# sqlite-remote-sync

> **[English (default)](./README.md)** · [中文](./README.zh-CN.md)

Bidirectional, conflict-free **SQLite** synchronisation over **WebDAV / any HTTP object store**, written in TypeScript with **zero runtime dependencies**.

One code path for every JS SQLite runtime — `kysely-sqlite-tools`, browser/OPFS, React Native, Capacitor, Electron, Tauri, Node. The core uses **only raw SQL + a byte store**: no SQLite file-byte APIs, no `EXPORT`/`IMPORT`, no native modules. Snapshots are logical SQL dumps, so wasm/RN work identically to Node.

**Highlights**

- Bidirectional, offline-first sync with deterministic **LWW-Map** conflict resolution (row-level or per-column field merge, tombstones, HLC).
- **Multi-cloud sync**: mirror one database to several drives/providers at once, or plug in third-party drives via [`files-sdk`](./docs/backends.md#files-sdk-third-party).
- Delta-only, gzip-compressed, chunked segments — 500 rows produce as few as **2 remote objects**; chunk count and size are configurable.
- Logical snapshots + compaction + gc so WebDAV holds `O(devices)` objects, not `O(writes)`.
- Optional **Kysely plugin** that triggers a sync right after a write completes.
- **`sqlite-remote-sync/react`** — direct Kysely CRUD in React with **auto-refreshing queries** (`useQuery` re-runs after local writes and remote pulls). See [React plugin](./docs/react.md).

**Live demo** — a [Todo / Notes app](https://zaaack.github.io/sqlite-remote-sync/) with categories, tags, reminders, WebDAV sync, import/export and a **Chinese / English switch**, running entirely in the browser on GitHub Pages. Built with **TypeScript 7 + Vite 8 + React 19 + kysely-wasm** (SQLite WASM) and the React plugin above. By default it runs in **demo mode**: a Service Worker implements a virtual WebDAV server in the browser (IndexedDB-backed), so **opening two tabs shows real bidirectional sync with zero setup** — no backend, no CORS, no COOP/COEP headers. See [demo/README.md](./demo/README.md).

---

## Install

```sh
pnpm add sqlite-remote-sync
# Kysely users: kysely is an optional peer (>=0.29)
```

---

## Quick start (Node)

```ts
import { DatabaseSync } from 'node:sqlite';
import { createSyncEngine, fromRaw, WebDavBackend } from 'sqlite-remote-sync';

const sqlite = new DatabaseSync('app.db');
const db = fromRaw({
  run(sql, params = []) {
    const st = sqlite.prepare(sql);
    if (st.columns().length > 0) return { rows: st.all(...params), changes: 0 };
    const r = st.run(...params);
    return { rows: [], changes: Number(r.changes), insertId: r.lastInsertRowid };
  },
});

const engine = createSyncEngine({
  db,
  backend: new WebDavBackend({
    url: 'https://dav.example.com/remote.php/dav/files/me/',
    username: 'user',
    password: 'app-password',       // or token: '...' for Bearer
  }),
  appId: 'my-app',                  // remote namespace
  siteId: await loadOrCreateDeviceId(), // stable, unique per device
  tables: [
    { name: 'todos', primaryKey: ['id'] },
    { name: 'notes', primaryKey: ['id'] },
  ],
});
await engine.init();

await db.run('INSERT INTO todos (id, title) VALUES (?, ?)', ['t1', 'buy milk']);
await engine.sync();                // pull() then push()
engine.startAutoSync(30_000);       // optional periodic sync
```

`siteId` must be stable and unique per device. All devices must use the same `appId`, table config, `strategy` and `resolver`.

---

## React: Kysely CRUD with automatic refresh

`sqlite-remote-sync/react` turns a Kysely-backed SQLite database into a live
data source. Write with the Kysely query builder as usual; every `useQuery`
result re-runs automatically after a local write **and** after the engine
applies a remote pull.

```tsx
import { SyncProvider, useKysely, useQuery, useSync } from 'sqlite-remote-sync/react';

<SyncProvider db={kysely} engine={engine}>
  <Items />
</SyncProvider>

function Items() {
  const db = useKysely<DB>();                       // live Kysely for CRUD
  const { data } = useQuery<DB['items'][], DB>((d) =>
    d.selectFrom('items').selectAll().execute());  // re-runs on any change
  const sync = useSync();

  return <>{/* add/upd/del with db.insertInto(...).execute() — no manual refresh */}</>;
}
```

`createLiveKysely()` is also exported as a framework-agnostic core. Full API,
options and caveats: **[React plugin docs](./docs/react.md)**. React is an
optional peer (`>=18`); `kysely` remains optional too.

---

## Sync to multiple cloud drives

Pass `backends` instead of `backend`. Every write is broadcast to all clouds; reads fall back across them. See **[Multi-cloud sync](./docs/multi-cloud.md)**.

```ts
import {
  createSyncEngine, fromRaw, WebDavBackend, FsBackend,
} from 'sqlite-remote-sync';

const engine = createSyncEngine({
  db,
  backends: [
    new WebDavBackend({ url: 'https://dav.jianguoyun.com/dav/', username, password }),
    new WebDavBackend({ url: 'https://cloud.example.com/remote.php/dav/files/me/', token }),
    new FsBackend('/mnt/backup/sync'),        // local/offline copy
  ],
  mirror: { writeQuorum: 'all' },             // default: fail loudly if a cloud is down
  appId: 'my-app', siteId: deviceId, tables,
});
```

Third-party drives (S3/R2/GCS/Azure/Dropbox/OneDrive/Google Drive/Box/...) via `files-sdk`:

```ts
import { Files } from 'files-sdk';
import { s3 } from 'files-sdk/s3';
import { FilesSdkBackend } from 'sqlite-remote-sync';

const backend = new FilesSdkBackend({
  files: new Files({ adapter: s3({ bucket: 'my-sync' }) }),
});
```

---

## How it works

1. `init()` installs `AFTER INSERT/UPDATE/DELETE` triggers that append local writes to an **outbox** with a **Hybrid Logical Clock** timestamp.
2. `push()` coalesces the outbox into immutable, compressed **segments** under the device's own prefix.
3. `pull()` downloads only segments beyond its **per-site cursor** and applies them in **one transaction**.
4. Conflicts are resolved by an **LWW-Map semilattice join** — commutative, associative, idempotent — so replicas converge regardless of delivery order.

Full details: **[Architecture](./docs/architecture.md)**.

### Conflict handling (short version)

- `strategy: 'row'` (default): LWW-Register, winner is `max(p, l, siteId)`. Deterministic even with identical clocks.
- `strategy: 'field'`: per-column LWW; concurrent edits to different columns are both preserved.
- Deletes are tombstones, so a stale update cannot resurrect a deleted row.
- `resolver` accepts a custom `ConflictResolver` — **it must be a semilattice join**. Bad resolvers cause divergence.

Full details + worked custom resolvers: **[Conflict resolution](./docs/conflict-resolution.md)**.

### Chunking — avoiding too many small files

**One local write ≠ one remote file.** Writes coalesce per `(table, pk)`; `segmentMaxOps` / `segmentMaxBytes` split large change sets into bounded chunks downloaded in parallel; `compact()` rolls many segments into one snapshot and `gc()` reclaims them.

For `500 rows ≈ 10 files`:

```ts
const engine = createSyncEngine({
  db, backend, appId: 'my-app', siteId: deviceId, tables,
  segmentMaxOps: 50,            // 500 / 50 = 10 chunks
  concurrency: 4,
  compactAfterSegments: 200,    // don't let auto-compact roll them back into 1
});
```

Full details: **[Getting started → chunking](./docs/getting-started.md#controlling-chunk-size)**.

---

## Backends

All implement `RemoteBackend { get, put, list, head, delete }`.

| Backend | Import | Notes |
| --- | --- | --- |
| `WebDavBackend` | main / `./backends` | Basic/Bearer, MKCOL, PROPFIND, `If-Match`, `Range`, retries. Nextcloud/ownCloud/坚果云/Synology/rclone/Apache/nginx. |
| `GenericHttpBackend` | main / `./backends` | Tiny REST+ETag contract; runnable reference server in [`examples/server.ts`](./examples/server.ts). |
| `FilesSdkBackend` | main / `./backends/files-sdk` | Third-party drives via [`files-sdk`](https://www.npmjs.com/package/files-sdk): S3/R2/GCS/Azure/Vercel Blob/Dropbox/OneDrive/GDrive/Box/WebDAV/fs. Structural — no dependency on `files-sdk`. |
| `MirrorBackend` | main / `./backends/mirror` | Multi-cloud mirror: broadcast writes, fallback reads, union listing. |
| `MemoryBackend` | main / `./backends` | Tests / in-process multi-window. |
| `FsBackend` | `sqlite-remote-sync/backends/fs` | Node / Electron local folder (content-fingerprint ETags). |

Full comparison, provider setup and how to write your own backend: **[Backends](./docs/backends.md)**.

---

## API

```ts
const engine = createSyncEngine(config);
await engine.init();                  // install tables/triggers, probe backend
await engine.migrate();               // rebuild triggers after ALTER TABLE
await engine.push();                  // upload local changes
await engine.pull();                  // download + apply remote changes
await engine.sync();                  // pull() then push()  <-- recommended
await engine.compact();               // snapshot + roll up segments
await engine.gc();                    // delete acknowledged segments
await engine.write(fn);               // run fn under the engine write lock
await engine.trackChange(table, pk);  // explicit capture (no-trigger runtimes)
engine.startAutoSync(30_000);
engine.stopAutoSync();
const off = engine.on(evt => { /* push | pull | conflict | error | compact */ });
engine.isSyncing();
await engine.close();
```

`sync()` / `push()` / `pull()` return `SyncStats` (pushed/pulled ops, segments, bytes, conflicts, duration).

### Config (all optional except `db`, `appId`, `siteId`, `tables` and one of `backend`/`backends`)

| Option | Default | Meaning |
| --- | --- | --- |
| `db`, `appId`, `siteId`, `tables` | — | required |
| `backend` / `backends` | — | one backend, or an array mirrored via `MirrorBackend` |
| `mirror` | — | `MirrorOptions` (`writeQuorum`, `onBackendError`) |
| `strategy` | `'row'` | `'row'` LWW-Register or `'field'` per-column merge |
| `resolver` | built-in | custom semilattice join |
| `compress` | `true` | gzip via `CompressionStream`, else identity / custom `Codec` |
| `segmentMaxBytes` | 512 KiB | split large pushes (uncompressed JSON bytes) |
| `segmentMaxOps` | 2000 | split large pushes (coalesced row-ops) |
| `blobThreshold` | `0` (off) | dedupe large BLOB cells per segment |
| `concurrency` | 4 | parallel segment downloads |
| `compactAfterSegments` | 24 | auto-compact threshold |
| `autoCompact` | `true` | compact during `sync()` when threshold hit |
| `healInterval` | 10 | every N syncs, reconcile via `list()` |
| `clockSkewMs` | 0 | tolerated physical clock skew |
| `retry`, `logger`, `fetch` | — | backoff, logging, injected fetch |

---

## Remote layout

```
<appId>/
  manifest/<site>.json                     # per-site: epoch, resolver, segments, applied vector
  segments/<site>/<from>-<to>-<hash>.seg  # immutable, gzip JSON, append-only
  snapshots/<hash>.snap                   # immutable logical snapshot
  snapshot.json                           # shared, monotonically advancing pointer
```

---

## Verified against a real WebDAV server

`test/webdav-e2e.test.ts` runs the whole library against an in-process [`webdav-server`](https://www.npmjs.com/package/webdav-server) over real HTTP. That server emits **no ETags** and **ignores `If-Match`**, so the suite also exercises the no-CAS fallback end to end. Performance numbers (single run, Node 24 — order of magnitude, not a benchmark claim):

| scenario | requests | objects | notes |
| --- | --- | --- | --- |
| 500 rows / 5 tables, one `sync()` | 10 | 2 | 500 ops → 1 gzip segment (~11 KB) + 1 manifest |
| fresh device full pull | 9 | — | 500 rows in 1 segment |
| 1 new row, incremental `sync()` | 6 | — | `pushedOps=1`, 175 B |
| no-op `sync()` | 2 | — | 0 push / 0 pull |
| `segmentMaxOps: 50` | 19 | 11 | exactly 10 chunks, parallel pull |
| 5 devices × 100 rows converge | 198 | 10 | 5 manifests + 5 segments |

Two inefficiencies found by these measurements were fixed: a redundant `HEAD` after every WebDAV PUT, and duplicate `MKCOL`s under concurrent PUTs (the 10-chunk push went 35 → 19 requests). `webdav-server` has no 304, so every manifest is re-downloaded on every pull — use an ETag-capable backend for conditional reads.

---

## Documentation

| Doc | Contents |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Lifecycle, `write()` lock, auto-sync, Kysely plugin, events/stats, error handling, chunking, migration |
| [Backends](./docs/backends.md) | WebDAV provider setup, REST contract, `files-sdk` third-party drives, custom backend, ETag/CAS behaviour |
| [Multi-cloud sync](./docs/multi-cloud.md) | `MirrorBackend`, `backends` config, consistency/quorum, failover, independent DB per cloud |
| [Conflict resolution](./docs/conflict-resolution.md) | LWW-Map semantics, `strategy`, custom resolvers, worked examples, pitfalls |
| [Architecture](./docs/architecture.md) | Wire format, HLC, oplog, segments, manifests, snapshots, compaction, gc, correctness details |
| [Frameworks](./docs/frameworks.md) | Detailed wiring for kysely-sqlite-tools, RN, Capacitor, Electron, Tauri, OPFS/worker |
| [React plugin](./docs/react.md) | `sqlite-remote-sync/react`, `SyncProvider` / `useQuery` / `useKysely`, live queries & auto-refresh |
| [Examples](./examples/) | Runnable REST/ETag reference backend |

---

## Requirements & limitations

- SQLite ≥ 3.42 gets millisecond HLC precision; older builds fall back to `strftime('%s','now')*1000`. `init()` probes capabilities and degrades gracefully.
- Tables need a **stable primary key**. DDL changes are managed by your app; call `migrate()` afterwards on each device.
- One sync engine per database. Prefer a single writer connection; use `engine.write()` for concurrent app writes.
- All devices must use the same `tables`, `strategy`, `resolver` and codec (enforced by `schemaEpoch` + manifest checks).
- Wall-clock skew affects *which* LWW write wins, not convergence. Use `'field'` or a custom resolver for stronger semantics.
- Trigger-less environments: call `engine.trackChange(table, pkValues)` after each write.
- `MirrorBackend` / `FilesSdkBackend` deliberately run **without CAS/304** (their no-CAS path is still fully correct); use a single ETag-capable backend if you need conditional reads.

---

## Development

This project uses **pnpm** (`packageManager` is pinned; `pnpm-lock.yaml` is the only lockfile).

```sh
pnpm install
pnpm run typecheck
pnpm test              # all suites: real webdav-server E2E + perf + multi-cloud + files-sdk + kysely
pnpm run test:e2e      # just the real-WebDAV E2E / performance suite
pnpm run build         # ESM + .d.ts into dist/
pnpm run qa            # typecheck + test + build
pnpm tsx examples/server.ts   # reference REST/ETag backend
```

Full suite: **66 tests** (codec, HLC, triggers, replay guard, LWW convergence, tombstones, field merge, idempotency, chunking, snapshots, CAS re-base, real WebDAV bidirectional/conflicts/compaction/concurrency/performance, multi-cloud mirror, `files-sdk` adapter, Kysely plugin).

## License

[MIT](./LICENSE) — see [LICENSE](./LICENSE).
