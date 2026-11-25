#!/usr/bin/env node
// Builds the static website into dist/.
//
//   node build.mjs
//
// No npm dependencies – only Node.js built-in modules. The build validates
// all content first; on any problem it prints a plain-Czech explanation and
// exits with a non-zero code (Cloudflare Pages then keeps the previous
// version of the site online).

import { readFile, writeFile, mkdir, rm, readdir, lstat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, dirname, sep, isAbsolute, parse as parsePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAndValidateContent } from './src/validate.mjs';
import { renderIndex, render404, renderPrivacy, renderRobots, renderSitemap, PRIVACY_PATH } from './src/render.mjs';
import { FAVICON_SVG } from './src/icons.mjs';
import { readRegularFile, reasonText } from './src/safe-fs.mjs';
import {
  checkUploads,
  checkDist,
  checkSecurityTxt,
  checkStaticTree,
  checkFunctionsTree,
  checkGitModes,
  checkRepoRoot,
  checkPackageJson,
  checkSvg,
  checkFontFile,
  formatProblems,
  SKIP_NAMES,
} from './scripts/check.mjs';

const CODE_DIR = dirname(fileURLToPath(import.meta.url));

// Files the build generates itself; static/ must not contain them.
const GENERATED = ['index.html', '404.html', 'robots.txt', 'sitemap.xml', '_headers', 'assets', PRIVACY_PATH.split('/')[1]];
const MAX_HEADERS_BYTES = 64 * 1024;
const BOM = String.fromCharCode(0xfeff);

export class BuildError extends Error {
  constructor(problems) {
    super(formatProblems(problems));
    this.name = 'BuildError';
    this.problems = problems;
  }
}

const shortHash = (data) => createHash('sha256').update(data).digest('hex').slice(0, 10);

function assertSafeOutDir(root, outDir) {
  const { root: fsRoot } = parsePath(outDir);
  const rel = relative(root, outDir);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (outDir === fsRoot || outDir === root || root.startsWith(outDir + sep)) {
    throw new Error(`Refusing to use ${outDir} as output directory.`);
  }
  if (inside && rel.split(sep)[0] !== 'dist') {
    throw new Error(`Output directory inside the project must be dist/, got ${rel}.`);
  }
}

// Recursively copies static/ to dist/, refusing symlinks and skipping junk.
async function copyStatic(srcDir, destDir, problems, relBase = '') {
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const st = await lstat(src);
    if (st.isSymbolicLink()) {
      problems.push({ where: `static/${rel}`, message: 'Ve složce static je zástupce (symbolický odkaz) – z bezpečnostních důvodů se nekopíruje.', fix: 'Nahraďte ho skutečným souborem.' });
    } else if (st.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await copyStatic(src, dest, problems, rel);
    } else if (st.isFile()) {
      await copyFile(src, dest);
    }
  }
}

async function listFilesRel(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRel(p, base)));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

// Removes /* comments */ and blank space around lines. Linear time (no regex that could
// backtrack on long runs of spaces or unclosed comments).
export function minifyCss(css) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = css.indexOf('/*', i);
    if (start === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, start);
    const end = css.indexOf('*/', start + 2);
    if (end === -1) break; // unclosed comment runs to the end, as in CSS
    i = end + 2;
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n') + '\n';
}

// BOM removed, CRLF -> LF, exactly one trailing newline. Linear time.
export function normalizeHeadersText(t) {
  if (t.startsWith(BOM)) t = t.slice(1);
  t = t.replace(/\r\n?/g, '\n');
  let e = t.length;
  while (e > 0 && t.charCodeAt(e - 1) === 10) e--;
  return t.slice(0, e) + '\n';
}

