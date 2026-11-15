/** Per-tab identity: each tab is a separate "device" for the sync demo. */
const TAB_KEY = 'srs.tabId';

function randomId(): string {
  const raw = globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

/**
 * `?tab=<id>` (used by the "open another tab" button) takes precedence so
 * two tabs can never accidentally share an id. Otherwise we use a stable
 * sessionStorage value that survives reloads of this tab but is not shared
 * with other tabs (unlike localStorage).
 */
export function getTabId(): string {
  const fromUrl = new URLSearchParams(location.search).get('tab');
  if (fromUrl) return `tab-${fromUrl.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`;
  let id = sessionStorage.getItem(TAB_KEY);
  if (!id) {
    id = `tab-${randomId()}`;
    sessionStorage.setItem(TAB_KEY, id);
  }
  return id;
}

/** Short label for the UI ("此标签页 / This tab"). */
export function tabLabel(): string {
  return getTabId().replace(/^tab-/, '').slice(0, 8);
}

/** URL for the "open a second device" button, with a fresh tab identity. */
export function anotherTabUrl(): string {
  const u = new URL(location.href);
  u.searchParams.set('tab', randomId());
  return u.href;
}
