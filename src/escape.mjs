// HTML escaping and a tiny auto-escaping template tag.
//
// Every interpolated value in an html`` template is escaped unless it is an
// instance of SafeHtml (produced by html`` itself or by raw()). raw() is only
// ever used for constant markup written in this repository (SVG icons) and
// for JSON-LD that went through jsonForScript().

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export class SafeHtml {
  constructor(value) {
    this.value = String(value);
  }
  toString() {
    return this.value;
  }
}

export function raw(value) {
  return new SafeHtml(value);
}

function renderValue(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

// Czech typography for a finished HTML page: a no-break space after one-letter
// prepositions and conjunctions (k, s, v, z, o, u, a, i), after abbreviations
// that belong to the following number (§, č., čl., odst., písm.) and between
// groups of digits (+420 739 039 559, 594 42). Only text between tags is
// changed – never tags, attribute values, <script> (JSON-LD) or <style>.
export const NBSP = '\u00a0';
const ONE_LETTER = /(?<=^|[\s(\u201e\u00a0])([KkSsVvZzOoUuAaIi]) (?=\S|$)/g;
const ABBREV = /(?<=^|[\s(\u201e\u00a0])(\u00a7|\u010d\.|\u010dl\.|odst\.|p\u00edsm\.) (?=\S|$)/g;
const DIGITS = /(?<=\d) (?=\d)/g;
const SEGMENTS = /(<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<[^>]*>)/gi;

export function czechText(text) {
  return String(text).replace(ONE_LETTER, `$1${NBSP}`).replace(ABBREV, `$1${NBSP}`).replace(DIGITS, NBSP);
}

export function czechTypography(page) {
  return String(page).split(SEGMENTS).map((part, i) => (i % 2 === 1 ? part : czechText(part))).join('');
}

// JSON for embedding inside <script type="application/ld+json">.
// Escapes characters that could terminate the script element or confuse
// HTML/JS parsers.
export function jsonForScript(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
