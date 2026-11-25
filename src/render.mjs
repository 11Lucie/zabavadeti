// Page templates. Every piece of content goes through the auto-escaping
// html`` tag; raw() is used only for constant SVG markup and JSON-LD.
//
// Design: a modern product-site look in a playful spirit. A deep navy page
// (or a clean light one) with soft multicoloured glows, big rounded display
// type with one word per heading on a coloured highlight box, pill buttons and
// a "bento" grid of rounded tiles. One shape per kind of element; tiles and
// chips differ only in size and accent colour (pink, sun, blue, green, orange).
// Every section has its own colour (SECTION_COLORS): the filled label above the
// heading, the highlighted word, the glow behind the section and the underline
// of its menu item. Photos are always shown whole, never under text – the only
// exception is the slogan sticker in the hero, which on wider screens overlaps
// the bottom-left corner of the photo (only the floor there, never a face).
// Everything else (colours, glows) lives in src/styles.css.
//
// Finished pages go through czechTypography() (src/escape.mjs): no-break spaces
// after one-letter prepositions, in phone numbers etc.

import { html, raw, jsonForScript, czechTypography, NBSP } from './escape.mjs';
import {
  serviceIcon, uiIcon, logoMark, quoteMark,
  heroPlaceholder, aboutPlaceholder, facebookLogo,
} from './icons.mjs';
import { FACEBOOK_TEXT_DEFAULT } from './validate.mjs';

export const SITE_URL = 'https://www.zabavadeti.cz';
export const PRIVACY_PATH = '/ochrana-soukromi/';
// Date of the last change of the privacy page text (privacyMain). Update it together with the text.
export const PRIVACY_UPDATED = 'listopad 2026';

// Accent colours of tiles, chips and icons, in the order they rotate.
export const ACCENTS = Object.freeze(['pink', 'sun', 'blue', 'green', 'orange']);
const accent = (i) => ACCENTS[i % ACCENTS.length];
// The "for whom" chips in the hero rotate through the first four colours only:
// orange belongs to the kindergarten card under them, so the card never shares
// its colour with a chip.
const CHIP_ACCENTS = ACCENTS.filter((a) => a !== 'orange');
const chipAccent = (i) => CHIP_ACCENTS[i % CHIP_ACCENTS.length];

// Colour of each section (label, highlighted word, glow, menu underline).
export const SECTION_COLORS = Object.freeze({ sluzby: 'sun', 'o-mne': 'pink', reference: 'blue', kontakt: 'green' });

// "Zábava pro děti – Měřín a okolí" (the subtitle is optional).
function fullName(n) {
  return n.podtitul ? `${n.nazev_webu} – ${n.podtitul}` : n.nazev_webu;
}

// Multi-line plain text -> escaped text with <br> between lines.
function multiline(text) {
  return text.split('\n').map((part, i) => (i === 0 ? html`${part}` : html`<br>${part}`));
}

// E-mail with an optional line break before the @ sign.
function emailBreakable(email) {
  const at = email.indexOf('@');
  return html`${email.slice(0, at)}<wbr>${email.slice(at)}`;
}

// The last word of a heading on a coloured highlight box (like a marker
// behind the text). A short last word (o mně, oči) takes the word before it
// too – unless that would be the whole heading (Kontaktujte mě): then only the
// first word is highlighted. A short highlight never breaks across lines.
export function highlight(text, color = 'sun') {
  const words = text.trim().split(/\s+/);
  if (words.length > 1 && words.length <= 2 && [...words.at(-1)].length <= 3) {
    return html`<span class="hl hl-${color}">${words[0]}</span> ${words.slice(1).join(' ')}`;
  }
  const n = words.length > 2 && [...words.at(-1)].length <= 3 ? 2 : 1;
  const head = words.slice(0, -n).join(' ');
  let tail = words.slice(-n).join(' ');
  if ([...tail].length <= 16) tail = tail.replace(/ /g, NBSP);
  return html`${head}${head ? ' ' : ''}<span class="hl hl-${color}">${tail}</span>`;
}

function photo(img, alt, { eager = false } = {}) {
  const loading = eager ? raw(' fetchpriority="high"') : raw(' loading="lazy"');
  return html`<img class="photo" src="${img.src}" width="${img.width}" height="${img.height}" alt="${alt}" decoding="async"${loading}>`;
}

// Photo in a rounded card – always whole (natural aspect ratio), no text over it.
function photoCard(img, alt, { eager = false, cls = '' } = {}) {
  return html`<div class="photo-card ${cls}">${photo(img, alt, { eager })}</div>`;
}

