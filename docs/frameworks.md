# Frameworks

> [← Docs index](./README.md)

Every runtime uses the same three adapters. The library never touches SQLite
file bytes, so a worker, an in-memory wasm DB and a native driver are all wired
the same way.

```ts
interface SqliteAdapter {
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;
  transaction<T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
type SqlValue = null | string | number | bigint | Uint8Array;
interface SqlResult { rows: Row[]; changes: number; insertId?: bigint | number; }
```

`transaction()` **must** run `fn` on the same connection and roll back when `fn`
throws. When a driver has no callback transaction API, the fallback issues
`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` — this requires a single, non-shared
connection (the engine serialises access with its mutex, so that holds).

---

## Adapter cheat sheet

| Runtime | Adapter |
| --- | --- |
| `kysely-sqlite-tools` dialects (wasm, wa-sqlite OPFS, sqlite-worker, bun-worker, tauri, generic-sqlite) | `fromKysely(db)` / `fromExecutor(executor)` |
| Kysely built-in `SqliteDialect` | `fromKysely(db)` |
| Node / Electron main (`node:sqlite`, `better-sqlite3`, `bun:sqlite`, `sql.js`) | `fromRaw(client)` |
| React Native (`op-sqlite`, `react-native-quick-sqlite`) | `fromRaw(client)` |
| Capacitor (`@capacitor-community/sqlite`) | `fromRaw(client)` |
| Tauri (`@tauri-apps/plugin-sql`) | `fromRaw(client)` / `dialect-tauri` + `fromKysely` |
| Browser OPFS / Web Worker | `fromKysely` on a worker dialect, or `fromRaw` |

---

## `fromRaw` — any raw SQL client

```ts
import { fromRaw } from 'sqlite-remote-sync';

const db = fromRaw({
  run(sql, params = []) {
    const st = sqlite.prepare(sql);
    if (st.columns().length > 0) return { rows: st.all(...params), changes: 0 };
    const r = st.run(...params);
    return { rows: [], changes: Number(r.changes), insertId: r.lastInsertRowid };
  },
  // optional; omit to let the adapter issue BEGIN/COMMIT/ROLLBACK
  transaction: (fn) => sqlite.transaction(() => fn(db))(),
});
```

`run` must distinguish readers (return `rows`) from writers (return `changes`).
Any reliable way works: `StatementSync.columns()`, `better-sqlite3`'s
`st.reader`, or a regex on the SQL (see `fromExecutor`).

### Node (`node:sqlite`)

```ts
import { DatabaseSync } from 'node:sqlite';
import { fromRaw, createSyncEngine } from 'sqlite-remote-sync';

const sqlite = new DatabaseSync('app.db');
const db = fromRaw({
  run(sql, params: any[] = []) {
    const st = sqlite.prepare(sql);
    if (st.columns().length > 0) return { rows: st.all(...params) as any, changes: 0 };
    const r = st.run(...params);
    return { rows: [], changes: Number(r.changes), insertId: r.lastInsertRowid };
  },
});
```

### Electron main (`better-sqlite3`)

```ts
import Database from 'better-sqlite3';
import { fromRaw } from 'sqlite-remote-sync';

const sqlite = new Database('app.db');
const db = fromRaw({
  run: (sql, params: any[] = []) => {
    const st = sqlite.prepare(sql);
    if (st.reader) return { rows: st.all(...params) as any, changes: 0 };
    const r = st.run(...params);
    return { rows: [], changes: r.changes, insertId: r.lastInsertRowid };
  },
  transaction: (fn) => sqlite.transaction(() => fn(db))(),
});
```

### React Native (`op-sqlite`)

```ts
import { open } from '@op-engineering/op-sqlite';
import { fromRaw } from 'sqlite-remote-sync';

const sqlite = open({ name: 'app.db' });
const db = fromRaw({
  run: async (sql, params: any[] = []) => {
    const r = await sqlite.executeAsync(sql, params);
    return { rows: r.rows ?? [], changes: r.rowsAffected ?? 0, insertId: r.insertId };
  },
});
```

### Capacitor (`@capacitor-community/sqlite`)

```ts
import { SQLiteConnection, CapacitorSQLite } from '@capacitor-community/sqlite';
import { fromRaw } from 'sqlite-remote-sync';

const conn = new SQLiteConnection(CapacitorSQLite);
const sqlite = await conn.createConnection('app', false, 'no-encryption', 1, false);
await sqlite.open();
const db = fromRaw({
  run: async (sql, params: any[] = []) => {
    const isRead = /^\s*(select|pragma|with|values|explain)\b/i.test(sql);
    const r = await sqlite.query(sql, params); // or .run / .executeSet
    return { rows: isRead ? (r.values ?? []) : [], changes: r.changes?.changes ?? 0 };
  },
});
```

### Tauri (`@tauri-apps/plugin-sql`)

```ts
import Database from '@tauri-apps/plugin-sql';
import { fromRaw } from 'sqlite-remote-sync';

const sqlite = await Database.load('sqlite:app.db');
const db = fromRaw({
  run: async (sql, params: any[] = []) => {
    const isRead = /^\s*(select|pragma|with|values|explain)\b/i.test(sql);
    if (isRead) return { rows: await sqlite.select(sql, params), changes: 0 };
    const r = await sqlite.execute(sql, params);
    return { rows: [], changes: r.rowsAffected, insertId: r.lastInsertId };
  },
});
```

