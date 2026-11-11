import { hlcSend, maxTs, nowMs } from './clock.js';
import { fingerprint, hexDecode, pkEncode, quoteIdent, rowEncode, utf8Encode } from './codec.js';
import { readClock, SYNC, writeClock, type TableSchema } from './schema.js';
import type { Cell, SqliteAdapter, SqlValue, SyncOp, Ts } from './types.js';

export interface OutboxEntry {
  seq: number;
  tbl: string;
  pk: string;
  op: 'put' | 'del';
  row: string | null;
  /** Pre-image captured by UPDATE/DELETE triggers (NULL for INSERT). */
  oldRow: string | null;
  p: number;
  l: number;
  site: string;
}

export interface BuiltOps {
  ops: SyncOp[];
  maxSeq: number;
  /** Externalized blobs referenced by `blobx|<hash>` cells. */
  blobs: Map<string, Uint8Array>;
}

export async function readOutbox(db: SqliteAdapter, afterSeq: number): Promise<OutboxEntry[]> {
  const r = await db.run(
    `SELECT seq, tbl, pk, op, row, old_row, p, l, site FROM "${SYNC.oplog}"
       WHERE seq > ? ORDER BY seq`,
    [afterSeq],
  );
  return r.rows.map((x) => ({
    seq: Number(x.seq),
    tbl: String(x.tbl),
    pk: String(x.pk),
    op: String(x.op) as 'put' | 'del',
    row: x.row === null || x.row === undefined ? null : String(x.row),
    oldRow: x.old_row === null || x.old_row === undefined ? null : String(x.old_row),
    p: Number(x.p),
    l: Number(x.l),
    site: String(x.site),
  }));
}

function keyOf(tbl: string, pk: string): string {
  return `${tbl}\u0000${pk}`;
}

/**
 * Coalesce the local outbox into one op per `(table, pk)`.
 *
 * This is where chunking starts: many local writes to the same row become a
 * single replicated op. The op carries the FINAL row image and the MAX HLC of
 * the coalesced writes, which is enough for a state-based LWW register and
 * makes a retry byte-for-byte deterministic (the source is the immutable
 * outbox, never the mutable user table).
 *
 * For the `field` strategy, only columns that actually changed (including a
 * change that was later reverted) are emitted as individually-timestamped
 * cells, so concurrent edits to different columns are preserved.
 */
export async function buildOpsFromOutbox(
  db: SqliteAdapter,
  siteId: string,
  schemas: readonly TableSchema[],
  strategy: 'row' | 'field',
  afterSeq: number,
  blobThreshold = 0,
): Promise<BuiltOps> {
  const entries = await readOutbox(db, afterSeq);
  if (!entries.length) {
    return { ops: [], maxSeq: afterSeq, blobs: new Map() };
  }

  const schemaByTable = new Map(schemas.map((s) => [s.name, s]));
  const groups = new Map<string, OutboxEntry[]>();
  for (const e of entries) {
    const k = keyOf(e.tbl, e.pk);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(e);
  }

  const blobs = new Map<string, Uint8Array>();
  const externalize = (value: string): string => {
    if (blobThreshold <= 0 || !value.startsWith('blob|')) return value;
    const hex = value.slice(5);
    if (hex.length / 2 <= blobThreshold) return value;
    const hash = fingerprint(utf8Encode(hex));
    if (!blobs.has(hash)) blobs.set(hash, hexDecode(hex));
    return `blobx|${hash}`;
  };

  const ops: SyncOp[] = [];
  let maxSeq = afterSeq;

  for (const group of groups.values()) {
    let ts: Ts = { p: -1, l: -1, s: '' };
    for (const e of group) {
      ts = maxTs(ts, { p: e.p, l: e.l, s: e.site });
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    const final = group[group.length - 1]!;
    const cells: Cell[] = [];
    const base = { p: ts.p, l: ts.l, s: ts.s };

    if (strategy === 'row') {
      cells.push({
        cell: '*',
        value: final.op === 'put' && final.row ? externalize(final.row) : null,
        ...base,
      });
    } else if (final.op === 'del') {
      cells.push({ cell: '$del', value: null, ...base });
    } else {
      const schema = schemaByTable.get(final.tbl);
      if (!schema) continue;
      // Exact per-column delta from the trigger-captured OLD/NEW images.
      // This is independent of remote ops that may have landed since the write,
      // so a device that has never pushed before cannot clobber a concurrent
      // edit to a different column.
      const changed = new Set<string>();
      for (const e of group) {
        if (e.op === 'del') continue;
        const before = e.oldRow ? (JSON.parse(e.oldRow) as Record<string, string>) : null;
        const after = e.row ? (JSON.parse(e.row) as Record<string, string>) : {};
        for (const c of schema.columns) {
          if (!before || (before[c] ?? 'null|') !== (after[c] ?? 'null|')) changed.add(c);
        }
      }
      const last = final.row ? (JSON.parse(final.row) as Record<string, string>) : {};
      for (const c of changed) {
        cells.push({ cell: c, value: externalize(last[c] ?? 'null|'), ...base });
      }
    }

    if (cells.length) {
      ops.push({ site: siteId, seq: final.seq, tbl: final.tbl, pk: final.pk, cells });
    }
  }

  ops.sort((a, b) => a.seq - b.seq);
  return { ops, maxSeq, blobs };
}

/**
 * Explicit capture for runtimes without trigger support. Reads the current row
 * (or records a tombstone if it is gone) and appends one outbox entry.
 */
export async function captureRowChange(
  db: SqliteAdapter,
  schemas: readonly TableSchema[],
  siteId: string,
  table: string,
  primaryKeyValues: readonly SqlValue[],
): Promise<void> {
  const schema = schemas.find((s) => s.name === table);
  if (!schema) throw new Error(`sqlite-remote-sync: unknown table ${table}`);
  if (primaryKeyValues.length !== schema.primaryKey.length) {
    throw new Error(`sqlite-remote-sync: ${table} expects ${schema.primaryKey.length} pk values`);
  }
  const where = schema.primaryKey.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
  const cols = schema.columns.map(quoteIdent).join(', ');
  const r = await db.run(`SELECT ${cols} FROM ${quoteIdent(table)} WHERE ${where}`, primaryKeyValues);
  const row = r.rows.length ? rowEncode(r.rows[0]!, schema.columns) : null;

  const clock = await readClock(db);
  const { clock: next, ts } = hlcSend(clock, nowMs(), siteId);
  await writeClock(db, next.p, next.l);
  await db.run(
    `INSERT INTO "${SYNC.oplog}" (tbl, pk, op, row, p, l, site) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [table, pkEncode(primaryKeyValues), row ? 'put' : 'del', row, ts.p, ts.l, siteId],
  );
}
