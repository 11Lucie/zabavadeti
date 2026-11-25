// Verification of the Cloudflare Access token (header Cf-Access-Jwt-Assertion) inside the
// OAuth proxy. Cloudflare Access itself already guards /admin/* and /api/*; this is a second,
// independent check in our own code: if Access is ever switched off or misconfigured (deleted
// application, changed path, new domain), the proxy refuses to start or finish a login instead
// of silently working without it (fail closed).
//
// Configuration (Cloudflare Pages → Settings → Variables, prostředí Production):
//   ACCESS_TEAM_DOMAIN  e.g. "zabavadeti.cloudflareaccess.com" (název týmu v Zero Trust)
//   ACCESS_AUD          "Application Audience (AUD) Tag" of the Access application;
//                       several tags may be separated by commas.
// Missing configuration = every login is refused (HTTP 500, generic message).
//
// No dependencies: WebCrypto (RS256) only. Keys come from
// https://<team>/cdn-cgi/access/certs and are cached in memory.

const JWT_HEADER = 'Cf-Access-Jwt-Assertion';
const MAX_JWT_LENGTH = 8192;
const CLOCK_SKEW_S = 60;
const KEYS_TTL_MS = 60 * 60 * 1000;
const MIN_REFETCH_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_RE = /^[A-Za-z0-9]{16,128}$/;

let cache = { team: null, keys: new Map(), fetchedAt: 0 };

/** For tests only. */
export function _resetAccessCache() {
  cache = { team: null, keys: new Map(), fetchedAt: 0 };
}

function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validated Access configuration from env, or null when it is missing/invalid. */
export function accessConfig(env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '')
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '');
  if (!TEAM_RE.test(team)) return null;
  const auds = splitList(env.ACCESS_AUD);
  if (auds.length === 0 || !auds.every((a) => AUD_RE.test(a))) return null;
  return { team, auds };
}

function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function fetchKeys(team) {
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error('certs status');
  const data = await res.json();
  const keys = new Map();
  for (const jwk of Array.isArray(data?.keys) ? data.keys : []) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  if (keys.size === 0) throw new Error('no keys');
  cache = { team, keys, fetchedAt: Date.now() };
}

async function keyFor(team, kid) {
  const now = Date.now();
  const fresh = cache.team === team && now - cache.fetchedAt < KEYS_TTL_MS;
  if (fresh && cache.keys.has(kid)) return cache.keys.get(kid);
  // Unknown kid (key rotation) or stale cache: fetch again, but not more often than MIN_REFETCH_MS.
  if (!fresh || now - cache.fetchedAt >= MIN_REFETCH_MS) await fetchKeys(team);
  return cache.team === team ? cache.keys.get(kid) ?? null : null;
}

/**
 * Checks the Access JWT of the request.
 * Returns { ok: true } or { ok: false, reason: 'config' | 'denied' | 'unavailable' }.
 * Plain http on localhost/127.0.0.1 (local development with wrangler) is exempt.
 */
export async function verifyAccess(request, env, nowMs = Date.now()) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return { ok: false, reason: 'denied' };
  }
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return { ok: true };

  const cfg = accessConfig(env);
  if (!cfg) return { ok: false, reason: 'config' };

  const jwt = request.headers.get(JWT_HEADER) || '';
  if (!jwt || jwt.length > MAX_JWT_LENGTH) return { ok: false, reason: 'denied' };
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'denied' };

  let header;
  let payload;
  let signature;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
    signature = b64urlToBytes(parts[2]);
  } catch {
    return { ok: false, reason: 'denied' };
  }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'denied' };
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'denied' };

  let key;
  try {
    key = await keyFor(cfg.team, header.kid);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!key) return { ok: false, reason: 'denied' };

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'denied' };

  const now = Math.floor(nowMs / 1000);
  if (payload.iss !== `https://${cfg.team}`) return { ok: false, reason: 'denied' };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some((a) => typeof a === 'string' && cfg.auds.includes(a))) return { ok: false, reason: 'denied' };
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) return { ok: false, reason: 'denied' };
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_SKEW_S > now)) {
    return { ok: false, reason: 'denied' };
  }
  return { ok: true };
}
