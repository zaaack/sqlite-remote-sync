import { close as closeSqlite, exportDatabase } from '@subframe7536/sqlite-wasm';
import { createOnMessageCallback, defaultCreateDatabaseFn } from 'kysely-wasqlite-worker';

// Custom worker: the built-in one only executes SQL. We add two requests that
// need direct access to the SQLiteDBCore inside the worker.
createOnMessageCallback(defaultCreateDatabaseFn, async (executor, { type }) => {
  const core = executor.db; // SQLiteDBCore { path, vfs, sqlite, pointer, ... }

  if (type === 'export') {
    // The package README shows exportDatabase(executor.db), but the real
    // signature is exportDatabase(vfs, path) -- see initSQLite().dump().
    return exportDatabase(core.vfs, core.path);
  }

  if (type === 'reset') {
    await closeSqlite(core);
    // Release the VFS's IDB connection, otherwise deleteDatabase() stays blocked.
    await core.vfs.close();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(core.path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(`deleteDatabase(${core.path}) blocked`));
    });
    return null;
  }

  throw new Error(`Unknown worker request: ${type}`);
});
