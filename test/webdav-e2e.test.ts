import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebDavBackend } from '../src/remote/webdav.js';
import { createSyncEngine } from '../src/core/engine.js';
import { makeDb, rows, type TestDb } from './helpers.js';
import type { SyncConfig, SyncEngine, SyncStats, TableConfig } from '../src/core/types.js';

const require = createRequire(import.meta.url);
const webdav = require('webdav-server').v2 as {
  WebDAVServer: new (opts: { port: number; hostname: string }) => {
    start(cb: () => void): void;
    stop(cb: () => void): void;
  };
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------ */
/* HTTP instrumentation: counts every request + uploaded bytes        */
/* ------------------------------------------------------------------ */

interface Metrics {
  requests: number;
  byMethod: Record<string, number>;
  uploadBytes: number;
}

function makeFetch(): { fetch: typeof globalThis.fetch; metrics: Metrics; reset: () => void } {
  const native = globalThis.fetch.bind(globalThis);
  const metrics: Metrics = { requests: 0, byMethod: {}, uploadBytes: 0 };
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    metrics.requests++;
    metrics.byMethod[method] = (metrics.byMethod[method] ?? 0) + 1;
    const b = init?.body;
    if (b instanceof Uint8Array) metrics.uploadBytes += b.byteLength;
    else if (typeof b === 'string') metrics.uploadBytes += new TextEncoder().encode(b).length;
    return native(input, init);
  }) as typeof globalThis.fetch;
  return {
    fetch: wrapped,
    metrics,
    reset: () => {
      metrics.requests = 0;
      metrics.byMethod = {};
      metrics.uploadBytes = 0;
    },
  };
}

const inst = makeFetch();

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; wallMs: number; m: Metrics }> {
  inst.reset();
  const t0 = performance.now();
  const result = await fn();
  const wallMs = performance.now() - t0;
  return { result, wallMs, m: { ...inst.metrics, byMethod: { ...inst.metrics.byMethod } } };
}

function report(label: string, wallMs: number, m: Metrics, s?: SyncStats, extra?: Record<string, unknown>): void {
  const methods = Object.entries(m.byMethod)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  console.log(`[perf] ${label}`);
  console.log(`[perf]   wall=${wallMs.toFixed(1)}ms engine=${s ? s.durationMs.toFixed(1) + 'ms' : '-'} requests=${m.requests} (${methods}) upload=${m.uploadBytes}B`);
  if (s) {
    console.log(
      `[perf]   push(ops=${s.pushedOps} segs=${s.pushedSegments} B=${s.pushedBytes}) ` +
        `pull(ops=${s.pulledOps} segs=${s.pulledSegments} B=${s.pulledBytes}) ` +
        `applied=${s.appliedOps} conflicts=${s.conflicts} snapshots=${s.snapshotsApplied}`,
    );
  }
  if (extra) console.log(`[perf]   ${JSON.stringify(extra)}`);
}

/* ------------------------------------------------------------------ */
/* device helpers                                                     */
/* ------------------------------------------------------------------ */

interface Dev {
  db: TestDb;
  engine: SyncEngine;
  siteId: string;
}

interface DevOpts {
  appId: string;
  siteId: string;
  schema?: string;
  tables?: TableConfig[];
  config?: Partial<SyncConfig>;
}

const SCHEMA_2 = `
  CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0, score REAL, payload BLOB);
  CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, rev INTEGER);
`;
const TABLES_2: TableConfig[] = [
  { name: 'todos', primaryKey: ['id'] },
  { name: 'notes', primaryKey: ['id'] },
];

const SCHEMA_5 = `
  CREATE TABLE t0(id TEXT PRIMARY KEY, a TEXT, b INTEGER, c REAL, d BLOB);
  CREATE TABLE t1(id TEXT PRIMARY KEY, a TEXT, b INTEGER, c REAL, d BLOB);
  CREATE TABLE t2(id TEXT PRIMARY KEY, a TEXT, b INTEGER, c REAL, d BLOB);
  CREATE TABLE t3(id TEXT PRIMARY KEY, a TEXT, b INTEGER, c REAL, d BLOB);
  CREATE TABLE t4(id TEXT PRIMARY KEY, a TEXT, b INTEGER, c REAL, d BLOB);
`;
const TABLES_5: TableConfig[] = ['t0', 't1', 't2', 't3', 't4'].map((name) => ({
  name,
  primaryKey: ['id'],
}));

