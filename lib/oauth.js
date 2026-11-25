// Shared logic of the GitHub OAuth proxy for Decap CMS (Cloudflare Pages Functions).
//
// Lives outside functions/ on purpose: every file under functions/ becomes a route.
// Imported by functions/api/auth.js and functions/api/callback.js.
//
// Security notes:
// - Never log or echo the OAuth code, the access token or the client secret.
// - Error responses are generic (Czech, no details from GitHub or from the environment).
// - Cloudflare Pages `_headers` rules do NOT apply to Functions responses, so every response
//   built here sets its own security headers.
// - Everything fails closed: missing/invalid configuration (client id/secret, ALLOWED_GITHUB_USERS,
//   Cloudflare Access settings) means no login at all, never a login without the check.

import { verifyAccess } from './access.js';

export const PROVIDER = 'github';
export const STATE_COOKIE = '__Host-decap_oauth_state';
export const STATE_MAX_AGE = 600; // seconds
export const ALLOWED_SCOPES = new Set(['public_repo', 'repo']);
export const DEFAULT_SCOPE = 'public_repo';
// Origins the proxy serves when ALLOWED_ORIGINS is not set. Any other https host bound to the
// Pages project (zabavadeti.cz without www, *.pages.dev, …) is refused. Change together with
// base_url in static/admin/config.yml and the callback URL of the GitHub OAuth App.
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['https://www.zabavadeti.cz']);
export const HSTS = 'max-age=31536000; includeSubDomains';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'zabavadeti-decap-oauth';
// GitHub login rules: 1–39 characters, letters/digits/single hyphens, no hyphen at the ends.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const MSG = {
  serverConfig: 'Přihlašování není na serveru správně nastavené. Kontaktujte správce webu.',
  badRequest: 'Neplatný požadavek.',
  badOrigin: 'Přihlášení z této adresy není povolené.',
  methodNotAllowed: 'Tato metoda není povolená.',
  stateMismatch: 'Přihlášení vypršelo nebo bylo přerušeno. Zavřete okno a přihlaste se znovu z administrace.',
  denied: 'Přihlášení bylo zrušeno.',
  githubFailed: 'Přihlášení přes GitHub se nepodařilo. Zkuste to prosím znovu za chvíli.',
  notAllowedUser: 'Tento účet GitHub nemá přístup do administrace webu.',
  scopeTooBroad: 'Přihlášení mělo širší oprávnění, než je potřeba, a bylo proto zrušeno. Přihlaste se prosím znovu.',
  crossSite: 'Přihlášení nejde spustit z jiné stránky. Vraťte se do administrace a klikněte na přihlášení ještě jednou.',
  accessDenied: 'Přístup odepřen. Administrace je dostupná jen po ověření e-mailem (Cloudflare Access).',
  accessUnavailable: 'Ověření přístupu se teď nepodařilo. Zkuste to prosím znovu za chvíli.',
  success: 'Přihlášení proběhlo. Okno se zavře samo.',
  working: 'Dokončuji přihlášení…',
  noOpener: 'Okno zavřete a přihlaste se znovu z administrace.',
};

// ----------------------------------------------------------------------------- helpers

