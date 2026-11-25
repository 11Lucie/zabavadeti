// Regression tests of the security hardening (audit 2026-11): content validation, uploads,
// allowlists of static/ and functions/, symbolic links, the HTML check, linear-time helpers
// and repository hygiene. Every test that modifies data works on a temporary copy.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

import { build, BuildError, minifyCss, normalizeHeadersText } from '../build.mjs';
import { validateContent, loadContent, hasForbiddenChars, normalizeFacebook } from '../src/validate.mjs';
import { checkUploads, checkHtml, checkSvg, inspectImage, checkDist, checkSecurityTxt, checkFunctionsTree, checkStaticTree, checkGitModes, checkRepoRoot, checkPackageJson } from '../scripts/check.mjs';
import { parseHeadersFile } from '../scripts/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_FILES = ['nastaveni.json', 'uvod.json', 'sluzby.json', 'o-mne.json', 'reference.json', 'kontakt.json', 'provozovatel.json'];
const ch = (...cps) => String.fromCodePoint(...cps);

const tempDirs = [];
async function tempDir(prefix = 'zabava-hard-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
});

async function tempProject({ withAdmin = false, emptyUploads = false } = {}) {
  const dir = await tempDir();
  await cp(join(ROOT, 'content'), join(dir, 'content'), { recursive: true });
  await cp(join(ROOT, 'headers'), join(dir, 'headers'), { recursive: true });
  await cp(join(ROOT, 'static'), join(dir, 'static'), {
    recursive: true,
    filter: (src) => (withAdmin || !src.includes(join('static', 'admin')))
      && !(emptyUploads && /[\\/]uploads[\\/][^\\/]+\.(?:jpe?g|png|webp)$/i.test(src)),
  });
  return dir;
}
const outOf = async () => join(await tempDir(), 'dist');
const raw = () => Object.fromEntries(CONTENT_FILES.map((f) => [f, JSON.parse(readFileSync(join(ROOT, 'content', f), 'utf8'))]));
// Photos of the real content (read only) – validateContent needs them to accept content/*.json.
const REAL_IMAGES = (await checkUploads(ROOT)).images;

function errorsFor(mutate) {
  const d = raw();
  mutate(d);
  return validateContent(d, REAL_IMAGES).errors;
}

async function canSymlink() {
  const dir = await tempDir();
  await writeFile(join(dir, 't'), 'x');
  try {
    await symlink(join(dir, 't'), join(dir, 'l'), 'file');
    return true;
  } catch {
    return false;
  }
}

