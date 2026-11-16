import { createMutex, probeCapabilities } from './adapter.js';
import { buildOpsFromOutbox, captureRowChange, type BuiltOps } from './capture.js';
import { resolveCodec } from './codec.js';
import { buildSegments, decodeSegment } from './segment.js';
import { buildSnapshot, decodeSnapshot, snapshotToOps } from './snapshot.js';
import { applyOps } from './replay.js';
import { resolveResolver } from './resolver.js';
import {
  discoverSchemas,
  getAllCursors,
  installSchema,
  readMeta,
  writeMeta,
  type TableSchema,
} from './schema.js';
import { nowMs } from './clock.js';
import type {
  Capabilities,
  ConflictResolver,
  Codec,
  RemoteBackend,
  SqlValue,
  SyncConfig,
  SyncEngine,
  SyncEvent,
  SyncListener,
  SyncOp,
  SyncStats,
} from './types.js';
import { NotFoundError } from './types.js';
import { probeIfMatch } from '../remote/backend.js';
import { MirrorBackend } from '../remote/mirror.js';
import {
  listManifestSites,
  listSegmentFiles,
  listSegmentSites,
  readJson,
  updateManifest,
  updateSnapshotPointer,
  vvAtLeast,
  createLayout,
  type Layout,
  type ManifestCacheEntry,
  type SegmentDesc,
  type SiteManifest,
  type SnapshotPointer,
} from '../remote/manifest.js';

const DEFAULTS = {
  segmentMaxBytes: 512 * 1024,
  segmentMaxOps: 2000,
  blobThreshold: 0,
  concurrency: 4,
  compactAfterSegments: 24,
  autoCompact: true,
  healInterval: 10,
  clockSkewMs: 0,
  debounceMs: 0,
};

