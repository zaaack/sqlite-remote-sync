/**
 * Public types for sqlite-remote-sync.
 *
 * The library is deliberately driver-agnostic: it only needs a way to run raw
 * SQL (`SqliteAdapter`) and a byte-oriented object store (`RemoteBackend`).
 * No SQLite file-byte APIs are used, which is what makes it work identically
 * on OPFS / wa-sqlite / sqlite-wasm / Tauri / React Native / Capacitor.
 */

/** Values that can be bound to a SQLite statement. */
export type SqlValue = null | string | number | bigint | Uint8Array;

/** A row as returned by a SQLite driver. */
export type Row = Record<string, unknown>;

/** Result of executing one SQL statement. */
export interface SqlResult {
  rows: Row[];
  changes: number;
  insertId?: bigint | number;
}

/**
 * Minimal SQL executor. `transaction` MUST call `fn` with a handle bound to
 * the same connection/transaction, and MUST roll back when `fn` throws.
 */
export interface SqliteAdapter {
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;
  transaction<T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Capabilities detected at `init()`; used to degrade gracefully. */
export interface Capabilities {
  triggers: boolean;
  json: boolean;
  printf: boolean;
  /** `'subsec'` when `unixepoch('subsec')` exists, else `'seconds'`. */
  clock: 'subsec' | 'seconds';
  subsecondNowExpr: string;
}

/* ------------------------------------------------------------------ */
/* Remote storage                                                      */
/* ------------------------------------------------------------------ */

export interface RemoteGetOptions {
  /** Send `If-None-Match`. */
  etag?: string;
  /** Send `Range` (e.g. `bytes=0-1023`) for resumable downloads. */
  range?: string;
  signal?: AbortSignal;
}

export interface RemoteGetResult {
  data: Uint8Array;
  etag?: string;
  notModified?: boolean;
  /** Total object size when a Range request was answered. */
  totalSize?: number;
}

export interface RemotePutOptions {
  /** Send `If-Match` for compare-and-swap. `CasConflictError` on 412. */
  etag?: string;
  /** Send `If-None-Match: *` for create-only (safe concurrent creation). */
  createOnly?: boolean;
  contentType?: string;
  signal?: AbortSignal;
}

export interface RemotePutResult {
  etag?: string;
}

export interface RemoteEntry {
  /** Key relative to the backend root (always `/`-separated). */
  key: string;
  etag?: string;
  size?: number;
}

export interface RemoteHead {
  etag?: string;
  size?: number;
}

/**
 * Byte-oriented object store. Keys are `/`-separated relative paths.
 * Implementations must be safe to call concurrently and should preserve
 * ETag semantics (a changed object yields a different ETag).
 */
export interface RemoteBackend {
  get(key: string, opts?: RemoteGetOptions): Promise<RemoteGetResult>;
  put(key: string, data: Uint8Array, opts?: RemotePutOptions): Promise<RemotePutResult>;
  list(prefix: string): Promise<RemoteEntry[]>;
  head(key: string): Promise<RemoteHead | null>;
  delete(key: string): Promise<void>;
}

export class RemoteError extends Error {
  constructor(message: string, readonly status?: number, readonly key?: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

/** Optimistic-concurrency failure (HTTP 412 / ETag mismatch). */
export class CasConflictError extends RemoteError {
  constructor(key: string) {
    super(`CAS conflict for ${key}`, 412, key);
    this.name = 'CasConflictError';
  }
}

export class NotFoundError extends RemoteError {
  constructor(key: string) {
    super(`Not found: ${key}`, 404, key);
    this.name = 'NotFoundError';
  }
}

/* ------------------------------------------------------------------ */
/* Wire format                                                         */
/* ------------------------------------------------------------------ */

/**
 * One candidate for the LWW-Map join. `value` is a cell-encoded string
 * (see codec.ts), or `null` for a tombstone. `cell` is `'*'` (whole row,
 * row-level LWW), `'$del'` (row tombstone, field-level) or a column name.
 */
export interface Cell {
  cell: string;
  value: string | null;
  p: number;
  l: number;
  s: string;
}

/** A single replicated operation. Ops are immutable and idempotent. */
export interface SyncOp {
  site: string;
  seq: number;
  tbl: string;
  pk: string;
  cells: Cell[];
}

/** A timestamp / total-order key. */
export interface Ts {
  p: number;
  l: number;
  s: string;
}

/* ------------------------------------------------------------------ */
/* Codecs                                                              */
/* ------------------------------------------------------------------ */

export interface Codec {
  readonly id: string;
  encode(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
  decode(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export interface Logger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/* ------------------------------------------------------------------ */
/* Conflict resolution                                                 */
/* ------------------------------------------------------------------ */

export interface CellState extends Ts {
  cell: string;
  value: string | null;
}

export interface ResolveContext {
  tbl: string;
  pk: string;
  /** Candidate cells offered by the incoming op. */
  incoming: readonly Cell[];
  /** Current winning cells for this row, keyed by cell name. */
  current: ReadonlyMap<string, CellState>;
  /** Table primary-key columns. */
  primaryKey: readonly string[];
}

/**
 * A conflict resolver MUST implement a semilattice join: commutative,
 * associative and idempotent, depending only on the set of operation keys.
 * It must NOT depend on arrival order, local site identity, or wall clock.
 * Return the winning cells for each cell name.
 */
export interface ConflictResolver {
  readonly id: string;
  resolve(ctx: ResolveContext): Map<string, CellState>;
}

/* ------------------------------------------------------------------ */
/* Config / API                                                        */
/* ------------------------------------------------------------------ */

export interface TableConfig {
  name: string;
  /** Stable primary-key columns. Never mutate a PK value. */
  primaryKey: string[];
  /** Columns to replicate. Defaults to all columns of the table. */
  columns?: string[];
}

export interface MirrorError {
  index: number;
  op: 'put' | 'delete';
  error: unknown;
}

/** Options for `MirrorBackend` / the implicit mirror built from `backends`. */
export interface MirrorOptions {
  /**
   * How many backends must accept each write. Default `'all'` (strongest
   * consistency: one cloud down fails the sync loudly; the next successful
   * write heals the lagging replica). Lower only for availability over
   * immediate consistency.
   */
  writeQuorum?: number | 'all';
  /** Called for each replica that fails a write while the quorum is still met. */
  onBackendError?: (err: MirrorError) => void;
}

export interface SyncConfig {
  db: SqliteAdapter;
  /** Single remote backend. Provide either `backend` or `backends`. */
  backend?: RemoteBackend;
  /**
   * Convenience for multi-cloud sync: replicate to several backends at once.
   * When set, it takes precedence over `backend` and is wrapped in a
   * `MirrorBackend` (one entry is used directly, without the wrapper).
   */
  backends?: RemoteBackend[];
  /** Options for the implicit `MirrorBackend` when `backends` is used. */
  mirror?: MirrorOptions;
  /** Remote namespace; several independent databases can share one backend. */
  appId: string;
  /** Stable, globally unique id for this device. Never reused after a reset. */
  siteId: string;
  tables: TableConfig[];

  /** `'row'` = LWW-Register (default); `'field'` = per-column LWW merge. */
  strategy?: 'row' | 'field';
  /** Override the built-in resolver (must be a semilattice join). */
  resolver?: ConflictResolver;

  codec?: Codec;
  /** Compress segments/snapshots. Default true when a gzip codec is available. */
  compress?: boolean;
  /**
   * Split a push when the segment's UNCOMPRESSED JSON exceeds this many bytes
   * (gzip is applied afterwards, so the object on WebDAV is much smaller).
   * Default 512 KiB. Use `segmentMaxOps` if you want a predictable file count.
   */
  segmentMaxBytes?: number;
  /** Split a push after this many coalesced row-ops. Default 2000. */
  segmentMaxOps?: number;
  /** Inline BLOBs larger than this become content-addressed objects. 0 = off. */
  blobThreshold?: number;
  /** Max parallel segment downloads. Default 4. */
  concurrency?: number;
  /** Roll up a site's own segments when it has more than this many. Default 24. */
  compactAfterSegments?: number;
  /** Automatically compact after a sync when the threshold is hit. Default true. */
  autoCompact?: boolean;
  /** How often (in sync cycles) to heal orphaned segments via `list()`. Default 10. */
  healInterval?: number;
  /** Extra physical-clock skew tolerated when folding received HLCs. Default 0. */
  clockSkewMs?: number;

  retry?: RetryOptions;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
}

export interface SyncStats {
  pushedOps: number;
  pushedSegments: number;
  pushedBytes: number;
  pulledSegments: number;
  pulledOps: number;
  pulledBytes: number;
  appliedOps: number;
  conflicts: number;
  snapshotsApplied: number;
  durationMs: number;
}

export type SyncEvent =
  | { type: 'push'; stats: SyncStats }
  | { type: 'pull'; stats: SyncStats }
  | { type: 'conflict'; tbl: string; pk: string }
  | { type: 'error'; error: unknown }
  | { type: 'compact'; key: string };

export type SyncListener = (event: SyncEvent) => void;

export interface SyncEngine {
  init(): Promise<void>;
  /** Rebuild triggers after a schema change and advance the schema epoch. */
  migrate(): Promise<void>;
  push(): Promise<SyncStats>;
  pull(): Promise<SyncStats>;
  /** pull() then push(); the recommended entry point. */
  sync(): Promise<SyncStats>;
  /** Build a logical snapshot and roll up old segments. */
  compact(): Promise<string | null>;
  /** Delete segments that every known site has acknowledged. */
  gc(): Promise<number>;
  /** Run `fn` while holding the engine write lock (guarantees trigger capture). */
  write<T>(fn: () => Promise<T> | T): Promise<T>;
  startAutoSync(intervalMs: number): void;
  stopAutoSync(): void;
  /** True while push/pull/compact is running (used by the Kysely plugin guard). */
  isSyncing(): boolean;
  on(listener: SyncListener): () => void;
  close(): Promise<void>;
  /** Explicit capture fallback for runtimes without trigger support. */
  trackChange(table: string, primaryKey: readonly SqlValue[]): Promise<void>;
}