function logo(name, sub) {
  return html`<span class="logo-mark">${logoMark()}</span><span class="logo-text"><span class="logo-title">${name}</span>${sub ? html`<span class="logo-sub">${uiIcon('pin')}<span>${sub}</span></span>` : ''}</span>`;
}

function navItems(c, prefix) {
  const items = [
    ['sluzby', 'Služby'],
    ['o-mne', 'O mně'],
  ];
  if (c.reference.polozky.length) items.push(['reference', 'Reference']);
  items.push(['kontakt', 'Kontakt']);
  return items.map(([id, label]) => html`<li><a class="acc-${SECTION_COLORS[id]}" href="${prefix}#${id}">${label}</a></li>`);
}

// Light/dark theme switcher. Hidden without JavaScript (the theme then
// follows the system via CSS); src/theme.js unhides it and keeps data-mode,
// aria-label and title up to date.
export const THEME_TOGGLE_LABEL = 'Vzhled: podle systému. Přepnout na světlý.';
// Browser bar colours = page background (--bg) of the light and the dark theme
// (tests/theme.test.mjs checks they match src/styles.css).
export const THEME_COLORS = { light: '#f6f7fd', dark: '#0b1026' };

function themeToggle() {
  return html`<button type="button" class="theme-toggle" data-mode="auto" aria-label="${THEME_TOGGLE_LABEL}" title="${THEME_TOGGLE_LABEL}" hidden>${uiIcon('auto', 'ti-auto')}${uiIcon('sun', 'ti-light')}${uiIcon('moon', 'ti-dark')}</button>`;
}

// Sticky header: logo with the place name, the menu, ONE prominent phone
// button (on a computer a pill with the number, on a phone a round 44 × 44
// icon), Facebook and the theme switcher. On a phone the menu folds into a
// <details> drop-down (works without JavaScript).
function siteHeader(c, { prefix = '' } = {}) {
  const { nazev_webu, podtitul, facebook } = c.nastaveni;
  const k = c.kontakt;
  const items = navItems(c, prefix);
  return html`<header class="site-header">
  <div class="wrap header-bar">
    <a class="logo" href="/">${logo(nazev_webu, podtitul)}</a>
    <nav class="main-nav nav-wide" aria-label="Hlavní menu">
      <ul class="nav-list">${items}</ul>
    </nav>
    <div class="header-actions">
      <a class="quick quick-phone" href="tel:${k.telefon_href}" aria-label="Zavolat na ${k.telefon}">${uiIcon('phone')}<span class="quick-text">${k.telefon}</span></a>
      ${facebook ? html`<a class="quick quick-fb" href="${facebook}" rel="noopener noreferrer" aria-label="Facebook" title="Facebook">${uiIcon('facebook')}</a>` : ''}
      ${themeToggle()}
      <details class="nav-mobile">
        <summary aria-label="Menu">${uiIcon('menu')}</summary>
        <nav class="nav-drop" aria-label="Hlavní menu">
          <ul class="nav-list">${items}</ul>
        </nav>
      </details>
    </div>
  </div>
</header>`;
}

// "Provozovatel: Ivona Mutlová · IČO 00718131 · Balinka 619, 594 42 Měřín" (§ 435 občanského zákoníku).
function operatorLine(p) {
  return html`Provozovatel: ${p.jmeno} · IČO ${p.ico} · ${p.adresa}`;
}

function siteFooter(c, { year }) {
  const { nazev_webu, podtitul, facebook } = c.nastaveni;
  const k = c.kontakt;
  return html`<footer class="site-footer">
  <div class="wrap footer-grid">
    <div class="footer-brand">
      <p class="logo footer-logo">${logo(nazev_webu, podtitul)}</p>
    </div>
    <ul class="footer-contact">
      <li><a href="tel:${k.telefon_href}">${uiIcon('phone')}<span>${k.telefon}</span></a></li>
      <li><a href="mailto:${k.email}">${uiIcon('mail')}<span>${emailBreakable(k.email)}</span></a></li>
      ${facebook ? html`<li><a href="${facebook}" rel="noopener noreferrer">${uiIcon('facebook')}<span>Facebook</span></a></li>` : ''}
    </ul>
    <div class="footer-meta">
      <p class="footer-legal">${operatorLine(c.provozovatel)}</p>
      <p class="footer-legal"><a href="${PRIVACY_PATH}">Ochrana soukromí a cookies</a></p>
      <p class="footer-copy">© ${year} ${c.provozovatel.jmeno} – ${nazev_webu}</p>
    </div>
    <p class="footer-top-row"><a class="footer-top" href="#top">${uiIcon('up')}<span>Nahoru</span></a></p>
  </div>
</footer>`;
}

