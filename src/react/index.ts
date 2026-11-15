/**
 * `sqlite-remote-sync/react` — live Kysely queries for React.
 *
 * Wrap your tree in `<SyncProvider db={kysely} engine={engine}>`, then use
 * `useKysely()` to run CRUD directly on the SQLite database and `useQuery()`
 * to read from it. Queries refresh automatically after local writes and after
 * the sync engine applies remote changes.
 */
export { createLiveKysely } from './live.js';
export type { LiveKysely, LiveKyselyOptions } from './live.js';

export { SyncProvider, LiveKyselyContext } from './context.js';
export type { SyncProviderProps } from './context.js';

export {
  useKysely,
  useQuery,
  useLiveKysely,
  useSyncEngine,
  useSyncEvent,
  useSync,
} from './hooks.js';
export type { QueryResult, SyncActions } from './hooks.js';
