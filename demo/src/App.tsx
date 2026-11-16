import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Kysely } from 'kysely';
import {
  SyncProvider,
  useKysely,
  useQuery,
  useSync,
  useSyncEvent,
} from 'sqlite-remote-sync/react';
import type { SyncEngine } from 'sqlite-remote-sync';
import { clearLocalDB, exportSQLiteBytes, getAdapter } from './db';
import {
  configureEngine,
  getEngine,
  isConfigured,
  loadSettings,
  saveSettings,
  withWrite,
} from './sync';
import { anotherTabUrl, getTabId, tabLabel } from './tab';
import { clearVirtualDav, DAV_CHANGE_EVENT, DEMO_APP_ID } from './virtual-dav';
import { getLang, setLang, t, useLang } from './i18n';
import type { TKey } from './i18n';
import type { DB, Item, ItemsTable, Kind, Settings, SyncMode } from './types';

/* ------------------------------------------------------------------ */
/* constants & helpers                                                 */
/* ------------------------------------------------------------------ */

type ViewId = 'all' | 'todo' | 'note' | 'done';
type SortId = 'created' | 'due' | 'updated' | 'title';

interface Toast {
  id: number;
  msg: string;
  type: string;
}

interface EditorValues {
  kind: Kind;
  title: string;
  body: string;
  category: string;
  tags: string;
  due_at: string;
  remind_min: number;
}

const VIEWS: Array<{ id: ViewId; labelKey: TKey; icon: string }> = [
  { id: 'all', labelKey: 'view.all', icon: '▦' },
  { id: 'todo', labelKey: 'view.todo', icon: '✓' },
  { id: 'note', labelKey: 'view.note', icon: '▤' },
  { id: 'done', labelKey: 'view.done', icon: '✔' },
];

const SORTS: Array<{ id: SortId; labelKey: TKey }> = [
  { id: 'created', labelKey: 'sort.created' },
  { id: 'due', labelKey: 'sort.due' },
  { id: 'updated', labelKey: 'sort.updated' },
  { id: 'title', labelKey: 'sort.title' },
];

const REMIND_OPTIONS: Array<{ value: number; labelKey: TKey }> = [
  { value: -1, labelKey: 'remind.none' },
  { value: 0, labelKey: 'remind.onTime' },
  { value: 5, labelKey: 'remind.m5' },
  { value: 15, labelKey: 'remind.m15' },
  { value: 60, labelKey: 'remind.h1' },
  { value: 1440, labelKey: 'remind.d1' },
];

const REMIND_SHORT: Record<number, TKey> = {
  0: 'remind.onTime',
  5: 'remind.short.m5',
  15: 'remind.short.m15',
  60: 'remind.short.h1',
  1440: 'remind.short.d1',
};

const MODES: Array<{ id: SyncMode; labelKey: TKey; hintKey: TKey }> = [
  { id: 'demo', labelKey: 'settings.modeDemo', hintKey: 'settings.modeDemoHint' },
  { id: 'custom', labelKey: 'settings.modeCustom', hintKey: 'settings.modeCustomHint' },
  { id: 'local', labelKey: 'settings.modeLocal', hintKey: 'settings.modeLocalHint' },
];

function remindShort(m: number): string {
  const key: TKey | undefined = REMIND_SHORT[m];
  return key ? t(key) : t('remind.generic');
}

const uid = (): string =>
  globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const nowISO = (): string => new Date().toISOString();
const parseLocal = (s: string): number => (s ? new Date(s).getTime() : NaN);
const locale = (): string => (getLang() === 'zh' ? 'zh-CN' : 'en-US');

function fmtDateTime(s: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function parseTags(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseTagInput(s: string): string[] {
  return s.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
}

function normalizeRow(r: ItemsTable): Item {
  return {
    ...r,
    kind: r.kind === 'note' ? 'note' : 'todo',
    done: Number(r.done),
    notified: Number(r.notified),
    remind_min: Number(r.remind_min),
    tags: parseTags(r.tags),
  };
}

function remindAt(it: Item): number | null {
  if (it.kind !== 'todo' || it.done || !it.due_at || it.remind_min < 0) return null;
  const due = parseLocal(it.due_at);
  return Number.isNaN(due) ? null : due - Number(it.remind_min) * 60000;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function notifyDesktop(title: string, body: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body: body || t('remind.desktopFallback') });
  } catch {
    /* some platforms require a service worker */
  }
}

