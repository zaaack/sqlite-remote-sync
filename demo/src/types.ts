export type Kind = 'todo' | 'note';

/** Row shape as stored in SQLite. `tags` is a JSON-encoded string array. */
export interface ItemsTable {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  done: number;
  category: string;
  tags: string;
  due_at: string;
  remind_min: number;
  notified: number;
  created_at: string;
  updated_at: string;
}

export interface DB {
  items: ItemsTable;
}

/** Row shape used by the UI (`tags` parsed into an array). */
export interface Item {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  done: number;
  category: string;
  tags: string[];
  due_at: string;
  remind_min: number;
  notified: number;
  created_at: string;
  updated_at: string;
}

/**
 * demo  = built-in WebDAV server in a Service Worker (shared by all tabs)
 * custom= a real WebDAV server (needs CORS)
 * local = offline only (MemoryBackend)
 */
export type SyncMode = 'demo' | 'custom' | 'local';

export interface Settings {
  mode: SyncMode;
  url: string;
  username: string;
  password: string;
  token: string;
  appId: string;
  autoSync: boolean;
  intervalSec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'demo',
  url: '',
  username: '',
  password: '',
  token: '',
  appId: 'todo-notes-demo',
  autoSync: true,
  intervalSec: 10,
};
