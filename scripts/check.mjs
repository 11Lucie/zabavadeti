#!/usr/bin/env node
// Safety checks used by build.mjs and runnable on their own:
//   node scripts/check.mjs
//
// 1. static/uploads: only real JPEG/PNG/WebP images (checked by magic bytes,
//    not just by extension), max 5 MB, max 40 Mpx, safe file names (also no
//    Windows device names), warning about GPS location in EXIF/XMP/PNG text.
// 2. static/ and functions/: only the known files (allowlist) – no Cloudflare
//    Pages control files (_worker.js, _redirects, _routes.json), no extra HTML.
// 3. git: no symbolic links or submodules in the repository.
// 3b. repository root: only the known files and folders (no wrangler.toml/json/jsonc,
//    .npmrc, lock files, _worker.js …), package.json without dependencies and install scripts.
// 4. dist/*.html: no inline scripts/styles, no on* event handlers, no
//    javascript: URLs, no external resources (JSON-LD is the only allowed
//    inline <script>), mailto: links with exactly one plain address. Script
//    files only from the same origin: the public pages from /assets/ (theme
//    switcher, copy buttons), the administration from /admin/.
// 5. dist/: no Cloudflare Pages control files, active file types (HTML, SVG,
//    JS, XML) only where the build puts them; SVG files only as plain drawings (checkSvg);
//    fonts only as WOFF/WOFF2 in /assets/, checked by their magic bytes (checkFontFile).

import { readdir, readFile, lstat } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectPath, reasonText } from '../src/safe-fs.mjs';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
// Null prototype: "constructor", "__proto__" … are not extensions.
const EXT_TO_TYPE = Object.freeze(Object.assign(Object.create(null), { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' }));
const IGNORED_FILES = new Set(['.gitkeep']);
// Junk files that are never copied from static/ (and never count as a problem).
export const SKIP_NAMES = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
export const MAX_DIMENSION = 12000;
// ~160 MB once decoded to RGBA. Protects visitors' browsers from "decompression bombs"
// (a few-kB PNG with 20000 × 20000 px).
export const MAX_PIXELS = 40_000_000;
const BIG_DIMENSION = 3000;
const BIG_BYTES = 2 * 1024 * 1024;
const BOM = String.fromCharCode(0xfeff);

// Windows device names – a file called e.g. con.jpg cannot be checked out on Windows
// ("invalid path"), which would break the admin's local copy of the repository.
// Shared with scripts/serve.mjs.
export const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

// static/: the only allowed entries (see checkStaticTree).
const STATIC_TOP = new Map([
  ['admin', 'dir'],
  ['uploads', 'dir'],
  ['.well-known', 'dir'],
  ['favicon.svg', 'file'],
  ['site.webmanifest', 'file'],
]);
const STATIC_ADMIN_FILES = new Set([
  'index.html',
  'config.yml',
  'decap-cms.js',
  'decap-cms.js.LICENSE.txt',
  'LICENSE-decap-cms.txt',
  'publish-guard.js',
  'manual-init.js',
]);
const STATIC_WELL_KNOWN_FILES = new Set(['security.txt']);
// functions/: every file there becomes a server route on Cloudflare Pages.
const FUNCTIONS_FILES = new Set(['api/auth.js', 'api/callback.js']);

// ---------------------------------------------------------------------------
// Problem formatting (shared with build.mjs)
// ---------------------------------------------------------------------------

export function formatProblem(p) {
  const head = p.field ? `${p.where} – ${p.field}` : p.where;
  let out = `  • ${head}\n    ${p.message}`;
  if (p.fix) out += `\n    Co udělat: ${p.fix}`;
  return out;
}

export function formatProblems(list) {
  return list.map(formatProblem).join('\n\n');
}

// ---------------------------------------------------------------------------
// Image inspection
// ---------------------------------------------------------------------------

export function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Rough description of a non-image file, for a friendlier error message.
function describeOther(buf) {
  let head = buf.subarray(0, 512).toString('utf8');
  if (head.startsWith(BOM)) head = head.slice(1);
  head = head.trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'SVG obrázek (může obsahovat skripty, proto není povolený)';
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<script')) return 'HTML stránka';
  if (head.startsWith('<?xml') || head.startsWith('<')) return 'XML/HTML soubor';
  if (head.startsWith('gif8')) return 'GIF obrázek';
  if (head.startsWith('%pdf')) return 'PDF dokument';
  if (head.startsWith('pk')) return 'ZIP/Office soubor';
  if (head.startsWith('mz')) return 'spustitelný program';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12).toLowerCase();
    if (/hei|hev|mif1|msf1/.test(brand)) return 'fotka ve formátu HEIC (iPhone)';
    if (brand.startsWith('avi')) return 'obrázek AVIF';
    return 'video';
  }
  return 'neznámý typ souboru';
}

// Parses a TIFF/EXIF block. Returns { gps, orientation }.
export function parseExif(tiff) {
  const result = { gps: false, orientation: 1 };
  if (!tiff || tiff.length < 8) return result;
  const order = tiff.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return result;
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return result;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return result;
  const count = u16(ifd);
  for (let k = 0; k < count && k < 1000; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.length) break;
    const tag = u16(e);
    if (tag === 0x8825) {
      // GPS IFD pointer. Count the entries of the GPS IFD when possible;
      // if the pointer is broken, err on the safe side and report GPS.
      const off = u32(e + 8);
      result.gps = off + 2 <= tiff.length ? u16(off) > 0 : true;
    } else if (tag === 0x0112) {
      result.orientation = u16(e + 8);
    }
  }
  return result;
}

// GPS position written as XMP (Lightroom, Photoshop …) or as plain text.
const XMP_GPS_RE = /GPS(?:Latitude|Longitude)/;

