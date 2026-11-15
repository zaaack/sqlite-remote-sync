import { CompiledQuery, Kysely } from 'kysely';
import { SqlJsDialect } from 'kysely-wasm';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { fromKysely } from 'sqlite-remote-sync';
import type { SqliteAdapter } from 'sqlite-remote-sync';
import type { DB } from './types';
import { getTabId } from './tab';

type SqlJsDb = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

const IDB_NAME = 'srs-todo-notes';
const IDB_STORE = 'kv';
const LEGACY_DB_KEY = 'sqlite';
// Each tab owns its own SQLite file, exactly like two separate devices. A
// single shared key would make the tabs overwrite each other's local state.
const DB_KEY = `sqlite:${getTabId()}`;

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

let raw: SqlJsDb | null = null;
let adapter: SqliteAdapter | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let fresh = false;

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

function idbGet(key: string): Promise<Uint8Array | undefined> {
  return openIDB().then(
    (idb) =>
      new Promise((resolve, reject) => {
        const r = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        r.onsuccess = () => resolve(r.result as Uint8Array | undefined);
        r.onerror = () => reject(r.error);
      }),
  );
}

function idbPut(key: string, value: Uint8Array): Promise<void> {
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

/**
 * Boot the local database: load sql.js (WASM), restore the SQLite file from
 * IndexedDB, expose a Kysely instance backed by kysely-wasm's SqlJsDialect,
 * and build the sync-engine adapter from that same Kysely instance.
 */
export async function initDB(): Promise<Boot> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });

  let bytes: Uint8Array | undefined;
  try {
    bytes = await idbGet(DB_KEY);
    // One-time upgrade from the old single shared key.
    if (!bytes || !bytes.length) bytes = await idbGet(LEGACY_DB_KEY);
  } catch (e) {
    console.warn('IndexedDB unavailable, running in memory only', e);
  }
  fresh = !(bytes && bytes.length);
  if (!fresh && bytes) {
    // Adopt the legacy file under this tab's key so each tab diverges cleanly.
    try { await idbPut(DB_KEY, bytes); } catch { /* non-fatal */ }
  }

  raw = (fresh ? new SQL.Database() : new SQL.Database(bytes)) as SqlJsDb;
  raw.run(DDL);

  const db = new Kysely<DB>({
    dialect: new SqlJsDialect({ database: raw }),
  });

  adapter = fromKysely(db, {
    compiledQuery: (sql, params) => CompiledQuery.raw(sql, params),
  });

  return { db, adapter, fresh };
}

/** True when this is the very first launch (no persisted file existed). */
export function isFresh(): boolean {
  return fresh;
}

export function getAdapter(): SqliteAdapter {
  if (!adapter) throw new Error('Database not initialized');
  return adapter;
}

/** Raw sql.js handle, used to export the real `.sqlite` file. */
export function getRaw(): SqlJsDb {
  if (!raw) throw new Error('Database not initialized');
  return raw;
}

/** Persist the whole SQLite file to IndexedDB (offline-first local copy). */
export async function persistNow(): Promise<void> {
  if (!raw) return;
  try {
    await idbPut(DB_KEY, raw.export());
  } catch (e) {
    console.warn('Local persistence failed (private mode?)', e);
  }
}

/** Debounced persist for high-frequency UI actions. Stable identity for the provider. */
export function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistNow();
  }, 200);
}

/** Wipe the local SQLite file (settings "reset" action). */
export async function clearLocalDB(): Promise<void> {
  try {
    const idb = await openIDB();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('clearLocalDB:', e);
  }
}