function headCommon(c, { title, description, cssHref, themeJs, copyJs = '', fonts = [], canonical, robots, ogImage, extra = '' }) {
  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
${robots ? html`<meta name="robots" content="${robots}">\n` : ''}${canonical ? html`<link rel="canonical" href="${canonical}">\n` : ''}<meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<meta name="format-detection" content="telephone=no">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/site.webmanifest">
${fonts.map((href) => html`<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>\n`)}<link rel="stylesheet" href="${cssHref}">
${themeJs ? html`<script src="${themeJs}"></script>\n` : ''}${copyJs ? html`<script src="${copyJs}" defer></script>\n` : ''}<meta property="og:type" content="website">
<meta property="og:locale" content="cs_CZ">
<meta property="og:site_name" content="${fullName(c.nastaveni)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
${canonical ? html`<meta property="og:url" content="${canonical}">\n` : ''}${ogImage ? html`<meta property="og:image" content="${SITE_URL}${ogImage.src}">\n<meta property="og:image:width" content="${ogImage.width}">\n<meta property="og:image:height" content="${ogImage.height}">\n` : ''}<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
${extra}`;
}

// "Balinka 619, 594 42 Měřín" -> street, postal code, town.
export function splitAddress(adresa) {
  const i = adresa.lastIndexOf(',');
  if (i <= 0) return { streetAddress: adresa.trim() };
  const street = adresa.slice(0, i).trim();
  const rest = adresa.slice(i + 1).trim();
  const m = /^(\d{3}) ?(\d{2})\s+(.+)$/.exec(rest);
  return m
    ? { streetAddress: street, postalCode: `${m[1]} ${m[2]}`, addressLocality: m[3] }
    : { streetAddress: street, addressLocality: rest };
}

export function buildJsonLd(c) {
  const k = c.kontakt;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'EntertainmentBusiness',
    '@id': `${SITE_URL}/#firma`,
    name: k.nazev_provozovny || fullName(c.nastaveni),
    description: c.nastaveni.seo_popis,
    url: `${SITE_URL}/`,
    telephone: k.telefon_href,
    email: k.email,
  };
  if (k.adresa) data.address = { '@type': 'PostalAddress', ...splitAddress(k.adresa), addressCountry: 'CZ' };
  const images = [c.uvod.fotka, c.oMne.fotka].filter(Boolean).map((f) => `${SITE_URL}${f.src}`);
  if (images.length) data.image = images;
  if (c.nastaveni.facebook) data.sameAs = [c.nastaveni.facebook];
  return data;
}

// Every section opens the same way: a label filled with the section colour
// (kicker), the heading with one word on a highlight box of the same colour
// and an optional intro.
function sectionHead(id, kicker, title, intro, color) {
  return html`<div class="section-head">
      <div class="section-title">
        <p class="kicker">${kicker}</p>
        <h2 id="${id}">${highlight(title, color)}</h2>
      </div>
      ${intro ? html`<p class="section-intro">${multiline(intro)}</p>` : ''}
    </div>`;
}

// Phone and e-mail written out on the buttons (not every computer has an app
// that opens tel: / mailto: links – the visitor can always read or copy them).
function contactButtons(k, size) {
  return html`<a class="btn btn-primary ${size}" href="tel:${k.telefon_href}">${uiIcon('phone')}<span>${k.telefon}</span></a>
        <a class="btn btn-secondary ${size} btn-mail" href="mailto:${k.email}">${uiIcon('mail')}<span>${emailBreakable(k.email)}</span></a>`;
}