// --- image fixtures -----------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
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
// PNG with the given dimensions (pixel data is not decoded by the check, a tiny IDAT is enough).
function pngWith(width, height, extra = [], bitDepth = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// TIFF block with a GPS IFD (one entry).
function gpsTiff() {
  const tiff = Buffer.alloc(40);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x0002, 28); // GPSLatitude
  tiff.writeUInt16LE(5, 30);
  tiff.writeUInt32LE(3, 32);
  tiff.writeUInt32LE(0, 36);
  return tiff;
}
function plainTiff() {
  const tiff = Buffer.alloc(14);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(0, 8);
  return tiff;
}
function app1(payload) {
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function jpegWith(segments, width = 8, height = 6) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, sof, Buffer.from([0xff, 0xd9])]);
}
const XMP_GPS = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="49,23.1N" exif:GPSLongitude="15,53.2E"/></rdf:RDF></x:xmpmeta>';
function webpWith(extraChunks) {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(7, 4, 3); // width-1
  vp8x.writeUIntLE(5, 7, 3); // height-1
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1');
    h.writeUInt32LE(data.length, 4);
    return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', vp8x), ...extraChunks.map(([t, d]) => chunk(t, d))]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

// ---------------------------------------------------------------------------

describe('validace obsahu – zpřísnění', () => {
  test('e-mail: odmítne %, čárku, ?, & (mailto by se rozdělil na víc adres)', () => {
    for (const bad of ['spy%40evil.cz%2Civona@seznam.cz', 'ivona%2C@seznam.cz', 'a,b@seznam.cz', 'a?cc=x@seznam.cz', 'a&b@seznam.cz', 'a=b@seznam.cz']) {
      assert.ok(errorsFor((d) => (d['kontakt.json'].email = bad)).some((e) => e.field.includes('email')), bad);
    }
    assert.deepEqual(errorsFor((d) => (d['kontakt.json'].email = 'ivona.husakova+web@seznam.cz')), []);
  });

  test('neviditelné a směrové znaky se odmítnou, emoji a čeština projdou', () => {
    for (const cp of [0x200e, 0x200f, 0x061c, 0x200b, 0x200c, 0x2060, 0x00ad, 0x3164, 0x115f, 0xffa0, 0xe0041, 0x2028, 0x2029, 0xfeff, 0x202e, 0xe000]) {
      const errs = errorsFor((d) => (d['uvod.json'].nadpis = `Ahoj${ch(cp)}svete`));
      assert.ok(errs.some((e) => e.field.includes('nadpis') && /neviditelné/.test(e.message)), cp.toString(16));
    }
    for (const ok of [ch(0x1f469, 0x200d, 0x1f3a8), ch(0x2764, 0xfe0f), ch(0x1f1e8, 0x1f1ff), 'Příliš žluťoučký kůň', ch(0x1f469, 0x1f3fd, 0x200d, 0x1f3a8)]) {
      assert.equal(hasForbiddenChars(ok), false, ok);
      assert.deepEqual(errorsFor((d) => (d['uvod.json'].slogan = ok)), [], ok);
    }
    assert.equal(hasForbiddenChars(`a${ch(0x200d)}b`), true, 'osamělý ZWJ mimo emoji');
  });

  test('variation selectory, CGJ, mongolské a khmerské neviditelné znaky, Braillova mezera a „zalgo“ se odmítnou', () => {
    for (const cp of [0xfe00, 0xfe0e, 0xfe0f, 0xe0100, 0xe01ef, 0x034f, 0x180b, 0x180d, 0x180f, 0x17b4, 0x17b5, 0x2800, 0x2064, 0x1d173]) {
      assert.equal(hasForbiddenChars(`Ahoj${ch(cp)}svete`), true, cp.toString(16));
      const errs = errorsFor((d) => (d['uvod.json'].nadpis = `Ahoj${ch(cp)}svete`));
      assert.ok(errs.some((e) => e.field.includes('nadpis') && /neviditelné/.test(e.message)), cp.toString(16));
    }
    // U+FE0F only right after an emoji (or in a keycap), never twice or after a letter.
    for (const bad of [ch(0x2764, 0xfe0f, 0xfe0f), ch(0x61, 0xfe0f), ch(0x31, 0xfe0f), ch(0x2764, 0xfe0e), `a${ch(0x300, 0x301, 0x302, 0x303)}`]) {
      assert.equal(hasForbiddenChars(bad), true, [...bad].map((c) => c.codePointAt(0).toString(16)).join(' '));
    }
    for (const ok of [ch(0x31, 0xfe0f, 0x20e3), ch(0x1f3f3, 0xfe0f, 0x200d, 0x1f308), ch(0xa9, 0xfe0f), `e${ch(0x301)}`, `a${ch(0x300, 0x301, 0x302)}`]) {
      assert.equal(hasForbiddenChars(ok), false, [...ok].map((c) => c.codePointAt(0).toString(16)).join(' '));
      assert.deepEqual(errorsFor((d) => (d['uvod.json'].slogan = `Super ${ok}`)), [], ok);
    }
  });

  test('Facebook: přesměrovávače a dialogy se odmítnou, odkaz se vyčistí od sledovacích parametrů', () => {
    for (const bad of [
      'https://www.facebook.com/l.php?u=https%3A%2F%2Fevil.example%2F&h=AT0',
      'https://www.facebook.com/dialog/feed?redirect_uri=https%3A%2F%2Fevil.example',
      'https://www.facebook.com/flx/warn/?u=x',
      'https://www.facebook.com/L.PHP?u=x',
      'https://www.facebook.com/profile.php?next=x',
      'https://www.facebook.com/',
      'https://www.facebook.com/login.php',
    ]) {
      assert.ok(errorsFor((d) => (d['nastaveni.json'].facebook = bad)).some((e) => e.field.includes('facebook')), bad);
    }
    assert.equal(normalizeFacebook('https://www.facebook.com/zabava?mibextid=abc#x'), 'https://www.facebook.com/zabava');
    assert.equal(normalizeFacebook('https://www.facebook.com/profile.php?id=123&next=x'), 'https://www.facebook.com/profile.php?id=123');
    assert.equal(normalizeFacebook('https://www.facebook.com/share/g/1AbC/'), 'https://www.facebook.com/share/g/1AbC/');
    assert.equal(normalizeFacebook('https://www.facebook.com/people/Jmeno/123/'), 'https://www.facebook.com/people/Jmeno/123/');
    const d = raw();
    d['nastaveni.json'].facebook = 'https://www.facebook.com/groups/698688478954254?mibextid=q';
    assert.equal(validateContent(d, REAL_IMAGES).content.nastaveni.facebook, 'https://www.facebook.com/groups/698688478954254');
  });

  test('pole __proto__, constructor, toString … jsou neznámá pole (i v položkách seznamu)', () => {
    const d = raw();
    d['kontakt.json'] = JSON.parse(JSON.stringify(d['kontakt.json']).replace(/^\{/, '{"__proto__":"skryte","constructor":"<img src=x>","toString":"x",'));
    d['sluzby.json'] = JSON.parse(JSON.stringify(d['sluzby.json']).replace('"nazev"', '"hasOwnProperty":"x","nazev"'));
    const fields = validateContent(d, REAL_IMAGES).errors.map((e) => e.field);
    for (const f of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.ok(fields.some((x) => x.includes(f)), f);
    }
  });

  test('chybný JSON: hláška ukáže jen místo chyby, ne obsah souboru', async () => {
    const dir = await tempProject();
    await writeFile(join(dir, 'content', 'uvod.json'), 'GITHUB_CLIENT_SECRET=abcdef0123');
    await writeFile(join(dir, 'content', 'kontakt.json'), '{\n "a": 1,\n}');
    const { errors } = await loadContent(dir);
    const text = JSON.stringify(errors);
    assert.ok(!text.includes('GITHUB') && !text.includes('abcdef'), text);
    assert.match(errors.find((e) => e.where.endsWith('kontakt.json')).message, /řádek 3/);
  });

  test('příliš velký soubor obsahu se nenačte', async () => {
    const dir = await tempProject();
    await writeFile(join(dir, 'content', 'uvod.json'), '"' + 'x'.repeat(1024 * 1024 + 10) + '"');
    const { errors } = await loadContent(dir);
    assert.match(errors[0].message, /příliš velký/);
  });
});

describe('symbolické odkazy', () => {
  test('content/*.json, content/, static/ a headers/site.txt jako odkaz → build selže bez obsahu cíle', async (t) => {
    if (!(await canSymlink())) return t.skip('systém nedovolí vytvořit symbolický odkaz');
    const secretDir = await tempDir();
    await writeFile(join(secretDir, 'uvod.json'), JSON.stringify({ nadpis: 'TAJNY OBSAH MIMO REPO' }));
    await writeFile(join(secretDir, 'site.txt'), '/*\n  Content-Security-Policy: x\n');

    const cases = [
      async (dir) => {
        await rm(join(dir, 'content', 'uvod.json'));
        await symlink(join(secretDir, 'uvod.json'), join(dir, 'content', 'uvod.json'), 'file');
      },
      async (dir) => {
        await cp(join(dir, 'content'), join(secretDir, 'content-copy'), { recursive: true });
        await rm(join(dir, 'content'), { recursive: true });
        await symlink(join(secretDir, 'content-copy'), join(dir, 'content'), 'junction');
      },
      async (dir) => {
        await cp(join(dir, 'static'), join(secretDir, 'static-copy'), { recursive: true });
        await writeFile(join(secretDir, 'static-copy', 'secret.txt'), 'tajne');
        await rm(join(dir, 'static'), { recursive: true });
        await symlink(join(secretDir, 'static-copy'), join(dir, 'static'), 'junction');
      },
      async (dir) => {
        await rm(join(dir, 'headers', 'site.txt'));
        await symlink(join(secretDir, 'site.txt'), join(dir, 'headers', 'site.txt'), 'file');
      },
    ];
    for (const [i, prepare] of cases.entries()) {
      const dir = await tempProject();
      await prepare(dir);
      const out = await outOf();
      await assert.rejects(build({ root: dir, outDir: out }), (err) => {
        assert.ok(err instanceof BuildError, `case ${i}: ${err}`);
        assert.ok(!err.message.includes('TAJNY'), `case ${i}`);
        return true;
      });
      assert.ok(!existsSync(join(out, 'secret.txt')), `case ${i}`);
    }
  });
});

describe('git: symbolické odkazy a submoduly', () => {
  test('checkGitModes najde odkaz (120000) a submodul (160000) v indexu gitu', async (t) => {
    const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', input: args.includes('--stdin') ? 'cil' : undefined });
    const dir = await tempDir();
    if (git(dir, 'init', '-q').status !== 0) return t.skip('git není k dispozici');
    assert.deepEqual(checkGitModes(dir), [], 'prázdný repozitář');
    const blob = git(dir, 'hash-object', '-w', '--stdin').stdout.trim();
    assert.equal(git(dir, 'update-index', '--add', '--cacheinfo', `120000,${blob},content/uvod.json`).status, 0);
    assert.equal(git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/x`).status, 0);
    const where = checkGitModes(dir).map((e) => e.where).sort();
    assert.deepEqual(where, ['content/uvod.json', 'vendor/x']);
    assert.deepEqual(checkGitModes(join(dir, 'content')), [], 'jen v kořeni repozitáře');
    assert.deepEqual(checkGitModes(ROOT), [], 'skutečný repozitář je čistý');
  });
});

describe('povolené soubory v kořeni repozitáře', () => {
  test('skutečný repozitář projde', async () => {
    assert.deepEqual(await checkRepoRoot(ROOT), []);
    assert.deepEqual(await checkPackageJson(ROOT), []);
  });

  test('wrangler.*, soubory správců balíčků a řídicí soubory v kořeni build zastaví (i bez gitu)', async () => {
    for (const name of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'Wrangler.TOML', '.npmrc', 'package-lock.json', 'bun.lockb', 'bun.lock',
      'yarn.lock', 'pnpm-lock.yaml', '.yarnrc.yml', 'requirements.txt', '.nvmrc', '_worker.js', '_routes.json', '_redirects', '_headers', 'evil.txt', 'index.html']) {
      const dir = await tempProject();
      await writeFile(join(dir, name), name.startsWith('wrangler') ? 'pages_build_output_dir = "static"\n[vars]\nALLOWED_GITHUB_USERS = "utocnik"\n' : 'x');
      const errs = await checkRepoRoot(dir);
      assert.deepEqual(errs.map((e) => e.where), [name], name);
      await assert.rejects(build({ root: dir, outDir: await outOf() }), (err) => err instanceof BuildError && err.message.includes(name), name);
    }
    for (const dirName of ['_worker.js', '.yarn', 'functions2', '.github/workflows']) {
      const dir = await tempProject();
      await mkdir(join(dir, dirName), { recursive: true });
      await writeFile(join(dir, dirName, 'x.js'), 'x');
      assert.ok((await checkRepoRoot(dir)).length > 0, dirName);
    }
  });

  test('místní soubory mimo git (.dev.vars, dist, .wrangler …) projdou, pokud nejsou v gitu', async (t) => {
    const dir = await tempProject();
    for (const f of ['.dev.vars', '.env', 'npm-debug.log']) await writeFile(join(dir, f), 'x');
    for (const d of ['dist', '.wrangler', 'node_modules']) await mkdir(join(dir, d));
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude', 'launch.json'), '{}');
    await writeFile(join(dir, '.claude', 'settings.local.json'), '{}');
    assert.deepEqual(await checkRepoRoot(dir), []);

    const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (git('init', '-q').status !== 0) return t.skip('git není k dispozici');
    await writeFile(join(dir, 'poznamky.txt'), 'x'); // neverzovaný soubor: rozhoduje git
    await writeFile(join(dir, 'package-lock.json'), '{}'); // vytvořený strojem při sestavení, ne z návrhu
    await writeFile(join(dir, 'wrangler.toml'), 'pages_build_output_dir = "static"');
    assert.deepEqual(await checkRepoRoot(dir), []);
    for (const f of ['.dev.vars', 'poznamky.txt', '.claude/settings.local.json', 'content/uvod.json', 'wrangler.toml']) {
      assert.equal(git('add', '-f', f).status, 0, f);
    }
    const errs = await checkRepoRoot(dir);
    assert.deepEqual(errs.map((e) => e.where).sort(), ['.claude/settings.local.json', '.dev.vars', 'poznamky.txt', 'wrangler.toml']);
    assert.match(errs.find((e) => e.where === 'wrangler.toml').message, /Wrangleru/);
  });

  test('package.json bez závislostí a bez automaticky spouštěných skriptů', async () => {
    const dir = await tempProject();
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
    assert.deepEqual(await checkPackageJson(dir), []);
    for (const bad of [{ dependencies: { x: '1' } }, { devDependencies: {} }, { overrides: {} }, { scripts: { postinstall: 'node x' } },
      { scripts: { prepare: 'x' } }, { scripts: { preinstall: 'x' } }]) {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, ...bad, scripts: { ...pkg.scripts, ...(bad.scripts ?? {}) } }));
      assert.ok((await checkPackageJson(dir)).length > 0, JSON.stringify(bad));
      await assert.rejects(build({ root: dir, outDir: await outOf() }), (err) => err instanceof BuildError && /package\.json/.test(err.message));
    }
    await writeFile(join(dir, 'package.json'), '{nejde');
    assert.ok((await checkPackageJson(dir)).length > 0);
  });
});

describe('povolené soubory ve static/ a functions/', () => {
  test('řídicí soubory Cloudflare Pages, HTML a neznámé soubory ve static/ build zastaví', async () => {
    const variants = [
      ['_worker.js', 'export default { fetch: (r, env) => new Response(env.GITHUB_CLIENT_SECRET) }'],
      ['_worker.js/index.js', 'export default {}'],
      ['_redirects', '/admin/* https://evil.example/ 302'],
      ['_routes.json', '{"version":1,"include":[],"exclude":["/*"]}'],
      ['_Worker.JS', 'x'],
      ['x/login.html', '<form>'],
      ['phish.html', '<p>x</p>'],
      ['admin/evil.html', '<!--><script>alert(1)</script>'],
      ['.well-known/extra.txt', 'x'],
      ['robots.txt', 'x'],
    ];
    for (const [rel, data] of variants) {
      const dir = await tempProject();
      await mkdir(dirname(join(dir, 'static', rel)), { recursive: true });
      await writeFile(join(dir, 'static', rel), data);
      await assert.rejects(build({ root: dir, outDir: await outOf() }), (err) => err instanceof BuildError, rel);
    }
    assert.deepEqual(await checkStaticTree(await tempProject({ withAdmin: true })), [], 'skutečný obsah static/ projde');
  });

  test('functions/ smí obsahovat jen api/auth.js a api/callback.js', async () => {
    assert.deepEqual(await checkFunctionsTree(ROOT), []);
    const dir = await tempProject();
    await cp(join(ROOT, 'functions'), join(dir, 'functions'), { recursive: true });
    assert.deepEqual(await checkFunctionsTree(dir), []);
    await writeFile(join(dir, 'functions', 'api', 'leak.js'), 'export const onRequest = () => new Response("x")');
    await writeFile(join(dir, 'functions', '_middleware.js'), 'x');
    const errs = await checkFunctionsTree(dir);
    assert.deepEqual(errs.map((e) => e.where).sort(), ['functions/_middleware.js', 'functions/api/leak.js']);
    await assert.rejects(build({ root: dir, outDir: await outOf() }), (err) => err instanceof BuildError && /leak\.js/.test(err.message));
  });

  test('checkDist: _worker.js, _redirects a HTML/JS mimo povolená místa ve výstupu', async () => {
    const dist = await tempDir();
    await writeFile(join(dist, 'index.html'), '<!doctype html><p>x</p>');
    await writeFile(join(dist, '_worker.js'), 'x');
    await writeFile(join(dist, '_redirects'), 'x');
    await mkdir(join(dist, 'uploads'));
    await writeFile(join(dist, 'uploads', 'x.html'), '<p>x</p>');
    await writeFile(join(dist, 'x.svg'), '<svg/>');
    const where = (await checkDist(dist)).errors.map((e) => e.where);
    for (const w of ['dist/_worker.js', 'dist/_redirects', 'dist/uploads/x.html', 'dist/x.svg']) assert.ok(where.includes(w), w);
  });

  test('SVG soubory (favicon.svg) jen jako obyčejná kresba: bez skriptů, on*, foreignObject, stylů a odkazů ven', async () => {
    assert.deepEqual(checkSvg(readFileSync(join(ROOT, 'static', 'favicon.svg'), 'utf8'), 'static/favicon.svg'), []);
    assert.deepEqual(checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>', 't'), []);
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/onclick="x"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>x</p></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="https://evil.example/x.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="/uploads/x.svg#a"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/x#a)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(x.css)</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:red"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<html><svg/></html>',
      // Obejití černé listiny: předpona jmenného prostoru a animace SMIL (seznam povolených to zachytí).
      '<svg xmlns="http://www.w3.org/2000/svg"><s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><use x:href="https://evil.example/a.svg#a"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript:alert(1)"/><rect/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="https://evil.example/"/><rect/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image width="1" height="1"/></svg>',
      '<svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><!-- <script>alert(1)</script> --><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[x]]><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill=red/></svg>',
    ]) assert.ok(checkSvg(bad, 't').length > 0, bad);
    // Designové SVG ze src/assets projdou i seznamem povolených prvků.
    assert.deepEqual(checkSvg(readFileSync(join(ROOT, 'src', 'assets', 'konfety.svg'), 'utf8'), 'konfety.svg'), []);
    assert.deepEqual(checkSvg('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><title>x</title><g><path d="M0 0h1"/><use xlink:href="#a"/></g></svg>', 't'), []);
    const dist = await tempDir();
    await writeFile(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    assert.ok((await checkDist(dist)).errors.some((e) => e.where === 'dist/favicon.svg' && /on…=/.test(e.message)));
  });

  test('vložené SVG ve stránce: <foreignObject> ani odkaz <use>/<image> ven nejsou povolené', () => {
    assert.ok(checkHtml('<svg><foreignObject><p>x</p></foreignObject></svg>', 't').length > 0);
    assert.ok(checkHtml('<svg><use href="https://evil.example/s.svg#a"/></svg>', 't').length > 0);
    assert.ok(checkHtml('<svg><image xlink:href="//evil.example/x.png"/></svg>', 't').length > 0);
    assert.deepEqual(checkHtml('<svg><use href="#a"/></svg>', 't'), []);
  });
});

describe('kontrola fotek – zpřísnění', () => {
  async function uploadsWith(files) {
    const dir = await tempProject({ emptyUploads: true });
    for (const [name, data] of Object.entries(files)) await writeFile(join(dir, 'static', 'uploads', name), data);
    return checkUploads(dir);
  }

  test('„dekompresní bomba“: malé PNG s obřími rozměry je chyba, běžná fotka jen upozornění', async () => {
    const bomb = pngWith(10000, 10000);
    assert.ok(bomb.length < 1000);
    assert.match(inspectImage(bomb).error, /příliš mnoho pixelů/);
    assert.match(inspectImage(pngWith(20000, 100)).error, /rozměry/);
    const r = await uploadsWith({ 'bomba.png': bomb, 'fotka.png': pngWith(4000, 3000, [], 8) });
    assert.deepEqual(r.errors.map((e) => e.where), ['static/uploads/bomba.png']);
    assert.ok(r.images.has('fotka.png'));
    assert.match(r.warnings[0].message, /zbytečně velká/);
  });

  test('GPS se najde i v XMP, ve druhém EXIF bloku, v textu PNG a ve WebP XMP', () => {
    const exif = (t) => app1(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]));
    const xmp = app1(Buffer.from('http://ns.adobe.com/xap/1.0/\0' + XMP_GPS, 'latin1'));
    assert.equal(inspectImage(jpegWith([xmp])).gps, true, 'JPEG XMP');
    assert.equal(inspectImage(jpegWith([exif(plainTiff()), exif(gpsTiff())])).gps, true, 'druhý EXIF');
    assert.equal(inspectImage(jpegWith([exif(plainTiff())])).gps, false, 'bez GPS');

    const itxt = pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(XMP_GPS)]));
    assert.equal(inspectImage(pngWith(4, 3, [itxt])).gps, true, 'PNG iTXt XMP');
    const hex = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), gpsTiff()]).toString('hex');
    const rawProfile = `\nexif\n      ${hex.length / 2}\n${hex.match(/.{1,72}/g).join('\n')}\n`;
    const ztxt = pngChunk('zTXt', Buffer.concat([Buffer.from('Raw profile type exif\0\0', 'latin1'), zlib.deflateSync(Buffer.from(rawProfile))]));
    assert.equal(inspectImage(pngWith(4, 3, [ztxt])).gps, true, 'PNG zTXt raw exif');
    const text = pngChunk('tEXt', Buffer.from('Comment\0bez polohy', 'latin1'));
    assert.equal(inspectImage(pngWith(4, 3, [text])).gps, false);

    const webp = webpWith([['XMP ', Buffer.from(XMP_GPS)]]);
    assert.deepEqual(inspectImage(webp), { type: 'webp', width: 8, height: 6, gps: true });
  });

  test('názvy vyhrazené ve Windows a přípony jako .constructor se odmítnou', async () => {
    const png = pngWith(4, 3, [], 8);
    const r = await uploadsWith({
      'con.jpg': jpegWith([]),
      'aux.png': png,
      'nul.webp': png,
      'lpt1.jpg': jpegWith([]),
      'con.x.jpg': jpegWith([]),
      'conx.jpg': jpegWith([]),
      'con-x.jpg': jpegWith([]),
      'foto.constructor': jpegWith([]),
      'foto.__proto__': jpegWith([]),
    });
    const bad = r.errors.map((e) => e.where.replace('static/uploads/', '')).sort();
    assert.deepEqual(bad, ['aux.png', 'con.jpg', 'con.x.jpg', 'foto.__proto__', 'foto.constructor', 'lpt1.jpg', 'nul.webp'].sort());
    for (const name of ['foto.constructor', 'foto.__proto__']) {
      assert.match(r.errors.find((e) => e.where.endsWith(name)).message, /nepovolenou příponu/);
    }
    assert.match(r.errors.find((e) => e.where.endsWith('con.jpg')).message, /Windows/);
    assert.ok(r.images.has('conx.jpg') && r.images.has('con-x.jpg'));
  });
});

describe('kontrola HTML – obejití parseru', () => {
  test('komentáře <!-->, <!--->, --!>, lomítko místo mezery a skryté skripty se zachytí', () => {
    for (const bad of [
      '<!--><script>x</script>',
      '<!---><script>x</script>',
      '<!-- a --!><script>x</script>',
      '<script/src="https://e/x.js"></script>',
      '<img/src="https://e/x.png">',
      '<a/onclick=x>y</a>',
      '<!-- neuzavřený komentář <script>x</script>',
      '<!-- <script src="/assets/x.js"></script> -->',
      '<a href="mailto:spy%40evil.cz%2Civona@seznam.cz">x</a>',
      '<a href="mailto:ivona@seznam.cz,spy@evil.cz">x</a>',
      '<a href="mailto:ivona@seznam.cz?bcc=spy@evil.cz">x</a>',
    ]) {
      assert.ok(checkHtml(bad, 't').length > 0, bad);
    }
    assert.deepEqual(checkHtml('<br/><a href=x>y</a><a href="mailto:ivona.husakova@seznam.cz">m</a><!-- ok --><script src="/assets/theme.0123456789.js"></script>', 't'), []);
  });

  test('fail closed: značka, kterou kontrola neumí přečíst („<x", „</", „<!", „<?"), je chyba', () => {
    for (const bad of [
      '<img src=x "foo" onerror=alert(1)>', // uvozovka v názvu atributu – prohlížeč ji přijme
      "<img src=/a.png 'x'=1 onerror=alert(1)>",
      '<img src="/a.png"\u0000onerror=alert(1)>',
      '</ x><script>alert(1)</script>',
      '</>',
      '<?php echo 1 ?>',
      '<!x>',
      '<![CDATA[x]]>',
      '<!ELEMENT x>',
    ]) {
      const problems = checkHtml(bad, 't');
      assert.ok(problems.some((p) => /Nerozpoznaný zápis značky/.test(p.message)), bad);
    }
    // Plain text "<" and the doctype stay allowed; many unreadable tags give one problem only.
    assert.deepEqual(checkHtml('<!doctype html><!DOCTYPE html><p>3 < 5, a <= b, <1></p>', 't'), []);
    assert.equal(checkHtml('<a "x">'.repeat(50), 't').length, 1);
  });

  test('externí zdroje se hledají ve všech atributech, které načítají nebo odesílají (srcset, poster, ping, action …)', () => {
    for (const bad of [
      '<img src="/a.png" srcset="/a.png 1x, https://e.example/x.png 2x">',
      '<picture><source srcset="//e.example/x.webp"></picture>',
      '<link rel="preload" as="image" href="/a.png" imagesrcset="https://e.example/x.png 2x">',
      '<video poster="https://e.example/p.jpg"></video>',
      '<body background="https://e.example/b.png">',
      '<table background="//e.example/b.png"></table>',
      '<a href="/" ping="https://e.example/track">x</a>',
      '<form action="https://e.example/"></form>',
      '<button formaction="https://e.example/">x</button>',
      '<img lowsrc="https://e.example/x.png" src="/a.png">',
      '<html manifest="https://e.example/m.appcache">',
      '<link rel="preconnect" href="https://e.example">',
      '<link rel="dns-prefetch" href="//e.example">',
      '<link rel="prerender" href="https://e.example/">',
      '<link rel="alternate stylesheet" href="https://e.example/s.css">',
      '<link rel="neznamy" href="https://e.example/x">',
      '<link href="https://e.example/x">',
      '<svg><linearGradient id="g" href="https://e.example/g.svg#a"/></svg>',
      '<svg><pattern xlink:href="//e.example/p.svg#p"/></svg>',
      '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
      '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
      '<img srcset="/a.png 1x, javascript:alert(1) 2x">',
      '<blockquote cite="javascript:alert(1)">x</blockquote>',
      // Obcházení normalizací URL v prohlížeči: zakódovaná čárka v srcset, zpětné lomítko,
      // tabulátor/nový řádek uvnitř URL (prohlížeč je vypustí), mezera/řídicí znak na začátku.
      '<img src="/a.png" srcset="/a.png 1x&#44;https://e.example/x.png 2x">',
      '<img src="/a.png" srcset="/a.png 1x&comma; //e.example/x.png 2x">',
      '<img src="\\\\e.example/x.png">',
      '<img src="/\\e.example/x.png">',
      '<img src="https:\\\\e.example/x.png">',
      '<img src="ht&#9;tps://e.example/x.png">',
      '<img src="/&#10;/e.example/x.png">',
      '<img src="ht\ntps://e.example/x.png">',
      '<img src="&#1;//e.example/x.png">',
      '<script src="/&#9;/e.example/x.js"></script>',
    ]) {
      assert.ok(checkHtml(bad, 't').length > 0, bad);
    }
    for (const ok of [
      '<link rel="canonical" href="https://www.zabavadeti.cz/">',
      '<a href="https://www.facebook.com/zabava" rel="noopener noreferrer">f</a>',
      '<img src="/uploads/a.jpg" srcset="/uploads/a.jpg 1x, /uploads/b.jpg 2x" alt="">',
      '<form action="/hledat"></form>',
      '<svg><use href="#a"/><linearGradient href="#g"/></svg>',
    ]) {
      assert.deepEqual(checkHtml(ok, 't'), [], ok);
    }
  });

  test('kontrola HTML i pomocné funkce běží v lineárním čase', () => {
    const timed = (fn) => {
      const t = Date.now();
      fn();
      return Date.now() - t;
    };
    assert.ok(timed(() => checkHtml('<a '.repeat(20000), 't')) < 1000);
    assert.ok(timed(() => checkHtml('<!--'.repeat(20000), 't')) < 1000);
    assert.ok(timed(() => normalizeHeadersText('\n'.repeat(100000) + 'x')) < 200);
    assert.ok(timed(() => minifyCss(' '.repeat(100000) + 'x' + '/*'.repeat(20000))) < 200);
    assert.ok(timed(() => parseHeadersFile('/*\n  X-A: b' + ' '.repeat(100000) + 'x\n')) < 200);
    assert.equal(normalizeHeadersText(String.fromCharCode(0xfeff) + 'a\r\nb\n\n\n'), 'a\nb\n');
    assert.equal(minifyCss('/* c */\n  a { b: c; }  \n\n\n  d {}\n'), 'a { b: c; }\nd {}\n');
  });
});

describe('security.txt a hygiena repozitáře', () => {
  test('security.txt: kontakt přes GitHub (soukromé hlášení) a e-mail, platné datum', async () => {
    const text = readFileSync(join(ROOT, 'static', '.well-known', 'security.txt'), 'utf8');
    const contacts = [...text.matchAll(/^Contact:\s*(\S+)/gm)].map((m) => m[1]);
    assert.equal(contacts[0], 'https://github.com/11Lucie/zabavadeti/security/advisories/new');
    assert.ok(contacts.some((c) => c.startsWith('mailto:')));
    assert.deepEqual(await checkSecurityTxt(ROOT, new Date('2026-11-25')), []);
    const dir = await tempProject();
    await writeFile(join(dir, 'static', '.well-known', 'security.txt'), 'Expires: 2099-01-01T00:00:00.000Z\n');
    assert.match((await checkSecurityTxt(dir))[0].message, /Contact/);
  });

  test('package.json: žádné závislosti ani instalační skripty, žádný .npmrc', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
      assert.equal(pkg[k], undefined, k);
    }
    for (const s of Object.keys(pkg.scripts ?? {})) assert.ok(!/^(pre|post)?install$|^prepare$|^prepack$|^postpack$/.test(s), s);
    assert.ok(!existsSync(join(ROOT, '.npmrc')));
  });

  test('.gitignore chrání soubory s tajnými hodnotami', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    for (const p of ['.env', '.env.*', '.dev.vars*', '.claude/settings.local.json']) assert.ok(gi.includes(p), p);
  });

  test('CODEOWNERS: schvalovat smí jen správkyně', () => {
    const co = readFileSync(join(ROOT, '.github', 'CODEOWNERS'), 'utf8');
    assert.match(co, /^\* @11Lucie$/m);
  });

  test('ve zdrojových souborech nejsou neviditelné znaky', () => {
    const files = ['build.mjs', 'lib/oauth.js', 'lib/access.js', 'src/validate.mjs', 'src/safe-fs.mjs', 'scripts/check.mjs', 'scripts/serve.mjs',
      'static/admin/publish-guard.js', 'static/admin/manual-init.js', 'static/admin/index.html', 'static/admin/config.yml', 'headers/site.txt', 'headers/admin.txt'];
    for (const f of files) {
      const t = readFileSync(join(ROOT, f), 'utf8');
      assert.ok(!hasForbiddenChars(t), f);
    }
  });
});
