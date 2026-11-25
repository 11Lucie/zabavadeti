// Tests of the website build, content validation, upload checks and the
// local preview server. Run: node --test tests/
//
// Every test that modifies content works on a temporary copy of the
// project data (content/, static/, headers/) – the real files are never
// touched.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';

import { build, BuildError, loadDesignAssets, rewriteCssUrls, ASSET_NAME_RE, PRELOAD_FONTS } from '../build.mjs';
import { validateContent, phoneToHref, isValidIco } from '../src/validate.mjs';
import { escapeHtml, jsonForScript } from '../src/escape.mjs';
import { checkUploads, checkHtml, inspectImage, checkFontFile, checkSvg } from '../scripts/check.mjs';
import { parseRequestPath, resolveFile, parseHeadersFile, headersFor, createServer } from '../scripts/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_FILES = ['nastaveni.json', 'uvod.json', 'sluzby.json', 'o-mne.json', 'reference.json', 'kontakt.json', 'provozovatel.json'];

const tempDirs = [];
async function tempDir(prefix = 'zabava-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
});

// Copy of the project data in a temporary directory (without the big
// vendored admin bundle, which the build only copies). emptyUploads: without the real photos
// (for tests of the upload check that list exactly the files they create).
async function tempProject({ emptyUploads = false } = {}) {
  const dir = await tempDir();
  await cp(join(ROOT, 'content'), join(dir, 'content'), { recursive: true });
  await cp(join(ROOT, 'headers'), join(dir, 'headers'), { recursive: true });
  await cp(join(ROOT, 'static'), join(dir, 'static'), {
    recursive: true,
    filter: (src) => !src.includes(`${join('static', 'admin')}`) && !(emptyUploads && /[\\/]uploads[\\/][^\\/]+\.(?:jpe?g|png|webp)$/i.test(src)),
  });
  return dir;
}

// Photos of the real content (read only) – validateContent needs them to accept content/*.json.
const REAL_IMAGES = (await checkUploads(ROOT)).images;

async function readContent(dir, file) {
  return JSON.parse(await readFile(join(dir, 'content', file), 'utf8'));
}
async function writeContent(dir, file, data) {
  await writeFile(join(dir, 'content', file), JSON.stringify(data, null, 2));
}
async function realRaw() {
  const raw = {};
  for (const f of CONTENT_FILES) raw[f] = JSON.parse(await readFile(join(ROOT, 'content', f), 'utf8'));
  return raw;
}

