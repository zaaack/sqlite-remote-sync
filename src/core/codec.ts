import type { Cell, Codec, Row, SqlValue, SyncOp } from './types.js';

/* ------------------------------------------------------------------ */
/* byte / string helpers                                               */
/* ------------------------------------------------------------------ */

const te = new TextEncoder();
const td = new TextDecoder();

export function utf8Encode(s: string): Uint8Array {
  return te.encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return td.decode(b);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]!;
    out += b === undefined ? '=' : B64[(n >>> 6) & 63]!;
    out += c === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}

export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]!);
    const c1 = B64.indexOf(clean[i + 1]!);
    const c2 = clean[i + 2] ? B64.indexOf(clean[i + 2]!) : -1;
    const c3 = clean[i + 3] ? B64.indexOf(clean[i + 3]!) : -1;
    const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    if (o < out.length) out[o++] = (n >>> 16) & 255;
    if (c2 >= 0 && o < out.length) out[o++] = (n >>> 8) & 255;
    if (c3 >= 0 && o < out.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

const HEX = '0123456789abcdef';

export function hexEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += HEX[(b >>> 4) & 15]! + HEX[b & 15]!;
  return s;
}

export function hexDecode(s: string): Uint8Array {
  const out = new Uint8Array(s.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* hashing                                                             */
/* ------------------------------------------------------------------ */

/** Fast, deterministic 64-bit fingerprint (two 32-bit FNV-1a lanes). */
export function fingerprint(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** SHA-256 when WebCrypto is available, otherwise a fast fingerprint. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
      return hexEncode(new Uint8Array(digest));
    } catch {
      /* fall through */
    }
  }
  return fingerprint(bytes);
}

/* ------------------------------------------------------------------ */
/* cell / row / pk encoding                                            */
/* ------------------------------------------------------------------ */

/**
 * A SQL value encoded as `"<typeof>|<payload>"`. This exact format is also
 * produced by the generated triggers (see schema.ts), so a row captured in
 * SQL and a row encoded in JS are byte-for-byte compatible.
 *
 * Payload: `hex()` for BLOB, exact decimal text for INTEGER, `CAST(x AS TEXT)`
 * for REAL/TEXT, empty for NULL. Splitting on the FIRST `|` keeps TEXT values
 * containing `|` intact. Exactly preserves BLOBs and 64-bit integers.
 */
export function cellEncode(v: SqlValue): string {
  if (v === null || v === undefined) return 'null|';
  if (typeof v === 'bigint') return `integer|${v.toString()}`;
  if (typeof v === 'number') {
    return Number.isInteger(v) ? `integer|${v.toString()}` : `real|${v.toString()}`;
  }
  if (typeof v === 'string') return `text|${v}`;
  if (v instanceof Uint8Array) return `blob|${hexEncode(v)}`;
  throw new TypeError(`Unsupported SQLite value: ${String(v)}`);
}

/**
 * Decode a cell string. `blobs` resolves externalized (`blobx|<hash>`) values,
 * which are stored in `_sync_blobs` and uploaded as content-addressed objects.
 */
export function cellDecode(s: string, blobs?: ReadonlyMap<string, Uint8Array>): SqlValue {
  const i = s.indexOf('|');
  const kind = i < 0 ? s : s.slice(0, i);
  const body = i < 0 ? '' : s.slice(i + 1);
  switch (kind) {
    case 'null':
      return null;
    case 'blob':
      return hexDecode(body);
    case 'blobx': {
      const b = blobs?.get(body);
      if (!b) throw new Error(`sqlite-remote-sync: missing external blob ${body}`);
      return b;
    }
    case 'real':
      return Number(body);
    case 'text':
      return body;
    case 'integer': {
      const n = Number(body);
      return Number.isSafeInteger(n) ? n : BigInt(body);
    }
    default:
      throw new TypeError(`Unknown cell encoding: ${s.slice(0, 32)}`);
  }
}

