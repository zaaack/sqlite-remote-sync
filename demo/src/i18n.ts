import { useSyncExternalStore } from 'react';

export type Lang = 'zh' | 'en';

/** All UI strings. `en` is type-checked against the `zh` key set. */
const zh = {
  'app.title': 'Sync Notes · Todo / 笔记 · WebDAV 同步',
  'app.description': 'Todo / 笔记 demo：分类与标签、提醒、WebDAV 同步、导入导出。基于 sqlite-remote-sync + React + Kysely (SQLite WASM)。',
  'app.subtitle': 'Todo · 笔记 · WebDAV 同步',
  'app.logo': '记',
  'app.demoTag': 'demo',

  'view.all': '全部',
  'view.todo': '待办',
  'view.note': '笔记',
  'view.done': '已完成',

  'sort.label': '排序',
  'sort.created': '创建时间',
  'sort.due': '截止时间',
  'sort.updated': '最近更新',
  'sort.title': '标题',

  'nav.views': '视图',
  'nav.categories': '分类',
  'nav.tags': '标签',
  'nav.syncStatus': '同步状态',
  'nav.clear': '清除',
  'nav.noCategories': '暂无分类',
  'nav.noTags': '暂无标签',
  'nav.footer': '基于 sqlite-remote-sync 的 GitHub Pages 演示 · React + Kysely (SQLite WASM) · 数据自动刷新',
  'count.suffix': '{n} 项',
  'clearFilters': '清除筛选',

  'btn.new': '＋ 新建',
  'btn.newShort': '＋ 新建一条',
  'btn.sync': '⟳ 同步',
  'btn.syncing': '⟳ 同步中…',
  'btn.import': '导入',
  'btn.export': '导出 ▾',
  'btn.settings': '⚙',
  'btn.save': '保存',
  'btn.cancel': '取消',
  'btn.delete': '删除',
  'btn.close': '关闭',
  'btn.saveConnect': '保存并连接',
  'btn.resetLocal': '清空本地数据并重载',
  'btn.resetDemo': '清空演示服务数据并重载',
  'btn.openSecondTab': '打开第二个标签页',
  'btn.desktopEnable': '🔔 启用桌面提醒',
  'btn.desktopOn': '🔔 桌面提醒已启用',
  'btn.desktopDenied': '🔔 通知权限被拒绝',
  'btn.desktopUnsupported': '🔔 不支持桌面通知',
  'title.syncNow': '立即与 WebDAV 同步',
  'title.importJson': '导入 JSON 备份',
  'title.settings': '设置',
  'export.json': '导出 JSON（可再导入）',
  'export.sqlite': '导出 SQLite 文件 (.sqlite)',
  'search.placeholder': '搜索标题 / 内容 / 标签…',

  'kind.todo': '待办',
  'kind.note': '笔记',

  'card.toggle': '切换完成',
  'card.edit': '编辑',
  'card.delete': '删除',
  'card.overdue': '⏰ 已逾期',
  'card.soon': '⏳ 即将',
  'card.due': '🕒 截止',
  'card.updated': '更新 {time}',
  'card.notified': '已提醒',

  'remind.none': '不提醒',
  'remind.onTime': '准时',
  'remind.m5': '提前 5 分钟',
  'remind.m15': '提前 15 分钟',
  'remind.h1': '提前 1 小时',
  'remind.d1': '提前 1 天',
  'remind.short.m5': '提前5分',
  'remind.short.m15': '提前15分',
  'remind.short.h1': '提前1时',
  'remind.short.d1': '提前1天',
  'remind.generic': '提醒',
  'remind.desktopFallback': '你有一条待办到期了',
  'remind.duePrefix': '截止 {time}',
  'remind.todoReminder': '待办提醒',
  'remind.toastPrefix': '⏰ 提醒：{title}',
  'remind.hint': '提醒在页面打开时生效；授予「桌面通知」权限后会弹出系统通知。',

  'editor.edit': '编辑',
  'editor.new': '新建',
  'editor.todo': '✓ 待办',
  'editor.note': '▤ 笔记',
  'editor.title': '标题',
  'editor.titlePlaceholder': '要做什么…',
  'editor.body': '内容 / 备注',
  'editor.bodyPlaceholder': '补充说明（可选）',
  'editor.category': '分类',
  'editor.categoryPlaceholder': '如：工作 / 生活',
  'editor.tags': '标签（逗号分隔）',
  'editor.tagsPlaceholder': '如：灵感, 重要',
  'editor.due': '截止时间',
  'editor.remind': '提醒',

  'settings.title': '设置 · WebDAV 同步',
  'settings.intro': '本 demo 使用 sqlite-remote-sync 的 WebDavBackend + createSyncEngine 做双向逐字段 LWW 同步；界面通过 sqlite-remote-sync/react 的 useQuery 自动刷新，增删改查直接走 Kysely。',
  'settings.demoInfo': '演示模式：WebDAV 服务由浏览器内的 Service Worker 模拟，数据存在 IndexedDB，同源的所有标签页共享。打开第二个标签页即可看到实时同步，无需任何服务器。',
  'settings.corsTitle': '浏览器跨域 (CORS) 提示：',
  'settings.corsBody': '页面运行在 GitHub Pages 上，WebDAV 服务是另一个域。服务端需允许 GET, PUT, DELETE, HEAD, PROPFIND, MKCOL，允许 Authorization, Depth, If-Match, If-None-Match, Content-Type 请求头，并暴露 ETag。不配置也能离线完整使用本 demo。',
  'settings.modeLabel': '同步模式',
  'settings.modeDemo': '演示模式（内置 WebDAV）',
  'settings.modeDemoHint': '无需配置，多标签页实时同步',
  'settings.modeCustom': '自定义 WebDAV',
  'settings.modeCustomHint': '连接真实网盘 / 自建服务',
  'settings.modeLocal': '仅本地（离线）',
  'settings.modeLocalHint': '不连接任何远端',
  'settings.url': 'WebDAV 地址',
  'settings.urlPlaceholder': 'https://dav.example.com/remote.php/dav/files/me/',
  'settings.username': '用户名',
  'settings.optional': '可选',
  'settings.password': '应用密码 / 密码',
  'settings.passwordPlaceholder': '建议使用应用专用密码',
  'settings.token': 'Bearer Token（可选，填写后覆盖上面的基础认证）',
  'settings.appId': '命名空间 (appId)',
  'settings.appIdHint': '多设备保持一致才会互相同步；不同命名空间互不影响。',
  'settings.autoSync': '自动同步',
  'settings.interval': '间隔（秒）',
  'settings.credentialsHint': '凭据仅保存在本浏览器 localStorage，请只在自己的设备上使用。',
  'settings.danger': '危险操作',
  'settings.resetLocalHint': '删除本标签页的 SQLite 文件（不会影响远端 WebDAV 数据）。',
  'settings.badUrl': 'WebDAV 地址格式不正确',

  'sync.syncing': '正在同步…',
  'sync.error': '同步出错',
  'sync.offline': '未连接 · 本地模式',
  'sync.syncedAt': '已同步 · {time}',
  'sync.connected': '已连接 · 等待同步',
  'sync.demoBadge': '演示 WebDAV',
  'sync.customBadge': '自定义 WebDAV',
  'sync.localBadge': '仅本地',

  'toast.noWebdav': '请先在「设置」中选择同步模式',
  'toast.syncDone': '同步完成：上传 {up} 条，下载应用 {down} 条',
  'toast.syncFailed': '同步失败：{msg}',
  'toast.configSaved': '已保存配置，正在同步…',
  'toast.switchedLocal': '已切换为本地（离线）模式',
  'toast.switchedDemo': '已切换到演示模式，正在同步…',
  'toast.configFailed': '配置失败：{msg}',
  'toast.queryFailed': '查询失败：{msg}',
  'toast.autoSyncError': '自动同步出错：{msg}',
  'toast.notifyUnsupported': '当前浏览器不支持桌面通知',
  'toast.notifyGranted': '桌面提醒已启用 ✅',
  'toast.notifyDenied': '未授予权限（仍会有页面内提醒）',
  'toast.notifyError': '无法请求通知权限：{msg}',
  'toast.exportedJson': '已导出 {n} 条 (JSON)',
  'toast.exportedSqlite': '已导出 SQLite 数据库文件 (.sqlite)',
  'toast.imported': '已导入 {n} 条；点「⟳ 同步」可上传到 WebDAV',
  'toast.importFailed': '导入失败：{msg}',
  'toast.missingItems': '缺少 items 数组',
  'toast.remotelySynced': '已从其他标签页同步 {n} 条',
  'toast.deleteConfirm': '确定删除「{title}」？删除会通过同步传播到其他设备。',
  'toast.resetConfirm': '确定清空本标签页的本地数据并重载？远端 WebDAV 数据不会被删除。',
  'toast.resetDemoConfirm': '确定清空演示服务的数据并重载？所有标签页的演示数据都会被清除。',

  'empty.title': '还没有内容',
  'empty.body': '点右上角「＋ 新建」创建待办或笔记。数据存于本地 SQLite，可在「设置」里选择同步模式。',
  'empty.noMatchTitle': '没有匹配的内容',
  'empty.noMatchBody': '试试清除筛选条件或换个关键词。',

  'fatal.title': '启动失败',
  'fatal.body': '请通过 HTTP(S) 访问（GitHub Pages 或本地静态服务器），不要用 file:// 直接打开。',

  'demo.bannerTitle': '演示模式',
  'demo.banner': 'WebDAV 服务由浏览器内的 Service Worker 模拟，同源标签页共享数据。再开一个标签页，任意改动都会自动同步过去。',
  'demo.tabLabel': '此标签页 {id}',
  'demo.openTab': '打开第二个标签页',
} as const;