// --- tiny image fixtures -----------------------------------------------------

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(width = 4, height = 3) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height, 0xcc);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Minimal JPEG structure: SOI, optional APP1/EXIF with a GPS IFD, SOF0, EOI.
function makeJpeg({ width = 8, height = 6, gps = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (gps) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4);
    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4); // IFD0 offset
    tiff.writeUInt16LE(1, 8); // 1 entry
    tiff.writeUInt16LE(0x8825, 10); // GPS IFD pointer
    tiff.writeUInt16LE(4, 12); // LONG
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt32LE(26, 18); // GPS IFD at offset 26
    tiff.writeUInt32LE(0, 22); // next IFD
    tiff.writeUInt16LE(1, 26); // GPS IFD: 1 entry
    tiff.writeUInt16LE(0x0000, 28); // GPSVersionID
    tiff.writeUInt16LE(1, 30); // BYTE
    tiff.writeUInt32LE(4, 32);
    tiff.writeUInt32LE(0x00000202, 36);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const head = Buffer.from([0xff, 0xe1, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    parts.push(head, payload);
  }
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------

describe('escapování', () => {
  test('escapeHtml escapuje & < > " \'', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  test('jsonForScript neobsahuje < ani ukončení scriptu', () => {
    const out = jsonForScript({ a: '</script><script>alert(1)</script>', b: 'x & y' });
    assert.ok(!out.includes('<'));
    assert.ok(!out.includes('>'));
    assert.deepEqual(JSON.parse(out), { a: '</script><script>alert(1)</script>', b: 'x & y' });
  });

  test('nebezpečný obsah se ve výstupu objeví jen escapovaně', async () => {
    const dir = await tempProject();
    const XSS = '<script>alert(1)</script>';
    const ATTR = '" onerror="alert(1)';
    const uvod = await readContent(dir, 'uvod.json');
    uvod.nadpis = `Ahoj ${XSS}`;
    uvod.perex = `Perex ${ATTR} a <img src=x onerror=alert(1)>`;
    uvod.pro_koho = [XSS, `' onmouseover='alert(1)`];
    await writeContent(dir, 'uvod.json', uvod);
    const ref = await readContent(dir, 'reference.json');
    ref.polozky[0].autor = `</figcaption>${XSS}`;
    ref.polozky[0].text = `Text ${ATTR}`;
    await writeContent(dir, 'reference.json', ref);
    const nast = await readContent(dir, 'nastaveni.json');
    nast.seo_titulek = `</title>${XSS}`;
    nast.seo_popis = `${ATTR} </script>`;
    await writeContent(dir, 'nastaveni.json', nast);

    const out = await tempDir();
    await build({ root: dir, outDir: join(out, 'dist') });
    const page = await readFile(join(out, 'dist', 'index.html'), 'utf8');

    assert.ok(!page.includes(XSS), 'surový <script> se nesmí objevit');
    assert.ok(!page.includes('<img src=x'), 'surový <img> se nesmí objevit');
    assert.ok(!page.includes('" onerror="'), 'neescapovaná uvozovka + onerror');
    assert.ok(!page.includes("' onmouseover='"), 'neescapovaný apostrof + onmouseover');
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(page.includes('&quot; onerror=&quot;alert(1)'));
    assert.ok(page.includes('&#39; onmouseover=&#39;alert(1)'));
    // JSON-LD: description is escaped for the script context
    const ld = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    assert.ok(!ld.includes('<'));
    assert.equal(JSON.parse(ld).description, `${ATTR} </script>`);
    // and the built-in HTML check is happy
    assert.deepEqual(checkHtml(page, 'index.html'), []);
  });

  test('nebezpečný obsah v dalších polích (provozovatel, Facebook, reference, fotky, slogan) je escapovaný na všech stránkách', async () => {
    const dir = await tempProject();
    const XSS = '<script>alert(1)</script>';
    const IMG = '<img src=x onerror=alert(1)>';
    const ATTR = '" onerror="alert(1)';
    const prov = await readContent(dir, 'provozovatel.json');
    Object.assign(prov, { jmeno: `Ivona ${XSS}`, adresa: `Balinka ${IMG}, 594 42 Měřín`, zapis: `Zápis ${ATTR} ${XSS}` });
    await writeContent(dir, 'provozovatel.json', prov);
    const nast = await readContent(dir, 'nastaveni.json');
    Object.assign(nast, { facebook_text: `FB ${XSS}`, podtitul: `Měřín ${IMG}` });
    await writeContent(dir, 'nastaveni.json', nast);
    const ref = await readContent(dir, 'reference.json');
    ref.overeni = `Původ ${XSS} ${ATTR}`;
    await writeContent(dir, 'reference.json', ref);
    const sluzby = await readContent(dir, 'sluzby.json');
    const big = sluzby.polozky.find((p) => p.fotka);
    Object.assign(big, { nazev: `Maskoti ${ATTR}`, fotka_popis: `Foto ${ATTR} ${XSS}` });
    await writeContent(dir, 'sluzby.json', sluzby);
    const uvod = await readContent(dir, 'uvod.json');
    Object.assign(uvod, { slogan: `Slogan ${IMG}`, fotka_popis: `Hero ${ATTR}`, skolky: `Školky ${XSS}` });
    await writeContent(dir, 'uvod.json', uvod);

    const out = join(await tempDir(), 'dist');
    await build({ root: dir, outDir: out });
    for (const f of ['index.html', '404.html', 'ochrana-soukromi/index.html']) {
      const p = await readFile(join(out, f), 'utf8');
      assert.ok(!p.includes(XSS), `${f}: surový <script>`);
      assert.ok(!p.includes('<img src=x'), `${f}: surový <img>`);
      assert.ok(!p.includes('" onerror="'), `${f}: neescapovaná uvozovka + onerror`);
      assert.ok(p.includes('&lt;'), `${f}: obsah se vypsal escapovaně`);
      assert.deepEqual(checkHtml(p, f), [], f);
    }
  });
});

describe('validace obsahu', () => {
  let raw;
  before(async () => {
    raw = await realRaw();
  });
  const clone = () => structuredClone(raw);

  function expectError(data, fieldPart, images = REAL_IMAGES) {
    const { errors } = validateContent(data, images);
    assert.ok(errors.length > 0, 'očekávána chyba');
    const hit = errors.find((e) => (e.field ?? '').includes(fieldPart));
    assert.ok(hit, `chyba u pole ${fieldPart}; nalezeno: ${JSON.stringify(errors)}`);
    assert.ok(hit.message && hit.fix, 'chyba má zprávu i radu');
    return hit;
  }

  test('skutečný obsah projde', () => {
    const { errors, content } = validateContent(clone(), REAL_IMAGES);
    assert.deepEqual(errors, []);
    assert.equal(content.kontakt.telefon_href, '+420739039559');
  });

  test('telefon: odmítne písmena, HTML a krátká čísla', () => {
    for (const bad of ['abc', '+420 739 039 559<script>', '123', 'tel:+420739039559', '+420-739-039-559', '+420 739 039 559 ; javascript:alert(1)']) {
      const d = clone();
      d['kontakt.json'].telefon = bad;
      expectError(d, 'telefon');
    }
    assert.equal(phoneToHref('+420 739 039 559'), '+420739039559');
  });

  test('e-mail: odmítne neplatné adresy', () => {
    for (const bad of ['ivona@', 'ivona', 'a@b', 'mailto:ivona@seznam.cz', 'iv ona@seznam.cz', 'ivona@seznam..cz', '"><script>@x.cz', 'javascript:alert(1)']) {
      const d = clone();
      d['kontakt.json'].email = bad;
      expectError(d, 'email');
    }
  });

  test('facebook: jen https://www.facebook.com/ nebo https://facebook.com/', () => {
    const bads = [
      'javascript:alert(1)',
      'http://www.facebook.com/groups/1',
      'https://evil.com/facebook.com/',
      'https://www.facebook.com.evil.com/',
      'https://www.facebook.com@evil.com/',
      'https://m.facebook.com/x',
      '//www.facebook.com/x',
      'https://www.facebook.com/"onmouseover="alert(1)',
      'https://www.facebook.com:8080/x',
      ' https://www.facebook.com/x\njavascript:alert(1)',
    ];
    for (const bad of bads) {
      const d = clone();
      d['nastaveni.json'].facebook = bad;
      expectError(d, 'facebook');
    }
    for (const ok of ['', 'https://facebook.com/zabava', 'https://www.facebook.com/groups/698688478954254']) {
      const d = clone();
      d['nastaveni.json'].facebook = ok;
      assert.deepEqual(validateContent(d, REAL_IMAGES).errors, [], ok);
    }
  });

  test('fotka: odmítne ../, javascript:, cizí složky, velká písmena a neexistující soubor', () => {
    const images = new Map([...REAL_IMAGES, ['ivona.jpg', { width: 10, height: 10 }]]);
    const bads = [
      '/uploads/../secret.jpg',
      '/uploads/..%2fsecret.jpg',
      '../content/kontakt.json',
      'javascript:alert(1)',
      'https://example.com/a.jpg',
      '/admin/decap-cms.js',
      '/uploads/Foto.JPG',
      '/uploads/žirafa.jpg',
      '/uploads/obrazek.svg',
      '/uploads/neexistuje.jpg',
      '/uploads/ivona.jpg"onerror="x.jpg',
    ];
    for (const bad of bads) {
      const d = clone();
      d['uvod.json'].fotka = bad;
      expectError(d, 'fotka', images);
    }
    const d = clone();
    d['uvod.json'].fotka = '/uploads/ivona.jpg';
    const { errors, content } = validateContent(d, images);
    assert.deepEqual(errors, []);
    assert.deepEqual(content.uvod.fotka, { src: '/uploads/ivona.jpg', width: 10, height: 10 });
  });

  test('ikona: jen ze seznamu', () => {
    const d = clone();
    d['sluzby.json'].polozky[0].ikona = 'bomba';
    const e = expectError(d, 'ikona');
    assert.match(e.fix, /oblicej/);
  });

  test('povinná pole, typy, délky, neznámá pole a řídicí znaky', () => {
    let d = clone();
    d['uvod.json'].nadpis = '   ';
    expectError(d, 'nadpis');

    d = clone();
    d['kontakt.json'].telefon = 739039559;
    expectError(d, 'telefon');

    d = clone();
    d['nastaveni.json'].seo_popis = 'x'.repeat(161);
    const e = expectError(d, 'seo_popis');
    assert.match(e.fix, /1 znak/);

    d = clone();
    d['sluzby.json'].polozky[1].cena = '500 Kč';
    expectError(d, 'cena');

    d = clone();
    d['o-mne.json'].odstavce = [];
    expectError(d, 'odstavce');

    d = clone();
    d['uvod.json'].slogan = `Ahoj${String.fromCharCode(0x202e)}evil`;
    expectError(d, 'slogan');
  });

  test('build skončí chybou BuildError s českou hláškou', async () => {
    const dir = await tempProject();
    const k = await readContent(dir, 'kontakt.json');
    k.telefon = 'zavolej mi';
    await writeContent(dir, 'kontakt.json', k);
    const out = await tempDir();
    await assert.rejects(build({ root: dir, outDir: join(out, 'dist') }), (err) => {
      assert.ok(err instanceof BuildError);
      assert.match(err.message, /content\/kontakt\.json/);
      assert.match(err.message, /telefon/);
      assert.match(err.message, /Co udělat/);
      return true;
    });
    assert.ok(!existsSync(join(out, 'dist', 'index.html')), 'při chybě nevznikne web');
  });

  test('neplatný JSON dá srozumitelnou chybu', async () => {
    const dir = await tempProject();
    await writeFile(join(dir, 'content', 'uvod.json'), '{ "nadpis": "Ahoj", }');
    const out = await tempDir();
    await assert.rejects(build({ root: dir, outDir: join(out, 'dist') }), /není platný JSON/);
  });
});

describe('kontrola nahraných fotek', () => {
  test('rozpozná PNG a JPEG podle obsahu a zjistí rozměry', () => {
    assert.deepEqual(inspectImage(makePng(4, 3)), { type: 'png', width: 4, height: 3, gps: false });
    assert.deepEqual(inspectImage(makeJpeg({ width: 8, height: 6 })), { type: 'jpeg', width: 8, height: 6, gps: false });
    assert.equal(inspectImage(makeJpeg({ gps: true })).gps, true);
  });

  async function uploadsWith(files) {
    const dir = await tempProject({ emptyUploads: true });
    for (const [name, data] of Object.entries(files)) await writeFile(join(dir, 'static', 'uploads', name), data);
    return { dir, result: await checkUploads(dir) };
  }

  test('odmítne SVG (i převlečené za .jpg), HTML a jiné typy', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { result } = await uploadsWith({
      'obrazek.svg': svg,
      'falesny.jpg': svg,
      'stranka.png': '<!doctype html><script>alert(1)</script>',
      'dokument.pdf': '%PDF-1.4',
      'pismena.webp': 'RIFF....WEBX',
    });
    const where = result.errors.map((e) => e.where).sort();
    assert.deepEqual(where, [
      'static/uploads/dokument.pdf',
      'static/uploads/falesny.jpg',
      'static/uploads/obrazek.svg',
      'static/uploads/pismena.webp',
      'static/uploads/stranka.png',
    ]);
    assert.match(result.errors.find((e) => e.where.endsWith('falesny.jpg')).message, /SVG/);
    assert.equal(result.images.size, 0);
  });

  test('odmítne špatný název, nesoulad přípony a příliš velký soubor', async () => {
    const { result } = await uploadsWith({
      'Fotka.PNG': makePng(),
      'fotka s mezerou.png': makePng(),
      'png-jako.jpg': makePng(),
      'velka.png': Buffer.concat([makePng(), Buffer.alloc(5 * 1024 * 1024 + 1)]),
      'dobra.png': makePng(4, 3),
    });
    const bad = result.errors.map((e) => e.where).sort();
    assert.deepEqual(bad, ['static/uploads/Fotka.PNG', 'static/uploads/fotka s mezerou.png', 'static/uploads/png-jako.jpg', 'static/uploads/velka.png']);
    assert.deepEqual([...result.images.keys()], ['dobra.png']);
  });

  test('varuje před GPS souřadnicemi v JPEG', async () => {
    const { result } = await uploadsWith({ 'z-mobilu.jpg': makeJpeg({ gps: true }) });
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /GPS/);
  });

  test('build s SVG v uploads selže', async () => {
    const dir = await tempProject();
    await writeFile(join(dir, 'static', 'uploads', 'logo.svg'), '<svg onload="alert(1)"/>');
    const out = await tempDir();
    await assert.rejects(build({ root: dir, outDir: join(out, 'dist') }), (err) => err instanceof BuildError && /logo\.svg/.test(err.message));
  });

  test('platná fotka se na webu zobrazí s rozměry a alt textem', async () => {
    const dir = await tempProject();
    await writeFile(join(dir, 'static', 'uploads', 'ivona.png'), makePng(40, 50));
    const uvod = await readContent(dir, 'uvod.json');
    uvod.fotka = '/uploads/ivona.png';
    uvod.fotka_popis = 'Ivona "s maskoty"';
    await writeContent(dir, 'uvod.json', uvod);
    const omne = await readContent(dir, 'o-mne.json');
    omne.fotka = '/uploads/ivona.png';
    await writeContent(dir, 'o-mne.json', omne);
    const out = await tempDir();
    await build({ root: dir, outDir: join(out, 'dist') });
    const page = await readFile(join(out, 'dist', 'index.html'), 'utf8');
    assert.match(page, /<img class="photo" src="\/uploads\/ivona\.png" width="40" height="50" alt="Ivona &quot;s maskoty&quot;" decoding="async" fetchpriority="high">/);
    assert.match(page, /<img class="photo" src="\/uploads\/ivona\.png" width="40" height="50" alt="[^"]+" decoding="async" loading="lazy">/);
    assert.match(page, /<meta property="og:image" content="https:\/\/www\.zabavadeti\.cz\/uploads\/ivona\.png">/);
    assert.ok(existsSync(join(out, 'dist', 'uploads', 'ivona.png')));
  });
});