function hero(c) {
  const u = c.uvod;
  const k = c.kontakt;
  const media = u.fotka
    ? photoCard(u.fotka, u.fotka_popis || c.nastaveni.nazev_webu, { eager: true, cls: 'hero-photo' })
    : html`<div class="photo-card hero-photo hero-art">${heroPlaceholder()}</div>`;
  return html`<section class="hero" aria-labelledby="hero-title">
  <div class="wrap hero-grid">
    <div class="hero-text">
      ${c.nastaveni.podtitul ? html`<p class="kicker">${uiIcon('pin')}<span>${c.nastaveni.podtitul}</span></p>` : ''}
      <h1 id="hero-title">${highlight(u.nadpis, 'sun')}</h1>
      <p class="lead">${multiline(u.perex)}</p>
      <div class="cta">
        ${contactButtons(k, 'btn-lg')}
      </div>
      ${u.pro_koho.length || u.skolky ? html`<div class="hero-audience">
        ${u.pro_koho.length ? html`<div class="for-whom">
          ${u.pro_koho_nadpis ? html`<p class="for-whom-title">${u.pro_koho_nadpis}</p>` : ''}
          <ul class="chips">${u.pro_koho.map((x, i) => html`<li class="chip acc-${chipAccent(i)}">${x}</li>`)}</ul>
        </div>` : ''}
        ${u.skolky ? html`<p class="hero-note acc-orange"><span class="hero-note-icon">${serviceIcon('skolka')}</span><span class="hero-note-text">${multiline(u.skolky)}</span></p>` : ''}
      </div>` : ''}
    </div>
    <div class="hero-media">
      <div class="hero-frame">${media}</div>
      ${u.slogan ? html`<p class="hero-badge">${uiIcon('sparkle')}<span>${u.slogan}</span></p>` : ''}
    </div>
  </div>
</section>`;
}

// How many columns the last tile spans so that the bento grid has no hole at
// the end. A service with a photo is a big tile – 2 × 2 cells in the 3- and
// 4-column grid, 1 column × 2 rows in the 2-column grid (so the small photo is
// never blown up); the others take one cell. When the last row is not full,
// the last tile stretches over the rest of the row.
function lastSpan(items, cols) {
  const big = cols === 2 ? 2 : 4;
  const cells = items.reduce((sum, p) => sum + (p.fotka ? big : 1), 0);
  const rest = cells % cols;
  return rest === 0 ? 1 : cols - rest + 1;
}

// Services: a bento grid of tiles of one shape; only the size (a service with
// a photo is a big tile, the last tile may be wide) and the accent colour
// differ. Every tile has an outline in its accent colour and is a link to the
// contact ("… – domluvit termín"); on hover / focus it fills with its colour.
// Services with a photo go first, so the big tiles open the grid. The photo is
// shown whole, the text sits next to it (below it on narrow screens).
function services(c) {
  const s = c.sluzby;
  const items = [...s.polozky.filter((p) => p.fotka), ...s.polozky.filter((p) => !p.fotka)];
  const last = items.at(-1);
  const wide = last && !last.fotka
    ? [2, 3, 4].map((cols) => lastSpan(items, cols)).map((n, i) => (n > 1 ? `w${i + 2}-${n}` : '')).filter(Boolean)
    : [];
  const color = SECTION_COLORS.sluzby;
  return html`<section id="sluzby" class="section section-band section-services acc-${color}" aria-labelledby="sluzby-title">
  <div class="wrap">
    ${sectionHead('sluzby-title', 'Služby', s.nadpis, s.uvod, color)}
    <ul class="services">
      ${items.map((p, i) => {
        const cell = ['svc'];
        if (p.fotka) cell.push('svc-big');
        if (p === last && wide.length) cell.push('svc-wide', ...wide);
        const id = `sluzba-${i + 1}`;
        const body = html`<span class="service-icon">${serviceIcon(p.ikona)}</span>
          <div class="service-body">
            <h3>${p.nazev}</h3>
            <p id="${id}">${multiline(p.popis)}</p>
          </div>
          <span class="service-go">${uiIcon('arrow')}</span>`;
        return html`<li class="${cell.join(' ')}">
        <a class="service acc-${accent(i)}" href="#kontakt" aria-label="${p.nazev} – domluvit termín" aria-describedby="${id}">
          ${p.fotka ? html`<span class="service-photo">${photo(p.fotka, p.fotka_popis)}</span>
          <div class="service-main">
          ${body}
          </div>` : body}
        </a>
      </li>`;
      })}
    </ul>
  </div>
</section>`;
}

function about(c) {
  const a = c.oMne;
  const color = SECTION_COLORS['o-mne'];
  const media = a.fotka
    ? photoCard(a.fotka, a.fotka_popis || a.nadpis, { cls: 'about-photo' })
    : html`<div class="photo-card about-photo about-art">${aboutPlaceholder()}</div>`;
  return html`<section id="o-mne" class="section section-about acc-${color}" aria-labelledby="o-mne-title">
  <div class="wrap about-grid">
    <div class="about-media"><div class="about-frame">${media}</div></div>
    <div class="about-text">
      ${sectionHead('o-mne-title', 'O mně', a.nadpis, '', color)}
      ${a.odstavce.map((p) => html`<p>${multiline(p)}</p>`)}
      ${a.vlastnosti.length ? html`<div class="traits">
        ${a.vlastnosti_nadpis ? html`<h3>${a.vlastnosti_nadpis}</h3>` : ''}
        <ul class="check-list">${a.vlastnosti.map((v, i) => html`<li><span class="check-icon acc-${accent(i)}">${uiIcon('check')}</span><span>${v}</span></li>`)}</ul>
      </div>` : ''}
      ${a.zaver ? html`<p class="about-outro">${uiIcon('sparkle')}<span>${multiline(a.zaver)}</span></p>` : ''}
    </div>
  </div>
</section>`;
}

