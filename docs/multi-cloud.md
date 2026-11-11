# Multi-cloud sync / 多网盘同步

> [← Docs index](./README.md)

"Multi-cloud" can mean two different things. This library supports both:

| Pattern | What you want | How |
| --- | --- | --- |
| **A. Mirror one database to N clouds** | The *same* data on several drives for redundancy / failover; any device can sync through any cloud | `MirrorBackend` or `backends: [...]` |
| **B. Independent databases per cloud** | Different, unrelated datasets on different providers | Several engines with different `appId`s (no mirror needed) |

This page is mostly about **A**. Pattern **B** is at the end.

---

## Pattern A: `MirrorBackend`

`MirrorBackend` composes any number of `RemoteBackend`s and implements the same
interface, so the sync engine needs no special handling.

```ts
import {
  createSyncEngine, MirrorBackend, WebDavBackend, FsBackend,
} from 'sqlite-remote-sync';

const backend = new MirrorBackend([
  new WebDavBackend({ url: 'https://dav.jianguoyun.com/dav/', username, password }),
  new WebDavBackend({ url: 'https://cloud.example.com/remote.php/dav/files/me/', token }),
  new FsBackend('/mnt/offline-backup'),
], {
  writeQuorum: 'all',                 // default
  onBackendError: (e) => console.warn(`cloud #${e.index} failed on ${e.op}`, e.error),
});

const engine = createSyncEngine({ db, backend, appId: 'my-app', siteId, tables });
```

| Operation | Behaviour |
| --- | --- |
| `put` / `delete` | **Broadcast to every backend**, concurrently. Succeeds when `writeQuorum` backends accept it. |
| `get` | Try backends **in order**; on a 404 or a transient error, fall through to the next. First success wins. |
| `list` | **Union** of all backends' listings (`allSettled`), deduplicated by key. An offline replica does not break discovery. |
| `head` | First backend that has the object. |

Because the union of listings is used for site discovery and orphan healing, a
segment that landed on only one cloud is still found and pulled.

---

## Config shortcut: `backends`

You do not have to construct `MirrorBackend` yourself:

```ts
const engine = createSyncEngine({
  db,
  backends: [cloud1, cloud2, cloud3],   // <-- instead of `backend`
  mirror: { writeQuorum: 'all' },       // MirrorOptions
  appId: 'my-app', siteId, tables,
});
```

Resolution rules (`src/core/engine.ts`):

1. If `backends` is a non-empty array, it **takes precedence** over `backend`.
2. A single-element array is used directly (no wrapper, zero overhead).
3. Two or more are wrapped in `new MirrorBackend(targets, config.mirror)`.
4. Neither supplied → `createSyncEngine` throws immediately with a clear message.

`SyncConfig.backend` is therefore optional. Existing `backend:` configs are
unchanged.

---

## Consistency model

### `writeQuorum: 'all'` (default, recommended)

Every write must land on **every** cloud. If one cloud is down, the whole sync
fails loudly instead of silently diverging.

Why this is the safe default:

- A partial write (cloud A has the new manifest, cloud B still has the old one)
  could later be read back from B and overwrite A's newer value. Requiring all
  writes to succeed makes that state impossible to *accept*.
- When a failed cloud comes back, the **next successful write heals it**: the
  manifest is re-read from a healthy cloud and broadcast to every backend, so B
  receives the current value. Immutable segments are content-addressed and are
  re-uploaded deterministically on retry.
- `list()` union + the engine's `healInterval` reconciliation cover any stale
  immutable objects left behind.

The trade-off: a single cloud outage blocks syncing (consistency over
availability). Your app should surface the error; local writes stay in the
outbox and are retried on the next sync.

### Lowering the quorum

```ts
const backend = new MirrorBackend([cloud1, cloud2, cloud3], {
  writeQuorum: 2,
  onBackendError: ({ index, op, error }) => metrics.count('cloud_error', { index, op }),
});
```

`writeQuorum: 1` means "any one cloud accepted it". This favours availability:
the sync continues while a cloud is offline, and `onBackendError` tells you which
replica missed the write. Converge later with a full sync once it is back.

Use it when you accept **eventual consistency** and want the app to keep
working offline-against-one-cloud. Do not use it if you require every cloud to
be an immediately usable standalone backup.

---

## Why mirrors disable CAS / 304

ETags are **local to one server**. A single `If-Match` token obtained from
Nextcloud can never be valid on 坚果云 or S3. Therefore `MirrorBackend`:

- drops `etag` / `createOnly` on writes and never returns ETags on reads;
- makes `probeIfMatch()` report *CAS unavailable*;
- forces the engine onto its **no-CAS path** — the same path fully tested
  against `webdav-server` (per-site manifests, read-modify-write with re-base,
  `list()`+union discovery).

That path is correct because **each manifest key is owned by exactly one site**
(`manifest/<siteId>.json`), so no two devices ever write the same manifest.
Even a stale read from a lagging replica cannot lose another writer's update.

Consequences:

- No conditional 304 reads → manifests are re-downloaded on every pull.
- The shared `snapshot.json` pointer can lose a concurrent compaction update
  (no data loss; the next `compact()` restores it and orphan snapshots are
  cleaned up).
- If you need 304s, use a **single** ETag-capable backend instead of a mirror.

`FilesSdkBackend` is also no-CAS for the same reason (see [Backends](./backends.md#files-sdk-third-party)).

---

## Heterogeneous clouds are fine

Backends do not have to be the same type. A tested combination is
`WebDavBackend` (real HTTP) + `FsBackend` (local disk), plus a third-party
drive via `FilesSdkBackend`:

```ts
import { Files } from 'files-sdk';
import { s3 } from 'files-sdk/s3';
import { FilesSdkBackend } from 'sqlite-remote-sync';