/** Headers common to every /api/* response. */
export function baseHeaders(extra = {}) {
  const h = new Headers({
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': HSTS,
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    // The OAuth popup must keep its relation to window.opener (the /admin/ page); see docs/VENDOR.md.
    'Cross-Origin-Opener-Policy': 'unsafe-none',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

export function textResponse(status, message, extra = {}) {
  return new Response(message + '\n', {
    status,
    headers: baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...extra }),
  });
}

export function methodNotAllowed() {
  return textResponse(405, MSG.methodNotAllowed, { Allow: 'GET' });
}

/**
 * Wraps a GET handler: every other method gets 405; then the Cloudflare Access token is
 * verified (second, independent check after Access itself) before the handler runs.
 */
export function onlyGet(handler) {
  return async (context) => {
    if (context.request.method !== 'GET') return methodNotAllowed();
    const access = await verifyAccess(context.request, context.env || {});
    if (!access.ok) {
      if (access.reason === 'config') return textResponse(500, MSG.serverConfig);
      if (access.reason === 'unavailable') return textResponse(503, MSG.accessUnavailable);
      return textResponse(403, MSG.accessDenied);
    }
    return handler(context);
  };
}

export function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Constant-time string comparison (no early exit; length difference folded into the result). */
export function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export function getCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function stateCookie(value, maxAge) {
  return `${STATE_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearStateCookie() {
  return stateCookie('', 0);
}

function isNonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Scope from env, restricted to the allowlist. Anything else falls back to public_repo. */
export function resolveScope(env) {
  const s = String(env.OAUTH_SCOPE || '').trim();
  return ALLOWED_SCOPES.has(s) ? s : DEFAULT_SCOPE;
}

/**
 * Required allowlist of GitHub logins (ALLOWED_GITHUB_USERS, comma separated).
 * Returns the lower-cased logins, or null when the list is empty or any entry is not a valid
 * GitHub login (e.g. an e-mail, a ";" separator, a stray space inside). null = fail closed.
 */
export function parseAllowedUsers(env) {
  const raw = String(env.ALLOWED_GITHUB_USERS ?? '');
  const list = splitList(raw);
  if (list.length === 0) return null;
  if (!list.every((s) => GITHUB_LOGIN_RE.test(s))) return null;
  return list.map((s) => s.toLowerCase());
}

/**
 * Origin of the current request, used for redirect_uri and postMessage.
 * Plain http and http(s) on localhost/127.0.0.1 are allowed only for local development.
 * Any other origin must be in ALLOWED_ORIGINS, or – when that variable is empty – in
 * DEFAULT_ALLOWED_ORIGINS (https://www.zabavadeti.cz). Returns null when not allowed.
 */
export function resolveOrigin(request, env) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (local) return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  if (url.protocol !== 'https:') return null;
  const fromEnv = splitList(env.ALLOWED_ORIGINS);
  const allowed = fromEnv.length > 0 ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
  return allowed.includes(url.origin) ? url.origin : null;
}

function hasClientConfig(env) {
  return isNonEmpty(env.GITHUB_CLIENT_ID) && isNonEmpty(env.GITHUB_CLIENT_SECRET);
}

async function safeFetch(url, init) {
  return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** JSON for embedding inside an inline <script>: escapes <, >, &, U+2028, U+2029. */
export function scriptSafeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * True when the granted scopes are a subset of the requested one (GitHub returns them comma
 * separated; a user may legitimately grant less, never more).
 */
export function scopeWithinRequested(granted, wanted) {
  return String(granted ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => s === wanted);
}

// ----------------------------------------------------------------------------- /api/auth

export async function handleAuth({ request, env }) {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider');
  if (provider !== null && provider !== PROVIDER) return textResponse(400, MSG.badRequest);

  // The administration opens /api/auth from its own page (Sec-Fetch-Site: same-origin).
  // A start from a foreign site would only disturb a running login (it overwrites the state
  // cookie) and mint unused tokens, so it is refused. A missing header (old browser) is allowed.
  const sfs = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  if (sfs === 'cross-site' || sfs === 'same-site') return textResponse(403, MSG.crossSite);

  const origin = resolveOrigin(request, env);
  if (!origin) return textResponse(400, MSG.badOrigin);
  if (!hasClientConfig(env) || !parseAllowedUsers(env)) return textResponse(500, MSG.serverConfig);

  // Decap also sends site_id and scope; both are ignored on purpose (scope comes from env only).
  const state = randomToken(32);
  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID.trim());
  authorize.searchParams.set('redirect_uri', `${origin}/api/callback`);
  authorize.searchParams.set('scope', resolveScope(env));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'false');

  return new Response(null, {
    status: 302,
    headers: baseHeaders({
      Location: authorize.toString(),
      'Set-Cookie': stateCookie(state, STATE_MAX_AGE),
    }),
  });
}

// ----------------------------------------------------------------------------- /api/callback

const CODE_RE = /^[A-Za-z0-9._-]{1,512}$/;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

export async function handleCallback({ request, env }) {
  const url = new URL(request.url);
  const origin = resolveOrigin(request, env);
  // No Set-Cookie here: a request that is not ours must not delete the state of a login in progress.
  if (!origin) return textResponse(400, MSG.badOrigin);

  // 1) CSRF / login-injection protection: state from the query must equal the cookie.
  //    Before this check succeeds, the state cookie is left untouched (clearCookie: false),
  //    so a stray or foreign request to /api/callback cannot break a running login.
  const stateParam = url.searchParams.get('state') || '';
  const stateCookieValue = getCookie(request, STATE_COOKIE) || '';
  const stateOk =
    STATE_RE.test(stateParam) && STATE_RE.test(stateCookieValue) && timingSafeEqual(stateParam, stateCookieValue);
  if (!stateOk) {
    return handshakePage({ origin, status: 403, ok: false, message: MSG.stateMismatch, clearCookie: false });
  }

  // From here on the state belonged to this login: every outcome clears the cookie.
  const page = (opts) => handshakePage({ origin, clearCookie: true, ...opts });

  // 2) Configuration first (fail closed, before any token exists).
  const allowedUsers = parseAllowedUsers(env);
  if (!hasClientConfig(env) || !allowedUsers) {
    return page({ status: 500, ok: false, message: MSG.serverConfig });
  }

  // 3) User cancelled on GitHub (?error=access_denied) or missing/odd code.
  if (url.searchParams.has('error')) {
    return page({ status: 403, ok: false, message: MSG.denied });
  }
  const code = url.searchParams.get('code') || '';
  if (!CODE_RE.test(code)) {
    return page({ status: 400, ok: false, message: MSG.badRequest });
  }

  // 4) Exchange code for token.
  let token;
  let tokenData;
  try {
    const res = await safeFetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID.trim(),
        client_secret: env.GITHUB_CLIENT_SECRET.trim(),
        code,
        redirect_uri: `${origin}/api/callback`,
      }).toString(),
    });
    if (res.status !== 200) throw new Error('token endpoint status');
    const data = await res.json();
    if (!data || typeof data !== 'object' || data.error) throw new Error('token endpoint error');
    if (typeof data.access_token !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(data.access_token)) {
      throw new Error('token missing');
    }
    token = data.access_token;
    tokenData = data;
  } catch (err) {
    console.error('oauth callback: token exchange failed', err && err.name);
    return page({ status: 502, ok: false, message: MSG.githubFailed });
  }

  // 5) The token must be a bearer token with no broader scope than requested. GitHub adds up
  //    scopes granted earlier to the same app, so a token can come back with e.g. "repo" even
  //    though only "public_repo" was asked for. Such a grant is revoked as a whole, so the next
  //    login asks again for the narrow scope only.
  const tokenType = String(tokenData.token_type || '').toLowerCase();
  if (tokenType !== 'bearer' || !scopeWithinRequested(tokenData.scope, resolveScope(env))) {
    console.warn('oauth callback: token type/scope not as requested');
    await revokeGrant(env, token);
    return page({ status: 403, ok: false, message: MSG.scopeTooBroad });
  }

  // 6) Required allowlist of GitHub logins.
  let login = null;
  try {
    const res = await safeFetch(`${GITHUB_API}/user`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status !== 200) throw new Error('user endpoint status');
    const user = await res.json();
    if (user && typeof user.login === 'string') login = user.login.toLowerCase();
  } catch (err) {
    console.error('oauth callback: user lookup failed', err && err.name);
    await revokeToken(env, token);
    return page({ status: 502, ok: false, message: MSG.githubFailed });
  }
  if (!login || !allowedUsers.includes(login)) {
    console.warn('oauth callback: login not in ALLOWED_GITHUB_USERS');
    await revokeToken(env, token);
    return page({ status: 403, ok: false, message: MSG.notAllowedUser });
  }

  return page({ status: 200, ok: true, token });
}

async function githubAppRequest(env, path, token) {
  const id = env.GITHUB_CLIENT_ID.trim();
  const basic = btoa(`${id}:${env.GITHUB_CLIENT_SECRET.trim()}`);
  return safeFetch(`${GITHUB_API}/applications/${encodeURIComponent(id)}/${path}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ access_token: token }),
  });
}

