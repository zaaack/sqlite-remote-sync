import { CasConflictError, NotFoundError, RemoteError } from '../core/types.js';
import type {
  RemoteBackend,
  RemoteEntry,
  RemoteGetOptions,
  RemoteGetResult,
  RemoteHead,
  RemotePutOptions,
  RemotePutResult,
} from '../core/types.js';
import { normalizeKey } from './backend.js';

/* ------------------------------------------------------------------ */
/* Structural subset of files-sdk's `Files` — NO hard dependency.      */
/* Pass your own `new Files({ adapter: ... })` instance; the library   */
/* never imports `files-sdk`, so it stays a zero-runtime-dep package.  */
/* ------------------------------------------------------------------ */

export interface FilesSdkMeta {
  etag?: string;
  size?: number;
}

export interface FilesSdkStored extends FilesSdkMeta {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FilesSdkRange {
  /** 0-based, inclusive. */
  start: number;
  /** 0-based, inclusive. Omit for `start..EOF`. */
  end?: number;
}

export interface FilesSdkUploadOptions {
  contentType?: string;
}

export interface FilesSdkDownloadOptions {
  range?: FilesSdkRange;
}

export interface FilesSdkListOptions {
  prefix?: string;
  cursor?: string;
}

export interface FilesSdkListResult {
  items?: (FilesSdkMeta & { key: string })[];
  cursor?: string;
}

/**
 * The methods of `files-sdk`'s `Files` used by this backend. Structural, so
 * `Files` from `files-sdk` (any version) is assignable without a cast.
 */
export interface FilesSdkLike {
  upload(key: string, body: Uint8Array, opts?: FilesSdkUploadOptions): Promise<FilesSdkMeta | undefined>;
  download(key: string, opts?: FilesSdkDownloadOptions): Promise<FilesSdkStored>;
  head(key: string): Promise<FilesSdkMeta | null>;
  list(opts?: FilesSdkListOptions): Promise<FilesSdkListResult>;
  delete(key: string): Promise<void>;
}

export interface FilesSdkBackendOptions {
  /** `new Files({ adapter: s3({ bucket }) })` — see https://files-sdk.dev */
  files: FilesSdkLike;
  /** Guard against a provider that never returns a cursor. Default 1000. */
  maxListPages?: number;
}

function errorCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c : undefined;
}

function isNotFound(e: unknown): boolean {
  const s = e as { status?: unknown; statusCode?: unknown };
  return errorCode(e) === 'NotFound' || s.status === 404 || s.statusCode === 404;
}

/** Map `files-sdk`'s FilesError codes onto the RemoteBackend error contract. */
function mapError(e: unknown, key: string): unknown {
  if (isNotFound(e)) return new NotFoundError(key);
  switch (errorCode(e)) {
    case 'Conflict':
      return new CasConflictError(key);
    case 'Unauthorized':
      return new RemoteError(`files-sdk: unauthorized for ${key}`, 401, key);
    case 'ReadOnly':
      return new RemoteError(`files-sdk: read-only for ${key}`, 403, key);
    case 'Invalid':
    case 'Unsupported':
      return new RemoteError(`files-sdk: ${errorCode(e)} for ${key}`, 400, key);
    case 'Provider':
      return new RemoteError(`files-sdk: provider error for ${key}`, 500, key);
    default:
      return e;
  }
}

function parseRange(range: string | undefined): FilesSdkRange | undefined {
  if (!range) return undefined;
  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!m) return undefined;
  return m[2] ? { start: Number(m[1]), end: Number(m[2]) } : { start: Number(m[1]) };
}

/**
 * Remote backend for third-party cloud drives through
 * [`files-sdk`](https://www.npmjs.com/package/files-sdk) — S3/R2/MinIO, GCS,
 * Azure Blob, Vercel Blob, Dropbox, OneDrive, Google Drive, Box, WebDAV and the
 * local `fs` / in-memory adapters, all behind one API.
 *
 * ```ts
 * import { Files } from 'files-sdk';
 * import { s3 } from 'files-sdk/s3';
 * import { FilesSdkBackend } from 'sqlite-remote-sync';
 *
 * const backend = new FilesSdkBackend({
 *   files: new Files({ adapter: s3({ bucket: 'my-sync' }) }),
 * });
 * ```
 *
 * CAS and conditional reads are deliberately **disabled** here. `files-sdk`
 * ETag formats differ from HTTP (bare strong tags vs quoted), and conditional
 * create/replace primitives are `Unsupported` on several adapters (fs,
 * Dropbox, …), so a single `If-Match`-style token cannot work across
 * providers. `init()` therefore detects "CAS unavailable" and the engine uses
 * its no-CAS path (per-site manifests + re-base + list/union discovery) —
 * the same well-tested path used for `webdav-server` and `MirrorBackend`.
 * Range downloads are supported natively and are the main bandwidth win.
 */
export class FilesSdkBackend implements RemoteBackend {
  private readonly files: FilesSdkLike;
  private readonly maxListPages: number;

  constructor(options: FilesSdkBackendOptions) {
    this.files = options.files;
    this.maxListPages = options.maxListPages ?? 1000;
  }

  async get(key: string, opts: RemoteGetOptions = {}): Promise<RemoteGetResult> {
    const k = normalizeKey(key);
    try {
      const r = parseRange(opts.range);
      const stored = await this.files.download(k, r ? { range: r } : {});
      const data = new Uint8Array(await stored.arrayBuffer());
      // No ETag is exposed: the composite is intentionally no-CAS, and
      // files-sdk's bare tags are not HTTP `If-None-Match` tokens.
      return { data };
    } catch (e) {
      throw mapError(e, k);
    }
  }

  async put(key: string, data: Uint8Array, opts: RemotePutOptions = {}): Promise<RemotePutResult> {
    const k = normalizeKey(key);
    // Ignore `etag` / `createOnly`: see the class doc — CAS is intentionally
    // off, so `probeIfMatch()` reports false and the engine takes its no-CAS
    // path. Returning an ETag would be misleading (quoted vs bare formats).
    const uo: FilesSdkUploadOptions = {};
    if (opts.contentType !== undefined) uo.contentType = opts.contentType;
    try {
      await this.files.upload(k, data, uo);
      return {};
    } catch (e) {
      throw mapError(e, k);
    }
  }

  async list(prefix: string): Promise<RemoteEntry[]> {
    const p = normalizeKey(prefix);
    const query = p ? `${p}/` : '';
    const byKey = new Map<string, RemoteEntry>();
    let cursor: string | undefined;
    for (let page = 0; page < this.maxListPages; page++) {
      let result: FilesSdkListResult;
      try {
        result = await this.files.list({ prefix: query, ...(cursor ? { cursor } : {}) });
      } catch (e) {
        throw mapError(e, p);
      }
      for (const item of result.items ?? []) {
        const key = normalizeKey(item.key);
        if (!key) continue;
        byKey.set(key, {
          key,
          ...(item.etag ? { etag: item.etag } : {}),
          ...(item.size !== undefined ? { size: item.size } : {}),
        });
      }
      cursor = result.cursor;
      if (!cursor) break;
    }
    return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async head(key: string): Promise<RemoteHead | null> {
    const k = normalizeKey(key);
    try {
      const meta = await this.files.head(k);
      if (!meta) return null;
      return { ...(meta.size !== undefined ? { size: meta.size } : {}) };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw mapError(e, k);
    }
  }

  async delete(key: string): Promise<void> {
    const k = normalizeKey(key);
    try {
      await this.files.delete(k);
    } catch (e) {
      if (isNotFound(e)) return;
      throw mapError(e, k);
    }
  }
}
