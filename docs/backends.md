# Backends

> [← Docs index](./README.md)

A *backend* is a byte-oriented object store. The sync engine only ever calls
five methods, so any storage that can `GET`/`PUT`/`LIST`/`HEAD`/`DELETE` a key
can be used — WebDAV, a REST API, S3, a third-party drive, or a local folder.

```ts
interface RemoteBackend {
  get(key: string, opts?: RemoteGetOptions): Promise<RemoteGetResult>;
  put(key: string, data: Uint8Array, opts?: RemotePutOptions): Promise<RemotePutResult>;
  list(prefix: string): Promise<RemoteEntry[]>;
  head(key: string): Promise<RemoteHead | null>;
  delete(key: string): Promise<void>;
}
```

Keys are `/`-separated relative paths. `get` supports `If-None-Match` (`etag`)
and `Range`; `put` supports `If-Match` (`etag` → CAS) and `If-None-Match: *`
(`createOnly`). Results optionally carry an `etag` and `size`.

---

## ETag / CAS behaviour

`init()` calls `probeIfMatch()`: it attempts a `PUT` with a deliberately wrong
`If-Match` token.

- Server returns **412 / 409 / 404** → `CasConflictError` → **CAS available**.
  `updateManifest()` then re-reads and re-applies its mutation on a 412 (never
  blind-retries a stale body), and `readJson()` uses conditional `GET`s for 304s.
- Server **ignores** `If-Match` (creates the object) → **CAS unavailable**.
  The engine switches to a fully correct no-CAS path: each site writes *only its
  own* manifest (so there is no cross-device write contention), `list()`+union
  heals orphaned segments and lost manifest updates, and `healInterval` controls
  how often that reconciliation runs.

Both paths are covered by tests: `MemoryBackend`/`FsBackend` exercise CAS;
[`webdav-server`](https://www.npmjs.com/package/webdav-server) (no ETags, ignores
`If-Match`) exercises the fallback. **You do not need to configure this.**

> Tip: a backend with ETag support gives conditional 304 reads and is cheaper
> for many-device topologies. A backend without it still works, it just
> re-downloads manifests on every pull.

---

## `WebDavBackend`

```ts
import { WebDavBackend } from 'sqlite-remote-sync';

const backend = new WebDavBackend({
  url: 'https://dav.example.com/remote.php/dav/files/me/',
  username: 'user',                  // Basic auth
  password: 'app-password',
  // token: '...',                   // or Bearer (alternative to username/password)
  // headers: () => ({ 'X-Api-Key': getKey() }),
  // fetch: customFetch,             // RN / Capacitor / Tauri HTTP plugin
  // retry: { attempts: 4, baseDelayMs: 120 },
});
```

Implements `GET` / `PUT` / `DELETE` / `HEAD` / `MKCOL` / `PROPFIND` (Depth: 1,
traversed recursively), plus `If-Match`, `If-None-Match` and `Range`. Parent
collections are created once per session; concurrent `PUT`s share one in-flight
`MKCOL` per directory.

### Provider setup

| Provider | `url` | Auth |
| --- | --- | --- |
| Nextcloud | `https://host/remote.php/dav/files/<user>/` | username + **app password** |
| ownCloud | `https://host/remote.php/dav/files/<user>/` | username + app password |
| 坚果云 (Jianguoyun) | `https://dav.jianguoyun.com/dav/` | account + **应用密码** (not login password) |
| Synology NAS | `https://host:5006/<share>/` | username + password |
| rclone `serve webdav` | `http://host:8080/` | whatever rclone is configured with |
| Apache `mod_dav` / nginx `dav` | the collection URL | Basic |
| Box / 4shared / Yandex | provider-specific WebDAV URL | Basic |

Notes:

- Prefer an **app password / token** over the account password.
- Some providers cap `PROPFIND` Depth or omit `getetag`; the backend degrades
  gracefully (recursive Depth: 1, no-CAS fallback).
- `webdav-server` (used in tests) emits no ETags at all — a good simulation of
  a "dumb" WebDAV endpoint.
- On React Native / Capacitor / Tauri, pass a `fetch` implementation backed by
  a native HTTP client that supports custom methods (`PROPFIND`, `MKCOL`) and
  binary bodies. See [Frameworks](./frameworks.md).

---

## `GenericHttpBackend` (REST / ETag)

A tiny contract you can implement in ~60 lines (Cloudflare Worker, Node handler,
S3/R2/OSS proxy). A runnable reference server is in
[`examples/server.ts`](../examples/server.ts).