// References: cards of one shape with a coloured quote mark and an initial.
function testimonials(c) {
  const r = c.reference;
  if (!r.polozky.length) return '';
  const color = SECTION_COLORS.reference;
  return html`<section id="reference" class="section section-band section-refs acc-${color}" aria-labelledby="reference-title">
  <div class="wrap">
    ${sectionHead('reference-title', 'Reference', r.nadpis, '', color)}
    <ul class="refs">
      ${r.polozky.map((p, i) => html`<li class="ref-item">
        <figure class="ref acc-${accent(i)}">
          <span class="ref-mark">${quoteMark()}</span>
          <blockquote><p>${multiline(p.text)}</p></blockquote>
          <figcaption><span class="ref-avatar" aria-hidden="true">${[...p.autor.trim()][0] ?? ''}</span><span class="ref-who"><strong>${p.autor}</strong>${p.popis_autora ? html` <span>${p.popis_autora}</span>` : ''}</span></figcaption>
        </figure>
      </li>`)}
    </ul>
    ${r.overeni ? html`<p class="refs-note">${multiline(r.overeni)}</p>` : ''}
  </div>
</section>`;
}

// A small fan of up to three of Ivona's own photos (hero, services, about –
// whichever are uploaded, each once) in the Facebook card, so the card that is
// as tall as the contact card has something to show between its text and its
// button. The previews are decorative (alt=""): the same photos with their
// descriptions are already on the page, and inside the link a description
// would only lengthen what a screen reader reads as the link's name. Without
// photos there is no fan at all (never a broken image).
function fbGallery(c) {
  const seen = new Set();
  const shots = [c.uvod.fotka, ...c.sluzby.polozky.map((p) => p.fotka), c.oMne.fotka]
    .filter((img) => img && img.src && !seen.has(img.src) && seen.add(img.src))
    .slice(0, 3);
  if (!shots.length) return '';
  return html`<span class="contact-fb-gallery"><span class="fb-shots fb-shots-${shots.length}">${shots.map((img) => html`<span class="fb-shot"><img src="${img.src}" width="${img.width}" height="${img.height}" alt="" decoding="async" loading="lazy"></span>`)}</span><span class="fb-shots-caption">Další fotky z akcí najdete na Facebooku</span></span>`;
}

// Contact: a big card with the invitation and large pill buttons with the
// phone number and the e-mail written out, each with a "Kopírovat" button
// (hidden without JavaScript, src/copy.js shows it when the browser can copy),
// and next to it the Facebook card.
function contact(c) {
  const k = c.kontakt;
  const fb = c.nastaveni.facebook;
  const color = SECTION_COLORS.kontakt;
  const copyBtn = (value, label) => html`<button type="button" class="copy-btn" data-copy="${value}" aria-label="${label}" hidden>${uiIcon('copy')}<span class="copy-label">Kopírovat</span></button>`;
  return html`<section id="kontakt" class="section section-contact acc-${color}" aria-labelledby="kontakt-title">
  <div class="wrap contact-grid${fb ? '' : ' contact-solo'}">
    <div class="contact-card">
      ${sectionHead('kontakt-title', 'Kontakt', k.nadpis, k.vyzva, color)}
      <ul class="contact-actions">
        <li class="contact-item"><a class="btn btn-primary btn-xl" href="tel:${k.telefon_href}">${uiIcon('phone')}<span class="btn-lines"><span class="contact-label">Zavolejte mi</span> <span class="contact-value">${k.telefon}</span></span></a>${copyBtn(k.telefon, 'Kopírovat telefonní číslo')}</li>
        <li class="contact-item"><a class="btn btn-secondary btn-xl" href="mailto:${k.email}">${uiIcon('mail')}<span class="btn-lines"><span class="contact-label">Napište mi</span> <span class="contact-value">${emailBreakable(k.email)}</span></span></a>${copyBtn(k.email, 'Kopírovat e-mailovou adresu')}</li>
      </ul>
      <p class="copy-status" role="status" aria-live="polite"></p>
      ${k.nazev_provozovny || k.adresa ? html`<address class="contact-address">${uiIcon('pin')}<span>${k.nazev_provozovny ? html`<strong>${k.nazev_provozovny}</strong>` : ''}${k.nazev_provozovny && k.adresa ? html`<br>` : ''}${k.adresa}</span></address>` : ''}
    </div>
    ${fb ? html`<a class="contact-fb" href="${fb}" rel="noopener noreferrer">${facebookLogo()}<span class="contact-fb-body"><span class="contact-fb-label">Facebook</span> <span class="contact-fb-text">${c.nastaveni.facebook_text || FACEBOOK_TEXT_DEFAULT}</span></span>${fbGallery(c)}<span class="contact-fb-cta"><span>Otevřít Facebook</span>${uiIcon('arrow')}</span></a>` : ''}
  </div>
</section>`;
}