async function makeDev(o: DevOpts): Promise<Dev> {
  const db = makeDb();
  for (const stmt of (o.schema ?? SCHEMA_2).split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.adapter.run(stmt);
  }
  const config: SyncConfig = {
    db: db.adapter,
    backend,
    appId: o.appId,
    siteId: o.siteId,
    tables: o.tables ?? TABLES_2,
    ...o.config,
  };
  const engine = createSyncEngine(config);
  await engine.init();
  return { db, engine, siteId: o.siteId };
}

function canonRow(r: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(r).sort()) {
    const v = r[k];
    o[k] = v instanceof Uint8Array ? `@hex:${Buffer.from(v).toString('hex')}` : v;
  }
  return o;
}

function state(db: TestDb, tables: readonly string[]): string {
  return JSON.stringify(tables.map((t) => rows(db, t).map(canonRow)));
}

function totalRows(db: TestDb, tables: readonly string[]): number {
  return tables.reduce((n, t) => n + rows(db, t).length, 0);
}

/** Sync everyone until there is nothing left to push or pull. Returns rounds. */
async function converge(devs: Dev[], maxRounds = 12): Promise<number> {
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    let activity = 0;
    for (const d of devs) {
      const s = await d.engine.sync();
      activity += s.pushedOps + s.pulledOps;
    }
    if (activity === 0) break;
  }
  // one extra quiet round so ack manifests settle
  for (const d of devs) await d.engine.sync();
  return rounds;
}

function conflictCounter(devs: Dev[]): () => number {
  let n = 0;
  for (const d of devs) d.engine.on((e) => { if (e.type === 'conflict') n++; });
  return () => n;
}

async function closeAll(devs: Dev[]): Promise<void> {
  for (const d of devs) await d.engine.close();
}

/* ------------------------------------------------------------------ */
/* shared real WebDAV server                                          */
/* ------------------------------------------------------------------ */

let server: InstanceType<typeof webdav.WebDAVServer>;
let backend: WebDavBackend;
let baseUrl: string;

