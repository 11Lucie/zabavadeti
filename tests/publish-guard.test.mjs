// Tests of static/admin/publish-guard.js – the check in the administration that binds publishing
// to the exact commit the administrator saved, allows only the published page's content file and
// new photos, guards the merge request itself and starts Decap (CMS.init) only after that.
// The browser script is evaluated in a node:vm sandbox with fake window, CMS and fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'static', 'admin', 'publish-guard.js'), 'utf8');
const REPO = '11Lucie/zabavadeti';
const API = 'https://api.github.com';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BRANCH_REF = `/repos/${REPO}/git/refs/heads/${encodeURIComponent('cms/stranky/uvod')}`;

function response(status, body) {
  const res = { status, ok: status >= 200 && status < 300, json: async () => body };
  res.clone = () => response(status, body);
  return res;
}

function load({ routes = {}, token = 'gho_t', withCms = true, manualInit = true, storageThrows = false } = {}) {
  const handlers = {};
  const calls = [];
  const local = new Map();
  const session = new Map();
  let inits = 0;
  const removed = [];
  if (token !== null) local.set('decap-cms-user', JSON.stringify({ token, backendName: 'github' }));
  const notice = { parentNode: { removeChild: (n) => removed.push(n) } };
  const window = {
    __publishGuardTest: {},
    Response,
    console: { error: () => {} },
    localStorage: { getItem: (k) => local.get(k) ?? null },
    document: { getElementById: (id) => (id === 'nacitani' ? notice : null) },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const p = url.slice(API.length);
      const method = (init.method ?? 'GET').toUpperCase();
      const r = routes[`${method} ${p}`] ?? (method === 'GET' ? routes[p] : undefined);
      if (!r) return response(404, {});
      const body = typeof r === 'function' ? r(calls.length, init) : r;
      // { status: 401 } etc. = GitHub answers with an HTTP error
      if (body && typeof body.httpStatus === 'number') return response(body.httpStatus, { message: 'error' });
      return response(200, body);
    },
  };
  if (storageThrows) {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } });
  } else {
    window.sessionStorage = {
      getItem: (k) => session.get(k) ?? null,
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: (k) => session.delete(k),
    };
  }
  if (manualInit) window.CMS_MANUAL_INIT = true;
  if (withCms) {
    window.CMS = {
      registerEventListener: (h) => {
        (handlers[h.name] ??= []).push(h.handler);
      },
      init: () => {
        inits++;
      },
    };
  }
  vm.runInNewContext(SOURCE, { window, URL, Error, JSON, Array, Object, encodeURIComponent, decodeURIComponent, String, Date, Promise });
  return { window, handlers, calls, api: window.__publishGuardTest, session, inits: () => inits, removed };
}

const entry = (collection = 'stranky', slug = 'uvod') => ({ get: (k) => ({ collection, slug })[k] });

function prRoutes({ files, headShas = [SHA_A], headRepo = REPO, ref = 'cms/stranky/uvod', changed = files.length, list } = {}) {
  let n = 0;
  const pr = () => ({
    number: 7,
    head: { sha: headShas[Math.min(n++, headShas.length - 1)], ref, repo: { full_name: headRepo } },
    base: { ref: 'main' },
    changed_files: changed,
  });
  return {
    [`/repos/${REPO}/pulls?state=open&base=main&head=${encodeURIComponent('11Lucie:cms/stranky/uvod')}&per_page=10`]: list ?? [{ number: 7 }],
    [`/repos/${REPO}/pulls/7`]: pr,
    [`/repos/${REPO}/pulls/7/files?per_page=100&page=1`]: files,
    [`PATCH ${BRANCH_REF}`]: { ref: 'refs/heads/cms/stranky/uvod', object: { sha: SHA_A } },
    [`POST /repos/${REPO}/git/refs`]: { ref: 'refs/heads/cms/stranky/uvod', object: { sha: SHA_A } },
    [`PUT /repos/${REPO}/pulls/7/merge`]: { merged: true },
  };
}

