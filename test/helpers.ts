import { DatabaseSync } from 'node:sqlite';
import { fromRaw, probeCapabilities } from '../src/core/adapter.js';
import { createSyncEngine } from '../src/core/engine.js';
import { discoverSchemas, installSchema, type TableSchema } from '../src/core/schema.js';
import type {
  Capabilities,
  RemoteBackend,
  SqliteAdapter,
  SqlResult,
  SqlValue,
  SyncConfig,
  SyncEngine,
} from '../src/core/types.js';

export interface TestDb {
  adapter: SqliteAdapter;
  raw: DatabaseSync;
  close(): void;
}

/** A `SqliteAdapter` backed by Node's built-in `node:sqlite`. */
export function makeDb(file = ':memory:'): TestDb {
  const raw = new DatabaseSync(file);
  const adapter = fromRaw({
    run(sql: string, params: readonly SqlValue[] = []): SqlResult {
      const st = raw.prepare(sql);
      if (st.columns().length > 0) {
        return { rows: st.all(...(params as any[])) as Record<string, unknown>[], changes: 0 };
      }
      const r = st.run(...(params as any[]));
      return { rows: [], changes: Number(r.changes), insertId: r.lastInsertRowid };
    },
  });
  return { adapter, raw, close: () => raw.close() };
}

export function execSql(db: TestDb, sql: string, params: readonly SqlValue[] = []): void {
  db.adapter.run(sql, params);
}

export function allRows(db: TestDb, sql: string): Record<string, unknown>[] {
  return db.raw.prepare(sql).all() as Record<string, unknown>[];
}

export function makeConfig(
  adapter: SqliteAdapter,
  overrides: Partial<SyncConfig> = {},
): SyncConfig {
  return {
    db: adapter,
    backend: {} as SyncConfig['backend'],
    appId: 'test-app',
    siteId: 'site-A',
    tables: [{ name: 'todos', primaryKey: ['id'] }],
    ...overrides,
  };
}

/** Standard test schema, present in every device. */
export const SCHEMA_SQL = `
  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    title TEXT,
    done INTEGER DEFAULT 0,
    score REAL,
    payload BLOB
  );
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    body TEXT,
    rev INTEGER
  );
`;

export interface SetupResult {
  db: TestDb;
  cap: Capabilities;
  schemas: TableSchema[];
  config: SyncConfig;
  epoch: string;
}

/** A fresh device with the sync tables/triggers installed. */
export async function setupSyncDb(overrides: Partial<SyncConfig> = {}): Promise<SetupResult> {
  const db = makeDb();
  for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.adapter.run(stmt);
  }
  const cap = await probeCapabilities(db.adapter);
  const config = makeConfig(db.adapter, {
    tables: [
      { name: 'todos', primaryKey: ['id'] },
      { name: 'notes', primaryKey: ['id'] },
    ],
    ...overrides,
  });
  const schemas = await discoverSchemas(db.adapter, config.tables);
  const epoch = await db.adapter.transaction((tx) =>
    installSchema(tx, config, cap, schemas, config.strategy === 'field' ? 'field-lww' : 'lww'),
  );
  return { db, cap, schemas, config, epoch };
}

export interface Device {
  db: TestDb;
  engine: SyncEngine;
  config: SyncConfig;
  siteId: string;
}

/** A fully initialised device sharing a backend with the other devices. */
export async function makeDevice(
  backend: RemoteBackend,
  siteId: string,
  overrides: Partial<SyncConfig> = {},
): Promise<Device> {
  const db = makeDb();
  for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.adapter.run(stmt);
  }
  const config: SyncConfig = {
    db: db.adapter,
    backend,
    appId: 'test-app',
    siteId,
    tables: [
      { name: 'todos', primaryKey: ['id'] },
      { name: 'notes', primaryKey: ['id'] },
    ],
    ...overrides,
  };
  const engine = createSyncEngine(config);
  await engine.init();
  return { db, engine, config, siteId };
}

export function rows(db: TestDb, table: string): Record<string, unknown>[] {
  return (db.raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Record<string, unknown>[]).map(
    (r) => ({ ...r }),
  );
}