function emptyStats(): SyncStats {
  return {
    pushedOps: 0,
    pushedSegments: 0,
    pushedBytes: 0,
    pulledSegments: 0,
    pulledOps: 0,
    pulledBytes: 0,
    appliedOps: 0,
    conflicts: 0,
    snapshotsApplied: 0,
    durationMs: 0,
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface EngineState {
  initialized: boolean;
  syncing: boolean;
  closed: boolean;
  syncCount: number;
  cap: Capabilities;
  schemas: TableSchema[];
  epoch: string;
  resolver: ConflictResolver;
  strategy: 'row' | 'field';
  codec: Codec;
  layout: Layout;
  casSupported: boolean;
  manifestCache: Map<string, ManifestCacheEntry>;
  pointerEtag?: string;
  listeners: Set<SyncListener>;
  timer?: ReturnType<typeof setInterval>;
}

/**
 * Create a sync engine. Call `await engine.init()` once before any operation.
 */
export function createSyncEngine(config: SyncConfig): SyncEngine {
  const db = config.db;
  // `backends` (multi-cloud) takes precedence; a single target is used
  // directly so nothing changes for the classic `backend` config.
  const targets = config.backends?.length
    ? [...config.backends]
    : config.backend
      ? [config.backend]
      : [];
  if (!targets.length) {
    throw new Error('sqlite-remote-sync: provide `backend` or `backends` in the config');
  }
  const backend: RemoteBackend =
    targets.length === 1 ? targets[0]! : new MirrorBackend(targets, config.mirror);
  const log = config.logger;
  const mutex = createMutex();

  const st: EngineState = {
    initialized: false,
    syncing: false,
    closed: false,
    syncCount: 0,
    cap: { triggers: true, json: true, printf: true, clock: 'seconds', subsecondNowExpr: '' },
    schemas: [],
    epoch: '',
    resolver: resolveResolver(config),
    strategy: config.strategy ?? 'row',
    codec: resolveCodec(config.compress === false ? false : config.codec ?? true),
    layout: createLayout(config.appId),
    casSupported: true,
    manifestCache: new Map(),
    listeners: new Set(),
  };

  const emit = (e: SyncEvent): void => {
    for (const l of st.listeners) {
      try {
        l(e);
      } catch (err) {
        log?.error?.('listener error', err);
      }
    }
  };

  const assertReady = (): void => {
    if (!st.initialized) throw new Error('sqlite-remote-sync: call await engine.init() first');
    if (st.closed) {
      throw new Error(
        'sqlite-remote-sync: engine is closed. This engine was disposed, usually because ' +
          'a newer engine replaced it during a reconfiguration. Obtain the current engine ' +
          'from your engine manager before calling push()/pull()/sync() again.',
      );
    }
  };

  const retry = config.retry;
  const concurrency = config.concurrency ?? DEFAULTS.concurrency;
  const segmentMaxBytes = config.segmentMaxBytes ?? DEFAULTS.segmentMaxBytes;
  const segmentMaxOps = config.segmentMaxOps ?? DEFAULTS.segmentMaxOps;
  const blobThreshold = config.blobThreshold ?? DEFAULTS.blobThreshold;
  const healInterval = Math.max(1, config.healInterval ?? DEFAULTS.healInterval);
  const clockSkewMs = config.clockSkewMs ?? DEFAULTS.clockSkewMs;

  const readLastPushed = async (): Promise<number> => Number((await readMeta(db, 'last_pushed_seq')) ?? '0');

  /**
   * Fold every pending local outbox entry into the local LWW-Map state.
   * Called at the start of BOTH pull and push so local writes are visible to
   * the join before any remote op can win. Idempotent; the outbox is only
   * cleared after a successful push, so retries are byte-for-byte identical.
   */
  const ingestLocal = async (): Promise<BuiltOps> => {
    const built = await buildOpsFromOutbox(
      db,
      config.siteId,
      st.schemas,
      st.strategy,
      await readLastPushed(),
      blobThreshold,
    );
    if (built.ops.length) {
      await db.transaction((tx) =>
        applyOps(tx, {
          ops: built.ops,
          schemas: st.schemas,
          resolver: st.resolver,
          strategy: st.strategy,
          blobs: built.blobs,
        }),
      );
    }
    return built;
  };

  const checkManifest = (m: SiteManifest): void => {
    if (m.epoch !== st.epoch || m.resolver !== st.resolver.id || m.strategy !== st.strategy) {
      throw new Error(
        `sqlite-remote-sync: schema/resolver mismatch with site "${m.site}". ` +
          `Local epoch=${st.epoch} resolver=${st.resolver.id}; remote epoch=${m.epoch} resolver=${m.resolver}. ` +
          `Run migrate() on every device with the same schema and config.`,
      );
    }
    if (m.codec && m.codec !== st.codec.id) {
      throw new Error(`sqlite-remote-sync: codec mismatch with site "${m.site}" (${m.codec} vs ${st.codec.id})`);
    }
  };

  const readRemoteManifests = async (sites: Iterable<string>): Promise<Map<string, SiteManifest>> => {
    const out = new Map<string, SiteManifest>();
    await mapLimit([...sites], concurrency, async (site) => {
      const key = st.layout.manifestKey(site);
      const cached = st.manifestCache.get(key);
      try {
        const r = await readJson<SiteManifest>(backend, key, cached?.etag);
        if (r.notModified && cached) {
          checkManifest(cached.manifest);
          out.set(site, cached.manifest);
          return;
        }
        if (r.value) {
          checkManifest(r.value);
          out.set(site, r.value);
          st.manifestCache.set(key, { ...(r.etag ? { etag: r.etag } : {}), manifest: r.value });
        }
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    });
    return out;
  };

  /** Publish our applied version vector (used by gc() to know what is safe). */
  const ackApplied = async (): Promise<void> => {
    const cursors = await getAllCursors(db);
    await updateManifest(
      backend,
      st.layout.manifestKey(config.siteId),
      (cur) => ({
        v: cur?.v ?? 0,
        site: config.siteId,
        epoch: st.epoch,
        resolver: st.resolver.id,
        strategy: st.strategy,
        codec: st.codec.id,
        segments: cur?.segments ?? [],
        lastSeq: cur?.lastSeq ?? 0,
        applied: { ...(cur?.applied ?? {}), ...cursors },
      }),
      st.casSupported,
      retry,
    );
  };

  const doPush = async (): Promise<SyncStats> => {
    const t0 = nowMs();
    const stats = emptyStats();
    const built = await ingestLocal();
    if (!built.ops.length) {
      stats.durationMs = nowMs() - t0;
      return stats;
    }

    const segments = buildSegments(built.ops, built.blobs, segmentMaxBytes, segmentMaxOps);
    const uploads = await mapLimit(segments, concurrency, async (seg) => {
      const payload = await st.codec.encode(seg.payload);
      const key = st.layout.segmentKey(config.siteId, seg.from, seg.to, seg.hash);
      // Immutable + deterministic name: a retry PUTs byte-identical content.
      await backend.put(key, payload, { contentType: 'application/octet-stream' });
      return { seg, payload, key };
    });

    const descs: SegmentDesc[] = uploads.map(({ seg, payload, key }) => ({
      from: seg.from,
      to: seg.to,
      key,
      bytes: payload.byteLength,
      hash: seg.hash,
    }));
    stats.pushedOps = built.ops.length;
    stats.pushedSegments = descs.length;
    stats.pushedBytes = descs.reduce((n, d) => n + d.bytes, 0);

    const cursors = await getAllCursors(db);
    const pointer = await readJson<SnapshotPointer>(backend, st.layout.snapshotPointerKey);
    await updateManifest(
      backend,
      st.layout.manifestKey(config.siteId),
      (cur) => {
        const byKey = new Map((cur?.segments ?? []).map((d) => [d.key, d]));
        for (const d of descs) byKey.set(d.key, d);
        let list = [...byKey.values()].sort((a, b) => a.from - b.from);
        // Never drop a concurrent writer's descriptors on CAS re-base.
        if (pointer.value) {
          const covered = pointer.value.vv[config.siteId] ?? 0;
          list = list.filter((d) => d.to > covered);
        }
        return {
          v: cur?.v ?? 0,
          site: config.siteId,
          epoch: st.epoch,
          resolver: st.resolver.id,
          strategy: st.strategy,
          codec: st.codec.id,
          segments: list,
          lastSeq: Math.max(cur?.lastSeq ?? 0, ...descs.map((d) => d.to)),
          applied: { ...(cur?.applied ?? {}), ...cursors },
        };
      },
      st.casSupported,
      retry,
    );

    // Ack only after the manifest is durable. Crash-safe: the outbox survives
    // and a re-push reproduces the exact same segment bytes.
    await db.transaction(async (tx) => {
      await writeMeta(tx, 'last_pushed_seq', String(built.maxSeq));
    });

    if (config.autoCompact ?? DEFAULTS.autoCompact) {
      const own = await readJson<SiteManifest>(backend, st.layout.manifestKey(config.siteId));
      if (own.value && own.value.segments.length >= (config.compactAfterSegments ?? DEFAULTS.compactAfterSegments)) {
        try {
          await doCompact();
        } catch (e) {
          log?.warn?.('auto-compact failed', e);
        }
      }
    }

    stats.durationMs = nowMs() - t0;
    emit({ type: 'push', stats });
    return stats;
  };

  const doPull = async (): Promise<SyncStats> => {
    const t0 = nowMs();
    const stats = emptyStats();
    await ingestLocal();

    const heal = st.syncCount % healInterval === 0;
    const sites = new Set<string>([
      ...(await listManifestSites(backend, st.layout)),
      ...(heal ? await listSegmentSites(backend, st.layout) : []),
    ]);
    sites.delete(config.siteId); // our own segments are ingested from the outbox
    const manifests = await readRemoteManifests(sites);
    const cursors = await getAllCursors(db);

    // ---- snapshot bootstrap -------------------------------------------------
    let snapOps: SyncOp[] = [];
    let snapBlobs = new Map<string, Uint8Array>();
    let snapFold: { p: number; l: number }[] = [];
    const cursorUpdates: Record<string, number> = {};
    const metaUpdates: Record<string, string> = {};
    const pointerRead = await readJson<SnapshotPointer>(backend, st.layout.snapshotPointerKey, st.pointerEtag);
    if (pointerRead.value) {
      st.pointerEtag = pointerRead.etag;
      const pointer = pointerRead.value;
      if (
        pointer.epoch === st.epoch &&
        pointer.resolver === st.resolver.id &&
        (await readMeta(db, 'applied_snapshot')) !== pointer.key &&
        !vvAtLeast(cursors, pointer.vv)
      ) {
        try {
          const r = await backend.get(pointer.key);
          const snap = decodeSnapshot(await st.codec.decode(r.data));
          const converted = snapshotToOps(snap);
          snapOps = converted.ops;
          snapBlobs = converted.blobs;
          snapFold = converted.foldClock;
          Object.assign(cursorUpdates, converted.vv);
          metaUpdates['applied_snapshot'] = pointer.key;
          stats.snapshotsApplied = 1;
          stats.pulledBytes += r.data.byteLength;
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
        }
      }
    }

    // ---- select only segments beyond each site's cursor ---------------------
    const needed: Array<{ site: string; desc: SegmentDesc }> = [];
    for (const site of sites) {
      const cursor = Math.max(cursors[site] ?? 0, cursorUpdates[site] ?? 0);
      const byKey = new Map<string, SegmentDesc>();
      const m = manifests.get(site);
      if (m) for (const d of m.segments) if (d.to > cursor) byKey.set(d.key, d);
      // list()+union heals orphaned segments (client died after PUT but before
      // the manifest update) and manifest updates lost on backends without CAS.
      if (heal) {
        for (const d of await listSegmentFiles(backend, st.layout, site)) {
          if (d.to > cursor) byKey.set(d.key, d);
        }
      }
      for (const d of [...byKey.values()].sort((a, b) => a.from - b.from)) {
        needed.push({ site, desc: d });
      }
    }

    // ---- bounded-parallel download (all network I/O BEFORE the transaction) --
    // A 404 is tolerated: a concurrent compaction may have GC'd a segment that
    // is already covered by the snapshot. We stop at the first gap per site so
    // the cursor never skips missing data.
    type Fetch =
      | { ok: true; ops: SyncOp[]; blobs: Map<string, Uint8Array>; bytes: number }
      | { ok: false };
    const downloaded: Fetch[] = await mapLimit(needed, concurrency, async ({ desc }) => {
      try {
        const r = await backend.get(desc.key);
        const decoded = decodeSegment(await st.codec.decode(r.data));
        return { ok: true as const, ops: decoded.ops, blobs: decoded.blobs, bytes: r.data.byteLength };
      } catch (e) {
        if (e instanceof NotFoundError) {
          log?.warn?.(`segment ${desc.key} missing (likely compacted); healing`);
          return { ok: false as const };
        }
        throw e;
      }
    });

    const allOps: SyncOp[] = [...snapOps];
    const allBlobs = new Map(snapBlobs);
    const foldClock = [...snapFold];
    const bySite = new Map<string, number[]>();
    for (let i = 0; i < needed.length; i++) {
      const s = needed[i]!.site;
      let arr = bySite.get(s);
      if (!arr) bySite.set(s, (arr = []));
      arr.push(i);
    }
    for (const indices of bySite.values()) {
      for (const i of indices) {
        // `needed` is already sorted by `from` within each site.
        const d = downloaded[i]!;
        if (!d.ok) break;
        const { site, desc } = needed[i]!;
        allOps.push(...d.ops);
        for (const [h, b] of d.blobs) allBlobs.set(h, b);
        for (const op of d.ops) {
          for (const c of op.cells) foldClock.push({ p: c.p, l: c.l });
        }
        cursorUpdates[site] = Math.max(cursorUpdates[site] ?? 0, desc.to);
        stats.pulledSegments++;
        stats.pulledOps += d.ops.length;
        stats.pulledBytes += d.bytes;
      }
    }

    // ---- one atomic transaction: cells + rows + clock + cursors + meta -----
    const result = await db.transaction((tx) =>
      applyOps(tx, {
        ops: allOps,
        schemas: st.schemas,
        resolver: st.resolver,
        strategy: st.strategy,
        blobs: allBlobs,
        foldClock,
        clockSkewMs,
        cursorUpdates,
        metaUpdates,
        onConflict: (tbl, pk) => emit({ type: 'conflict', tbl, pk }),
      }),
    );
    stats.appliedOps = result.applied;
    stats.conflicts = result.conflicts;

    if (needed.length || Object.keys(cursorUpdates).length) {
      try {
        await ackApplied();
      } catch (e) {
        log?.warn?.('ack failed', e);
      }
    }

    st.syncCount++;
    stats.durationMs = nowMs() - t0;
    emit({ type: 'pull', stats });
    return stats;
  };

  const doCompact = async (): Promise<string | null> => {
    await ingestLocal();
    const cursors = await getAllCursors(db);
    const lastPushed = await readLastPushed();
    const vv: Record<string, number> = { ...cursors, [config.siteId]: Math.max(cursors[config.siteId] ?? 0, lastPushed) };
    const { payload, hash } = await buildSnapshot(db, {
      epoch: st.epoch,
      resolver: st.resolver.id,
      strategy: st.strategy,
      codec: st.codec.id,
      vv,
    });
    const key = st.layout.snapshotKey(hash);
    if (!(await backend.head(key))) {
      await backend.put(key, await st.codec.encode(payload), { contentType: 'application/octet-stream' });
    }
    const prev = (await readJson<SnapshotPointer>(backend, st.layout.snapshotPointerKey)).value;
    const pointer = await updateSnapshotPointer(
      backend,
      st.layout.snapshotPointerKey,
      { key, vv, epoch: st.epoch, resolver: st.resolver.id, strategy: st.strategy, createdBy: config.siteId },
      st.casSupported,
    );
    await rollupOwnSegments();
    // Bound snapshot objects: keep the current pointer and its immediate
    // predecessor (a peer may still be downloading the older one).
    const keep = new Set<string>([key, prev?.key].filter((x): x is string => !!x));
    for (const f of await backend.list(st.layout.snapshotsRoot)) {
      if (!keep.has(f.key)) {
        try {
          await backend.delete(f.key);
        } catch {
          /* best effort */
        }
      }
    }
    if (pointer) emit({ type: 'compact', key: pointer.key });
    return pointer?.key ?? null;
  };

  /** Merge our own many small segment files into one (per-site, no conflicts). */
  const rollupOwnSegments = async (): Promise<void> => {
    const key = st.layout.manifestKey(config.siteId);
    const read = await readJson<SiteManifest>(backend, key);
    const m = read.value;
    if (!m || m.segments.length <= 1) return;
    const parts = await mapLimit(m.segments, concurrency, async (d) => {
      const r = await backend.get(d.key);
      return decodeSegment(await st.codec.decode(r.data));
    });
    const ops = parts.flatMap((p) => p.ops);
    if (!ops.length) return;
    const blobs = new Map<string, Uint8Array>();
    for (const p of parts) for (const [h, b] of p.blobs) blobs.set(h, b);
    const merged = buildSegments(ops, blobs, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const seg = merged[0]!;
    const payload = await st.codec.encode(seg.payload);
    const from = Math.min(...m.segments.map((d) => d.from));
    const to = Math.max(...m.segments.map((d) => d.to));
    const newKey = st.layout.segmentKey(config.siteId, from, to, seg.hash);
    await backend.put(newKey, payload, { contentType: 'application/octet-stream' });
    await updateManifest(
      backend,
      key,
      (cur) => ({
        v: cur?.v ?? 0,
        site: config.siteId,
        epoch: st.epoch,
        resolver: st.resolver.id,
        strategy: st.strategy,
        codec: st.codec.id,
        segments: [{ from, to, key: newKey, bytes: payload.byteLength, hash: seg.hash }],
        lastSeq: Math.max(cur?.lastSeq ?? 0, to),
        applied: cur?.applied ?? {},
      }),
      st.casSupported,
      retry,
    );
    // The merged segment now contains every op from the old ones and is the
    // only descriptor in our manifest, so the superseded files are redundant.
    // Peers behind the snapshot bootstrap from it; a 404 during pull is tolerated.
    for (const d of m.segments) {
      if (d.key === newKey) continue;
      try {
        await backend.delete(d.key);
      } catch {
        /* best effort */
      }
    }
  };

  const doGc = async (): Promise<number> => {
    const pointer = (await readJson<SnapshotPointer>(backend, st.layout.snapshotPointerKey)).value;
    if (!pointer) return 0;
    // Snapshot coverage is the safe watermark: any replica behind `vv`
    // bootstraps from the snapshot (which advances its cursor to `vv`), so it
    // never needs the covered segments. Explicit peer acks can only lower it.
    let safe = pointer.vv[config.siteId] ?? 0;
    for (const site of await listManifestSites(backend, st.layout)) {
      if (site === config.siteId) continue; // our own cursor is not in `applied`
      const r = await readJson<SiteManifest>(backend, st.layout.manifestKey(site));
      const acked = r.value?.applied[config.siteId];
      if (acked !== undefined) safe = Math.min(safe, acked);
    }
    if (safe <= 0) return 0;

    let removed = 0;
    await updateManifest(
      backend,
      st.layout.manifestKey(config.siteId),
      (cur) => {
        const keep: SegmentDesc[] = [];
        for (const d of cur?.segments ?? []) if (d.to > safe) keep.push(d);
        return {
          v: cur?.v ?? 0,
          site: config.siteId,
          epoch: st.epoch,
          resolver: st.resolver.id,
          strategy: st.strategy,
          codec: st.codec.id,
          segments: keep,
          lastSeq: cur?.lastSeq ?? 0,
          applied: cur?.applied ?? {},
        };
      },
      st.casSupported,
      retry,
    );
    // Delete files only after the descriptor is gone, and only for our own
    // prefix. Each site owns and GCs its own segments.
    const current = (await readJson<SiteManifest>(backend, st.layout.manifestKey(config.siteId))).value;
    const referenced = new Set((current?.segments ?? []).map((d) => d.key));
    for (const d of await listSegmentFiles(backend, st.layout, config.siteId)) {
      if (d.to <= safe && !referenced.has(d.key)) {
        try {
          await backend.delete(d.key);
          removed++;
        } catch {
          /* best effort */
        }
      }
    }
    return removed;
  };

  const engine: SyncEngine = {
    async init(): Promise<void> {
      if (st.initialized) return;
      st.cap = await probeCapabilities(db);
      st.schemas = await discoverSchemas(db, config.tables);
      st.epoch = await db.transaction((tx) =>
        installSchema(tx, config, st.cap, st.schemas, st.resolver.id),
      );
      st.casSupported = await probeIfMatch(backend, `${st.layout.root}/.cas-probe`).catch(() => false);
      st.initialized = true;
    },

    async migrate(): Promise<void> {
      assertReady();
      return mutex(async () => {
        st.cap = await probeCapabilities(db);
        st.schemas = await discoverSchemas(db, config.tables);
        st.epoch = await db.transaction((tx) =>
          installSchema(tx, config, st.cap, st.schemas, st.resolver.id),
        );
        st.manifestCache.clear();
        st.pointerEtag = undefined;
      });
    },

    push(): Promise<SyncStats> {
      assertReady();
      return guard(async () => doPush());
    },
    pull(): Promise<SyncStats> {
      assertReady();
      return guard(async () => doPull());
    },
    async sync(): Promise<SyncStats> {
      assertReady();
      return guard(async () => {
        const a = await doPull();
        const b = await doPush();
        return {
          pushedOps: b.pushedOps,
          pushedSegments: b.pushedSegments,
          pushedBytes: b.pushedBytes,
          pulledSegments: a.pulledSegments,
          pulledOps: a.pulledOps,
          pulledBytes: a.pulledBytes,
          appliedOps: a.appliedOps,
          conflicts: a.conflicts,
          snapshotsApplied: a.snapshotsApplied,
          durationMs: a.durationMs + b.durationMs,
        };
      });
    },
    compact(): Promise<string | null> {
      assertReady();
      return guard(doCompact);
    },
    gc(): Promise<number> {
      assertReady();
      return guard(doGc);
    },
    write<T>(fn: () => Promise<T> | T): Promise<T> {
      return mutex(fn);
    },
    startAutoSync(intervalMs: number): void {
      assertReady();
      engine.stopAutoSync();
      st.timer = setInterval(() => {
        void engine.sync().catch((e) => {
          emit({ type: 'error', error: e });
          log?.error?.('auto-sync failed', e);
        });
      }, Math.max(50, intervalMs));
    },
    stopAutoSync(): void {
      if (st.timer) clearInterval(st.timer);
      st.timer = undefined;
    },
    isSyncing(): boolean {
      return st.syncing;
    },
    on(listener: SyncListener): () => void {
      st.listeners.add(listener);
      return () => st.listeners.delete(listener);
    },
    async close(): Promise<void> {
      if (st.closed) return; // idempotent
      engine.stopAutoSync();
      // Drain any in-flight op (and anything queued behind it) before marking
      // the engine closed, so close() never races a running push/pull.
      await mutex(() => {
        st.closed = true;
      });
      await db.close?.();
    },
    async trackChange(table: string, primaryKey: readonly SqlValue[]): Promise<void> {
      assertReady();
      return mutex(() =>
        captureRowChange(db, st.schemas, config.siteId, table, primaryKey),
      );
    },
  };

  /** Wrap a sync operation: serialize + set the reentrancy guard. The `closed`
   * flag is re-checked under the lock so a concurrent `close()` that waits for
   * the mutex can never be bypassed by an op that queued before it. */
  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    return mutex(async () => {
      assertReady();
      st.syncing = true;
      try {
        return await fn();
      } finally {
        st.syncing = false;
      }
    });
  }

  return engine;
}