async function readHeaders(root, problems) {
  const site = await readRegularFile(root, 'headers/site.txt', MAX_HEADERS_BYTES);
  if (!site.ok) {
    problems.push({
      where: 'headers/site.txt',
      message: site.reason === 'missing' ? 'Soubor s bezpečnostními hlavičkami chybí.' : reasonText(site.reason, MAX_HEADERS_BYTES),
      fix: 'Obnovte ho z gitu.',
    });
    return null;
  }
  const siteText = normalizeHeadersText(site.text);
  if (!/^\/\*\s*$/m.test(siteText) || !/^\s+Content-Security-Policy:/m.test(siteText)) {
    problems.push({ where: 'headers/site.txt', message: 'Chybí pravidlo /* s hlavičkou Content-Security-Policy.', fix: 'Obnovte soubor z gitu.' });
  }
  let adminText = '';
  const admin = await readRegularFile(root, 'headers/admin.txt', MAX_HEADERS_BYTES);
  if (admin.ok) adminText = normalizeHeadersText(admin.text);
  else if (admin.reason !== 'missing') {
    problems.push({ where: 'headers/admin.txt', message: reasonText(admin.reason, MAX_HEADERS_BYTES), fix: 'Obnovte ho z gitu.' });
  }
  return { site: siteText, admin: adminText };
}

// Design files (fonts and SVG decorations) from src/assets/. Each one is checked (SVG only as a
// plain drawing, fonts only WOFF/WOFF2 by their magic bytes), gets a content hash in its name
// (/assets/<name>.<hash>.<ext>) and the CSS references are rewritten to the hashed names.
export const ASSET_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:svg|woff2)$/;
const MAX_ASSET_BYTES = 256 * 1024;

// Fonts every page preloads (<link rel="preload" as="font" crossorigin>): the display font of the
// big headings, both subsets (Czech needs latin-ext). The text font loads normally (font-display: swap).
export const PRELOAD_FONTS = ['baloo-latin.woff2', 'baloo-latin-ext.woff2'];

export async function loadDesignAssets(codeDir, problems) {
  const dir = join(codeDir, 'src', 'assets');
  const assets = new Map();
  if (!existsSync(dir)) return assets;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const where = `src/assets/${entry.name}`;
    const st = await lstat(join(dir, entry.name));
    if (!st.isFile() || !ASSET_NAME_RE.test(entry.name)) {
      problems.push({ where, message: 'Ve složce src/assets smí být jen soubory .svg a .woff2 s jednoduchým názvem (malá písmena, číslice, pomlčky).', fix: 'Soubor přejmenujte nebo odstraňte.' });
      continue;
    }
    if (st.size > MAX_ASSET_BYTES) {
      problems.push({ where, message: `Soubor je větší než ${MAX_ASSET_BYTES / 1024} kB.`, fix: 'Zmenšete ho.' });
      continue;
    }
    const data = await readFile(join(dir, entry.name));
    const ext = entry.name.slice(entry.name.lastIndexOf('.') + 1);
    const found = ext === 'svg' ? checkSvg(data.toString('utf8'), where) : checkFontFile(data, where);
    if (found.length) {
      problems.push(...found);
      continue;
    }
    const base = entry.name.slice(0, -(ext.length + 1));
    assets.set(entry.name, { data, hashed: `${base}.${shortHash(data)}.${ext}` });
  }
  return assets;
}

// Every url() in the CSS must point to a design file: url("/assets/<name>"). Anything else
// (data: URIs, other folders, other sites) is an error. Returns the rewritten CSS.
const CODE_FIX_CSS = 'Opravte src/styles.css (jde o kód webu, ne o obsah).';

