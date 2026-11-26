// Tests of the Decap CMS OAuth proxy (functions/api/*.js + lib/oauth.js + lib/access.js)
// and of the admin static files.
// Run: node --test tests/oauth.test.mjs   (Node 22+, no dependencies)
import { test, describe, beforeEach, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as authFn from '../functions/api/auth.js';
import * as callbackFn from '../functions/api/callback.js';
import { timingSafeEqual, scriptSafeJson, STATE_COOKIE, parseAllowedUsers, scopeWithinRequested } from '../lib/oauth.js';
import { _resetAccessCache, accessConfig, verifyAccess } from '../lib/access.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://www.zabavadeti.cz';
const TEAM = 'zabavadeti.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
const ENV = Object.freeze({
  GITHUB_CLIENT_ID: 'Iv1.testclientid',
  GITHUB_CLIENT_SECRET: 'super-secret-value',
  ALLOWED_GITHUB_USERS: '11Lucie, ivona-m',
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
});
const STATE = 'A'.repeat(43);
const SECRET_MARKERS = ['super-secret-value', 'github-internal-detail', 'bad_verification_code'];

// ------------------------------------------------------------------ Cloudflare Access JWT fixtures
const subtle = webcrypto.subtle;
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
let accessKey; // { privateKey, jwk }
let foreignKey;
let JWT;

async function makeKey(kid) {
  const pair = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function signJwt(payloadOverrides = {}, { key = accessKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'RS256', kid: key.jwk.kid, typ: 'JWT', ...header });
  const p = enc({ iss: `https://${TEAM}`, aud: [AUD], exp: now + 3600, iat: now, nbf: now, email: 'lucie@example.cz', type: 'app', ...payloadOverrides });
  const sig = Buffer.from(await subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, Buffer.from(`${h}.${p}`))).toString('base64url');
  return `${h}.${p}.${sig}`;
}

before(async () => {
  accessKey = await makeKey('kid-1');
  foreignKey = await makeKey('kid-1'); // same kid, different key -> signature must fail
  JWT = await signJwt();
});

function ctx(url, { method = 'GET', headers = {}, env = ENV, jwt = undefined } = {}) {
  const h = { ...headers };
  const token = jwt === undefined ? JWT : jwt;
  if (token !== null) h['Cf-Access-Jwt-Assertion'] = token;
  return { request: new Request(url, { method, headers: h }), env: { ...env }, params: {}, next: () => {} };
}

function callbackCtx({ state = STATE, cookie = STATE, code = 'abc123', env = ENV, extra = '' } = {}) {
  const headers = cookie === null ? {} : { Cookie: `other=1; ${STATE_COOKIE}=${cookie}` };
  const q = new URLSearchParams();
  if (code !== null) q.set('code', code);
  if (state !== null) q.set('state', state);
  return ctx(`${ORIGIN}/api/callback?${q}${extra}`, { headers, env });
}

function assertApiHeaders(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d+; includeSubDomains/);
}

function assertNoLeak(text) {
  for (const m of SECRET_MARKERS) assert.ok(!text.includes(m), `response leaks "${m}"`);
}

// ------------------------------------------------------------------ fetch mock
let realFetch;
let calls;
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const certsRoute = () => [CERTS_URL, () => json({ keys: [accessKey.jwk], public_cert: {}, public_certs: [] })];
const tokenOk = (access_token = 'gho_placeholder', extra = {}) =>
  ['https://github.com/login/oauth/access_token', () => json({ access_token, token_type: 'bearer', scope: 'public_repo', ...extra })];
const userRoute = (login = '11Lucie') => ['https://api.github.com/user', () => json({ login })];

function mockFetch(routes, { certs = true } = {}) {
  calls = [];
  const all = certs ? [certsRoute(), ...routes] : routes;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    for (const [prefix, handler] of all) {
      if (url.startsWith(prefix)) return handler(url, init);
    }
    throw new Error('unexpected fetch ' + url);
  };
}
const githubCalls = () => calls.filter((c) => !c.url.startsWith(CERTS_URL));

