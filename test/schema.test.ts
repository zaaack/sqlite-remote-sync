import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { probeCapabilities } from '../src/core/adapter.js';
import { cellDecode, rowDecode } from '../src/core/codec.js';
import { discoverSchemas, installSchema, SYNC } from '../src/core/schema.js';
import { allRows, makeConfig, makeDb, SCHEMA_SQL, type TestDb } from './helpers.js';

async function setup(): Promise<{ db: TestDb; epoch: string }> {
  const db = makeDb();
  for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.adapter.run(stmt);
  }
  const cap = await probeCapabilities(db.adapter);
  const cfg = makeConfig(db.adapter, {
    tables: [
      { name: 'todos', primaryKey: ['id'] },
      { name: 'notes', primaryKey: ['id'] },
    ],
  });
  const schemas = await discoverSchemas(db.adapter, cfg.tables);
  const epoch = await db.adapter.transaction((tx) =>
    installSchema(tx, cfg, cap, schemas, 'lww'),
  );
  return { db, epoch };
}

describe('schema / trigger capture', () => {
  it('probes capabilities', async () => {
    const db = makeDb();
    const cap = await probeCapabilities(db.adapter);
    assert.equal(cap.triggers, true);
    assert.equal(cap.json, true);
    assert.ok(cap.clock === 'subsec' || cap.clock === 'seconds');
    db.close();
  });

  it('installs triggers and captures INSERT/UPDATE/DELETE with exact values', async () => {
    const { db } = await setup();
    await db.adapter.run(
      `INSERT INTO todos (id, title, done, score, payload) VALUES (?, ?, ?, ?, ?)`,
      ['a', 'hello|world', 1, 1.5, new Uint8Array([0, 1, 255])],
    );
    await db.adapter.run(`UPDATE todos SET title = ?, done = ? WHERE id = ?`, ['changed', 2, 'a']);
    await db.adapter.run(`DELETE FROM todos WHERE id = ?`, ['a']);

    const ops = allRows(db, `SELECT op, pk, row, p, l, site FROM "${SYNC.oplog}" ORDER BY seq`);
    assert.equal(ops.length, 3);
    assert.deepEqual(
      ops.map((o) => o.op),
      ['put', 'put', 'del'],
    );

    const first = rowDecode(String(ops[0]!.row));
    assert.equal(first['title'], 'hello|world');
    assert.equal(first['done'], 1);
    assert.equal(first['score'], 1.5);
    assert.deepEqual(first['payload'], new Uint8Array([0, 1, 255]));
    assert.equal(ops[0]!.site, 'site-A');

    // HLC is monotonically increasing and stored as integers.
    for (let i = 1; i < ops.length; i++) {
      assert.ok(Number(ops[i]!.p) > Number(ops[i - 1]!.p) || Number(ops[i]!.l) > Number(ops[i - 1]!.l));
    }
    db.close();
  });

  it('emits delete+put when a primary key changes', async () => {
    const { db } = await setup();
    await db.adapter.run(`INSERT INTO todos (id, title) VALUES (?, ?)`, ['a', 'x']);
    await db.adapter.run(`UPDATE todos SET id = ? WHERE id = ?`, ['b', 'a']);
    const ops = allRows(db, `SELECT op, pk FROM "${SYNC.oplog}" ORDER BY seq`);
    assert.deepEqual(
      ops.map((o) => o.op),
      ['put', 'del', 'put'],
    );
    assert.match(String(ops[1]!.pk), /text\|a/);
    assert.match(String(ops[2]!.pk), /text\|b/);
    db.close();
  });

  it('suppresses replay writes via the per-PK guard but keeps other rows', async () => {
    const { db } = await setup();
    await db.adapter.run(`INSERT INTO todos (id, title) VALUES (?, ?)`, ['a', 'x']);
    await db.adapter.run(`DELETE FROM "${SYNC.oplog}"`);

    // Simulate a replay transaction touching only pk "a".
    await db.adapter.transaction(async (tx) => {
      await tx.run(`INSERT INTO "${SYNC.replay}" (tbl, pk) VALUES (?, ?)`, ['todos', '["text|a"]']);
      await tx.run(`UPDATE todos SET title = ? WHERE id = ?`, ['remote', 'a']);
      await tx.run(`INSERT INTO todos (id, title) VALUES (?, ?)`, ['b', 'local']);
      await tx.run(`DELETE FROM "${SYNC.replay}"`);
    });

    const ops = allRows(db, `SELECT pk, op FROM "${SYNC.oplog}" ORDER BY seq`);
    assert.equal(ops.length, 1, 'only the unrelated row should be captured');
    assert.match(String(ops[0]!.pk), /text\|b/);
    db.close();
  });

  it('cell codec round-trips bigint, blob, text-with-pipe and null', () => {
    assert.equal(cellDecode('integer|9007199254740993'), 9007199254740993n);
    assert.deepEqual(cellDecode('blob|00ff'), new Uint8Array([0, 255]));
    assert.equal(cellDecode('text|a|b'), 'a|b');
    assert.equal(cellDecode('null|'), null);
    assert.equal(cellDecode('real|1.5'), 1.5);
  });
});
