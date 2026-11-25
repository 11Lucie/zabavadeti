#!/usr/bin/env node
// Local preview server for dist/ – no dependencies.
//
//   node scripts/serve.mjs            (http://127.0.0.1:8787)
//   PORT=9000 node scripts/serve.mjs
//
// * listens only on 127.0.0.1 and accepts only Host 127.0.0.1/localhost
//   (protection against DNS rebinding),
// * applies dist/_headers like Cloudflare Pages does (wildcards, :splat,
//   placeholders, detaching with "! Name", merging of repeated headers),
// * refuses path traversal (.., encoded ..), NUL bytes, backslashes,
//   Windows device names and symlinks pointing outside dist/,
// * only GET and HEAD; /api/* answers 501 (Pages Functions are not emulated).

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WINDOWS_DEVICE_RE } from './check.mjs';

export const DEFAULT_PORT = 8787;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// _headers parsing and matching (Cloudflare Pages semantics)
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Converts a URL pattern part to a regex source. `*` = splat (greedy),
// `:name` = placeholder that does not cross `stop` characters.
function patternToRe(part, stop, names) {
  let re = '';
  for (let i = 0; i < part.length; ) {
    const ch = part[i];
    if (ch === '*') {
      re += '(.*)';
      names.push('splat');
      i++;
    } else if (ch === ':' && /[A-Za-z]/.test(part[i + 1] ?? '')) {
      let j = i + 1;
      while (j < part.length && /[A-Za-z0-9_]/.test(part[j])) j++;
      names.push(part.slice(i + 1, j));
      re += `([^${escapeRe(stop)}]+)`;
      i = j;
    } else {
      re += escapeRe(ch);
      i++;
    }
  }
  return re;
}

export function compilePattern(pattern) {
  const names = [];
  const m = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(pattern);
  if (m) {
    const hostRe = patternToRe(m[1], './', names);
    const pathRe = patternToRe(m[2] ?? '/', '/', names);
    return { absolute: true, re: new RegExp(`^${hostRe}${pathRe}$`, 'i'), names };
  }
  return { absolute: false, re: new RegExp(`^${patternToRe(pattern, '/', names)}$`), names };
}

export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((rawLine, idx) => {
    const lineText = rawLine.trimEnd(); // linear; /\s+$/ backtracks quadratically on long blank runs
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (!/^\s/.test(lineText)) {
      current = { pattern: trimmed, detach: [], set: [], ...compilePattern(trimmed) };
      rules.push(current);
      return;
    }
    if (!current) throw new Error(`_headers, řádek ${idx + 1}: hlavička bez pravidla (URL) nad ní.`);
    if (trimmed.startsWith('!')) {
      current.detach.push(trimmed.slice(1).trim().toLowerCase());
      return;
    }
    const colon = trimmed.indexOf(':');
    if (colon <= 0) throw new Error(`_headers, řádek ${idx + 1}: chybí dvojtečka v „${trimmed}“.`);
    current.set.push({ name: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() });
  });
  return rules;
}

// Returns a Map(lowercase name -> { name, value }) of headers for a request.
export function headersFor(rules, pathname, host = '') {
  const out = new Map();
  for (const rule of rules) {
    const subject = rule.absolute ? `${host}${pathname}` : pathname;
    const m = rule.re.exec(subject);
    if (!m) continue;
    const params = {};
    rule.names.forEach((n, i) => {
      params[n] = m[i + 1];
    });
    // Cloudflare applies a rule's "! Name" removals before its own values.
    for (const name of rule.detach) out.delete(name);
    for (const { name, value } of rule.set) {
      const v = value.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (all, n) => (n in params ? params[n] : all));
      const key = name.toLowerCase();
      const existing = out.get(key);
      if (existing) existing.value = `${existing.value}, ${v}`;
      else out.set(key, { name, value: v });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Safe path resolution
// ---------------------------------------------------------------------------

// Shared with the upload check (scripts/check.mjs), so both lists stay the same.
const WINDOWS_DEVICE = WINDOWS_DEVICE_RE;

// Validates the raw request target. Returns { ok: true, path } with the
// decoded path, or { ok: false, status, reason }.
export function parseRequestPath(rawUrl) {
  const bad = (status, reason) => ({ ok: false, status, reason });
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return bad(400, 'Neplatná adresa.');
  if (rawUrl.length > 2048) return bad(414, 'Adresa je příliš dlouhá.');
  const pathPart = rawUrl.split('?')[0].split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return bad(400, 'Neplatné kódování adresy.');
  }
  // Decode once more to catch double-encoded traversal (%252e%252e).
  let twice = decoded;
  try {
    twice = decodeURIComponent(decoded);
  } catch {
    /* not double-encoded */
  }
  for (const candidate of [decoded, twice]) {
    if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return bad(400, 'Adresa obsahuje nepovolené znaky.');
    if (candidate.includes(':')) return bad(400, 'Adresa obsahuje nepovolené znaky.');
    const segments = candidate.split('/').slice(1);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s === '.' || s === '..') return bad(400, 'Cesta mimo web není povolená.');
      if (s === '' && i !== segments.length - 1) return bad(400, 'Neplatná adresa.');
      if (/[. ]$/.test(s)) return bad(400, 'Neplatná adresa.');
      if (WINDOWS_DEVICE.test(s)) return bad(400, 'Neplatná adresa.');
      if (s.startsWith('.') && s !== '.well-known') return bad(404, 'Nenalezeno.');
    }
  }
  return { ok: true, path: decoded };
}