export type TKey = keyof typeof zh;

const en: Record<TKey, string> = {
  'app.title': 'Sync Notes · Todo / Notes · WebDAV sync',
  'app.description': 'Todo / Notes demo: categories, tags, reminders, WebDAV sync, import/export. Built on sqlite-remote-sync + React + Kysely (SQLite WASM).',
  'app.subtitle': 'Todo · Notes · WebDAV sync',
  'app.logo': 'N',
  'app.demoTag': 'demo',

  'view.all': 'All',
  'view.todo': 'Todos',
  'view.note': 'Notes',
  'view.done': 'Done',

  'sort.label': 'Sort',
  'sort.created': 'Created',
  'sort.due': 'Due date',
  'sort.updated': 'Updated',
  'sort.title': 'Title',

  'nav.views': 'Views',
  'nav.categories': 'Categories',
  'nav.tags': 'Tags',
  'nav.syncStatus': 'Sync status',
  'nav.clear': 'Clear',
  'nav.noCategories': 'No categories',
  'nav.noTags': 'No tags',
  'nav.footer': 'A GitHub Pages demo built on sqlite-remote-sync · React + Kysely (SQLite WASM) · auto-refreshing queries',
  'count.suffix': '{n} items',
  'clearFilters': 'Clear filters',

  'btn.new': '＋ New',
  'btn.newShort': '＋ New item',
  'btn.sync': '↻ Sync',
  'btn.syncing': '↻ Syncing…',
  'btn.import': 'Import',
  'btn.export': 'Export ▾',
  'btn.settings': '⚙',
  'btn.save': 'Save',
  'btn.cancel': 'Cancel',
  'btn.delete': 'Delete',
  'btn.close': 'Close',
  'btn.saveConnect': 'Save & connect',
  'btn.resetLocal': 'Clear local data & reload',
  'btn.resetDemo': 'Clear demo server data & reload',
  'btn.openSecondTab': 'Open a second tab',
  'btn.desktopEnable': '🔔 Enable desktop reminders',
  'btn.desktopOn': '🔔 Desktop reminders on',
  'btn.desktopDenied': '🔔 Notifications blocked',
  'btn.desktopUnsupported': '🔔 Notifications unsupported',
  'title.syncNow': 'Sync with WebDAV now',
  'title.importJson': 'Import a JSON backup',
  'title.settings': 'Settings',
  'export.json': 'Export JSON (re-importable)',
  'export.sqlite': 'Export SQLite file (.sqlite)',
  'search.placeholder': 'Search title / body / tags…',

  'kind.todo': 'Todo',
  'kind.note': 'Note',

  'card.toggle': 'Toggle done',
  'card.edit': 'Edit',
  'card.delete': 'Delete',
  'card.overdue': '⏰ Overdue',
  'card.soon': '⏳ Soon',
  'card.due': '🕒 Due',
  'card.updated': 'Updated {time}',
  'card.notified': 'Notified',

  'remind.none': 'No reminder',
  'remind.onTime': 'On time',
  'remind.m5': '5 min before',
  'remind.m15': '15 min before',
  'remind.h1': '1 hour before',
  'remind.d1': '1 day before',
  'remind.short.m5': '5m before',
  'remind.short.m15': '15m before',
  'remind.short.h1': '1h before',
  'remind.short.d1': '1d before',
  'remind.generic': 'Reminder',
  'remind.desktopFallback': 'You have a todo due',
  'remind.duePrefix': 'Due {time}',
  'remind.todoReminder': 'Todo reminder',
  'remind.toastPrefix': '⏰ Reminder: {title}',
  'remind.hint': 'Reminders fire while the page is open; grant desktop notifications to also get system popups.',

  'editor.edit': 'Edit',
  'editor.new': 'New',
  'editor.todo': '✓ Todo',
  'editor.note': '▤ Note',
  'editor.title': 'Title',
  'editor.titlePlaceholder': 'What needs doing…',
  'editor.body': 'Body / notes',
  'editor.bodyPlaceholder': 'Extra details (optional)',
  'editor.category': 'Category',
  'editor.categoryPlaceholder': 'e.g. Work / Life',
  'editor.tags': 'Tags (comma separated)',
  'editor.tagsPlaceholder': 'e.g. idea, important',
  'editor.due': 'Due at',
  'editor.remind': 'Reminder',

  'settings.title': 'Settings · WebDAV sync',
  'settings.intro': 'This demo uses sqlite-remote-sync with WebDavBackend + createSyncEngine for bidirectional per-column LWW sync. The UI auto-refreshes through useQuery from sqlite-remote-sync/react, and all CRUD goes straight through Kysely.',
  'settings.demoInfo': 'Demo mode: the WebDAV server is simulated by a Service Worker inside the browser, backed by IndexedDB and shared by every tab on this origin. Open a second tab to see live sync — no server needed.',
  'settings.corsTitle': 'Browser CORS note:',
  'settings.corsBody': 'This page runs on GitHub Pages while a real WebDAV server lives on another origin. The server must allow GET, PUT, DELETE, HEAD, PROPFIND, MKCOL, allow the Authorization, Depth, If-Match, If-None-Match and Content-Type headers, and expose ETag. The demo also works fully offline without any config.',
  'settings.modeLabel': 'Sync mode',
  'settings.modeDemo': 'Demo mode (built-in WebDAV)',
  'settings.modeDemoHint': 'No setup, live sync across tabs',
  'settings.modeCustom': 'Custom WebDAV',
  'settings.modeCustomHint': 'Connect a real cloud drive / server',
  'settings.modeLocal': 'Local only (offline)',
  'settings.modeLocalHint': 'No remote connection',
  'settings.url': 'WebDAV URL',
  'settings.urlPlaceholder': 'https://dav.example.com/remote.php/dav/files/me/',
  'settings.username': 'Username',
  'settings.optional': 'Optional',
  'settings.password': 'App password / password',
  'settings.passwordPlaceholder': 'Use an app-specific password',
  'settings.token': 'Bearer Token (optional, overrides basic auth above)',
  'settings.appId': 'Namespace (appId)',
  'settings.appIdHint': 'Devices must use the same namespace to sync; different namespaces are isolated.',
  'settings.autoSync': 'Auto sync',
  'settings.interval': 'Interval (sec)',
  'settings.credentialsHint': 'Credentials are stored only in this browser\'s localStorage. Use this on your own devices only.',
  'settings.danger': 'Danger zone',
  'settings.resetLocalHint': 'Deletes this tab\'s SQLite file (does not touch remote WebDAV data).',
  'settings.badUrl': 'Invalid WebDAV URL',

  'sync.syncing': 'Syncing…',
  'sync.error': 'Sync error',
  'sync.offline': 'Offline · local mode',
  'sync.syncedAt': 'Synced · {time}',
  'sync.connected': 'Connected · waiting',
  'sync.demoBadge': 'Demo WebDAV',
  'sync.customBadge': 'Custom WebDAV',
  'sync.localBadge': 'Local only',

  'toast.noWebdav': 'Choose a sync mode in Settings first',
  'toast.syncDone': 'Sync complete: {up} up, {down} applied',
  'toast.syncFailed': 'Sync failed: {msg}',
  'toast.configSaved': 'Settings saved, syncing…',
  'toast.switchedLocal': 'Switched to local (offline) mode',
  'toast.switchedDemo': 'Switched to demo mode, syncing…',
  'toast.configFailed': 'Configuration failed: {msg}',
  'toast.queryFailed': 'Query failed: {msg}',
  'toast.autoSyncError': 'Auto sync error: {msg}',
  'toast.notifyUnsupported': 'Desktop notifications are not supported here',
  'toast.notifyGranted': 'Desktop reminders enabled ✅',
  'toast.notifyDenied': 'Permission denied (in-app reminders still work)',
  'toast.notifyError': 'Could not request notification permission: {msg}',
  'toast.exportedJson': 'Exported {n} items (JSON)',
  'toast.exportedSqlite': 'Exported SQLite database file (.sqlite)',
  'toast.imported': 'Imported {n} items; click "↻ Sync" to upload',
  'toast.importFailed': 'Import failed: {msg}',
  'toast.missingItems': 'Missing items array',
  'toast.remotelySynced': 'Synced {n} changes from another tab',
  'toast.deleteConfirm': 'Delete "{title}"? The deletion will propagate to other devices.',
  'toast.resetConfirm': 'Clear this tab\'s local data and reload? Remote WebDAV data is not deleted.',
  'toast.resetDemoConfirm': 'Clear the demo server data and reload? Demo data in every tab will be removed.',

  'empty.title': 'Nothing here yet',
  'empty.body': 'Click "＋ New" to create a todo or note. Data lives in local SQLite; pick a sync mode in Settings.',
  'empty.noMatchTitle': 'No matches',
  'empty.noMatchBody': 'Try clearing filters or changing the keyword.',

  'fatal.title': 'Startup failed',
  'fatal.body': 'Open this page over HTTP(S) (GitHub Pages or a local static server), not via file://.',

  'demo.bannerTitle': 'Demo mode',
  'demo.banner': 'The WebDAV server is simulated by a Service Worker inside the browser and shared by all tabs on this origin. Open a second tab — any edit syncs over automatically.',
  'demo.tabLabel': 'This tab {id}',
  'demo.openTab': 'Open a second tab',
};