beforeEach(() => {
  realFetch = globalThis.fetch;
  _resetAccessCache();
  mockFetch([]); // no test may ever reach the network
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ------------------------------------------------------------------ /api/auth
describe('/api/auth', () => {
  test('redirects to GitHub with state, public_repo scope and sets a __Host- cookie', async () => {
    const res = await authFn.onRequestGet(
      ctx(`${ORIGIN}/api/auth?provider=github&site_id=www.zabavadeti.cz&scope=repo`, { headers: { 'Sec-Fetch-Site': 'same-origin' } }),
    );
    assert.equal(res.status, 302);
    assertApiHeaders(res);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(loc.searchParams.get('client_id'), ENV.GITHUB_CLIENT_ID);
    assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/api/callback`);
    assert.equal(loc.searchParams.get('scope'), 'public_repo', 'scope from the browser must be ignored');
    assert.equal(loc.searchParams.get('allow_signup'), 'false');
    const state = loc.searchParams.get('state');
    assert.match(state, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');

    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie.startsWith(`${STATE_COOKIE}=${state};`));
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
      assert.ok(cookie.includes(attr), `cookie attribute ${attr}`);
    }
    assert.ok(!/Domain=/i.test(cookie), '__Host- cookie must not have Domain');
  });

  test('state is random per request', async () => {
    const a = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`));
    const b = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`));
    const s = (r) => new URL(r.headers.get('location')).searchParams.get('state');
    assert.notEqual(s(a), s(b));
  });

  test('OAUTH_SCOPE=repo is honoured, anything else falls back to public_repo', async () => {
    const scopeOf = async (OAUTH_SCOPE) => {
      const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { env: { ...ENV, OAUTH_SCOPE } }));
      return new URL(res.headers.get('location')).searchParams.get('scope');
    };
    assert.equal(await scopeOf('repo'), 'repo');
    assert.equal(await scopeOf('public_repo'), 'public_repo');
    assert.equal(await scopeOf('repo,admin:org'), 'public_repo');
    assert.equal(await scopeOf('delete_repo'), 'public_repo');
    assert.equal(await scopeOf(''), 'public_repo');
  });

  test('other provider -> 400', async () => {
    const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth?provider=gitlab`));
    assert.equal(res.status, 400);
    assertApiHeaders(res);
  });

  test('missing env -> 500 with generic message', async () => {
    for (const env of [{}, { ...ENV, GITHUB_CLIENT_ID: '' }, { ...ENV, GITHUB_CLIENT_SECRET: undefined }]) {
      const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { env }));
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.match(text, /správce webu/);
      assert.ok(!/GITHUB_CLIENT|ACCESS_/.test(text), 'no env variable names in the response');
      assertNoLeak(text);
    }
  });

  test('ALLOWED_GITHUB_USERS missing, empty or invalid -> 500, no redirect to GitHub (fail closed)', async () => {
    for (const v of [undefined, '', ' ', ' , ', ',,,', '\u00a0', 'bad login!', 'ivona@seznam.cz', '11Lucie;ivona', '-lucie']) {
      const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { env: { ...ENV, ALLOWED_GITHUB_USERS: v } }));
      assert.equal(res.status, 500, JSON.stringify(v));
      assert.equal(res.headers.get('location'), null);
      assert.equal(res.headers.get('set-cookie'), null);
    }
  });

  test('origins: only www.zabavadeti.cz by default, ALLOWED_ORIGINS overrides; http only on localhost', async () => {
    for (const bad of [
      'https://zabavadeti.cz/api/auth',
      'https://zabavadeti.pages.dev/api/auth',
      'https://abc123.zabavadeti.pages.dev/api/auth',
      'https://evil.example/api/auth',
      'http://www.zabavadeti.cz/api/auth',
    ]) {
      const res = await authFn.onRequestGet(ctx(bad));
      assert.equal(res.status, 400, bad);
      assert.equal(res.headers.get('set-cookie'), null, bad);
    }
    assert.equal((await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`))).status, 302);
    const env = { ...ENV, ALLOWED_ORIGINS: 'https://admin.example.cz' };
    assert.equal((await authFn.onRequestGet(ctx('https://admin.example.cz/api/auth', { env }))).status, 302);
    assert.equal((await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { env }))).status, 400, 'override replaces the default');
    const local = await authFn.onRequestGet(ctx('http://localhost:8788/api/auth', { jwt: null }));
    assert.equal(local.status, 302, 'local development without Access');
  });

  test('cross-site start is refused, same-origin / none / missing Sec-Fetch-Site allowed', async () => {
    for (const sfs of ['cross-site', 'same-site', 'Cross-Site']) {
      const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { headers: { 'Sec-Fetch-Site': sfs } }));
      assert.equal(res.status, 403, sfs);
      assert.equal(res.headers.get('set-cookie'), null, 'a running login keeps its state cookie');
      assert.match(await res.text(), /klikněte na přihlášení ještě jednou/);
    }
    for (const sfs of ['same-origin', 'none', null]) {
      const headers = sfs ? { 'Sec-Fetch-Site': sfs } : {};
      const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { headers }));
      assert.equal(res.status, 302, String(sfs));
    }
  });

  test('POST / PUT / HEAD -> 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const res = await authFn.onRequest(ctx(`${ORIGIN}/api/auth`, { method }));
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'GET');
      assertApiHeaders(res);
      assert.equal(res.headers.get('set-cookie'), null);
    }
    const viaFallback = await authFn.onRequest(ctx(`${ORIGIN}/api/auth`));
    assert.equal(viaFallback.status, 302, 'GET through onRequest still works');
  });
});

// ------------------------------------------------------------------ Cloudflare Access JWT
describe('Cloudflare Access token (fail closed)', () => {
  test('missing or invalid ACCESS_* configuration -> 500 on both endpoints', async () => {
    for (const env of [
      { ...ENV, ACCESS_TEAM_DOMAIN: '' },
      { ...ENV, ACCESS_AUD: '' },
      { ...ENV, ACCESS_TEAM_DOMAIN: 'evil.example.com' },
      { ...ENV, ACCESS_AUD: 'short' },
    ]) {
      assert.equal((await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { env }))).status, 500);
      assert.equal((await callbackFn.onRequestGet(callbackCtx({ env }))).status, 500);
    }
    assert.equal(githubCalls().length, 0);
  });

  test('accessConfig accepts the team with or without https://', () => {
    assert.ok(accessConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD }));
    assert.deepEqual(accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: `${AUD}, ${'b'.repeat(64)}` }).auds, [AUD, 'b'.repeat(64)]);
  });

  test('missing, forged, expired, foreign-audience or alg=none token -> 403, nothing else happens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      null,
      '',
      'not-a-jwt',
      await signJwt({}, { key: foreignKey }),
      await signJwt({ exp: now - 3600 }),
      await signJwt({ nbf: now + 3600 }),
      await signJwt({ aud: ['c'.repeat(64)] }),
      await signJwt({ iss: 'https://evil.cloudflareaccess.com' }),
      await signJwt({}, { header: { alg: 'none' } }),
      await signJwt({}, { header: { alg: 'HS256' } }),
      await signJwt({}, { header: { kid: 'unknown-kid' } }),
      JWT.split('.').slice(0, 2).join('.') + '.',
    ];
    for (const jwt of bad) {
      const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { jwt }));
      assert.equal(res.status, 403, String(jwt).slice(0, 40));
      assert.equal(res.headers.get('location'), null);
      assert.equal(res.headers.get('set-cookie'), null);
    }
    const cb = await callbackFn.onRequestGet({ ...callbackCtx(), request: new Request(`${ORIGIN}/api/callback?code=a&state=${STATE}`) });
    assert.equal(cb.status, 403);
    assert.equal(githubCalls().length, 0);
  });

  test('aud as a plain string is accepted; keys are cached', async () => {
    const jwt = await signJwt({ aud: AUD });
    assert.equal((await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`, { jwt }))).status, 302);
    assert.equal((await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`))).status, 302);
    assert.equal(calls.filter((c) => c.url === CERTS_URL).length, 1, 'certs fetched once');
  });

  test('certificate endpoint down -> 503', async () => {
    mockFetch([], { certs: false });
    globalThis.fetch = async () => new Response('down', { status: 500 });
    const r = await verifyAccess(new Request(`${ORIGIN}/api/auth`, { headers: { 'Cf-Access-Jwt-Assertion': JWT } }), ENV);
    assert.deepEqual(r, { ok: false, reason: 'unavailable' });
    const res = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth`));
    assert.equal(res.status, 503);
  });
});