export function renderIndex(c, { cssHref, themeJs, copyJs, fonts, year }) {
  const n = c.nastaveni;
  const ogImage = c.uvod.fotka || c.oMne.fotka || null;
  const jsonLd = raw(`<script type="application/ld+json">${jsonForScript(buildJsonLd(c))}</script>\n`);
  return czechTypography(`<!doctype html>
<html lang="cs">
<head>
${headCommon(c, { title: n.seo_titulek, description: n.seo_popis, cssHref, themeJs, copyJs, fonts, canonical: `${SITE_URL}/`, ogImage, extra: jsonLd })}</head>
<body id="top">
<a class="skip-link" href="#obsah">Přeskočit na obsah</a>
${siteHeader(c)}
<main id="obsah" tabindex="-1">
${hero(c)}
${services(c)}
${about(c)}
${testimonials(c)}
${contact(c)}
</main>
${siteFooter(c, { year })}
</body>
</html>
`);
}

export function render404(c, { cssHref, themeJs, fonts, year }) {
  const n = c.nastaveni;
  return czechTypography(`<!doctype html>
<html lang="cs">
<head>
${headCommon(c, { title: `Stránka nenalezena – ${n.nazev_webu}`, description: n.seo_popis, cssHref, themeJs, fonts, robots: 'noindex' })}</head>
<body id="top">
<a class="skip-link" href="#obsah">Přeskočit na obsah</a>
${siteHeader(c, { prefix: '/' })}
<main id="obsah" tabindex="-1">
${html`<section class="section not-found" aria-labelledby="nf-title">
  <div class="wrap">
    <div class="not-found-card">
      <p class="nf-digits" aria-hidden="true"><span class="nf-tile acc-pink">4</span><span class="nf-tile acc-sun">0</span><span class="nf-tile acc-blue">4</span></p>
      <p class="kicker">Chyba 404</p>
      <h1 id="nf-title">Tuhle stránku se nepodařilo najít</h1>
      <p class="lead">Možná se schovala za skákací hrad. Zkuste to prosím z úvodní stránky.</p>
      <p class="cta"><a class="btn btn-primary btn-lg" href="/">${uiIcon('home')}<span>Zpět na úvod</span></a></p>
    </div>
  </div>
</section>`}
</main>
${siteFooter(c, { year })}
</body>
</html>
`);
}

