import { createRoot } from 'react-dom/client';
import type { Kysely } from 'kysely';
import { App } from './App';
import { initDB, persistNow } from './db';
import { configureEngine, isConfigured, loadSettings, withWrite } from './sync';
import { ensureVirtualDav } from './virtual-dav';
import { getLang, SEED_ITEMS, t } from './i18n';
import type { DB } from './types';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

function fatal(message: string): void {
  root.render(
    <div style={{ maxWidth: 560, margin: '60px auto', fontFamily: 'sans-serif', lineHeight: 1.7 }}>
      <h2>{t('fatal.title')}</h2>
      <p>{message}</p>
      <p>{t('fatal.body')}</p>
    </div>,
  );
}

const nowISO = (): string => new Date().toISOString();

async function seedIfFresh(db: Kysely<DB>, fresh: boolean): Promise<void> {
  if (!fresh) return;
  const now = nowISO();
  // Sample rows are content, so they are seeded in the language selected at
  // first launch. Stable ids make two independently-seeded tabs converge.
  const samples = SEED_ITEMS[getLang()];
  await withWrite(async () => {
    for (const s of samples) {
      await db
        .insertInto('items')
        .values({
          id: s.id,
          kind: s.kind,
          title: s.title,
          body: s.body,
          done: 0,
          category: s.category,
          tags: JSON.stringify(s.tags),
          due_at: '',
          remind_min: -1,
          notified: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  });
  await persistNow();
}

async function boot(): Promise<void> {
  try {
    const settings = loadSettings();
    if (settings.mode === 'demo') {
      try {
        await ensureVirtualDav();
      } catch (e) {
        // Service workers need HTTPS/localhost. Degrade to offline instead of
        // surfacing a stream of 404s from the un-intercepted virtual URL.
        console.warn('Virtual WebDAV unavailable, falling back to local mode', e);
        settings.mode = 'local';
      }
    }
    const { db, adapter, fresh } = await initDB();
    const engine = await configureEngine(settings, adapter);
    await seedIfFresh(db, fresh);
    if (isConfigured()) {
      try {
        await engine.sync();
        await persistNow();
      } catch (e) {
        console.warn('Initial sync failed (retry manually later)', e);
      }
    }
    root.render(<App db={db} initialEngine={engine} />);
  } catch (e) {
    fatal(e instanceof Error ? e.message : String(e));
  }
}

void boot();