// ------------------------------------------------------------------ /api/callback
describe('/api/callback', () => {
  test('missing cookie -> 403, no GitHub call, state cookie left alone', async () => {
    const res = await callbackFn.onRequestGet(callbackCtx({ cookie: null }));
    assert.equal(res.status, 403);
    assertApiHeaders(res);
    assert.equal(githubCalls().length, 0);
    assert.equal(res.headers.get('set-cookie'), null, 'a stray callback must not delete a running login');
    const html = await res.text();
    assert.ok(html.includes('authorization:github:error:'));
    assert.ok(!html.includes('success'));
  });

  test('wrong / missing / malformed state -> 403, cookie not cleared', async () => {
    for (const opts of [
      { state: 'B'.repeat(43) },
      { state: null },
      { state: STATE.slice(0, 42) },
      { state: STATE + 'A', cookie: STATE + 'A' },
      { state: '', cookie: '' },
    ]) {
      const res = await callbackFn.onRequestGet(callbackCtx(opts));
      assert.equal(res.status, 403, JSON.stringify(opts));
      assert.equal(res.headers.get('set-cookie'), null, JSON.stringify(opts));
    }
    assert.equal(githubCalls().length, 0);
  });

  test('callback on a foreign origin -> 400 without Set-Cookie', async () => {
    const res = await callbackFn.onRequestGet(ctx(`https://zabavadeti.pages.dev/api/callback?code=a&state=${STATE}`));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('success -> handshake HTML with nonce CSP, exact origin, no "*", escaped token, cookie cleared', async () => {
    const evilToken = 'gho_x</script><script>alert(1)</script>&\u2028\u2029';
    mockFetch([tokenOk('gho_placeholder'), userRoute('11Lucie')]);
    const res = await callbackFn.onRequestGet(callbackCtx());
    assert.equal(res.status, 200);
    assertApiHeaders(res);
    assert.equal(res.headers.get('pragma'), 'no-cache');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'unsafe-none');
    assert.match(res.headers.get('content-type'), /^text\/html; charset=utf-8/);

    const csp = res.headers.get('content-security-policy');
    const m = csp.match(/script-src 'nonce-([A-Za-z0-9_-]{16,})'/);
    assert.ok(m, 'nonce in CSP: ' + csp);
    for (const d of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      assert.ok(csp.includes(d), d);
    }
    assert.ok(!csp.includes('unsafe-inline'));

    const html = await res.text();
    assert.ok(html.includes(`<script nonce="${m[1]}">`));
    assert.ok(html.includes(JSON.stringify(ORIGIN)), 'exact origin embedded');
    assert.ok(!/postMessage\([^)]*['"]\*['"]/.test(html), 'never targetOrigin "*"');
    assert.ok(!html.includes("'*'") && !html.includes('"*"'));
    assert.ok(html.includes('authorization:github:success:'));
    assert.ok(html.includes('gho_placeholder'));
    assert.ok(html.includes('authorizing:github'));
    assert.ok(html.includes('e.origin !== ORIGIN'));
    assert.ok(html.includes('Okno zavřete a přihlaste se znovu z administrace.'));
    assertNoLeak(html);

    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie.startsWith(`${STATE_COOKIE}=;`));
    assert.ok(cookie.includes('Max-Age=0'));

    // token exchange request, then the allowlist lookup
    const gh = githubCalls();
    assert.equal(gh.length, 2);
    const call = gh[0];
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.ok(call.init.signal, 'request has a timeout signal');
    const body = new URLSearchParams(call.init.body);
    assert.equal(body.get('code'), 'abc123');
    assert.equal(body.get('client_id'), ENV.GITHUB_CLIENT_ID);
    assert.equal(body.get('redirect_uri'), `${ORIGIN}/api/callback`);
    assert.equal(gh[1].url, 'https://api.github.com/user');

    // escaping of </script>, &, U+2028/2029 inside the inline script
    const escaped = scriptSafeJson('authorization:github:success:' + JSON.stringify({ token: evilToken }));
    assert.ok(!escaped.includes('</script>'));
    assert.ok(!escaped.includes('<') && !escaped.includes('>') && !escaped.includes('&'));
    assert.ok(!escaped.includes('\u2028') && !escaped.includes('\u2029'));
    assert.equal(JSON.parse(escaped), 'authorization:github:success:' + JSON.stringify({ token: evilToken }));
  });

  // OAuth App with "Expire user access tokens": GitHub answers with an 8-hour token plus a
  // refresh token. The proxy accepts it, but only the access token may ever reach the browser.
  test('expiring token (expires_in, refresh_token): accepted, refresh token never sent to the page', async () => {
    const REFRESH = 'ghr_refreshSECRETvalue1234567890';
    mockFetch([
      ['https://github.com/login/oauth/access_token', () => json({
        access_token: 'ghu_expiringAccessToken',
        expires_in: 28800,
        refresh_token: REFRESH,
        refresh_token_expires_in: 15811200,
        token_type: 'bearer',
        scope: '',
      })],
      userRoute('11Lucie'),
    ]);
    const res = await callbackFn.onRequestGet(callbackCtx());
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('authorization:github:success:'));
    assert.ok(html.includes('ghu_expiringAccessToken'), 'access token goes to the opener');
    assert.ok(!html.includes(REFRESH) && !html.includes('ghr_'), 'refresh token must never be in the HTML / postMessage');
    assert.ok(!/refresh_token|expires_in/.test(html), 'no other token fields are passed on');
    for (const [k, v] of res.headers) assert.ok(!v.includes(REFRESH), `header ${k}`);
    // The payload sent by postMessage contains exactly { token, provider }.
    const m = /var RESULT = ("(?:[^"\\]|\\.)*");/.exec(html);
    assert.ok(m, 'RESULT in the page');
    const payload = JSON.parse(m[1]);
    assert.deepEqual(JSON.parse(payload.slice('authorization:github:success:'.length)), { token: 'ghu_expiringAccessToken', provider: 'github' });
    // Same with the scope GitHub reports for public_repo.
    mockFetch([
      ['https://github.com/login/oauth/access_token', () => json({ access_token: 'ghu_b', expires_in: 28800, refresh_token: REFRESH, refresh_token_expires_in: 15811200, token_type: 'bearer', scope: 'public_repo' })],
      userRoute('11Lucie'),
    ]);
    const res2 = await callbackFn.onRequestGet(callbackCtx());
    assert.equal(res2.status, 200);
    assert.ok(!(await res2.text()).includes(REFRESH));
  });

  // GitHub App (current setup since 26. 11. 2026): the authorize URL keeps scope=public_repo
  // (GitHub Apps ignore it), the token endpoint answers with scope "" and a user-to-server token
  // (ghu_…) plus a refresh token. Login passes; a foreign login's token is revoked with the
  // GitHub App's client id (DELETE /applications/{client_id}/token), same as with an OAuth App.
  test('GitHub App: empty scope passes, foreign login revoked via /applications/{client_id}/token', async () => {
    const env = { ...ENV, GITHUB_CLIENT_ID: 'Iv23.testappclientid' };
    const appToken = (access_token) => ['https://github.com/login/oauth/access_token', () => json({
      access_token, expires_in: 28800, refresh_token: 'ghr_appRefreshSECRET', refresh_token_expires_in: 15811200, token_type: 'bearer', scope: '',
    })];

    const auth = await authFn.onRequestGet(ctx(`${ORIGIN}/api/auth?provider=github&scope=repo`, { env }));
    assert.equal(auth.status, 302);
    const loc = new URL(auth.headers.get('location'));
    assert.equal(loc.searchParams.get('client_id'), env.GITHUB_CLIENT_ID);
    assert.equal(loc.searchParams.get('scope'), 'public_repo');

    mockFetch([appToken('ghu_appUserToken'), userRoute('11Lucie')]);
    const ok = await callbackFn.onRequestGet(callbackCtx({ env }));
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.ok(html.includes('ghu_appUserToken'));
    assert.ok(!html.includes('ghr_'), 'refresh token never reaches the page');
    assert.ok(!githubCalls().some((c) => c.url.startsWith('https://api.github.com/applications/')), 'nothing revoked');

    mockFetch([
      appToken('ghu_intruderToken'),
      ['https://api.github.com/user', () => json({ login: 'intruder' })],
      ['https://api.github.com/applications/', () => new Response(null, { status: 204 })],
    ]);
    const denied = await callbackFn.onRequestGet(callbackCtx({ env }));
    assert.equal(denied.status, 403);
    assert.ok(!(await denied.text()).includes('ghu_intruderToken'));
    const revoke = githubCalls().find((c) => c.url.startsWith('https://api.github.com/applications/'));
    assert.equal(revoke.url, `https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`);
    assert.equal(revoke.init.method, 'DELETE');
    assert.equal(revoke.init.headers.Authorization, `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${ENV.GITHUB_CLIENT_SECRET}`)}`);
    assert.equal(JSON.parse(revoke.init.body).access_token, 'ghu_intruderToken');
  });

  test('token containing </script> is never reflected raw', async () => {
    mockFetch([tokenOk('gho_</script><b>x'), userRoute()]);
    const res = await callbackFn.onRequestGet(callbackCtx());
    const html = await res.text();
    assert.equal(html.split('</script>').length, 2, 'only the closing tag of our own script');
    assert.ok(!html.includes('<b>x'));
  });

  test('GitHub error in JSON -> generic message, no details', async () => {
    mockFetch([
      [
        'https://github.com/login/oauth/access_token',
        () => json({ error: 'bad_verification_code', error_description: 'github-internal-detail' }),
      ],
    ]);
    const res = await callbackFn.onRequestGet(callbackCtx());
    assert.equal(res.status, 502);
    const html = await res.text();
    assert.ok(html.includes('authorization:github:error:'));
    assert.ok(html.includes('Přihlášení přes GitHub se nepodařilo'));
    assert.ok(!html.includes('success'));
    assertNoLeak(html);
  });

  test('GitHub non-200 / network error / timeout -> generic 502', async () => {
    for (const handler of [
      () => new Response('github-internal-detail', { status: 500 }),
      () => {
        throw new TypeError('github-internal-detail');
      },
      () => {
        throw new DOMException('github-internal-detail', 'TimeoutError');
      },
    ]) {
      mockFetch([['https://github.com/login/oauth/access_token', handler]]);
      const res = await callbackFn.onRequestGet(callbackCtx());
      assert.equal(res.status, 502);
      assertNoLeak(await res.text());
    }
  });

  test('user cancelled on GitHub (?error=access_denied) -> error handshake, no token call, cookie cleared', async () => {
    const res = await callbackFn.onRequestGet(callbackCtx({ code: null, extra: '&error=access_denied' }));
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes('authorization:github:error:'));
    assert.equal(githubCalls().length, 0);
    assert.ok(res.headers.get('set-cookie').includes('Max-Age=0'), 'valid state -> flow finished -> cookie cleared');
  });

  test('ALLOWED_GITHUB_USERS: foreign login -> 403, token not sent, revoked', async () => {
    mockFetch([
      tokenOk('gho_intruder_token'),
      ['https://api.github.com/user', () => json({ login: 'intruder' })],
      ['https://api.github.com/applications/', () => new Response(null, { status: 204 })],
    ]);
    const res = await callbackFn.onRequestGet(callbackCtx());
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.ok(!html.includes('gho_intruder_token'), 'token must not reach the browser');
    assert.ok(!html.includes('success'));
    assert.ok(html.includes('nemá přístup'));

    const userCall = calls.find((c) => c.url === 'https://api.github.com/user');
    assert.ok(userCall.init.headers['User-Agent'], 'User-Agent header required by GitHub API');
    assert.equal(userCall.init.headers.Authorization, 'Bearer gho_intruder_token');
    const revoke = calls.find((c) => c.url.startsWith('https://api.github.com/applications/'));
    assert.ok(revoke, 'token revocation attempted');
    assert.ok(revoke.url.endsWith('/token'));
    assert.equal(revoke.init.method, 'DELETE');
    assert.equal(JSON.parse(revoke.init.body).access_token, 'gho_intruder_token');
  });

  test('ALLOWED_GITHUB_USERS: allowed login (case-insensitive) -> success', async () => {
    mockFetch([tokenOk('gho_good'), userRoute('11lucie')]);
    const env = { ...ENV, ALLOWED_GITHUB_USERS: '11Lucie,ivona-m' };
    const res = await callbackFn.onRequestGet(callbackCtx({ env }));
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('gho_good'));
  });

  test('ALLOWED_GITHUB_USERS missing, empty or invalid -> 500 before any token exists', async () => {
    for (const v of [undefined, '', ' ', ' , ', ',,,', '\u00a0', 'bad login!', 'ivona@seznam.cz']) {
      mockFetch([tokenOk('gho_should_not_exist'), userRoute()]);
      const res = await callbackFn.onRequestGet(callbackCtx({ env: { ...ENV, ALLOWED_GITHUB_USERS: v } }));
      assert.equal(res.status, 500, JSON.stringify(v));
      const html = await res.text();
      assert.ok(!html.includes('gho_should_not_exist'));
      assert.ok(!html.includes('success'));
      assert.equal(githubCalls().length, 0, 'code is never exchanged for a token');
    }
  });

  test('ALLOWED_GITHUB_USERS: /user lookup failure -> 502, token not sent', async () => {
    mockFetch([
      tokenOk('gho_secret_tok'),
      ['https://api.github.com/user', () => new Response('nope', { status: 401 })],
      ['https://api.github.com/applications/', () => new Response(null, { status: 204 })],
    ]);
    const res = await callbackFn.onRequestGet(callbackCtx());
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('gho_secret_tok'));
  });

  test('token with broader scope than requested -> 403, whole grant revoked, token not sent', async () => {
    for (const [scope, tokenType] of [['repo', 'bearer'], ['public_repo,repo', 'bearer'], ['public_repo,admin:org', 'bearer'], ['public_repo', 'mac'], ['public_repo', undefined]]) {
      mockFetch([
        ['https://github.com/login/oauth/access_token', () => json({ access_token: 'gho_wide', scope, token_type: tokenType })],
        ['https://api.github.com/applications/', () => new Response(null, { status: 204 })],
        userRoute(),
      ]);
      const res = await callbackFn.onRequestGet(callbackCtx());
      assert.equal(res.status, 403, `${scope} ${tokenType}`);
      const html = await res.text();
      assert.ok(!html.includes('gho_wide'));
      assert.match(html, /širší oprávnění/);
      const revoke = githubCalls().find((c) => c.url.startsWith('https://api.github.com/applications/'));
      assert.ok(revoke.url.endsWith('/grant'), 'grant (not only the token) is revoked');
      assert.ok(!githubCalls().some((c) => c.url === 'https://api.github.com/user'), 'no further use of the token');
    }
  });

  test('narrower or equal scope passes; Bearer case-insensitive; OAUTH_SCOPE=repo allows repo', async () => {
    for (const [scope, env] of [['public_repo', ENV], ['', ENV], [' public_repo ', ENV], ['repo', { ...ENV, OAUTH_SCOPE: 'repo' }]]) {
      mockFetch([['https://github.com/login/oauth/access_token', () => json({ access_token: 'gho_ok', scope, token_type: 'Bearer' })], userRoute()]);
      const res = await callbackFn.onRequestGet(callbackCtx({ env }));
      assert.equal(res.status, 200, scope);
    }
    assert.equal(scopeWithinRequested('public_repo,repo', 'public_repo'), false);
    assert.equal(scopeWithinRequested(undefined, 'public_repo'), true);
  });

  test('grant revocation failure falls back to token revocation', async () => {
    mockFetch([
      ['https://github.com/login/oauth/access_token', () => json({ access_token: 'gho_wide', scope: 'repo', token_type: 'bearer' })],
      ['https://api.github.com/applications/', (url) => new Response(null, { status: url.endsWith('/grant') ? 404 : 204 })],
    ]);
    const res = await callbackFn.onRequestGet(callbackCtx());
    assert.equal(res.status, 403);
    const urls = githubCalls().map((c) => c.url);
    assert.ok(urls.some((u) => u.endsWith('/grant')) && urls.some((u) => u.endsWith('/token')));
  });

  test('missing env -> 500 generic', async () => {
    for (const env of [{}, { ...ENV, GITHUB_CLIENT_SECRET: '' }]) {
      const res = await callbackFn.onRequestGet(callbackCtx({ env }));
      assert.equal(res.status, 500);
      const html = await res.text();
      assert.ok(!/GITHUB_CLIENT/.test(html));
    }
    assert.equal(githubCalls().length, 0);
  });

  test('POST -> 405', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callbackFn.onRequest(ctx(`${ORIGIN}/api/callback?code=a&state=${STATE}`, { method }));
      assert.equal(res.status, 405, method);
      assertApiHeaders(res);
    }
  });

  test('nonce differs per response', async () => {
    mockFetch([tokenOk('gho_a'), userRoute()]);
    const a = await callbackFn.onRequestGet(callbackCtx());
    const b = await callbackFn.onRequestGet(callbackCtx());
    assert.notEqual(a.headers.get('content-security-policy'), b.headers.get('content-security-policy'));
  });
});

describe('helpers', () => {
  test('timingSafeEqual', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
    assert.equal(timingSafeEqual('', ''), true);
    assert.equal(timingSafeEqual('a', ''), false);
  });

  test('parseAllowedUsers', () => {
    assert.deepEqual(parseAllowedUsers({ ALLOWED_GITHUB_USERS: ' 11Lucie , Ivona-M ' }), ['11lucie', 'ivona-m']);
    assert.equal(parseAllowedUsers({}), null);
    assert.equal(parseAllowedUsers({ ALLOWED_GITHUB_USERS: 'a--b' }), null);
    assert.equal(parseAllowedUsers({ ALLOWED_GITHUB_USERS: 'x'.repeat(40) }), null);
    assert.deepEqual(parseAllowedUsers({ ALLOWED_GITHUB_USERS: 'x'.repeat(39) }), ['x'.repeat(39)]);
  });
});

// ------------------------------------------------------------------ admin static files
describe('admin static files', () => {
  const admin = (f) => readFileSync(path.join(ROOT, 'static', 'admin', f), 'utf8');
  const sriOf = (f) => 'sha384-' + createHash('sha384').update(readFileSync(path.join(ROOT, 'static', 'admin', f))).digest('base64');

  test('index.html: noindex, no-referrer, no inline script, SRI matches manual-init, the vendored bundle and the publish guard', () => {
    const html = admin('index.html');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 3);
    for (const s of scripts) assert.equal(s[2].trim(), '', 'no inline script');
    assert.match(scripts[0][1], /src="\/admin\/manual-init\.js"/, 'manual init before Decap (Decap must not start on its own)');
    assert.match(scripts[1][1], /src="\/admin\/decap-cms\.js"/);
    assert.match(scripts[2][1], /src="\/admin\/publish-guard\.js"/, 'guard loads after Decap and starts it');
    assert.equal(scripts[0][1].match(/integrity="(sha384-[^"]+)"/)[1], sriOf('manual-init.js'));
    assert.equal(scripts[1][1].match(/integrity="(sha384-[^"]+)"/)[1], sriOf('decap-cms.js'));
    assert.equal(scripts[2][1].match(/integrity="(sha384-[^"]+)"/)[1], sriOf('publish-guard.js'));
    assert.ok(!/https?:\/\//.test(html), 'no external resources');
  });

  test('manual-init.js only sets CMS_MANUAL_INIT; Decap honours the flag and the guard calls CMS.init()', () => {
    const code = admin('manual-init.js').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
    assert.deepEqual(code, ['window.CMS_MANUAL_INIT = true;']);
    const bundle = readFileSync(path.join(ROOT, 'static', 'admin', 'decap-cms.js'), 'latin1');
    assert.ok(bundle.includes('window.CMS_MANUAL_INIT?console.log("`window.CMS_MANUAL_INIT` flag set, skipping automatic initialization."):'), 'Decap reads the flag');
    assert.ok(bundle.includes('invokePostSaveEvent(l.get("entry"))'), 'Decap fires postSave after saving (also in editorial workflow)');
    assert.ok(bundle.includes('body:JSON.stringify({commit_message:wv,sha:e.head.sha,merge_method:this.mergeMethod})'), 'Decap merges with the head SHA');
    assert.match(admin('publish-guard.js'), /window\.CMS\.init\(\);/);
    const headers = readFileSync(path.join(ROOT, 'headers', 'admin.txt'), 'utf8');
    for (const f of ['decap-cms.js', 'publish-guard.js', 'manual-init.js']) {
      assert.match(headers, new RegExp(`^/admin/${f.replace(/\./g, '\\.')}\\n  ! Cache-Control\\n  Cache-Control: no-cache$`, 'm'), f);
    }
  });

  test('config.yml: production settings, no markdown/html widgets, no local_backend', () => {
    const yml = admin('config.yml');
    assert.ok(!/^\s*local_backend/m.test(yml));
    assert.ok(!/open_authoring/.test(yml));
    assert.match(yml, /^publish_mode: editorial_workflow$/m);
    assert.match(yml, /^\s+repo: 11Lucie\/zabavadeti$/m);
    assert.match(yml, /^\s+auth_endpoint: api\/auth$/m);
    assert.match(yml, /^\s+base_url: https:\/\/www\.zabavadeti\.cz$/m);
    assert.match(yml, /^locale: cs$/m);
    assert.ok(!/widget:\s*(markdown|html|code|file)\b/.test(yml));
    const widgets = new Set([...yml.matchAll(/widget:\s*(\w+)/g)].map((m) => m[1]));
    for (const w of widgets) assert.ok(['string', 'text', 'list', 'object', 'select', 'image'].includes(w), w);
    assert.equal((yml.match(/choose_url: false/g) || []).length, (yml.match(/widget: image/g) || []).length);
    for (const f of ['nastaveni', 'uvod', 'sluzby', 'o-mne', 'reference', 'kontakt']) {
      assert.ok(yml.includes(`file: content/${f}.json`), f);
    }
  });

  test('config.yml patterns are valid regexes and behave as expected', () => {
    const yml = admin('config.yml');
    const pats = Object.fromEntries(
      [...yml.matchAll(/name: (\w+)\n(?:\s+\w+:.*\n)*?\s+pattern: \['([^']+)'/g)].map((m) => [m[1], new RegExp(m[2])]),
    );
    assert.ok(pats.telefon.test('+420 739 039 559'));
    assert.ok(!pats.telefon.test('739-039-559<script>'));
    assert.ok(pats.email.test('ivona@seznam.cz'));
    assert.ok(pats.email.test('ivona.husakova@seznam.cz'));
    for (const bad of ['ivona@seznam', 'spy%40evil.cz%2Civona@seznam.cz', 'a,b@seznam.cz', 'a?cc=x@seznam.cz', 'a&b@seznam.cz', '.jana@seznam.cz', 'jana.@seznam.cz', 'jana..x@seznam.cz']) {
      assert.ok(!pats.email.test(bad), bad);
    }
    assert.ok(pats.facebook.test(''));
    assert.ok(pats.facebook.test('https://www.facebook.com/zabavadeti'));
    assert.ok(pats.facebook.test('https://www.facebook.com/share/g/1AbC/'));
    for (const bad of [
      'javascript:alert(1)',
      'https://www.facebook.com.evil.cz/x',
      'https://www.facebook.com/l.php?u=https%3A%2F%2Fevil.example%2F',
      'https://www.facebook.com/dialog/feed?redirect_uri=x',
      'https://www.facebook.com/flx/warn/?u=x',
      'https://www.facebook.com/' + 'x'.repeat(300),
    ]) {
      assert.ok(!pats.facebook.test(bad), bad);
    }
    assert.ok(pats.seo_popis.test('x'.repeat(160)));
    assert.ok(!pats.seo_popis.test('x'.repeat(161)));
  });

  test('vendored license files are present', () => {
    assert.ok(existsSync(path.join(ROOT, 'static', 'admin', 'LICENSE-decap-cms.txt')));
  });
});