// ImageMagick stores EXIF in PNG text chunks "Raw profile type exif/APP1":
// "\nexif\n   <length>\n<hex digits in lines>".
function rawProfileGps(text) {
  const m = /^\s*\S+\s+\d+\s+([0-9a-fA-F\s]+)$/.exec(text);
  if (!m) return XMP_GPS_RE.test(text);
  let bytes = Buffer.from(m[1].replace(/\s+/g, ''), 'hex');
  if (bytes.toString('latin1', 0, 6) === 'Exif\0\0') bytes = bytes.subarray(6);
  return parseExif(bytes).gps;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const XMP_HEADERS = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0'];

function inspectJpeg(buf) {
  let i = 2;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let firstExif = true;
  let gps = false;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return { error: 'vnitřní struktura JPEG je poškozená' };
    let marker = buf[i + 1];
    while (marker === 0xff && i + 2 < buf.length) {
      i++;
      marker = buf[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    const start = i + 4;
    const end = i + 2 + len;
    if (len < 2 || end > buf.length) return { error: 'vnitřní struktura JPEG je poškozená' };
    if (marker === 0xe1) {
      // Every APP1 segment: EXIF (there may be more than one) and XMP.
      if (buf.toString('latin1', start, start + 6) === 'Exif\0\0') {
        const meta = parseExif(buf.subarray(start + 6, end));
        if (firstExif) orientation = meta.orientation;
        firstExif = false;
        gps ||= meta.gps;
      } else if (XMP_HEADERS.some((h) => buf.toString('latin1', start, start + h.length) === h)) {
        gps ||= XMP_GPS_RE.test(buf.toString('latin1', start, end));
      }
    }
    if (SOF_MARKERS.has(marker) && len >= 7) {
      height = buf.readUInt16BE(start + 1);
      width = buf.readUInt16BE(start + 3);
    }
    i = end;
  }
  if (!width || !height) return { error: 'nepodařilo se zjistit rozměry obrázku' };
  // EXIF orientations 5–8 rotate the image by 90°: swap displayed dimensions.
  if (orientation >= 5 && orientation <= 8) [width, height] = [height, width];
  return { width, height, gps };
}

const MAX_TEXT_INFLATE = 8 * 1024 * 1024;

// PNG tEXt / zTXt / iTXt chunk -> { keyword, text } (text decompressed when needed).
function pngText(type, data) {
  const nul = data.indexOf(0);
  if (nul <= 0) return null;
  const keyword = data.toString('latin1', 0, nul);
  let rest = data.subarray(nul + 1);
  let compressed = false;
  if (type === 'zTXt') {
    compressed = true;
    rest = rest.subarray(1); // compression method
  } else if (type === 'iTXt') {
    compressed = rest[0] === 1;
    rest = rest.subarray(2); // compression flag + method
    const lang = rest.indexOf(0);
    if (lang === -1) return null;
    const trans = rest.indexOf(0, lang + 1);
    if (trans === -1) return null;
    rest = rest.subarray(trans + 1);
  }
  if (compressed) rest = inflateSync(rest, { maxOutputLength: MAX_TEXT_INFLATE });
  return { keyword, text: rest.toString(type === 'iTXt' ? 'utf8' : 'latin1') };
}

function inspectPng(buf) {
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return { error: 'vnitřní struktura PNG je poškozená' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let gps = false;
  let i = 8;
  for (let n = 0; n < 10000 && i + 12 <= buf.length; n++) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (i + 12 + len > buf.length) break;
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'eXIf') gps ||= parseExif(data).gps;
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      let t = null;
      try {
        t = pngText(type, data);
      } catch {
        t = null; // broken or oversized text chunk – not our business here
      }
      if (t) gps ||= /^Raw profile type (?:exif|APP1)$/i.test(t.keyword) ? rawProfileGps(t.text) : XMP_GPS_RE.test(t.text);
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return { width, height, gps };
}

function inspectWebp(buf) {
  let width = 0;
  let height = 0;
  let gps = false;
  let i = 12;
  for (let n = 0; n < 10000 && i + 8 <= buf.length; n++) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const d = i + 8;
    if (d + len > buf.length) break;
    if (type === 'VP8X' && len >= 10) {
      width = 1 + buf.readUIntLE(d + 4, 3);
      height = 1 + buf.readUIntLE(d + 7, 3);
    } else if (type === 'VP8 ' && len >= 10 && !width) {
      width = buf.readUInt16LE(d + 6) & 0x3fff;
      height = buf.readUInt16LE(d + 8) & 0x3fff;
    } else if (type === 'VP8L' && len >= 5 && !width) {
      if (buf[d] !== 0x2f) return { error: 'vnitřní struktura WebP je poškozená' };
      const b = buf.readUInt32LE(d + 1);
      width = (b & 0x3fff) + 1;
      height = ((b >> 14) & 0x3fff) + 1;
    } else if (type === 'EXIF') {
      let ex = buf.subarray(d, d + len);
      if (ex.toString('latin1', 0, 6) === 'Exif\0\0') ex = ex.subarray(6);
      gps ||= parseExif(ex).gps;
    } else if (type === 'XMP ') {
      gps ||= XMP_GPS_RE.test(buf.toString('latin1', d, d + len));
    }
    i = d + len + (len % 2);
  }
  if (!width || !height) return { error: 'nepodařilo se zjistit rozměry obrázku' };
  return { width, height, gps };
}

// Returns { type, width, height, gps } or { error }.
export function inspectImage(buf) {
  const type = sniffType(buf);
  if (!type) return { error: `soubor není fotka JPG, PNG ani WebP – podle obsahu je to ${describeOther(buf)}` };
  let info;
  try {
    info = type === 'jpeg' ? inspectJpeg(buf) : type === 'png' ? inspectPng(buf) : inspectWebp(buf);
  } catch {
    info = { error: 'soubor je poškozený' };
  }
  if (info.error) return { type, error: info.error };
  if (info.width < 1 || info.height < 1 || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
    return { type, error: `nesmyslné rozměry obrázku (${info.width} × ${info.height} px, povoleno nejvýše ${MAX_DIMENSION} px na stranu)` };
  }
  if (info.width * info.height > MAX_PIXELS) {
    return { type, error: `obrázek má příliš mnoho pixelů (${info.width} × ${info.height} px). Zmenšete ho na šířku kolem 1600 px` };
  }
  return { type, ...info };
}

// ---------------------------------------------------------------------------
// Uploads check
// ---------------------------------------------------------------------------

function nameProblem(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (ext === 'svg' || ext === 'svgz') {
    return 'Obrázky SVG nejsou povolené – mohou obsahovat skripty, které by šlo zneužít k útoku na návštěvníky webu.';
  }
  if (ext === 'heic' || ext === 'heif') {
    return 'Fotky ve formátu HEIC (z iPhonu) prohlížeče neumí zobrazit.';
  }
  if (!Object.hasOwn(EXT_TO_TYPE, ext)) {
    return `Soubor má nepovolenou příponu „${ext ? '.' + ext : '(žádná)'}“. Povolené jsou jen .jpg, .jpeg, .png a .webp.`;
  }
  if (!SAFE_NAME.test(name) || name.includes('..') || name.length > 100) {
    return 'Název souboru smí obsahovat jen malá písmena bez diakritiky, číslice, tečku, pomlčku a podtržítko (např. ivona-s-maskoty.jpg).';
  }
  if (WINDOWS_DEVICE_RE.test(lower)) {
    return 'Název souboru je ve Windows vyhrazený (con, aux, nul, prn, com1…, lpt1…) a soubor by rozbil kopii webu v počítači.';
  }
  return null;
}

// Returns { errors, warnings, images: Map<name, {type,width,height,bytes}> }.
export async function checkUploads(root) {
  const errors = [];
  const warnings = [];
  const images = new Map();
  const dir = join(root, 'static', 'uploads');
  if (!existsSync(dir)) return { errors, warnings, images };
  const dirInfo = await inspectPath(root, 'static/uploads', 'dir');
  if (!dirInfo.ok) {
    errors.push({ where: 'static/uploads', message: `Složka s fotkami: ${reasonText(dirInfo.reason)}`, fix: 'Obnovte složku z gitu.' });
    return { errors, warnings, images };
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    const where = `static/uploads/${name}`;
    if (IGNORED_FILES.has(name)) continue;
    const st = await lstat(join(dir, name));
    if (st.isSymbolicLink()) {
      errors.push({ where, message: 'Ve složce s fotkami je zástupce (symbolický odkaz).', fix: 'Odstraňte ho a nahrajte skutečný soubor.' });
      continue;
    }
    if (st.isDirectory()) {
      errors.push({ where, message: 'Ve složce s fotkami je podsložka. Fotky musí ležet přímo ve složce static/uploads.', fix: 'Fotky přesuňte o úroveň výš a podsložku smažte.' });
      continue;
    }
    if (!st.isFile()) {
      errors.push({ where, message: 'Toto není běžný soubor.', fix: 'Odstraňte ho.' });
      continue;
    }

    const badName = nameProblem(name);
    if (badName) {
      errors.push({ where, message: badName, fix: 'Soubor přejmenujte (nebo převeďte do formátu JPG) a nahrajte ho znovu; nepovolený soubor smažte.' });
      continue;
    }
    if (st.size > MAX_UPLOAD_BYTES) {
      errors.push({
        where,
        message: `Soubor má ${(st.size / 1024 / 1024).toFixed(1)} MB, povoleno je nejvýše 5 MB.`,
        fix: 'Fotku zmenšete (stačí šířka kolem 1600 px) a nahrajte ji znovu.',
      });
      continue;
    }

    const buf = await readFile(join(dir, name));
    const info = inspectImage(buf);
    if (info.error) {
      errors.push({ where, message: `Soubor nelze použít: ${info.error}.`, fix: 'Soubor smažte. Nahrávat lze jen fotky ve formátu JPG, PNG nebo WebP do 12 000 px na stranu.' });
      continue;
    }
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (EXT_TO_TYPE[ext] !== info.type) {
      errors.push({
        where,
        message: `Přípona souboru neodpovídá obsahu (přípona .${ext}, ale uvnitř je ${info.type.toUpperCase()}).`,
        fix: `Přejmenujte soubor tak, aby končil .${info.type === 'jpeg' ? 'jpg' : info.type}, a nahrajte ho znovu.`,
      });
      continue;
    }
    if (info.gps) {
      warnings.push({
        where,
        message: 'Fotka obsahuje GPS souřadnice místa, kde byla vyfocena (běžné u fotek z mobilu). Kdokoli si je může z fotky na webu přečíst.',
        fix: 'Pokud to nechcete, odstraňte z fotky údaje o poloze (ve Windows: pravým tlačítkem → Vlastnosti → Podrobnosti → Odebrat vlastnosti a osobní informace) a nahrajte ji znovu.',
      });
    }
    if (info.width > BIG_DIMENSION || info.height > BIG_DIMENSION || st.size > BIG_BYTES) {
      warnings.push({
        where,
        message: `Fotka je zbytečně velká (${info.width} × ${info.height} px, ${(st.size / 1024 / 1024).toFixed(1)} MB) – web se kvůli ní bude na mobilu načítat pomaleji.`,
        fix: 'Doporučujeme ji zmenšit na šířku kolem 1600 px.',
      });
    }
    images.set(name, { type: info.type, width: info.width, height: info.height, bytes: st.size });
  }
  return { errors, warnings, images };
}

// ---------------------------------------------------------------------------
// Allowlists: static/ and functions/
// ---------------------------------------------------------------------------

const CODE_FIX = 'Tohle není text ani fotka, ale kód webu. Soubor odstraňte; pokud ho opravdu potřebujete, musí ho do kontroly (scripts/check.mjs) přidat správce webu.';

// static/ may contain only the known files. Anything else (Cloudflare Pages control files
// such as _worker.js, _redirects, _routes.json, extra HTML pages, scripts) fails the build.
export async function checkStaticTree(root) {
  const errors = [];
  if (!existsSync(join(root, 'static'))) return errors;
  const top = await inspectPath(root, 'static', 'dir');
  if (!top.ok) {
    errors.push({ where: 'static', message: `Složka static: ${reasonText(top.reason)}`, fix: 'Obnovte složku z gitu.' });
    return errors;
  }
  const add = (rel, message) => errors.push({ where: `static/${rel}`, message, fix: CODE_FIX });
  for (const entry of await readdir(join(root, 'static'), { withFileTypes: true })) {
    const name = entry.name;
    if (SKIP_NAMES.has(name)) continue;
    if (name.startsWith('_')) {
      add(name, 'Řídicí soubor Cloudflare Pages (název začíná podtržítkem, např. _worker.js, _redirects, _routes.json) – ve static/ být nesmí, je to kód, který by měnil chování serveru.');
      continue;
    }
    const kind = STATIC_TOP.get(name);
    const st = await lstat(join(root, 'static', name));
    if (st.isSymbolicLink()) continue; // reported by copyStatic with a precise message
    if (!kind || (kind === 'dir' ? !st.isDirectory() : !st.isFile())) {
      add(name, 'Neznámý soubor nebo složka ve static/. Povolené jsou jen admin/, uploads/, .well-known/, favicon.svg a site.webmanifest.');
      continue;
    }
    if (name === 'admin' || name === '.well-known') {
      const allowed = name === 'admin' ? STATIC_ADMIN_FILES : STATIC_WELL_KNOWN_FILES;
      for (const sub of await readdir(join(root, 'static', name), { withFileTypes: true })) {
        if (SKIP_NAMES.has(sub.name)) continue;
        const subSt = await lstat(join(root, 'static', name, sub.name));
        if (subSt.isSymbolicLink()) continue;
        if (!allowed.has(sub.name) || !subSt.isFile()) {
          add(`${name}/${sub.name}`, `Neznámý soubor ve static/${name}/. Povolené jsou jen: ${[...allowed].join(', ')}.`);
        }
      }
    }
  }
  return errors;
}

async function listRel(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listRel(p, base)));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