describe('webdav-server end-to-end (real HTTP)', () => {
  before(async () => {
    const port = await freePort();
    server = new webdav.WebDAVServer({ port, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.start(() => r()));
    baseUrl = `http://127.0.0.1:${port}`;
    backend = new WebDavBackend({ url: baseUrl, fetch: inst.fetch });
  });

  after(async () => {
    await new Promise<void>((r) => server.stop(() => r()));
  });

  /* ================================================================ */
  describe('WebDavBackend efficiency regressions', () => {
    it('issues no redundant HEAD after a PUT on an ETag-less server', async () => {
      const local = makeFetch();
      const b = new WebDavBackend({ url: baseUrl, fetch: local.fetch });
      await b.put('eff-head/a/one.bin', new Uint8Array([1, 2, 3])); // warm up collections
      local.reset();
      const r = await b.put('eff-head/a/two.bin', new Uint8Array([4, 5, 6]));
      assert.equal(local.metrics.byMethod['PUT'] ?? 0, 1);
      assert.equal(local.metrics.byMethod['HEAD'] ?? 0, 0, 'no HEAD fallback');
      assert.equal(r.etag, undefined, 'ETag-less server yields no etag');
    });

    it('shares exactly one MKCOL per collection across concurrent puts', async () => {
      const local = makeFetch();
      const b = new WebDavBackend({ url: baseUrl, fetch: local.fetch });
      // 12 concurrent puts into the same brand-new 4-level path.
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          b.put(`eff-mkcol/a/b/c/f${i}.bin`, new Uint8Array([i])),
        ),
      );
      assert.equal(local.metrics.byMethod['PUT'] ?? 0, 12);
      assert.equal(local.metrics.byMethod['MKCOL'] ?? 0, 4, 'one MKCOL per distinct parent dir');
      assert.equal(local.metrics.byMethod['HEAD'] ?? 0, 0);
    });
  });

  /* ================================================================ */
  describe('bidirectional sync / correctness', () => {
    it('three devices converge with distinct inserts, updates and a BLOB', async () => {
      const appId = 'e2e-converge';
      const a = await makeDev({ appId, siteId: 'A' });
      const b = await makeDev({ appId, siteId: 'B' });
      const c = await makeDev({ appId, siteId: 'C' });
      const devs = [a, b, c];

      await a.db.adapter.run('INSERT INTO todos (id,title,done,score,payload) VALUES (?,?,?,?,?)', [
        'a1', 'from A', 1, 2.5, new Uint8Array([0, 1, 2, 253, 254, 255]),
      ]);
      await a.db.adapter.run('INSERT INTO notes (id,body,rev) VALUES (?,?,?)', ['n-a', 'note A', 1]);
      await b.db.adapter.run('INSERT INTO todos (id,title,done) VALUES (?,?,?)', ['b1', 'from B', 0]);
      await c.db.adapter.run('INSERT INTO notes (id,body,rev) VALUES (?,?,?)', ['n-c', 'note C', 3]);

      const rounds = await converge(devs);
      assert.ok(rounds <= 6, `converged in ${rounds} rounds`);
      assert.equal(state(a.db, ['todos', 'notes']), state(b.db, ['todos', 'notes']));
      assert.equal(state(b.db, ['todos', 'notes']), state(c.db, ['todos', 'notes']));
      assert.equal(totalRows(a.db, ['todos', 'notes']), 4);
      const blobRow = rows(b.db, 'todos').find((r) => r.id === 'a1')!;
      assert.deepEqual(blobRow.payload, new Uint8Array([0, 1, 2, 253, 254, 255]), 'BLOB survived real HTTP + gzip');

      // an update on C propagates back to A and B
      await c.db.adapter.run('UPDATE notes SET body = ? WHERE id = ?', ['edited on C', 'n-a']);
      await converge(devs);
      assert.equal(state(a.db, ['todos', 'notes']), state(c.db, ['todos', 'notes']));
      assert.equal(rows(a.db, 'notes').find((r) => r.id === 'n-a')!.body, 'edited on C');

      await closeAll(devs);
    });

    it('concurrent conflicting edits converge by LWW and emit conflict events', async () => {
      const appId = 'e2e-conflict';
      const a = await makeDev({ appId, siteId: 'A' });
      const b = await makeDev({ appId, siteId: 'B' });
      const devs = [a, b];
      const conflicts = conflictCounter(devs);

      await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['x', 'base']);
      await converge(devs);

      // both edit the same row while offline
      await a.db.adapter.run('UPDATE todos SET title = ? WHERE id = ?', ['from-A', 'x']);
      await b.db.adapter.run('UPDATE todos SET title = ? WHERE id = ?', ['from-B', 'x']);
      await converge(devs);

      assert.equal(state(a.db, ['todos', 'notes']), state(b.db, ['todos', 'notes']), 'replicas converged');
      const winner = rows(a.db, 'todos').find((r) => r.id === 'x')!.title;
      assert.ok(winner === 'from-A' || winner === 'from-B', `deterministic winner, got ${winner}`);
      assert.equal(rows(a.db, 'todos').length, 1, 'no duplicate row');
      assert.ok(conflicts() >= 1, 'a real LWW conflict was observed');

      // stable: extra syncs do not flip the winner or duplicate
      await a.engine.sync();
      await b.engine.sync();
      assert.equal(rows(a.db, 'todos').find((r) => r.id === 'x')!.title, winner);
      assert.equal(state(a.db, ['todos', 'notes']), state(b.db, ['todos', 'notes']));

      await closeAll(devs);
    });

    it('delete propagates; a causally-later recreate wins (no stale resurrection)', async () => {
      const appId = 'e2e-delete';
      const a = await makeDev({ appId, siteId: 'A' });
      const b = await makeDev({ appId, siteId: 'B' });
      const devs = [a, b];

      await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['d1', 'will be deleted']);
      await converge(devs);

      await a.db.adapter.run('DELETE FROM todos WHERE id = ?', ['d1']);
      await a.engine.sync();
      await b.engine.sync();
      assert.equal(rows(b.db, 'todos').length, 0, 'tombstone propagated');

      // B has applied the tombstone, so its recreate is causally newer (HLC folded on receive)
      await b.db.adapter.run('INSERT INTO todos (id,title,done) VALUES (?,?,?)', ['d1', 'recreated on B', 1]);
      await converge(devs);
      assert.equal(state(a.db, ['todos', 'notes']), state(b.db, ['todos', 'notes']));
      assert.equal(rows(a.db, 'todos').length, 1);
      assert.equal(rows(a.db, 'todos')[0]!.title, 'recreated on B');

      await closeAll(devs);
    });

    it('field strategy merges non-overlapping column edits over WebDAV', async () => {
      const appId = 'e2e-field';
      const a = await makeDev({ appId, siteId: 'A', config: { strategy: 'field' } });
      const b = await makeDev({ appId, siteId: 'B', config: { strategy: 'field' } });
      const devs = [a, b];

      await a.db.adapter.run('INSERT INTO todos (id,title,done) VALUES (?,?,?)', ['f1', 'base', 0]);
      await converge(devs);

      await a.db.adapter.run('UPDATE todos SET title = ? WHERE id = ?', ['title-from-A', 'f1']);
      await b.db.adapter.run('UPDATE todos SET done = ? WHERE id = ?', [1, 'f1']);
      await converge(devs);

      assert.equal(state(a.db, ['todos', 'notes']), state(b.db, ['todos', 'notes']));
      const row = rows(a.db, 'todos').find((r) => r.id === 'f1')!;
      assert.equal(row.title, 'title-from-A', 'A\'s column survived');
      assert.equal(row.done, 1, 'B\'s column survived');

      await closeAll(devs);
    });

    it('compaction + gc: a fresh device bootstraps from a snapshot with full data', async () => {
      const appId = 'e2e-compact';
      const a = await makeDev({
        appId, siteId: 'A',
        config: { autoCompact: false, compactAfterSegments: 1000, healInterval: 1000 },
      });
      for (let i = 0; i < 8; i++) {
        await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', [`s${i}`, `v${i}`]);
        await a.engine.push();
      }
      const before = (await backend.list(`${appId}/`)).length;
      const key = await a.engine.compact();
      assert.ok(key, 'snapshot pointer created');
      const removed = await a.engine.gc();
      const after = (await backend.list(`${appId}/`)).length;
      assert.ok(removed > 0, `gc removed ${removed} old segments`);
      assert.ok(after < before, `object count reduced ${before} -> ${after}`);

      // brand-new device: no segments, must bootstrap purely from the snapshot
      const fresh = await makeDev({ appId, siteId: 'FRESH' });
      const pull = await fresh.engine.pull();
      assert.equal(pull.snapshotsApplied, 1);
      assert.equal(totalRows(fresh.db, ['todos', 'notes']), 8, 'all rows present after gc');
      assert.equal(state(a.db, ['todos', 'notes']), state(fresh.db, ['todos', 'notes']));

      // a second sync is a no-op (idempotent bootstrap)
      const again = await fresh.engine.pull();
      assert.equal(again.appliedOps, 0);
      assert.equal(again.snapshotsApplied, 0);

      await closeAll([a, fresh]);
    });

    it('an offline device catches up after several remote rounds', async () => {
      const appId = 'e2e-offline';
      const a = await makeDev({ appId, siteId: 'A' });
      const b = await makeDev({ appId, siteId: 'B' });
      const c = await makeDev({ appId, siteId: 'C' });
      await converge([a, b, c]);

      // C writes but stays offline while A/B keep syncing
      await c.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['offline', 'written offline']);
      for (let i = 0; i < 3; i++) {
        await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', [`a${i}`, `A round ${i}`]);
        await b.db.adapter.run('INSERT INTO notes (id,body,rev) VALUES (?,?,?)', [`b${i}`, `B round ${i}`, i]);
        await a.engine.sync();
        await b.engine.sync();
      }
      assert.equal(totalRows(c.db, ['todos', 'notes']), 1, 'C stayed offline');

      await converge([a, b, c]);
      assert.equal(state(a.db, ['todos', 'notes']), state(c.db, ['todos', 'notes']));
      assert.equal(state(b.db, ['todos', 'notes']), state(c.db, ['todos', 'notes']));
      assert.equal(totalRows(a.db, ['todos', 'notes']), 7);

      await closeAll([a, b, c]);
    });

    it('concurrent sync() across devices converges on a no-CAS server', async () => {
      const appId = 'e2e-concurrent';
      const devs = await Promise.all(['A', 'B', 'C', 'D'].map((s) => makeDev({ appId, siteId: s })));
      for (let i = 0; i < devs.length; i++) {
        await devs[i]!.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', [`dev-${i}`, `from ${devs[i]!.siteId}`]);
      }
      // fire all syncs simultaneously (each engine has its own mutex; the
      // webdav-server ignores If-Match, so this exercises the no-CAS path)
      for (let round = 0; round < 6; round++) {
        await Promise.all(devs.map((d) => d.engine.sync()));
      }
      const expected = state(devs[0]!.db, ['todos', 'notes']);
      for (const d of devs.slice(1)) {
        assert.equal(state(d.db, ['todos', 'notes']), expected, `device ${d.siteId} converged`);
      }
      assert.equal(totalRows(devs[0]!.db, ['todos', 'notes']), 4);
      await closeAll(devs);
    });

    it('repeated sync is idempotent: no echo, no duplicate rows', async () => {
      const appId = 'e2e-idempotent';
      const a = await makeDev({ appId, siteId: 'A' });
      const b = await makeDev({ appId, siteId: 'B' });
      await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['i1', 'x']);
      await converge([a, b]);
      const before = state(b.db, ['todos', 'notes']);
      for (let i = 0; i < 4; i++) await b.engine.sync();
      assert.equal(state(b.db, ['todos', 'notes']), before);
      assert.equal(rows(b.db, 'todos').length, 1);
      const s = await a.engine.sync();
      assert.equal(s.pushedOps, 0, 'nothing new to push');
      await closeAll([a, b]);
    });

    it('special-character siteIds round-trip through real PROPFIND hrefs', async () => {
      const appId = 'e2e special app';
      const ids = ['device one', 'a/b', 'plain-A'];
      const devs = await Promise.all(ids.map((s) => makeDev({ appId, siteId: s })));
      for (let i = 0; i < devs.length; i++) {
        await devs[i]!.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', [`sp-${i}`, `from ${ids[i]}`]);
      }
      await converge(devs);
      const expected = state(devs[0]!.db, ['todos', 'notes']);
      for (const d of devs.slice(1)) assert.equal(state(d.db, ['todos', 'notes']), expected);
      assert.equal(totalRows(devs[0]!.db, ['todos', 'notes']), 3);
      await closeAll(devs);
    });
  });

  /* ================================================================ */
  describe('performance', () => {
    const PERF = 'perf-app';

    it('bulk 500 rows / 5 tables: one object per chunk, fresh reader gets all rows', { timeout: 120000 }, async () => {
      const a = await makeDev({
        appId: PERF, siteId: 'BULK',
        schema: SCHEMA_5, tables: TABLES_5,
        config: { autoCompact: false, healInterval: 100000 },
      });
      for (let i = 0; i < 500; i++) {
        await a.db.adapter.run(`INSERT INTO t${i % 5} (id,a,b,c,d) VALUES (?,?,?,?,?)`, [
          `id${i}`, `value-${i}`, i, i / 7,
          i % 7 === 0 ? new Uint8Array([i % 256, 253, 254, 255]) : null,
        ]);
      }
      const { result: push, wallMs, m } = await measure(() => a.engine.sync());
      const objects = await backend.list(`${PERF}/`);
      const segments = objects.filter((e) => e.key.includes('/segments/'));
      report('bulk initial sync (500 rows / 5 tables)', wallMs, m, push, {
        objects: objects.length, segments: segments.length,
        segBytes: segments.reduce((n, e) => n + (e.size ?? 0), 0),
      });

      assert.equal(push.pushedOps, 500);
      assert.equal(push.pushedSegments, 1, '500 coalesced rows fit in one segment');
      assert.ok(objects.length <= 4, `only a handful of WebDAV objects, got ${objects.length}`);
      assert.ok(m.requests <= 20, `bounded request count, got ${m.requests}`);

      // fresh reader pulls the whole history
      const reader = await makeDev({ appId: PERF, siteId: 'READER', schema: SCHEMA_5, tables: TABLES_5 });
      const r = await measure(() => reader.engine.pull());
      report('fresh reader full pull', r.wallMs, r.m, r.result, { rows: totalRows(reader.db, TABLES_5.map((t) => t.name)) });
      assert.equal(totalRows(reader.db, TABLES_5.map((t) => t.name)), 500);
      assert.equal(state(a.db, TABLES_5.map((t) => t.name)), state(reader.db, TABLES_5.map((t) => t.name)));
      await closeAll([a, reader]);
    });

    it('incremental single-row sync is cheap', { timeout: 60000 }, async () => {
      const appId = 'perf-incremental';
      const a = await makeDev({
        appId, siteId: 'INC', schema: SCHEMA_5, tables: TABLES_5,
        config: { autoCompact: false, healInterval: 100000 },
      });
      for (let i = 0; i < 200; i++) {
        await a.db.adapter.run(`INSERT INTO t${i % 5} (id,a) VALUES (?,?)`, [`id${i}`, `v${i}`]);
      }
      await a.engine.sync(); // baseline

      await a.db.adapter.run('INSERT INTO t0 (id,a) VALUES (?,?)', ['new-1', 'just one row']);
      const { result: s, wallMs, m } = await measure(() => a.engine.sync());
      report('incremental 1-row sync', wallMs, m, s);
      assert.equal(s.pushedOps, 1);
      assert.equal(s.pushedSegments, 1);
      assert.equal(s.pushedBytes < 1024, true, 'tiny payload');
      assert.ok(m.requests <= 12, `few requests, got ${m.requests}`);

      const noop = await measure(() => a.engine.sync());
      report('no-op sync (nothing changed)', noop.wallMs, noop.m, noop.result);
      assert.equal(noop.result.pushedOps, 0);
      assert.equal(noop.result.pulledOps, 0);
      assert.ok(noop.m.requests <= noop.result.pushedSegments + 12, 'no unnecessary downloads');
      await a.engine.close();
    });

    it('segmentMaxOps controls the exact file count over real WebDAV', { timeout: 120000 }, async () => {
      const appId = 'perf-chunks';
      const a = await makeDev({
        appId, siteId: 'CHUNK', schema: SCHEMA_5, tables: TABLES_5,
        config: { segmentMaxOps: 50, autoCompact: false, healInterval: 100000 },
      });
      for (let i = 0; i < 500; i++) {
        await a.db.adapter.run(`INSERT INTO t${i % 5} (id,a) VALUES (?,?)`, [`id${i}`, `v${i}`]);
      }
      const { result: push, wallMs, m } = await measure(() => a.engine.sync());
      const segments = (await backend.list(`${appId}/`)).filter((e) => e.key.includes('/segments/'));
      report('chunked push (segmentMaxOps=50)', wallMs, m, push, { segmentFiles: segments.length });
      assert.equal(push.pushedSegments, 10, '500 / 50 = 10 chunks');
      assert.equal(segments.length, 10);

      const reader = await makeDev({ appId, siteId: 'CHUNK-READER', schema: SCHEMA_5, tables: TABLES_5 });
      const r = await measure(() => reader.engine.pull());
      report('parallel pull of 10 chunks', r.wallMs, r.m, r.result);
      assert.equal(r.result.pulledSegments, 10);
      assert.equal(totalRows(reader.db, TABLES_5.map((t) => t.name)), 500);
      await closeAll([a, reader]);
    });

    it('snapshot bootstrap is cheaper than replaying many segments', { timeout: 120000 }, async () => {
      const appId = 'perf-bootstrap';
      const a = await makeDev({
        appId, siteId: 'HIST', schema: SCHEMA_5, tables: TABLES_5,
        config: { autoCompact: false, compactAfterSegments: 1000, healInterval: 100000 },
      });
      // 12 separate pushes -> 12 segment files
      for (let batch = 0; batch < 12; batch++) {
        for (let i = 0; i < 25; i++) {
          await a.db.adapter.run(`INSERT INTO t${i % 5} (id,a) VALUES (?,?)`, [`b${batch}-${i}`, `v${i}`]);
        }
        await a.engine.push();
      }
      const preObjects = (await backend.list(`${appId}/`)).filter((e) => e.key.includes('/segments/')).length;
      assert.equal(preObjects, 12, '12 segment files before compaction');

      // bootstrap by replay (no snapshot yet)
      const replay = await makeDev({ appId, siteId: 'REPLAY', schema: SCHEMA_5, tables: TABLES_5 });
      const rReplay = await measure(() => replay.engine.pull());
      report('fresh device: replay 12 segments', rReplay.wallMs, rReplay.m, rReplay.result, { rows: totalRows(replay.db, TABLES_5.map((t) => t.name)) });
      assert.equal(rReplay.result.pulledSegments, 12);
      assert.equal(totalRows(replay.db, TABLES_5.map((t) => t.name)), 300);

      // now compact + gc
      const compact = await measure(() => a.engine.compact());
      await a.engine.gc();
      report('compact()', compact.wallMs, compact.m, undefined, { snapshot: compact.result });

      const boot = await makeDev({ appId, siteId: 'BOOT', schema: SCHEMA_5, tables: TABLES_5 });
      const rBoot = await measure(() => boot.engine.pull());
      report('fresh device: snapshot bootstrap', rBoot.wallMs, rBoot.m, rBoot.result, {
        rows: totalRows(boot.db, TABLES_5.map((t) => t.name)),
      });
      assert.equal(rBoot.result.snapshotsApplied, 1);
      assert.equal(totalRows(boot.db, TABLES_5.map((t) => t.name)), 300, 'full data after gc');
      assert.equal(state(a.db, TABLES_5.map((t) => t.name)), state(boot.db, TABLES_5.map((t) => t.name)));
      assert.ok(rBoot.result.pulledSegments < 12, 'bootstrap needs fewer segment downloads');
      await closeAll([a, replay, boot]);
    });

    it('five devices converge: total request/byte cost', { timeout: 120000 }, async () => {
      const appId = 'perf-multi';
      const devs = await Promise.all(
        ['A', 'B', 'C', 'D', 'E'].map((s) =>
          makeDev({ appId, siteId: s, schema: SCHEMA_5, tables: TABLES_5, config: { autoCompact: false, healInterval: 100000 } }),
        ),
      );
      for (let k = 0; k < devs.length; k++) {
        for (let i = 0; i < 100; i++) {
          await devs[k]!.db.adapter.run(`INSERT INTO t${i % 5} (id,a) VALUES (?,?)`, [`${k}-${i}`, `v${i}`]);
        }
      }
      const { wallMs, m } = await measure(async () => {
        await converge(devs, 8);
      });
      const objects = await backend.list(`${appId}/`);
      report('5 devices x 100 rows converge', wallMs, m, undefined, {
        objects: objects.length,
        segments: objects.filter((e) => e.key.includes('/segments/')).length,
        rows: totalRows(devs[0]!.db, TABLES_5.map((t) => t.name)),
      });
      const expected = state(devs[0]!.db, TABLES_5.map((t) => t.name));
      for (const d of devs.slice(1)) assert.equal(state(d.db, TABLES_5.map((t) => t.name)), expected);
      assert.equal(totalRows(devs[0]!.db, TABLES_5.map((t) => t.name)), 500);
      assert.ok(objects.length < 30, `bounded object count, got ${objects.length}`);
      await closeAll(devs);
    });
  });
});
