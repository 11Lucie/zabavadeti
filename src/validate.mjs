// Loading and validation of content/*.json.
//
// The schema here is the contract between the website and the admin (Decap
// CMS). Every problem is reported as { where, field, message, fix } in plain
// Czech so that a non-technical editor understands what to change.

import { ICON_NAMES } from './icons.mjs';
import { readRegularFile, reasonText } from './safe-fs.mjs';

const MAX_CONTENT_BYTES = 1024 * 1024;

export const IKONY = Object.freeze([
  'oblicej', 'tetovani', 'copanky', 'tvoreni', 'sport',
  'hrad', 'kostymy', 'maskoti', 'skolka', 'oslava',
]);

export const IKONY_POPIS = {
  oblicej: 'malování na obličej',
  tetovani: 'tetování',
  copanky: 'copánky',
  tvoreni: 'tvoření',
  sport: 'sport',
  hrad: 'skákací hrad',
  kostymy: 'kostýmy',
  maskoti: 'maskoti',
  skolka: 'školka',
  oslava: 'oslava',
};

// Field kinds:
//   line   – single-line plain text (newlines are folded into spaces)
//   text   – multi-line plain text (newlines are kept and rendered as <br>)
//   phone, email, facebook, photo – special validated strings
//   enum   – one of `values`
//   list   – array of `of` (a field spec)
//   object – nested object with `fields`
const line = (label, max, required = true, extra = {}) => ({ kind: 'line', label, max, required, ...extra });
const text = (label, max, required = true) => ({ kind: 'text', label, max, required });
const photo = (label) => ({ kind: 'photo', label, required: false });
// requiredWith: the field is required when the named sibling field is filled in
// (a photo, a non-empty list).
const requiredWith = (spec, field, message) => ({ ...spec, requiredWith: { field, message } });

export const FACEBOOK_TEXT_DEFAULT = 'Sledujte fotky a novinky z mých akcí na Facebooku';

export const SCHEMA = {
  'nastaveni.json': {
    title: 'Nastavení webu',
    fields: {
      nazev_webu: line('Název webu', 60),
      podtitul: line('Podtitul', 80, false),
      seo_titulek: line('Titulek pro vyhledávače', 70),
      seo_popis: line('Popis pro vyhledávače', 160),
      facebook: { kind: 'facebook', label: 'Odkaz na Facebook', required: false },
      facebook_text: line('Text u odkazu na Facebook', 120, false),
    },
  },
  'uvod.json': {
    title: 'Úvod',
    fields: {
      nadpis: line('Hlavní nadpis', 90),
      perex: text('Úvodní text', 600),
      pro_koho_nadpis: line('Nadpis „pro koho“', 80, false),
      pro_koho: { kind: 'list', label: 'Pro koho (štítky)', min: 0, max: 12, of: line('Štítek', 40) },
      skolky: text('Text o školkách', 400, false),
      slogan: line('Slogan', 120, false),
      fotka: photo('Fotka'),
      fotka_popis: line('Popis fotky', 160, false),
    },
  },
  'sluzby.json': {
    title: 'Služby',
    fields: {
      nadpis: line('Nadpis', 90),
      uvod: text('Úvodní text', 800, false),
      polozky: {
        kind: 'list', label: 'Služby', min: 1, max: 24,
        of: {
          kind: 'object', label: 'Služba',
          fields: {
            nazev: line('Název služby', 70),
            popis: text('Popis služby', 400),
            ikona: { kind: 'enum', label: 'Ikona', values: IKONY, required: true },
            fotka: photo('Fotka služby'),
            fotka_popis: requiredWith(line('Popis fotky', 160, false), 'fotka', 'Služba má fotku, ale chybí popis fotky (co je na ní).'),
          },
        },
      },
    },
  },
  'o-mne.json': {
    title: 'O mně',
    fields: {
      nadpis: line('Nadpis', 90),
      odstavce: { kind: 'list', label: 'Odstavce', min: 1, max: 10, of: text('Odstavec', 1200) },
      vlastnosti_nadpis: line('Nadpis seznamu vlastností', 90, false),
      vlastnosti: { kind: 'list', label: 'Vlastnosti', min: 0, max: 12, of: line('Vlastnost', 200) },
      zaver: text('Závěr', 600, false),
      fotka: photo('Fotka'),
      fotka_popis: line('Popis fotky', 160, false),
    },
  },
  'reference.json': {
    title: 'Reference',
    fields: {
      nadpis: line('Nadpis', 90),
      polozky: {
        kind: 'list', label: 'Reference', min: 0, max: 30,
        of: {
          kind: 'object', label: 'Reference',
          fields: {
            autor: line('Jméno', 60),
            popis_autora: line('Kdo to je', 100, false),
            text: text('Text reference', 1200),
          },
        },
      },
      overeni: requiredWith(
        text('Informace o původu referencí', 400, false),
        'polozky',
        'Na webu jsou reference, ale chybí informace o tom, odkud pocházejí (vyžaduje zákon o ochraně spotřebitele).',
      ),
    },
  },
  'kontakt.json': {
    title: 'Kontakt',
    fields: {
      nadpis: line('Nadpis', 90),
      vyzva: text('Výzva', 400, false),
      telefon: { kind: 'phone', label: 'Telefon', required: true },
      email: { kind: 'email', label: 'E-mail', required: true },
      nazev_provozovny: line('Název provozovny', 100, false),
      adresa: line('Adresa', 160, false),
    },
  },
  'provozovatel.json': {
    title: 'Provozovatel',
    fields: {
      jmeno: line('Jméno a příjmení (název) provozovatele', 100),
      ico: { kind: 'ico', label: 'IČO', required: true },
      adresa: line('Adresa (místo podnikání)', 160),
      zapis: text('Zápis v rejstříku', 300),
      zivnostensky_urad: line('Živnostenský úřad', 120, false),
      email_osobni_udaje: { kind: 'email', label: 'E-mail pro dotazy k osobním údajům', required: true },
    },
  },
};

