import { compareTs, foldBatch, nowMs } from './clock.js';
import { cellDecode, pkDecode, quoteIdent, rowDecode } from './codec.js';
import { readClock, setCursor, SYNC, writeClock, writeMeta, type TableSchema } from './schema.js';
import type {
  Cell,
  CellState,
  ConflictResolver,
  Row,
  SqliteAdapter,
  SqlValue,
  SyncOp,
} from './types.js';

export interface ReplayInput {
  ops: readonly SyncOp[];
  schemas: readonly TableSchema[];
  resolver: ConflictResolver;
  strategy: 'row' | 'field';
  /** Externalized blobs carried by the segment/snapshot. */
  blobs?: ReadonlyMap<string, Uint8Array>;
  /** Timestamps to fold into the local HLC (max/join, idempotent). */
  foldClock?: readonly { p: number; l: number }[];
  /** Tolerate this much physical clock skew when folding (ms). */
  clockSkewMs?: number;
  /** Version-vector advances committed in the same transaction. */
  cursorUpdates?: Readonly<Record<string, number>>;
  /** Internal meta values committed in the same transaction (e.g. snapshot key). */
  metaUpdates?: Readonly<Record<string, string>>;
  onConflict?: (tbl: string, pk: string) => void;
}

export interface ReplayResult {
  applied: number;
  conflicts: number;
}

