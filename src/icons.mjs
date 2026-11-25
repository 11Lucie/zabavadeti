// Inline SVG graphics. All markup here is constant (no user content), uses
// presentation attributes only (no style attributes, no scripts, no external
// references) and is decorative (aria-hidden).
//
// Two kinds of icons:
// - Service icons: a bold coloured tile (an "app icon") with a flat drawing on
//   it – white shapes, dark details and one contrasting accent. The colours come
//   from CSS classes and tokens (the tile takes the accent of its card), so the
//   icons have no colour of their own and work in both themes.
// - Small UI icons: simple line icons in currentColor.
//
// The confetti decoration is a separate file (src/assets/konfety.svg) used from CSS.

import { raw } from './escape.mjs';

const r1 = (n) => Math.round(n * 10) / 10;

// Points of a star polygon.
function starPoints(cx, cy, outer, inner = outer * 0.5, spikes = 5, rotation = -90) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = ((rotation + (i * 180) / spikes) * Math.PI) / 180;
    pts.push(`${r1(cx + radius * Math.cos(angle))},${r1(cy + radius * Math.sin(angle))}`);
  }
  return pts.join(' ');
}

// Four-point sparkle (path data).
function sparkleD(cx, cy, s) {
  const k = r1(s * 0.16);
  return `M${cx} ${r1(cy - s)}C${r1(cx + k)} ${r1(cy - k)} ${r1(cx + k)} ${r1(cy - k)} ${r1(cx + s)} ${cy}C${r1(cx + k)} ${r1(cy + k)} ${r1(cx + k)} ${r1(cy + k)} ${cx} ${r1(cy + s)}C${r1(cx - k)} ${r1(cy + k)} ${r1(cx - k)} ${r1(cy + k)} ${r1(cx - s)} ${cy}C${r1(cx - k)} ${r1(cy - k)} ${r1(cx - k)} ${r1(cy - k)} ${cx} ${r1(cy - s)}Z`;
}

// Palette for the favicon (a standalone file, it cannot use CSS tokens). The same
// values are the accent tokens in src/styles.css (tests/theme.test.mjs checks it).
const C = {
  navy: '#0b1026',
  pink: '#ff3d9a',
  sun: '#ffd23f',
  blue: '#4a8cff',
  green: '#22c983',
};

// Favicon: a deep navy tile with a sunny star and two confetti dots – the same
// mark as the logo. The same file is in static/favicon.svg.
export const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" rx="16" fill="${C.navy}"/>` +
  `<polygon points="${starPoints(31, 34, 21, 10.5)}" fill="${C.sun}" stroke="${C.sun}" stroke-width="5" stroke-linejoin="round"/>` +
  `<circle cx="51" cy="13" r="6" fill="${C.pink}"/>` +
  `<circle cx="13" cy="52" r="4.5" fill="${C.blue}"/>` +
  `</svg>\n`;

// Logo mark in the header and footer: a pink tile with a sunny star and a blue
// confetti dot. Colours via classes (tokens), the same in both themes.
export function logoMark() {
  return raw(
    '<svg class="logo-svg" viewBox="0 0 48 48" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">' +
      '<rect class="lm-tile" width="48" height="48" rx="14"/>' +
      `<polygon class="lm-star" points="${starPoints(23, 26, 14.5, 7.2)}" stroke-width="3.5" stroke-linejoin="round"/>` +
      '<circle class="lm-dot" cx="38.5" cy="9.5" r="4"/>' +
      '</svg>',
  );
}

// ---------------------------------------------------------------------------
// Service icons (viewBox 0 0 48 48): a rounded tile in the card's accent
// colour (.ico-tile), white shapes (.ico-w), dark details (currentColor) and
// a contrasting second accent (.ico-x). Fixed paint colours (.ico-pink …) are
// used only on white shapes (paint dots on the palette).
// ---------------------------------------------------------------------------

const DARK = 'fill="currentColor"';
const LINE = 'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';