const LANG_KEY = 'srs.lang';

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* ignore */ }
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
}

let lang: Lang = detectLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
  applyDocumentLang();
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Subscribe a component to language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export function t(key: TKey, vars?: Record<string, string | number>): string {
  let s: string = (lang === 'zh' ? zh : en)[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

function applyDocumentLang(): void {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app.title');
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', t('app.description'));
}
applyDocumentLang();

// Language is a browser-wide preference: mirror switches into other tabs.
window.addEventListener('storage', (e) => {
  if (e.key !== LANG_KEY) return;
  const next: Lang = e.newValue === 'zh' || e.newValue === 'en' ? e.newValue : detectLang();
  if (next === lang) return;
  lang = next;
  applyDocumentLang();
  for (const fn of listeners) fn();
});

export interface SeedItem {
  id: string;
  kind: 'todo' | 'note';
  title: string;
  body: string;
  category: string;
  tags: string[];
}

export const SEED_ITEMS: Record<Lang, SeedItem[]> = {
  zh: [
    {
      id: 'seed-welcome',
      kind: 'todo',
      title: '试试点左边的方框标记完成',
      body: '这是一条待办示例。可以设「截止时间」并开启提醒。',
      category: '示例',
      tags: ['demo', '上手'],
    },
    {
      id: 'seed-about',
      kind: 'note',
      title: '关于这个 Demo',
      body:
        '数据存在浏览器里的 SQLite (WASM)，由 Kysely + kysely-wasm 读写。\n' +
        '默认「演示模式」用 Service Worker 模拟 WebDAV，多个标签页会自动互相同步。\n' +
        '列表通过 useQuery 自动刷新，写入直接走 Kysely，无需手动 render。',
      category: '示例',
      tags: ['demo', '说明'],
    },
    {
      id: 'seed-remind',
      kind: 'todo',
      title: '给这条待办设个提醒试试',
      body: '编辑它，填一个「截止时间」并选「提前 5 分钟」，授予桌面通知后到期会弹提醒。',
      category: '示例',
      tags: ['demo', '提醒'],
    },
  ],
  en: [
    {
      id: 'seed-welcome',
      kind: 'todo',
      title: 'Try ticking the checkbox to complete me',
      body: 'A sample todo. You can set a due date and turn on a reminder.',
      category: 'Sample',
      tags: ['demo', 'start'],
    },
    {
      id: 'seed-about',
      kind: 'note',
      title: 'About this demo',
      body:
        'Data lives in a SQLite (WASM) database in the browser, read and written with Kysely + kysely-wasm.\n' +
        'The default "Demo mode" simulates WebDAV in a Service Worker, so multiple tabs sync with each other.\n' +
        'The list auto-refreshes through useQuery; all writes go straight through Kysely.',
      category: 'Sample',
      tags: ['demo', 'about'],
    },
    {
      id: 'seed-remind',
      kind: 'todo',
      title: 'Give this todo a reminder',
      body: 'Edit it, set a due date and choose "5 min before"; grant desktop notifications to get a popup.',
      category: 'Sample',
      tags: ['demo', 'reminder'],
    },
  ],
};