```ts
import { GenericHttpBackend } from 'sqlite-remote-sync';

const backend = new GenericHttpBackend({
  baseUrl: 'https://api.example.com/sync',
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
  // listQuery: 'list=1',   // default
  // fetch, retry
});
```

| Request | Contract |
| --- | --- |
| `GET <base>/<key>` | Bytes, `ETag`; honours `If-None-Match` (304) and `Range` |
| `PUT <base>/<key>` | Honours `If-Match` (412 on mismatch), returns `ETag` |
| `HEAD <base>/<key>` | `ETag` + `Content-Length` |
| `DELETE <base>/<key>` | Idempotent |
| `GET <base>/<prefix>?list=1` | JSON array (or `{ entries: [] }`) of `{ key, etag, size }` |

Because this contract supports ETags, it is the best choice if you want
conditional 304 reads backed by S3/R2 or your own API.

Run the reference server:

```sh
PORT=8787 ROOT=/tmp/sync pnpm tsx examples/server.ts
```

---

<a id="files-sdk-third-party"></a>

## `files-sdk` / third-party drives

[`files-sdk`](https://www.npmjs.com/package/files-sdk) is a unified SDK for
object/blob backends with one API (`upload`, `download`, `head`, `list`,
`exists`, `delete`). `FilesSdkBackend` adapts it **structurally** — the library
does not import or depend on `files-sdk`, so it stays zero-runtime-dependency
and works with any `files-sdk` version.

```sh
pnpm add files-sdk
# install ONLY the provider you use (each is an optional peer):
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner   # S3 / R2 / MinIO / B2
# or: pnpm add @google-cloud/storage                         # GCS
# or: pnpm add @azure/storage-blob                          # Azure Blob
# or: pnpm add @vercel/blob                                 # Vercel Blob
# or: pnpm add dropbox                                      # Dropbox
```

```ts
import { Files } from 'files-sdk';
import { s3 } from 'files-sdk/s3';        // files-sdk/r2, /gcs, /azure, /vercel-blob,
                                          // /dropbox, /onedrive, /gdrive, /box, /fs, /memory …
import { FilesSdkBackend, createSyncEngine } from 'sqlite-remote-sync';

const backend = new FilesSdkBackend({
  files: new Files({ adapter: s3({ bucket: 'my-sync' }) }),
});
// backend works with createSyncEngine({ backend, ... }) or as one entry of `backends`.
```

Supported adapter families (see the files-sdk docs for exact install commands):

| Family | Providers |
| --- | --- |
| `s3` / `r2` / `s3-fetch` | AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, Backblaze B2, Wasabi, … |
| `gcs`, `azure` | Google Cloud Storage, Azure Blob Storage |
| `vercel-blob` | Vercel Blob |
| `dropbox`, `onedrive`, `gdrive`, `box` | Consumer / business drives |
| `webdav` | Another WebDAV endpoint |
| `fs`, `memory` | Local filesystem, in-memory (tests) |

Behaviour and trade-offs:

- **Structurally typed**: `Files` is assignable to `FilesSdkLike` with no cast
  (verified against `files-sdk@3.x` type declarations).
- **Byte-range downloads** are forwarded to adapters that support them — the
  main bandwidth win for large segments.
- **`list()` walks every page** via `cursor` (with a `maxListPages` guard).
- **No CAS / 304, deliberately.** `files-sdk` uses *bare* strong ETags (unlike
  HTTP's quoted tags) and conditional create/replace is `Unsupported` on several
  adapters. A single `If-Match` token therefore cannot work across providers.
  `probeIfMatch()` reports "unavailable" and the engine uses its no-CAS path —
  still fully correct. Range reads and `FilesError` → `NotFoundError` /
  `CasConflictError` / `RemoteError` mapping still work.
- Requires Node ≥ 22 (files-sdk's own requirement); fine on Bun/Deno/Workers.

> Want conditional reads on S3? Use `GenericHttpBackend` with a thin REST/ETag
> proxy instead.

---

## `MirrorBackend` (multi-cloud)

See **[Multi-cloud sync](./multi-cloud.md)** for the full guide. In short:

```ts
const backend = new MirrorBackend([
  new WebDavBackend({ url: jianguo }),
  new WebDavBackend({ url: nextcloud }),
  new FilesSdkBackend({ files: new Files({ adapter: s3({ bucket }) }) }),
], { writeQuorum: 'all' });
```

Broadcasts writes to all clouds, falls back on reads, unions `list()`. It is
also implicitly created when you pass `backends: [...]` to `createSyncEngine`.

---

## `FsBackend` / `MemoryBackend`

```ts
import { FsBackend } from 'sqlite-remote-sync/backends/fs';
const local = new FsBackend('/mnt/sync');   // Node / Electron main only

import { MemoryBackend } from 'sqlite-remote-sync';
const mem = new MemoryBackend();           // tests / in-process multi-window
```

- `FsBackend` maps keys to files and computes ETags as content fingerprints, so
  CAS works across processes. Import from the dedicated subpath — it pulls in
  `node:fs`.
- `MemoryBackend` is a reference implementation of the full contract
  (ETag, `If-Match`, `If-None-Match`, `Range`, `list`) and is handy for unit
  tests.

---

## Writing your own backend

Implement the five methods. Return `NotFoundError` on a missing key and
`CasConflictError` on a failed `If-Match`; everything else can be a
`RemoteError` (a 4xx status is not retried, a 5xx is).

```ts
import {
  createSyncEngine, NotFoundError, CasConflictError,
  type RemoteBackend, type RemoteEntry, type RemoteGetOptions,
  type RemoteGetResult, type RemoteHead, type RemotePutOptions,
  type RemotePutResult,
} from 'sqlite-remote-sync';

class MyDriveBackend implements RemoteBackend {
  async get(key: string, opts: RemoteGetOptions = {}): Promise<RemoteGetResult> {
    const obj = await myDrive.read(key);
    if (!obj) throw new NotFoundError(key);
    if (opts.etag && obj.etag === opts.etag) {
      return { data: new Uint8Array(), etag: obj.etag, notModified: true };
    }
    return { data: obj.bytes, etag: obj.etag };
  }
  async put(key: string, data: Uint8Array, opts: RemotePutOptions = {}): Promise<RemotePutResult> {
    if (opts.etag && !(await myDrive.etagMatches(key, opts.etag))) throw new CasConflictError(key);
    if (opts.createOnly && (await myDrive.exists(key))) throw new CasConflictError(key);
    const etag = await myDrive.write(key, data);
    return { etag };
  }
  async list(prefix: string): Promise<RemoteEntry[]> {
    return (await myDrive.walk(prefix)).map((o) => ({ key: o.key, etag: o.etag, size: o.size }));
  }
  async head(key: string): Promise<RemoteHead | null> {
    const o = await myDrive.stat(key);
    return o ? { etag: o.etag, size: o.size } : null;
  }
  async delete(key: string): Promise<void> {
    await myDrive.remove(key); // idempotent: a missing key is fine
  }
}
```

Checklist:

- `list()` must return **all** keys under the prefix (used for site discovery,
  orphan healing and gc), each with a `/`-separated key.
- Immutable segment objects must be byte-exact on `GET`; never transform them.
- `put()` must be safe to call concurrently and safe to retry with identical
  bytes (segment names are deterministic and content-addressed).
- Keys can contain spaces, unicode and `%` — preserve them exactly (see the
  special-character siteId test in the suite).

---

<a id="choosing-a-backend"></a>

## Choosing a backend

| Situation | Recommendation |
| --- | --- |
| A WebDAV 网盘 (Nextcloud / 坚果云 / 群晖) | `WebDavBackend` |
| Your own API / S3 / R2 proxy | `GenericHttpBackend` (ETag contract) |
| Dropbox / OneDrive / GDrive / Box / Azure / GCS … | `FilesSdkBackend` + `files-sdk` |
| Sync to several providers at once | `MirrorBackend` / `backends: [...]` — see [multi-cloud](./multi-cloud.md) |
| Desktop local folder / offline backup | `FsBackend` (also as one mirror target) |
| Unit tests | `MemoryBackend` |
| Maximum conditional-read efficiency | Any ETag-capable single backend (avoid mirrors/`files-sdk` no-CAS paths) |
| Server with no ETag / ignores `If-Match` | Any — no-CAS fallback is automatic |

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `MKCOL 405/409` | Usually harmless (collection already exists); `ensureCollection` ignores it. A persistent 409 on nested paths means the server does not auto-create parents. |
| `PROPFIND` returns nothing | Depth: infinity is often disabled — the backend uses recursive Depth: 1. Verify the server returns `href` + `resourcetype`. |
| 404 on a segment during pull | Expected after a concurrent `compact()`/`gc()`; pull tolerates it and bootstraps from the snapshot. |
| Manifests never 304 | The server has no ETag support; expected, just more bandwidth. |
| `files-sdk` `Unsupported` errors | Conditional primitives vary by adapter; `FilesSdkBackend` never uses them, so this should not surface. |