const engine = createSyncEngine({
  db,
  backends: [
    new WebDavBackend({ url: jianguo }),
    new FilesSdkBackend({ files: new Files({ adapter: s3({ bucket: 'backup' }) }) }),
    new FsBackend('/mnt/local'),
  ],
  appId: 'my-app', siteId, tables,
});
```

Keys are identical across clouds, so **every cloud is a complete, independent
replica**. The test suite proves this by syncing through the mirror and then
creating a brand-new device pointed at *only the second cloud* — it pulls the
full dataset without ever touching the first.

---

## Failover patterns

### Read from one cloud directly

A device can be configured with just one of the mirror's backends and still see
all data (because every write was broadcast):

```ts
const offlineDevice = createSyncEngine({ db, backend: cloud2, appId: 'my-app', siteId, tables });
await offlineDevice.init();
await offlineDevice.pull();   // full dataset from cloud2 alone
```

This is useful for a "read-only replica", a per-region device, or disaster
recovery. Note its own writes will go **only** to `cloud2` unless you add the
mirror back.

### One cloud permanently dies

1. Remove it from `backends` (or keep it with a lower `writeQuorum`).
2. Run a full `sync()` so the remaining clouds receive the latest manifests.
3. Optionally `compact()` + `gc()` to shrink the object count.

No data is lost as long as at least one cloud has the complete history.

### Adding a cloud later

Add it to `backends` and run `compact()` then `sync()`. New immutable segments
and the current manifest are broadcast; the new cloud also gets the snapshot so
fresh devices can bootstrap from it. For a large history, `compact()` first is
much cheaper than replaying every segment.

---

## Cost model

For `N` clouds:

| | Cost |
| --- | --- |
| Segment uploads | `N ×` per push (parallel) |
| Manifest / snapshot writes | `N ×` |
| `list()` | `N ×` PROPFIND/list calls (parallel, union) |
| Reads | Usually 1 backend; `N` only on fallback |
| Storage | `N ×` total bytes |

The engine still coalesces writes into one segment per push cycle and
auto-compacts, so you get `O(devices)` objects **per cloud**, not `O(writes)`.
See [Getting started → chunk size](./getting-started.md#controlling-chunk-size).

---

## Pattern B: independent databases per cloud

When the datasets are unrelated, do **not** mirror. Create one engine per
database with its own `appId` (and optionally its own `siteId` namespace):

```ts
const personal = createSyncEngine({
  db: personalDb, backend: jianguo, appId: 'personal', siteId: `${deviceId}-p`, tables,
});
const work = createSyncEngine({
  db: workDb, backend: nextcloud, appId: 'work', siteId: `${deviceId}-w`, tables,
});
```

Different `appId`s are completely isolated in the remote layout. Use a distinct
`siteId` per engine as well, since outbox sequence numbers are per-site.

---

## FAQ

**Can two clouds have different credentials / base paths?** Yes — each
`WebDavBackend` has its own `url`, auth and `fetch`. Keys are relative to each
base, so two different folders on the same server behave as two independent
clouds.

**Do I need a leader / coordinator?** No. Per-site manifests and immutable,
deterministically-named segments mean devices never contend on the same key.
The mirror only multiplies writes; it adds no coordination.

**What if two devices write at the same time on a mirror?** Normal LWW-Map
conflict handling applies — see [Conflict resolution](./conflict-resolution.md).
The suite includes a 4-device concurrent `sync()` test.

**Does `gc()` delete from every cloud?** Yes — `MirrorBackend.delete` broadcasts,
and gc only deletes this site's own segments after the snapshot covers them.

**Can I mix a mirror with `files-sdk`?** Yes, see the heterogeneous example
above. `FilesSdkBackend` is just another `RemoteBackend`.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Sync fails whenever one cloud is down | Expected with `writeQuorum: 'all'`. Lower the quorum, or fix/remove the failing cloud. |
| `onBackendError` firing but sync succeeds | A replica missed a write while the quorum was met. Run a full sync after it recovers. |
| A cloud is missing some objects | Add it back to `backends`, `compact()`, then `sync()`; or lower the quorum and re-sync. |
| Device pointed at one cloud is behind | That cloud missed writes; use the mirror for that device, or re-broadcast. |
| More requests than expected | `N ×` writes and `N ×` list calls are inherent; keep `healInterval` high and use ETag-capable backends where possible. |
