/**
 * Minimal reference backend for `GenericHttpBackend`.
 *
 * Implements the whole contract with `node:http` + a directory on disk:
 *
 *   GET    /<key>              -> bytes + ETag (If-None-Match / Range)
 *   PUT    /<key>              -> If-Match / If-None-Match:* (CAS)
 *   HEAD   /<key>              -> ETag + Content-Length
 *   DELETE /<key>
 *   GET    /<prefix>?list=1    -> [{ key, etag, size }]
 *
 * Run:  ROOT=./sync-data PORT=8787 npx tsx examples/server.ts
 * Then point GenericHttpBackend at http://127.0.0.1:8787 .
 *
 * Put an auth gateway / S3 / R2 / Cloudflare Worker in front for production.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.env.ROOT ?? './sync-data');
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.TOKEN;

function safePath(urlPath: string): string {
  const key = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const p = resolve(join(ROOT, normalize(key)));
  if (p !== ROOT && !p.startsWith(ROOT + sep)) throw new Error('path escapes root');
  return p;
}

async function etagOf(p: string): Promise<string | null> {
  try {
    const s = await stat(p);
    if (!s.isFile()) return null;
    const hash = createHash('sha256').update(await readFile(p)).digest('hex');
    return `"${hash}"`;
  } catch {
    return null;
  }
}

async function walk(dir: string, out: { key: string; etag: string; size: number }[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile()) {
      const etag = await etagOf(full);
      if (etag) out.push({ key: relative(ROOT, full), etag, size: (await stat(full)).size });
    }
  }
}

function relative(root: string, p: string): string {
  return p.slice(root.length + 1).split(sep).join('/');
}

await mkdir(ROOT, { recursive: true });

createServer(async (req, res) => {
  try {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const p = safePath(url.pathname);
    const current = await etagOf(p);

    if (url.searchParams.has('list')) {
      const out: { key: string; etag: string; size: number }[] = [];
      await walk(p, out);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      return;
    }

    switch (req.method) {
      case 'GET': {
        if (!current) {
          res.writeHead(404).end();
          return;
        }
        if (req.headers['if-none-match'] === current) {
          res.writeHead(304).end();
          return;
        }
        const s = await stat(p);
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m?.[1] ? Number(m[1]) : 0;
          const end = m?.[2] ? Number(m[2]) : s.size - 1;
          res.writeHead(206, {
            ETag: current,
            'Content-Range': `bytes ${start}-${end}/${s.size}`,
            'Content-Length': end - start + 1,
          });
          createReadStream(p, { start, end }).pipe(res);
          return;
        }
        res.writeHead(200, { ETag: current, 'Content-Length': s.size });
        createReadStream(p).pipe(res);
        return;
      }
      case 'HEAD': {
        if (!current) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { ETag: current, 'Content-Length': (await stat(p)).size }).end();
        return;
      }
      case 'PUT': {
        if (req.headers['if-none-match'] === '*' && current) {
          res.writeHead(412).end();
          return;
        }
        if (req.headers['if-match'] && req.headers['if-match'] !== current) {
          res.writeHead(412).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, Buffer.concat(chunks));
        const e = await etagOf(p);
        res.writeHead(200, { ETag: e! }).end();
        return;
      }
      case 'DELETE': {
        if (!current) {
          res.writeHead(404).end();
          return;
        }
        await rm(p);
        res.writeHead(204).end();
        return;
      }
      default:
        res.writeHead(405).end();
    }
  } catch (e) {
    res.writeHead(400).end(String(e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`sync backend listening on http://127.0.0.1:${PORT} (root=${ROOT})`);
});
