import { utf8Decode, utf8Encode } from '../core/codec.js';
import { CasConflictError, NotFoundError } from '../core/types.js';
import type { RemoteBackend, RetryOptions } from '../core/types.js';
import { normalizeKey, withRetry } from './backend.js';

export interface SegmentDesc {
  from: number;
  to: number;
  key: string;
  bytes: number;
  hash: string;
}

/** One manifest per site, written ONLY by that site -> no cross-device CAS contention. */
export interface SiteManifest {
  v: number;
  site: string;
  epoch: string;
  resolver: string;
  strategy: string;
  codec: string;
  segments: SegmentDesc[];
  lastSeq: number;
  /** Version vector of what THIS site has applied (used by gc()). */
  applied: Record<string, number>;
}

export interface SnapshotPointer {
  key: string;
  vv: Record<string, number>;
  epoch: string;
  resolver: string;
  strategy: string;
  createdBy: string;
}

export interface Layout {
  root: string;
  manifestPrefix: string;
  segmentsRoot: string;
  snapshotsRoot: string;
  snapshotPointerKey: string;
  manifestKey(site: string): string;
  segmentPrefix(site: string): string;
  segmentKey(site: string, from: number, to: number, hash: string): string;
  snapshotKey(hash: string): string;
}

export function safeSite(site: string): string {
  return encodeURIComponent(site);
}

export function createLayout(appId: string): Layout {
  const root = normalizeKey(appId);
  const p = (x: string): string => `${root}/${x}`;
  return {
    root,
    manifestPrefix: p('manifest/'),
    segmentsRoot: p('segments/'),
    snapshotsRoot: p('snapshots/'),
    snapshotPointerKey: p('snapshot.json'),
    manifestKey: (site) => p(`manifest/${safeSite(site)}.json`),
    segmentPrefix: (site) => p(`segments/${safeSite(site)}/`),
    segmentKey: (site, from, to, hash) =>
      p(`segments/${safeSite(site)}/${from}-${to}-${hash}.seg`),
    snapshotKey: (hash) => p(`snapshots/${hash}.snap`),
  };
}

const SEGMENT_NAME = /\/(\d+)-(\d+)-([a-f0-9]+)\.seg$/;

export function parseSegmentName(key: string): { from: number; to: number; hash: string } | null {
  const m = SEGMENT_NAME.exec(key);
  return m ? { from: Number(m[1]), to: Number(m[2]), hash: m[3]! } : null;
}

export interface JsonRead<T> {
  value: T | null;
  etag?: string;
  notModified: boolean;
}

export async function readJson<T>(
  backend: RemoteBackend,
  key: string,
  etag?: string,
): Promise<JsonRead<T>> {
  try {
    const r = await backend.get(key, etag ? { etag } : {});
    if (r.notModified) return { value: null, etag: r.etag ?? etag, notModified: true };
    return {
      value: JSON.parse(utf8Decode(r.data)) as T,
      ...(r.etag ? { etag: r.etag } : {}),
      notModified: false,
    };
  } catch (e) {
    if (e instanceof NotFoundError) return { value: null, notModified: false };
    throw e;
  }
}

async function putJson(
  backend: RemoteBackend,
  key: string,
  value: unknown,
  etag?: string,
  createOnly = false,
): Promise<void> {
  await backend.put(key, utf8Encode(JSON.stringify(value)), {
    ...(etag ? { etag } : {}),
    ...(createOnly ? { createOnly } : {}),
    contentType: 'application/json',
  });
}

/**
 * Compare-and-swap with RE-BASE on 412. `mutate` is re-applied to the fresh
 * manifest after every conflict, so a losing writer can never erase a
 * concurrent update. Never blindly retries a stale body.
 */
export async function updateManifest(
  backend: RemoteBackend,
  key: string,
  mutate: (current: SiteManifest | null) => SiteManifest,
  casSupported: boolean,
  retry?: RetryOptions,
): Promise<SiteManifest> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const read = await withRetry(() => readJson<SiteManifest>(backend, key), retry);
    const next = mutate(read.value);
    next.v = (read.value?.v ?? 0) + 1;
    try {
      const createOnly = casSupported && !read.value;
      await putJson(backend, key, next, casSupported ? read.etag : undefined, createOnly);
      return next;
    } catch (e) {
      if (e instanceof CasConflictError && attempt < 5) continue;
      throw e;
    }
  }
  throw new Error(`sqlite-remote-sync: could not update ${key} after 6 CAS attempts`);
}

export interface ManifestCacheEntry {
  etag?: string;
  manifest: SiteManifest;
}

/** Site ids that have published a manifest. */
export async function listManifestSites(
  backend: RemoteBackend,
  layout: Layout,
): Promise<string[]> {
  const entries = await withRetry(() => backend.list(layout.manifestPrefix));
  return entries
    .map((e) => e.key)
    .filter((k) => k.startsWith(layout.manifestPrefix) && k.endsWith('.json'))
    .map((k) => decodeURIComponent(k.slice(layout.manifestPrefix.length, -5)));
}

/** Site ids that have segment files (heals orphans with no manifest). */
export async function listSegmentSites(
  backend: RemoteBackend,
  layout: Layout,
): Promise<string[]> {
  const entries = await withRetry(() => backend.list(layout.segmentsRoot));
  const sites = new Set<string>();
  for (const e of entries) {
    const rest = e.key.slice(layout.segmentsRoot.length);
    const slash = rest.indexOf('/');
    if (slash > 0) sites.add(decodeURIComponent(rest.slice(0, slash)));
  }
  return [...sites];
}

/** All segment files for one site, discovered from the immutable object store. */
export async function listSegmentFiles(
  backend: RemoteBackend,
  layout: Layout,
  site: string,
): Promise<SegmentDesc[]> {
  const prefix = layout.segmentPrefix(site);
  const entries = await withRetry(() => backend.list(prefix));
  const out: SegmentDesc[] = [];
  for (const e of entries) {
    if (!e.key.startsWith(prefix)) continue;
    const m = parseSegmentName(e.key);
    if (m) out.push({ ...m, key: e.key, bytes: e.size ?? 0 });
  }
  return out.sort((a, b) => a.from - b.from);
}

export function vvAtLeast(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  for (const [site, seq] of Object.entries(b)) {
    if ((a[site] ?? 0) < seq) return false;
  }
  return true;
}

/** Monotonically advance the shared snapshot pointer (CAS re-base). */
export async function updateSnapshotPointer(
  backend: RemoteBackend,
  key: string,
  candidate: SnapshotPointer,
  casSupported: boolean,
): Promise<SnapshotPointer | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const read = await readJson<SnapshotPointer>(backend, key);
    if (read.value && !vvAtLeast(candidate.vv, read.value.vv)) return null;
    try {
      await putJson(backend, key, candidate, casSupported ? read.etag : undefined, casSupported && !read.value);
      return candidate;
    } catch (e) {
      if (e instanceof CasConflictError && attempt < 5) continue;
      throw e;
    }
  }
  return null;
}
