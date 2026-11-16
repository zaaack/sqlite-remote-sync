import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryBackend } from '../src/remote/memory.js';
import { SYNC } from '../src/core/schema.js';
import {
  allRows,
  makeDevice,
  rows,
  type Device,
} from './helpers.js';

function todo(d: Device, id: string, title: string, done = 0): Promise<unknown> {
  return d.db.adapter.run(
    'INSERT INTO todos (id, title, done) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, done=excluded.done',
    [id, title, done],
  );
}

async function converge(devices: Device[], rounds = 4): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    for (const d of devices) await d.engine.sync();
    for (const d of [...devices].reverse()) await d.engine.sync();
  }
}

describe('engine / end-to-end bidirectional sync', () => {
  it('propagates inserts and updates in both directions', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A');
    const b = await makeDevice(backend, 'B');

    await todo(a, 't1', 'from A');
    await a.engine.sync();
    await b.engine.sync();
    assert.deepEqual(rows(b.db, 'todos'), [{ id: 't1', title: 'from A', done: 0, score: null, payload: null }]);

    await todo(b, 't1', 'updated by B', 1);
    await todo(b, 't2', 'only on B');
    await b.engine.sync();
    await a.engine.sync();
    assert.deepEqual(rows(a.db, 'todos'), rows(b.db, 'todos'));
    assert.equal(rows(a.db, 'todos')[0]!.title, 'updated by B');
    a.engine.close();
    b.engine.close();
  });

  it('converges after concurrent conflicting edits (LWW)', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A');
    const b = await makeDevice(backend, 'B');
    await converge([a, b]); // establish a common baseline
    await todo(a, 'x', 'init');
    await a.engine.sync();
    await b.engine.sync();

    // both edit offline
    await todo(a, 'x', 'A wins?');
    await todo(b, 'x', 'B wins?');
    await converge([a, b]);
    assert.deepEqual(rows(a.db, 'todos'), rows(b.db, 'todos'), 'converged');
    assert.equal(rows(a.db, 'todos').length, 1);
    a.engine.close();
    b.engine.close();
  });

  it('three devices converge under randomized interleaving', async () => {
    const backend = new MemoryBackend();
    const devices = await Promise.all(
      ['A', 'B', 'C'].map((s) => makeDevice(backend, s)),
    );
    let seed = 12345;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (let round = 0; round < 6; round++) {
      for (const d of devices) {
        const id = `r${Math.floor(rnd() * 5)}`;
        await todo(d, id, `${d.siteId}-${round}`);
        if (rnd() > 0.5) await d.engine.sync();
      }
    }
    await converge(devices, 6);
    const expected = rows(devices[0]!.db, 'todos');
    for (const d of devices.slice(1)) {
      assert.deepEqual(rows(d.db, 'todos'), expected, `device ${d.siteId} converged`);
    }
    for (const d of devices) await d.engine.close();
  });

  it('field-level strategy merges non-overlapping concurrent column edits', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A', { strategy: 'field' });
    const b = await makeDevice(backend, 'B', { strategy: 'field' });
    await todo(a, 'f1', 'base', 0);
    await a.engine.sync();
    await b.engine.sync();

    await a.db.adapter.run('UPDATE todos SET title = ? WHERE id = ?', ['title-from-A', 'f1']);
    await b.db.adapter.run('UPDATE todos SET done = ? WHERE id = ?', [1, 'f1']);
    await converge([a, b], 3);
    assert.deepEqual(rows(a.db, 'todos'), rows(b.db, 'todos'));
    const row = rows(a.db, 'todos')[0]!;
    assert.equal(row.title, 'title-from-A');
    assert.equal(row.done, 1);
    await a.engine.close();
    await b.engine.close();
  });

  it('delete propagates, and a causally-later recreate wins', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A');
    const b = await makeDevice(backend, 'B');
    await todo(a, 'd1', 'will be deleted');
    await a.engine.sync();
    await b.engine.sync();

    await a.db.adapter.run('DELETE FROM todos WHERE id = ?', ['d1']);
    await a.engine.sync();
    await b.engine.sync();
    assert.equal(rows(b.db, 'todos').length, 0, 'delete propagated');

    // B sees the tombstone, then deliberately recreates the row: causally newer.
    await todo(b, 'd1', 'recreated on B', 1);
    await b.engine.sync();
    await a.engine.sync();
    assert.deepEqual(rows(a.db, 'todos'), rows(b.db, 'todos'));
    assert.equal(rows(a.db, 'todos').length, 1);
    assert.equal(rows(a.db, 'todos')[0]!.title, 'recreated on B');
    await a.engine.close();
    await b.engine.close();
  });

  it('does not echo remote writes back into the outbox', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A');
    const b = await makeDevice(backend, 'B');
    await todo(a, 'e1', 'x');
    await a.engine.sync();
    await b.engine.sync();
    await b.engine.sync();
    const outbox = allRows(b.db, `SELECT seq FROM "${SYNC.oplog}" WHERE seq > (SELECT CAST(value AS INTEGER) FROM "${SYNC.meta}" WHERE key='last_pushed_seq')`);
    assert.equal(outbox.length, 0, 'no pending local ops after pure pull');
    await a.engine.close();
    await b.engine.close();
  });

  it('chunks large change sets and keeps the file count far below write count', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A', { segmentMaxOps: 25, segmentMaxBytes: 4096 });
    const b = await makeDevice(backend, 'B');
    for (let i = 0; i < 300; i++) await todo(a, `c${i}`, `value-${i}`);
    const push = await a.engine.sync();
    assert.ok(push.pushedSegments >= 2, `expected chunking, got ${push.pushedSegments}`);
    await b.engine.sync();
    assert.equal(rows(b.db, 'todos').length, 300);

    // 300 writes produced only a handful of objects (segments + per-site manifest).
    const objects = backend.keys().filter((k) => k.includes('/segments/'));
    assert.ok(objects.length < 30, `too many small files: ${objects.length}`);
    await a.engine.close();
    await b.engine.close();
  });

  it('honours a user-configured chunk size (500 rows -> 10 segments)', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A', { segmentMaxOps: 50 });
    const b = await makeDevice(backend, 'B');
    for (let i = 0; i < 500; i++) await todo(a, `q${i}`, `v${i}`);

    const push = await a.engine.sync();
    assert.equal(push.pushedOps, 500);
    assert.equal(push.pushedSegments, 10, '500 coalesced ops / 50 per chunk');
    const segmentFiles = backend.keys().filter((k) => k.includes('/segments/'));
    assert.equal(segmentFiles.length, 10);

    const pull = await b.engine.pull();
    assert.equal(pull.pulledSegments, 10);
    assert.equal(rows(b.db, 'todos').length, 500, 'all data arrives across the chunks');
    assert.deepEqual(rows(b.db, 'todos'), rows(a.db, 'todos'));
    await a.engine.close();
    await b.engine.close();
  });

  it('compaction lets a fresh device bootstrap from a snapshot', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A', { compactAfterSegments: 2, autoCompact: false });
    for (let i = 0; i < 5; i++) {
      await todo(a, `s${i}`, `v${i}`);
      await a.engine.push();
    }
    const key = await a.engine.compact();
    assert.ok(key, 'snapshot created');

    const c = await makeDevice(backend, 'C');
    const pull = await c.engine.pull();
    assert.equal(pull.snapshotsApplied, 1, 'bootstrapped from snapshot');
    assert.equal(rows(c.db, 'todos').length, 5);
    assert.deepEqual(rows(c.db, 'todos'), rows(a.db, 'todos'));
    await a.engine.close();
    await c.engine.close();
  });

  it('is idempotent: repeated sync produces no changes', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A');
    const b = await makeDevice(backend, 'B');
    await todo(a, 'i1', 'x');
    await a.engine.sync();
    await b.engine.sync();
    const before = rows(b.db, 'todos');
    await b.engine.sync();
    await b.engine.sync();
    assert.deepEqual(rows(b.db, 'todos'), before);
    assert.equal(allRows(b.db, `SELECT seq FROM "${SYNC.oplog}"`).length, 0);
    await a.engine.close();
    await b.engine.close();
  });

  it('close() is idempotent and subsequent sync fails loudly', async () => {
    const backend = new MemoryBackend();
    const a = await makeDevice(backend, 'A');
    await todo(a, 't', 'x');
    await a.engine.sync();
    await a.engine.close();
    await a.engine.close(); // idempotent: must not throw
    await assert.rejects(async () => { await a.engine.sync(); }, /sqlite-remote-sync: engine is closed/);
    await assert.rejects(async () => { await a.engine.push(); }, /sqlite-remote-sync: engine is closed/);
  });
});
