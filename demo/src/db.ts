import { CompiledQuery, Kysely } from 'kysely';
import { WaSqliteWorkerDialect } from 'kysely-wasqlite-worker';
import wasmAssetUrl from '@subframe7536/sqlite-wasm/dist/wa-sqlite-async.wasm?url';
import { fromKysely } from 'sqlite-remote-sync';
import type { SqliteAdapter } from 'sqlite-remote-sync';
import type { DB } from './types';
import { getTabId } from './tab';

// The demo's own IndexedDB only holds the "already seeded" marker; the actual
// SQLite pages live in the VFS's own database (<fileName>.db).
const IDB_NAME = 'srs-todo-notes';
const IDB_STORE = 'kv';
const SEEDED_KEY = `seeded:${getTabId()}`;

// Each tab owns its own SQLite file, exactly like two separate devices.
// useIdbStorage() opens `<fileName>.db` in IndexedDB and keys its Web Locks
// by that name, so the two tabs never contend for the same lock.
const FILE_NAME = `todo-${getTabId()}.sqlite`;
const VFS_IDB_NAME = `${FILE_NAME}.db`;

// `base: './'` makes Vite emit a document-relative URL, but the worker's
// locateFile() would resolve it against the worker chunk. Resolve it here.
const WASM_URL = new URL(wasmAssetUrl, document.baseURI).href;

const DDL = `
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  category   TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',
  due_at     TEXT NOT NULL DEFAULT '',
  remind_min INTEGER NOT NULL DEFAULT -1,
  notified   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

// The runtime connection is a GenericSqliteWorkerConnection, which has a
// request() method that Kysely's DatabaseConnection type does not declare.
interface WorkerConnection {
  request<T = unknown>(type: string, payload?: unknown): Promise<T>;
}

let adapter: SqliteAdapter | null = null;
let connection: WorkerConnection | null = null;
let markReady!: () => void;
const connectionReady = new Promise<void>((resolve) => { markReady = resolve; });

export interface Boot {
  db: Kysely<DB>;
  adapter: SqliteAdapter;
  fresh: boolean;
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  return openIDB().then(
    (idb) =>
      new Promise((resolve, reject) => {
        const r = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve(r.result as T | undefined);
        r.onerror = () => reject(r.error);
      }),
  );
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openIDB().then(
    (idb) =>
      new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbDelete(key: string): Promise<void> {
  return openIDB().then(
    (idb) =>
      new Promise((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

/**
 * Boot the local database: wa-sqlite in a Web Worker with an IndexedDB VFS
 * (IDBBatchAtomicVFS, no OPFS), exposed through kysely-wasqlite-worker, then
 * build the sync-engine adapter from that same Kysely instance.
 */
export async function initDB(): Promise<Boot> {
  const fresh = (await idbGet<number>(SEEDED_KEY)) === undefined;

  const dialect = new WaSqliteWorkerDialect({
    fileName: FILE_NAME,
    // IndexedDB VFS, not OPFS. No COOP/COEP headers needed (GitHub Pages).
    preferOPFS: false,
    // preferOPFS:false makes the dialect call url(true) => async wasm build.
    url: () => WASM_URL,
    worker: () => new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' }),
    onCreateConnection: (conn) => {
      connection = conn as unknown as WorkerConnection;
      markReady();
    },
  });

  const db = new Kysely<DB>({ dialect });
  // Also forces the worker's async driver.init() (and onCreateConnection) to
  // finish before the instance is handed to the sync engine.
  await db.executeQuery(CompiledQuery.raw(DDL));

  adapter = fromKysely(db, {
    compiledQuery: (sql, params) => CompiledQuery.raw(sql, params),
  });

  return { db, adapter, fresh };
}

/** Record that the sample rows have been seeded (VFS persists data itself). */
export async function markSeeded(): Promise<void> {
  await idbPut(SEEDED_KEY, 1);
}

export function getAdapter(): SqliteAdapter {
  if (!adapter) throw new Error('Database not initialized');
  return adapter;
}

/** Ask the worker to serialize the whole SQLite file (custom 'export' request). */
export async function exportSQLiteBytes(): Promise<Uint8Array> {
  await connectionReady;
  if (!connection) throw new Error('Database not initialized');
  return connection.request<Uint8Array>('export');
}

/** Wipe this tab's VFS database and its seeded marker. */
export async function clearLocalDB(): Promise<void> {
  try {
    await connectionReady;
    await connection?.request('reset');
  } catch (e) {
    console.warn('clearLocalDB: worker reset failed', e);
    // Fallback: delete the VFS database from the main thread. The reload
    // right after this call terminates the worker connection anyway.
    try {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(VFS_IDB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve();
      });
    } catch (e2) {
      console.warn('clearLocalDB: deleteDatabase', e2);
    }
  }
  try {
    await idbDelete(SEEDED_KEY);
    // Old sql.js whole-file snapshots are incompatible with the VFS pages.
    await idbDelete('sqlite');
    await idbDelete(`sqlite:${getTabId()}`);
  } catch (e) {
    console.warn('clearLocalDB:', e);
  }
}
