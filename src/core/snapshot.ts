import { base64Decode, base64Encode, fingerprint, hexEncode, utf8Decode, utf8Encode } from './codec.js';
import { SYNC } from './schema.js';
import type { SqliteAdapter, SyncOp } from './types.js';

/**
 * A logical snapshot = the full LWW-Map cell state, not a raw `.db` file.
 * Portable across OPFS / wasm / RN / Tauri, and lets a fresh device bootstrap
 * in one download instead of replaying the entire history.
 */
export interface SnapshotFile {
  v: 1;
  epoch: string;
  resolver: string;
  strategy: string;
  codec: string;
  /** Version vector covered by this snapshot. */
  vv: Record<string, number>;
  cells: Array<{
    tbl: string;
    pk: string;
    cell: string;
    value: string | null;
    p: number;
    l: number;
    s: string;
  }>;
  blobs?: Record<string, string>;
}

export interface SnapshotOptions {
  epoch: string;
  resolver: string;
  strategy: string;
  codec: string;
  vv: Record<string, number>;
  blobs?: ReadonlyMap<string, Uint8Array>;
}

export async function buildSnapshot(
  db: SqliteAdapter,
  options: SnapshotOptions,
): Promise<{ payload: Uint8Array; hash: string }> {
  const r = await db.run(
    `SELECT tbl, pk, cell, value, p, l, s FROM "${SYNC.cells}" ORDER BY tbl, pk, cell`,
  );
  const cells = r.rows.map((x) => ({
    tbl: String(x.tbl),
    pk: String(x.pk),
    cell: String(x.cell),
    value: x.value === null || x.value === undefined ? null : String(x.value),
    p: Number(x.p),
    l: Number(x.l),
    s: String(x.s),
  }));

  const refs = new Set<string>();
  for (const c of cells) {
    if (c.value?.startsWith('blobx|')) refs.add(c.value.slice(6));
  }
  let blobs: Record<string, string> | undefined;
  if (refs.size) {
    blobs = {};
    for (const part of chunk([...refs], 200)) {
      const q = `SELECT hash, data FROM "${SYNC.blobs}" WHERE hash IN (${part.map(() => '?').join(', ')})`;
      const br = await db.run(q, part);
      for (const row of br.rows) {
        const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array();
        blobs![String(row.hash)] = base64Encode(bytes);
      }
    }
  }

  const snap: SnapshotFile = {
    v: 1,
    epoch: options.epoch,
    resolver: options.resolver,
    strategy: options.strategy,
    codec: options.codec,
    vv: options.vv,
    cells,
    ...(blobs && Object.keys(blobs).length ? { blobs } : {}),
  };
  const payload = utf8Encode(JSON.stringify(snap));
  return { payload, hash: fingerprint(payload) };
}

export function decodeSnapshot(bytes: Uint8Array): SnapshotFile {
  return JSON.parse(utf8Decode(bytes)) as SnapshotFile;
}

/** Turn a snapshot into one op per row so `applyOps()` can join + materialize it. */
export function snapshotToOps(snap: SnapshotFile): {
  ops: SyncOp[];
  blobs: Map<string, Uint8Array>;
  vv: Record<string, number>;
  foldClock: { p: number; l: number }[];
} {
  const blobs = new Map<string, Uint8Array>();
  for (const [h, b64] of Object.entries(snap.blobs ?? {})) blobs.set(h, base64Decode(b64));
  const groups = new Map<string, { tbl: string; pk: string; cells: SyncOp['cells'] }>();
  const foldClock: { p: number; l: number }[] = [];
  for (const c of snap.cells) {
    const key = `${c.tbl}\u0000${c.pk}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tbl: c.tbl, pk: c.pk, cells: [] }));
    g.cells.push({ cell: c.cell, value: c.value, p: c.p, l: c.l, s: c.s });
    foldClock.push({ p: c.p, l: c.l });
  }
  const ops: SyncOp[] = [...groups.values()].map((g) => ({
    site: g.cells[0]?.s ?? 'snapshot',
    seq: 0,
    tbl: g.tbl,
    pk: g.pk,
    cells: g.cells,
  }));
  return { ops, blobs, vv: snap.vv, foldClock };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Unused helper kept for symmetry with segment hashing. */
export function hashBytes(bytes: Uint8Array): string {
  return hexEncode(utf8Encode(fingerprint(bytes)));
}