// Czech company ID (IČO): 8 digits, the last one is a check digit (weights 8 … 2, mod 11).
export function isValidIco(v) {
  if (typeof v !== 'string' || !/^[0-9]{8}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(v[i]) * (8 - i);
  return (11 - (sum % 11)) % 10 === Number(v[7]);
}

// Sanity: every icon allowed by the schema must have a drawing.
for (const name of IKONY) {
  if (!ICON_NAMES.includes(name)) throw new Error(`Missing SVG for icon ${name}`);
}

// Invisible and disguising characters, by Unicode category (u flag):
//   Cc \u2013 control characters (tab and newline are removed before the test),
//   Cf \u2013 format characters: bidi marks/overrides (RLM, LRM, ALM, RLO \u2026), zero-width
//        characters, soft hyphen, BOM, "tag" characters U+E0000\u2013E007F (hidden ASCII text),
//   Co \u2013 private use, Cs \u2013 lone surrogates,
//   Default_Ignorable_Code_Point \u2013 everything a font draws as nothing: variation selectors
//        U+FE00\u2013FE0F and U+E0100\u2013E01EF, combining grapheme joiner U+034F, Mongolian
//        selectors U+180B\u2013180F, Khmer U+17B4/17B5, blank Hangul fillers, invisible
//        operators \u2026 (text hidden from people that robots and filters still "see"),
// plus the Braille blank U+2800 (looks like a space, but is a letter) and the line/paragraph
// separators (Zl/Zp).
// Allowed exceptions used by emoji: the zero-width joiner inside emoji sequences
// (\uD83D\uDC69\u200D\uD83C\uDFA8, see EMOJI_ZWJ) and the emoji variation selector U+FE0F right after
// an emoji (\u2764\uFE0F) or inside a keycap (1\uFE0F\u20E3), see EMOJI_VS16.
// Four or more combining marks in a row ("zalgo" text drawn over other lines) are refused too.
// \p{Cn} (unassigned) is deliberately not used: it depends on the Unicode version of Node
// and would reject new emoji.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2028}\u{2029}\u{2800}]/u;
const EMOJI_ZWJ = /(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}]\u{FE0F}?)\u{200D}(?=\p{Extended_Pictographic})/gu;
const EMOJI_VS16 = /(?<=\p{Extended_Pictographic})\u{FE0F}|(?<=[#*0-9])\u{FE0F}(?=\u{20E3})/gu;
const MARK_RUN = /\p{M}{4,}/u;

export function hasForbiddenChars(v) {
  const rest = String(v).replace(/[\t\n]/g, '').replace(EMOJI_ZWJ, '').replace(EMOJI_VS16, '');
  return FORBIDDEN_CHARS.test(rest) || MARK_RUN.test(rest);
}

const PHONE_RE = /^\+?[0-9]+(?: [0-9]+)*$/;
// No "%" in the local part: a mailto: link is percent-decoded by the mail client, so
// "spy%40evil.cz%2Civona@seznam.cz" would become two recipients. ",", "?", "&", "=" are
// not allowed either.
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const FACEBOOK_RE = /^https:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9._~\-\/%?=&+#]*$/;
// Facebook endpoints that redirect elsewhere or act (link shim, dialogs, login \u2026) \u2013 never a
// page of the business itself.
const FACEBOOK_DENY_RE = /^\/(?:(?:l|lm|login|logout|sharer|profile_redirect)\.php|(?:flx|dialog|sharer|login|logout|plugins|connect|checkpoint|recover|ajax|v\d+(?:\.\d+)?)(?:\/|$))/i;

// Returns the cleaned Facebook URL (no query except ?id= on profile.php, no #fragment),
// or null when the value is not an acceptable link to a Facebook page/group/profile.
export function normalizeFacebook(v) {
  if (!FACEBOOK_RE.test(v) || v.length > 300) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'www.facebook.com' && u.hostname !== 'facebook.com')) return null;
  if (u.username || u.password || u.port) return null;
  let path;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (path === '/' || FACEBOOK_DENY_RE.test(path) || /[\\]|\/\.\.?(?:\/|$)/.test(path)) return null;
  if (u.pathname.toLowerCase() === '/profile.php') {
    const id = u.searchParams.get('id');
    if (!id || !/^\d{1,20}$/.test(id)) return null;
    return `${u.origin}/profile.php?id=${id}`;
  }
  return u.origin + u.pathname;
}
export const PHOTO_RE = /^\/uploads\/([a-z0-9][a-z0-9._-]*\.(?:jpg|jpeg|png|webp))$/;

