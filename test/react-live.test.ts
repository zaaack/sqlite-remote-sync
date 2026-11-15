import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveKysely } from '../src/react/live.js';
import type { SyncEngine, SyncEvent, SyncStats } from '../src/core/types.js';

const stats = {} as SyncStats;

function fakeKysely() {
  let plugin: any;
  const live = {
    withPlugin(p: any) {
      plugin = p;
      return live;
    },
  };
  return { db: live as any, plugin: () => plugin };
}

function fakeEngine() {
  const listeners = new Set<(e: SyncEvent) => void>();
  let pushes = 0;
  const engine = {
    on(fn: (e: SyncEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(e: SyncEvent) {
      for (const fn of [...listeners]) fn(e);
    },
    isSyncing: () => false,
    push: async () => {
      pushes++;
      return stats;
    },
    sync: async () => stats,
  };
  return { engine: engine as unknown as SyncEngine, emit: engine.emit, pushes: () => pushes };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
}

async function write(plugin: any, queryId: string, kind: string): Promise<void> {
  const node = { kind };
  plugin.transformQuery({ queryId, node });
  await plugin.transformResult({ queryId, node, result: { rows: [] } });
}

test('createLiveKysely invalidates after Kysely query-builder writes only', async () => {
  const { db, plugin } = fakeKysely();
  const live = createLiveKysely(db, { engine: undefined });
  let hits = 0;
  const off = live.subscribe(() => hits++);

  await write(plugin(), 'w1', 'InsertQueryNode');
  await write(plugin(), 'w2', 'UpdateQueryNode');
  await write(plugin(), 'w3', 'DeleteQueryNode');
  await write(plugin(), 'r1', 'SelectQueryNode');
  await write(plugin(), 'e1', 'RawNode'); // engine-internal write
  await tick();

  assert.equal(hits, 1, 'burst of 3 writes coalesces into one notification');

  await write(plugin(), 'w4', 'InsertQueryNode');
  await tick();
  assert.equal(hits, 2, 'a later write triggers a fresh notification');

  await write(plugin(), 'r2', 'SelectQueryNode');
  await write(plugin(), 'e2', 'RawNode');
  await tick();
  assert.equal(hits, 2, 'reads and engine-internal RawNode writes do not notify');

  off();
  live.dispose();
});

test('createLiveKysely invalidates on remote pulls that applied rows', async () => {
  const { db } = fakeKysely();
  const { engine, emit } = fakeEngine();
  const live = createLiveKysely(db, { engine, syncAfterWrite: false });
  let hits = 0;
  live.subscribe(() => hits++);

  emit({ type: 'pull', stats: { ...stats, appliedOps: 0 } as SyncStats });
  await tick();
  assert.equal(hits, 0);

  emit({ type: 'pull', stats: { ...stats, appliedOps: 2 } as SyncStats });
  await tick();
  assert.equal(hits, 1);

  live.dispose();
  emit({ type: 'pull', stats: { ...stats, appliedOps: 5 } as SyncStats });
  await tick();
  assert.equal(hits, 1, 'dispose detaches the engine listener');
});

test('syncAfterWrite pushes after a write and flush() fires synchronously', async () => {
  const { db, plugin } = fakeKysely();
  const { engine, pushes } = fakeEngine();
  const live = createLiveKysely(db, {
    engine,
    syncAfterWrite: true,
    syncPlugin: { debounceMs: 5 },
  });
  let hits = 0;
  live.subscribe(() => hits++);

  await write(plugin(), 'w1', 'InsertQueryNode');
  await live.flush();
  assert.equal(pushes(), 1, 'flush() pushes pending sync');
  assert.equal(hits, 1, 'flush() also emits the coalesced notification');
  live.dispose();
});

test('subscribe/unsubscribe is StrictMode-safe (re-attachable engine listener)', async () => {
  const { db } = fakeKysely();
  const { engine, emit } = fakeEngine();
  const live = createLiveKysely(db, { engine, syncAfterWrite: false });
  let hits = 0;

  const a = live.subscribe(() => hits++);
  a(); // simulate React StrictMode cleanup
  const b = live.subscribe(() => hits++);
  emit({ type: 'pull', stats: { ...stats, appliedOps: 1 } as SyncStats });
  await tick();
  assert.equal(hits, 1, 'listener re-attached after the last subscriber left and returned');

  b();
  live.dispose();
});
