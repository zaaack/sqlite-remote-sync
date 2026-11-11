export { CasConflictError, NotFoundError, RemoteError } from '../core/types.js';
export type {
  RemoteBackend,
  RemoteEntry,
  RemoteGetOptions,
  RemoteGetResult,
  RemoteHead,
  RemotePutOptions,
  RemotePutResult,
  RetryOptions,
} from '../core/types.js';

import type { RetryOptions } from '../core/types.js';

/** Normalize a backend key: `/`-separated, no leading/trailing slash. */
export function normalizeKey(key: string): string {
  return key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** `fetch`-friendly delay. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry transient failures with exponential backoff + jitter.
 * `CasConflictError` (412) is never retried here — it is a signal to re-base.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 120;
  const max = options.maxDelayMs ?? 4000;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const status = (e as { status?: number })?.status;
      const name = (e as { name?: string })?.name;
      if (name === 'CasConflictError' || name === 'NotFoundError') throw e;
      if (status !== undefined && status >= 400 && status < 500) throw e;
      if (i === attempts - 1) throw e;
      const wait = Math.min(max, base * 2 ** i) * (0.7 + Math.random() * 0.6);
      await delay(wait);
    }
  }
  throw lastError;
}

/** Best-effort check that the backend really honours `If-Match` (412). */
export async function probeIfMatch(
  backend: {
    put(k: string, d: Uint8Array, o?: { etag?: string }): Promise<unknown>;
    delete(k: string): Promise<void>;
  },
  probeKey: string,
): Promise<boolean> {
  try {
    await backend.put(probeKey, new Uint8Array(), { etag: '"__definitely_not_matching__"' });
    // Server ignored If-Match and created the object: clean up.
    await backend.delete(probeKey).catch(() => undefined);
    return false;
  } catch (e) {
    if ((e as { name?: string })?.name === 'CasConflictError') return true;
    // A 404/409 for a missing resource is also acceptable conditional behaviour.
    if ((e as { status?: number })?.status === 404 || (e as { status?: number })?.status === 409) {
      return true;
    }
    return false;
  }
}
