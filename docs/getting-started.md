# Getting started

> [← Docs index](./README.md)

This guide covers the day-to-day usage details: engine lifecycle, safe writes,
automatic syncing, the Kysely plugin, observability, error handling, chunk
tuning and schema migration. For protocol internals see [Architecture](./architecture.md).

---

## 1. Lifecycle

```ts
const engine = createSyncEngine(config);
await engine.init();        // MUST be called once, before anything else
// ... use the engine ...
await engine.close();       // stops auto-sync; does NOT drop your data
```

`init()`:

1. Probes SQLite capabilities (`unixepoch('subsec')`, `json_object`, `printf`, triggers).
2. Discovers columns via `PRAGMA table_info` for each configured table.
3. Creates the internal `_sync_*` tables and installs `AFTER INSERT/UPDATE/DELETE` triggers — all inside one transaction.
4. Probes the backend for `If-Match` support (`probeIfMatch`) to decide whether CAS is available.
5. Computes the **schema epoch** = fingerprint of (tables, columns, PKs, strategy, resolver id).

It is idempotent: calling it twice is a no-op. `close()` stops timers and marks the engine closed; your SQLite connection is yours to manage (pass `close()` in the adapter if you want `engine.close()` to close it).

**One engine per database.** Two engines sharing one SQLite file would both own the outbox and `last_pushed_seq` and would corrupt each other. If you need two remote targets, use [multi-cloud sync](./multi-cloud.md), not two engines.

---

## 2. Writing data safely

All writes to synced tables must be observable by the triggers. Anything that runs raw SQL through the adapter works:

```ts
await db.run('INSERT INTO todos (id, title) VALUES (?, ?)', ['t1', 'buy milk']);
await db.run('UPDATE todos SET done = ? WHERE id = ?', [1, 't1']);
await db.run('DELETE FROM todos WHERE id = ?', ['t1']);
```

Use `engine.write()` when several application tasks may write concurrently. It runs your function under the engine's async mutex, so a `push()`/`pull()`/`compact()` cannot interleave with your writes:

```ts
await engine.write(async () => {
  await db.run('UPDATE todos SET title = ? WHERE id = ?', ['new', 't1']);
  await db.run('INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'memo']);
});
```

The mutex also serialises all sync operations. `engine.isSyncing()` reports whether one is in flight (used by the Kysely plugin to avoid feedback loops).

### Things that bypass capture

- `PRAGMA writable_schema`, direct file writes, `ATTACH` + writes to another DB file.
- Bulk loaders that disable triggers.
- Runtimes without trigger support — call `engine.trackChange(table, pkValues)` **after** each write instead. `trackChange` reads the current row (or records a tombstone if it is gone) and appends one outbox entry.
- `INSERT OR REPLACE` fires delete + insert triggers, which is handled (emitted as delete+put). A primary-key change is emitted as delete(old) + put(new); still, **never mutate a PK value** as a normal workflow — use a stable id.

---

## 3. Syncing

```ts
await engine.pull();   // download + apply remote changes
await engine.push();   // upload local changes
await engine.sync();   // pull() then push()  <-- recommended
```

`sync()` = `pull()` then `push()`. Pulling first means freshly-downloaded writes are folded into the local LWW state before your local outbox is pushed, so conflicts are resolved consistently.

Each returns a `SyncStats`:

```ts
interface SyncStats {
  pushedOps: number; pushedSegments: number; pushedBytes: number;
  pulledSegments: number; pulledOps: number; pulledBytes: number;
  appliedOps: number; conflicts: number; snapshotsApplied: number;
  durationMs: number;
}
```

`conflicts` counts incoming cells that lost the LWW join. `snapshotsApplied > 0` means this device bootstrapped from a logical snapshot instead of replaying segments.

### Automatic syncing

```ts
engine.startAutoSync(30_000);   // every 30s, errors emitted as 'error' events
engine.stopAutoSync();
```