// Privacy page (GDPR art. 13, cookies, operator, consumer disputes). Generated from this template
// and content/provozovatel.json + kontakt.json – deliberately not free text in the administration.
// Written in the first person singular, like the rest of the site (the operator is one person).
function privacyMain(c) {
  const p = c.provozovatel;
  const k = c.kontakt;
  const fb = c.nastaveni.facebook;
  const privacyMail = html`<a href="mailto:${p.email_osobni_udaje}">${emailBreakable(p.email_osobni_udaje)}</a>`;
  const ext = (href, label) => html`<a href="${href}" rel="noopener noreferrer">${label}</a>`;
  return html`<article class="section legal acc-pink" aria-labelledby="legal-title">
  <div class="wrap legal-inner">
    <div class="section-head legal-head">
      <div class="section-title">
        <p class="kicker">Právní informace</p>
        <h1 id="legal-title">Ochrana soukromí a cookies</h1>
      </div>
      <p class="section-intro">Kdo tento web provozuje, jak zacházím s vašimi osobními údaji a proč tu nenajdete lištu se souhlasem s cookies.</p>
    </div>
    <div class="legal-card">

    <section class="legal-block" aria-labelledby="provozovatel">
      <h2 id="provozovatel">Provozovatel webu</h2>
      <dl class="legal-facts">
        <div><dt>Provozovatel</dt><dd>${p.jmeno}</dd></div>
        <div><dt>IČO</dt><dd>${p.ico}</dd></div>
        <div><dt>Adresa</dt><dd>${p.adresa}</dd></div>
        <div><dt>Zápis</dt><dd>${multiline(p.zapis)}</dd></div>
        <div><dt>Telefon</dt><dd><a href="tel:${k.telefon_href}">${k.telefon}</a></dd></div>
        <div><dt>E-mail</dt><dd><a href="mailto:${k.email}">${emailBreakable(k.email)}</a></dd></div>
      </dl>
    </section>

    <section class="legal-block" aria-labelledby="osobni-udaje">
      <h2 id="osobni-udaje">Osobní údaje</h2>
      <p>Správkyní osobních údajů jsem já, provozovatelka uvedená výše. Web nemá žádný formulář, registraci ani uživatelské účty, takže kromě technických údajů nutných pro jeho provoz (viz níže) od vás sám žádné osobní údaje nesbírá.</p>
      <h3>Co zpracovávám a proč</h3>
      <p>Když mi zavoláte nebo napíšete, zpracovávám vaše jméno, telefon nebo e-mail a údaje o akci (datum, místo, počet a věk dětí, požadovaný program). Potřebuji je, abych se s vámi mohla domluvit a akci připravit a uskutečnit.</p>
      <ul class="legal-list">
        <li>Právní základ: jednání o smlouvě a její plnění (čl. 6 odst. 1 písm. b) obecného nařízení o ochraně osobních údajů, GDPR).</li>
        <li>U faktur a dalších účetních a daňových dokladů: splnění povinnosti, kterou ukládá zákon (čl. 6 odst. 1 písm. c) GDPR).</li>
        <li>Poskytnutí údajů je dobrovolné, bez kontaktu se ale na akci domluvit nejde.</li>
        <li>Nedochází k automatizovanému rozhodování ani profilování.</li>
      </ul>
      <h3>Jak dlouho údaje uchovávám</h3>
      <p>Po dobu domluvy a konání akce. Pokud k objednávce nedojde, zprávy smažu nejpozději 6 měsíců po poslední zprávě. Po akci uchovávám domluvu nejvýše 3 roky (promlčecí lhůta pro případné nároky z objednávky). Účetní a daňové doklady uchovávám po dobu, kterou stanoví účetní a daňové předpisy.</p>
      <h3>Kdo k údajům má přístup</h3>
      <p>Údaje nikomu neprodávám ani je nepředávám pro reklamu. Technicky k nim mají přístup poskytovatel e-mailové schránky a telefonní operátor, přes které spolu komunikujeme, a u dokladů případně účetní nebo daňový poradce, pokud mi vede účetnictví.</p>
      <p>Web běží na hostingu Cloudflare (Cloudflare, Inc.), který pro mě údaje zpracovává jako zpracovatel. Při každé návštěvě zpracovává technické údaje (IP adresu, typ prohlížeče, čas přístupu), aby mohl stránku doručit a chránit ji před útoky. Právním základem je můj oprávněný zájem na bezpečném provozu webu (čl. 6 odst. 1 písm. f) GDPR). Cloudflare může tyto údaje zpracovávat i mimo Evropskou unii; společnost je zapojena do rámce EU–USA pro ochranu osobních údajů (Data Privacy Framework).</p>
      <h3>Vaše práva</h3>
      <p>Máte právo požádat o přístup ke svým údajům, o jejich opravu nebo výmaz, o omezení zpracování a o přenos údajů a máte právo vznést námitku proti zpracování na základě oprávněného zájmu. Svá práva uplatníte e-mailem na adrese ${privacyMail}.</p>
      <p>Pokud se domníváte, že s vašimi údaji nezacházím správně, můžete podat stížnost u Úřadu pro ochranu osobních údajů, Pplk. Sochora 27, 170 00 Praha 7, ${ext('https://www.uoou.gov.cz/', 'www.uoou.gov.cz')}.</p>
    </section>

    <section class="legal-block" aria-labelledby="fotografie">
      <h2 id="fotografie">Fotografie z akcí</h2>
      <p>Na akcích občas fotografuji, abych mohla ukázat, jak program vypadá. Fotografie, na kterých jsou děti poznat, zveřejňuji na tomto webu${fb ? ' a na Facebooku' : ''} jen se souhlasem rodičů, případně objednatele akce, který souhlas rodičů zajistí. Pokud si nepřejete, aby vaše dítě bylo fotografováno, řekněte mi to prosím na začátku akce. Souhlas můžete kdykoli odvolat e-mailem na ${privacyMail} a fotografii obratem odstraním.</p>
      <p>Právním základem je váš souhlas (čl. 6 odst. 1 písm. a) GDPR); fotografie zveřejňuji do jeho odvolání.${fb ? ' Fotografie zveřejněné na Facebooku zpracovává také jeho provozovatel, společnost Meta Platforms Ireland Limited.' : ''}</p>
      ${c.reference.polozky.length ? html`<p>Reference zákazníků zveřejňuji jen s jejich souhlasem, podepsané křestním jménem. Autor může souhlas kdykoli odvolat e-mailem na stejné adrese a referenci odstraním.</p>` : ''}
    </section>

    <section class="legal-block" aria-labelledby="cookies">
      <h2 id="cookies">Cookies</h2>
      <p>Běžným návštěvníkům web žádné cookies neukládá. Nepoužívá analytiku (například Google Analytics) ani jiné sledovací nástroje a nenačítá nic z cizích serverů – ani písma, ta jsou uložená přímo na tomto webu.</p>
      <p>Výjimečně může hosting Cloudflare kvůli ochraně před útoky a roboty uložit nezbytnou bezpečnostní cookie (například __cf_bm nebo cf_clearance). Přihlašovací část pro správu webu (/admin) používá nezbytné přihlašovací cookies (Cloudflare Access a přihlášení přes GitHub) – týká se jen správců webu. K nezbytným cookies souhlas potřeba není.</p>
      <p>Jediné, co se ve vašem prohlížeči ukládá, je volba světlého nebo tmavého vzhledu – a to jen tehdy, když si ji sami nastavíte tlačítkem v horní části stránky. Ukládá se v úložišti prohlížeče (localStorage), nikam se neodesílá a slouží jen k tomu, aby web při dalším načtení vypadal tak, jak jste si zvolili. Smažete ji vymazáním dat webu v prohlížeči. Protože jde o údaj nezbytný pro funkci, kterou si sami vyžádáte, není k němu potřeba souhlas (§ 89 odst. 3 zákona č. 127/2005 Sb., o elektronických komunikacích).</p>
      ${fb ? html`<p>Odkaz na Facebook je obyčejný odkaz: dokud na něj neklepnete, Facebook se nenačte a o vaší návštěvě nic neví. Po klepnutí se otevře web Facebooku a platí jeho pravidla ochrany soukromí.</p>` : ''}
    </section>

    <section class="legal-block" aria-labelledby="spory">
      <h2 id="spory">Řešení sporů a dozor</h2>
      <p>Pokud se se mnou jako spotřebitel nedohodnete, můžete využít mimosoudní řešení spotřebitelských sporů u České obchodní inspekce (oddělení ADR), ${ext('https://adr.coi.cz/', 'adr.coi.cz')}.</p>
      <p>Dozor nad dodržováním mých povinností vykonává ${p.zivnostensky_urad ? html`${p.zivnostensky_urad} (živnostenský úřad)` : 'příslušný živnostenský úřad'} a Česká obchodní inspekce (${ext('https://www.coi.cz/', 'www.coi.cz')}).</p>
    </section>

    <p class="legal-updated">Poslední aktualizace: ${PRIVACY_UPDATED}</p>
    </div>
  </div>
</article>`;
}

export function renderPrivacy(c, { cssHref, themeJs, fonts, year }) {
  const n = c.nastaveni;
  return czechTypography(`<!doctype html>
<html lang="cs">
<head>
${headCommon(c, {
    title: `Ochrana soukromí a cookies – ${n.nazev_webu}`,
    description: `Provozovatel webu ${fullName(n)}, zpracování osobních údajů (GDPR), fotografie z akcí, cookies a řešení sporů.`,
    cssHref,
    themeJs,
    fonts,
    canonical: `${SITE_URL}${PRIVACY_PATH}`,
  })}</head>
<body id="top">
<a class="skip-link" href="#obsah">Přeskočit na obsah</a>
${siteHeader(c, { prefix: '/' })}
<main id="obsah" tabindex="-1">
${privacyMain(c)}
</main>
${siteFooter(c, { year })}
</body>
</html>
`);
}

export function renderRobots() {
  return `User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

export function renderSitemap() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc></url>
  <url><loc>${SITE_URL}${PRIVACY_PATH}</loc></url>
</urlset>
`;
}
