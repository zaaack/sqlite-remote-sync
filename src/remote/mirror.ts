import { NotFoundError } from '../core/types.js';
import type {
  MirrorError,
  MirrorOptions,
  RemoteBackend,
  RemoteEntry,
  RemoteGetOptions,
  RemoteGetResult,
  RemoteHead,
  RemotePutOptions,
  RemotePutResult,
} from '../core/types.js';
import { normalizeKey } from './backend.js';

export type { MirrorError, MirrorOptions } from '../core/types.js';

/**
 * Replicate ONE database to several cloud drives at once (multi-cloud / 多网盘).
 *
 * `MirrorBackend` composes any number of `RemoteBackend`s and implements the
 * same interface, so the sync engine needs no changes:
 *
 *   new MirrorBackend([new WebDavBackend(jianguo), new WebDavBackend(nextcloud), s3])
 *
 * - Writes (`put` / `delete`) are broadcast to every backend.
 * - Reads (`get`) try backends in order and fall back on a 404 or a transient
 *   error, so one cloud being offline does not break pulls.
 * - `list()` returns the union — orphaned segments on any cloud are healed.
 * - `head()` returns the first hit.
 *
 * ### Why no ETag / CAS
 * ETags are local to a single server, so a single `If-Match` token can never
 * be valid across different providers. The mirror therefore deliberately
 * drops `etag`/`createOnly` on writes and never returns ETags on reads. This
 * makes `probeIfMatch()` report "CAS unavailable" and the engine switches to
 * its no-CAS path (per-site manifests + re-base + list/union discovery) —
 * the same well-tested path used for `webdav-server`. The trade-off is that
 * conditional 304 reads are unavailable on a mirror; use a single backend if
 * you need them.
 *
 * Consistency note: each manifest key is owned by exactly one site, so even
 * with a stale read from a lagging replica no other writer can lose an update.
 */
export class MirrorBackend implements RemoteBackend {
  /** The composed backends, in read-preference order. */
  readonly backends: readonly RemoteBackend[];
  private readonly quorum: number;
  private readonly onError?: (err: MirrorError) => void;

  constructor(backends: readonly RemoteBackend[], options: MirrorOptions = {}) {
    if (!backends.length) {
      throw new Error('sqlite-remote-sync: MirrorBackend needs at least one backend');
    }
    this.backends = [...backends];
    const wq = options.writeQuorum ?? 'all';
    this.quorum =
      wq === 'all'
        ? this.backends.length
        : Math.max(1, Math.min(this.backends.length, Math.floor(wq)));
    if (options.onBackendError) this.onError = options.onBackendError;
  }

  /** ETags are backend-local: never forward a conditional-read token. */
  private static readOpts(opts: RemoteGetOptions): RemoteGetOptions {
    const out: RemoteGetOptions = {};
    if (opts.range !== undefined) out.range = opts.range;
    if (opts.signal !== undefined) out.signal = opts.signal;
    return out;
  }

  /** Never forward `If-Match` / create-only to a different provider. */
  private static writeOpts(opts: RemotePutOptions): RemotePutOptions {
    const out: RemotePutOptions = {};
    if (opts.contentType !== undefined) out.contentType = opts.contentType;
    if (opts.signal !== undefined) out.signal = opts.signal;
    return out;
  }

  async get(key: string, opts: RemoteGetOptions = {}): Promise<RemoteGetResult> {
    const k = normalizeKey(key);
    const fwd = MirrorBackend.readOpts(opts);
    let lastError: unknown = new NotFoundError(k);
    for (const b of this.backends) {
      try {
        const r = await b.get(k, fwd);
        // Strip etag/notModified so the composite is consistently no-CAS.
        return {
          data: r.data,
          ...(r.totalSize !== undefined ? { totalSize: r.totalSize } : {}),
        };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  async put(key: string, data: Uint8Array, opts: RemotePutOptions = {}): Promise<RemotePutResult> {
    const k = normalizeKey(key);
    const fwd = MirrorBackend.writeOpts(opts);
    const results = await Promise.allSettled(this.backends.map((b) => b.put(k, data, fwd)));
    let ok = 0;
    let firstError: unknown;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'fulfilled') {
        ok++;
      } else {
        firstError ??= r.reason;
        this.onError?.({ index: i, op: 'put', error: r.reason });
      }
    }
    if (ok < this.quorum) {
      throw firstError ?? new Error(`sqlite-remote-sync: mirror write quorum not met for ${k}`);
    }
    return {}; // no ETag: composite is intentionally no-CAS
  }

  async list(prefix: string): Promise<RemoteEntry[]> {
    const p = normalizeKey(prefix);
    const results = await Promise.allSettled(this.backends.map((b) => b.list(p)));
    const byKey = new Map<string, RemoteEntry>();
    let ok = 0;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      ok++;
      for (const e of r.value) {
        if (!byKey.has(e.key)) {
          byKey.set(e.key, { key: e.key, ...(e.etag ? { etag: e.etag } : {}), ...(e.size !== undefined ? { size: e.size } : {}) });
        }
      }
    }
    if (!ok) {
      throw (results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined)?.reason
        ?? new Error(`sqlite-remote-sync: every mirror backend failed to list ${p}`);
    }
    return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async head(key: string): Promise<RemoteHead | null> {
    const k = normalizeKey(key);
    for (const b of this.backends) {
      try {
        const r = await b.head(k);
        if (r) return { ...(r.size !== undefined ? { size: r.size } : {}) };
      } catch {
        /* try the next replica */
      }
    }
    return null;
  }

  async delete(key: string): Promise<void> {
    const k = normalizeKey(key);
    const results = await Promise.allSettled(this.backends.map((b) => b.delete(k)));
    let ok = 0;
    let firstError: unknown;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'fulfilled') {
        ok++;
      } else {
        firstError ??= r.reason;
        this.onError?.({ index: i, op: 'delete', error: r.reason });
      }
    }
    if (ok < this.quorum) {
      throw firstError ?? new Error(`sqlite-remote-sync: mirror delete quorum not met for ${k}`);
    }
  }
}
