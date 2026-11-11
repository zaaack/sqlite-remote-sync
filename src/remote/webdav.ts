import { CasConflictError, NotFoundError, RemoteError } from '../core/types.js';
import type {
  RemoteBackend,
  RemoteEntry,
  RemoteGetOptions,
  RemoteGetResult,
  RemoteHead,
  RemotePutOptions,
  RemotePutResult,
  RetryOptions,
} from '../core/types.js';
import { base64Encode, utf8Encode } from '../core/codec.js';
import { normalizeKey, withRetry } from './backend.js';

export interface WebDavBackendOptions {
  /** Base collection URL, e.g. `https://dav.example.com/remote.php/dav/files/me/`. */
  url: string;
  username?: string;
  password?: string;
  /** Bearer token (alternative to Basic auth). */
  token?: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  fetch?: typeof globalThis.fetch;
  retry?: RetryOptions;
}

interface DavChild {
  key: string;
  etag?: string;
  size?: number;
  isDir: boolean;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:getetag/><d:getcontentlength/><d:resourcetype/>' +
  '</d:prop></d:propfind>';

/**
 * WebDAV backend. Uses GET/PUT/DELETE/HEAD/MKCOL plus PROPFIND (Depth: 1,
 * traversed recursively) for listing, and ETag/If-Match/If-None-Match for
 * optimistic concurrency and conditional reads. Works with Nextcloud,
 * ownCloud, Synology, Apache mod_dav, nginx dav, rclone serve, Caddy, etc.
 */
export class WebDavBackend implements RemoteBackend {
  private readonly base: string;
  private readonly basePath: string;
  private readonly auth: Record<string, string>;
  private readonly headersOpt?: WebDavBackendOptions['headers'];
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly retry?: RetryOptions;
  /**
   * In-flight (or completed) MKCOL per collection path. Sharing the promise —
   * rather than caching a boolean — prevents concurrent `put()` calls from all
   * observing an empty cache and issuing duplicate MKCOLs for the same dir.
   */
  private readonly createdDirs = new Map<string, Promise<void>>();

  constructor(options: WebDavBackendOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.basePath = decodeURIComponent(new URL(this.base).pathname).replace(/\/+$/, '') + '/';
    this.auth = {};
    if (options.token) this.auth['Authorization'] = `Bearer ${options.token}`;
    else if (options.username !== undefined) {
      const raw = `${options.username}:${options.password ?? ''}`;
      this.auth['Authorization'] = `Basic ${base64Encode(utf8Encode(raw))}`;
    }
    this.headersOpt = options.headers;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = options.retry;
  }

  private async headers(): Promise<Record<string, string>> {
    const extra = this.headersOpt
      ? typeof this.headersOpt === 'function'
        ? await this.headersOpt()
        : this.headersOpt
      : {};
    return { ...this.auth, ...extra };
  }

  private urlFor(key: string): string {
    const k = normalizeKey(key);
    return `${this.base}/${k.split('/').map(encodeURIComponent).join('/')}`;
  }

  private checkStatus(r: Response, key: string): void {
    if (r.status === 404) throw new NotFoundError(key);
    if (r.status === 412) throw new CasConflictError(key);
    if (!r.ok) throw new RemoteError(`HTTP ${r.status} for ${key}`, r.status, key);
  }

  private etagOf(r: Response): string | undefined {
    return r.headers.get('etag') ?? undefined;
  }

  /** Create parent collections once per session (MKCOL 405 = already exists). */
  private async ensureCollection(key: string): Promise<void> {
    const parts = normalizeKey(key).split('/');
    parts.pop();
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let inflight = this.createdDirs.get(path);
      if (!inflight) {
        const target = this.urlFor(path);
        inflight = (async () => {
          try {
            await this.fetchFn(target, { method: 'MKCOL', headers: await this.headers() });
          } catch {
            /* PUT will surface a real error if the collection is unusable */
          }
        })();
        this.createdDirs.set(path, inflight);
      }
      await inflight;
    }
  }

  async get(key: string, opts: RemoteGetOptions = {}): Promise<RemoteGetResult> {
    const k = normalizeKey(key);
    return withRetry(async () => {
      const h = { ...(await this.headers()) };
      if (opts.etag) h['If-None-Match'] = opts.etag;
      if (opts.range) h['Range'] = opts.range;
      const r = await this.fetchFn(this.urlFor(k), { method: 'GET', headers: h, signal: opts.signal });
      if (r.status === 304) return { data: new Uint8Array(), etag: this.etagOf(r), notModified: true };
      this.checkStatus(r, k);
      const buf = new Uint8Array(await r.arrayBuffer());
      const cr = r.headers.get('content-range');
      return {
        data: buf,
        etag: this.etagOf(r),
        ...(cr ? { totalSize: Number(cr.split('/')[1]) } : {}),
      };
    }, this.retry);
  }

