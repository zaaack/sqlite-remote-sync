/* eslint-disable */
/**
 * Virtual WebDAV server for the GitHub Pages demo.
 *
 * GitHub Pages cannot host a backend, so this service worker plays one: it
 * intercepts same-origin requests under `/__dav__/` and implements just enough
 * WebDAV for `WebDavBackend` (GET/PUT/HEAD/DELETE/MKCOL/PROPFIND, 207
 * Multi-Status, ETag + If-Match/If-None-Match, Range). Files live in
 * IndexedDB, which is shared by every tab on this origin, so two tabs behave
 * like two real devices talking to the same WebDAV server.
 *
 * This is a standalone classic script (not bundled) on purpose: a service
 * worker must be served as a separate file from the site's own origin.
 */

const DB_NAME = 'srs-virtual-dav';
const STORE = 'files';
const MARKER = '/__dav__';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function requestP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Content-derived ETag: stable across reads, changes whenever bytes change. */
function etagFor(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return '"' + h.toString(16) + '-' + bytes.length.toString(16) + '"';
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Split a request URL into the DAV base path and the (decoded) object key. */
function parseRequest(url) {
  const pathname = url.pathname;
  const idx = pathname.indexOf(MARKER);
  if (idx < 0) return null;
  const basePath = pathname.slice(0, idx + MARKER.length) + '/';
  const raw = pathname.slice(idx + MARKER.length);
  let key;
  try {
    key = decodeURIComponent(raw.replace(/^\/+/, '').replace(/\/+$/, ''));
  } catch {
    key = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  }
  return { basePath, key, origin: url.origin };
}

async function getEntry(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const r = t.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function doRead(key, req, headOnly) {
  const entry = await getEntry(key);
  if (!entry || entry.type !== 'file') return new Response(null, { status: 404 });
  const data = entry.data;
  const ifNoneMatch = req.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    return new Response(null, { status: 304, headers: { ETag: entry.etag } });
  }
  const h = new Headers({
    ETag: entry.etag,
    'Content-Type': entry.contentType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  });
  if (headOnly) {
    h.set('Content-Length', String(data.length));
    return new Response(null, { status: 200, headers: h });
  }
  const range = req.headers.get('Range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start;
      let end;
      if (m[1] === '') {
        start = Math.max(0, data.length - Number(m[2]));
        end = data.length - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
      }
      if (start >= data.length || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${data.length}` } });
      }
      const slice = data.slice(start, end + 1);
      h.set('Content-Range', `bytes ${start}-${end}/${data.length}`);
      h.set('Content-Length', String(slice.length));
      return new Response(slice, { status: 206, headers: h });
    }
  }
  h.set('Content-Length', String(data.length));
  return new Response(data, { status: 200, headers: h });
}

/** Create all ancestor collections of `key` inside an open readwrite store. */
function ensureDirs(store, key) {
  const parts = key.split('/');
  parts.pop();
  let path = '';
  for (const part of parts) {
    path = path ? path + '/' + part : part;
    const g = store.get(path);
    g.onsuccess = () => {
      if (!g.result) store.put({ type: 'dir' }, path);
    };
  }
}

/** CAS-guarded PUT. The check and the write share one IDB transaction. */
async function doPut(key, req) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  const ifMatch = req.headers.get('If-Match');
  const ifNoneMatch = req.headers.get('If-None-Match');
  const contentType = req.headers.get('Content-Type') || 'application/octet-stream';
  const db = await openDB();
  return new Promise((resolve) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    let outcome = null;
    const g = store.get(key);
    g.onsuccess = () => {
      const cur = g.result || null;
      const conflict =
        (ifMatch !== null && (!cur || cur.type !== 'file' || cur.etag !== ifMatch)) ||
        (ifNoneMatch === '*' && !!cur);
      if (conflict) {
        outcome = { status: 412 };
        try { t.abort(); } catch { /* already settling */ }
        return;
      }
      ensureDirs(store, key);
      const etag = etagFor(bytes);
      store.put(
        { type: 'file', data: bytes, etag, size: bytes.length, contentType },
        key,
      );
      outcome = { status: cur ? 200 : 201, etag };
    };
    t.oncomplete = () => resolve(outcome || { status: 201 });
    t.onabort = () => resolve(outcome || { status: 412 });
    t.onerror = () => resolve({ status: 500 });
  });
}

async function doDelete(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const g = store.get(key);
    g.onsuccess = () => {
      if (!g.result) return;
      store.delete(key);
      if (g.result.type === 'dir') {
        const kr = store.getAllKeys();
        kr.onsuccess = () => {
          for (const k of kr.result) if (k.startsWith(key + '/')) store.delete(k);
        };
      }
    };
    t.oncomplete = () => resolve(204);
    t.onerror = () => resolve(500);
    t.onabort = () => resolve(500);
  });
}

async function doMkcol(key) {
  if (!key) return 405;
  const db = await openDB();
  return new Promise((resolve) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const g = store.get(key);
    g.onsuccess = () => {
      if (!g.result) store.put({ type: 'dir' }, key);
    };
    t.oncomplete = () => resolve(201);
    t.onerror = () => resolve(500);
    t.onabort = () => resolve(500);
  });
}

function propfindXml(p, dir, children) {
  const hrefFor = (k, isDir) => {
    const segs = k ? k.split('/').map(encodeURIComponent).join('/') : '';
    return p.origin + p.basePath + segs + (isDir ? '/' : '');
  };
  let body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<d:multistatus xmlns:d="DAV:">';
  const add = (k, isDir, entry) => {
    body +=
      '<d:response><d:href>' + escapeXml(hrefFor(k, isDir)) + '</d:href>' +
      '<d:propstat><d:prop>';
    if (isDir) {
      body += '<d:resourcetype><d:collection/></d:resourcetype>';
    } else {
      body +=
        '<d:resourcetype/>' +
        (entry && entry.etag ? '<d:getetag>' + escapeXml(entry.etag) + '</d:getetag>' : '') +
        '<d:getcontentlength>' + (entry ? entry.size || 0 : 0) + '</d:getcontentlength>';
    }
    body += '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  };
  // The requested collection itself; the backend skips it while recursing.
  if (dir) add(dir, true, null);
  for (const [k, entry] of children) add(k, entry.type === 'dir', entry);
  body += '</d:multistatus>';
  return new Response(body, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

async function doPropfind(p, dir) {
  const db = await openDB();
  const entries = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const store = t.objectStore(STORE);
    const kr = store.getAllKeys();
    const vr = store.getAll();
    t.oncomplete = () => {
      const keys = kr.result || [];
      const values = vr.result || [];
      resolve(keys.map((k, i) => [k, values[i]]));
    };
    t.onerror = () => reject(t.error);
  });
  const prefix = dir ? dir + '/' : '';
  const map = new Map(entries);
  const exists = !dir || entries.some(([k]) => k === dir || k.startsWith(prefix));
  if (!exists) return new Response(null, { status: 404 });
  const children = new Map();
  for (const [k, v] of entries) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    const childKey = prefix + (slash === -1 ? rest : rest.slice(0, slash));
    if (!children.has(childKey)) {
      children.set(childKey, map.get(childKey) || { type: slash === -1 ? 'file' : 'dir' });
    }
  }
  return propfindXml(p, dir, children);
}

async function broadcastChange(tabId, key) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'srs-dav-change', tabId, key });
  } catch { /* best effort: auto-sync is the fallback */ }
}

async function handleDav(event, p) {
  try {
    const req = event.request;
    const method = req.method.toUpperCase();
    const tabId = req.headers.get('X-Demo-Tab') || '';
    switch (method) {
      case 'GET':
        return await doRead(p.key, req, false);
      case 'HEAD':
        return await doRead(p.key, req, true);
      case 'PUT': {
        const r = await doPut(p.key, req);
        const resp = new Response(null, {
          status: r.status,
          headers: r.etag ? { ETag: r.etag } : {},
        });
        if (r.status < 300 && (p.key.includes('/segments/') || p.key.includes('/snapshots/'))) {
          await broadcastChange(tabId, p.key);
        }
        return resp;
      }
      case 'DELETE':
        return new Response(null, { status: await doDelete(p.key) });
      case 'MKCOL':
        return new Response(null, { status: await doMkcol(p.key) });
      case 'PROPFIND':
        return await doPropfind(p, p.key);
      case 'OPTIONS':
        return new Response(null, {
          status: 204,
          headers: { Allow: 'GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, OPTIONS', DAV: '1,2' },
        });
      default:
        return new Response(null, { status: 405 });
    }
  } catch (e) {
    return new Response(String((e && e.message) || e), { status: 500 });
  }
}

self.addEventListener('fetch', (event) => {
  let p;
  try {
    p = parseRequest(new URL(event.request.url));
  } catch {
    return;
  }
  if (!p) return; // not a virtual-DAV request: let the network handle it
  event.respondWith(handleDav(event, p));
});

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'srs-dav-clear') return;
  event.waitUntil(
    (async () => {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).clear();
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
      if (event.ports[0]) event.ports[0].postMessage({ ok: true });
      // Tell the other tabs to drop their local copies too.
      const tabId = event.data.tabId || '';
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) c.postMessage({ type: 'srs-dav-cleared', tabId });
    })(),
  );
});