Or use `dialect-tauri` from kysely-sqlite-tools with `fromKysely`.

---

## `fromKysely` — all `kysely-sqlite-tools` dialects

All of these dialects can execute raw SQL, so one adapter covers them:
`dialect-wasm`, `dialect-wasqlite-worker`, `dialect-sqlite-worker`,
`dialect-bun-worker`, `dialect-tauri`, `kysely-generic-sqlite`
(`GenericSqliteDialect`), and Kysely's built-in `SqliteDialect`.

```ts
import { CompiledQuery, Kysely } from 'kysely';
import { GenericSqliteDialect } from 'kysely-generic-sqlite';
import {
  attachSyncPlugin, createSyncEngine, fromKysely, WebDavBackend,
} from 'sqlite-remote-sync';

const kysely = new Kysely<DB>({ dialect: new GenericSqliteDialect(createExecutor) });

const engine = createSyncEngine({
  db: fromKysely(kysely, {
    // Recommended when other Kysely plugins inspect the query AST:
    compiledQuery: (sql, p) => CompiledQuery.raw(sql, p),
  }),
  backend: /* ... */, appId: 'my-app', siteId: deviceId,
  tables: [{ name: 'todos', primaryKey: ['id'] }],
});
await engine.init();

// App-facing instance: every INSERT/UPDATE/DELETE triggers a debounced push.
const db = attachSyncPlugin(kysely, engine, { debounceMs: 200, mode: 'push' });
await db.insertInto('todos').values({ id: 't1', title: 'auto-synced' }).execute();
```

Without `compiledQuery`, a structural `CompiledQuery`-like object is used, which
is sufficient for every SQLite dialect. `fromKysely` deliberately types the
Kysely instance loosely so `kysely` stays an **optional peer**.

The plugin is also available from `sqlite-remote-sync/kysely`. See
[Getting started → Kysely plugin](./getting-started.md#4-kysely-plugin-write-triggered-sync).

---

## `fromExecutor` — worker dialects without a Kysely instance

For `kysely-generic-sqlite`'s `IGenericSqlite` executor (typical inside a Web /
Node worker):

```ts
import { fromExecutor, createSyncEngine } from 'sqlite-remote-sync';

const db = fromExecutor(createExecutor('app.db')); // { query(isSelect, sql, params) }
const engine = createSyncEngine({ db, /* ... */ });
```

`fromExecutor` classifies readers with a regex and issues `BEGIN IMMEDIATE` /
`COMMIT` / `ROLLBACK` for transactions.

### Browser OPFS / wa-sqlite worker

Use `dialect-wasqlite-worker` + `fromKysely` on the worker side, or
`fromExecutor` inside the worker with `createWebOnMessageCallback`. No file-byte
API is needed — snapshots are logical SQL, so OPFS VFS differences are
irrelevant.

---

## Capability probing & no-trigger runtimes

`init()` probes `unixepoch('subsec')`, `json_object`, `printf` and triggers, and
degrades gracefully:

- Old SQLite → `strftime('%s','now')*1000` (coarser but correct HLC).
- No `CompressionStream` → identity codec (larger objects, same behaviour).
- No triggers → call `engine.trackChange(table, pkValues)` after each write.
  It reads the current row (or records a tombstone) and appends one outbox
  entry with a fresh HLC timestamp.

---

## HTTP on mobile / desktop

`WebDavBackend` and `GenericHttpBackend` accept an injected `fetch`. On React
Native, Capacitor and Tauri, the global `fetch` may not support custom WebDAV
methods (`PROPFIND`, `MKCOL`) or binary bodies. Pass a native-HTTP-backed
implementation:

```ts
const backend = new WebDavBackend({
  url: 'https://dav.example.com/remote.php/dav/files/me/',
  username, password,
  fetch: async (input, init) => {
    // e.g. @tauri-apps/plugin-http, CapacitorHttp, RN fetch with custom method
    return nativeFetch(String(input), init);
  },
});
```

Requirements for the injected `fetch`:

- honours `init.method` including `PROPFIND` / `MKCOL` / `HEAD`,
- sends `Uint8Array` bodies unchanged and returns `arrayBuffer()` byte-exact,
- exposes response `headers` (`etag`, `content-length`, `content-range`) and
  `status` (404 / 412 / 304 must be distinguishable).

If custom methods are impossible, use `GenericHttpBackend` (plain GET/PUT/HEAD/
DELETE/list) with a small REST proxy instead — see [Backends](./backends.md).

---

## Checklist per platform

1. `run()` returns `{ rows, changes }` and correctly identifies readers.
2. `transaction()` rolls back on throw, on the same connection.
3. One engine per database; one writer connection.
4. `siteId` persisted and stable across launches.
5. `fetch` supports the required methods / binary bodies.
6. `await engine.init()` before any write or sync.
7. `await engine.migrate()` on every device after a schema change.
