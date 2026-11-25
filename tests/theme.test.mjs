// Tests of the light/dark theme: CSS tokens, the theme switcher script
// (src/theme.js) and how the build puts it into the pages.
// Run: node --test tests/

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { build } from '../build.mjs';
import { checkHtml } from '../scripts/check.mjs';
import { heroPlaceholder, aboutPlaceholder, logoMark, quoteMark, serviceIcon, uiIcon, UI_ICON_NAMES, ICON_NAMES, FAVICON_SVG } from '../src/icons.mjs';
import { THEME_COLORS } from '../src/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILE = join(ROOT, 'src', 'styles.css');
const JS_FILE = join(ROOT, 'src', 'theme.js');
const RENDER_FILE = join(ROOT, 'src', 'render.mjs');
const KEY = 'zabavadeti-vzhled';

// ---------------------------------------------------------------------------
// Tiny CSS walker: returns every declaration with the chain of selectors /
// at-rules it sits in.
// ---------------------------------------------------------------------------

function cssDeclarations(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let buf = '';
  for (const ch of src) {
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
    } else if (ch === '}' || ch === ';') {
      const text = buf.trim();
      if (text) {
        const i = text.indexOf(':');
        if (i > 0) out.push({ path: [...stack], prop: text.slice(0, i).trim(), value: text.slice(i + 1).trim().replace(/\s+/g, ' ') });
      }
      buf = '';
      if (ch === '}') stack.pop();
    } else {
      buf += ch;
    }
  }
  return out;
}

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|magenta|cyan)\b/i;

// Declarations that contain a hard-coded colour outside the token blocks
// (custom properties on :root…). Simple heuristic, good enough for our CSS.
function hardcodedColors(css) {
  return cssDeclarations(css).filter((d) => {
    // Token names like var(--tint-pink-bg) are fine, only literal colours count.
    if (!COLOR_LITERAL.test(d.value.replace(/var\(\s*--[\w-]+\s*\)/g, ''))) return false;
    const inTokenBlock = d.prop.startsWith('--') && (d.path.at(-1) ?? '').startsWith(':root');
    return !inTokenBlock && d.prop !== 'color-scheme';
  });
}

function tokenBlock(decls, match) {
  const map = new Map();
  for (const d of decls) if (match(d.path)) map.set(d.prop, d.value);
  return map;
}

