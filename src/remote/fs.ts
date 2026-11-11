import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
import { fingerprint } from '../core/codec.js';
import { normalizeKey } from './backend.js';

/**
 * Local-folder backend for Node, Electron main process and desktop tests.
 * Keys map to files under `root`. ETags are content fingerprints, so CAS is
 * exact and works across processes. Import it from
 * `sqlite-remote-sync/backends/fs` (Node only — it pulls in `node:fs`).
 */
export class FsBackend implements RemoteBackend {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const k = normalizeKey(key);
    if (k.split('/').includes('..')) throw new Error(`sqlite-remote-sync: invalid key ${key}`);
    const p = resolve(join(this.root, k));
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error(`sqlite-remote-sync: key escapes root: ${key}`);
    }
    return p;
  }

  private async etagFor(path: string): Promise<string | null> {
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
      const data = await readFile(path);
      return `"fp-${fingerprint(data)}"`;
    } catch {
      return null;
    }
  }

  async get(key: string, opts: RemoteGetOptions = {}): Promise<RemoteGetResult> {
    const k = normalizeKey(key);
    const p = this.pathFor(k);
    const etag = await this.etagFor(p);
    if (!etag) throw new NotFoundError(k);
    if (opts.etag && etag === opts.etag) {
      return { data: new Uint8Array(), etag, notModified: true };
    }
    const data = new Uint8Array(await readFile(p));
    if (opts.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(opts.range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : data.length - 1;
        return { data: data.slice(start, end + 1), etag, totalSize: data.length };
      }
    }
    return { data, etag };
  }

  async put(key: string, data: Uint8Array, opts: RemotePutOptions = {}): Promise<RemotePutResult> {
    const k = normalizeKey(key);
    const p = this.pathFor(k);
    if (opts.createOnly && (await this.etagFor(p))) throw new CasConflictError(k);
    if (opts.etag !== undefined) {
      const cur = await this.etagFor(p);
      if (!cur || cur !== opts.etag) throw new CasConflictError(k);
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    const etag = await this.etagFor(p);
    return { ...(etag ? { etag } : {}) };
  }

  async head(key: string): Promise<RemoteHead | null> {
    const p = this.pathFor(normalizeKey(key));
    try {
      const s = await stat(p);
      if (!s.isFile()) return null;
      const etag = await this.etagFor(p);
      return { ...(etag ? { etag } : {}), size: s.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(normalizeKey(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async list(prefix: string): Promise<RemoteEntry[]> {
    const p = normalizeKey(prefix);
    const dir = p ? this.pathFor(p) : this.root;
    const out: RemoteEntry[] = [];
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const key = relative(this.root, full).split(sep).join('/');
          const etag = await this.etagFor(full);
          const s = await stat(full);
          out.push({ key, ...(etag ? { etag } : {}), size: s.size });
        }
      }
    };
    await walk(dir);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}
