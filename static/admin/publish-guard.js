// Pojistka zveřejnění v administraci (náš vlastní soubor, ne součást Decap CMS).
//
// Decap při „Publish“ sloučí CELOU větev návrhu cms/… – i soubory, které v administraci vůbec
// nejsou vidět (kód webu, functions/, build.mjs, wrangler.toml …), a i commity přidané po
// kontrole. Pojistka proto:
//
// 1. Po každém uložení v administraci (událost postSave) si zapamatuje přesný commit (SHA), který
//    administrace sama do větve zapsala. Zjistí ho z odpovědi GitHubu na zápis větve, ne z
//    dodatečného dotazu, takže ho nejde podstrčit.
// 2. Těsně před zveřejněním (událost prePublish) ověří přes API GitHubu, že:
//    - návrh je otevřený pull request z větve cms/<kolekce>/<stránka> tohoto repozitáře,
//    - jeho poslední commit je PŘESNĚ ten, který se v tomto okně administrace uložil (cokoli, co
//      do větve přibylo potom – i přepsání větve z jiného účtu nebo okna –, zveřejnění zastaví),
//    - mění jen soubor právě zveřejňované stránky (content/<stránka>.json) a přidává nové fotky
//      (static/uploads/…, jen „added“, žádné přepsání ani mazání existující fotky).
// 3. Hlídá samotné sloučení: Decap pošle GitHubu příkaz „merge“ s SHA, které musí sedět s tím,
//    co pojistka právě ověřila; jinak ho pojistka vůbec neodešle a Decapu vrátí odpověď 409
//    s vysvětlením (Decap ji ukáže hned, bez opakování požadavku). GitHub pak sloučí jen přesně
//    tento commit (když se větev mezitím změní, sloučení odmítne). Tím se zavírá okno mezi
//    kontrolou a sloučením.
// 4. Spouští administraci: index.html načte nejdřív manual-init.js (CMS_MANUAL_INIT = true), takže
//    Decap čeká. Teprve tento soubor po registraci všech kontrol zavolá CMS.init(). Když se
//    pojistka nenačte (chyba SRI, 404), administrace se nespustí vůbec (fail closed).
// 5. Před uložením (událost preSave) zkontroluje pravidla, která config.yml neumí: kontrolní číslici
//    IČO, popis u fotky služby a text o původu referencí. Build je kontroluje také (src/validate.mjs).
//
// Když se kontrola nepodaří (výpadek, chybí nebo vypršelo přihlášení), zveřejnění se zastaví
// (fail closed). Je to obrana do hloubky, ne atomická záruka: hlavní pravidlo zůstává, že návrhy
// uložené jinde (jiným účtem, např. editorky, je-li přidaná, nebo v jiném okně) se zveřejňují na
// GitHubu po kontrole „Files changed“ (NAVOD.md, část D) a sloučení hlídá ruleset. Pojistka
// funguje stejně v režimu „jen admin“ i s editorkou.
(function () {
  'use strict';

  var REPO = '11Lucie/zabavadeti';
  var OWNER = REPO.split('/')[0];
  var BASE_BRANCH = 'main';
  var API = 'https://api.github.com';
  var API_HOST = 'api.github.com';
  var MAX_PAGES = 30; // GitHub vrací nejvýše 3000 souborů (30 × 100)
  var APPROVAL_TTL_MS = 2 * 60 * 1000;
  var STORAGE_PREFIX = 'zabavadeti-publish-guard:';

  // Stránky (kolekce „stranky“ v config.yml, typ files) a jejich soubory.
  // Musí odpovídat static/admin/config.yml (hlídá tests/config-sync.test.mjs).
  var ENTRY_FILES = {
    stranky: {
      nastaveni: 'content/nastaveni.json',
      uvod: 'content/uvod.json',
      sluzby: 'content/sluzby.json',
      'o-mne': 'content/o-mne.json',
      reference: 'content/reference.json',
      kontakt: 'content/kontakt.json',
      provozovatel: 'content/provozovatel.json',
    },
  };
  var UPLOAD_RE = /^static\/uploads\/[a-z0-9][a-z0-9._-]*\.(?:jpg|jpeg|png|webp)$/;

  var nativeFetch = typeof window.fetch === 'function' ? window.fetch : null;
  var written = Object.create(null); // větev -> SHA, které administrace v tomto okně zapsala
  var seenMemory = Object.create(null); // větev -> SHA uložené v tomto okně (záloha k sessionStorage)
  var approvals = Object.create(null); // "owner/repo#číslo" -> { sha, at }

  function fail(message) {
    throw new Error('Zveřejnění zastaveno: ' + message);
  }

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Path of the content file for an entry, or null. */
  function entryFile(collection, slug) {
    if (typeof collection !== 'string' || typeof slug !== 'string') return null;
    if (!own(ENTRY_FILES, collection) || !own(ENTRY_FILES[collection], slug)) return null;
    return ENTRY_FILES[collection][slug];
  }

  /**
   * Returns the list of problems (strings) for the files of a pull request.
   * Allowed: the content file of the published entry (modified) and new photos (added).
   */
  function checkFiles(files, contentFile) {
    var problems = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i] || {};
      var name = String(f.filename || '');
      if (f.previous_filename !== undefined) {
        problems.push(String(f.previous_filename) + ' (přejmenování)');
      } else if (typeof contentFile === 'string' && name === contentFile) {
        if (f.status !== 'modified') problems.push(name + ' (' + String(f.status) + ')');
      } else if (UPLOAD_RE.test(name)) {
        if (f.status !== 'added') problems.push(name + ' (' + String(f.status) + ', existující fotku nejde přepsat ani smazat)');
      } else {
        problems.push(name + ' (mimo text této stránky a nové fotky)');
      }
    }
    return problems;
  }

  function readToken() {
    try {
      var raw = window.localStorage.getItem('decap-cms-user');
      var user = raw ? JSON.parse(raw) : null;
      var t = user && (user.token || user.access_token);
      return typeof t === 'string' && t ? t : null;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ remembered saves

  function storage() {
    try {
      return window.sessionStorage || null;
    } catch (e) {
      return null;
    }
  }

  function rememberSeen(branch, sha) {
    seenMemory[branch] = sha;
    try {
      var s = storage();
      if (s) s.setItem(STORAGE_PREFIX + branch, sha);
    } catch (e) {
      // only memory then
    }
  }

  function forgetSeen(branch) {
    delete seenMemory[branch];
    try {
      var s = storage();
      if (s) s.removeItem(STORAGE_PREFIX + branch);
    } catch (e) {
      // nothing to do
    }
  }

  function readSeen(branch) {
    var fromMemory = own(seenMemory, branch) ? seenMemory[branch] : null;
    var fromStorage = null;
    try {
      var s = storage();
      fromStorage = s ? s.getItem(STORAGE_PREFIX + branch) : null;
    } catch (e) {
      fromStorage = null;
    }
    // When both exist they must agree (a different value in one of them = do not trust either).
    if (fromMemory && fromStorage && fromMemory !== fromStorage) return null;
    var sha = fromMemory || fromStorage;
    return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  // ------------------------------------------------------------------ GitHub API

  function api(path, token) {
    if (!nativeFetch) fail('prohlížeč neumí fetch.');
    return nativeFetch.call(window, API + path, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    }).then(function (res) {
      // 401 = the login token is no longer valid (GitHub OAuth tokens expire after 8 hours).
      if (res.status === 401) fail('přihlášení vypršelo – odhlaste se (vpravo nahoře) a přihlaste znovu, pak zveřejnění zopakujte.');
      if (res.status !== 200) fail('GitHub odpověděl chybou (' + res.status + '). Zkuste to za chvíli znovu.');
      return res.json();
    });
  }

  function entryOf(data) {
    var entry = data && data.entry;
    var collection = entry && entry.get && entry.get('collection');
    var slug = entry && entry.get && entry.get('slug');
    if (typeof collection !== 'string' || typeof slug !== 'string' || !collection || !slug) return null;
    return { collection: collection, slug: slug, branch: 'cms/' + collection + '/' + slug };
  }

  async function guard(data) {
    var e = entryOf(data);
    if (!e) fail('nepodařilo se zjistit, který návrh se zveřejňuje.');
    var contentFile = entryFile(e.collection, e.slug);
    if (!contentFile) fail('neznámá stránka „' + e.collection + '/' + e.slug + '“.');
    var token = readToken();
    if (!token) fail('chybí přihlášení. Odhlaste se a přihlaste znovu.');

    var head = encodeURIComponent(OWNER + ':' + e.branch);
    var list = await api('/repos/' + REPO + '/pulls?state=open&base=' + BASE_BRANCH + '&head=' + head + '&per_page=10', token);
    if (!Array.isArray(list) || list.length !== 1) fail('k návrhu se nenašel právě jeden otevřený pull request.');
    var number = list[0].number;
    if (typeof number !== 'number') fail('neplatná odpověď GitHubu.');

    var pr = await api('/repos/' + REPO + '/pulls/' + number, token);
    if (!pr || !pr.head || !pr.head.repo || pr.head.repo.full_name !== REPO || pr.head.ref !== e.branch ||
        !pr.base || pr.base.ref !== BASE_BRANCH) {
      fail('návrh nepochází z větve tohoto repozitáře.');
    }
    var sha = pr.head.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) fail('neplatná odpověď GitHubu.');

    // Bound to what was saved in this very window of the administration.
    var seen = readSeen(e.branch);
    if (!seen) {
      fail('tento návrh se v tomto okně administrace neuložil, takže pojistka neví, co v něm je. ' +
        'Návrh uložený jinde (jiným účtem nebo v jiném okně či dříve) zkontrolujte a zveřejněte na GitHubu (návod, část D). ' +
        'Vlastní návrh otevřete, upravte, uložte a hned zveřejněte.');
    }
    if (seen !== sha) {
      fail('návrh se od posledního uložení v tomto okně změnil (přibyla nebo se přepsala změna, která v administraci nebyla vidět). ' +
        'Nezveřejňujte ho a zkontrolujte ho na GitHubu (Files changed a Commits).');
    }

    var files = [];
    for (var page = 1; page <= MAX_PAGES; page++) {
      var batch = await api('/repos/' + REPO + '/pulls/' + number + '/files?per_page=100&page=' + page, token);
      if (!Array.isArray(batch)) fail('neplatná odpověď GitHubu.');
      files = files.concat(batch);
      if (batch.length < 100) break;
    }
    if (typeof pr.changed_files !== 'number' || files.length !== pr.changed_files) {
      fail('nepodařilo se načíst všechny změněné soubory návrhu.');
    }
    var problems = checkFiles(files, contentFile);
    if (problems.length) {
      fail('návrh mění i jiné soubory než text této stránky a nové fotky: ' + problems.slice(0, 5).join(', ') +
        (problems.length > 5 ? ' …' : '') + '. Nezveřejňujte ho a ozvěte se Claudovi – může jít o ukradený účet.');
    }

    // Did anything get pushed while we were checking?
    var again = await api('/repos/' + REPO + '/pulls/' + number, token);
    if (!again || !again.head || again.head.sha !== sha) fail('návrh se během kontroly změnil. Zkontrolujte ho znovu.');

    // Only this exact commit may be merged (checked in the fetch wrapper below).
    approvals[REPO.toLowerCase() + '#' + number] = { sha: sha, at: Date.now() };
  }

  // postSave: remember the commit the administration itself has just written to the branch.
  function rememberSave(data) {
    try {
      var e = entryOf(data);
      if (!e) return;
      var sha = own(written, e.branch) ? written[e.branch] : null;
      delete written[e.branch];
      if (sha) rememberSeen(e.branch, sha);
      else forgetSeen(e.branch);
    } catch (err) {
      if (window.console) window.console.error('Pojistka zveřejnění: uložení se nepodařilo zapamatovat.', err);
    }
  }

  function forgetAfterPublish(data) {
    var e = entryOf(data);
    if (e) forgetSeen(e.branch);
  }

  // ------------------------------------------------------------------ checks before saving

  // config.yml can only check each field on its own. Rules that depend on another field or need
  // a calculation are checked by the build (src/validate.mjs) – and here already when saving
  // (preSave), so that a draft which would stop the website from building cannot be saved at all.

  function isValidIco(v) {
    if (typeof v !== 'string' || !/^[0-9]{8}$/.test(v)) return false;
    var sum = 0;
    for (var i = 0; i < 7; i++) sum += Number(v.charAt(i)) * (8 - i);
    return (11 - (sum % 11)) % 10 === Number(v.charAt(7));
  }

  function blank(v) {
    return typeof v !== 'string' || v.trim() === '';
  }

  /** Problems (Czech sentences) of the data of one page, or []. */
  function checkEntryData(slug, d) {
    var problems = [];
    if (!d || typeof d !== 'object') return problems;
    if (slug === 'provozovatel' && typeof d.ico === 'string' && /^[0-9]{8}$/.test(d.ico) && !isValidIco(d.ico)) {
      problems.push('IČO ' + d.ico + ' není platné – nesedí kontrolní číslice (pravděpodobně překlep). Zkontrolujte ho podle živnostenského listu.');
    }
    if (slug === 'sluzby' && Array.isArray(d.polozky)) {
      for (var i = 0; i < d.polozky.length; i++) {
        var p = d.polozky[i];
        if (p && !blank(p.fotka) && blank(p.fotka_popis)) {
          problems.push('Služba č. ' + (i + 1) + (blank(p.nazev) ? '' : ' („' + p.nazev.trim() + '“)') + ' má fotku, ale chybí popis fotky.');
        }
      }
    }
    if (slug === 'reference' && Array.isArray(d.polozky) && d.polozky.length > 0 && blank(d.overeni)) {
      problems.push('Chybí text „Odkud reference pocházejí“ (vyžaduje ho zákon).');
    }
    return problems;
  }

  function checkBeforeSave(data) {
    var problems;
    try {
      var entry = data && data.entry;
      if (!entry || typeof entry.get !== 'function' || entry.get('collection') !== 'stranky') return undefined;
      var d = entry.get('data');
      problems = checkEntryData(entry.get('slug'), d && typeof d.toJS === 'function' ? d.toJS() : d);
    } catch (err) {
      return undefined; // unexpected shape – the build checks the content anyway
    }
    if (problems.length) throw new Error('Neuloženo: ' + problems.join(' ') + ' Opravte to a uložte znovu.');
    return undefined;
  }

  // ------------------------------------------------------------------ fetch wrapper

  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return null;
    }
  }

  function bodyJson(body) {
    if (typeof body !== 'string') return null;
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }

  // A blocked merge is answered by a synthetic HTTP 409 response instead of a network error: Decap
  // retries failed requests up to 5 times with growing pauses (about a minute), but passes an HTTP
  // error straight to the user (GitHub API: parseJsonResponse -> APIError with our message; mergePR
  // only treats 405 specially). Nothing is sent to GitHub either way.
  function blocked(message) {
    var text = 'Zveřejnění zastaveno: ' + message;
    if (typeof window.Response !== 'function') return Promise.reject(new Error(text));
    return Promise.resolve(new window.Response(JSON.stringify({ message: text }), {
      status: 409,
      statusText: 'Conflict',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
  }

  function guardedFetch(input, init) {
    var url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input);
    var method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    var u = null;
    try {
      u = new URL(url);
    } catch (e) {
      u = null;
    }
    if (!u || u.hostname.toLowerCase() !== API_HOST) return nativeFetch.apply(window, arguments);
    var path = u.pathname;

    // 1) Merging a pull request: only the commit the guard has just approved.
    var merge = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge\/?$/i.exec(path);
    if (merge && method !== 'GET' && method !== 'HEAD') {
      var owner = decode(merge[1]);
      var repo = decode(merge[2]);
      var key = owner && repo ? (owner + '/' + repo).toLowerCase() + '#' + merge[3] : '';
      var approval = own(approvals, key) ? approvals[key] : null;
      delete approvals[key];
      var body = bodyJson(init && init.body);
      var sha = body && typeof body.sha === 'string' ? body.sha : null;
      if (!approval || !sha || approval.sha !== sha || Date.now() - approval.at > APPROVAL_TTL_MS) {
        return blocked('sloučení návrhu neprošlo kontrolou pojistky (návrh se mezitím změnil nebo nebyl zkontrolován). Zkontrolujte ho na GitHubu.');
      }
      return nativeFetch.apply(window, arguments);
    }

    // 2) Writing a cms/… branch: remember the commit the administration itself wrote.
    var repoPath = '/repos/' + REPO.toLowerCase() + '/';
    if (path.toLowerCase().indexOf(repoPath) !== 0) return nativeFetch.apply(window, arguments);
    var rest = path.slice(repoPath.length);
    var branch = null;
    var refMatch = /^git\/refs\/heads\/(.+)$/.exec(rest);
    if (refMatch && (method === 'PATCH' || method === 'DELETE')) {
      branch = decode(refMatch[1]);
    } else if (/^git\/refs\/?$/.test(rest) && method === 'POST') {
      var created = bodyJson(init && init.body);
      var ref = created && typeof created.ref === 'string' ? created.ref : '';
      branch = ref.indexOf('refs/heads/') === 0 ? ref.slice('refs/heads/'.length) : null;
    }
    if (!branch || branch.indexOf('cms/') !== 0) return nativeFetch.apply(window, arguments);

    // Whatever happens next, the old value is no longer the head of the branch.
    delete written[branch];
    if (method === 'DELETE') {
      forgetSeen(branch);
      return nativeFetch.apply(window, arguments);
    }
    return nativeFetch.apply(window, arguments).then(function (res) {
      if (!res || !res.ok || typeof res.clone !== 'function') return res;
      return res.clone().json().then(function (j) {
        var s = j && j.object && j.object.sha;
        if (typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)) written[branch] = s;
      }, function () {
        // not JSON – nothing remembered, publishing from the administration will be refused
      }).then(function () {
        return res;
      });
    });
  }

  // ------------------------------------------------------------------ start

  if (typeof window.__publishGuardTest === 'object' && window.__publishGuardTest) {
    window.__publishGuardTest.checkFiles = checkFiles;
    window.__publishGuardTest.guard = guard;
    window.__publishGuardTest.entryFiles = ENTRY_FILES;
    window.__publishGuardTest.checkEntryData = checkEntryData;
    window.__publishGuardTest.checkBeforeSave = checkBeforeSave;
  }

  function showStartError() {
    if (window.console) window.console.error('Pojistka zveřejnění se nenačetla – administrace se z bezpečnostních důvodů nespustí.');
  }

  if (!nativeFetch || !window.CMS || typeof window.CMS.registerEventListener !== 'function') {
    showStartError();
    return;
  }
  try {
    window.fetch = guardedFetch;
    window.CMS.registerEventListener({ name: 'prePublish', handler: guard });
    window.CMS.registerEventListener({ name: 'preSave', handler: checkBeforeSave });
    window.CMS.registerEventListener({ name: 'postSave', handler: rememberSave });
    window.CMS.registerEventListener({ name: 'postPublish', handler: forgetAfterPublish });
  } catch (err) {
    showStartError();
    return;
  }
  // index.html loads manual-init.js first, so Decap waits for us. Without the flag Decap has
  // already started on its own (manual-init.js missing) – calling init again would break it.
  if (window.CMS_MANUAL_INIT === true && typeof window.CMS.init === 'function') {
    window.CMS.init();
    var doc = window.document;
    var notice = doc && doc.getElementById && doc.getElementById('nacitani');
    if (notice && notice.parentNode) notice.parentNode.removeChild(notice);
  } else if (window.console) {
    window.console.error('Pojistka zveřejnění: chybí manual-init.js, administrace se spustila bez čekání na pojistku.');
  }
})();