describe('CSS motivy (světlý / tmavý)', () => {
  let css;
  let decls;
  before(async () => {
    css = await readFile(CSS_FILE, 'utf8');
    decls = cssDeclarations(css);
  });

  test('heuristika na natvrdo zapsané barvy funguje', () => {
    assert.equal(hardcodedColors('.x { color: #fff; }').length, 1);
    assert.equal(hardcodedColors('.x { box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4); }').length, 1);
    assert.equal(hardcodedColors('.x { background: white; }').length, 1);
    assert.equal(hardcodedColors(':root { --a: #fff; } .x { color: var(--a); background: transparent; }').length, 0);
    assert.equal(hardcodedColors('.x { --a: #fff; }').length, 1, 'token mimo :root');
  });

  test('mimo bloky s tokeny nejsou natvrdo zapsané barvy', () => {
    const bad = hardcodedColors(css).map((d) => `${d.path.join(' > ')} { ${d.prop}: ${d.value} }`);
    assert.deepEqual(bad, []);
  });

  test('tmavé tokeny jsou pro media query i pro [data-theme="dark"] a jsou stejné', () => {
    const viaMedia = tokenBlock(decls, (p) => p.length === 2 && /prefers-color-scheme:\s*dark/.test(p[0]) && p[1] === ':root:not([data-theme="light"])');
    const viaAttr = tokenBlock(decls, (p) => p.at(-1) === ':root[data-theme="dark"]');
    assert.ok(viaMedia.size > 20, 'blok @media (prefers-color-scheme: dark) :root:not([data-theme="light"])');
    assert.ok(viaAttr.size > 20, 'blok :root[data-theme="dark"]');
    assert.deepEqual([...viaAttr], [...viaMedia], 'oba tmavé bloky musí mít stejné hodnoty');
    assert.equal(viaMedia.get('color-scheme'), 'dark');
    for (const name of ['--bg', '--ink', '--brand', '--focus', '--btn-bg', '--btn-ink']) assert.ok(viaMedia.has(name), name);
  });

  test('světlé tokeny jsou v :root a tmavé přepisují jen existující tokeny', () => {
    const light = tokenBlock(decls, (p) => p.length === 1 && p[0] === ':root');
    const dark = tokenBlock(decls, (p) => p.at(-1) === ':root[data-theme="dark"]');
    assert.equal(light.get('color-scheme'), 'light');
    for (const name of dark.keys()) assert.ok(name === 'color-scheme' || light.has(name), `token ${name} chybí ve světlém :root`);
    const forcedLight = tokenBlock(decls, (p) => p.length === 1 && p[0] === ':root[data-theme="light"]');
    assert.equal(forcedLight.get('color-scheme'), 'light');
  });

  test('každá barva ze světlého :root je i v tmavých blocích (výjimka jen --print-ink)', () => {
    const LIGHT_ONLY = new Set(['--print-ink']);
    const light = tokenBlock(decls, (p) => p.length === 1 && p[0] === ':root');
    const dark = tokenBlock(decls, (p) => p.at(-1) === ':root[data-theme="dark"]');
    const colors = [...light].filter(([name, value]) => name.startsWith('--') && COLOR_LITERAL.test(value)).map(([name]) => name);
    assert.ok(colors.length > 35, 'heuristika najde barevné tokeny');
    for (const name of LIGHT_ONLY) {
      assert.ok(light.has(name), `výjimka ${name} existuje`);
      assert.ok(!dark.has(name), `${name} je jen pro tisk`);
      const uses = decls.filter((d) => d.value.includes(`var(${name})`));
      assert.ok(uses.length > 0 && uses.every((d) => /^@media print/.test(d.path[0] ?? '')), `${name} se používá jen v @media print`);
    }
    const missing = colors.filter((name) => !LIGHT_ONLY.has(name) && !dark.has(name));
    assert.deepEqual(missing, [], 'tokeny chybí v tmavých blocích');
  });

  // WCAG 2.x: relativní jas a kontrastní poměr dvou barev #rrggbb.
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  // rgba(r, g, b, a) položená na neprůhlednou barvu #rrggbb -> výsledná #rrggbb.
  const blend = (rgba, under) => {
    const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
    assert.ok(m, `rgba: ${rgba}`);
    const a = Number(m[4]);
    const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
    return '#' + [1, 2, 3].map((k, i) => Math.round(Number(m[k]) * a + u[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
  };
  const themes = () => [
    ['světlý', tokenBlock(decls, (p) => p.length === 1 && p[0] === ':root')],
    ['tmavý', tokenBlock(decls, (p) => p.at(-1) === ':root[data-theme="dark"]')],
  ];

  test('kulatá tlačítka v hlavičce a menu: okraj --control-line má v obou motivech kontrast aspoň 3:1', () => {
    for (const [theme, tokens] of themes()) {
      const line = tokens.get('--control-line');
      assert.match(line, /^#[0-9a-f]{6}$/);
      for (const bg of ['--bg', '--card']) assert.ok(ratio(line, tokens.get(bg)) >= 3, `${theme}: --control-line / ${bg}`);
    }
    const bordered = decls.filter((d) => d.prop === 'border' && /var\(--control-line\)/.test(d.value)).flatMap((d) => d.path.at(-1).split(',').map((x) => x.trim()));
    for (const sel of ['.quick', '.theme-toggle', '.nav-mobile > summary', '.nav-drop', '.footer-top']) assert.ok(bordered.includes(sel), sel);
  });

  // WCAG 2.x AA: běžný text 4.5 : 1, velký text 3 : 1, ovládací prvky, fokus a grafika 3 : 1.
  // [popředí, pozadí, minimum, kde se dvojice používá]
  const ACCENTS = ['--pink', '--sun', '--blue', '--green', '--orange'];
  const TINTS = ['--tint-pink', '--tint-sun', '--tint-blue', '--tint-green', '--tint-orange'];
  const HOVER_TINTS = TINTS.map((t) => t.replace('--tint-', '--tint-hover-'));
  const FACES = TINTS.map((t) => t.replace('--tint-', '--face-'));
  // Barevné plochy s textem (tlačítka, vyplněné štítky sekcí, zvýraznění, vyplněné dlaždice
  // služeb, dlaždice 404) mají být čitelné na první pohled: cíl majitelky 5,5 : 1, ne hraničních 4,5.
  const SOLID = 5.5;
  const CONTRAST_PAIRS = [
    // text na stránce, střídajících se pruzích sekcí, patičce a kartách
    // (karty jsou ve světlém motivu bílé, v tmavém tmavě modré)
    ...['--bg', '--bg-band', '--bg-alt', '--card'].flatMap((bg) => [
      ['--ink', bg, 4.5, 'text'], ['--muted', bg, 4.5, 'vedlejší text'], ['--brand', bg, 4.5, 'odkazy a ikony v textu'],
      ['--brand-strong', bg, 4.5, 'odkaz při najetí'],
    ]),
    ['--logo-sub', '--bg', 4.5, '„Měřín a okolí“ pod logem'], ['--logo-sub', '--bg-alt', 4.5, '„Měřín a okolí“ v patičce'],
    ['--bg', '--ink', 4.5, 'odkaz Přeskočit na obsah, ikona v obrysovém tlačítku'],
    // plochy barevných karet: dlaždice služeb, karty referencí (dlouhý text: doporučeno 7 : 1),
    // štítky „pro koho“ a karta mateřských škol (světlý motiv bílé, tmavý tónované)
    ...FACES.flatMap((bg) => [['--ink', bg, 7, 'text na kartě'], ['--muted', bg, 4.5, 'popis služby, autor reference']]),
    // tónované pozadí: položka mobilního menu po najetí, kresba bez fotky
    ...TINTS.flatMap((bg) => [['--ink', bg, 7, 'text na tónovaném pozadí'], ['--muted', bg, 4.5, 'vedlejší text na tónovaném pozadí']]),
    // dlaždice služeb po najetí / při fokusu: o stupeň výraznější tón, všechen text --ink (7 : 1)
    ...HOVER_TINTS.map((bg) => ['--ink', bg, 7, 'text dlaždice služby po najetí']),
    // samolepka se sloganem v úvodu: tmavě modrý text na sluníčkově žluté
    ['--on-accent', '--sun', SOLID, 'samolepka se sloganem'],
    // sytý akcent s tmavým textem: zvýraznění v nadpisech, štítky sekcí, vyplněná dlaždice po najetí,
    // dlaždice 404, iniciály u referencí, fajfky, ikony služeb
    ...ACCENTS.map((bg) => ['--on-accent', bg, SOLID, 'text a kresba na sytém akcentu']),
    // tlačítka: bílý tučný text na malinové
    ['--btn-ink', '--btn-bg', SOLID, 'hlavní tlačítko'], ['--btn-ink', '--btn-bg-hover', SOLID, 'hlavní tlačítko při najetí'],
    ['--ink', '--btn2-bg-hover', 4.5, 'obrysové tlačítko při najetí'],
    ...['--bg', '--bg-band', '--card'].map((bg) => ['--btn2-line', bg, 3, 'obrys obrysového tlačítka']),
    // ovládací prvky a fokus (3 : 1)
    ...['--bg', '--bg-band', '--bg-alt', '--card'].map((bg) => ['--focus', bg, 3, 'rámeček fokusu']),
    ...['--bg', '--card'].map((bg) => ['--control-line', bg, 3, 'okraj kulatých tlačítek']),
    ['--fb-ink', '--fb-blue', 3, 'logo Facebooku'], ['--fb-ink', '--fb-btn', SOLID, 'tlačítko Otevřít Facebook'],
  ];

  test('kontrasty barev splňují WCAG AA ve světlém i tmavém motivu', () => {
    const bad = [];
    for (const [theme, tokens] of themes()) {
      for (const [fg, bg, min, where] of CONTRAST_PAIRS) {
        const a = tokens.get(fg);
        const b = tokens.get(bg);
        assert.match(a ?? '', /^#[0-9a-f]{6}$/, `${theme} ${fg}`);
        assert.match(b ?? '', /^#[0-9a-f]{6}$/, `${theme} ${bg}`);
        const r = ratio(a, b);
        if (r < min) bad.push(`${theme}: ${fg} na ${bg} = ${r.toFixed(2)} (min. ${min}, ${where})`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('hlavička se jasně odlišuje od sekcí: neprůhledné pozadí, stín, barevný proužek; text a ovládání mají kontrast', () => {
    for (const [theme, tokens] of themes()) {
      const raw = tokens.get('--header-bg');
      // Světlá hlavička je plně bílá; tmavá skoro neprůhledná (obsah pod ní rušivě neprosvítá),
      // proto se počítá nad nejsvětlejším i nejtmavším podkladem.
      let under;
      if (theme === 'světlý') {
        assert.equal(raw, '#ffffff', 'světlá hlavička: neprůhledná bílá');
        under = [raw];
      } else {
        const alpha = Number(/^rgba\(.*, ([\d.]+)\)$/.exec(raw)?.[1] ?? 1);
        assert.ok(alpha >= 0.95, `${theme}: hlavička je dost neprůhledná (${alpha})`);
        under = ['#ffffff', '#000000'].map((u) => blend(raw, u));
      }
      for (const bg of under) {
        for (const [fg, min] of [['--ink', 4.5], ['--logo-sub', 4.5], ['--control-line', 3], ['--focus', 3]]) {
          assert.ok(ratio(tokens.get(fg), bg) >= min, `${theme}: ${fg} na hlavičce ${bg} = ${ratio(tokens.get(fg), bg).toFixed(2)}`);
        }
      }
      assert.match(tokens.get('--header-shadow') ?? '', /^rgba\(/, `${theme}: --header-shadow`);
    }
    const at = (prop) => decls.find((d) => d.path.length === 1 && d.path[0] === '.site-header' && d.prop === prop)?.value;
    assert.equal(at('background'), 'var(--header-bg)');
    assert.match(at('box-shadow') ?? '', /var\(--header-shadow\)/, 'jemný stín pod hlavičkou');
    assert.match(at('border-bottom') ?? '', /^6px solid /, 'proužek 6 px');
    assert.equal(at('border-image'), 'linear-gradient(90deg, var(--pink), var(--orange), var(--sun), var(--green), var(--blue)) 1', 'duhový proužek');
  });

  test('fotky jsou celé a nic přes ně neleží (žádný ořez, přechod ani popisek)', () => {
    assert.ok(!/object-fit|--scrim|photo-caption|service-overlay/.test(css), 'žádný ořez fotek ani tmavý závoj');
    for (const sel of ['.photo-card .photo', '.service-photo .photo']) {
      assert.ok(decls.some((d) => d.path.at(-1) === sel && d.prop === 'width' && d.value === '100%'), sel);
      assert.ok(!decls.some((d) => d.path.at(-1) === sel && /^(height|position|aspect-ratio)$/.test(d.prop)), `${sel}: přirozený poměr stran`);
    }
  });

  test('úvod: karta školek stejně široká jako řádek štítků „pro koho“, stejné mezery, ikona a text na středu', () => {
    const at = (sel, prop) => decls.find((d) => d.path.length === 1 && d.path[0] === sel && d.prop === prop)?.value;
    assert.equal(at('.hero-audience', 'width'), 'fit-content');
    assert.equal(at('.hero-audience', 'gap'), 'var(--space-l)');
    assert.equal(at('.hero-audience', 'margin-top'), 'var(--space-l)');
    assert.equal(at('.hero-note', 'contain'), 'inline-size', 'karta se nepočítá do šířky bloku, jen ho vyplní');
    assert.equal(at('.hero-note', 'margin'), '0');
    assert.equal(at('.hero-note', 'align-items'), 'center');
    assert.equal(at('.hero-note', 'background'), 'var(--acc-face)', 've světlém motivu bílá, v tmavém tónovaná');
    assert.equal(at('.hero-note', 'border'), 'var(--face-bw) solid var(--acc-face-edge)');
    assert.equal(at('.hero-note', 'color'), 'var(--ink)');
  });

  test('dlaždice služeb: obrys v barvě vždy, po najetí (jen myš) a při fokusu jemně zesílí, bez pohybu při omezení pohybu', () => {
    const at = (sel, prop, media = null) => decls.find((d) => d.path.at(-1) === sel && d.prop === prop && (media === null ? d.path.length === 1 : d.path[0] === media));
    assert.equal(at('.service', 'border')?.value, 'var(--face-bw) solid var(--acc-face-edge)');
    assert.equal(at('.service', 'border-top-color')?.value, 'var(--acc-edge)', 'proužek nahoře v barvě');
    assert.equal(at('.service', 'background')?.value, 'var(--acc-face)');
    for (const [sel, media] of [['.service:focus-visible', null], ['.service:hover', '@media (hover: hover)']]) {
      // tón vlastní barvy (ve světlém motivu velmi světlý, ne celá sytá barva), text --ink (7 : 1 hlídá test kontrastů)
      assert.equal(at(sel, 'background', media)?.value, 'var(--acc-tint-hover)', sel);
      assert.equal(at(sel, 'color', media)?.value, 'var(--ink)', sel);
      assert.equal(at(`${sel} p`, 'color', media)?.value, 'var(--ink)', `${sel} p`);
      assert.equal(at(sel, 'border-color', media)?.value, 'var(--acc-edge)', `${sel}: obrys v barvě`);
      assert.match(at(sel, 'box-shadow', media)?.value ?? '', /0 0 0 var\(--face-ring\) var\(--acc-edge\)/, `${sel}: zesílený obrys`);
    }
    // Nadzvednutí jen bez omezení pohybu.
    for (const d of decls.filter((x) => x.prop === 'transform' && /^\.service:(hover|focus-visible)$/.test(x.path.at(-1)))) {
      assert.match(d.path[0], /prefers-reduced-motion: no-preference/, d.path.join(' '));
      assert.equal(d.value, 'translateY(-2px)');
    }
    // Zvýraznění po najetí jen na zařízeních s myší (na dotykových jen obrys a tón).
    assert.ok(!decls.some((d) => d.path.length === 1 && d.path[0] === '.service:hover' && d.prop === 'background'));
    // Přechody (transition) jen při prefers-reduced-motion: no-preference.
    for (const d of decls.filter((x) => x.prop === 'transition')) assert.match(d.path[0], /prefers-reduced-motion: no-preference/);
  });

  test('štítky sekcí jsou vyplněné barvou sekce, reference ve své barvě, dlouhé texty max. ~70 znaků na řádek', () => {
    const at = (sel, prop) => decls.find((d) => d.path.length === 1 && d.path[0] === sel && d.prop === prop)?.value;
    assert.equal(at('.section-title .kicker', 'background'), 'var(--acc)');
    assert.equal(at('.section-title .kicker', 'color'), 'var(--on-accent)');
    assert.equal(at('.ref', 'background'), 'var(--acc-face)');
    assert.equal(at('.ref', 'border'), 'var(--face-bw) solid var(--acc-face-edge)');
    // Délka řádku v em (ch je u Plus Jakarta Sans úzká nula -> řádky by měly přes 90 znaků).
    for (const sel of ['.legal-block', '.about-text > p', '.lead', '.section-intro', '.refs-note']) {
      const m = /^(\d+(?:\.\d+)?)em$/.exec(at(sel, 'max-width') ?? '');
      assert.ok(m && Number(m[1]) <= 44, `${sel}: max-width v em`);
    }
    assert.ok(!/max-width:\s*\d+ch/.test(css), 'žádné max-width v ch');
  });

  // Schválený tmavý motiv (stav před zklidněním světlého motivu). Tmavý vzhled se nemá měnit:
  // změna tmavé barvy musí být vědomá (upravit i tento seznam).
  const DARK_APPROVED = {
    'color-scheme': 'dark', '--bg': '#0b1026', '--bg-band': '#10173a', '--bg-alt': '#070b1c', '--ink': '#f3f5ff',
    '--muted': '#b3bbdf', '--brand': '#ff70b6', '--brand-strong': '#ffa3cf', '--focus': '#ffd23f',
    '--card': '#161e46', '--line': '#2a3563', '--line-strong': '#3b4880',
    '--card-hi': 'rgba(255, 255, 255, 0.07)', '--shadow-color': 'rgba(0, 0, 0, 0.55)',
    '--header-bg': 'rgba(11, 16, 38, 0.96)', '--header-shadow': 'rgba(0, 0, 0, 0.6)',
    '--control-line': '#6672a8', '--logo-sub': '#ffd23f', '--pink': '#ff3d9a', '--sun': '#ffd23f',
    '--blue': '#4a8cff', '--green': '#22c983', '--orange': '#ff7a1a', '--on-accent': '#0b1026',
    '--ico-w': '#ffffff', '--edge-pink': '#ff3d9a', '--edge-sun': '#ffd23f', '--edge-blue': '#4a8cff',
    '--edge-green': '#22c983', '--edge-orange': '#ff7a1a', '--tint-pink': '#47173f', '--tint-sun': '#3a3216',
    '--tint-blue': '#15295c', '--tint-green': '#0e3934', '--tint-orange': '#452418',
    '--tint-hover-pink': '#5c1d52', '--tint-hover-sun': '#4d4219', '--tint-hover-blue': '#1c3675',
    '--tint-hover-green': '#124a43', '--tint-hover-orange': '#5a2e1d', '--glow-pink': 'rgba(255, 61, 154, 0.3)',
    '--glow-sun': 'rgba(255, 210, 63, 0.15)', '--glow-blue': 'rgba(74, 140, 255, 0.32)',
    '--glow-green': 'rgba(34, 201, 131, 0.24)', '--glow-orange': 'rgba(255, 122, 26, 0.22)',
    '--glow-fb': 'rgba(24, 119, 242, 0.3)', '--btn-bg': '#c2165a', '--btn-bg-hover': '#a9124e',
    '--btn-ink': '#ffffff', '--btn2-line': '#dfe3fb', '--btn2-bg-hover': '#1f2958', '--fb-blue': '#1877f2',
    '--fb-btn': '#1463d1', '--fb-ink': '#ffffff',
  };

  test('tmavý motiv se nezměnil: schválené barvy a karty kreslené novými tokeny vypadají stejně', () => {
    const [, [, dark]] = themes();
    for (const [name, value] of Object.entries(DARK_APPROVED)) assert.equal(dark.get(name), value, `tmavý ${name}`);
    // Nové tokeny karet mají v tmavém motivu přesně dřívější hodnoty: plocha = tón, obrys = barva
    // obrysu, stín = sytá barva (Kontakt zelená, Facebook modrá) …
    for (const a of ACCENTS.map((n) => n.slice(2))) {
      assert.equal(dark.get(`--face-${a}`), DARK_APPROVED[`--tint-${a}`], `--face-${a}`);
      assert.equal(dark.get(`--face-edge-${a}`), DARK_APPROVED[`--edge-${a}`], `--face-edge-${a}`);
      assert.equal(dark.get(`--face-shade-${a}`), DARK_APPROVED[`--${a}`], `--face-shade-${a}`);
    }
    assert.equal(dark.get('--face-edge-fb'), DARK_APPROVED['--fb-blue']);
    assert.equal(dark.get('--face-shade-fb'), DARK_APPROVED['--fb-blue']);
    // … obrys 2 px, prstenec po najetí 2 px, bez proužku nahoře a bez neutrálního stínu.
    assert.equal(dark.get('--face-bw'), '2px');
    assert.equal(dark.get('--face-ring'), '2px');
    assert.equal(dark.get('--face-stripe'), '0px');
    assert.equal(dark.get('--face-lift'), 'rgba(0, 0, 0, 0)');
    // Tokeny, které rozdělily dřívější společnou hodnotu (aby šel světlý motiv zklidnit zvlášť),
    // mají v tmavém motivu přesně dřívější vzhled: obrys miniatur FB = dřívější --glow-fb,
    // zvýraznění slova přes celé slovo (dřívější 0 72% / 100% 76%), přechod za fotkou plně sytý.
    const SPLIT = { '--fb-shot-ring': DARK_APPROVED['--glow-fb'], '--hl-pos': '0 72%', '--hl-size': '100% 76%', '--frame-opacity': '1' };
    for (const [name, value] of Object.entries(SPLIT)) assert.equal(dark.get(name), value, `tmavý ${name}`);
    // Jiné nové tmavé tokeny než tokeny karet a výše vyjmenované nepřibyly.
    const added = [...dark.keys()].filter((n) => !(n in DARK_APPROVED) && !(n in SPLIT));
    assert.deepEqual(added.filter((n) => !n.startsWith('--face-')), []);
  });

  test('světlý motiv je klidný: bílé karty s jemným obrysem, barva jen jako akcent', () => {
    const [[, light]] = themes();
    const alpha = (v) => Number(/^rgba\(.*, ([\d.]+)\)$/.exec(v ?? '')?.[1]);
    assert.equal(light.get('--bg'), '#ffffff');
    assert.equal(light.get('--card'), '#ffffff');
    assert.ok(ratio(light.get('--bg-band'), '#ffffff') < 1.08, 'střídání sekcí jen velmi jemné');
    for (const a of ACCENTS.map((n) => n.slice(2))) {
      assert.equal(light.get(`--face-${a}`), '#ffffff', `--face-${a}: bílá karta, žádná pastelová výplň`);
      assert.equal(light.get(`--face-edge-${a}`), '#e5e8f2', `--face-edge-${a}: jemný neutrální obrys`);
      const shade = light.get(`--face-shade-${a}`);
      assert.ok(shade.startsWith('rgba(24, 32, 80,') && alpha(shade) <= 0.25, `--face-shade-${a}: neutrální měkký stín`);
      // po najetí jen velmi světlý tón vlastní barvy (~8 %)
      const hover = light.get(`--tint-hover-${a}`);
      assert.ok(ratio(hover, '#ffffff') < 1.13, `--tint-hover-${a} je velmi světlý (${ratio(hover, '#ffffff').toFixed(3)})`);
      assert.notEqual(hover, '#ffffff', `--tint-hover-${a} je tón, ne bílá`);
    }
    assert.equal(light.get('--face-edge-fb'), '#e5e8f2');
    assert.ok(alpha(light.get('--face-lift')) > 0, 'měkký neutrální stín karet');
    assert.equal(light.get('--face-bw'), '1px');
    assert.equal(light.get('--face-ring'), '1px');
    assert.equal(light.get('--face-stripe'), '4px');
    // barevné záře v pozadí sotva znatelné
    for (const g of ['--glow-pink', '--glow-sun', '--glow-blue', '--glow-green', '--glow-orange', '--glow-fb']) {
      assert.ok(alpha(light.get(g)) <= 0.12, `${g} = ${light.get(g)}`);
    }
    // Dlaždice služeb, reference, O mně, Kontakt a Facebook: jednotně proužek nahoře (vnitřní stín
    // + horní obrys v barvě karty), jemný obrys a stín z tokenů karet (žádná sytá barva natvrdo).
    const at = (sel, prop) => decls.find((d) => d.path.length === 1 && d.path[0] === sel && d.prop === prop)?.value;
    for (const [sel, edge, face] of [['.service', '--acc-edge', '--acc-face-edge'], ['.ref', '--acc-edge', '--acc-face-edge'],
      ['.traits', '--edge-pink', '--face-edge-pink'], ['.contact-card', '--edge-green', '--face-edge-green'], ['.contact-fb', '--fb-blue', '--face-edge-fb']]) {
      assert.equal(at(sel, 'border'), `var(--face-bw) solid var(${face})`, `${sel} border`);
      assert.equal(at(sel, 'border-top-color'), `var(${edge})`, `${sel} border-top-color`);
      const shadow = at(sel, 'box-shadow') ?? '';
      assert.ok(shadow.startsWith(`inset 0 var(--face-stripe) 0 var(${edge}), `), `${sel}: proužek nahoře`);
      assert.ok(!/var\(--(pink|sun|blue|green|orange|fb-blue|acc)\)/.test(shadow.replace(/^inset 0 var\(--face-stripe\) 0 var\([^)]+\), /, '')), `${sel}: stín bez syté barvy`);
    }
    // Zvýrazněné slovo v nadpisu: ve světlém motivu jen zvýrazňovač přes spodní část slova
    // (nejvýš polovina výšky), přechod za fotkami tlumený, miniatury FB s neutrálním obrysem.
    assert.equal(at('.hl', 'background'), 'linear-gradient(var(--hl), var(--hl)) var(--hl-pos) / var(--hl-size) no-repeat');
    const [, hlH] = light.get('--hl-size').split(' ').map(parseFloat);
    const [, hlY] = light.get('--hl-pos').split(' ').map(parseFloat);
    assert.ok(hlH <= 50, `--hl-size: výška ${hlH} %`);
    assert.ok(hlY >= 70, `--hl-pos: pruh dole (${hlY} %)`);
    const frameOpacity = Number(light.get('--frame-opacity'));
    assert.ok(frameOpacity > 0 && frameOpacity <= 0.5, `--frame-opacity = ${frameOpacity}`);
    const frameRule = decls.find((d) => d.path.at(-1).split(',').map((x) => x.trim()).includes('.hero-frame::before') && d.prop === 'opacity');
    assert.equal(frameRule?.value, 'var(--frame-opacity)', 'přechod za fotkou v úvodu i v O mně');
    assert.ok(frameRule.path.at(-1).includes('.about-frame::before'), 'přechod za fotkou v O mně');
    assert.equal(light.get('--fb-shot-ring'), '#e5e8f2');
    assert.ok((at('.fb-shot', 'box-shadow') ?? '').endsWith('0 0 0 1px var(--fb-shot-ring)'), '.fb-shot: obrys neutrálním tokenem, ne září');
    assert.equal(at('.chip', 'background'), 'var(--acc-face)');
    assert.equal(at('.chip', 'border'), '1px solid var(--acc-face-edge)');
    assert.equal(at('.section-title .kicker', 'box-shadow'), '0 14px 34px -16px var(--acc-shade)');
  });

  test('kontrastní test pokrývá všechny barvy textu a pozadí ze světlého :root', () => {
    // Nová barva textu/pozadí musí dostat dvojici v CONTRAST_PAIRS (výjimky = čistě dekorativní tokeny
    // a tokeny s průhledností, které hlídá test výše).
    // Obrysy --edge-* jsou dekorace: dlaždici i kartu identifikuje její text a tónované pozadí.
    const DECOR = new Set(['--print-ink', '--line', '--line-strong', '--card-hi', '--shadow-color', '--ico-w',
      '--glow-pink', '--glow-sun', '--glow-blue', '--glow-green', '--glow-orange', '--glow-fb', '--fb-shot-ring', '--header-bg', '--header-shadow',
      '--edge-pink', '--edge-sun', '--edge-blue', '--edge-green', '--edge-orange',
      ...[...ACCENTS, '--fb'].flatMap((a) => [a.replace('--', '--face-edge-'), a.replace('--', '--face-shade-')]), '--face-lift']);
    const light = tokenBlock(decls, (p) => p.length === 1 && p[0] === ':root');
    const covered = new Set(CONTRAST_PAIRS.flatMap(([fg, bg]) => [fg, bg]));
    const colors = [...light].filter(([name, value]) => name.startsWith('--') && COLOR_LITERAL.test(value)).map(([name]) => name);
    assert.deepEqual(colors.filter((n) => !DECOR.has(n) && !covered.has(n)), []);
  });

  test('syté akcenty jsou v obou motivech stejné (stejné barvy karet, štítků i ikon)', () => {
    const [[, light], [, dark]] = themes();
    for (const name of [...ACCENTS, '--on-accent']) assert.equal(dark.get(name), light.get(name), name);
    for (const name of ACCENTS) assert.match(light.get(name), /^#[0-9a-f]{6}$/, name);
    // Každá barva akcentu má třídu .acc-* s odstínem, září a druhou barvou pro detaily ikon.
    for (const a of ACCENTS.map((n) => n.slice(2))) {
      for (const prop of ['--acc', '--acc-edge', '--acc-tint', '--acc-tint-hover', '--acc-glow', '--acc-x', '--acc-face', '--acc-face-edge', '--acc-shade']) {
        assert.ok(decls.some((d) => d.path.at(-1) === `.acc-${a}` && d.prop === prop), `.acc-${a} ${prop}`);
      }
    }
  });

  test('barva lišty prohlížeče (theme-color) = pozadí stránky v obou motivech', () => {
    const [[, light], [, dark]] = themes();
    assert.equal(THEME_COLORS.light, light.get('--bg'));
    assert.equal(THEME_COLORS.dark, dark.get('--bg'));
  });

  test('manifest a favicon ladí s paletou (static/favicon.svg = FAVICON_SVG z icons.mjs)', async () => {
    const [[, light], [, dark]] = themes();
    const manifest = JSON.parse(await readFile(join(ROOT, 'static', 'site.webmanifest'), 'utf8'));
    // Hlavní vzhled je tmavý (námořnická modrá).
    assert.equal(manifest.theme_color, dark.get('--bg'));
    assert.equal(manifest.background_color, dark.get('--bg'));
    const favicon = (await readFile(join(ROOT, 'static', 'favicon.svg'), 'utf8')).replace(/\r\n?/g, '\n');
    assert.equal(favicon, FAVICON_SVG);
    assert.ok(favicon.includes(dark.get('--bg')), '--bg (tmavý)');
    for (const token of ['--sun', '--pink', '--blue']) assert.ok(favicon.includes(light.get(token)), token);
  });

  test('tisk: text černý, karty bez tmavého pozadí', () => {
    const print = decls.filter((d) => /^@media print/.test(d.path[0] ?? '') && d.prop === 'color' && d.value === 'var(--print-ink) !important');
    const selectors = print.flatMap((d) => d.path.at(-1).split(',').map((x) => x.trim()));
    for (const sel of ['body', '.site-footer', '.site-footer a', '.btn', '.kicker', '.contact-address .ui-icon', '.svc-big p', '.service p']) {
      assert.ok(selectors.includes(sel), sel);
    }
    const bg = decls.filter((d) => /^@media print/.test(d.path[0] ?? '') && d.prop === 'background' && d.value === 'none !important');
    const cards = bg.flatMap((d) => d.path.at(-1).split(',').map((x) => x.trim()));
    for (const sel of ['body', '.service', '.ref', '.contact-card', '.legal-card']) assert.ok(cards.includes(sel), sel);
  });

  test('každá použitá proměnná var(--…) je definovaná', () => {
    const defined = new Set(decls.filter((d) => d.prop.startsWith('--')).map((d) => d.prop));
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    for (const name of used) assert.ok(defined.has(name), `${name} není definovaná`);
  });

  test('přepínač je bez JS skrytý a ikony se přepínají třídami', () => {
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    assert.match(css, /\.theme-toggle\[data-mode="auto"\] \.ti-auto/);
    assert.match(css, /\.theme-toggle\[data-mode="light"\] \.ti-light/);
    assert.match(css, /\.theme-toggle\[data-mode="dark"\] \.ti-dark/);
  });
});

// ---------------------------------------------------------------------------
// src/theme.js – static checks and a run in a fake browser (node:vm).
// ---------------------------------------------------------------------------

function fakeElement(attrs) {
  const a = new Map(Object.entries(attrs));
  const listeners = {};
  return {
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    setAttribute: (k, v) => a.set(k, String(v)),
    removeAttribute: (k) => a.delete(k),
    hasAttribute: (k) => a.has(k),
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    fire: (type, ev = {}) => (listeners[type] ?? []).forEach((fn) => fn(ev)),
  };
}

function runTheme(code, { stored = null, storageThrows = false, systemDark = false } = {}) {
  const root = fakeElement({ lang: 'cs' });
  const metaLight = fakeElement({ name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#fffaf3' });
  const metaDark = fakeElement({ name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#1a1326' });
  const button = fakeElement({ type: 'button', class: 'theme-toggle', 'data-mode': 'auto', hidden: '' });
  const store = new Map(stored === null ? [] : [[KEY, stored]]);
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const mq = { matches: systemDark, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
  const docListeners = {};
  const winListeners = {};
  const document = {
    documentElement: root,
    readyState: 'loading',
    querySelector: (sel) => (sel.includes('theme-color') ? (sel.includes('light') ? metaLight : sel.includes('dark') ? metaDark : null) : null),
    querySelectorAll: (sel) => (sel === '.theme-toggle' ? [button] : []),
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
  };
  const window = {
    matchMedia: (q) => { assert.equal(q, '(prefers-color-scheme: dark)'); return mq; },
    addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
  };
  Object.defineProperty(window, 'localStorage', {
    get() {
      if (storageThrows) throw new Error('SecurityError: The operation is insecure.');
      return storage;
    },
  });
  vm.runInNewContext(code, { window, document });
  return {
    root, button, metaLight, metaDark, store, mq,
    ready: () => (docListeners.DOMContentLoaded ?? []).forEach((fn) => fn()),
    systemChange: (dark) => { mq.matches = dark; mq.listeners.forEach((fn) => fn({ matches: dark })); },
    storageEvent: (ev) => (winListeners.storage ?? []).forEach((fn) => fn(ev)),
    pageshow: (ev) => (winListeners.pageshow ?? []).forEach((fn) => fn(ev)),
    // What the visitor actually sees: the forced theme, or the system one.
    rendered: () => root.getAttribute('data-theme') ?? (mq.matches ? 'dark' : 'light'),
  };
}

describe('src/theme.js', () => {
  let code;
  before(async () => {
    code = await readFile(JS_FILE, 'utf8');
  });

  test('neobsahuje eval, innerHTML, document.write ani podobné', () => {
    const src = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const bad of [/\beval\s*\(/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /new\s+Function/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/]) {
      assert.ok(!bad.test(src), `zakázané: ${bad}`);
    }
    assert.ok(src.includes(`'${KEY}'`), 'klíč v localStorage');
  });

  test('každý přístup k localStorage je v try/catch', () => {
    const src = code.replace(/\/\*[\s\S]*?\*\//g, '');
    const uses = [...src.matchAll(/localStorage/g)].length;
    const guarded = [...src.matchAll(/try\s*\{[^}]*?localStorage[^}]*\}\s*catch/g)]
      .reduce((n, m) => n + [...m[0].matchAll(/localStorage/g)].length, 0);
    assert.ok(uses >= 3, 'čtení, zápis i smazání');
    assert.equal(guarded, uses);
  });

  test('bez uložené volby: automatika, tlačítko se odkryje s popiskem', () => {
    const env = runTheme(code);
    assert.equal(env.root.getAttribute('data-theme'), null);
    assert.ok(env.button.hasAttribute('hidden'), 'před DOMContentLoaded je tlačítko ještě skryté');
    env.ready();
    assert.ok(!env.button.hasAttribute('hidden'));
    assert.equal(env.button.getAttribute('data-mode'), 'auto');
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: podle systému (teď světlý). Přepnout na tmavý.');
    assert.equal(env.button.getAttribute('title'), env.button.getAttribute('aria-label'));
    assert.equal(env.metaLight.getAttribute('content'), '#fffaf3');
    assert.equal(env.metaDark.getAttribute('content'), '#1a1326');
  });

  test('uložený tmavý motiv se nastaví hned (před vykreslením) i s barvou lišty', () => {
    const env = runTheme(code, { stored: 'dark' });
    assert.equal(env.root.getAttribute('data-theme'), 'dark');
    assert.equal(env.metaLight.getAttribute('content'), '#1a1326');
    assert.equal(env.metaDark.getAttribute('content'), '#1a1326');
  });

  test('neplatná uložená hodnota = automatika', () => {
    const env = runTheme(code, { stored: '"><script>' });
    assert.equal(env.root.getAttribute('data-theme'), null);
  });

  test('tmavý systém: kliknutí cykluje auto → světlý → tmavý → auto a ukládá volbu', () => {
    const env = runTheme(code, { systemDark: true });
    env.ready();
    env.button.fire('click');
    assert.equal(env.root.getAttribute('data-theme'), 'light');
    assert.equal(env.store.get(KEY), 'light');
    assert.equal(env.button.getAttribute('data-mode'), 'light');
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: světlý. Přepnout na tmavý.');
    assert.equal(env.metaDark.getAttribute('content'), '#fffaf3');

    env.button.fire('click');
    assert.equal(env.root.getAttribute('data-theme'), 'dark');
    assert.equal(env.store.get(KEY), 'dark');
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: tmavý. Přepnout na automatický podle systému.');

    env.button.fire('click');
    assert.equal(env.root.getAttribute('data-theme'), null);
    assert.ok(!env.store.has(KEY), 'auto = klíč smazaný');
    assert.equal(env.button.getAttribute('data-mode'), 'auto');
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: podle systému (teď tmavý). Přepnout na světlý.');
    assert.equal(env.metaLight.getAttribute('content'), '#fffaf3');
    assert.equal(env.metaDark.getAttribute('content'), '#1a1326');
  });

  test('světlý systém: kliknutí cykluje auto → tmavý → světlý → auto', () => {
    const env = runTheme(code, { systemDark: false });
    env.ready();
    env.button.fire('click');
    assert.equal(env.root.getAttribute('data-theme'), 'dark');
    assert.equal(env.store.get(KEY), 'dark');
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: tmavý. Přepnout na světlý.');

    env.button.fire('click');
    assert.equal(env.root.getAttribute('data-theme'), 'light');
    assert.equal(env.store.get(KEY), 'light');
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: světlý. Přepnout na automatický podle systému.');

    env.button.fire('click');
    assert.equal(env.root.getAttribute('data-theme'), null);
    assert.ok(!env.store.has(KEY));
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: podle systému (teď světlý). Přepnout na tmavý.');
  });

  for (const systemDark of [false, true]) {
    test(`první klepnutí vždy změní vykreslený motiv (systém ${systemDark ? 'tmavý' : 'světlý'})`, () => {
      const env = runTheme(code, { systemDark });
      env.ready();
      const before = env.rendered();
      env.button.fire('click');
      assert.notEqual(env.rendered(), before);
      // A full round of clicks shows both themes and comes back to auto.
      const seen = new Set([before, env.rendered()]);
      env.button.fire('click');
      seen.add(env.rendered());
      env.button.fire('click');
      assert.deepEqual([...seen].sort(), ['dark', 'light']);
      assert.equal(env.button.getAttribute('data-mode'), 'auto');
    });
  }

  test('zakázané úložiště (soukromé okno): žádná chyba, funguje automatika i přepínání', () => {
    const env = runTheme(code, { storageThrows: true });
    assert.equal(env.root.getAttribute('data-theme'), null);
    env.ready();
    assert.doesNotThrow(() => env.button.fire('click'));
    assert.equal(env.root.getAttribute('data-theme'), 'dark');
  });

  test('změna systému při ruční volbě aktualizuje popisek (pořadí závisí na systému)', () => {
    const env = runTheme(code, { stored: 'light' });
    env.ready();
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: světlý. Přepnout na automatický podle systému.');
    env.systemChange(true);
    assert.equal(env.button.getAttribute('aria-label'), 'Vzhled: světlý. Přepnout na tmavý.');
    assert.equal(env.root.getAttribute('data-theme'), 'light');
  });

  test('návrat z bfcache (pageshow persisted) načte volbu znovu', () => {
    const env = runTheme(code);
    env.ready();
    // Meanwhile another page switched to dark; no storage event arrived.
    env.store.set(KEY, 'dark');
    env.pageshow({ persisted: false });
    assert.equal(env.root.getAttribute('data-theme'), null, 'běžné načtení nic nemění');
    env.pageshow({ persisted: true });
    assert.equal(env.root.getAttribute('data-theme'), 'dark');
    assert.equal(env.button.getAttribute('data-mode'), 'dark');
    assert.equal(env.metaLight.getAttribute('content'), '#1a1326');
    // The next click continues from the restored mode (dark → light), not from a stale auto.
    env.button.fire('click');
    assert.equal(env.root.getAttribute('data-theme'), 'light');
  });

  test('změna systému v automatice aktualizuje popisek', () => {
    const env = runTheme(code);
    env.ready();
    env.systemChange(true);
    assert.match(env.button.getAttribute('aria-label'), /teď tmavý/);
    assert.equal(env.root.getAttribute('data-theme'), null);
  });

  test('změna volby v jiné záložce se projeví', () => {
    const env = runTheme(code);
    env.ready();
    env.store.set(KEY, 'dark');
    env.storageEvent({ key: KEY });
    assert.equal(env.root.getAttribute('data-theme'), 'dark');
    assert.equal(env.button.getAttribute('data-mode'), 'dark');
  });
});

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------

describe('motiv ve výstupu buildu', () => {
  const tempDirs = [];
  let out;
  let jsName;
  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zabava-theme-'));
    tempDirs.push(dir);
    await cp(join(ROOT, 'content'), join(dir, 'content'), { recursive: true });
    await cp(join(ROOT, 'headers'), join(dir, 'headers'), { recursive: true });
    await cp(join(ROOT, 'static'), join(dir, 'static'), {
      recursive: true,
      filter: (src) => !src.includes(`${join('static', 'admin')}`),
    });
    out = join(dir, 'dist');
    ({ js: jsName } = await build({ root: dir, outDir: out, log: () => {} }));
  });
  after(async () => {
    for (const d of tempDirs) await rm(d, { recursive: true, force: true });
  });

  test('theme.js je otisknutý v /assets/ a shoduje se se zdrojem', async () => {
    assert.match(jsName, /^theme\.[0-9a-f]{10}\.js$/);
    assert.ok((await readdir(join(out, 'assets'))).includes(jsName));
    const src = (await readFile(JS_FILE, 'utf8')).replace(/\r\n?/g, '\n');
    assert.equal(await readFile(join(out, 'assets', jsName), 'utf8'), src);
  });

  for (const page of ['index.html', '404.html']) {
    test(`${page}: <script src> v <head> hned za CSS, bez defer a bez inline kódu`, async () => {
      const html = await readFile(join(out, page), 'utf8');
      const head = html.slice(0, html.indexOf('</head>'));
      const tag = `<script src="/assets/${jsName}"></script>`;
      assert.ok(head.includes(tag), 'skript je v <head>');
      assert.equal(html.split(tag).length, 2, 'právě jednou');
      assert.match(head, /<link rel="stylesheet" href="\/assets\/styles\.[0-9a-f]{10}\.css">\n<script src="\/assets\/theme\.[0-9a-f]{10}\.js"><\/script>\n/);
      // The only <script> tags: the theme file and (on index) the copy buttons (defer) and JSON-LD.
      const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
      for (const [whole, body] of scripts) {
        if (whole.startsWith('<script type="application/ld+json">')) continue;
        assert.equal(body, '', 'bez inline kódu');
        assert.match(whole, page === 'index.html'
          ? /^<script src="\/assets\/(?:theme\.[0-9a-f]{10}\.js"|copy\.[0-9a-f]{10}\.js" defer)><\/script>$/
          : /^<script src="\/assets\/theme\.[0-9a-f]{10}\.js"><\/script>$/);
      }
      assert.equal(html.includes('/assets/copy.'), page === 'index.html', 'kopírování jen na úvodní stránce (Kontakt)');
      assert.deepEqual(checkHtml(html, page), []);
    });

    test(`${page}: přepínač vzhledu v hlavičce, bez JS skrytý`, async () => {
      const html = await readFile(join(out, page), 'utf8');
      const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
      const button = /<button\b[^>]*class="theme-toggle"[^>]*>/.exec(header)?.[0];
      assert.ok(button, 'tlačítko je v hlavičce');
      assert.match(button, /type="button"/);
      assert.match(button, /\shidden(?=[\s>])/);
      assert.match(button, /data-mode="auto"/);
      assert.match(button, /aria-label="Vzhled: [^"]+"/);
      assert.match(button, /title="Vzhled: [^"]+"/);
      assert.ok(!/<details[^>]*>[\s\S]*theme-toggle[\s\S]*<\/details>/.test(header), 'ne v rozbalovacím menu');
      for (const cls of ['ti-auto', 'ti-light', 'ti-dark']) assert.ok(header.includes(cls), cls);
    });

    test(`${page}: theme-color pro světlý i tmavý motiv a color-scheme`, async () => {
      const html = await readFile(join(out, page), 'utf8');
      assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)">/);
      assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/);
      assert.match(html, /<meta name="color-scheme" content="light dark">/);
    });
  }

  test('styly neobsahují nepoužité třídy (každá třída z CSS je na některé stránce)', async () => {
    const css = (await readFile(CSS_FILE, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
    const cssClasses = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
    assert.ok(cssClasses.has('hl') && cssClasses.has('service'), 'heuristika najde třídy');
    const html = [];
    for (const page of ['index.html', '404.html', 'ochrana-soukromi/index.html']) html.push(await readFile(join(out, page), 'utf8'));
    // Zástupné kresby a jejich rámečky se ukážou jen tehdy, když k úvodu / O mně chybí fotka.
    html.push(String(heroPlaceholder()), String(aboutPlaceholder()));
    const render = await readFile(RENDER_FILE, 'utf8');
    const ONLY_WITHOUT_PHOTO = ['hero-art', 'about-art'];
    for (const cls of ONLY_WITHOUT_PHOTO) assert.ok(render.includes(`class="photo-card ${cls.split('-')[0]}-photo ${cls}"`), cls);
    // Třídy, které závisí na obsahu: kontakt bez Facebooku a roztažení poslední karty služeb
    // při jiném počtu služeb (render.mjs, lastSpan).
    const DEPENDS_ON_CONTENT = ['contact-solo', 'w3-2', 'w4-2', 'w4-3'];
    for (const cls of DEPENDS_ON_CONTENT.slice(1)) assert.match(render, /`w\$\{i \+ 2\}-\$\{n\}`/, cls);
    assert.ok(render.includes("' contact-solo'"), 'contact-solo');
    const used = new Set([...html.join('').matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
    const unused = [...cssClasses].filter((c) => !used.has(c) && !ONLY_WITHOUT_PHOTO.includes(c) && !DEPENDS_ON_CONTENT.includes(c));
    assert.deepEqual(unused, []);
  });

  test('každá ikona se na webu používá (žádné nepoužité kresby)', async () => {
    const render = await readFile(RENDER_FILE, 'utf8');
    for (const name of UI_ICON_NAMES) assert.ok(render.includes(`uiIcon('${name}'`), `ikona ${name}`);
    const config = await readFile(join(ROOT, 'static', 'admin', 'config.yml'), 'utf8');
    for (const name of ICON_NAMES) assert.ok(config.includes(`value: "${name}"`), `ikona služby ${name} je v administraci`);
  });

  test('ikony služeb: barevná dlaždice s plnou kresbou, barvy jen přes třídy a tokeny (bez vlastních barev)', async () => {
    const css = await readFile(CSS_FILE, 'utf8');
    const ICON_CLASSES = new Set(['service-svg', 'ico-tile', 'ico-w', 'ico-x', 'ico-pink', 'ico-sun', 'ico-blue', 'ico-green']);
    for (const name of ICON_NAMES) {
      const svg = String(serviceIcon(name));
      assert.match(svg, /^<svg class="service-svg" viewBox="0 0 48 48" aria-hidden="true" focusable="false" xmlns="http:\/\/www\.w3\.org\/2000\/svg"><rect class="ico-tile" width="48" height="48" rx="14"\/>/, name);
      assert.ok(!/#[0-9a-f]{3,6}\b|\sstyle=/i.test(svg), `${name}: žádná barva natvrdo`);
      for (const [, cls] of svg.matchAll(/\sclass="([^"]+)"/g)) assert.ok(ICON_CLASSES.has(cls), `${name}: třída ${cls}`);
      for (const [, paint] of svg.matchAll(/\s(?:fill|stroke)="([^"]+)"/g)) assert.ok(['currentColor', 'none'].includes(paint), `${name}: ${paint}`);
      assert.ok(svg.includes('class="ico-w"'), `${name}: bílé tvary`);
    }
    // Dlaždice má barvu akcentu karty, kresba je tmavá (--on-accent, kontrast hlídá test kontrastů).
    assert.match(css, /\.ico-tile \{\s*fill: var\(--acc\);/);
    assert.match(css, /\.service-svg \{[^}]*color: var\(--on-accent\);/);
    assert.match(css, /\.ico-x \{\s*fill: var\(--acc-x\);/);
  });

  test('stránky nemají style atributy', async () => {
    for (const page of ['index.html', '404.html']) {
      assert.ok(!/\sstyle=/.test(await readFile(join(out, page), 'utf8')), page);
    }
  });
});

describe('check.mjs: povolené skripty', () => {
  test('veřejná stránka smí načíst jen skript z /assets/ téhož webu', () => {
    assert.deepEqual(checkHtml('<script src="/assets/theme.0123456789.js"></script>', 'index.html'), []);
    for (const bad of [
      '<script src="/theme.js"></script>',
      '<script src="/uploads/x.js"></script>',
      '<script src="/assets/../uploads/x.js"></script>',
      '<script src="/assets/x.js?v=1"></script>',
      '<script src="/assets/x.css"></script>',
      '<script src="assets/x.js"></script>',
      '<script src="//evil.example/assets/x.js"></script>',
      '<script src="https://evil.example/assets/x.js"></script>',
      '<script src="/assets/theme.js">alert(1)</script>',
      '<script>document.documentElement.dataset.theme = "dark"</script>',
      // Repeated attributes: the browser uses the first one.
      '<script src="https://evil.example/x.js" src="/assets/theme.0123456789.js"></script>',
      '<script src="/uploads/x.js" src="/assets/theme.0123456789.js"></script>',
      '<script src="/assets/theme.0123456789.js" src="https://evil.example/x.js"></script>',
      '<script src="/assets/theme.0123456789.js" SRC="/uploads/x.js"></script>',
      '<script type="application/ld+json" type="text/javascript">alert(1)</script>',
    ]) assert.ok(checkHtml(bad, 'index.html').length > 0, bad);
  });
});

describe('ilustrace a logo v obou motivech', () => {
  test('barvy jdou přes třídy s tokeny, ikony UI přes currentColor', async () => {
    const css = await readFile(CSS_FILE, 'utf8');
    const all = [heroPlaceholder(), aboutPlaceholder(), logoMark(), quoteMark()].map(String).join('');
    assert.ok(!/\sstyle=/.test(all));
    assert.ok(!/#[0-9a-f]{3,6}\b/i.test(all), 'žádná barva natvrdo');
    for (const [cls, prop, token] of [['art-pink', 'fill', 'pink'], ['art-sun', 'fill', 'sun'], ['art-blue', 'fill', 'blue'], ['art-green', 'fill', 'green'],
      ['art-white', 'fill', 'ico-w'], ['art-line', 'stroke', 'on-accent'], ['lm-tile', 'fill', 'pink'], ['lm-dot', 'fill', 'blue']]) {
      assert.ok(all.includes(`class="${cls}"`), cls);
      assert.match(css, new RegExp(`\\.${cls} \\{\\s*${prop}: var\\(--${token}\\);`), `CSS pro .${cls}`);
    }
    assert.match(String(quoteMark()), /fill="currentColor"/);
    for (const name of ['auto', 'sun', 'moon']) assert.match(String(uiIcon(name)), /stroke="currentColor"/);
  });
});

// ---------------------------------------------------------------------------
// src/copy.js – the "Kopírovat" buttons next to the phone number and e-mail.
// ---------------------------------------------------------------------------

describe('src/copy.js (tlačítka Kopírovat)', () => {
  const COPY_FILE = join(ROOT, 'src', 'copy.js');

  function fakeButton(value) {
    const attrs = new Map([['data-copy', value], ['hidden', '']]);
    const label = { textContent: 'Kopírovat' };
    const listeners = {};
    return {
      label,
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      hasAttribute: (k) => attrs.has(k),
      querySelector: (sel) => (sel === '.copy-label' ? label : null),
      addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
      click: () => (listeners.click ?? []).forEach((fn) => fn()),
    };
  }

  function runCopy(code, { secure = true, clipboard = true, fail = false } = {}) {
    const buttons = [fakeButton('+420 739 039 559'), fakeButton('ivona.husakova@seznam.cz')];
    const status = { textContent: '' };
    const copied = [];
    const navigator = clipboard
      ? { clipboard: { writeText: (v) => { copied.push(v); return fail ? Promise.reject(new Error('x')) : Promise.resolve(); } } }
      : {};
    const document = {
      readyState: 'complete',
      querySelector: (sel) => (sel === '.copy-status' ? status : null),
      querySelectorAll: (sel) => (sel === '.copy-btn' ? buttons : []),
      addEventListener: () => {},
    };
    const timers = [];
    vm.runInNewContext(code, {
      window: { isSecureContext: secure }, navigator, document,
      setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    });
    return { buttons, status, copied, timers };
  }

  test('neobsahuje innerHTML, eval ani podobné; jen textContent', async () => {
    const src = (await readFile(COPY_FILE, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const bad of [/\beval\s*\(/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /new\s+Function/, /setTimeout\s*\(\s*['"`]/]) {
      assert.ok(!bad.test(src), `zakázané: ${bad}`);
    }
    assert.match(src, /navigator\.clipboard\.writeText/);
  });

  test('bez schránky (nebo mimo HTTPS) zůstanou tlačítka skrytá', async () => {
    const code = await readFile(COPY_FILE, 'utf8');
    for (const opts of [{ clipboard: false }, { secure: false }]) {
      const env = runCopy(code, opts);
      assert.ok(env.buttons.every((b) => b.hasAttribute('hidden')), JSON.stringify(opts));
    }
  });

  test('se schránkou se tlačítka odkryjí, kopírují hodnotu a ohlásí „Zkopírováno“', async () => {
    const env = runCopy(await readFile(COPY_FILE, 'utf8'));
    assert.ok(env.buttons.every((b) => !b.hasAttribute('hidden')));
    env.buttons[1].click();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(env.copied, ['ivona.husakova@seznam.cz']);
    assert.equal(env.buttons[1].label.textContent, 'Zkopírováno');
    assert.equal(env.status.textContent, 'Zkopírováno: ivona.husakova@seznam.cz');
    env.timers.at(-1)();
    assert.equal(env.buttons[1].label.textContent, 'Kopírovat');
    assert.equal(env.status.textContent, '');
  });

  test('když kopírování selže, poradí zkopírovat ručně', async () => {
    const env = runCopy(await readFile(COPY_FILE, 'utf8'), { fail: true });
    env.buttons[0].click();
    await new Promise((r) => setImmediate(r));
    assert.match(env.status.textContent, /ručně/);
    assert.equal(env.buttons[0].label.textContent, 'Kopírovat');
  });

  test('v HTML: tlačítka bez JS skrytá, s přístupným názvem, potvrzení přes role="status"', async () => {
    const { renderIndex } = await import('../src/render.mjs');
    assert.equal(typeof renderIndex, 'function');
    const render = await readFile(RENDER_FILE, 'utf8');
    assert.match(render, /<button type="button" class="copy-btn" data-copy="\$\{value\}" aria-label="\$\{label\}" hidden>/);
    assert.match(render, /<p class="copy-status" role="status" aria-live="polite"><\/p>/);
  });
});