export function phoneToHref(phone) {
  const digits = phone.replace(/[^0-9]/g, '');
  return (phone.trim().startsWith('+') ? '+' : '') + digits;
}

const quote = (s) => `„${s}“`;
const length = (s) => [...s].length;

function fieldLabel(path) {
  // path like ['polozky', 2, 'ikona'] -> human readable Czech description
  const parts = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (typeof p === 'number') parts.push(`položka č. ${p + 1}`);
    else parts.push(`pole ${quote(p)}`);
  }
  return parts.join(' → ');
}

function validateValue(spec, value, path, ctx) {
  const where = ctx.where;
  const err = (message, fix) => ctx.errors.push({ where, field: fieldLabel(path), message, fix });
  const missing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

  if (spec.kind === 'list') {
    if (value === undefined || value === null) value = [];
    if (!Array.isArray(value)) {
      err(`${spec.label}: má to být seznam, ale je tam něco jiného.`, 'Opravte pole v administraci, nebo obnovte soubor z gitu.');
      return [];
    }
    const out = [];
    value.forEach((item, i) => {
      // Empty rows of simple text lists are silently dropped (the admin can
      // leave an empty row behind when an item is added and not filled in).
      const isEmpty = item === undefined || item === null || (typeof item === 'string' && item.trim() === '');
      if (spec.of.kind !== 'object' && isEmpty) return;
      const v = validateValue(spec.of, item, [...path, i], ctx);
      if (v !== undefined && v !== '') out.push(v);
    });
    if (out.length < spec.min) {
      err(`${spec.label}: seznam musí mít alespoň ${spec.min} ${spec.min === 1 ? 'vyplněnou položku' : 'vyplněné položky'}.`, 'Přidejte a vyplňte položku.');
    }
    if (value.length > spec.max) {
      err(`${spec.label}: seznam má ${value.length} položek, povoleno je nejvýše ${spec.max}.`, 'Některé položky odeberte.');
    }
    return out;
  }

  if (spec.kind === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      err(`${spec.label}: položka má špatný tvar.`, 'Smažte položku a vytvořte ji v administraci znovu.');
      return undefined;
    }
    return validateObject(spec.fields, value, path, ctx);
  }

  if (missing) {
    if (spec.required) {
      err(`${spec.label}: pole je povinné a je prázdné.`, 'Doplňte ho.');
    }
    return '';
  }

  if (typeof value !== 'string') {
    err(`${spec.label}: má to být text, ale je tam ${typeof value === 'number' ? 'číslo' : 'jiný typ hodnoty'}.`, 'Zapište hodnotu jako text.');
    return '';
  }

  let v = value.replace(/\r\n?/g, '\n').trim();
  if (hasForbiddenChars(v)) {
    err(`${spec.label}: text obsahuje neviditelné řídicí znaky.`, 'Text smažte a napište ho znovu ručně (nekopírujte ho z jiného programu).');
    return '';
  }

  switch (spec.kind) {
    case 'line':
      v = v.replace(/\s+/g, ' ');
      break;
    case 'text':
      v = v.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
      break;
    case 'enum':
      if (!spec.values.includes(v)) {
        err(
          `${spec.label}: hodnota ${quote(v)} není povolená.`,
          `Vyberte jednu z možností: ${spec.values.map((x) => `${x} (${IKONY_POPIS[x] ?? x})`).join(', ')}.`,
        );
        return '';
      }
      return v;
    case 'phone': {
      const digits = v.replace(/[^0-9]/g, '');
      if (!PHONE_RE.test(v) || digits.length < 9 || digits.length > 15) {
        err(
          `${spec.label}: ${quote(v)} není platné telefonní číslo.`,
          'Napište číslo jen pomocí číslic a mezer, případně se znakem + na začátku, např. +420 739 039 559.',
        );
        return '';
      }
      return v;
    }
    case 'email':
      if (v.length > 254 || !EMAIL_RE.test(v) || v.includes('..')) {
        err(`${spec.label}: ${quote(v)} není platná e-mailová adresa.`, 'Napište adresu ve tvaru jmeno@domena.cz (bez mezer a bez „mailto:“).');
        return '';
      }
      return v;
    case 'ico': {
      const compact = v.replace(/\s+/g, '');
      if (!/^[0-9]{8}$/.test(compact)) {
        err(`${spec.label}: ${quote(v)} není IČO – IČO má přesně 8 číslic.`, 'Opište IČO ze živnostenského listu nebo z výpisu na rzp.gov.cz (jen číslice, bez mezer).');
        return '';
      }
      if (!isValidIco(compact)) {
        err(
          `${spec.label}: ${quote(v)} není platné IČO – nesedí kontrolní číslice (pravděpodobně překlep).`,
          'Zkontrolujte číslo podle živnostenského listu nebo výpisu na rzp.gov.cz a opravte ho.',
        );
        return '';
      }
      return compact;
    }
    case 'facebook': {
      const clean = normalizeFacebook(v);
      if (!clean) {
        err(
          `${spec.label}: ${quote(v)} není odkaz na stránku nebo skupinu na Facebooku.`,
          'Vložte celý odkaz na vaši stránku nebo skupinu, který začíná https://www.facebook.com/ (zkopírujte ho z adresního řádku prohlížeče, když máte stránku otevřenou), nebo pole nechte prázdné.',
        );
        return '';
      }
      return clean;
    }
    case 'photo': {
      const m = PHOTO_RE.exec(v);
      if (!m || v.includes('..')) {
        let fix = 'Fotku nahrajte znovu přes administraci. Povolené jsou jen soubory .jpg, .jpeg, .png a .webp ze složky /uploads/.';
        if (/^\/uploads\/[^/]+$/.test(v) && !v.includes('..')) {
          fix = 'Název souboru smí obsahovat jen malá písmena bez diakritiky, číslice, tečku, pomlčku a podtržítko a musí končit .jpg, .jpeg, .png nebo .webp. Přejmenujte fotku v počítači (např. ivona-s-maskoty.jpg) a nahrajte ji znovu.';
        }
        err(`${spec.label}: cesta k fotce ${quote(v)} není povolená.`, fix);
        return '';
      }
      const info = ctx.images?.get(m[1]);
      if (!info) {
        err(
          `${spec.label}: soubor ${quote(m[1])} ve složce static/uploads neexistuje (nebo neprošel kontrolou fotek).`,
          'Nahrajte fotku znovu přes administraci, nebo v poli vyberte jinou fotku.',
        );
        return '';
      }
      return { src: `/uploads/${m[1]}`, width: info.width, height: info.height };
    }
    default:
      throw new Error(`Unknown field kind ${spec.kind}`);
  }

  if (spec.max && length(v) > spec.max) {
    const over = length(v) - spec.max;
    err(
      `${spec.label}: text má ${length(v)} znaků, povoleno je nejvýše ${spec.max}.`,
      `Zkraťte ho alespoň o ${over} ${over === 1 ? 'znak' : over < 5 ? 'znaky' : 'znaků'}.`,
    );
  }
  return v;
}