export function rewriteCssUrls(css, assets, problems) {
  const bad = (what) => problems.push({ where: 'src/styles.css', message: `Nepovolený odkaz v CSS: ${what}. Povolené jsou jen soubory ze src/assets/ jako url("/assets/<název>").`, fix: CODE_FIX_CSS });
  // CSS escapes ("\75rl(" = url(, "@\69mport" = @import) would slip past the checks below.
  // Our styles need no backslash at all, so any backslash is an error.
  if (css.includes('\\')) bad('zpětné lomítko (escapovaný zápis, např. \\75rl( místo url()');
  if (/@import/i.test(css)) bad('@import');
  if (/\bimage-set\(|\bsrc\(/i.test(css)) bad('image-set() nebo src()');
  const out = css.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (whole, quote, url) => {
    const m = /^\/assets\/([a-z0-9-]+\.(?:svg|woff2))$/.exec(url);
    const asset = m && assets.get(m[1]);
    if (!asset) {
      bad(`url(${url.slice(0, 60)})`);
      return whole;
    }
    return `url("/assets/${asset.hashed}")`;
  });
  // Every url( left over must be one of the rewritten ones (no other spelling slips through).
  for (const m of out.matchAll(/url\(/gi)) {
    if (!/^url\("\/assets\/[a-z0-9-]+\.[0-9a-f]{10}\.(?:svg|woff2)"\)/.test(out.slice(m.index, m.index + 80))) bad('url( v nečekaném zápisu');
  }
  return out;
}

// Long cache only for the exact fingerprinted files. A rule like /assets/* would also give
// "immutable for a year" to the 404 page served for a missing /assets/… address.
// An SVG opened on its own is a document: it gets a sandbox CSP (no scripts, nothing
// loaded), like the uploads in headers/site.txt (favicon.svg has its rule there too).
export const SVG_ASSET_CSP = "default-src 'none'; sandbox";
function assetRules(names) {
  return [
    '# Soubory s otiskem obsahu v názvu se nikdy nemění -> mohou se cachovat napořád.',
    '# Pravidla generuje build (build.mjs) přesně pro aktuální soubory, ne pro celé /assets/*.',
    '# Soubory SVG otevřené samostatně jsou dokumenty -> sandbox bez skriptů (jako /uploads/*).',
    ...names.flatMap((n) => [
      `/assets/${n}`,
      '  Cache-Control: public, max-age=31536000, immutable',
      ...(n.endsWith('.svg') ? ['  ! Content-Security-Policy', `  Content-Security-Policy: ${SVG_ASSET_CSP}`] : []),
    ]),
  ].join('\n') + '\n';
}

function checkHeadersLimits(out, problems) {
  for (const [i, lineText] of out.split('\n').entries()) {
    if (lineText.length > 2000) {
      problems.push({ where: 'dist/_headers', message: `Řádek ${i + 1} je delší než 2000 znaků (limit Cloudflare Pages).`, fix: 'Zkraťte hlavičku.' });
    }
  }
  const rules = out.split('\n').filter((l) => l && !/^\s/.test(l) && !l.startsWith('#')).length;
  if (rules > 100) {
    problems.push({ where: 'dist/_headers', message: `Soubor má ${rules} pravidel, Cloudflare Pages jich povolí nejvýše 100.`, fix: 'Sloučte pravidla.' });
  }
}

export async function build({ root = CODE_DIR, outDir, log = console.log, now = new Date() } = {}) {
  root = resolve(root);
  outDir = resolve(outDir ?? join(root, 'dist'));
  assertSafeOutDir(root, outDir);

  const problems = [];
  const warnings = [];

  // 1) Photos and other uploads.
  const uploads = await checkUploads(root);
  problems.push(...uploads.errors);
  warnings.push(...uploads.warnings);

  // 2) Content.
  const { content, errors } = await loadAndValidateContent(root, uploads.images);
  problems.push(...errors);

  // 3) Headers, allowlists (repository root, static/, functions/), git (no symlinks/submodules).
  const headers = await readHeaders(root, problems);
  const staticDir = join(root, 'static');
  for (const name of GENERATED) {
    if (existsSync(join(staticDir, name))) {
      problems.push({ where: `static/${name}`, message: 'Tento soubor vytváří build sám, ve složce static být nesmí.', fix: 'Soubor ze složky static odstraňte.' });
    }
  }
  problems.push(...(await checkRepoRoot(root)));
  problems.push(...(await checkPackageJson(root)));
  problems.push(...(await checkStaticTree(root)));
  problems.push(...(await checkFunctionsTree(root)));
  problems.push(...checkGitModes(root));
  warnings.push(...(await checkSecurityTxt(root, now)));

  if (problems.length) throw new BuildError(problems);

  // 4) Output.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  if (existsSync(staticDir)) await copyStatic(staticDir, outDir, problems);
  if (problems.length) throw new BuildError(problems);

  if (!existsSync(join(outDir, 'favicon.svg'))) await writeFile(join(outDir, 'favicon.svg'), FAVICON_SVG);

  const assets = await loadDesignAssets(CODE_DIR, problems);
  const css = rewriteCssUrls(minifyCss(await readFile(join(CODE_DIR, 'src', 'styles.css'), 'utf8')), assets, problems);
  if (problems.length) throw new BuildError(problems);
  const cssName = `styles.${shortHash(css)}.css`;
  await mkdir(join(outDir, 'assets'), { recursive: true });
  await writeFile(join(outDir, 'assets', cssName), css);
  for (const { data, hashed } of assets.values()) await writeFile(join(outDir, 'assets', hashed), data);
  // Theme switcher (light/dark/system): a tiny classic script loaded in
  // <head> without defer, so data-theme is set before the first paint.
  const themeJs = (await readFile(join(CODE_DIR, 'src', 'theme.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const themeName = `theme.${shortHash(themeJs)}.js`;
  await writeFile(join(outDir, 'assets', themeName), themeJs);
  // "Kopírovat" buttons next to the phone number and e-mail (progressive enhancement, defer).
  const copyJs = (await readFile(join(CODE_DIR, 'src', 'copy.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const copyName = `copy.${shortHash(copyJs)}.js`;
  await writeFile(join(outDir, 'assets', copyName), copyJs);
  for (const name of PRELOAD_FONTS) {
    if (!assets.has(name)) problems.push({ where: `src/assets/${name}`, message: 'Chybí písmo, které stránky přednačítají.', fix: 'Obnovte soubor z gitu (nebo upravte PRELOAD_FONTS v build.mjs).' });
  }
  if (problems.length) throw new BuildError(problems);
  const fonts = PRELOAD_FONTS.map((name) => `/assets/${assets.get(name).hashed}`);
  const ctx = { cssHref: `/assets/${cssName}`, themeJs: `/assets/${themeName}`, copyJs: `/assets/${copyName}`, fonts, year: now.getFullYear() };

  // _headers = headers/site.txt, generated cache rules for the fingerprinted assets,
  // headers/admin.txt (admin rules last, they detach and replace inherited headers).
  const headersText = [headers.site, assetRules([cssName, themeName, copyName, ...[...assets.values()].map((a) => a.hashed)]), headers.admin].filter(Boolean).join('\n');
  checkHeadersLimits(headersText, problems);
  if (problems.length) throw new BuildError(problems);

  await writeFile(join(outDir, 'index.html'), renderIndex(content, ctx));
  await writeFile(join(outDir, '404.html'), render404(content, ctx));
  const privacyDir = join(outDir, ...PRIVACY_PATH.split('/').filter(Boolean));
  await mkdir(privacyDir, { recursive: true });
  await writeFile(join(privacyDir, 'index.html'), renderPrivacy(content, ctx));
  await writeFile(join(outDir, 'robots.txt'), renderRobots());
  await writeFile(join(outDir, 'sitemap.xml'), renderSitemap());
  await writeFile(join(outDir, '_headers'), headersText);

  // 5) Final safety check of the generated site.
  const dist = await checkDist(outDir);
  if (dist.errors.length) throw new BuildError(dist.errors);

  const files = await listFilesRel(outDir);
  return { outDir, files, warnings, css: cssName, js: themeName, copyJs: copyName, assets: [...assets.values()].map((a) => a.hashed) };
}

async function main() {
  const started = Date.now();
  try {
    const result = await build();
    if (result.warnings.length) {
      console.warn(`Upozornění (web se sestavil, ale doporučujeme to opravit):\n${formatProblems(result.warnings)}\n`);
    }
    const rel = relative(process.cwd(), result.outDir) || '.';
    console.log(`Hotovo: web je sestavený ve složce ${rel}${sep} (${result.files.length} souborů, ${Date.now() - started} ms).`);
  } catch (e) {
    process.exitCode = 1;
    if (e instanceof BuildError) {
      console.error('\nWeb se nepodařilo sestavit. Na internetu zůstává předchozí verze.\n');
      console.error(e.message);
      console.error(`\nCelkem ${e.problems.length} ${e.problems.length === 1 ? 'chyba' : e.problems.length < 5 ? 'chyby' : 'chyb'}. Po opravě se web sestaví znovu.`);
    } else {
      console.error('\nNeočekávaná chyba při sestavování webu (pravděpodobně chyba v programu, ne v obsahu):\n');
      console.error(e);
    }
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
