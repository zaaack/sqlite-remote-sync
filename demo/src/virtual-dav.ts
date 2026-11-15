/**
 * Browser-internal WebDAV server for the GitHub Pages demo.
 *
 * `public/sw.js` is a service worker that implements WebDAV over IndexedDB.
 * IndexedDB (and the worker itself) are shared by every tab on this origin,
 * so two tabs really do talk to the same remote store through the library's
 * unmodified `WebDavBackend`. No server, no CORS, no COOP/COEP headers.
 */
import { getTabId } from './tab';

export const DEMO_APP_ID = 'todo-notes-demo';
export const DAV_CHANGE_EVENT = 'srs-dav-change';

/** Same-origin URL that the SW intercepts. Stable across all tabs. */
export function demoDavUrl(): string {
  return new URL('__dav__', document.baseURI).href;
}

/**
 * Register the worker and wait until this page is controlled. A page can only
 * be intercepted once a worker controls it; `clients.claim()` in the worker
 * makes that happen without a reload in the common case.
 */
export async function ensureVirtualDav(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Worker is not available in this browser');
  }
  const script = new URL('sw.js', document.baseURI).href;
  const scope = new URL('.', document.baseURI).href;
  await navigator.serviceWorker.register(script, { scope });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, 3000);
    navigator.serviceWorker.addEventListener('controllerchange', finish, { once: true });
  });
}

/** Extra headers so the SW can tag changes with the originating tab. */
export function demoDavHeaders(): Record<string, string> {
  return { 'X-Demo-Tab': getTabId() };
}

export interface DavChange {
  type: typeof DAV_CHANGE_EVENT;
  tabId: string;
  key: string;
}

/** Wipe the shared virtual-DAV store (settings "reset demo data"). */
export function clearVirtualDav(): Promise<void> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return Promise.resolve();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      ch.port1.close();
      resolve();
    };
    timer = setTimeout(finish, 1500);
    ch.port1.onmessage = finish;
    controller.postMessage({ type: 'srs-dav-clear', tabId: getTabId() }, [ch.port2]);
  });
}