function isInside(base, target) {
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

// Maps a validated URL path to a file inside distDir.
// Returns { file } | { redirect } | null.
export async function resolveFile(distDir, urlPath) {
  const base = resolve(distDir);
  const realBase = await realpath(base);
  const check = async (target) => {
    if (!isInside(base, target)) return null;
    let st;
    try {
      st = await stat(target);
    } catch {
      return null;
    }
    const real = await realpath(target);
    if (!isInside(realBase, real)) return null; // symlink escaping dist/
    return st;
  };

  const target = resolve(base, `.${urlPath}`);
  if (!isInside(base, target)) return null;

  if (urlPath.endsWith('/')) {
    const index = join(target, 'index.html');
    const st = await check(index);
    return st?.isFile() ? { file: index } : null;
  }
  const st = await check(target);
  if (st?.isFile()) return { file: target };
  if (st?.isDirectory()) {
    const st2 = await check(join(target, 'index.html'));
    return st2?.isFile() ? { redirect: `${urlPath}/` } : null;
  }
  const html = `${target}.html`;
  const st3 = await check(html);
  return st3?.isFile() ? { file: html } : null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// The site's CSP contains upgrade-insecure-requests, which would make the
// browser try https://127.0.0.1 for every asset. Locally (plain http) we drop
// just that directive; everything else is sent exactly as on Cloudflare.
function localizeHeaders(map) {
  const csp = map.get('content-security-policy');
  if (csp) {
    csp.value = csp.value
      .split(',')
      .map((p) => p.split(';').map((d) => d.trim()).filter((d) => d && d.toLowerCase() !== 'upgrade-insecure-requests').join('; '))
      .join(', ');
  }
  return map;
}

export function createServer({ distDir, log = () => {} } = {}) {
  const base = resolve(distDir);

  async function loadRules() {
    try {
      return parseHeadersFile(await readFile(join(base, '_headers'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  function send(res, status, headers, body, isHead) {
    res.writeHead(status, headers);
    res.end(isHead ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    const isHead = req.method === 'HEAD';
    const plain = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : '';
      const hostHeader = String(req.headers.host ?? '').toLowerCase();
      if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) {
        log(`${req.method} ${req.url} -> 421 (Host ${hostHeader})`);
        return send(res, 421, plain, 'Neplatná hlavička Host.\n', isHead);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        log(`${req.method} ${req.url} -> 405`);
        return send(res, 405, { ...plain, Allow: 'GET, HEAD' }, 'Povolené jsou jen metody GET a HEAD.\n', isHead);
      }

      const parsed = parseRequestPath(req.url);
      if (!parsed.ok) {
        log(`${req.method} ${req.url} -> ${parsed.status}`);
        return send(res, parsed.status, plain, `${parsed.reason}\n`, isHead);
      }
      const urlPath = parsed.path;

      if (urlPath === '/api' || urlPath.startsWith('/api/')) {
        log(`${req.method} ${req.url} -> 501`);
        return send(
          res,
          501,
          plain,
          'Funkce /api/* (přihlášení do administrace přes GitHub) běží jen na Cloudflare Pages ' +
            '(nebo lokálně přes „npx wrangler pages dev dist“). Tento jednoduchý server je neumí.\n',
          isHead,
        );
      }

      const rules = await loadRules();
      const found = await resolveFile(base, urlPath);

      if (found?.redirect) {
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        log(`${req.method} ${req.url} -> 308`);
        return send(res, 308, { ...plain, Location: encodeURI(found.redirect) + query }, '', isHead);
      }

      let status = 200;
      let file = found?.file;
      if (!file) {
        status = 404;
        file = join(base, '404.html');
        const st = await stat(file).catch(() => null);
        if (!st?.isFile()) {
          log(`${req.method} ${req.url} -> 404`);
          return send(res, 404, plain, 'Nenalezeno.\n', isHead);
        }
      }

      const st = await stat(file);
      const headers = {};
      for (const { name, value } of localizeHeaders(headersFor(rules, urlPath, hostHeader)).values()) headers[name] = value;
      headers['Content-Type'] = contentTypeFor(file);
      headers['Content-Length'] = st.size;
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'cache-control')) {
        headers['Cache-Control'] = 'no-cache';
      }
      log(`${req.method} ${req.url} -> ${status}`);
      res.writeHead(status, headers);
      if (isHead) return res.end();
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (e) {
      log(`${req.method} ${req.url} -> 500 (${e.message})`);
      if (!res.headersSent) send(res, 500, plain, 'Chyba serveru.\n', isHead);
      else res.destroy();
    }
  });
  return server;
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Neplatný PORT „${value}“ (má být číslo 1–65535).`);
  return n;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = join(root, 'dist');
  const st = await stat(join(distDir, 'index.html')).catch(() => null);
  if (!st) {
    console.error('Složka dist/ neexistuje nebo je prázdná. Nejdřív spusťte: node build.mjs');
    process.exitCode = 1;
    return;
  }
  const port = parsePort(process.env.PORT);
  const server = createServer({ distDir, log: (line) => console.log(line) });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} je obsazený. Zkuste jiný: PORT=8788 node scripts/serve.mjs` : e);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    console.log(`Náhled webu běží na http://${HOST}:${server.address().port}/  (ukončení: Ctrl+C)`);
    console.log('Pozn.: /api/* (přihlášení do administrace) tady nefunguje, jen na Cloudflare Pages.');
  });
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
