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
import { normalizeKey, withRetry } from './backend.js';

export interface GenericHttpBackendOptions {
  /** Base URL of the object API, e.g. `https://api.example.com/sync`. */
  baseUrl: string;
  /** Extra headers (Authorization, API key, ...). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  fetch?: typeof globalThis.fetch;
  retry?: RetryOptions;
  /** Query parameter used for directory listing. Default `list=1`. */
  listQuery?: string;
}

/**
 * Generic REST/ETag backend. Implements this tiny contract:
 *
 *   GET    <base>/<key>              -> bytes, ETag, supports If-None-Match / Range
 *   PUT    <base>/<key>              -> honours If-Match; returns ETag
 *   HEAD   <base>/<key>              -> ETag + Content-Length
 *   DELETE <base>/<key>
 *   GET    <base>/<prefix>?list=1    -> JSON array (or {entries:[]}) of {key,etag,size}
 *
 * A ~60-line Cloudflare Worker / Node handler can implement it, which makes
 * this the easiest way to plug in S3/R2/OSS or your own backend API.
 */
export class GenericHttpBackend implements RemoteBackend {
  private readonly base: string;
  private readonly headersOpt?: GenericHttpBackendOptions['headers'];
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly retry?: RetryOptions;
  private readonly listQuery: string;

  constructor(options: GenericHttpBackendOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.headersOpt = options.headers;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = options.retry;
    this.listQuery = options.listQuery ?? 'list=1';
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (!this.headersOpt) return {};
    return typeof this.headersOpt === 'function' ? this.headersOpt() : this.headersOpt;
  }

  private urlFor(key: string): string {
    const k = normalizeKey(key);
    return `${this.base}/${k.split('/').map(encodeURIComponent).join('/')}`;
  }

  private etagOf(r: Response): string | undefined {
    return r.headers.get('etag') ?? undefined;
  }

  private checkStatus(r: Response, key: string): void {
    if (r.status === 404) throw new NotFoundError(key);
    if (r.status === 412) throw new CasConflictError(key);
    if (!r.ok) throw new RemoteError(`HTTP ${r.status} for ${key}`, r.status, key);
  }

  async get(key: string, opts: RemoteGetOptions = {}): Promise<RemoteGetResult> {
    const k = normalizeKey(key);
    return withRetry(async () => {
      const h: Record<string, string> = { ...(await this.authHeaders()) };
      if (opts.etag) h['If-None-Match'] = opts.etag;
      if (opts.range) h['Range'] = opts.range;
      const r = await this.fetchFn(this.urlFor(k), { method: 'GET', headers: h, signal: opts.signal });
      if (r.status === 304) {
        return { data: new Uint8Array(), etag: this.etagOf(r), notModified: true };
      }
      this.checkStatus(r, k);
      const buf = new Uint8Array(await r.arrayBuffer());
      const total = r.headers.get('content-range');
      return {
        data: buf,
        etag: this.etagOf(r),
        ...(total ? { totalSize: Number(total.split('/')[1]) } : {}),
      };
    }, this.retry);
  }

  async put(key: string, data: Uint8Array, opts: RemotePutOptions = {}): Promise<RemotePutResult> {
    const k = normalizeKey(key);
    return withRetry(async () => {
      const h: Record<string, string> = {
        ...(await this.authHeaders()),
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
      return { etag: this.etagOf(r) };
    }, this.retry);
  }

  async list(prefix: string): Promise<RemoteEntry[]> {
    const p = normalizeKey(prefix);
    return withRetry(async () => {
      const h = { ...(await this.authHeaders()) };
      const sep = this.listQuery.startsWith('?') ? '' : '?';
      const r = await this.fetchFn(`${this.urlFor(p)}${sep}${this.listQuery}`, {
        method: 'GET',
        headers: h,
      });
      if (r.status === 404) return [];
      this.checkStatus(r, p);
      const json = (await r.json()) as unknown;
      const arr = Array.isArray(json)
        ? (json as RemoteEntry[])
        : (((json as { entries?: RemoteEntry[] }).entries ?? []) as RemoteEntry[]);
      return arr.map((e) => ({ key: normalizeKey(e.key), ...(e.etag ? { etag: e.etag } : {}), ...(e.size !== undefined ? { size: e.size } : {}) }));
    }, this.retry);
  }

  async head(key: string): Promise<RemoteHead | null> {
    const k = normalizeKey(key);
    return withRetry(async () => {
      const r = await this.fetchFn(this.urlFor(k), {
        method: 'HEAD',
        headers: { ...(await this.authHeaders()) },
      });
      if (r.status === 404) return null;
      this.checkStatus(r, k);
      const len = r.headers.get('content-length');
      return { ...(this.etagOf(r) ? { etag: this.etagOf(r) } : {}), ...(len ? { size: Number(len) } : {}) };
    }, this.retry);
  }

  async delete(key: string): Promise<void> {
    const k = normalizeKey(key);
    await withRetry(async () => {
      const r = await this.fetchFn(this.urlFor(k), {
        method: 'DELETE',
        headers: { ...(await this.authHeaders()) },
      });
      if (r.status === 404) return;
      this.checkStatus(r, k);
    }, this.retry);
  }
}
