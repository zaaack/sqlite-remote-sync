import { createSyncEngine, MemoryBackend, WebDavBackend } from 'sqlite-remote-sync';
import type { SqliteAdapter, SyncEngine } from 'sqlite-remote-sync';
import { DEFAULT_SETTINGS } from './types';
import type { Settings } from './types';
import { getTabId } from './tab';
import { DEMO_APP_ID, demoDavHeaders, demoDavUrl } from './virtual-dav';

const SETTINGS_KEY = 'srs.settings';

let engine: SyncEngine | null = null;
let configured = false;

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<Settings>;
    const merged: Settings = { ...DEFAULT_SETTINGS, ...saved };
    if (merged.mode !== 'demo' && merged.mode !== 'custom' && merged.mode !== 'local') {
      merged.mode = 'demo';
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/** Each tab is its own device, so the engine needs a per-tab siteId. */
export function getSiteId(): string {
  return getTabId();
}

function makeBackend(s: Settings) {
  // Offline mode keeps a throwaway in-memory backend so local edits are still
  // recorded in the outbox and can be pushed later.
  if (s.mode === 'local' || (s.mode === 'custom' && !s.url.trim())) return new MemoryBackend();

  const demo = s.mode === 'demo';
  const opts: {
    url: string;
    token?: string;
    username?: string;
    password?: string;
    headers?: () => Record<string, string>;
  } = { url: demo ? demoDavUrl() : s.url.trim() };

  if (demo) {
    opts.headers = demoDavHeaders;
  } else if (s.token.trim()) {
    opts.token = s.token.trim();
  } else if (s.username) {
    opts.username = s.username;
    opts.password = s.password || '';
  }
  return new WebDavBackend(opts);
}

/**
 * (Re)create the sync engine. The engine's outbox/cursors live inside the
 * SQLite file, so a fresh engine picks up pending local changes on the next
 * sync.
 */
export async function configureEngine(settings: Settings, db: SqliteAdapter): Promise<SyncEngine> {
  if (engine) {
    try {
      await engine.close();
    } catch (e) {
      console.warn('close previous engine:', e);
    }
    engine = null;
  }

  const backend = makeBackend(settings);
  configured = settings.mode === 'demo' || (settings.mode === 'custom' && !!settings.url.trim());

  const e = createSyncEngine({
    db,
    backend,
    // All demo tabs must use the same namespace to see each other.
    appId: settings.mode === 'demo' ? DEMO_APP_ID : (settings.appId || 'todo-notes').trim(),
    siteId: getSiteId(),
    tables: [{ name: 'items', primaryKey: ['id'] }],
    strategy: 'field', // per-column LWW: edit title on one device, tick done on another, keep both
    compress: true,
    retry: { attempts: 3, baseDelayMs: 200, maxDelayMs: 3000 },
  });

  await e.init();
  engine = e;

  // Demo mode also gets instant cross-tab refresh from the worker broadcast;
  // this short timer is a safety net (and covers a tab that missed a message).
  const intervalSec = settings.mode === 'demo' ? 10 : Math.max(10, Number(settings.intervalSec) || 60);
  if (configured && settings.autoSync) e.startAutoSync(intervalSec * 1000);
  return e;
}

export function getEngine(): SyncEngine | null {
  return engine;
}

export function isConfigured(): boolean {
  return configured;
}

/** Serialize a local mutation with the engine write lock. */
export function withWrite<T>(fn: () => Promise<T> | T): Promise<T> {
  return engine ? engine.write(fn) : Promise.resolve(fn());
}
