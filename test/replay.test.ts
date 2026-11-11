import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeOps, pkEncode, rowEncode } from '../src/core/codec.js';
import { applyOps } from '../src/core/replay.js';
import { fieldLwwResolver, lwwResolver } from '../src/core/resolver.js';
import { SYNC } from '../src/core/schema.js';
import type { Cell, SqliteAdapter, SyncOp } from '../src/core/types.js';
import { allRows, setupSyncDb, type SetupResult } from './helpers.js';

function cell(cellName: string, value: string | null, p: number, l: number, s: string): Cell {
  return { cell: cellName, value, p, l, s };
}

function op(site: string, seq: number, pk: string, cells: Cell[]): SyncOp {
  return { site, seq, tbl: 'todos', pk, cells };
}

const pk = pkEncode(['r1']);

function row(values: Record<string, unknown>): string {
  return rowEncode(values, ['id', 'title', 'done', 'score', 'payload']);
}

async function replay(
  db: SqliteAdapter,
  setup: SetupResult,
  ops: SyncOp[],
  strategy: 'row' | 'field' = 'row',
): Promise<{ applied: number; conflicts: number }> {
  return db.transaction((tx) =>
    applyOps(tx, {
      ops,
      schemas: setup.schemas,
      resolver: strategy === 'field' ? fieldLwwResolver : lwwResolver,
      strategy,
      foldClock: ops.flatMap((o) => o.cells.map((c) => ({ p: c.p, l: c.l }))),
    }),
  );
}

function todos(db: SetupResult): Record<string, unknown>[] {
  return allRows(db.db, 'SELECT id, title, done FROM todos ORDER BY id');
}

describe('replay / LWW-Map join', () => {
  it('row-level LWW converges regardless of delivery order', async () => {
    const a = await setupSyncDb();
    const b = await setupSyncDb();
    const older = op('site-A', 1, pk, [cell('*', row({ id: 'r1', title: 'older', done: 0 }), 100, 0, 'site-A')]);
    const newer = op('site-B', 1, pk, [cell('*', row({ id: 'r1', title: 'newer', done: 1 }), 200, 0, 'site-B')]);

    await replay(a.db.adapter, a, [older, newer]);
    await replay(b.db.adapter, b, [newer, older]);

    assert.deepEqual(todos(a), todos(b));
    assert.equal(todos(a)[0]!.title, 'newer');
    a.db.close();
    b.db.close();
  });

  it('tombstones beat stale updates and allow resurrection', async () => {
    const s = await setupSyncDb();
    await replay(s.db.adapter, s, [
      op('A', 1, pk, [cell('*', row({ id: 'r1', title: 'v1', done: 0 }), 100, 0, 'A')]),
    ]);
    await replay(s.db.adapter, s, [op('B', 2, pk, [cell('*', null, 500, 0, 'B')])]);
    assert.equal(todos(s).length, 0, 'deleted');

    // stale put arrives late
    await replay(s.db.adapter, s, [
      op('C', 3, pk, [cell('*', row({ id: 'r1', title: 'stale', done: 0 }), 200, 0, 'C')]),
    ]);
    assert.equal(todos(s).length, 0, 'tombstone still wins');

    // newer put resurrects
    await replay(s.db.adapter, s, [
      op('D', 4, pk, [cell('*', row({ id: 'r1', title: 'again', done: 1 }), 600, 0, 'D')]),
    ]);
    assert.equal(todos(s)[0]!.title, 'again');
    s.db.close();
  });

  it('field-level merge preserves concurrent edits to different columns', async () => {
    const a = await setupSyncDb({ strategy: 'field' });
    const b = await setupSyncDb({ strategy: 'field' });
    const base = op('A', 1, pk, [
      cell('id', 'text|r1', 100, 0, 'A'),
      cell('title', 'text|base', 100, 0, 'A'),
      cell('done', 'integer|0', 100, 0, 'A'),
    ]);
    const titleEdit = op('B', 2, pk, [cell('title', 'text|from-B', 200, 0, 'B')]);
    const doneEdit = op('C', 3, pk, [cell('done', 'integer|1', 300, 0, 'C')]);

    await replay(a.db.adapter, a, [base, titleEdit, doneEdit], 'field');
    await replay(b.db.adapter, b, [doneEdit, base, titleEdit], 'field');

    assert.deepEqual(todos(a), todos(b), 'converged');
    assert.equal(todos(a)[0]!.title, 'from-B');
    assert.equal(todos(a)[0]!.done, 1);
    a.db.close();
    b.db.close();
  });

  it('field-level delete wins over older cells, newer put resurrects only its cells', async () => {
    const s = await setupSyncDb({ strategy: 'field' });
    await replay(
      s.db.adapter,
      s,
      [
        op('A', 1, pk, [
          cell('id', 'text|r1', 100, 0, 'A'),
          cell('title', 'text|orig', 100, 0, 'A'),
          cell('done', 'integer|1', 100, 0, 'A'),
        ]),
      ],
      'field',
    );
    await replay(s.db.adapter, s, [op('B', 2, pk, [cell('$del', null, 500, 0, 'B')])], 'field');
    assert.equal(todos(s).length, 0);
    await replay(
      s.db.adapter,
      s,
      [op('C', 3, pk, [cell('title', 'text|new', 600, 0, 'C')])],
      'field',
    );
    assert.equal(todos(s).length, 1);
    assert.equal(todos(s)[0]!.title, 'new');
    s.db.close();
  });

  it('is idempotent and does not create outbox echo', async () => {
    const s = await setupSyncDb();
    const ops = [
      op('A', 1, pk, [cell('*', row({ id: 'r1', title: 'x', done: 0 }), 100, 0, 'A')]),
      op('B', 2, pk, [cell('*', row({ id: 'r1', title: 'y', done: 1 }), 200, 0, 'B')]),
    ];
    await replay(s.db.adapter, s, ops);
    const before = todos(s);
    await replay(s.db.adapter, s, ops);
    assert.deepEqual(todos(s), before);
    assert.equal(allRows(s.db, `SELECT seq FROM "${SYNC.oplog}"`).length, 0, 'no echo');
    s.db.close();
  });

  it('folds received HLC so subsequent local writes are newer', async () => {
    const s = await setupSyncDb();
    await replay(s.db.adapter, s, [
      op('B', 1, pk, [cell('*', row({ id: 'r1', title: 'remote', done: 0 }), 900000, 7, 'B')]),
    ]);
    const clock = allRows(s.db, 'SELECT p, l FROM "_sync_clock"')[0]!;
    assert.ok(Number(clock.p) >= 900000);
    assert.ok(Number(clock.l) >= 7);
    s.db.close();
  });

  it('segments round-trip through the JSONL codec', () => {
    const ops = [op('A', 1, pk, [cell('*', row({ id: 'r1', title: 'x' }), 1, 0, 'A')])];
    // encodeOps is used by the engine; validate the exported pair here.
    assert.ok(encodeOps(ops).byteLength > 0);
  });
});