export function rowEncode(row: Row, columns: readonly string[]): string {
  const o: Record<string, string> = {};
  for (const c of columns) o[c] = cellEncode((row[c] ?? null) as SqlValue);
  return JSON.stringify(o);
}

export function rowDecode(json: string | null, blobs?: ReadonlyMap<string, Uint8Array>): Row {
  if (!json) return {};
  const o = JSON.parse(json) as Record<string, string>;
  const row: Row = {};
  for (const k of Object.keys(o)) row[k] = cellDecode(o[k]!, blobs);
  return row;
}

export function pkEncode(values: readonly SqlValue[]): string {
  return JSON.stringify(values.map(cellEncode));
}

export function pkDecode(s: string): SqlValue[] {
  return (JSON.parse(s) as string[]).map((x) => cellDecode(x));
}

/** Canonical SQL expression producing a cell-encoded string for one column. */
export function sqlCellExpr(column: string, alias: 'NEW' | 'OLD'): string {
  const q = `"${column.replace(/"/g, '""')}"`;
  const x = `${alias}.${q}`;
  return `(typeof(${x}) || '|' || CASE typeof(${x}) WHEN 'blob' THEN hex(${x}) WHEN 'null' THEN '' ELSE CAST(${x} AS TEXT) END)`;
}

/** Canonical SQL expression producing the opaque PK array string. */
export function sqlPkExpr(columns: readonly string[], alias: 'NEW' | 'OLD'): string {
  return `json_array(${columns.map((c) => sqlCellExpr(c, alias)).join(', ')})`;
}

/** Canonical SQL expression producing a row JSON object of cell strings. */
export function sqlRowExpr(columns: readonly string[], alias: 'NEW' | 'OLD'): string {
  const args: string[] = [];
  for (const c of columns) {
    args.push(`'${c.replace(/'/g, "''")}'`, sqlCellExpr(c, alias));
  }
  return `json_object(${args.join(', ')})`;
}

/* ------------------------------------------------------------------ */
/* JSONL                                                               */
/* ------------------------------------------------------------------ */

export function jsonlEncode(items: readonly unknown[]): Uint8Array {
  return utf8Encode(items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
}

export function jsonlDecode<T>(bytes: Uint8Array): T[] {
  const s = utf8Decode(bytes);
  const out: T[] = [];
  for (const line of s.split('\n')) {
    if (line.trim()) out.push(JSON.parse(line) as T);
  }
  return out;
}

/** Decode a segment containing `SyncOp[]`. */
export function decodeOps(bytes: Uint8Array): SyncOp[] {
  return jsonlDecode<SyncOp>(bytes);
}

export function encodeOps(ops: readonly SyncOp[]): Uint8Array {
  return jsonlEncode(ops);
}

/* ------------------------------------------------------------------ */
/* compression                                                         */
/* ------------------------------------------------------------------ */

async function pipeThrough(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const source = new Blob([new Uint8Array(bytes)]);
  const out = source.stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const identityCodec: Codec = {
  id: 'identity',
  encode: (b) => b,
  decode: (b) => b,
};

/** Returns null when the runtime has no CompressionStream. */
export function createGzipCodec(): Codec | null {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    return null;
  }
  return {
    id: 'gzip',
    encode: (b) => pipeThrough(b, new CompressionStream('gzip')),
    decode: (b) => pipeThrough(b, new DecompressionStream('gzip')),
  };
}

/**
 * Resolve the codec for a config value. `true`/undefined -> gzip when
 * available, otherwise identity. `false` -> identity. An object is used as-is.
 */
export function resolveCodec(value: Codec | boolean | undefined): Codec {
  if (value && typeof value === 'object') return value;
  if (value === false) return identityCodec;
  return createGzipCodec() ?? identityCodec;
}

/* ------------------------------------------------------------------ */
/* misc                                                                */
/* ------------------------------------------------------------------ */

export function cellIdentity(c: Cell): string {
  return `${c.cell}\u0000${c.p}\u0000${c.l}\u0000${c.s}\u0000${c.value ?? ''}`;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