function hasErrorFor(ctx, path) {
  const label = fieldLabel(path);
  return ctx.errors.some((e) => e.where === ctx.where && e.field === label);
}

function validateObject(fields, obj, path, ctx) {
  const out = {};
  for (const key of Object.keys(obj)) {
    // Object.hasOwn, not "in": "constructor", "toString", "__proto__" … are inherited and
    // must be reported as unknown fields too.
    if (!Object.hasOwn(fields, key)) {
      ctx.errors.push({
        where: ctx.where,
        field: fieldLabel([...path, key]),
        message: `Neznámé pole ${quote(key)} – web ho nezná a nezobrazil by ho.`,
        fix: `Pole odstraňte, nebo zkontrolujte překlep. Povolená pole: ${Object.keys(fields).join(', ')}.`,
      });
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    out[key] = validateValue(spec, obj[key], [...path, key], ctx);
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (!spec.requiredWith) continue;
    const other = out[spec.requiredWith.field];
    const filled = Array.isArray(other) ? other.length > 0 : Boolean(other);
    // Only when the field itself is empty and had no error of its own.
    if (filled && out[key] === '' && !hasErrorFor(ctx, [...path, key])) {
      ctx.errors.push({
        where: ctx.where,
        field: fieldLabel([...path, key]),
        message: `${spec.label}: ${spec.requiredWith.message}`,
        fix: 'Doplňte ho.',
      });
    }
  }
  return out;
}

// Validates already-parsed JSON for one file. Returns { value, errors }.
export function validateFile(fileName, data, images) {
  const schema = SCHEMA[fileName];
  const ctx = { where: `content/${fileName}`, errors: [], images };
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    ctx.errors.push({ where: ctx.where, message: 'Soubor nemá správný tvar (má obsahovat objekt { … }).', fix: 'Obnovte soubor z gitu, nebo ho uložte znovu v administraci.' });
    return { value: null, errors: ctx.errors };
  }
  const value = validateObject(schema.fields, data, [], ctx);
  return { value, errors: ctx.errors };
}