describe('výstup buildu', () => {
  let out;
  let files;
  before(async () => {
    const dir = await tempProject();
    out = join(await tempDir(), 'dist');
    ({ files } = await build({ root: dir, outDir: out }));
  });

  test('vzniknou všechny soubory a nic navíc', () => {
    for (const f of ['index.html', '404.html', 'robots.txt', 'sitemap.xml', '_headers', 'favicon.svg', 'site.webmanifest', '.well-known/security.txt']) {
      assert.ok(files.includes(f), f);
    }
    assert.ok(files.some((f) => /^assets\/styles\.[0-9a-f]{10}\.css$/.test(f)));
    assert.ok(!files.some((f) => /^(content|functions|lib|src|headers|scripts|tests|\.git)\//.test(f)), files.join(', '));
    assert.ok(!files.includes('uploads/.gitkeep'));
  });

  test('_headers obsahuje CSP a bezpečnostní hlavičky, admin pravidla až za webem', async () => {
    const h = await readFile(join(out, '_headers'), 'utf8');
    assert.match(h, /^\/\*$/m);
    assert.match(h, /Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'/);
    assert.match(h, /frame-ancestors 'none'/);
    assert.match(h, /Strict-Transport-Security: max-age=31536000; includeSubDomains/);
    assert.match(h, /X-Content-Type-Options: nosniff/);
    assert.match(h, /Permissions-Policy: .*camera=\(\).*geolocation=\(\).*microphone=\(\)/);
    // Long cache only for the exact fingerprinted files, not for /assets/* (404 pages).
    assert.match(h, /\n\/assets\/styles\.[0-9a-f]{10}\.css\n\s+Cache-Control: public, max-age=31536000, immutable/);
    assert.match(h, /\n\/assets\/theme\.[0-9a-f]{10}\.js\n\s+Cache-Control: public, max-age=31536000, immutable/);
    assert.ok(!/^\/assets\/\*/m.test(h), 'žádné pravidlo /assets/*');
    const csp = /^\s+Content-Security-Policy: (.*)$/m.exec(h)[1];
    assert.ok(!/connect-src/.test(csp), 'web nic nestahuje (žádné fetch/XHR)');
    // Vlastní písma a obrázky jen z vlastní domény (src/assets/ -> /assets/), nic z cizích serverů.
    assert.match(csp, /(?:^|; )font-src 'self'(?:;|$)/);
    assert.match(csp, /(?:^|; )img-src 'self'(?:;|$)/);
    assert.ok(!/https?:|data:|blob:|\*/.test(csp), 'žádné cizí zdroje, data: ani blob: v CSP');
    // Otisknutá písma a SVG ze src/assets mají dlouhou cache (pravidla přesně pro aktuální soubory).
    for (const name of ['baloo-latin', 'baloo-latin-ext', 'jakarta-latin', 'jakarta-latin-ext']) {
      assert.match(h, new RegExp('\\n/assets/' + name + '\\.[0-9a-f]{10}\\.woff2\\n\\s+Cache-Control: public, max-age=31536000, immutable'), name);
    }
    assert.match(h, /\n\/assets\/copy\.[0-9a-f]{10}\.js\n\s+Cache-Control: public, max-age=31536000, immutable/);
    // SVG otevřené samostatně je dokument: sandbox bez skriptů (konfety z buildu, favicon ze site.txt).
    assert.match(h, /\n\/assets\/konfety\.[0-9a-f]{10}\.svg\n\s+Cache-Control: public, max-age=31536000, immutable\n\s+! Content-Security-Policy\n\s+Content-Security-Policy: default-src 'none'; sandbox\n/);
    assert.match(h, /\n\/favicon\.svg\n\s+! Content-Security-Policy\n\s+Content-Security-Policy: default-src 'none'; sandbox\n/);
    const site = await readFile(join(ROOT, 'headers', 'site.txt'), 'utf8');
    assert.ok(h.replace(/\r/g, '').startsWith(site.replace(/\r/g, '')), 'site.txt je na začátku');
    if (existsSync(join(ROOT, 'headers', 'admin.txt'))) {
      assert.ok(h.indexOf('/admin/') > h.indexOf('/assets/styles.'), 'admin pravidla jsou za pravidly webu');
    }
  });

  test('stránky nemají inline styly, skripty ani on* atributy a odkazují na CSS s otiskem', async () => {
    for (const f of ['index.html', '404.html']) {
      const page = await readFile(join(out, f), 'utf8');
      assert.deepEqual(checkHtml(page, f), []);
      assert.match(page, /<html lang="cs">/);
      assert.match(page, /<link rel="stylesheet" href="\/assets\/styles\.[0-9a-f]{10}\.css">/);
      assert.equal((page.match(/<h1[\s>]/g) ?? []).length, 1, 'právě jeden h1');
      assert.ok(!/https?:\/\/(?!www\.zabavadeti\.cz|schema\.org|www\.facebook\.com|www\.w3\.org)/.test(page.replace(/xmlns="[^"]*"/g, '')), 'žádné cizí domény');
    }
    const index = await readFile(join(out, 'index.html'), 'utf8');
    assert.match(index, /<link rel="canonical" href="https:\/\/www\.zabavadeti\.cz\/">/);
    assert.match(index, /href="tel:\+420739039559"/);
    assert.match(index, /rel="noopener noreferrer"/);
    const notFound = await readFile(join(out, '404.html'), 'utf8');
    assert.match(notFound, /<meta name="robots" content="noindex">/);
  });

  test('checkHtml zachytí inline skript, styl, on* a javascript:', () => {
    const bad = [
      '<script>alert(1)</script>',
      '<p style="color:red">x</p>',
      '<style>p{}</style>',
      '<img src="/a.png" onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '<a href=" jav&#x61;script:alert(1)">x</a>',
      '<script src="https://cdn.example.com/x.js"></script>',
      '<iframe src="/x"></iframe>',
    ];
    for (const b of bad) assert.ok(checkHtml(b, 't').length > 0, b);
    assert.deepEqual(checkHtml('<script type="application/ld+json">{"a":1}</script><script src="/assets/theme.0123456789.js"></script><link rel="icon" href="data:,">', 't'), []);
    // Administration pages may load only their own bundle from /admin/.
    assert.deepEqual(checkHtml('<script src="/admin/x.js"></script>', 't', { scriptDirs: ['/admin/'] }), []);
    assert.ok(checkHtml('<script src="/admin/x.js"></script>', 't').length > 0, '/admin/ skript na veřejné stránce');
  });

  test('build nikdy nesmaže nic mimo dist', async () => {
    const dir = await tempProject();
    await assert.rejects(build({ root: dir, outDir: dir }), /Refusing/);
    await assert.rejects(build({ root: dir, outDir: join(dir, 'content') }), /dist/);
    assert.ok(existsSync(join(dir, 'content', 'uvod.json')));
  });
});

describe('fotky služeb, provozovatel, ochrana soukromí, reference a Facebook', () => {
  let raw;
  before(async () => {
    raw = await realRaw();
  });
  const clone = () => structuredClone(raw);
  const errorFields = (d) => validateContent(d, REAL_IMAGES).errors.map((e) => `${e.where} ${e.field ?? ''} ${e.message}`);

  test('IČO: 8 číslic a kontrolní číslice (vážený součet mod 11)', () => {
    for (const ok of ['00718131', '27082440', '25596641', '00000019']) assert.ok(isValidIco(ok), ok);
    for (const bad of ['00718132', '27082441', '0071813', '007181311', '0071813a', ' 00718131', '', null]) assert.ok(!isValidIco(bad), String(bad));
    let d = clone();
    d['provozovatel.json'].ico = '00718132';
    let errs = errorFields(d);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /provozovatel\.json .*ico.*kontrolní číslice/);
    d = clone();
    d['provozovatel.json'].ico = '123 45';
    assert.match(errorFields(d)[0], /8 číslic/);
    d = clone();
    d['provozovatel.json'].ico = '007 181 31';
    const { errors, content } = validateContent(d, REAL_IMAGES);
    assert.deepEqual(errors, []);
    assert.equal(content.provozovatel.ico, '00718131', 'mezery se odstraní');
  });

  test('provozovatel: všechna pole povinná, e-mail se kontroluje', () => {
    for (const field of ['jmeno', 'ico', 'adresa', 'zapis', 'email_osobni_udaje']) {
      const d = clone();
      d['provozovatel.json'][field] = '';
      assert.ok(errorFields(d).some((e) => e.includes(field)), field);
    }
    const d = clone();
    d['provozovatel.json'].email_osobni_udaje = 'a,b@seznam.cz';
    assert.ok(errorFields(d).some((e) => e.includes('email_osobni_udaje')));
  });

  test('fotka služby: nepovinná, ale s fotkou je povinný popis', () => {
    const d = clone();
    const p = d['sluzby.json'].polozky.find((x) => x.fotka);
    assert.ok(p, 'v obsahu je služba s fotkou');
    p.fotka_popis = '';
    assert.ok(errorFields(d).some((e) => /sluzby\.json .*fotka_popis.*chybí popis fotky/.test(e)));
    p.fotka = '';
    assert.deepEqual(errorFields(d), [], 'bez fotky popis není potřeba');
    p.fotka = '/uploads/neexistuje.jpg';
    p.fotka_popis = 'x';
    assert.ok(errorFields(d).some((e) => e.includes('neexistuje.jpg')));
  });

  test('reference: s referencemi je povinná informace o jejich původu', () => {
    const d = clone();
    d['reference.json'].overeni = ' ';
    assert.ok(errorFields(d).some((e) => /reference\.json .*overeni.*zákon o ochraně spotřebitele/.test(e)));
    d['reference.json'].polozky = [];
    assert.deepEqual(errorFields(d), [], 'bez referencí text není potřeba');
  });

  test('živnostenský úřad: nepovinný, jen prostý text na jednom řádku', () => {
    let d = clone();
    delete d['provozovatel.json'].zivnostensky_urad;
    assert.deepEqual(errorFields(d), []);
    d = clone();
    d['provozovatel.json'].zivnostensky_urad = '  Městský úřad\n Velké Meziříčí ';
    const { errors, content } = validateContent(d, REAL_IMAGES);
    assert.deepEqual(errors, []);
    assert.equal(content.provozovatel.zivnostensky_urad, 'Městský úřad Velké Meziříčí', 'zalomení řádku a mezery se srovnají');
    d = clone();
    d['provozovatel.json'].zivnostensky_urad = 'x'.repeat(121);
    assert.ok(errorFields(d).some((e) => e.includes('zivnostensky_urad')));
  });

  test('bez živnostenského úřadu stránka napíše obecně „příslušný živnostenský úřad“; s pěti a více štítky žádný není oranžový', async () => {
    const dir = await tempProject();
    const p = await readContent(dir, 'provozovatel.json');
    delete p.zivnostensky_urad;
    await writeContent(dir, 'provozovatel.json', p);
    const uvod = await readContent(dir, 'uvod.json');
    uvod.pro_koho = ['a', 'b', 'c', 'd', 'e', 'f'];
    await writeContent(dir, 'uvod.json', uvod);
    const out = join(await tempDir(), 'dist');
    await build({ root: dir, outDir: out });
    const privacy = (await readFile(join(out, 'ochrana-soukromi/index.html'), 'utf8')).replaceAll(' ', ' ');
    assert.ok(privacy.includes('vykonává příslušný živnostenský úřad a Česká obchodní inspekce'));
    const index = await readFile(join(out, 'index.html'), 'utf8');
    assert.deepEqual([...index.matchAll(/<li class="chip acc-([a-z]+)">/g)].map((m) => m[1]), ['pink', 'sun', 'blue', 'green', 'pink', 'sun']);
    assert.ok(index.includes('<p class="hero-note acc-orange">'));
  });

  test('build s neplatným IČO skončí srozumitelnou chybou', async () => {
    const dir = await tempProject();
    const p = await readContent(dir, 'provozovatel.json');
    p.ico = '00718130';
    await writeContent(dir, 'provozovatel.json', p);
    await assert.rejects(build({ root: dir, outDir: join(await tempDir(), 'dist') }), (err) => {
      assert.ok(err instanceof BuildError);
      assert.match(err.message, /content\/provozovatel\.json/);
      assert.match(err.message, /IČO: „00718130“ není platné IČO – nesedí kontrolní číslice/);
      assert.match(err.message, /Co udělat: .*živnostenského listu/);
      return true;
    });
  });

  describe('výstup', () => {
    let out;
    let files;
    // Pages with no-break spaces (Czech typography) turned back into plain spaces, so the
    // texts below can be written normally; rawPage() keeps them (test of the typography).
    const rawPage = (f) => readFile(join(out, f), 'utf8');
    const page = async (f) => (await rawPage(f)).replaceAll('\u00a0', ' ');
    before(async () => {
      const dir = await tempProject();
      out = join(await tempDir(), 'dist');
      ({ files } = await build({ root: dir, outDir: out }));
    });

    test('stránka /ochrana-soukromi/: vlastní adresa, canonical, sitemap, stejná hlavička a patička', async () => {
      assert.ok(files.includes('ochrana-soukromi/index.html'));
      const p = await page('ochrana-soukromi/index.html');
      assert.deepEqual(checkHtml(p, 'ochrana-soukromi/index.html'), []);
      assert.match(p, /<html lang="cs">/);
      assert.match(p, /<link rel="canonical" href="https:\/\/www\.zabavadeti\.cz\/ochrana-soukromi\/">/);
      assert.match(p, /<title>Ochrana soukromí a cookies – Zábava pro děti<\/title>/);
      assert.equal((p.match(/<h1[\s>]/g) ?? []).length, 1);
      assert.match(p, /<script src="\/assets\/theme\.[0-9a-f]{10}\.js"><\/script>/);
      assert.match(p, /class="theme-toggle"/);
      assert.match(p, /<a class="acc-sun" href="\/#sluzby">Služby<\/a>/, 'menu vede na úvodní stránku');
      assert.match(p, /<h1 id="legal-title">Ochrana soukromí a cookies<\/h1>/, 'nadpis bez zvýraznění');
      assert.ok(!p.includes('application/ld+json'));
      const sitemap = await page('sitemap.xml');
      assert.match(sitemap, /<loc>https:\/\/www\.zabavadeti\.cz\/ochrana-soukromi\/<\/loc>/);
    });

    test('obsah stránky ochrany soukromí: provozovatel, GDPR, fotky dětí, cookies, ČOI', async () => {
      const p = await page('ochrana-soukromi/index.html');
      for (const text of [
        '<dd>Ivona Mutlová</dd>', '<dd>00718131</dd>', '<dd>Balinka 619, 594 42 Měřín</dd>', 'zapsaná v živnostenském rejstříku',
        'čl. 6 odst. 1 písm. b)', 'čl. 6 odst. 1 písm. c)', 'čl. 6 odst. 1 písm. f)', 'Cloudflare', 'IP adresu',
        'přístup', 'opravu', 'výmaz', 'omezení zpracování', 'přenos údajů', 'námitku',
        'Úřadu pro ochranu osobních údajů', 'href="https://www.uoou.gov.cz/"',
        'jen se souhlasem rodičů', 'kdykoli odvolat',
        'Běžným návštěvníkům web žádné cookies neukládá', '__cf_bm', 'Cloudflare Access', 'localStorage',
        '§ 89 odst. 3 zákona č. 127/2005 Sb.', 'Facebook se nenačte',
        'České obchodní inspekce', 'href="https://adr.coi.cz/"', 'živnostenský úřad',
        'nejpozději 6 měsíců po poslední zprávě', 'Meta Platforms', 'Právním základem je váš souhlas',
        'Poslední aktualizace: listopad 2026',
      ]) assert.ok(p.includes(text), text);
      assert.match(p, /href="mailto:ivona\.husakova@seznam\.cz"/);
      assert.ok(!p.includes('Štěpánská'), 'stará adresa ČOI');
      assert.ok(!/jsme|zveřejňujeme|zpracováváme|\(dále „my“\)/.test(p), 'mluví v 1. osobě jednotného čísla');
      assert.ok(!/<form[\s>]/.test(p));
      assert.ok(!/https?:\/\/(?!www\.zabavadeti\.cz|www\.facebook\.com|www\.w3\.org|www\.uoou\.gov\.cz|adr\.coi\.cz|www\.coi\.cz)/.test(p.replace(/xmlns="[^"]*"/g, '')), 'jen známé domény');
    });

    test('patička na všech stránkách: provozovatel, IČO, adresa a odkaz na ochranu soukromí', async () => {
      for (const f of ['index.html', '404.html', 'ochrana-soukromi/index.html']) {
        const p = await page(f);
        assert.ok(p.includes('Provozovatel: Ivona Mutlová · IČO 00718131 · Balinka 619, 594 42 Měřín'), f);
        assert.match(p, /<p class="footer-copy">© \d{4} Ivona Mutlová – Zábava pro děti<\/p>/, f);
        assert.match(p, /<a href="\/ochrana-soukromi\/">Ochrana soukromí a cookies<\/a>/, f);
        assert.match(p, /<li><a href="https:\/\/www\.facebook\.com\/groups\/698688478954254" rel="noopener noreferrer"><svg class="ui-icon"[^>]*>.*?<\/svg><span>Facebook<\/span><\/a><\/li>/, f);
      }
    });

    test('adresa i s PSČ všude: kontakt, patička, JSON-LD, ochrana soukromí (kontakt.json = provozovatel.json)', async () => {
      const ADDRESS = 'Balinka 619, 594 42 Měřín';
      const content = (f) => readFile(join(ROOT, 'content', f), 'utf8').then(JSON.parse);
      assert.equal((await content('kontakt.json')).adresa, ADDRESS);
      assert.equal((await content('provozovatel.json')).adresa, ADDRESS);
      const p = await page('index.html');
      const contact = p.slice(p.indexOf('<section id="kontakt"'), p.indexOf('</section>', p.indexOf('<section id="kontakt"')));
      assert.match(contact, /<address class="contact-address">[\s\S]*?<br>Balinka 619, 594 42 Měřín<\/span><\/address>/, 'kontakt');
      for (const f of ['index.html', '404.html', 'ochrana-soukromi/index.html']) {
        assert.ok((await page(f)).includes(`IČO 00718131 · ${ADDRESS}</p>`), `${f}: patička`);
      }
      const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(p)[1]);
      assert.deepEqual(ld.address, { '@type': 'PostalAddress', streetAddress: 'Balinka 619', postalCode: '594 42', addressLocality: 'Měřín', addressCountry: 'CZ' });
      assert.ok((await page('ochrana-soukromi/index.html')).includes(`<dt>Adresa</dt><dd>${ADDRESS}</dd>`), 'ochrana soukromí');
    });

    test('úvod: slogan jako samolepka u fotky, mateřské školy v kartě s ikonou školky', async () => {
      const p = await page('index.html');
      const hero = p.slice(p.indexOf('<section class="hero"'), p.indexOf('</section>'));
      assert.match(hero, /<div class="hero-media">\s*<div class="hero-frame"><div class="photo-card hero-photo">[\s\S]*?<\/div><\/div>\s*<p class="hero-badge"><svg class="ui-icon"[^>]*>.*?<\/svg><span>Konečně na to nemusíte být sami…<\/span><\/p>\s*<\/div>/);
      // Štítky „pro koho“ a karta školek v jednom bloku (karta stejně široká jako řádek štítků),
      // karta oranžová – tu barvu žádný štítek nepoužívá.
      assert.match(hero, /<div class="hero-audience">\s*<div class="for-whom">[\s\S]*?<ul class="chips">[\s\S]*?<\/ul>\s*<\/div>\s*<p class="hero-note acc-orange"><span class="hero-note-icon"><svg class="service-svg"[^>]*>.*?<\/svg><\/span><span class="hero-note-text">Zároveň připravuji zábavné programy pro mateřské školy, které kombinují kreativitu, pohyb a radost\.<\/span><\/p>\s*<\/div>/);
      assert.ok(!/class="chip acc-orange"/.test(hero), 'žádný štítek není oranžový jako karta školek');
    });

    test('dozor na stránce ochrany soukromí: konkrétní živnostenský úřad z provozovatel.json', async () => {
      const p = await page('ochrana-soukromi/index.html');
      assert.ok(p.includes('Dozor nad dodržováním mých povinností vykonává Městský úřad Velké Meziříčí (živnostenský úřad) a Česká obchodní inspekce'));
      assert.ok(p.includes('příslušný živnostenský úřad: Městský úřad Velké Meziříčí.'), 'zápis v rejstříku');
      assert.ok(!p.includes('vykonává příslušný živnostenský úřad'));
    });

    test('fotky: úvod, o mně a služba s fotkou jako velká karta', async () => {
      const p = await page('index.html');
      assert.match(p, /<img class="photo" src="\/uploads\/ivona-s-mimony\.jpg" width="450" height="600" alt="Ivona s maskoty Mimoňů na dětské oslavě" decoding="async" fetchpriority="high">/);
      assert.match(p, /<img class="photo" src="\/uploads\/ivona-portret\.jpg" width="432" height="578" alt="Ivona Mutlová, animátorka dětské zábavy" decoding="async" loading="lazy">/);
      // Fotky jsou celé a nic přes ně neleží: žádné popisky ani přechody na fotkách.
      assert.match(p, /<div class="photo-card hero-photo"><img class="photo" src="\/uploads\/ivona-s-mimony\.jpg"[^>]*><\/div>/);
      assert.match(p, /<div class="photo-card about-photo"><img class="photo" src="\/uploads\/ivona-portret\.jpg"[^>]*><\/div>/);
      assert.ok(!/photo-caption|service-overlay|figcaption class="photo/.test(p), 'žádný text přes fotku');
      // Služba s fotkou: velká dlaždice bento mřížky (první); fotka celá v samostatném rámečku,
      // ikona, nadpis a popis vedle ní / pod ní. Celá dlaždice je odkaz na kontakt.
      assert.match(p, /<ul class="services">\s*<li class="svc svc-big">\s*<a class="service acc-pink" href="#kontakt" aria-label="Maskoti na vaši akci – domluvit termín" aria-describedby="sluzba-1">\s*<span class="service-photo"><img class="photo" src="\/uploads\/mickey-a-minnie\.jpg" width="645" height="860" alt="Maskoti Mickey a Minnie na akci" decoding="async" loading="lazy"><\/span>\s*<div class="service-main">\s*<span class="service-icon"><svg class="service-svg"[^>]*>.*?<\/svg><\/span>\s*<div class="service-body">\s*<h3>Maskoti na vaši akci<\/h3>\s*<p id="sluzba-1">[^<]+<\/p>\s*<\/div>\s*<span class="service-go">/);
      const services = raw['sluzby.json'].polozky.length;
      const tiles = [...p.matchAll(/<a class="service acc-(?:pink|sun|blue|green|orange)" href="#kontakt" aria-label="([^"]+)" aria-describedby="(sluzba-\d+)">([\s\S]*?)<\/a>/g)];
      assert.equal(tiles.length, services, 'všechny služby jsou dlaždice stejného tvaru s barvou akcentu a odkazem na kontakt');
      for (const [, label, id, inner] of tiles) {
        assert.match(label, / – domluvit termín$/, label);
        assert.ok(p.includes(`<p id="${id}">`), id);
        assert.ok(!/<(?:a|button|input|select|textarea)[\s>]/.test(inner), `${label}: uvnitř dlaždice není další ovládací prvek`);
      }
      assert.equal((p.match(/<span class="service-icon">/g) ?? []).length, services, 'každá služba má ikonu');
      // Bento bez díry na konci: 1 velká dlaždice (2 × 2) + 9 malých = 13 buněk -> poslední přes celý řádek.
      assert.match(p, /<li class="svc svc-wide w2-2 w3-3 w4-4">\s*<a class="service acc-[a-z]+" href="#kontakt" aria-label="Oslavy a akce na míru – domluvit termín"/);
      assert.match(p, /"image":\["https:\/\/www\.zabavadeti\.cz\/uploads\/ivona-s-mimony\.jpg","https:\/\/www\.zabavadeti\.cz\/uploads\/ivona-portret\.jpg"\]/);
      for (const f of ['ivona-s-mimony.jpg', 'ivona-portret.jpg', 'mickey-a-minnie.jpg']) assert.ok(files.includes(`uploads/${f}`), f);
    });

    test('reference: pod nimi malým písmem informace o jejich původu', async () => {
      const p = await page('index.html');
      assert.match(p, /<\/ul>\s*<p class="refs-note">Reference mi napsali rodiče a organizátoři po akci, kterou jsem pro ně skutečně připravila\. Zveřejňuji jen reference od lidí, pro které jsem akci dělala, s jejich souhlasem a beze změny smyslu\.<\/p>/);
      // Každá karta ve své barvě (1. růžová, 2. žlutá, 3. modrá).
      assert.deepEqual([...p.matchAll(/<figure class="ref acc-([a-z]+)">/g)].map((m) => m[1]), ['pink', 'sun', 'blue']);
    });

    test('sekce: každá má svou barvu (štítek, zvýraznění, záře, podtržení v menu) a střídají se v pozadí', async () => {
      const p = await page('index.html');
      for (const [id, color, label] of [['sluzby', 'sun', 'Služby'], ['o-mne', 'pink', 'O mně'], ['reference', 'blue', 'Reference'], ['kontakt', 'green', 'Kontakt']]) {
        const start = p.indexOf(`<section id="${id}"`);
        assert.ok(start > 0, id);
        const section = p.slice(start, p.indexOf('</section>', start));
        assert.match(section, new RegExp(`^<section id="${id}" class="section [a-z -]*acc-${color}"`), `${id}: barva sekce`);
        assert.match(section, new RegExp(`<p class="kicker">${label}</p>\\s*<h2 id="${id}-title">[^<]*<span class="hl hl-${color}">`), `${id}: štítek a zvýraznění`);
        assert.match(p, new RegExp(`<a class="acc-${color}" href="#${id}">${label}</a>`), `${id}: položka menu`);
      }
      assert.deepEqual([...p.matchAll(/<section id="[a-z-]+" class="section( section-band)?/g)].map((m) => Boolean(m[1])), [true, false, true, false], 'střídání pozadí');
    });

    test('čeština: nedělitelné mezery za jednopísmennými slovy, v číslech a zkratkách (ne v atributech a JSON-LD)', async () => {
      const NB = '\u00a0';
      for (const f of ['index.html', '404.html', 'ochrana-soukromi/index.html']) {
        const p = await rawPage(f);
        const text = p.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, '\n');
        const bad = text.match(/(?:^|[\s(„])[KkSsVvZzOoUuAaIi] /gm) ?? [];
        assert.deepEqual(bad, [], `${f}: jednopísmenné slovo s obyčejnou mezerou`);
        assert.ok(p.includes(`+420${NB}739${NB}039${NB}559`), `${f}: telefon`);
        assert.ok(p.includes(`594${NB}42`), `${f}: PSČ`);
        assert.ok(p.includes('href="tel:+420739039559"'), `${f}: odkaz tel: beze změny`);
      }
      const index = await rawPage('index.html');
      assert.ok(index.includes(`v${NB}nezapomenutelný zážitek`));
      assert.ok(index.includes('data-copy="+420 739 039 559"'), 'atributy beze změny');
      const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(index)[1];
      assert.ok(!ld.includes(NB), 'JSON-LD bez nedělitelných mezer');
      assert.match(ld, /"postalCode":"594 42"/);
      const privacy = await rawPage('ochrana-soukromi/index.html');
      for (const s of [`§${NB}89`, `č.${NB}127/2005`, `čl.${NB}6`, `odst.${NB}1`, `písm.${NB}b)`]) assert.ok(privacy.includes(s), s);
    });

    test('Facebook: výrazná karta v kontaktu s vlastním logem, obyčejný odkaz bez skriptů Facebooku', async () => {
      const p = await page('index.html');
      assert.match(p, /<a class="contact-fb" href="https:\/\/www\.facebook\.com\/groups\/698688478954254" rel="noopener noreferrer"><svg class="fb-logo" viewBox="0 0 24 24" aria-hidden="true"[^>]*>.*?<\/svg><span class="contact-fb-body"><span class="contact-fb-label">Facebook<\/span> <span class="contact-fb-text">Sledujte fotky a novinky z mých akcí na Facebooku<\/span><\/span><span class="contact-fb-gallery"><span class="fb-shots fb-shots-3">(?:<span class="fb-shot"><img src="\/uploads\/[a-z-]+\.jpg" width="\d+" height="\d+" alt="" decoding="async" loading="lazy"><\/span>){3}<\/span><span class="fb-shots-caption">Další fotky z akcí najdete na Facebooku<\/span><\/span><span class="contact-fb-cta"><span>Otevřít Facebook<\/span><svg class="ui-icon"[^>]*>.*?<\/svg><\/span><\/a>/);
      // Kontakt: velká pilulková tlačítka se skutečným číslem a e-mailem, žádná vstupenka.
      assert.match(p, /<a class="btn btn-primary btn-xl" href="tel:\+420739039559"><svg class="ui-icon"[^>]*>.*?<\/svg><span class="btn-lines"><span class="contact-label">Zavolejte mi<\/span> <span class="contact-value">\+420 739 039 559<\/span><\/span><\/a>/);
      assert.match(p, /<a class="btn btn-secondary btn-xl" href="mailto:ivona\.husakova@seznam\.cz"><svg class="ui-icon"[^>]*>.*?<\/svg><span class="btn-lines"><span class="contact-label">Napište mi<\/span> <span class="contact-value">ivona\.husakova<wbr>@seznam\.cz<\/span><\/span><\/a>/);
      // Úvod: tlačítka také ukazují číslo a e-mail.
      const hero = p.slice(p.indexOf('<section class="hero"'), p.indexOf('</section>'));
      assert.match(hero, /<a class="btn btn-primary btn-lg" href="tel:\+420739039559"><svg class="ui-icon"[^>]*>.*?<\/svg><span>\+420 739 039 559<\/span><\/a>/);
      assert.match(hero, /<a class="btn btn-secondary btn-lg btn-mail" href="mailto:ivona\.husakova@seznam\.cz"><svg class="ui-icon"[^>]*>.*?<\/svg><span>ivona\.husakova<wbr>@seznam\.cz<\/span><\/a>/);
      assert.ok(!/float-card|float-note|float-slogan/.test(p), 'žádné plovoucí karty přes fotku');
      assert.ok(!/target=/.test(p), 'žádný target');
      assert.ok(!/connect\.facebook|fbcdn|<iframe|fb-root/.test(p), 'žádný vložený panel ani skript Facebooku');
      assert.match(p, /"sameAs":\["https:\/\/www\.facebook\.com\/groups\/698688478954254"\]/);
    });

    test('hlavička: rychlé kontakty (telefon, Facebook) vedle přepínače vzhledu a menu na všech stránkách', async () => {
      for (const f of ['index.html', '404.html', 'ochrana-soukromi/index.html']) {
        const p = await page(f);
        const header = p.slice(p.indexOf('<header'), p.indexOf('</header>'));
        const actions = header.slice(header.indexOf('<div class="header-actions">'));
        // Telefon: tel: odkaz s číslem jako textem (na mobilu skrytým) a popiskem, který text obsahuje.
        assert.match(actions, /<a class="quick quick-phone" href="tel:\+420739039559" aria-label="Zavolat na \+420 739 039 559"><svg class="ui-icon"[^>]*>.*?<\/svg><span class="quick-text">\+420 739 039 559<\/span><\/a>/, f);
        // Facebook: odkaz z nastavení, rel="noopener noreferrer", přístupný popisek, bez target.
        assert.match(actions, /<a class="quick quick-fb" href="https:\/\/www\.facebook\.com\/groups\/698688478954254" rel="noopener noreferrer" aria-label="Facebook" title="Facebook"><svg class="ui-icon"/, f);
        // Jediné tlačítko s telefonem (žádné druhé „Zavolejte mi“). Pořadí: telefon, Facebook,
        // přepínač vzhledu, menu (rozbalovací pro mobil).
        assert.equal((header.match(/href="tel:/g) ?? []).length, 1, `${f}: jeden odkaz na telefon`);
        assert.ok(!header.includes('header-cta'), f);
        const order = ['class="quick quick-phone"', 'class="quick quick-fb"', 'class="theme-toggle"', 'class="nav-mobile"'].map((c) => actions.indexOf(c));
        assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `${f}: ${order}`);
        assert.match(header, /<nav class="main-nav nav-wide" aria-label="Hlavní menu">/, f);
        assert.match(header, /<summary aria-label="Menu">/, f);
        // Název místa pod logem (výrazný řádek se špendlíkem).
        assert.match(header, /<span class="logo-sub"><svg class="ui-icon"[^>]*>.*?<\/svg><span>Měřín a okolí<\/span><\/span><\/span><\/a>/, f);
        assert.match(header, /<span class="logo-title">Zábava pro děti<\/span>/, f);
      }
    });

    test('jeden moderní styl: nic z opuštěných směrů (koláž, vstupenka, šapitó)', async () => {
      const GONE = ['paper', 'polaroid', 'ticket', 'stub', 'tape', 'paska', 'zrno', 'grain', 'cut-letters', 'tilt-', 'bunting', 'vlajky',
        'ring-word', 'service-num', 'font-hand', 'Zabava Ruka', 'Zabava Strih', 'sapito', 'cirkus', 'manez'];
      for (const f of ['index.html', '404.html', 'ochrana-soukromi/index.html']) {
        const p = await page(f);
        for (const gone of GONE) assert.ok(!p.includes(gone), `${f}: ${gone}`);
      }
      const css = await readFile(join(ROOT, 'src', 'styles.css'), 'utf8');
      for (const gone of GONE) assert.ok(!css.includes(gone), `styles.css: ${gone}`);
      // Písma: zaoblené Baloo 2 na nadpisy, Plus Jakarta Sans na text – obě z vlastní domény.
      assert.match(css, /--font-display: "Baloo 2"/);
      assert.match(css, /--font-text: "Plus Jakarta Sans"/);
      assert.equal([...css.matchAll(/font-display: swap;/g)].length, [...css.matchAll(/@font-face/g)].length, 'každé písmo font-display: swap');
      // Nadpisy: zvýrazněné slovo na barevném obdélníku, žádné kroužky ani čmáranice.
      const p = await page('index.html');
      assert.match(p, /<h1 id="hero-title">Program, který rozzáří <span class="hl hl-sun">dětské oči<\/span><\/h1>/);
      assert.equal((p.match(/<h2 id="[a-z-]+">[^<]*<span class="hl hl-[a-z]+">/g) ?? []).length, 4, 'každý nadpis sekce má zvýraznění');
      assert.equal((p.match(/class="hl /g) ?? []).length, 5, 'zvýraznění jen v hlavním nadpisu a nadpisech sekcí');
      for (const f of ['404.html', 'ochrana-soukromi/index.html']) assert.ok(!(await page(f)).includes('class="hl '), f);
      // Štítky „pro koho“: jeden tvar, liší se jen barvou.
      assert.deepEqual([...p.matchAll(/<li class="chip acc-([a-z]+)">/g)].map((m) => m[1]), ['pink', 'sun', 'blue', 'green']);
    });

    test('písma se přednačítají z vlastní domény (preload s crossorigin, sedí na soubory v /assets/)', async () => {
      for (const f of ['index.html', '404.html', 'ochrana-soukromi/index.html']) {
        const p = await page(f);
        const head = p.slice(0, p.indexOf('</head>'));
        const links = [...head.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1]);
        assert.equal(links.length, PRELOAD_FONTS.length, f);
        for (const href of links) {
          assert.match(href, /^\/assets\/baloo-latin(?:-ext)?\.[0-9a-f]{10}\.woff2$/, f);
          assert.ok(files.includes(href.slice(1)), `${f}: ${href} existuje`);
        }
        assert.ok(head.indexOf('rel="preload"') < head.indexOf('rel="stylesheet"'), 'preload před stylem');
        assert.deepEqual(checkHtml(p, f), [], f);
      }
    });

    test('ochrana soukromí: sekce Fotografie z akcí s e-mailem pro odvolání souhlasu', async () => {
      const p = await page('ochrana-soukromi/index.html');
      const block = p.slice(p.indexOf('<section class="legal-block" aria-labelledby="fotografie">'), p.indexOf('<section class="legal-block" aria-labelledby="cookies">'));
      assert.match(block, /<h2 id="fotografie">Fotografie z akcí<\/h2>/);
      for (const text of [
        'Na akcích občas fotografuji, abych mohla ukázat, jak program vypadá.',
        'Fotografie, na kterých jsou děti poznat, zveřejňuji na tomto webu a na Facebooku jen se souhlasem rodičů, případně objednatele akce, který souhlas rodičů zajistí.',
        'Pokud si nepřejete, aby vaše dítě bylo fotografováno, řekněte mi to prosím na začátku akce.',
        'Souhlas můžete kdykoli odvolat e-mailem na <a href="mailto:ivona.husakova@seznam.cz">ivona.husakova<wbr>@seznam.cz</a> a fotografii obratem odstraním.',
      ]) assert.ok(block.includes(text), text);
    });
  });

  test('bez Facebooku: žádná karta, ikona ani věta o Facebooku; prázdný text karty = výchozí věta', async () => {
    const dir = await tempProject();
    const n = await readContent(dir, 'nastaveni.json');
    n.facebook_text = '';
    await writeContent(dir, 'nastaveni.json', n);
    let out = join(await tempDir(), 'dist');
    await build({ root: dir, outDir: out });
    assert.match((await readFile(join(out, 'index.html'), 'utf8')).replaceAll('\u00a0', ' '), /<span class="contact-fb-text">Sledujte fotky a novinky z mých akcí na Facebooku<\/span>/);
    n.facebook = '';
    await writeContent(dir, 'nastaveni.json', n);
    out = join(await tempDir(), 'dist');
    await build({ root: dir, outDir: out });
    for (const f of ['index.html', 'ochrana-soukromi/index.html']) {
      const p = await readFile(join(out, f), 'utf8');
      assert.ok(!p.includes('facebook.com') && !p.includes('fb-logo') && !p.includes('Facebook'), f);
    }
  });

  test('karta Facebooku: vějíř až tří fotek (úvod, služby, o mně), bez chybějících, bez fotek žádný', async () => {
    const shots = (p) => [...p.matchAll(/<span class="fb-shot"><img src="([^"]+)"[^>]*alt=""[^>]*><\/span>/g)].map((m) => m[1]);
    const dir = await tempProject();
    const pageOf = async () => {
      const out = join(await tempDir(), 'dist');
      await build({ root: dir, outDir: out });
      return readFile(join(out, 'index.html'), 'utf8');
    };
    assert.deepEqual(shots(await pageOf()), ['/uploads/ivona-s-mimony.jpg', '/uploads/mickey-a-minnie.jpg', '/uploads/ivona-portret.jpg']);
    const uvod = await readContent(dir, 'uvod.json');
    uvod.fotka = '';
    await writeContent(dir, 'uvod.json', uvod);
    const sluzby = await readContent(dir, 'sluzby.json');
    for (const p of sluzby.polozky) p.fotka = '';
    await writeContent(dir, 'sluzby.json', sluzby);
    let p = await pageOf();
    assert.deepEqual(shots(p), ['/uploads/ivona-portret.jpg']);
    assert.match(p, /<span class="fb-shots fb-shots-1">/);
    const omne = await readContent(dir, 'o-mne.json');
    omne.fotka = '';
    await writeContent(dir, 'o-mne.json', omne);
    p = await pageOf();
    assert.ok(!p.includes('contact-fb-gallery') && !p.includes('fb-shot'), 'bez fotek žádný vějíř');
    assert.match(p, /<span class="contact-fb-text">[^<]*<\/span><\/span><span class="contact-fb-cta">/);
  });

  test('static/ochrana-soukromi build odmítne (adresu vytváří build sám)', async () => {
    const dir = await tempProject();
    await mkdir(join(dir, 'static', 'ochrana-soukromi'));
    await writeFile(join(dir, 'static', 'ochrana-soukromi', 'index.html'), '<p>x</p>');
    await assert.rejects(build({ root: dir, outDir: join(await tempDir(), 'dist') }), (err) => err instanceof BuildError && /ochrana-soukromi/.test(err.message));
  });
});

describe('designové soubory (src/assets): písma a SVG', () => {
  const ASSETS_DIR = join(ROOT, 'src', 'assets');

  test('checkFontFile: jen WOFF/WOFF2 podle obsahu, ne jen podle přípony', async () => {
    for (const name of (await readdir(ASSETS_DIR)).filter((n) => n.endsWith('.woff2'))) {
      assert.deepEqual(checkFontFile(await readFile(join(ASSETS_DIR, name)), `src/assets/${name}`), [], name);
    }
    const body = Buffer.alloc(64);
    const withMagic = (magic) => Buffer.concat([Buffer.from(magic, 'latin1'), body]);
    assert.deepEqual(checkFontFile(withMagic('wOFF'), 'x.woff'), []);
    assert.deepEqual(checkFontFile(withMagic('wOF2'), 'x.woff2'), []);
    for (const [buf, where] of [
      [withMagic('wOF2'), 'x.woff'], // WOFF2 přejmenovaný na .woff
      [withMagic('wOFF'), 'x.woff2'],
      [withMagic('\x00\x01\x00\x00'), 'x.woff'], // TTF
      [withMagic('OTTO'), 'x.woff'], // OTF
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.woff'],
      [Buffer.alloc(0), 'x.woff'],
      [withMagic('wOFF'), 'x.ttf'],
      [withMagic('wOFF'), 'x.otf'],
      [withMagic('wOFF'), 'x.svg'],
    ]) {
      const problems = checkFontFile(buf, where);
      assert.equal(problems.length, 1, where);
      assert.equal(problems[0].where, where);
    }
  });

  test('loadDesignAssets: skutečné soubory projdou kontrolou a dostanou otisk v názvu', async () => {
    const problems = [];
    const assets = await loadDesignAssets(ROOT, problems);
    assert.deepEqual(problems, []);
    assert.deepEqual([...assets.keys()].sort(), (await readdir(ASSETS_DIR)).sort());
    for (const [name, { hashed, data }] of assets) {
      assert.match(name, ASSET_NAME_RE);
      const ext = name.slice(name.lastIndexOf('.') + 1);
      assert.match(hashed, new RegExp(`^${name.slice(0, -(ext.length + 1))}\\.[0-9a-f]{10}\\.${ext}$`));
      if (ext === 'svg') assert.deepEqual(checkSvg(data.toString('utf8'), name), [], name);
    }
  });

  test('každý soubor ze src/assets se v CSS používá a každý odkaz v CSS vede na existující soubor', async () => {
    const css = await readFile(join(ROOT, 'src', 'styles.css'), 'utf8');
    const used = new Set([...css.matchAll(/url\("\/assets\/([a-z0-9-]+\.(?:svg|woff2?))"\)/g)].map((m) => m[1]));
    const files = (await readdir(ASSETS_DIR)).sort();
    assert.deepEqual([...used].sort(), files, 'nepoužité nebo chybějící soubory');
  });

  test('loadDesignAssets odmítne SVG se skriptem, podvržené písmo, cizí typ souboru a divný název', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'src', 'assets'), { recursive: true });
    const put = (name, data) => writeFile(join(dir, 'src', 'assets', name), data);
    await put('ok.svg', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
    await put('zly.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await put('odkaz.svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>');
    await put('falesne.woff', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await put('obrazek.png', 'x');
    await put('Velka.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await put('velke.svg', `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(300 * 1024)}</svg>`);
    const problems = [];
    const assets = await loadDesignAssets(dir, problems);
    assert.deepEqual([...assets.keys()], ['ok.svg']);
    for (const name of ['zly.svg', 'odkaz.svg', 'falesne.woff', 'obrazek.png', 'Velka.svg', 'velke.svg']) {
      assert.ok(problems.some((p) => p.where === `src/assets/${name}`), name);
    }
  });

  test('rewriteCssUrls: odkazy na /assets/ dostanou otisk, cokoli jiného je chyba', () => {
    const assets = new Map([
      ['konfety.svg', { hashed: 'konfety.0123456789.svg' }],
      ['baloo.woff2', { hashed: 'baloo.abcdef0123.woff2' }],
    ]);
    const ok = [];
    const out = rewriteCssUrls('a{background:url("/assets/konfety.svg")}b{mask:url(\'/assets/konfety.svg\')}@font-face{src:url(/assets/baloo.woff2) format("woff2")}', assets, ok);
    assert.deepEqual(ok, []);
    assert.equal(out, 'a{background:url("/assets/konfety.0123456789.svg")}b{mask:url("/assets/konfety.0123456789.svg")}@font-face{src:url("/assets/baloo.abcdef0123.woff2") format("woff2")}');
    for (const bad of [
      'a{background:url("data:image/svg+xml,<svg/>")}',
      'a{background:url(https://evil.example/x.svg)}',
      'a{background:url(//evil.example/x.svg)}',
      'a{background:url("/uploads/x.svg")}',
      'a{background:url("/assets/neexistuje.svg")}',
      'a{background:url("/assets/../uploads/konfety.svg")}',
      'a{background:url("/assets/konfety.svg?x=1")}',
      'a{background:URL("/uploads/x.svg")}',
      '@import "x.css";',
      'a{background:image-set("/assets/konfety.svg" 1x)}',
      '@font-face{src:src("/assets/baloo.woff2")}',
      // Escapovaný zápis CSS (prohlížeč ho čte jako url( / @import).
      'a{background:\\75rl(https://evil.example/x.png)}',
      'a{background:u\\72l(https://evil.example/x.png)}',
      '@\\69mport "https://evil.example/a.css";',
      '@font-face{src:url("/assets/stare.woff")}',
    ]) {
      const problems = [];
      rewriteCssUrls(bad, assets, problems);
      assert.ok(problems.length > 0, bad);
      assert.ok(problems.every((p) => p.where === 'src/styles.css'), bad);
    }
  });

  test('build: písma a SVG jsou v /assets/ s otiskem a CSS na ně odkazuje', async () => {
    const dir = await tempProject();
    const out = join(await tempDir(), 'dist');
    const result = await build({ root: dir, outDir: out });
    assert.equal(result.assets.length, (await readdir(ASSETS_DIR)).length);
    const css = await readFile(join(out, 'assets', result.css), 'utf8');
    for (const hashed of result.assets) {
      assert.ok(result.files.includes(`assets/${hashed}`), hashed);
      assert.ok(css.includes(`url("/assets/${hashed}")`), `CSS odkazuje na ${hashed}`);
    }
    assert.ok(!/url\("\/assets\/[a-z0-9-]+\.(?:svg|woff2?)"\)/.test(css), 'žádný odkaz bez otisku');
  });
});

describe('lokální server (serve.mjs)', () => {
  test('parseRequestPath odmítne path traversal a podivné cesty', () => {
    const bad = [
      '/../etc/passwd',
      '/..',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/%2E%2E%2Fsecret',
      '/..%2f..%2fwindows/win.ini',
      '/%252e%252e/secret',
      '/a/..\\..\\b',
      '/a%5c..%5cb',
      '/index.html%00.png',
      '/C:/Windows/win.ini',
      '/index.html::$DATA',
      '/nul',
      '/con.txt',
      '/index.html.',
      '/%zz',
      'index.html',
      '//evil.com/x',
    ];
    for (const p of bad) assert.equal(parseRequestPath(p).ok, false, p);
    assert.equal(parseRequestPath('/.git/config').status, 404);
    for (const p of ['/', '/index.html', '/assets/styles.abc.css?v=1', '/.well-known/security.txt', '/admin/', '/uploads/a-b_c.jpg']) {
      assert.equal(parseRequestPath(p).ok, true, p);
    }
  });

  test('resolveFile nevrátí soubor mimo dist', async () => {
    const dir = await tempDir();
    const dist = join(dir, 'dist');
    await mkdir(join(dist, 'sub'), { recursive: true });
    await writeFile(join(dist, 'index.html'), 'ok');
    await writeFile(join(dist, 'sub', 'index.html'), 'ok');
    await writeFile(join(dir, 'secret.txt'), 'tajne');
    assert.equal(await resolveFile(dist, '/../secret.txt'), null);
    assert.deepEqual(await resolveFile(dist, '/sub'), { redirect: '/sub/' });
    assert.deepEqual(await resolveFile(dist, '/'), { file: join(dist, 'index.html') });
  });

  test('_headers: zástupné znaky, :splat a odpojení „! Název“', () => {
    const rules = parseHeadersFile([
      '/*',
      '  Content-Security-Policy: default-src \'none\'',
      '  X-Test: a',
      '/admin/*',
      '  ! Content-Security-Policy',
      '  Content-Security-Policy: default-src \'self\'',
      '  X-Test: b',
      '/blog/:slug/*',
      '  X-Slug: :slug-:splat',
      'https://:project.pages.dev/*',
      '  X-Robots-Tag: noindex',
    ].join('\n'));
    const root = headersFor(rules, '/', 'www.zabavadeti.cz');
    assert.equal(root.get('content-security-policy').value, "default-src 'none'");
    const admin = headersFor(rules, '/admin/index.html', 'www.zabavadeti.cz');
    assert.equal(admin.get('content-security-policy').value, "default-src 'self'");
    assert.equal(admin.get('x-test').value, 'a, b', 'opakovaná hlavička se spojí čárkou');
    assert.equal(headersFor(rules, '/blog/ahoj/x/y').get('x-slug').value, 'ahoj-x/y');
    assert.equal(headersFor(rules, '/', 'zabava.pages.dev').get('x-robots-tag').value, 'noindex');
    assert.equal(headersFor(rules, '/', 'www.zabavadeti.cz').has('x-robots-tag'), false);
  });

  describe('HTTP', () => {
    let server;
    let port;
    let dist;
    before(async () => {
      const dir = await tempProject();
      dist = join(await tempDir(), 'dist');
      await build({ root: dir, outDir: dist });
      server = createServer({ distDir: dist });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      port = server.address().port;
    });
    after(() => new Promise((r) => server.close(r)));

    function request(path, { method = 'GET', host } = {}) {
      return new Promise((res, rej) => {
        const req = http.request({ host: '127.0.0.1', port, path, method, headers: host ? { Host: host } : {} }, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }));
        });
        req.on('error', rej);
        req.end();
      });
    }

    test('/ vrátí 200 s CSP a bezpečnostními hlavičkami', async () => {
      const r = await request('/');
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.headers['content-security-policy'], /default-src 'none'/);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    });

    test('/ochrana-soukromi/ vrátí 200 s CSP, adresa bez lomítka přesměruje', async () => {
      const r = await request('/ochrana-soukromi/');
      assert.equal(r.status, 200);
      assert.match(r.body, /<h1 id="legal-title">Ochrana soukromí a[\s\u00a0]cookies<\/h1>/);
      assert.match(r.headers['content-security-policy'], /default-src 'none'/);
      const redirect = await request('/ochrana-soukromi');
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.location, '/ochrana-soukromi/');
    });

    test('CSS má dlouhou cache, chybějící soubor pod /assets/ ne', async () => {
      const css = (await readdir(join(dist, 'assets'))).find((f) => f.endsWith('.css'));
      const r = await request(`/assets/${css}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.match(r.headers['content-type'], /text\/css/);
      const missing = await request('/assets/neexistuje.css');
      assert.equal(missing.status, 404);
      assert.ok(!/immutable/.test(missing.headers['cache-control'] ?? ''), '404 se nesmí cachovat na rok');
      assert.match(missing.headers['content-security-policy'], /default-src 'none'/);
    });

    test('path traversal → 400, neexistující → 404 se stránkou 404', async () => {
      for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json']) {
        const r = await request(p);
        assert.equal(r.status, 400, p);
        assert.ok(!r.body.includes('"scripts"'));
      }
      const nf = await request('/neexistuje');
      assert.equal(nf.status, 404);
      assert.match(nf.body, /<h1 id="nf-title">Tuhle stránku se nepodařilo najít<\/h1>/);
    });

    test('jen GET/HEAD, /api/* → 501, cizí Host → 421', async () => {
      assert.equal((await request('/', { method: 'POST' })).status, 405);
      assert.equal((await request('/', { method: 'DELETE' })).status, 405);
      const head = await request('/', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      const api = await request('/api/auth');
      assert.equal(api.status, 501);
      assert.match(api.body, /Cloudflare/);
      assert.equal((await request('/', { host: 'evil.example' })).status, 421);
    });
  });
});