const SERVICE_ICONS = {
  // Face painting: a smiling face with a painted star on the cheek.
  oblicej:
    '<circle class="ico-w" cx="23" cy="25.5" r="13"/>' +
    `<circle ${DARK} cx="18.3" cy="22.5" r="1.9"/><circle ${DARK} cx="27.7" cy="22.5" r="1.9"/>` +
    `<path ${LINE} d="M18 29.2c2.8 3 7.2 3 10 0"/>` +
    `<polygon class="ico-x" points="${starPoints(31.2, 28.6, 4.2, 2.1)}"/>` +
    `<path class="ico-w" d="${sparkleD(37.5, 10.5, 4.5)}"/>`,

  // Glitter tattoo: a big sparkle, a small one and glitter dots.
  tetovani:
    `<path class="ico-w" d="${sparkleD(21, 22, 13)}"/>` +
    `<path class="ico-x" d="${sparkleD(34.5, 34, 6.5)}"/>` +
    `<circle ${DARK} cx="21" cy="22" r="2.4"/>` +
    '<circle class="ico-w" cx="36" cy="11.5" r="2.2"/><circle class="ico-w" cx="11" cy="37.5" r="1.8"/>',

  // Braids: a girl with two plaits and bows.
  copanky:
    '<circle class="ico-x" cx="13.5" cy="29" r="3"/><circle class="ico-x" cx="12.5" cy="35" r="2.6"/>' +
    '<circle class="ico-x" cx="34.5" cy="29" r="3"/><circle class="ico-x" cx="35.5" cy="35" r="2.6"/>' +
    '<circle class="ico-w" cx="24" cy="22" r="11"/>' +
    `<path ${DARK} d="M13 21.5C13.6 14.8 18.3 11 24 11s10.4 3.8 11 10.5c-4.6-.4-8.4-2.6-11-6.2-2.6 3.6-6.4 5.8-11 6.2Z"/>` +
    `<circle ${DARK} cx="20" cy="24.5" r="1.7"/><circle ${DARK} cx="28" cy="24.5" r="1.7"/>` +
    `<path ${LINE} d="M21 28.6c1.8 1.5 4.2 1.5 6 0"/>` +
    '<path class="ico-w" d="M9 39.5 12.5 41.5 9 43.5ZM16 39.5 12.5 41.5 16 43.5ZM32 39.5l3.5 2-3.5 2ZM39 39.5l-3.5 2 3.5 2Z"/>',

  // Creative workshops: painter's palette with paint dots and a brush.
  tvoreni:
    '<path class="ico-w" d="M22 9C13 9 6.5 15.3 6.5 23.3 6.5 31.6 13.3 38 22 38c2.6 0 4-1.3 4-3.2 0-2.1-1.7-2.9-1.7-4.9 0-1.9 1.5-3.2 3.5-3.2h3.5c4.8 0 8-3.2 8-7.4C39.3 13.5 31.5 9 22 9Z"/>' +
    '<circle class="ico-pink" cx="14" cy="22.5" r="3"/><circle class="ico-sun" cx="17.5" cy="15" r="3"/>' +
    '<circle class="ico-blue" cx="25.5" cy="13.5" r="3"/><circle class="ico-green" cx="32" cy="18" r="3"/>' +
    `<path ${LINE} d="M33 38.5 41.5 30"/>` +
    '<path class="ico-x" d="M33.4 37.8c-2.2-.5-4.3 1-4.6 3.2-.1 1.2-.8 2.3-1.8 3 3.3.8 6.3-.3 7.1-2.8.4-1.3.1-2.6-.7-3.4Z"/>',

  // Sport and games: a trophy with a star.
  sport:
    `<path ${LINE} d="M15 13.5H9.5c0 5.6 2.4 9 6.6 9.6M33 13.5h5.5c0 5.6-2.4 9-6.6 9.6"/>` +
    '<path class="ico-w" d="M14.5 9h19v10.5a9.5 9.5 0 0 1-19 0Z"/>' +
    '<rect class="ico-w" x="21.5" y="27" width="5" height="7"/>' +
    '<path class="ico-x" d="M16 41a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v1.5H16Z"/>' +
    `<polygon ${DARK} points="${starPoints(24, 18, 5, 2.4)}"/>`,

  // Bouncy castle with flags.
  hrad:
    `<path ${LINE} d="M10.5 16V8M37.5 16V8M24 13V5"/>` +
    '<path class="ico-x" d="M10.5 8 16 10 10.5 12ZM37.5 8 43 10 37.5 12ZM24 5l5.5 2-5.5 2Z"/>' +
    '<rect class="ico-w" x="6" y="16" width="9" height="26" rx="4.5"/>' +
    '<rect class="ico-w" x="33" y="16" width="9" height="26" rx="4.5"/>' +
    '<path class="ico-w" d="M13 42V25h5v-7a6 6 0 0 1 12 0v7h5v17Z"/>' +
    `<path ${DARK} d="M19.5 42v-5a4.5 4.5 0 0 1 9 0v5Z"/>` +
    '<circle class="ico-x" cx="24" cy="19" r="2.2"/>',

  // Costumes: carnival mask with a feather.
  kostymy:
    '<path class="ico-x" d="M31 16c1.5-5.2 5.2-8.3 10.5-9-.8 4.6-3.8 8-8.3 9.3Z"/>' +
    '<path class="ico-w" d="M5 20c0-3 3.8-4.6 9-4.6 4.6 0 7.5 1.8 10 1.8s5.4-1.8 10-1.8c5.2 0 9 1.6 9 4.6 0 9-5.2 13.5-10.5 13.5-3.9 0-5.4-3.9-8.5-3.9s-4.6 3.9-8.5 3.9C10.2 33.5 5 29 5 20Z"/>' +
    `<path ${DARK} d="M11.5 23c1.8-2.2 5.4-2.2 7.2 0-1.8 2.2-5.4 2.2-7.2 0ZM29.3 23c1.8-2.2 5.4-2.2 7.2 0-1.8 2.2-5.4 2.2-7.2 0Z"/>` +
    `<path ${LINE} d="M37 32.5 40 42"/>`,

  // Mascots: a friendly bear head.
  maskoti:
    '<circle class="ico-w" cx="13" cy="14" r="6"/><circle class="ico-w" cx="35" cy="14" r="6"/>' +
    '<circle class="ico-x" cx="13" cy="14" r="2.8"/><circle class="ico-x" cx="35" cy="14" r="2.8"/>' +
    '<circle class="ico-w" cx="24" cy="26" r="14"/>' +
    `<circle ${DARK} cx="18.5" cy="23.5" r="2"/><circle ${DARK} cx="29.5" cy="23.5" r="2"/>` +
    '<ellipse class="ico-x" cx="24" cy="31" rx="6" ry="4.6"/>' +
    `<path ${DARK} d="M21.6 28.6h4.8L24 31.2Z"/>`,

  // Kindergarten: toy blocks with a letter, a ball and a star.
  skolka:
    '<rect class="ico-w" x="6" y="25" width="16" height="16" rx="3"/>' +
    '<rect class="ico-w" x="26" y="25" width="16" height="16" rx="3"/>' +
    '<rect class="ico-w" x="16" y="7" width="16" height="16" rx="3" transform="rotate(-8 24 15)"/>' +
    `<path ${LINE} d="M10.5 37.5 14 29l3.5 8.5M11.8 34.5h4.4"/>` +
    '<circle class="ico-x" cx="34" cy="33" r="4.2"/>' +
    `<polygon class="ico-x" points="${starPoints(24, 15.3, 4.6, 2.2)}"/>`,

  // Party: birthday cake with candles.
  oslava:
    `<path ${LINE} d="M15 22v-5M24 22v-5M33 22v-5"/>` +
    '<path class="ico-x" d="M15 14c-1.6-1.4-1.6-3.2 0-5.2 1.6 2 1.6 3.8 0 5.2ZM24 14c-1.6-1.4-1.6-3.2 0-5.2 1.6 2 1.6 3.8 0 5.2ZM33 14c-1.6-1.4-1.6-3.2 0-5.2 1.6 2 1.6 3.8 0 5.2Z"/>' +
    '<path class="ico-w" d="M8 41V26a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v15Z"/>' +
    '<path class="ico-x" d="M8 26a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v3c-2.7 2.4-5.3 2.4-8 0-2.7 2.4-5.3 2.4-8 0-2.7 2.4-5.3 2.4-8 0-2.7 2.4-5.3 2.4-8 0Z"/>' +
    `<rect ${DARK} x="5" y="40" width="38" height="3.4" rx="1.7"/>`,
};