  async put(key: string, data: Uint8Array, opts: RemotePutOptions = {}): Promise<RemotePutResult> {
    const k = normalizeKey(key);
    await this.ensureCollection(k);
    return withRetry(async () => {
      const h: Record<string, string> = {
        ...(await this.headers()),
        'Content-Type': opts.contentType ?? 'application/octet-stream',
      };
      if (opts.etag) h['If-Match'] = opts.etag;
      if (opts.createOnly) h['If-None-Match'] = '*';
      const r = await this.fetchFn(this.urlFor(k), {
        method: 'PUT',
        headers: h,
        body: data as BodyInit,
        signal: opts.signal,
      });
      this.checkStatus(r, k);
      // Return whatever ETag the PUT response carries. We deliberately do NOT
      // fall back to HEAD: on ETag-less servers (e.g. webdav-server) that would
      // add a second request to every single write for a value no caller uses —
      // CAS is driven by the ETag obtained from GET (readJson), never from PUT.
      const etag = this.etagOf(r);
      return { ...(etag ? { etag } : {}) };
    }, this.retry);
  }

  async head(key: string): Promise<RemoteHead | null> {
    const k = normalizeKey(key);
    return withRetry(async () => {
      const r = await this.fetchFn(this.urlFor(k), { method: 'HEAD', headers: await this.headers() });
      if (r.status === 404) return null;
      this.checkStatus(r, k);
      const len = r.headers.get('content-length');
      return {
        ...(this.etagOf(r) ? { etag: this.etagOf(r) } : {}),
        ...(len ? { size: Number(len) } : {}),
      };
    }, this.retry);
  }

  async delete(key: string): Promise<void> {
    const k = normalizeKey(key);
    await withRetry(async () => {
      const r = await this.fetchFn(this.urlFor(k), { method: 'DELETE', headers: await this.headers() });
      if (r.status === 404) return;
      this.checkStatus(r, k);
    }, this.retry);
  }

  private async propfind(dir: string): Promise<DavChild[]> {
    const target = dir ? `${this.urlFor(dir)}/` : `${this.base}/`;
    const r = await this.fetchFn(target, {
      method: 'PROPFIND',
      headers: { ...(await this.headers()), Depth: '1', 'Content-Type': 'application/xml' },
      body: PROPFIND_BODY,
    });
    if (r.status === 404) return [];
    this.checkStatus(r, dir);
    return parsePropfind(await r.text(), this.basePath);
  }

  /** Recursive listing (Depth: 1 per collection; infinity is often disabled). */
  async list(prefix: string): Promise<RemoteEntry[]> {
    const root = normalizeKey(prefix);
    const found = new Map<string, RemoteEntry>();
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      const children = await withRetry(() => this.propfind(dir), this.retry);
      for (const c of children) {
        // Servers include the requested collection itself in the 207 response;
        // skip it (and anything outside this subtree) to avoid loops/dupes.
        if (dir && (c.key === dir || !c.key.startsWith(`${dir}/`))) continue;
        if (c.isDir) await visit(c.key, depth + 1);
        else {
          found.set(c.key, {
            key: c.key,
            ...(c.etag ? { etag: c.etag } : {}),
            ...(c.size !== undefined ? { size: c.size } : {}),
          });
        }
      }
    };
    await visit(root, 0);
    return [...found.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

/** Namespace-agnostic parser for a WebDAV 207 Multi-Status body. */
export function parsePropfind(xml: string, basePath: string): DavChild[] {
  const out: DavChild[] = [];
  const blocks = xml.split(/<(?:\w+:)?response\b[^>]*>/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/<\/(?:\w+:)?response>/i)[0] ?? block;
    const pick = (tag: string): string | undefined => {
      const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(body);
      return m?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    const hrefRaw = pick('href');
    if (!hrefRaw) continue;
    let pathname: string;
    try {
      pathname = /^https?:\/\//i.test(hrefRaw) ? new URL(hrefRaw).pathname : hrefRaw.split('?')[0]!;
    } catch {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = pathname;
    }
    if (!decoded.startsWith(basePath)) continue;
    const key = decoded.slice(basePath.length).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!key) continue;
    const isDir = /<(?:\w+:)?collection\b/i.test(body) || decoded.endsWith('/');
    const len = pick('getcontentlength');
    out.push({
      key,
      isDir,
      ...(pick('getetag') ? { etag: pick('getetag') } : {}),
      ...(len ? { size: Number(len) } : {}),
    });
  }
  return out;
}