// functions/: every file becomes a server route (code with access to the secrets).
export async function checkFunctionsTree(root) {
  const errors = [];
  const dir = join(root, 'functions');
  if (!existsSync(dir)) return errors;
  const info = await inspectPath(root, 'functions', 'dir');
  if (!info.ok) return [{ where: 'functions', message: `Složka functions: ${reasonText(info.reason)}`, fix: CODE_FIX }];
  for (const rel of await listRel(dir)) {
    if (SKIP_NAMES.has(rel.split('/').pop())) continue;
    const st = await lstat(join(dir, ...rel.split('/')));
    if (!FUNCTIONS_FILES.has(rel) || !st.isFile()) {
      errors.push({ where: `functions/${rel}`, message: 'Neznámý soubor ve functions/ – na Cloudflare by se z něj stala serverová adresa s přístupem k tajným klíčům.', fix: CODE_FIX });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Allowlist: repository root
// ---------------------------------------------------------------------------

// Cloudflare Pages reads some files in the repository root before (or instead of) our build:
// wrangler.toml / wrangler.json / wrangler.jsonc (pages_build_output_dir would publish another
// folder and skip checkDist, [vars] would override the variables set in Cloudflare), package
// manager files (.npmrc, lock files, bun.lockb … trigger installs that run foreign code) and
// Pages control files. Only the known files and folders are allowed.
const ROOT_FILES = new Set(['.gitattributes', '.gitignore', '.node-version', 'NAVOD.md', 'README.md', 'build.mjs', 'package.json']);
const ROOT_DIRS = new Set(['.claude', '.github', 'content', 'docs', 'functions', 'headers', 'lib', 'scripts', 'src', 'static', 'tests']);
// Folders where only the listed files are allowed (in git).
const ROOT_DIR_FILES = new Map([
  ['.github', new Set(['CODEOWNERS'])], // no workflows (GitHub Actions are off), no settings
  ['.claude', new Set(['launch.json'])],
]);
// Local files that are never in the repository (.gitignore): allowed on disk, not in git.
const LOCAL_ONLY_DIRS = new Set(['.git', 'dist', 'node_modules', '.wrangler']);
const LOCAL_ONLY_FILE_RE = /^(?:\.git|\.dev\.vars(?:\..*)?|\.env(?:\..*)?|.*\.log)$/;
const LOCAL_ONLY_NESTED = new Map([['.claude', new Set(['settings.local.json'])]]);

// Names with a specific (dangerous) meaning in the root. Rejected even when not in git.
export function dangerousRootName(name) {
  if (/^wrangler\./i.test(name)) {
    return 'Nastavení Wrangleru (wrangler.toml/json/jsonc) – Cloudflare by podle něj mohl zveřejnit jinou složku než zkontrolovaný web a přepsat proměnné (např. ALLOWED_GITHUB_USERS).';
  }
  if (/^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|bunfig\.toml|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.yarn)$/i.test(name)) {
    return 'Soubor správce balíčků (npm/yarn/pnpm/bun) – Cloudflare by před sestavením instaloval cizí kód. Web žádné balíčky nepoužívá. (Pokud ho při sestavení vytvořil sám Cloudflare, chybí v nastavení proměnná SKIP_DEPENDENCY_INSTALL=1, NAVOD B4.)';
  }
  if (/^(?:requirements\.txt|pipfile(?:\.lock)?|pyproject\.toml|runtime\.txt|gemfile(?:\.lock)?|\.ruby-version|\.python-version|\.nvmrc|\.tool-versions|composer\.(?:json|lock)|go\.mod)$/i.test(name)) {
    return 'Soubor, podle kterého by Cloudflare před sestavením instaloval jiné programy nebo jinou verzi Node.js.';
  }
  if (name.startsWith('_')) {
    return 'Řídicí soubor Cloudflare Pages (_worker.js, _routes.json, _redirects, _headers …) – v kořeni projektu být nesmí.';
  }
  return null;
}

const ROOT_FIX = 'Soubor odstraňte (v návrhu ho neschvalujte – může jít o ukradený účet). Pokud ho opravdu potřebujete, musí ho do kontroly (scripts/check.mjs) přidat správce webu.';

// Tracked files of the repository whose top is exactly root, or null (no git, tests, copies).
function gitTrackedFiles(root) {
  const opts = { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], opts);
  if (top.error || top.status !== 0) return null;
  if (normPath(top.stdout) !== normPath(root)) return null;
  const ls = spawnSync('git', ['-C', root, 'ls-files', '-z'], opts);
  if (ls.error || ls.status !== 0) return null;
  return ls.stdout.split('\0').filter(Boolean);
}

function trackedPathAllowed(path) {
  const parts = path.split('/');
  if (parts.length === 1) return ROOT_FILES.has(path);
  const top = parts[0];
  if (!ROOT_DIRS.has(top)) return false;
  const only = ROOT_DIR_FILES.get(top);
  return !only || (parts.length === 2 && only.has(parts[1]));
}

// Returns a list of problems. With git (local copy, Cloudflare clone): every tracked file must be
// allowed – what is in the repository decides. Files that are not in git cannot come from a
// draft; they are created locally or by the build machine (e.g. package-lock.json from an
// automatic npm install when SKIP_DEPENDENCY_INSTALL is missing), so they are not checked.
// Without git (tests, copies): everything on disk except the local-only files.
export async function checkRepoRoot(root) {
  const errors = [];
  const reported = new Set();
  const add = (where, message) => {
    if (reported.has(where)) return;
    reported.add(where);
    errors.push({ where, message, fix: ROOT_FIX });
  };
  const tracked = gitTrackedFiles(root);
  for (const entry of tracked ? [] : await readdir(root, { withFileTypes: true })) {
    const name = entry.name;
    const danger = dangerousRootName(name);
    if (danger) {
      add(name, danger);
      continue;
    }
    if (SKIP_NAMES.has(name)) continue;
    const st = await lstat(join(root, name));
    if (st.isDirectory() ? LOCAL_ONLY_DIRS.has(name) : LOCAL_ONLY_FILE_RE.test(name)) continue;
    const ok = st.isSymbolicLink() ? false : st.isDirectory() ? ROOT_DIRS.has(name) : st.isFile() && ROOT_FILES.has(name);
    if (!ok) {
      add(name, 'Neznámý soubor nebo složka v kořeni projektu.');
      continue;
    }
    const only = ROOT_DIR_FILES.get(name);
    if (!only) continue;
    const local = LOCAL_ONLY_NESTED.get(name) ?? new Set();
    for (const sub of await readdir(join(root, name), { withFileTypes: true })) {
      if (SKIP_NAMES.has(sub.name) || local.has(sub.name)) continue;
      const subSt = await lstat(join(root, name, sub.name));
      if (!only.has(sub.name) || !subSt.isFile()) add(`${name}/${sub.name}`, `Neznámý soubor ve složce ${name}/. Povolené jsou jen: ${[...only].join(', ')}.`);
    }
  }
  for (const path of tracked ?? []) {
    if (trackedPathAllowed(path)) continue;
    const top = path.split('/')[0];
    const danger = dangerousRootName(top);
    add(path, danger ?? (ROOT_DIR_FILES.has(top)
      ? `Neznámý soubor ve složce ${top}/ (v gitu). Povolené jsou jen: ${[...ROOT_DIR_FILES.get(top)].join(', ')}.`
      : 'Neznámý soubor nebo složka v kořeni repozitáře (v gitu).'));
  }
  return errors;
}

// package.json: no dependencies and no scripts that npm runs on its own (install hooks).
const PKG_DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'workspaces', 'overrides'];
const PKG_AUTO_SCRIPT_RE = /^(?:pre|post)?(?:install|uninstall|prepare|prepack|postpack|prepublish(?:Only)?|publish|ci|dependencies)$/;

