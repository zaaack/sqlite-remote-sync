# React plugin — live Kysely queries

`sqlite-remote-sync/react` connects a Kysely-backed SQLite database to React.
You keep writing normal Kysely CRUD, and every `useQuery` result re-runs
automatically when data changes — locally (after `insertInto` / `updateTable` /
`deleteFrom`) or remotely (after the sync engine applies a pull).

React is an **optional peer** (`>=18`); the core package has no React dependency.

```sh
pnpm add react sqlite-remote-sync kysely
```

## Quick start

```tsx
import { Kysely } from 'kysely';
import { SqlJsDialect } from 'kysely-wasm';
import { createSyncEngine, WebDavBackend, fromKysely } from 'sqlite-remote-sync';
import {
  SyncProvider, useKysely, useQuery, useSync,
} from 'sqlite-remote-sync/react';

interface DB { items: { id: string; title: string; done: number } }

// 1. Create a Kysely instance (any kysely-sqlite-tools dialect works).
const db = new Kysely<DB>({ dialect: new SqlJsDialect({ database: sqlJsDb }) });

// 2. Create the engine from the SAME Kysely instance.
const engine = createSyncEngine({
  db: fromKysely(db),
  backend: new WebDavBackend({ url: 'https://dav.example.com/notes/' }),
  appId: 'notes', siteId: getSiteId(),
  tables: [{ name: 'items', primaryKey: ['id'] }],
  strategy: 'field',
});
await engine.init();

// 3. Wrap the tree.
function Root() {
  return (
    <SyncProvider db={db} engine={engine}>
      <TodoList />
    </SyncProvider>
  );
}

// 4. Read reactively, write directly with Kysely. No manual refresh anywhere.
function TodoList() {
  const db = useKysely<DB>();
  const { data: items, isLoading } = useQuery<DB['items'][], DB>((d) =>
    d.selectFrom('items').selectAll().execute(),
  );
  const sync = useSync();

  if (isLoading) return <p>Loading…</p>;
  return (
    <>
      <button onClick={() => sync.sync()}>Sync</button>
      <ul>{items?.map((it) => <li key={it.id}>{it.title}</li>)}</ul>
      <button onClick={() =>
        db.insertInto('items').values({ id: crypto.randomUUID(), title: 'New', done: 0 }).execute()
      }>Add</button>
    </>
  );
}
```

`useKysely()` returns the live instance (the one with the observer plugin
attached). Always use it for writes — otherwise the UI will not refresh.

## How auto-refresh works

`SyncProvider` builds a `LiveKysely` client via `createLiveKysely()`:

1. It calls `db.withPlugin(...)` to attach a Kysely plugin. `transformQuery`
   marks `InsertQueryNode` / `UpdateQueryNode` / `DeleteQueryNode` queries, and
   `transformResult` fires a coalesced invalidation **after** the statement
   succeeds. Engine-internal writes go through `db.executeQuery()` with a
   `RawNode` and are deliberately excluded, so replay/ingest never causes a
   feedback loop.
2. It subscribes to the engine's `pull` events and invalidates when
   `stats.appliedOps > 0` (remote changes landed locally).
3. Every `useQuery` subscribes to that client and re-runs its query on each
   invalidation, with a sequence guard so a slow result can never overwrite a
   newer one.

Notifications are coalesced with `setTimeout(0)`, so a transaction or a batch
import produces one re-render, not one per row.

## API

### `createLiveKysely<DB>(db, options?)` — framework-agnostic core

Useful without React (or for tests). Returns `LiveKysely<DB>`:

| Member | Description |
| --- | --- |
| `db` | Kysely instance with the observer plugin attached |
| `engine` | the engine passed in, if any |
| `subscribe(fn)` | subscribe to invalidations; returns an unsubscribe function |
| `notify()` | invalidate manually (raw `sql` writes, external changes) |
| `flush()` | flush coalesced notifications, then flush pending sync |
| `dispose()` | detach engine listeners, drop subscribers |

Options:

| Option | Default | Description |
| --- | --- | --- |
| `engine` | – | enables remote-change invalidation |
| `syncAfterWrite` | `true` when `engine` is given | also attaches `createSyncPlugin` so writes push automatically |
| `syncPlugin` | – | forwarded to `createSyncPlugin` (e.g. `{ debounceMs, mode }`) |
| `onChange` | – | extra callback fired on every invalidation |

> **Offline backlog:** if the engine uses a throwaway `MemoryBackend` while
> offline, set `syncAfterWrite: false`. Otherwise writes are pushed into that
> backend and the outbox is drained before a real backend is configured. The
> [demo](../demo/) does exactly this with `syncAfterWrite={isConfigured()}`.

### `SyncProvider<DB>`

```tsx
<SyncProvider db={kysely} engine={engine} syncAfterWrite onChange={fn}>
  {children}
</SyncProvider>
```

The client is (re)created when `db` or `engine` identity changes, so replacing
the engine on a settings change works. The engine listener is attached lazily
on first subscriber and detached when the last one leaves — this makes it safe
under React StrictMode's double effect invocation. Options other than
`db`/`engine` are read when the client is created.

### `useQuery<T, DB>(queryFn, deps?)`

```ts
const { data, error, isLoading, refresh } = useQuery<Item[], DB>(
  (db) => db.selectFrom('items').selectAll().execute(),
  [filter], // optional; must have a stable length, like useEffect deps
);
```

Runs on mount, when `deps` change, and on every invalidation. Previous `data`
is kept during a refresh (no flicker); `isLoading` is only true for the first
load. `refresh()` re-runs manually.

### Other hooks

| Hook | Returns |
| --- | --- |
| `useKysely<DB>()` | the live `Kysely<DB>` for CRUD |
| `useLiveKysely<DB>()` | the whole `LiveKysely` client (`notify`, `subscribe`, `dispose`, …) |
| `useSyncEngine()` | the engine passed to the provider, if any |
| `useSyncEvent()` | the most recent `SyncEvent` (for a status indicator) |
| `useSync()` | `{ engine, isSyncing, error, sync, push, pull, compact, refresh }` |

`useSync().sync()/push()/pull()` wrap the engine calls with a local
`isSyncing`/`error` state and invalidate queries afterwards.

## Caveats

- Only **Kysely query-builder** writes are detected automatically. If you write
  with `sql\`...\`.execute(db)` or change the database out of band, call
  `useLiveKysely().notify()` (or `refresh()`).
- The plugin must be given a Kysely instance created from the **same** SQLite
  database the engine's `fromKysely()` adapter uses. `db.withPlugin()` returns
  a new view sharing the same driver, so this is safe.
- `useQuery` re-runs **all** active queries on any change (no table-level
  invalidation). For a small local SQLite app this is cheap; wrap expensive
  queries in `deps`-keyed memoisation if needed.
- The engine's SQLite triggers still capture every write, so local changes made
  through the live instance are synced normally.
