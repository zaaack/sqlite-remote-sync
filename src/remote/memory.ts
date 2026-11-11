import { CasConflictError, NotFoundError } from '../core/types.js';
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

interface Stored {
  data: Uint8Array;
  etag: string;
}

/**
 * In-memory backend with full ETag / If-Match / If-None-Match / Range
 * semantics. Intended for tests and as a reference implementation of the
 * `RemoteBackend` contract.
 */
export class MemoryBackend implements RemoteBackend {
  private readonly store = new Map<string, Stored>();
  private version = 0;

  async get(key: string, opts: RemoteGetOptions = {}): Promise<RemoteGetResult> {
    const k = normalizeKey(key);
    const cur = this.store.get(k);
    if (!cur) throw new NotFoundError(k);
    if (opts.etag && cur.etag === opts.etag) {
      return { data: new Uint8Array(), etag: cur.etag, notModified: true };
    }
    if (opts.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(opts.range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : cur.data.length - 1;
        return {
          data: cur.data.slice(start, end + 1),
          etag: cur.etag,
          totalSize: cur.data.length,
        };
      }
    }
    return { data: cur.data.slice(), etag: cur.etag };
  }

  async put(key: string, data: Uint8Array, opts: RemotePutOptions = {}): Promise<RemotePutResult> {
    const k = normalizeKey(key);
    const cur = this.store.get(k);
    if (opts.createOnly && cur) throw new CasConflictError(k);
    if (opts.etag !== undefined) {
      if (!cur || cur.etag !== opts.etag) throw new CasConflictError(k);
    }
    const etag = `"v${++this.version}"`;
    this.store.set(k, { data: data.slice(), etag });
    return { etag };
  }

  async list(prefix: string): Promise<RemoteEntry[]> {
    const p = normalizeKey(prefix);
    const out: RemoteEntry[] = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(p)) out.push({ key: k, etag: v.etag, size: v.data.byteLength });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async head(key: string): Promise<RemoteHead | null> {
    const cur = this.store.get(normalizeKey(key));
    return cur ? { etag: cur.etag, size: cur.data.byteLength } : null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(normalizeKey(key));
  }

  /** Test helpers. */
  keys(): string[] {
    return [...this.store.keys()].sort();
  }

  raw(key: string): Uint8Array | undefined {
    return this.store.get(normalizeKey(key))?.data;
  }

  size(): number {
    return this.store.size;
  }
}