export async function checkPackageJson(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return [];
  const where = 'package.json';
  const fix = 'Web žádné npm balíčky ani instalační skripty nepoužívá. Změnu vraťte (v návrhu ji neschvalujte).';
  let pkg;
  try {
    const text = await readFile(file, 'utf8');
    pkg = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch {
    return [{ where, message: 'Soubor package.json není platný JSON.', fix }];
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return [{ where, message: 'Soubor package.json nemá očekávaný tvar.', fix }];
  const errors = [];
  for (const k of PKG_DEP_KEYS) {
    if (Object.hasOwn(pkg, k)) errors.push({ where, field: k, message: `Položka „${k}“ – Cloudflare by před sestavením instaloval balíčky (cizí kód).`, fix });
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [];
  for (const s of scripts) {
    if (PKG_AUTO_SCRIPT_RE.test(s)) errors.push({ where, field: `scripts.${s}`, message: `Skript „${s}“ spouští npm automaticky (např. při instalaci) – ještě před kontrolami buildu.`, fix });
  }
  return errors;
}

// realpath: same form for both (Windows short 8.3 names, symlinked temp dirs, letter case).
function normPath(p) {
  let r = resolve(p.trim());
  try {
    r = realpathSync.native(r);
  } catch {
    // keep the resolved path
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// Symbolic links (mode 120000) and submodules (160000) in git. Skipped silently when git
// is not available or root is not the top of a git repository (tests, copies without .git).
export function checkGitModes(root) {
  const errors = [];
  const opts = { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], opts);
  if (top.error || top.status !== 0) return errors;
  if (normPath(top.stdout) !== normPath(root)) return errors;
  const ls = spawnSync('git', ['-C', root, 'ls-files', '-s', '-z'], opts);
  if (ls.error || ls.status !== 0) return errors;
  for (const rec of ls.stdout.split('\0')) {
    const m = /^(\d{6}) [0-9a-f]+ \d\t(.*)$/s.exec(rec);
    if (!m) continue;
    if (m[1] === '120000') {
      errors.push({ where: m[2], message: 'V repozitáři je zástupce (symbolický odkaz). Na serveru by mohl číst soubory mimo projekt.', fix: 'Nahraďte ho skutečným souborem (git rm a nový soubor).' });
    } else if (m[1] === '160000') {
      errors.push({ where: m[2], message: 'V repozitáři je vnořený repozitář (submodule).', fix: 'Odstraňte ho; projekt žádné submoduly nepoužívá.' });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Built HTML check
// ---------------------------------------------------------------------------

// One tag at a given position (sticky). Attributes may be separated by whitespace or "/"
// (as browsers do: <script/src=…>), attribute names never contain "<".
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[\s/]+[^\s"'>/=<]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)[\s/]*>/y;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// Attributes holding a URL (checked for javascript:/vbscript:/data:).
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'srcset', 'imagesrcset', 'background',
  'ping', 'cite', 'longdesc', 'lowsrc', 'dynsrc', 'codebase', 'archive', 'manifest', 'icon', 'profile', 'classid', 'usemap']);
// Attributes that make the browser load or send something on their own (on any element): an
// external value is an external resource. srcset/imagesrcset/ping/archive hold several URLs.
const RESOURCE_ATTRS = new Set(['src', 'srcset', 'imagesrcset', 'poster', 'background', 'ping', 'action', 'formaction', 'data',
  'codebase', 'archive', 'lowsrc', 'dynsrc', 'manifest', 'icon', 'profile', 'classid']);
// SVG animation elements can rewrite href to javascript: after the check (<set attributeName="href" to=…>).
const FORBIDDEN_TAGS = new Set(['style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'foreignobject',
  'set', 'animate', 'animatemotion', 'animatetransform', 'discard']);
// <link rel=…> values that only describe a page (no download): an external href is fine only with these.
const NAV_LINK_RELS = new Set(['canonical', 'alternate', 'author', 'license', 'me', 'help', 'next', 'prev', 'bookmark', 'external',
  'nofollow', 'noopener', 'noreferrer']);
const MAILTO_RE = /^mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&sol;/g, '/')
    .replace(/&bsol;/g, '\\')
    .replace(/&comma;/g, ',')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Any URL with a scheme or protocol-relative URL loads from elsewhere.
// data: URLs are handled separately (see isHarmlessData).
// The URL is normalised the way a browser parses it: entities decoded, tabs/newlines removed
// anywhere, leading C0 controls/spaces stripped, "\" read as "/" (so "/\evil", "\\evil",
// "ht\ttps://evil" or "/&#10;/evil" are all caught).
function isExternal(url) {
  const u = decodeEntities(url).replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '').replace(/\\/g, '/');
  if (/^data:/i.test(u)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//');
}

// The only data: URL we accept is an inline favicon on <link rel="icon">
// (e.g. href="data:," to stop the browser from requesting /favicon.ico).
function isHarmlessData(tag, attrName, attrs) {
  return tag === 'link' && attrName === 'href' && /(^|\s)icon(\s|$)/i.test(attrs.get('rel') ?? '');
}

// A script file must be a plain same-origin path inside one of the allowed
// folders, e.g. /assets/theme.0123456789.js (no query, no "..", no "//").
export function isAllowedScriptSrc(src, scriptDirs) {
  const u = decodeEntities(src).trim();
  return /^\/[A-Za-z0-9._/-]+\.js$/.test(u)
    && !u.includes('..')
    && !u.includes('//')
    && scriptDirs.some((dir) => u.startsWith(dir));
}

// Folders a page may load script files from (see checkDist).
const PUBLIC_SCRIPT_DIRS = ['/assets/'];
const ADMIN_SCRIPT_DIRS = ['/admin/'];

// End of an HTML comment starting at i ("<!--"), as browsers parse it: "<!-->" and "<!--->"
// close immediately, otherwise the first "-->" or "--!>". Returns the index after the
// comment, or -1 when it is never closed.
function commentEnd(htmlText, i) {
  if (htmlText.startsWith('<!-->', i)) return i + 5;
  if (htmlText.startsWith('<!--->', i)) return i + 6;
  const a = htmlText.indexOf('-->', i + 4);
  const b = htmlText.indexOf('--!>', i + 4);
  if (a === -1 && b === -1) return -1;
  if (b === -1 || (a !== -1 && a < b)) return a + 3;
  return b + 4;
}

// All URLs of an attribute value (srcset: "url 2x, url 640w"; ping/archive: space separated).
function attrUrls(name, value) {
  if (name === 'srcset' || name === 'imagesrcset') return value.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
  if (name === 'ping' || name === 'archive') return value.split(/[\s,]+/).filter(Boolean);
  return [value];
}

// Checks one HTML document. Returns a list of problems.
export function checkHtml(htmlText, where, { scriptDirs = PUBLIC_SCRIPT_DIRS } = {}) {
  const problems = [];
  const add = (message) => problems.push({ where, message, fix: 'Chyba je v šablonách webu (src/) nebo v administraci – kontaktujte správce webu.' });
  const lower = htmlText.toLowerCase();
  let scriptTags = 0;
  let unclosedCommentFrom = Infinity;
  let unparsed = 0;
  let i = 0;
  while ((i = htmlText.indexOf('<', i)) !== -1) {
    if (htmlText.startsWith('<!--', i)) {
      // An unclosed comment is NOT treated as a comment: the rest is still checked (fail safe).
      const end = i >= unclosedCommentFrom ? -1 : commentEnd(htmlText, i);
      if (end === -1) {
        unclosedCommentFrom = Math.min(unclosedCommentFrom, i);
        i += 4;
      } else {
        i = end;
      }
      continue;
    }
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(htmlText);
    if (!m) {
      // Fail closed: where a browser starts a tag ("<a", "</", "<!", "<?"), the check must have
      // recognised one. Only "<" followed by anything else (space, digit …) is plain text.
      // <!doctype …> is the one allowed markup declaration besides comments.
      if (/^<[A-Za-z/!?]/.test(htmlText.slice(i, i + 2)) && !/^<!doctype[\s>]/i.test(htmlText.slice(i, i + 10))) {
        if (unparsed++ === 0) {
          add(`Nerozpoznaný zápis značky „${htmlText.slice(i, i + 40).replace(/\s+/g, ' ')}“ – kontrola ho neumí ověřit, prohlížeč by ho ale mohl brát jako prvek.`);
        }
      }
      i++;
      continue;
    }
    i = TAG_RE.lastIndex;
    if (m[1]) continue;
    const tag = m[2].toLowerCase();
    const attrs = new Map();
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(m[3]))) {
      // The browser uses the first occurrence of a repeated attribute, so the
      // check must too (e.g. <script src="https://…" src="/assets/x.js">).
      // A repeated attribute is never needed in our pages – report it.
      const name = a[1].toLowerCase();
      if (attrs.has(name)) add(`Atribut ${name}= je u prvku <${tag}> uvedený vícekrát.`);
      else attrs.set(name, a[2] ?? a[3] ?? a[4] ?? '');
    }

    if (FORBIDDEN_TAGS.has(tag)) add(`Nepovolený prvek <${tag}>.`);
    for (const [name, value] of attrs) {
      if (name.startsWith('on')) add(`Nepovolený atribut ${name}= u prvku <${tag}> (vložený JavaScript).`);
      if (name === 'style') add(`Nepovolený atribut style= u prvku <${tag}> (vložené styly).`);
      if (URL_ATTRS.has(name)) {
        const v = decodeEntities(value).replace(/[\x00-\x20\x7f]/g, '').toLowerCase();
        const dangerous = attrUrls(name, decodeEntities(value)).concat(v).some((url) => {
          const u = url.replace(/[\x00-\x20\x7f]/g, '').toLowerCase();
          return /^(javascript|vbscript):/.test(u) || (u.startsWith('data:') && !isHarmlessData(tag, name, attrs));
        });
        if (dangerous) add(`Nebezpečný odkaz „${value.slice(0, 40)}“ v atributu ${name}= u prvku <${tag}>.`);
        // mailto: exactly one plain address – no %-encoding, ",", "?", "&" (extra recipients/headers).
        if (name === 'href' && v.startsWith('mailto:') && !MAILTO_RE.test(decodeEntities(value).trim())) {
          add(`Odkaz „${value.slice(0, 60)}“ nemá tvar mailto: s jedinou obyčejnou e-mailovou adresou.`);
        }
      }
      if (name === 'http-equiv' && /refresh/i.test(value)) add('Nepovolené automatické přesměrování <meta http-equiv="refresh">.');
    }

    // External resources (links to other websites are fine, loading scripts/styles/images from
    // them – or sending anything there (ping, form action) – is not). Fail closed: every
    // attribute that loads on its own is checked on every element, every URL of a srcset.
    const resources = [];
    for (const [name, value] of attrs) {
      // Decode first, so an encoded comma (&#44;) still separates srcset candidates.
      if (RESOURCE_ATTRS.has(name)) resources.push(...attrUrls(name, decodeEntities(value)));
    }
    if (tag === 'link') {
      // An external href only for links that describe the page (canonical …); stylesheet, icon,
      // preload, preconnect, dns-prefetch, prerender and any unknown rel would contact the host.
      const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!rels.length || rels.some((r) => !NAV_LINK_RELS.has(r))) resources.push(attrs.get('href') ?? '');
    } else if (tag !== 'a' && tag !== 'area') {
      // Inline SVG: <use>, <image>, <feImage>, gradients, patterns … load what href points to.
      for (const name of ['href', 'xlink:href']) if (attrs.has(name)) resources.push(attrs.get(name));
    }
    for (const res of resources) {
      if (isExternal(res)) add(`Externí zdroj „${res.slice(0, 60)}“ u prvku <${tag}> – web smí načítat jen vlastní soubory.`);
    }

    if (tag === 'script') {
      scriptTags++;
      const close = lower.indexOf('</script', i);
      const body = close === -1 ? htmlText.slice(i) : htmlText.slice(i, close);
      const type = (attrs.get('type') ?? '').trim().toLowerCase();
      if (type === 'application/ld+json') {
        if (body.includes('<')) add('Strukturovaná data (JSON-LD) obsahují znak „<“ – musí být escapovaný.');
      } else if (!attrs.has('src') || body.trim() !== '') {
        add('Vložený (inline) <script> – povolené jsou jen skripty v samostatných souborech.');
      } else if (!isExternal(attrs.get('src')) && !isAllowedScriptSrc(attrs.get('src'), scriptDirs)) {
        add(`Skript „${attrs.get('src').slice(0, 60)}“ – stránka smí načítat skripty jen ze složky ${scriptDirs.join(' nebo ')} tohoto webu.`);
      }
      i = close === -1 ? htmlText.length : close;
    }
  }
  // Fail closed against parser gaps: every "<script" in the file must have been recognised
  // and checked as a tag above.
  const rawScripts = (lower.match(/<script(?=[\s/>])/g) ?? []).length;
  if (rawScripts !== scriptTags) {
    add(`Soubor obsahuje ${rawScripts}× „<script“, ale kontrola rozpoznala jen ${scriptTags} prvků <script> (např. skript schovaný v komentáři nebo nestandardní zápis).`);
  }
  return problems;
}

// SVG files (favicon.svg and the decorations from src/assets/ in /assets/): opened on their own, an SVG is a document
// that can run scripts. Only plain drawings are allowed – no <script>, <foreignObject>, on*
// handlers, <style>/style=, entities, links or references outside the file (only "#id").
export function checkSvg(text, where) {
  const problems = [];
  const add = (message) => problems.push({ where, message, fix: CODE_FIX });
  const t = text.toLowerCase();
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s/>]/.test(t)) add('Soubor SVG nezačíná prvkem <svg>.');
  if (/<script[\s/>]/.test(t)) add('SVG obsahuje <script>.');
  if (/<foreignobject[\s/>]/.test(t)) add('SVG obsahuje <foreignObject> (vložené HTML).');
  if (/<style[\s/>]/.test(t) || /[\s"'/]style\s*=/.test(t)) add('SVG obsahuje styly (<style> nebo style=).');
  if (/<!(?:doctype|entity)/.test(t)) add('SVG obsahuje deklaraci DOCTYPE/ENTITY.');
  if (/[\s"'/]on[a-z]+\s*=/.test(t)) add('SVG obsahuje atribut on…= (vložený JavaScript).');
  for (const m of text.matchAll(/[\s"'/]((?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!v.startsWith('#')) add(`SVG odkazuje mimo soubor (${m[1]}="${v.slice(0, 40)}").`);
  }
  for (const m of text.matchAll(/url\(\s*['"]?([^'")\s]*)/gi)) {
    if (!m[1].startsWith('#')) add(`SVG odkazuje mimo soubor (url(${m[1].slice(0, 40)})).`);
  }
  problems.push(...svgAllowlist(text).map((message) => ({ where, message, fix: CODE_FIX })));
  return problems;
}

// Allowlist on top of the checks above (a blacklist alone can be bypassed with a namespace
// prefix like <s:script xmlns:s="…svg">, x:href or SMIL animation <set attributeName="href">):
// the file must consist only of these drawing elements with quoted attributes; no attribute
// may have a prefix (except xmlns:xlink and xlink:href) and no animation attributes are allowed.
// Comments, CDATA, processing instructions (except the XML declaration at the start) and
// anything the simple tokenizer does not understand are rejected (fail closed).
export const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'symbol', 'title', 'desc']);
const SVG_NAMESPACES = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' };
const SVG_ANIMATION_ATTRS = new Set(['attributename', 'attributetype', 'to', 'values', 'from', 'by', 'begin']);
const SVG_TAG_RE = /<(\/?)([^\s/>"'=]+)((?:\s+[^\s"'>/=]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const SVG_ATTR_RE = /([^\s"'>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function svgAllowlist(text) {
  const found = [];
  const s = text.replace(/^\uFEFF/, '');
  const decl = /^\s*<\?xml[^<>]*\?>/.exec(s);
  let i = decl ? decl[0].length : 0;
  while ((i = s.indexOf('<', i)) !== -1) {
    SVG_TAG_RE.lastIndex = i;
    const m = SVG_TAG_RE.exec(s);
    if (!m) {
      found.push(`SVG obsahuje zápis, který kontrola nezná (komentář, CDATA, instrukci nebo neúplnou značku) u „${s.slice(i, i + 30)}“.`);
      break;
    }
    i = SVG_TAG_RE.lastIndex;
    const [, closing, name, attrs] = m;
    if (!SVG_ELEMENTS.has(name.toLowerCase())) found.push(`SVG obsahuje nepovolený prvek <${name.slice(0, 40)}> (povolené jsou jen tvary kresby).`);
    if (closing) {
      if (attrs.trim()) found.push(`Uzavírací značka </${name.slice(0, 40)}> má atributy.`);
      continue;
    }
    for (const a of attrs.matchAll(SVG_ATTR_RE)) {
      const attr = a[1].toLowerCase();
      const value = a[2] ?? a[3];
      if (Object.hasOwn(SVG_NAMESPACES, attr)) {
        if (value !== SVG_NAMESPACES[attr]) found.push(`SVG: atribut ${a[1]} má nepovolenou hodnotu.`);
      } else if (attr.includes(':') && attr !== 'xlink:href') {
        found.push(`SVG obsahuje atribut s předponou (${a[1].slice(0, 40)}).`);
      } else if (SVG_ANIMATION_ATTRS.has(attr)) {
        found.push(`SVG obsahuje animační atribut ${a[1]}.`);
      }
    }
  }
  return found;
}

// Fonts (src/assets/*.woff, *.woff2 -> dist/assets/): only WOFF/WOFF2, checked by the magic
// bytes at the start of the file (wOFF / wOF2), not just by the extension.
export const FONT_MAGIC = { woff: 'wOFF', woff2: 'wOF2' };
export function checkFontFile(buf, where) {
  const ext = /\.(woff2?)$/i.exec(where)?.[1]?.toLowerCase();
  if (!ext) return [{ where, message: 'Písmo smí být jen ve formátu WOFF nebo WOFF2 (.woff, .woff2).', fix: CODE_FIX }];
  if (buf.subarray(0, 4).toString('latin1') !== FONT_MAGIC[ext]) {
    return [{ where, message: `Soubor se tváří jako písmo .${ext}, ale podle obsahu jím není.`, fix: CODE_FIX }];
  }
  return [];
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

// Files with types a browser or Cloudflare may execute/interpret. Allowed only where the
// build itself puts them.
const ACTIVE_EXT_RE = /\.(?:html?|xhtml?|xht|svgz?|xml|xsl|xslt|m?js|wasm)$/i;
const ACTIVE_ALLOWED = [
  /^index\.html$/,
  /^404\.html$/,
  /^ochrana-soukromi\/index\.html$/,
  /^admin\/index\.html$/,
  /^admin\/decap-cms\.js$/,
  /^admin\/publish-guard\.js$/,
  /^admin\/manual-init\.js$/,
  /^assets\/theme\.[0-9a-f]{10}\.js$/,
  /^assets\/copy\.[0-9a-f]{10}\.js$/,
  /^assets\/[a-z0-9-]+\.[0-9a-f]{10}\.svg$/,
  /^favicon\.svg$/,
  /^sitemap\.xml$/,
];
const FONT_EXT_RE = /\.(?:woff2?|ttf|otf|eot|ttc|dfont)$/i;
const FONT_ALLOWED_RE = /^assets\/[a-z0-9-]+\.[0-9a-f]{10}\.woff2$/;
const PAGES_CONTROL_RE = /^(?:_worker\.js|_routes\.json|_redirects|functions)$/i;

// Checks the built site. Returns { errors }.
export async function checkDist(distDir) {
  const errors = [];
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (PAGES_CONTROL_RE.test(entry.name) || (entry.name.startsWith('_') && entry.name !== '_headers')) {
      errors.push({ where: `dist/${entry.name}`, message: 'Řídicí soubor Cloudflare Pages ve výstupu buildu – změnil by chování serveru.', fix: CODE_FIX });
    }
  }
  for (const file of await listFiles(distDir)) {
    const rel = relative(distDir, file).split(sep).join('/');
    if (ACTIVE_EXT_RE.test(rel) && !ACTIVE_ALLOWED.some((re) => re.test(rel))) {
      errors.push({ where: `dist/${rel}`, message: 'Soubor typu HTML/SVG/JS/XML na nečekaném místě – web takové soubory vytváří jen sám.', fix: CODE_FIX });
    }
    if (FONT_EXT_RE.test(rel)) {
      if (!FONT_ALLOWED_RE.test(rel)) {
        errors.push({ where: `dist/${rel}`, message: 'Písmo na nečekaném místě nebo v nepovoleném formátu – web používá jen vlastní písma WOFF/WOFF2 v /assets/.', fix: CODE_FIX });
      } else {
        errors.push(...checkFontFile(await readFile(file), `dist/${rel}`));
      }
      continue;
    }
    if (/\.svgz?$/i.test(rel)) {
      errors.push(...checkSvg(await readFile(file, 'utf8'), `dist/${rel}`));
      continue;
    }
    if (!/\.html?$/i.test(file)) continue;
    const scriptDirs = rel.startsWith('admin/') ? ADMIN_SCRIPT_DIRS : PUBLIC_SCRIPT_DIRS;
    errors.push(...checkHtml(await readFile(file, 'utf8'), `dist/${rel}`, { scriptDirs }));
  }
  return { errors };
}

// Warns when security.txt is missing a contact or is about to expire.
export async function checkSecurityTxt(root, now = new Date()) {
  const warnings = [];
  const file = join(root, 'static', '.well-known', 'security.txt');
  const where = 'static/.well-known/security.txt';
  if (!existsSync(file)) return warnings;
  const text = await readFile(file, 'utf8');
  if (!/^Contact:\s*(?:mailto:|https:\/\/)\S+/im.test(text)) {
    warnings.push({ where, message: 'V souboru chybí řádek „Contact:“ (kam hlásit bezpečnostní chyby).', fix: 'Doplňte Contact: s odkazem https:// nebo mailto:.' });
  }
  const m = /^Expires:\s*(\S+)/im.exec(text);
  const expires = m ? new Date(m[1]) : null;
  if (!expires || Number.isNaN(expires.getTime())) {
    warnings.push({ where, message: 'V souboru chybí platné datum „Expires“.', fix: 'Doplňte řádek Expires: s datem za rok.' });
  } else if (expires.getTime() - now.getTime() < 30 * 24 * 3600 * 1000) {
    warnings.push({ where, message: `Platnost souboru security.txt končí ${m[1].slice(0, 10)}.`, fix: 'Posuňte datum v řádku Expires: o rok dopředu.' });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const uploads = await checkUploads(root);
  const warnings = [...uploads.warnings, ...(await checkSecurityTxt(root))];
  const errors = [
    ...uploads.errors,
    ...(await checkRepoRoot(root)),
    ...(await checkPackageJson(root)),
    ...(await checkStaticTree(root)),
    ...(await checkFunctionsTree(root)),
    ...checkGitModes(root),
  ];
  const dist = join(root, 'dist');
  if (existsSync(dist)) errors.push(...(await checkDist(dist)).errors);

  console.log(`Kontrola fotek: ${uploads.images.size} v pořádku.`);
  if (!existsSync(dist)) console.log('Složka dist/ zatím neexistuje – kontrola hotového webu se přeskočila (spusťte node build.mjs).');
  if (warnings.length) console.log(`\nUpozornění:\n${formatProblems(warnings)}\n`);
  if (errors.length) {
    console.error(`\nNalezené chyby:\n${formatProblems(errors)}\n\nCelkem chyb: ${errors.length}.`);
    process.exitCode = 1;
  } else {
    console.log('Vše v pořádku.');
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) {
  main().catch((e) => {
    console.error('Neočekávaná chyba kontroly:', e);
    process.exitCode = 1;
  });
}