interface RowKey {
  tbl: string;
  pk: string;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildUpsert(schema: TableSchema, presentColumns: readonly string[]): string {
  const cols = presentColumns.filter((c) => schema.columns.includes(c));
  const colList = cols.map(quoteIdent).join(', ');
  const marks = cols.map(() => '?').join(', ');
  const pkList = schema.primaryKey.map(quoteIdent).join(', ');
  const updates = cols
    .filter((c) => !schema.primaryKey.includes(c))
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ');
  if (!updates) {
    return `INSERT OR IGNORE INTO ${quoteIdent(schema.name)} (${colList}) VALUES (${marks})`;
  }
  return `INSERT INTO ${quoteIdent(schema.name)} (${colList}) VALUES (${marks})
            ON CONFLICT(${pkList}) DO UPDATE SET ${updates}`;
}

/**
 * Apply a batch of remote (or locally-ingested) operations inside ONE
 * transaction. Everything that must be atomic — cell state, materialized user
 * rows, HLC clock and version-vector cursors — is written here.
 *
 * Replay is at-least-once and fully idempotent: the LWW-Map join plus the
 * timestamp-guarded cell writes mean re-applying an op is a no-op.
 */
export async function applyOps(tx: SqliteAdapter, input: ReplayInput): Promise<ReplayResult> {
  const { ops, schemas, resolver, strategy } = input;
  const blobs = input.blobs ?? new Map<string, Uint8Array>();
  const schemaByTable = new Map(schemas.map((s) => [s.name, s]));
  let conflicts = 0;

  // 0. Persist externalized blobs so materialization is fully synchronous.
  for (const part of chunk([...blobs.entries()], 100)) {
    if (!part.length) continue;
    const sql = `INSERT OR IGNORE INTO "${SYNC.blobs}" (hash, data) VALUES ${part
      .map(() => '(?, ?)')
      .join(', ')}`;
    await tx.run(sql, part.flatMap(([h, b]) => [h, b] as SqlValue[]));
  }

  // 1. Distinct affected rows.
  const keys = new Map<string, RowKey & { incoming: Cell[] }>();
  for (const op of ops) {
    const k = `${op.tbl}\u0000${op.pk}`;
    let entry = keys.get(k);
    if (!entry) keys.set(k, (entry = { tbl: op.tbl, pk: op.pk, incoming: [] }));
    entry.incoming.push(...op.cells);
    if (!schemaByTable.has(op.tbl)) {
      throw new Error(
        `sqlite-remote-sync: received op for unknown table "${op.tbl}" — schema mismatch, run migrate()`,
      );
    }
  }
  const keyList = [...keys.values()];

  // 2. Replay guard. Inserted and cleared inside this transaction, so a crash
  //    rolls it back and the guard can never be left stuck.
  for (const part of chunk(keyList, 300)) {
    if (!part.length) continue;
    await tx.run(
      `INSERT OR IGNORE INTO "${SYNC.replay}" (tbl, pk) VALUES ${part.map(() => '(?, ?)').join(', ')}`,
      part.flatMap((k) => [k.tbl, k.pk] as SqlValue[]),
    );
  }

  // 3. Bulk-load current cell state (avoids a round trip per row).
  const current = new Map<string, Map<string, CellState>>();
  for (const part of chunk(keyList, 300)) {
    if (!part.length) continue;
    const where = part.map(() => '(tbl = ? AND pk = ?)').join(' OR ');
    const params = part.flatMap((k) => [k.tbl, k.pk] as SqlValue[]);
    const r = await tx.run(
      `SELECT tbl, pk, cell, value, p, l, s FROM "${SYNC.cells}" WHERE ${where}`,
      params,
    );
    for (const x of r.rows) {
      const key = `${String(x.tbl)}\u0000${String(x.pk)}`;
      let m = current.get(key);
      if (!m) current.set(key, (m = new Map()));
      m.set(String(x.cell), {
        cell: String(x.cell),
        value: x.value === null || x.value === undefined ? null : String(x.value),
        p: Number(x.p),
        l: Number(x.l),
        s: String(x.s),
      });
    }
  }

  // 4. Resolve, write cell state, materialize user rows.
  const changedCells: SqlValue[][] = [];
  for (const k of keyList) {
    const key = `${k.tbl}\u0000${k.pk}`;
    const cur = current.get(key) ?? new Map<string, CellState>();
    const resolved = resolver.resolve({
      tbl: k.tbl,
      pk: k.pk,
      incoming: k.incoming,
      current: cur,
      primaryKey: schemaByTable.get(k.tbl)!.primaryKey,
    });

    for (const c of k.incoming) {
      const winner = resolved.get(c.cell);
      if (!winner || winner.p !== c.p || winner.l !== c.l || winner.s !== c.s) {
        conflicts++;
        input.onConflict?.(k.tbl, k.pk);
        break;
      }
    }

    let rowChanged = false;
    for (const state of resolved.values()) {
      const prev = cur.get(state.cell);
      if (
        !prev ||
        prev.value !== state.value ||
        prev.p !== state.p ||
        prev.l !== state.l ||
        prev.s !== state.s
      ) {
        changedCells.push([k.tbl, k.pk, state.cell, state.value, state.p, state.l, state.s]);
        rowChanged = true;
      }
    }
    // Re-applying an already-seen op is a no-op; avoid needless user-table
    // writes (they would also be suppressed by the replay guard anyway).
    if (rowChanged) {
      await materialize(tx, schemaByTable.get(k.tbl)!, k.pk, resolved, strategy, blobs);
    }
  }

  for (const part of chunk(changedCells, 200)) {
    if (!part.length) continue;
    await tx.run(
      `INSERT INTO "${SYNC.cells}" (tbl, pk, cell, value, p, l, s) VALUES ${part
        .map(() => '(?, ?, ?, ?, ?, ?, ?)')
        .join(', ')}
         ON CONFLICT(tbl, pk, cell) DO UPDATE SET
           value = excluded.value, p = excluded.p, l = excluded.l, s = excluded.s`,
      part.flat(),
    );
  }

  // 5. Everything below is in the same transaction as the writes above.
  await tx.run(`DELETE FROM "${SYNC.replay}"`);

  if (input.foldClock?.length) {
    const clock = await readClock(tx);
    const next = foldBatch(clock, input.foldClock, nowMs() + (input.clockSkewMs ?? 0));
    await writeClock(tx, next.p, next.l);
  }
  for (const [site, seq] of Object.entries(input.cursorUpdates ?? {})) {
    await setCursor(tx, site, seq);
  }
  for (const [key, value] of Object.entries(input.metaUpdates ?? {})) {
    await writeMeta(tx, key, value);
  }

  return { applied: ops.length, conflicts };
}

async function materialize(
  tx: SqliteAdapter,
  schema: TableSchema,
  pk: string,
  resolved: ReadonlyMap<string, CellState>,
  strategy: 'row' | 'field',
  blobs: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const pkValues = pkDecode(pk);
  const where = schema.primaryKey.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
  const deleteSql = `DELETE FROM ${quoteIdent(schema.name)} WHERE ${where}`;

  if (strategy === 'row') {
    const winner = resolved.get('*');
    if (!winner) return;
    if (winner.value === null) {
      await tx.run(deleteSql, pkValues);
      return;
    }
    const row = rowDecode(winner.value, blobs);
    const cols = schema.columns.filter((c) => c in row);
    if (!cols.length) return;
    const sql = buildUpsert(schema, cols);
    await tx.run(sql, cols.map((c) => row[c] as SqlValue));
    return;
  }

  // field strategy: a `$del` tombstone beats every cell at or before its ts.
  const tomb = resolved.get('$del');
  const others = [...resolved.values()].filter((c) => c.cell !== '$del');
  const living = tomb
    ? others.filter((c) => compareTs(c, tomb) > 0)
    : others;

  if (!living.length) {
    await tx.run(deleteSql, pkValues);
    return;
  }

  const row: Row = {};
  for (const c of living) {
    if (schema.columns.includes(c.cell)) {
      row[c.cell] = cellDecode(c.value ?? 'null|', blobs);
    }
  }
  // Primary keys are authoritative from the op identity.
  schema.primaryKey.forEach((col, i) => {
    row[col] = pkValues[i] ?? null;
  });
  const cols = schema.columns.filter((c) => c in row);
  if (!cols.length) {
    await tx.run(deleteSql, pkValues);
    return;
  }
  await tx.run(buildUpsert(schema, cols), cols.map((c) => row[c] as SqlValue));
}