// Validates a whole content object { 'nastaveni.json': {...}, ... }.
// Returns { content, errors } where content uses friendly keys.
export function validateContent(raw, images = new Map()) {
  const errors = [];
  const values = {};
  for (const fileName of Object.keys(SCHEMA)) {
    if (!Object.hasOwn(raw, fileName)) {
      errors.push({ where: `content/${fileName}`, message: 'Soubor chybí.', fix: 'Obnovte ho z gitu.' });
      continue;
    }
    const r = validateFile(fileName, raw[fileName], images);
    errors.push(...r.errors);
    values[fileName] = r.value;
  }
  if (errors.length) return { content: null, errors };

  const kontakt = values['kontakt.json'];
  kontakt.telefon_href = phoneToHref(kontakt.telefon);
  return {
    content: {
      nastaveni: values['nastaveni.json'],
      uvod: values['uvod.json'],
      sluzby: values['sluzby.json'],
      oMne: values['o-mne.json'],
      reference: values['reference.json'],
      kontakt,
      provozovatel: values['provozovatel.json'],
    },
    errors,
  };
}

export async function loadContent(root) {
  const raw = {};
  const errors = [];
  for (const fileName of Object.keys(SCHEMA)) {
    // No symlinks (neither content/ nor the file), regular file, size limit – see src/safe-fs.mjs.
    const r = await readRegularFile(root, `content/${fileName}`, MAX_CONTENT_BYTES);
    if (!r.ok) {
      errors.push({ where: `content/${fileName}`, message: reasonText(r.reason, MAX_CONTENT_BYTES), fix: 'Obnovte soubor z gitu.' });
      continue;
    }
    const textValue = r.text;
    try {
      raw[fileName] = JSON.parse(textValue.replace(/^\uFEFF/, ''));
    } catch (e) {
      // Only the position goes to the log, never an excerpt of the file content.
      const m = /line (\d+) column (\d+)/.exec(e.message) || /position (\d+)/.exec(e.message);
      const pos = m ? (m[2] ? `řádek ${m[1]}, znak ${m[2]}` : `kolem znaku ${m[1]}`) : 'místo se nepodařilo určit';
      errors.push({
        where: `content/${fileName}`,
        message: `Soubor není platný JSON (${pos}).`,
        fix: 'Pravděpodobně chybí uvozovka, čárka nebo závorka. Obnovte soubor z gitu, nebo ho uložte znovu v administraci.',
      });
    }
  }
  return { raw, errors };
}

export async function loadAndValidateContent(root, images) {
  const { raw, errors } = await loadContent(root);
  if (errors.length) return { content: null, errors };
  return validateContent(raw, images);
}