Auto-sync is a `setInterval` calling `sync()`; the mutex prevents overlap. For a Kysely app, the [plugin](#4-kysely-plugin-write-triggered-sync) is usually better (it reacts to writes instead of polling).

---

## 4. Kysely plugin (write-triggered sync)

```ts
import { attachSyncPlugin, createSyncPlugin } from 'sqlite-remote-sync';
// or: import { createSyncPlugin } from 'sqlite-remote-sync/kysely';

const plugin = createSyncPlugin(engine, {
  mode: 'push',        // 'push' (default, cheapest) | 'sync' (full bidirectional)
  debounceMs: 200,     // coalesce bursts
  onError: console.error,
});
const db = kysely.withPlugin(plugin);
// or simply:
const db = attachSyncPlugin(kysely, engine, { mode: 'push', debounceMs: 200 });

await db.insertInto('todos').values({ id: 't1', title: 'auto' }).execute();
// no explicit engine.sync() needed
await plugin.flush();   // force an immediate sync (e.g. before app backgrounding)
```

- Write queries are detected in `transformQuery` (`InsertQueryNode` / `UpdateQueryNode` / `DeleteQueryNode`, plus raw `INSERT/UPDATE/DELETE/REPLACE`).
- The debounced sync is scheduled in `transformResult`, i.e. **after** the statement succeeded.
- `engine.isSyncing()` guards reentrancy so the engine's own replay writes do not loop.
- `shouldTrigger(node)` lets you override write detection (e.g. ignore a scratch table).
- `mode: 'push'` only uploads — use it when another path (auto-sync / manual `pull()`) handles downloads. `mode: 'sync'` is fully bidirectional but costs a pull per write burst.

---

## 5. Events & logging

```ts
const off = engine.on((e) => {
  switch (e.type) {
    case 'push':    console.log('pushed', e.stats.pushedOps); break;
    case 'pull':    console.log('pulled', e.stats.pulledOps); break;
    case 'conflict': console.log('LWW conflict on', e.tbl, e.pk); break;
    case 'compact': console.log('snapshot', e.key); break;
    case 'error':   console.error(e.error); break;
  }
});
off(); // unsubscribe
```

Pass a `logger` (`debug`/`info`/`warn`/`error`) for internal diagnostics. `retry` controls backoff for transient network failures:

```ts
const engine = createSyncEngine({
  ...,
  retry: { attempts: 4, baseDelayMs: 120, maxDelayMs: 4000 },
  logger: console,
});
```

`withRetry` does **not** retry `CasConflictError` (412) — that is a signal for the manifest layer to re-base — nor deterministic 4xx errors.

Always wrap sync calls in your own error handling for UI purposes:

```ts
try {
  await engine.sync();
} catch (e) {
  // network down / backend rejected / schema mismatch — data stays in the outbox
  // and will be retried on the next sync; never clear anything here.
}
```

---

<a id="controlling-chunk-size"></a>

## 6. Controlling chunk size

The number of remote files is driven by **push cycles and device count**, not by row count. A single `sync()` coalesces every changed row into one segment unless you split it.

| Option | Default | Meaning |
| --- | --- | --- |
| `segmentMaxOps` | 2000 | Max **coalesced row-ops** per segment. Use this for a predictable file count. |
| `segmentMaxBytes` | 512 KiB | Max **uncompressed JSON** bytes per segment (gzip is applied afterwards). |
| `concurrency` | 4 | Parallel segment downloads. |
| `compactAfterSegments` | 24 | Auto-compact threshold. |
| `autoCompact` | `true` | Roll up segments during `sync()` when the threshold is hit. |

An "op" is one row after coalescing per `(table, pk)` — editing the same row 100 times between pushes still produces **one** op.

**500 rows → 10 segments (11 objects with the manifest)**, verified over a real WebDAV server:

```ts
const engine = createSyncEngine({
  db, backend, appId: 'my-app', siteId: deviceId, tables,
  segmentMaxOps: 50,            // 500 / 50 = 10 chunks
  concurrency: 4,               // 4 parallel downloads
  compactAfterSegments: 200,    // keep the 10 chunks from being rolled up
  // or: autoCompact: false, and call compact()/gc() on your own schedule
});
```

| Config (500 rows / 5 tables, one `sync()`) | Segments | Objects | Per chunk (gzip) |
| --- | --- | --- | --- |
| default (`maxOps=2000`) | 1 | 2 | ~10.8 KB |
| `segmentMaxOps: 100` | 5 | 6 | ~2.2 KB |
| **`segmentMaxOps: 50`** | **10** | **11** | **~1.2 KB** |
| `segmentMaxOps: 20` | 25 → auto-compacted to 1 | 4 | — |
| `segmentMaxBytes: 1500`, `autoCompact: false` | 84 | 85 | ~0.3 KB |

Two gotchas:

1. **`autoCompact` will undo fine-grained chunking.** With the default threshold of 24 accumulated segments, `sync()` rolls them into 1 segment + a snapshot. Raise `compactAfterSegments` or set `autoCompact: false` if you want to keep ~10 chunks.
2. **`segmentMaxBytes` counts uncompressed JSON** — compressed objects are far smaller, so it is a poor way to control file *count*. Use `segmentMaxOps` for that. Every push appends new chunks, so periodic `compact()` / `gc()` is still needed for long-running apps.

If 500 rows are written across **10 separate sync cycles**, the default config naturally yields 10 segments + 1 manifest = 11 objects, with no tuning at all.

---

## 7. Schema changes & migration

DDL is managed by your app (Kysely migrations, etc.). After changing a synced table:

```ts
await runMyMigrations();       // ALTER TABLE / ADD COLUMN / CREATE TABLE ...
await engine.migrate();        // on EVERY device
```

`migrate()` re-probes capabilities, re-discovers columns, rebuilds triggers and advances the schema epoch. Manifests carry the epoch; a device whose epoch differs **refuses to sync** and tells you to run `migrate()`. Deploy the schema change to all devices before letting them write.

Changing `strategy`, `resolver` or the codec also changes the epoch / manifest checks. Treat those as a coordinated migration too, and never mix them across devices.

---

## 8. Maintenance: compact + gc

```ts
await engine.compact();   // logical snapshot + roll up own segments
await engine.gc();        // delete segments every known site has acknowledged
```

- `compact()` writes an immutable snapshot of the full cell state, advances the shared `snapshot.json` pointer, merges this site's segments into one, and keeps at most 2 snapshot objects. New devices bootstrap from `snapshot + tail`.
- `gc()` deletes own segments already covered by the snapshot (and acknowledged by peers). A device lagging behind the snapshot bootstraps from it, so deleting covered segments is safe; `pull()` tolerates a 404 on a compacted segment.

A reasonable production schedule: let auto-compact handle the steady state, and call `compact()` + `gc()` during a quiet window (e.g. app background / nightly job). See [Architecture](./architecture.md#compaction-and-gc).

---

## 9. Identity & namespaces

| Field | Rule |
| --- | --- |
| `siteId` | Stable, globally unique per device. **Never reuse** it after a device reset / database wipe — otherwise its outbox sequence numbers restart and can collide with already-published segments. |
| `appId` | Remote namespace. Several independent databases can share one backend by using different `appId`s; they will never see each other's objects. |
| `tables[].primaryKey` | Stable columns. Auto-detected from `PRAGMA table_info` if omitted; pass it explicitly for composite keys or `WITHOUT ROWID` edge cases. |

Persist `siteId` in a place that survives app reinstall only if you also keep the local database — otherwise generate a fresh one.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `call await engine.init() first` | Forgot `init()`. |
| `schema/resolver mismatch with site "..."` | Run `migrate()` on every device with identical `tables`, `strategy`, `resolver`, codec. |
| Nothing syncs | Check `siteId` is unique, `appId` matches, and the backend is reachable; inspect `logger`. |
| Too many objects | See [chunk size](#controlling-chunk-size); call `compact()` + `gc()`; check that `autoCompact` is not thrashing. |
| Conflicts always resolve the same way | That is LWW by design; use `strategy: 'field'` or a [custom resolver](./conflict-resolution.md). |
| Remote writes duplicated locally | Should not happen — the replay guard suppresses them. Verify triggers were installed (`migrate()`). |
| A device is stuck behind | Pull tolerates missing segments and bootstraps from the snapshot; check `snapshot.json` exists and manifests are readable. |
