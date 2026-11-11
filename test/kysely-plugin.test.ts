import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { CompiledQuery, Kysely } from 'kysely';
import { GenericSqliteDialect } from 'kysely-generic-sqlite';
import {
  attachSyncPlugin,
  createSyncEngine,
  createSyncPlugin,
  fromKysely,
  MemoryBackend,
  type SyncEngine,
} from '../src/index.js';
import { makeDevice, rows } from './helpers.js';

interface DB {
  todos: { id: string; title: string; done: number; score: number | null; payload: Uint8Array | null };
}

function makeKysely(): { raw: DatabaseSync; db: Kysely<DB> } {
  const raw = new DatabaseSync(':memory:');
  const executor = {
    db: raw,
    query: (_isSelect: boolean, sql: string, params: any[] | readonly any[]) => {
      const st = raw.prepare(sql);
      if (st.columns().length > 0) return { rows: st.all(...(params as any[])) };
      const r = st.run(...(params as any[]));
      return { rows: [], numAffectedRows: BigInt(r.changes), insertId: BigInt(r.lastInsertRowid) };
    },
    close: () => raw.close(),
  };
  const dialect = new GenericSqliteDialect(() => executor);
  return { raw, db: new Kysely<DB>({ dialect }) };
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Kysely plugin: sync immediately after a write', () => {
  it('auto-pushes an INSERT made through kysely-generic-sqlite', async () => {
    const backend = new MemoryBackend();
    const { raw, db } = makeKysely();
    raw.exec(`
      CREATE TABLE todos (
        id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0, score REAL, payload BLOB
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, body TEXT, rev INTEGER
      );
    `);

    // The engine uses the plugin-free instance; app writes use the instrumented
    // one. This is the recommended wiring and avoids any feedback loop.
    const engine = createSyncEngine({
      db: fromKysely(db, { compiledQuery: (sql, p) => CompiledQuery.raw(sql, p) }),
      backend,
      appId: 'kysely-plugin',
      siteId: 'KP-A',
      tables: [
        { name: 'todos', primaryKey: ['id'] },
        { name: 'notes', primaryKey: ['id'] },
      ],
    });
    await engine.init();

    const appDb = attachSyncPlugin(db, engine, { debounceMs: 10, mode: 'push' });
    await appDb.insertInto('todos').values({ id: 'k1', title: 'written via Kysely', done: 1 }).execute();

    // No explicit engine.sync(): the plugin triggered the push.
    await waitFor(() => backend.keys().some((k) => k.includes('manifest/KP-A.json')));

    const reader = await makeDevice(backend, 'KP-B', { appId: 'kysely-plugin' });
    await reader.engine.pull();
    assert.deepEqual(rows(reader.db, 'todos'), [
      { id: 'k1', title: 'written via Kysely', done: 1, score: null, payload: null },
    ]);

    // A second write also gets pushed automatically (debounce coalescing).
    await appDb.updateTable('todos').set({ title: 'edited via Kysely' }).where('id', '=', 'k1').execute();
    await new Promise((r) => setTimeout(r, 150));
    await reader.engine.pull();
    assert.equal(rows(reader.db, 'todos')[0]!.title, 'edited via Kysely');

    await reader.engine.close();
    await engine.close();
    await db.destroy();
  });

  it('ignores writes while the engine is syncing (no feedback loop)', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      isSyncing: () => true,
      push: async () => {
        calls.push('push');
      },
      sync: async () => {
        calls.push('sync');
      },
    } as unknown as SyncEngine;
    const plugin = createSyncPlugin(fakeEngine, { debounceMs: 0 });
    plugin.transformQuery({ queryId: 1, node: { kind: 'InsertQueryNode' } });
    await plugin.transformResult({ queryId: 1, node: { kind: 'InsertQueryNode' }, result: { rows: [] } });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, [], 'no sync scheduled while engine is syncing');
  });

  it('detects write nodes, coalesces bursts and supports flush()', async () => {
    const calls: string[] = [];
    const fakeEngine = {
      isSyncing: () => false,
      push: async () => {
        calls.push('push');
      },
      sync: async () => {
        calls.push('sync');
      },
    } as unknown as SyncEngine;
    const plugin = createSyncPlugin(fakeEngine, { debounceMs: 500, mode: 'sync' });

    for (const [id, kind] of [
      [1, 'InsertQueryNode'],
      [2, 'UpdateQueryNode'],
      [3, 'DeleteQueryNode'],
      [4, 'SelectQueryNode'],
    ] as const) {
      plugin.transformQuery({ queryId: id, node: { kind } });
      await plugin.transformResult({ queryId: id, node: { kind }, result: { rows: [] } });
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0, 'debounce has not fired yet');
    await plugin.flush();
    assert.deepEqual(calls, ['sync'], 'one coalesced sync after flush');
  });
});