export const ICON_NAMES = Object.freeze(Object.keys(SERVICE_ICONS));

export function serviceIcon(name) {
  const body = SERVICE_ICONS[name];
  if (!body) throw new Error(`Unknown icon: ${name}`);
  return raw(
    `<svg class="service-svg" viewBox="0 0 48 48" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect class="ico-tile" width="48" height="48" rx="14"/>${body}</svg>`,
  );
}

// ---------------------------------------------------------------------------
// Small UI icons (24x24, stroke = currentColor)
// ---------------------------------------------------------------------------

const UI = {
  phone:
    '<path d="M6.5 3.5h3l1.5 4.2-2.2 1.6a12 12 0 0 0 5.9 5.9l1.6-2.2 4.2 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  // Facebook as an outline: rounded square with an "f" whose stem runs out through the bottom edge.
  facebook: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M16 7.5h-1.5A2.5 2.5 0 0 0 12 10v11M9 12.5h6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  home: '<path d="M4 11 12 4l8 7M6 9.5V20h12V9.5"/>',
  check: '<path d="m5.5 12.5 4 4L18.5 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 5.5v-.5a2 2 0 0 0-2-2h-8.5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h.5"/>',
  sparkle: `<path d="${sparkleD(12, 12, 9)}"/>`,
  // Theme switcher: half-filled circle (follow the system), sun, moon.
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7Z"/>',
};