function normalizeImport(raw: any): ItemsTable | null {
  if (!raw || typeof raw !== 'object') return null;
  let tags: unknown = raw.tags;
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = String(tags).split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(tags)) tags = [];
  const title = String(raw.title ?? '').slice(0, 200);
  if (!title) return null;
  return {
    id: String(raw.id ?? '') || uid(),
    kind: raw.kind === 'note' ? 'note' : 'todo',
    title,
    body: String(raw.body ?? ''),
    done: raw.done ? 1 : 0,
    category: String(raw.category ?? ''),
    tags: JSON.stringify((tags as unknown[]).map(String)),
    due_at: String(raw.due_at ?? ''),
    remind_min: Number.isFinite(Number(raw.remind_min)) ? Number(raw.remind_min) : -1,
    notified: raw.notified ? 1 : 0,
    created_at: String(raw.created_at ?? nowISO()),
    updated_at: String(raw.updated_at ?? nowISO()),
  };
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------------ */
/* card                                                                */
/* ------------------------------------------------------------------ */

interface CardProps {
  item: Item;
  onToggle: (it: Item) => void;
  onEdit: (it: Item) => void;
  onDelete: (it: Item) => void;
  onCategory: (c: string) => void;
  onTag: (t: string) => void;
}

function Card({ item: it, onToggle, onEdit, onDelete, onCategory, onTag }: CardProps) {
  useLang();
  const isTodo = it.kind === 'todo';
  const done = !!it.done;
  const dueT = it.due_at ? parseLocal(it.due_at) : NaN;
  const now = Date.now();
  const overdue = isTodo && !done && !Number.isNaN(dueT) && dueT < now;
  const soon = isTodo && !done && !Number.isNaN(dueT) && !overdue && dueT - now < 24 * 3600 * 1000;

  return (
    <article className={`card ${done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}`}>
      <div className="card-check">
        {isTodo ? (
          <button
            className={`check ${done ? 'checked' : ''}`}
            title={t('card.toggle')}
            onClick={() => onToggle(it)}
          >
            {done ? '✓' : ''}
          </button>
        ) : (
          <span className="note-ico">▤</span>
        )}
      </div>
      <div className="card-body">
        <div className="card-top">
          <span className={`kind-badge kind-${isTodo ? 'todo' : 'note'}`}>
            {isTodo ? t('kind.todo') : t('kind.note')}
          </span>
          {it.category && (
            <button className="chip-mini cat" onClick={() => onCategory(it.category)}>
              {it.category}
            </button>
          )}
          {it.tags.map((tag) => (
            <button className="chip-mini tag" key={tag} onClick={() => onTag(tag)}>
              #{tag}
            </button>
          ))}
        </div>
        <h3 className="card-title" onClick={() => onEdit(it)}>{it.title}</h3>
        {it.body && <p className="card-text">{it.body.length > 240 ? `${it.body.slice(0, 240)}…` : it.body}</p>}
        <div className="card-meta">
          {it.due_at && (
            <span className={`badge ${overdue ? 'overdue' : soon ? 'soon' : 'due'}`}>
              {overdue ? t('card.overdue') : soon ? t('card.soon') : t('card.due')} {fmtDateTime(it.due_at)}
            </span>
          )}
          {isTodo && it.remind_min >= 0 && !done && (
            <span className="badge remind">
              🔔 {it.notified ? t('card.notified') : remindShort(it.remind_min)}
            </span>
          )}
          <span className="muted small">{t('card.updated', { time: fmtDateTime(it.updated_at) })}</span>
        </div>
      </div>
      <div className="card-actions">
        <button className="icon-btn" title={t('card.edit')} onClick={() => onEdit(it)}>✎</button>
        <button className="icon-btn" title={t('card.delete')} onClick={() => onDelete(it)}>🗑</button>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* editor modal                                                        */
/* ------------------------------------------------------------------ */

interface EditorProps {
  item: Item | null;
  categories: string[];
  onSave: (v: EditorValues) => void;
  onDelete: (it: Item) => void;
  onClose: () => void;
}

function Editor({ item, categories, onSave, onDelete, onClose }: EditorProps) {
  useLang();
  const [v, setV] = useState<EditorValues>(() => ({
    kind: item?.kind ?? 'todo',
    title: item?.title ?? '',
    body: item?.body ?? '',
    category: item?.category ?? '',
    tags: (item?.tags ?? []).join(', '),
    due_at: item?.due_at ?? '',
    remind_min: item?.remind_min ?? -1,
  }));
  const set = <K extends keyof EditorValues>(k: K, value: EditorValues[K]): void =>
    setV((prev) => ({ ...prev, [k]: value }));

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!v.title.trim()) return;
    onSave({ ...v, title: v.title.trim(), body: v.body.trim(), category: v.category.trim() });
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{item ? t('editor.edit') : t('editor.new')}</h3>
          <button className="icon-btn" aria-label={t('btn.close')} onClick={onClose}>✕</button>
        </div>
        <form id="editor-form" onSubmit={submit}>
          <div className="kind-toggle">
            <label>
              <input type="radio" name="kind" checked={v.kind === 'todo'} onChange={() => set('kind', 'todo')} />
              {t('editor.todo')}
            </label>
            <label>
              <input type="radio" name="kind" checked={v.kind === 'note'} onChange={() => set('kind', 'note')} />
              {t('editor.note')}
            </label>
          </div>
          <label className="field">{t('editor.title')}
            <input required maxLength={200} placeholder={t('editor.titlePlaceholder')} value={v.title} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className="field">{t('editor.body')}
            <textarea rows={3} placeholder={t('editor.bodyPlaceholder')} value={v.body} onChange={(e) => set('body', e.target.value)} />
          </label>
          <div className="row">
            <label className="field">{t('editor.category')}
              <input list="category-options" placeholder={t('editor.categoryPlaceholder')} maxLength={60} value={v.category} onChange={(e) => set('category', e.target.value)} />
            </label>
            <datalist id="category-options">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
            <label className="field">{t('editor.tags')}
              <input placeholder={t('editor.tagsPlaceholder')} value={v.tags} onChange={(e) => set('tags', e.target.value)} />
            </label>
          </div>
          <div className="row todo-only" hidden={v.kind !== 'todo'}>
            <label className="field">{t('editor.due')}
              <input type="datetime-local" value={v.due_at} onChange={(e) => set('due_at', e.target.value)} />
            </label>
            <label className="field">{t('editor.remind')}
              <select value={v.remind_min} onChange={(e) => set('remind_min', Number(e.target.value))}>
                {REMIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
              </select>
            </label>
          </div>
          <p className="form-hint">{t('remind.hint')}</p>
          <div className="modal-actions">
            <button type="button" className="btn danger" hidden={!item} onClick={() => item && onDelete(item)}>{t('btn.delete')}</button>
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={onClose}>{t('btn.cancel')}</button>
            <button type="submit" className="btn primary">{t('btn.save')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* settings drawer                                                     */
/* ------------------------------------------------------------------ */

interface SettingsProps {
  settings: Settings;
  onSave: (s: Settings) => void | Promise<void>;
  onCancel: () => void;
  onReset: () => void;
  onResetDemo: () => void;
}

function SettingsPanel({ settings, onSave, onCancel, onReset, onResetDemo }: SettingsProps) {
  useLang();
  const [form, setForm] = useState<Settings>(settings);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Settings>(k: K, value: Settings[K]): void =>
    setForm((prev) => ({ ...prev, [k]: value }));

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (saving) return;
    const url = form.url.trim();
    if (form.mode === 'custom' && url) {
      try {
        new URL(url);
      } catch {
        setError(t('settings.badUrl'));
        return;
      }
    }
    setSaving(true);
    Promise.resolve()
      .then(() =>
        onSave({
          ...form,
          url,
          token: form.token.trim(),
          appId: form.mode === 'demo' ? DEMO_APP_ID : (form.appId.trim() || 'todo-notes'),
          intervalSec: Math.max(10, Number(form.intervalSec) || 10),
        }),
      )
      .finally(() => setSaving(false));
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{t('settings.title')}</h3>
          <button className="icon-btn" aria-label={t('btn.close')} onClick={onCancel}>✕</button>
        </div>
        <div className="drawer-body">
          <form id="settings-form" onSubmit={submit}>
          <p className="note">{t('settings.intro')}</p>

          <div className="field">{t('settings.modeLabel')}
            <div className="mode-options">
              {MODES.map((m) => (
                <label key={m.id} className={`mode-option ${form.mode === m.id ? 'active' : ''}`}>
                  <input type="radio" name="mode" value={m.id} checked={form.mode === m.id} onChange={() => set('mode', m.id)} />
                  <span className="mode-title">{t(m.labelKey)}</span>
                  <small>{t(m.hintKey)}</small>
                </label>
              ))}
            </div>
          </div>

          {form.mode === 'demo' && <div className="callout info">{t('settings.demoInfo')}</div>}

          {form.mode === 'custom' && (
            <>
              <div className="callout warn"><b>{t('settings.corsTitle')}</b> {t('settings.corsBody')}</div>
              <label className="field">{t('settings.url')}
                <input type="url" placeholder={t('settings.urlPlaceholder')} value={form.url} onChange={(e) => set('url', e.target.value)} />
              </label>
              <div className="row">
                <label className="field">{t('settings.username')}
                  <input autoComplete="username" placeholder={t('settings.optional')} value={form.username} onChange={(e) => set('username', e.target.value)} />
                </label>
                <label className="field">{t('settings.password')}
                  <input type="password" autoComplete="current-password" placeholder={t('settings.passwordPlaceholder')} value={form.password} onChange={(e) => set('password', e.target.value)} />
                </label>
              </div>
              <label className="field">{t('settings.token')}
                <input placeholder="token…" value={form.token} onChange={(e) => set('token', e.target.value)} />
              </label>
              <label className="field">{t('settings.appId')}
                <input placeholder="todo-notes" value={form.appId} onChange={(e) => set('appId', e.target.value)} />
                <small>{t('settings.appIdHint')}</small>
              </label>
              <div className="row">
                <label className="check"><input type="checkbox" checked={form.autoSync} onChange={(e) => set('autoSync', e.target.checked)} /> {t('settings.autoSync')}</label>
                <label className="field inline">{t('settings.interval')}
                  <input type="number" min={10} step={10} value={form.intervalSec} onChange={(e) => set('intervalSec', Number(e.target.value))} />
                </label>
              </div>
              <p className="form-hint">{t('settings.credentialsHint')}</p>
            </>
          )}

          {error && <p className="form-hint" style={{ color: 'var(--red)' }}>{error}</p>}

          <div className="danger-zone">
            <div className="side-label">{t('settings.danger')}</div>
            <button type="button" className="btn danger ghost" onClick={onReset}>{t('btn.resetLocal')}</button>
            <small>{t('settings.resetLocalHint')}</small>
            {form.mode === 'demo' && (
              <>
                <button type="button" className="btn danger ghost" onClick={onResetDemo}>{t('btn.resetDemo')}</button>
                <small>{t('toast.resetDemoConfirm')}</small>
              </>
            )}
          </div>
          </form>
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>{t('btn.cancel')}</button>
          <button type="submit" form="settings-form" className="btn primary" disabled={saving}>{t('btn.saveConnect')}</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* app                                                                 */
/* ------------------------------------------------------------------ */

interface AppProps {
  db: Kysely<DB>;
  initialEngine: SyncEngine;
}

export function App({ db, initialEngine }: AppProps) {
  const [engine, setEngine] = useState(initialEngine);
  return (
    // In offline mode the engine uses a throwaway MemoryBackend: let changes
    // accumulate in the outbox so they are pushed once a remote is configured.
    <SyncProvider db={db} engine={engine} syncAfterWrite={isConfigured()}>
      <Workspace onEngineChange={setEngine} />
    </SyncProvider>
  );
}

function Workspace({ onEngineChange }: { onEngineChange: (e: SyncEngine) => void }) {
  useLang();
  const kdb = useKysely<DB>();
  const sync = useSync();
  const event = useSyncEvent();
  const { data: rows, isLoading, error: queryError, refresh } = useQuery<ItemsTable[], DB>(
    (d) => d.selectFrom('items').selectAll().execute(),
  );

  const [view, setView] = useState<ViewId>('all');
  const [category, setCategory] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortId>('created');
  const [editor, setEditor] = useState<{ item: Item | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [exportOpen, setExportOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notifyPerm, setNotifyPerm] = useState<string>(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const toastSeq = useRef(0);
  const itemsRef = useRef<Item[]>([]);

  const toast = useCallback((msg: string, type = '', ms = 3800): void => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), ms);
  }, []);

  const items = useMemo<Item[]>(() => (rows ?? []).map(normalizeRow), [rows]);
  itemsRef.current = items;

  const counts = useMemo(() => ({
    all: items.length,
    todo: items.filter((x) => x.kind === 'todo' && !x.done).length,
    note: items.filter((x) => x.kind === 'note').length,
    done: items.filter((x) => x.kind === 'todo' && x.done).length,
  }), [items]);

  const facets = useMemo(() => {
    const catMap = new Map<string, number>();
    const tagMap = new Map<string, number>();
    for (const it of items) {
      if (it.category) catMap.set(it.category, (catMap.get(it.category) ?? 0) + 1);
      for (const x of it.tags) tagMap.set(x, (tagMap.get(x) ?? 0) + 1);
    }
    const byCount = (a: [string, number], b: [string, number]): number =>
      b[1] - a[1] || a[0].localeCompare(b[0], locale());
    return {
      cats: [...catMap.entries()].sort(byCount),
      tags: [...tagMap.entries()].sort(byCount),
    };
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const arr = items.filter((it) => {
      if (view === 'todo' && !(it.kind === 'todo' && !it.done)) return false;
      if (view === 'note' && it.kind !== 'note') return false;
      if (view === 'done' && !(it.kind === 'todo' && it.done)) return false;
      if (category && it.category !== category) return false;
      if (tag && !it.tags.includes(tag)) return false;
      if (q && ![it.title, it.body, it.category, ...it.tags].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
    const byCreated = (a: Item, b: Item): number => String(b.created_at).localeCompare(String(a.created_at));
    arr.sort((a, b) => {
      switch (sort) {
        case 'updated': return String(b.updated_at).localeCompare(String(a.updated_at));
        case 'title': return String(a.title).localeCompare(String(b.title), locale());
        case 'due': {
          const da = a.kind === 'todo' && a.due_at ? parseLocal(a.due_at) : Infinity;
          const dbb = b.kind === 'todo' && b.due_at ? parseLocal(b.due_at) : Infinity;
          return da === dbb ? byCreated(a, b) : da - dbb;
        }
        default: return byCreated(a, b);
      }
    });
    return arr;
  }, [items, view, category, tag, search, sort]);

  /* ---------------- mutations: only Kysely, no manual UI refresh ----- */

  const toggleDone = useCallback(async (it: Item): Promise<void> => {
    await withWrite(() =>
      kdb.updateTable('items').set({ done: it.done ? 0 : 1, updated_at: nowISO() }).where('id', '=', it.id).execute(),
    );
  }, [kdb]);

  const deleteItem = useCallback(async (it: Item): Promise<boolean> => {
    if (!confirm(t('toast.deleteConfirm', { title: it.title }))) return false;
    await withWrite(() => kdb.deleteFrom('items').where('id', '=', it.id).execute());
    return true;
  }, [kdb]);

  const saveItem = useCallback(async (v: EditorValues, editing: Item | null): Promise<void> => {
    const now = nowISO();
    const tags = JSON.stringify(parseTagInput(v.tags));
    const due_at = v.kind === 'todo' ? v.due_at : '';
    const remind_min = v.kind === 'todo' ? v.remind_min : -1;
    if (editing) {
      const timingChanged = editing.due_at !== due_at || Number(editing.remind_min) !== remind_min;
      const notified = timingChanged ? 0 : editing.notified;
      await withWrite(() =>
        kdb.updateTable('items').set({
          kind: v.kind, title: v.title, body: v.body, category: v.category,
          tags, due_at, remind_min, notified, updated_at: now,
        }).where('id', '=', editing.id).execute(),
      );
    } else {
      await withWrite(() =>
        kdb.insertInto('items').values({
          id: uid(), kind: v.kind, title: v.title, body: v.body, done: 0,
          category: v.category, tags, due_at, remind_min, notified: 0,
          created_at: now, updated_at: now,
        }).execute(),
      );
    }
    setEditor(null);
  }, [kdb]);

  /* ---------------- reminders --------------------------------------- */

  const checkReminders = useCallback(async (): Promise<void> => {
    const now = Date.now();
    const due = itemsRef.current.filter((it) => {
      if (it.notified) return false;
      const at = remindAt(it);
      return at != null && at <= now;
    });
    if (!due.length) return;
    for (const it of due) {
      toast(t('remind.toastPrefix', { title: it.title }), 'remind', 9000);
      notifyDesktop(it.title, it.body || (it.due_at ? t('remind.duePrefix', { time: fmtDateTime(it.due_at) }) : t('remind.todoReminder')));
    }
    await withWrite(async () => {
      for (const it of due) {
        await kdb.updateTable('items').set({ notified: 1 }).where('id', '=', it.id).execute();
      }
    });
  }, [kdb, toast]);

  // useQuery resolves asynchronously: wait for the first rows before the
  // initial check, and re-check whenever the data changes (e.g. an edit that
  // re-arms a reminder). Re-runs are harmless: `notified` is now 1.
  useEffect(() => {
    if (isLoading || !items.length) return;
    void checkReminders();
  }, [items, isLoading, checkReminders]);

  useEffect(() => {
    const timer = setInterval(() => void checkReminders(), 30000);
    return () => clearInterval(timer);
  }, [checkReminders]);

  /* ---------------- instant cross-tab refresh ------------------------ */

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; tabId?: string } | undefined;
      if (!data) return;
      if (data.type === 'srs-dav-cleared') {
        if (data.tabId === getTabId()) return;
        void clearLocalDB().then(() => location.reload());
        return;
      }
      if (data.type !== DAV_CHANGE_EVENT || data.tabId === getTabId()) return;
      // Another tab wrote a segment. Settle briefly so its manifest update
      // lands too, then let the engine pull (useQuery re-runs automatically).
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const e = getEngine();
        if (!e) return;
        void e.sync()
          .then((stats) => {
            if (stats.appliedOps) toast(t('toast.remotelySynced', { n: stats.appliedOps }), 'success');
          })
          .catch(() => { /* auto-sync will retry */ });
      }, 250);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      if (timer) clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [toast]);

  /* ---------------- sync --------------------------------------------- */

  useEffect(() => {
    if (event?.type === 'error') toast(t('toast.autoSyncError', { msg: errorMessage(event.error) }), 'error');
  }, [event, toast]);

  useEffect(() => {
    if (queryError) toast(t('toast.queryFailed', { msg: errorMessage(queryError) }), 'error');
  }, [queryError, toast]);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (): void => setExportOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [exportOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setEditor(null);
      setSettingsOpen(false);
      setExportOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const handleSync = useCallback(async (): Promise<void> => {
    if (!isConfigured()) {
      toast(t('toast.noWebdav'), 'warn');
      setSettingsOpen(true);
      return;
    }
    try {
      const stats = await sync.sync();
      refresh();
      toast(t('toast.syncDone', { up: stats.pushedOps, down: stats.appliedOps }), 'success');
    } catch (e) {
      toast(t('toast.syncFailed', { msg: errorMessage(e) }), 'error');
    }
  }, [sync, toast, refresh]);

  const handleSaveSettings = useCallback(async (s: Settings): Promise<void> => {
    saveSettings(s);
    setSettings(s);
    setSettingsOpen(false);
    try {
const e = await configureEngine(s, getAdapter());
    onEngineChange(e);
    if (isConfigured()) {
      toast(s.mode === 'demo' ? t('toast.switchedDemo') : t('toast.configSaved'), 'success');
      // Sync the *current* engine: a concurrent reconfigure may have replaced
      // `e` already, and syncing a disposed engine would fail with "engine is closed".
      const cur = getEngine();
      if (cur) {
        const stats = await cur.sync();
        refresh();
        toast(t('toast.syncDone', { up: stats.pushedOps, down: stats.appliedOps }), 'success');
      }
    } else {
      toast(t('toast.switchedLocal'), 'success');
    }
    } catch (err) {
      toast(t('toast.configFailed', { msg: errorMessage(err) }), 'error');
    }
  }, [onEngineChange, toast, refresh]);

  const handleReset = useCallback(async (): Promise<void> => {
    if (!confirm(t('toast.resetConfirm'))) return;
    await clearLocalDB();
    location.reload();
  }, []);

  const handleResetDemo = useCallback(async (): Promise<void> => {
    if (!confirm(t('toast.resetDemoConfirm'))) return;
    await clearVirtualDav();
    await clearLocalDB();
    location.reload();
  }, []);

  const requestNotify = useCallback(async (): Promise<void> => {
    if (!('Notification' in window)) {
      toast(t('toast.notifyUnsupported'), 'warn');
      return;
    }
    try {
      const p = await Notification.requestPermission();
      setNotifyPerm(p);
      toast(p === 'granted' ? t('toast.notifyGranted') : t('toast.notifyDenied'), p === 'granted' ? 'success' : 'warn');
    } catch (e) {
      toast(t('toast.notifyError', { msg: errorMessage(e) }), 'error');
    }
  }, [toast]);

  /* ---------------- import / export ---------------------------------- */

  const exportJSON = useCallback((): void => {
    const payload = {
      format: 'srs-todo-notes', version: 1, exportedAt: nowISO(),
      appId: loadSettings().appId, items,
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `todo-notes-${stamp()}.json`);
    toast(t('toast.exportedJson', { n: items.length }), 'success');
  }, [items, toast]);

  const exportSQLite = useCallback(async (): Promise<void> => {
    try {
      // copy into a fresh ArrayBuffer so TS7's generic typed arrays satisfy BlobPart
      const bytes = new Uint8Array(await exportSQLiteBytes());
      download(new Blob([bytes], { type: 'application/octet-stream' }), `todo-notes-${stamp()}.sqlite`);
      toast(t('toast.exportedSqlite'), 'success');
    } catch (e) {
      toast(t('toast.exportSqliteFailed', { msg: errorMessage(e) }), 'error');
    }
  }, [toast]);

  const importJSON = useCallback(async (file: File): Promise<void> => {
    try {
      const data: unknown = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : (data as { items?: unknown })?.items;
      if (!Array.isArray(list)) throw new Error(t('toast.missingItems'));
      const values = (list as unknown[]).map(normalizeImport).filter((x): x is ItemsTable => x !== null);
      await withWrite(async () => {
        for (const v of values) {
          await kdb.insertInto('items').values(v)
            .onConflict((oc) => oc.column('id').doUpdateSet(v))
            .execute();
        }
      });
      refresh();
      toast(t('toast.imported', { n: values.length }), 'success');
    } catch (e) {
      toast(t('toast.importFailed', { msg: errorMessage(e) }), 'error');
    }
  }, [kdb, refresh, toast]);

  /* ---------------- derived UI state --------------------------------- */

  const lastSync = event && (event.type === 'push' || event.type === 'pull') ? event : null;
  const statusDot = sync.isSyncing ? 'syncing'
    : event?.type === 'error' ? 'error'
    : isConfigured() ? 'ok' : 'idle';
  const statusText = sync.isSyncing ? t('sync.syncing')
    : event?.type === 'error' ? t('sync.error')
    : !isConfigured() ? t('sync.offline')
    : lastSync ? t('sync.syncedAt', { time: new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })
    : t('sync.connected');
  const statusDetail = lastSync ? `↑${lastSync.stats.pushedOps || 0} / ↓${lastSync.stats.appliedOps || 0}` : '';
  const modeBadge = settings.mode === 'demo' ? t('sync.demoBadge')
    : settings.mode === 'custom' ? t('sync.customBadge') : t('sync.localBadge');
  const hasFilters = !!(category || tag || search);

  const clearFilters = (): void => {
    setCategory(null);
    setTag(null);
    setSearch('');
    setView('all');
  };

  const notifyLabel = notifyPerm === 'granted' ? t('btn.desktopOn')
    : notifyPerm === 'denied' ? t('btn.desktopDenied')
    : notifyPerm === 'unsupported' ? t('btn.desktopUnsupported')
    : t('btn.desktopEnable');

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="logo">{t('app.logo')}</div>
          <div className="brand-text">
            <h1>Sync Notes <span className="tag-demo">{t('app.demoTag')}</span></h1>
            <p className="sub">{t('app.subtitle')}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <input className="search" type="search" placeholder={t('search.placeholder')} autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button id="btn-new" className="btn primary" onClick={() => setEditor({ item: null })}>{t('btn.new')}</button>
          <button id="btn-sync" className="btn" disabled={sync.isSyncing} title={t('title.syncNow')} onClick={() => void handleSync()}>
            {sync.isSyncing ? t('btn.syncing') : t('btn.sync')}
          </button>
          <button id="btn-import" className="btn ghost" title={t('title.importJson')} onClick={() => fileRef.current?.click()}>{t('btn.import')}</button>
          <div className="dropdown">
            <button id="btn-export" className="btn ghost" aria-haspopup="true" onClick={(e) => { e.stopPropagation(); setExportOpen((o) => !o); }}>{t('btn.export')}</button>
            <div className={`menu ${exportOpen ? 'open' : ''}`}>
              <button onClick={() => { setExportOpen(false); exportJSON(); }}>{t('export.json')}</button>
              <button onClick={() => { setExportOpen(false); void exportSQLite(); }}>{t('export.sqlite')}</button>
            </div>
          </div>
          <button id="btn-settings" className="btn ghost" title={t('title.settings')} onClick={() => setSettingsOpen(true)}>{t('btn.settings')}</button>
          <button id="btn-lang" className="btn ghost lang-btn" title="Language" onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')}>
            <span className={getLang() === 'zh' ? 'on' : ''}>ZH</span>
            <span className="lang-sep">/</span>
            <span className={getLang() === 'en' ? 'on' : ''}>EN</span>
          </button>
        </div>
      </header>

      {settings.mode === 'demo' && (
        <div className="demo-banner">
          <span className="demo-badge">{t('demo.bannerTitle')}</span>
          <span className="demo-text">{t('demo.banner')}</span>
          <span className="demo-tab">{t('demo.tabLabel', { id: tabLabel() })}</span>
          <button className="btn tiny" onClick={() => window.open(anotherTabUrl(), '_blank', 'noopener')}>{t('demo.openTab')}</button>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <div className="side-section">
            <div className="side-label">{t('nav.views')}</div>
            <nav className="nav">
              {VIEWS.map((v) => (
                <button key={v.id} className={`nav-item ${view === v.id ? 'active' : ''}`} onClick={() => setView(v.id)}>
                  <span className="ico">{v.icon}</span>{t(v.labelKey)}<span className="count">{counts[v.id]}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="side-section">
            <div className="side-label">{t('nav.categories')} {category && <button className="mini-clear" onClick={() => setCategory(null)}>{t('nav.clear')}</button>}</div>
            <div className="chip-list">
              {facets.cats.length ? facets.cats.map(([c, n]) => (
                <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(category === c ? null : c)}>
                  {c}<span className="n">{n}</span>
                </button>
              )) : <span className="empty-chips">{t('nav.noCategories')}</span>}
            </div>
          </div>

          <div className="side-section">
            <div className="side-label">{t('nav.tags')} {tag && <button className="mini-clear" onClick={() => setTag(null)}>{t('nav.clear')}</button>}</div>
            <div className="chip-list">
              {facets.tags.length ? facets.tags.map(([x, n]) => (
                <button key={x} className={`chip ${tag === x ? 'active' : ''}`} onClick={() => setTag(tag === x ? null : x)}>
                  #{x}<span className="n">{n}</span>
                </button>
              )) : <span className="empty-chips">{t('nav.noTags')}</span>}
            </div>
          </div>

          <div className="side-section sync-card">
            <div className="side-label">{t('nav.syncStatus')}</div>
            <div className="sync-status">
              <span className={`dot ${statusDot}`} /><span>{statusText}</span>
              {statusDetail && <span className="detail">{statusDetail}</span>}
            </div>
            <div className="mode-badge">{modeBadge}</div>
            <button className="btn tiny full" disabled={notifyPerm !== 'default'} onClick={() => void requestNotify()}>{notifyLabel}</button>
          </div>

          <div className="side-foot">{t('nav.footer')}</div>
        </aside>

        <main className="main">
          <div className="list-head">
            <div className="list-head-title">
              <h2>{t(VIEWS.find((v) => v.id === view)?.labelKey ?? 'view.all')}</h2>
              <span className="muted">{t('count.suffix', { n: filtered.length })}</span>
              {hasFilters && <button className="link-btn" onClick={clearFilters}>{t('clearFilters')}</button>}
            </div>
            <label className="sort-label muted">{t('sort.label')}
              <select value={sort} onChange={(e) => setSort(e.target.value as SortId)}>
                {SORTS.map((o) => <option key={o.id} value={o.id}>{t(o.labelKey)}</option>)}
              </select>
            </label>
          </div>

          <div className="list">
            {filtered.map((it) => (
              <Card key={it.id} item={it}
                onToggle={(x) => void toggleDone(x)}
                onEdit={(x) => setEditor({ item: x })}
                onDelete={(x) => { void deleteItem(x).then((ok) => { if (ok) setEditor(null); }); }}
                onCategory={(c) => setCategory(c)}
                onTag={(x) => setTag(x)}
              />
            ))}
          </div>

          {!filtered.length && !isLoading && (
            <div className="empty">
              {items.length === 0 ? (
                <>
                  <div className="big">📝</div>
                  <h3>{t('empty.title')}</h3>
                  <p>{t('empty.body')}</p>
                  <button className="btn primary" onClick={() => setEditor({ item: null })}>{t('btn.newShort')}</button>
                </>
              ) : (
                <>
                  <div className="big">🔍</div>
                  <h3>{t('empty.noMatchTitle')}</h3>
                  <p>{t('empty.noMatchBody')}</p>
                  <button className="btn" onClick={clearFilters}>{t('clearFilters')}</button>
                </>
              )}
            </div>
          )}
        </main>
      </div>

      {editor && (
        <Editor
          key={editor.item?.id ?? 'new'}
          item={editor.item}
          categories={facets.cats.map(([c]) => c)}
          onSave={(v) => void saveItem(v, editor.item)}
          onDelete={(it) => { void deleteItem(it).then((ok) => { if (ok) setEditor(null); }); }}
          onClose={() => setEditor(null)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onSave={handleSaveSettings}
          onCancel={() => setSettingsOpen(false)}
          onReset={() => void handleReset()}
          onResetDemo={() => void handleResetDemo()}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((x) => <div key={x.id} className={`toast ${x.type}`}>{x.msg}</div>)}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importJSON(f);
          e.target.value = '';
        }}
      />
    </>
  );
}