/**
 * Best-effort revocation of a token that must not be used (user not on the allowlist).
 * DELETE /applications/{client_id}/token with HTTP Basic auth (client_id:client_secret).
 * Failures are ignored – the token was never sent to the browser.
 */
export async function revokeToken(env, token) {
  try {
    await githubAppRequest(env, 'token', token);
  } catch {
    // ignored on purpose
  }
}

/**
 * Best-effort revocation of the whole authorization (grant) of this app for the user – used
 * when the token carries broader scopes than requested. Falls back to revoking the token.
 */
export async function revokeGrant(env, token) {
  try {
    const res = await githubAppRequest(env, 'grant', token);
    if (res.status === 204) return;
  } catch {
    // fall through
  }
  await revokeToken(env, token);
}

/**
 * HTML page that completes the Decap CMS popup handshake:
 *   popup -> opener: "authorizing:github"           (targetOrigin = own origin)
 *   opener -> popup: echo, verified by e.origin === own origin and e.source === window.opener
 *   popup -> opener: "authorization:github:success:{json}" | "authorization:github:error:{json}"
 *                                                    (targetOrigin = own origin, never "*")
 * clearCookie: true only after the state was verified (see handleCallback).
 */
export function handshakePage({ origin, status, ok, token, message, clearCookie = false }) {
  const nonce = randomToken(18);
  const payload = ok
    ? `authorization:${PROVIDER}:success:` + JSON.stringify({ token, provider: PROVIDER })
    : `authorization:${PROVIDER}:error:` + JSON.stringify({ message, provider: PROVIDER });
  const visible = ok ? MSG.working : message;

  const script = `(function () {
  'use strict';
  var ORIGIN = ${scriptSafeJson(origin)};
  var HELLO = ${scriptSafeJson(`authorizing:${PROVIDER}`)};
  var RESULT = ${scriptSafeJson(payload)};
  var OK = ${ok ? 'true' : 'false'};
  var MSG_DONE = ${scriptSafeJson(MSG.success)};
  var MSG_NO_OPENER = ${scriptSafeJson(MSG.noOpener)};
  var out = document.getElementById('msg');
  function show(t) { out.textContent = t; }
  var opener = window.opener;
  if (!opener || opener.closed) { RESULT = null; show(MSG_NO_OPENER); return; }
  var sent = false;
  function onMessage(e) {
    if (sent) return;
    if (e.origin !== ORIGIN || e.source !== opener || e.data !== HELLO) return;
    sent = true;
    window.removeEventListener('message', onMessage, false);
    opener.postMessage(RESULT, ORIGIN);
    RESULT = null;
    if (OK) show(MSG_DONE);
    setTimeout(function () { window.close(); }, 500);
  }
  window.addEventListener('message', onMessage, false);
  opener.postMessage(HELLO, ORIGIN);
  setTimeout(function () {
    if (!sent) { RESULT = null; window.removeEventListener('message', onMessage, false); show(MSG_NO_OPENER); }
  }, 60000);
})();`;

  const html = `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Přihlášení do administrace</title>
<style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#222;background:#fff}</style>
</head>
<body>
<p id="msg">${escapeHtml(visible)}</p>
<noscript><p>${escapeHtml(MSG.noOpener)}</p></noscript>
<script nonce="${nonce}">${script}</script>
</body>
</html>
`;

  const extra = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  if (clearCookie) extra['Set-Cookie'] = clearStateCookie();
  return new Response(html, { status, headers: baseHeaders(extra) });
}