const OK_FILES = [{ filename: 'content/uvod.json', status: 'modified' }, { filename: 'static/uploads/oslava-2026.jpg', status: 'added' }];

// What Decap does when the administrator saves: writes the branch, then fires postSave.
async function save(g, { method = 'PATCH' } = {}) {
  if (method === 'PATCH') {
    await g.window.fetch(API + BRANCH_REF, { method: 'PATCH', body: JSON.stringify({ sha: SHA_A, force: true }) });
  } else {
    await g.window.fetch(`${API}/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/cms/stranky/uvod', sha: SHA_A }) });
  }
  for (const h of g.handlers.postSave) await h({ entry: entry(), author: { login: '11Lucie' } });
}
// A merge the guard stops never reaches GitHub: Decap gets a synthetic 409 with the reason
// (an HTTP error is shown at once; a rejected fetch would be retried 5 times by Decap).
async function assertBlocked(promise, message) {
  const res = await promise;
  assert.equal(res.status, 409, message);
  assert.equal(res.ok, false, message);
  assert.match(res.headers.get('Content-Type'), /application\/json/, message);
  assert.match((await res.json()).message, /^Zveřejnění zastaveno: /, message);
}

const publish = (g, e = entry()) => g.handlers.prePublish[0]({ entry: e, author: { login: '11Lucie' } });
const merge = (g, sha = SHA_A, number = 7) =>
  g.window.fetch(`${API}/repos/${REPO}/pulls/${number}/merge`, { method: 'PUT', body: JSON.stringify({ commit_message: 'x', sha, merge_method: 'squash' }) });

describe('pojistka zveřejnění (publish-guard.js)', () => {
  test('zaregistruje prePublish, postSave a postPublish a teprve potom spustí administraci', () => {
    const g = load();
    assert.equal(g.handlers.prePublish.length, 1);
    assert.equal(g.handlers.postSave.length, 1);
    assert.equal(g.handlers.postPublish.length, 1);
    assert.equal(g.handlers.preSave.length, 1);
    assert.equal(g.inits(), 1, 'CMS.init() zavolán právě jednou');
    assert.equal(g.removed.length, 1, 'hláška „Načítám administraci“ zmizí');
  });

  test('bez manual-init.js (Decap už běží) se CMS.init nevolá podruhé', () => {
    const g = load({ manualInit: false });
    assert.equal(g.inits(), 0);
    assert.equal(g.handlers.prePublish.length, 1, 'kontroly se přesto zaregistrují');
  });

  test('bez CMS se nic nespustí a nespadne', () => {
    assert.doesNotThrow(() => load({ withCms: false }));
  });

  test('checkFiles: jen soubor zveřejňované stránky (upravený) a nové fotky', () => {
    const { api } = load();
    assert.equal(api.checkFiles(OK_FILES, 'content/uvod.json').length, 0);
    for (const f of [
      { filename: 'content/kontakt.json', status: 'modified' }, // jiná stránka než ta zveřejňovaná
      { filename: 'content/uvod.json', status: 'removed' },
      { filename: 'content/uvod.json', status: 'added' },
      { filename: 'content/uvod.json', status: 'renamed', previous_filename: 'build.mjs' },
      { filename: 'static/uploads/oslava-2026.jpg', status: 'modified' }, // přepsání existující fotky
      { filename: 'static/uploads/oslava-2026.jpg', status: 'removed' },
      { filename: 'build.mjs', status: 'modified' },
      { filename: 'wrangler.toml', status: 'added' },
      { filename: 'wrangler.jsonc', status: 'added' },
      { filename: '.npmrc', status: 'added' },
      { filename: 'package.json', status: 'modified' },
      { filename: 'functions/api/callback.js', status: 'modified' },
      { filename: 'static/_worker.js', status: 'added' },
      { filename: 'static/admin/index.html', status: 'modified' },
      { filename: 'headers/site.txt', status: 'modified' },
      { filename: 'content/sub/x.json', status: 'added' },
      { filename: 'static/uploads/x.svg', status: 'added' },
      { filename: 'static/uploads/../../build.mjs', status: 'added' },
      { filename: '.github/workflows/x.yml', status: 'added' },
    ]) {
      assert.ok(api.checkFiles([f], 'content/uvod.json').length > 0, JSON.stringify(f));
    }
  });

  test('vlastní uložení a hned zveřejnění projde; sloučí se jen ověřený commit, jednou', async () => {
    for (const method of ['PATCH', 'POST']) {
      const g = load({ routes: prRoutes({ files: OK_FILES }) });
      await save(g, { method });
      await publish(g);
      const res = await merge(g, SHA_A);
      assert.equal(res.status, 200, method);
      await assertBlocked(merge(g, SHA_A), 'schválení platí jen pro jedno sloučení');
      const gets = g.calls.filter((c) => (c.init.method ?? 'GET') === 'GET');
      assert.ok(gets.every((c) => c.init.headers.Authorization === 'Bearer gho_t' && c.init.credentials === 'omit'));
    }
  });

  test('zapamatované uložení přežije obnovení stránky (sessionStorage)', async () => {
    const g = load({ routes: prRoutes({ files: OK_FILES }) });
    await save(g);
    const again = load({ routes: prRoutes({ files: OK_FILES }) });
    for (const [k, v] of g.session) again.session.set(k, v);
    await again.handlers.prePublish[0]({ entry: entry() });
  });

  test('bez sessionStorage funguje pojistka jen z paměti', async () => {
    const g = load({ routes: prRoutes({ files: OK_FILES }), storageThrows: true });
    await save(g);
    await publish(g);
  });

  test('návrh, který se v tomto okně neuložil (jiný účet, jiné okno), zveřejnit nejde', async () => {
    const g = load({ routes: prRoutes({ files: OK_FILES }) });
    await assert.rejects(publish(g), /v tomto okně administrace neuložil/);
  });

  test('commit přidaný nebo větev přepsaná po uložení (i z jiného účtu) zveřejnění zastaví', async () => {
    const g = load({ routes: prRoutes({ files: OK_FILES, headShas: [SHA_B] }) });
    await save(g);
    await assert.rejects(publish(g), /od posledního uložení v tomto okně změnil/);
  });

  test('uložení bez zachyceného zápisu větve (neúspěšný zápis) se nezapamatuje', async () => {
    const routes = prRoutes({ files: OK_FILES });
    delete routes[`PATCH ${BRANCH_REF}`];
    const g = load({ routes });
    await save(g);
    await assert.rejects(publish(g), /neuložil/);
  });

  test('smazání větve nebo zveřejnění zapamatované uložení zapomene', async () => {
    const g = load({ routes: { ...prRoutes({ files: OK_FILES }), [`DELETE ${BRANCH_REF}`]: {} } });
    await save(g);
    await g.window.fetch(API + BRANCH_REF, { method: 'DELETE' });
    await assert.rejects(publish(g), /neuložil/);
    const h = load({ routes: prRoutes({ files: OK_FILES }) });
    await save(h);
    await h.handlers.postPublish[0]({ entry: entry() });
    await assert.rejects(publish(h), /neuložil/);
  });

  test('sloučení bez kontroly, s jiným SHA nebo jiného návrhu pojistka GitHubu vůbec nepošle', async () => {
    const g = load({ routes: prRoutes({ files: OK_FILES }) });
    await assertBlocked(merge(g, SHA_A), 'bez kontroly');
    await save(g);
    await publish(g);
    await assertBlocked(merge(g, SHA_B), 'jiné SHA než ověřené (změna mezi kontrolou a sloučením)');
    await save(g);
    await publish(g);
    await assertBlocked(merge(g, SHA_A, 8), 'jiný návrh');
    await assertBlocked(g.window.fetch(`${API}/repos/${REPO}/pulls/7/merge`, { method: 'PUT', body: '{}' }), 'bez SHA');
    const before = g.calls.filter((c) => /\/merge$/.test(c.url)).length;
    assert.equal(before, 0, 'žádný požadavek na sloučení neodešel');
  });

  test('návrh s kódem nebo s jinou stránkou zveřejnění zastaví', async () => {
    for (const extra of [
      { filename: 'functions/api/callback.js', status: 'modified' },
      { filename: 'wrangler.toml', status: 'added' },
      { filename: 'content/kontakt.json', status: 'modified' },
      { filename: 'static/uploads/stara.jpg', status: 'modified' },
    ]) {
      const g = load({ routes: prRoutes({ files: [OK_FILES[0], extra] }) });
      await save(g);
      await assert.rejects(publish(g), new RegExp(extra.filename.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }
  });

  test('fail closed: chybí token, chyba API, cizí repozitář, neúplný seznam, změna během kontroly, neznámá stránka', async () => {
    const cases = [
      load({ token: null, routes: prRoutes({ files: OK_FILES }) }),
      load({ routes: {} }),
      load({ routes: prRoutes({ files: OK_FILES, headRepo: 'attacker/zabavadeti' }) }),
      load({ routes: prRoutes({ files: OK_FILES, ref: 'cms/stranky/jine' }) }),
      load({ routes: prRoutes({ files: OK_FILES, changed: 5 }) }),
      load({ routes: prRoutes({ files: OK_FILES, headShas: [SHA_A, SHA_B] }) }),
      load({ routes: prRoutes({ files: OK_FILES, list: [] }) }),
      load({ routes: prRoutes({ files: OK_FILES, list: [{ number: 7 }, { number: 8 }] }) }),
    ];
    for (const [i, c] of cases.entries()) {
      await save(c);
      await assert.rejects(publish(c), /Zveřejnění zastaveno/, `case ${i}`);
      await assertBlocked(merge(c, SHA_A), `merge after failed check, case ${i}`);
    }
    await assert.rejects(publish(load(), { get: () => undefined }), /Zveřejnění zastaveno/);
    await assert.rejects(publish(load(), entry('stranky', 'neexistuje')), /neznámá stránka/);
    await assert.rejects(publish(load(), entry('jina', 'uvod')), /neznámá stránka/);
  });

  test('vypršelé přihlášení (401 z GitHubu) radí odhlásit se a přihlásit znovu, jiná chyba zkusit později', async () => {
    const PR_LIST = `/repos/${REPO}/pulls?state=open&base=main&head=${encodeURIComponent('11Lucie:cms/stranky/uvod')}&per_page=10`;
    for (const [route, status] of [[PR_LIST, 401], [`/repos/${REPO}/pulls/7`, 401], [`/repos/${REPO}/pulls/7/files?per_page=100&page=1`, 401]]) {
      const g = load({ routes: { ...prRoutes({ files: OK_FILES }), [route]: { httpStatus: status } } });
      await save(g);
      await assert.rejects(publish(g), (e) => {
        assert.match(e.message, /^Zveřejnění zastaveno: přihlášení vypršelo – odhlaste se .* a přihlaste znovu/);
        assert.ok(!/za chvíli/.test(e.message), 'u vypršelého přihlášení neradit „zkuste to za chvíli“');
        return true;
      }, route);
      await assertBlocked(merge(g, SHA_A), 'po 401 se nesmí sloučit');
    }
    for (const status of [403, 500, 502]) {
      const g = load({ routes: { ...prRoutes({ files: OK_FILES }), [PR_LIST]: { httpStatus: status } } });
      await save(g);
      await assert.rejects(publish(g), new RegExp(`chybou \\(${status}\\)\\. Zkuste to za chvíli znovu`), String(status));
    }
  });

  test('hlášky a komentáře pojistky jsou neutrální (režim jen admin i s editorkou)', () => {
    const messages = [...SOURCE.matchAll(/(?:fail|blocked)\(([\s\S]*?)\);/g)].map((m) => m[1]).join('\n');
    assert.ok(messages.includes('přihlášení vypršelo'), 'hlášky se načetly');
    assert.ok(!/Ivon|editork|správkyn|neuložila|viděla/.test(messages), messages);
    assert.ok(!/Ivon/.test(SOURCE), 'pojistka nezná jména');
  });

  test('bez Response (starý prohlížeč) se zablokované sloučení odmítne chybou', async () => {
    const g = load({ routes: prRoutes({ files: OK_FILES }) });
    delete g.window.Response;
    await assert.rejects(merge(g, SHA_A), /Zveřejnění zastaveno/);
  });

  test('Decap odpověď 409 neopakuje a ukáže ji hned (ověřeno ve vendorovaném balíku)', () => {
    const bundle = readFileSync(path.join(ROOT, 'static', 'admin', 'decap-cms.js'), 'latin1');
    // requestWithBackoff: only a thrown error is retried (up to 5×); of HTTP statuses only 429 and
    // the GitHub rate limit (403 "API rate limit exceeded") are turned into errors.
    assert.ok(bundle.includes('if(429===i.status){const e=await i.text().catch(()=>"Too many requests");throw new Error(e)}if(403===i.status){'), 'backoff jen pro 429/403');
    assert.ok(bundle.includes('catch(r){if(n>5||"Can\'t refresh access token when using implicit auth"===r.message)throw r;'), 'opakuje jen vyhozenou chybu');
    // GitHub API: JSON error body -> APIError(message, status); mergePR handles only 405 (force merge).
    assert.ok(bundle.includes('parseResponse(e){const t=e.headers.get("Content-Type");return t&&t.match(/json/)?this.parseJsonResponse(e)'));
    assert.ok(bundle.includes('parseJsonResponse(e){return e.json().then(t=>e.ok?t:Promise.reject(t))}'));
    assert.ok(bundle.includes('catch(t){if(t instanceof Zp&&405===t.status)return this.forceMergePR(e);throw t}'), 'mergePR: 409 se jen předá dál');
  });

  test('před uložením (preSave): neplatné IČO, fotka služby bez popisu a reference bez původu uložení zastaví', () => {
    const g = load();
    assert.equal(g.handlers.preSave.length, 1);
    const save = (slug, data, collection = 'stranky') => g.handlers.preSave[0]({
      entry: { get: (k) => ({ collection, slug, data: { toJS: () => data } })[k] },
    });
    assert.equal(save('provozovatel', { ico: '00718131' }), undefined);
    assert.throws(() => save('provozovatel', { ico: '00718132' }), /Neuloženo: IČO 00718132 není platné/);
    assert.equal(save('provozovatel', { ico: '123' }), undefined, 'tvar IČO hlídá pattern v config.yml');
    assert.equal(save('sluzby', { polozky: [{ nazev: 'A' }, { nazev: 'B', fotka: '/uploads/b.jpg', fotka_popis: 'B' }] }), undefined);
    assert.throws(() => save('sluzby', { polozky: [{ nazev: 'A' }, { nazev: 'Maskoti', fotka: '/uploads/b.jpg', fotka_popis: ' ' }] }), /Služba č\. 2 \(„Maskoti“\) má fotku, ale chybí popis fotky/);
    assert.throws(() => save('reference', { polozky: [{ autor: 'Jana' }], overeni: '' }), /Odkud reference pocházejí/);
    assert.equal(save('reference', { polozky: [], overeni: '' }), undefined);
    assert.equal(save('provozovatel', { ico: '00718132' }, 'jina'), undefined, 'jiná kolekce');
    assert.equal(g.handlers.preSave[0]({}), undefined, 'neznámý tvar dat uložení neblokuje');
    assert.equal(g.handlers.preSave[0]({ entry: { get: () => { throw new Error('x'); } } }), undefined);
  });

  test('ostatní požadavky (čtení, zápisy jiných větví, jiné weby) projdou beze změny', async () => {
    const g = load({ routes: { '/user': { login: '11Lucie' } } });
    assert.equal((await g.window.fetch(`${API}/user`)).status, 200);
    assert.equal((await g.window.fetch('https://www.zabavadeti.cz/admin/config.yml')).status, 404);
    assert.equal(g.calls.length, 2);
  });
});