export const UI_ICON_NAMES = Object.freeze(Object.keys(UI));

export function uiIcon(name, extraClass = '') {
  if (!UI[name]) throw new Error(`Unknown UI icon: ${name}`);
  if (extraClass && !/^[a-z][a-z0-9-]*$/.test(extraClass)) throw new Error(`Bad class: ${extraClass}`);
  return raw(
    `<svg class="ui-icon${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${UI[name]}</svg>`,
  );
}

// Big quote mark for the reference cards (filled, colour from CSS via currentColor).
export function quoteMark() {
  return raw(
    '<svg class="quote-svg" viewBox="0 0 48 36" aria-hidden="true" focusable="false" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M19 2C9 4.5 2 12 2 23v11h17V18h-7.5c0-5.6 3-9.5 7.5-11.5ZM45 2C35 4.5 28 12 28 23v11h17V18h-7.5c0-5.6 3-9.5 7.5-11.5Z"/>' +
      '</svg>',
  );
}

// Facebook logo (blue circle with a white "f") for the Facebook card in the contact – drawn
// here, nothing is loaded from Facebook. Colours come from CSS tokens (--fb-blue, --fb-ink)
// via the classes; the fill attributes are only a fallback. The bottom of the "f" follows the
// circle (arc), so no clipPath/id is needed.
export function facebookLogo(cls = 'fb-logo') {
  if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(cls)) throw new Error(`Bad class: ${cls}`);
  return raw(
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">` +
      '<circle class="fb-logo-bg" cx="12" cy="12" r="12" fill="#1877f2"/>' +
      '<path class="fb-logo-f" d="M16.7 15.5 17.2 12h-3.4V9.8c0-1 .5-1.9 2-1.9h1.5v-3s-1.4-.2-2.7-.2c-2.8 0-4.6 1.7-4.6 4.7V12H7v3.5h3v8.33A12 12 0 0 0 13.8 23.86V15.5Z" fill="#ffffff"/>' +
      '</svg>',
  );
}

// ---------------------------------------------------------------------------
// Placeholders shown when no photo has been uploaded yet: flat colourful
// shapes on the gradient panel of the photo card (colours via classes/tokens).
// ---------------------------------------------------------------------------

const svg = (viewBox, body, cls) =>
  raw(`<svg class="${cls}" viewBox="${viewBox}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

export function heroPlaceholder() {
  const body =
    // balloons on strings
    '<path class="art-line" d="M150 210c10 40-14 70 6 120M300 190c-8 40 14 70-4 130M225 160c-6 40 10 80-2 160" fill="none" stroke-width="4" stroke-linecap="round"/>' +
    '<ellipse class="art-pink" cx="150" cy="150" rx="52" ry="62"/>' +
    '<ellipse class="art-sun" cx="300" cy="135" rx="48" ry="58"/>' +
    '<ellipse class="art-blue" cx="225" cy="100" rx="44" ry="54"/>' +
    `<polygon class="art-green" points="${starPoints(90, 330, 26, 13)}"/>` +
    `<polygon class="art-sun" points="${starPoints(360, 300, 20, 10)}"/>` +
    `<path class="art-white" d="${sparkleD(370, 60, 18)}"/>` +
    `<path class="art-white" d="${sparkleD(70, 70, 12)}"/>`;
  return svg('0 0 440 420', body, 'illustration');
}

export function aboutPlaceholder() {
  const body =
    // a big heart with sparkles
    '<path class="art-pink" d="M210 360C110 290 50 230 50 160c0-48 36-82 80-82 34 0 60 20 80 48 20-28 46-48 80-48 44 0 80 34 80 82 0 70-60 130-160 200Z"/>' +
    `<polygon class="art-sun" points="${starPoints(345, 70, 26, 13)}"/>` +
    `<polygon class="art-blue" points="${starPoints(70, 330, 20, 10)}"/>` +
    `<path class="art-white" d="${sparkleD(210, 190, 30)}"/>`;
  return svg('0 0 420 420', body, 'illustration');
}
