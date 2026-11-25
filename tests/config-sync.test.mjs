// Keeps the administration (static/admin/config.yml) in sync with the build validation
// (SCHEMA in src/validate.mjs). Whatever the administration accepts must also pass the build –
// otherwise a published draft would break the build of main and block further deployments.
// The CMS may be stricter than the build, never looser.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { SCHEMA, IKONY, validateContent, isValidIco } from '../src/validate.mjs';
import { checkUploads } from '../scripts/check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YML = readFileSync(path.join(ROOT, 'static', 'admin', 'config.yml'), 'utf8');

// Minimal YAML reader for the subset used in config.yml: nested maps and lists by
// indentation, "- key: value" list items, scalars, single-line ['…', '…'] lists,
// { … } flow maps (kept as raw text) and folded block scalars (>-, skipped).
export function parseYaml(text) {
  const lines = text
    .split('\n')
    .map((raw) => ({ indent: raw.match(/^ */)[0].length, s: raw.trim() }))
    .filter((l) => l.s && !l.s.startsWith('#'));
  let i = 0;
  const flowSeq = (v) => [...v.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  function scalar(v) {
    v = v.trim();
    if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    if (v.startsWith('"')) return JSON.parse(v);
    if (v.startsWith('[')) return flowSeq(v);
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }
  function parseBlock(indent) {
    return lines[i].s.startsWith('- ') ? parseList(indent) : parseMap(indent);
  }
  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].s.startsWith('- ')) {
      const { s } = lines[i];
      const c = s.indexOf(':');
      assert.ok(c > 0, `YAML: očekáván klíč na řádku „${s}“`);
      const key = s.slice(0, c).trim();
      const rest = s.slice(c + 1).trim();
      assert.ok(!Object.hasOwn(obj, key), `YAML: klíč „${key}“ je v jedné mapě dvakrát (Decap by konfiguraci nenačetl)`);
      i++;
      if (rest === '>-' || rest === '>' || rest === '|') {
        while (i < lines.length && lines[i].indent > indent) i++;
        obj[key] = '(block)';
      } else if (rest === '') {
        obj[key] = i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : null;
      } else {
        obj[key] = scalar(rest);
      }
    }
    return obj;
  }
  function parseList(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].s.startsWith('- ')) {
      const item = lines[i].s.slice(2);
      if (/^[\w-]+:(?: |$)/.test(item)) {
        lines[i] = { indent: indent + 2, s: item };
        arr.push(parseMap(indent + 2));
      } else {
        i++;
        arr.push(scalar(item));
      }
    }
    return arr;
  }
  return parseMap(0);
}

// Strict line check of config.yml (the CMS refuses to start when config.yml is not valid YAML –
// e.g. an unquoted hint containing ": " – and the minimal reader above would not notice).
// Allowed values: empty (nested block), block scalar (>-, >, |, |-), a double-quoted string with
// JSON escapes only, a single-quoted string, a flow list of single-quoted strings, a flow map of
// key: "…" pairs, or a plain scalar made only of [A-Za-z0-9_./:@+-] with no ": " – i.e. names,
// numbers, paths and URLs. Any human text must be quoted. Returns a list of problems.
const DQ = String.raw`"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"`;
const SQ = String.raw`'(?:[^'\x00-\x1f]|'')*'`;
const VALUE_RES = [
  new RegExp(`^${DQ}$`),
  new RegExp(`^${SQ}$`),
  new RegExp(String.raw`^\[ *${SQ}(?: *, *${SQ})* *\]$`),
  new RegExp(String.raw`^\{ *[a-z_]+: ${DQ}(?: *, *[a-z_]+: ${DQ})* *\}$`),
  /^(?![-?:,[\]{}#&*!|>'"%@`])[A-Za-z0-9_./:@+-]+(?<!:)$/,
];
export function lintYaml(text) {
  const problems = [];
  const lines = text.split('\n');
  let blockIndent = -1; // inside a block scalar: indent of its key
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n].replace(/\r$/, '');
    const at = `řádek ${n + 1}`;
    if (/\t/.test(raw)) problems.push(`${at}: tabulátor (YAML ho k odsazení nedovoluje)`);
    const indent = raw.match(/^ */)[0].length;
    const s = raw.trim();
    if (blockIndent >= 0) {
      if (!s || indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (!s || s.startsWith('#')) continue;
    const m = /^(- )?(?:([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?|(.*))$/.exec(s);
    const value = (m[2] !== undefined ? m[3] ?? '' : m[4]).trim();
    if (m[2] === undefined && !m[1]) {
      problems.push(`${at}: očekáván „klíč: hodnota“ nebo položka seznamu „- …“`);
      continue;
    }
    if (value === '') continue;
    if (/^[>|][-+]?$/.test(value)) {
      blockIndent = indent;
      continue;
    }
    if (!VALUE_RES.some((re) => re.test(value))) {
      problems.push(`${at}: hodnota „${value.slice(0, 50)}“ musí být v uvozovkách (text s mezerou, „: “, „ #“ nebo zvláštním znakem na začátku)`);
      continue;
    }
    if (value.startsWith('"')) JSON.parse(value); // JSON escapes are a subset of YAML double-quoted escapes
  }
  return problems;
}

const RAW = Object.fromEntries(
  Object.keys(SCHEMA).map((f) => [f, JSON.parse(readFileSync(path.join(ROOT, 'content', f), 'utf8'))]),
);
// Photos of the real content (read only) – validateContent needs them to accept content/*.json.
const IMAGES = (await checkUploads(ROOT)).images;
function buildAccepts(file, field, value) {
  const d = structuredClone(RAW);
  d[file][field] = value;
  return validateContent(d, IMAGES).errors.length === 0;
}

describe('config.yml je platný YAML (jinak se administrace vůbec nenačte)', () => {
  test('žádná neuvozovaná hodnota s mezerou, „: “, „ #“ ani zvláštním znakem; žádný tabulátor', () => {
    assert.deepEqual(lintYaml(YML), []);
  });

  test('kontrola zachytí chyby, kvůli kterým Decap konfiguraci odmítne', () => {
    const bad = [
      'hint: Služba se zobrazí jako velká karta: fotka celá',
      'hint: úřad: Městský úřad',
      'hint: Text #1 s komentářem',
      'label: - položka',
      'label: *alias',
      'label: &kotva text',
      'label: !tag text',
      'label: %procenta',
      'label: @zavinac',
      'label: `zpětný apostrof`',
      "label: 'neuzavřený",
      'label: "neuzavřený',
      'label: "špatný \\x escape"',
      'label: {nevalidní mapa}',
      'label: [nevalidní seznam]',
      'label: x:',
      '\tlabel: "tabulátor"',
      'jen text bez klíče',
    ];
    for (const line of bad) assert.ok(lintYaml(`a:\n  ${line}\n`).length > 0, line);
    const good = [
      'hint: "Služba se zobrazí jako velká karta: fotka celá"',
      "hint: 'Text #1: ''citace'''",
      'base_url: https://www.zabavadeti.cz',
      'max: 12',
      "pattern: ['^.{0,60}$', 'Text může mít nejvýše 60 znaků']",
      '- { label: "Malování na obličej", value: "oblicej" }',
      'description: >-\n    Volný text: i s dvojtečkou # a mřížkou.',
    ];
    for (const line of good) assert.deepEqual(lintYaml(`a:\n  ${line}\n`), [], line);
  });

  test('texty s dvojtečkou se načtou celé', () => {
    const files = parseYaml(YML).collections[0].files;
    const field = (file, name, sub) => {
      const f = files.find((x) => x.name === file).fields.find((x) => x.name === name);
      return sub ? f.fields.find((x) => x.name === sub) : f;
    };
    assert.match(field('sluzby', 'polozky', 'fotka').hint, /velká karta: fotka celá .* souhlasem rodičů\.$/);
    assert.match(field('provozovatel', 'zapis').hint, /živnostenský úřad: Městský úřad Velké Meziříčí\.“$/);
    assert.equal(field('nastaveni', 'facebook_text').default, 'Sledujte fotky a novinky z mých akcí na Facebooku');
  });
});

describe('administrace (config.yml) odpovídá kontrole buildu (SCHEMA)', () => {
  const cfg = parseYaml(YML);
  const files = cfg.collections[0].files;

  test('každý soubor obsahu má v administraci stejná pole', () => {
    assert.deepEqual(files.map((f) => f.file).sort(), Object.keys(SCHEMA).map((f) => `content/${f}`).sort());
  });

  test('pojistka zveřejnění zná přesně stránky a soubory z administrace', () => {
    const t = {};
    vm.runInNewContext(readFileSync(path.join(ROOT, 'static', 'admin', 'publish-guard.js'), 'utf8'), {
      window: { __publishGuardTest: t, console: { error: () => {} } },
    });
    assert.equal(cfg.collections.length, 1);
    const collection = cfg.collections[0].name;
    assert.deepEqual(Object.keys(t.entryFiles), [collection]);
    assert.deepEqual(
      Object.entries(t.entryFiles[collection]).sort(),
      files.map((f) => [f.name, f.file]).sort(),
    );
  });

  function checkFields(schemaFields, cmsFields, where) {
    assert.ok(Array.isArray(cmsFields), `${where}: chybí pole`);
    assert.deepEqual(cmsFields.map((f) => f.name).sort(), Object.keys(schemaFields).sort(), `${where}: názvy polí`);
    for (const cf of cmsFields) checkField(schemaFields[cf.name], cf, `${where}.${cf.name}`);
  }

  function checkField(spec, cf, where) {
    if (spec.required) assert.equal(cf.required ?? true, true, `${where}: build pole vyžaduje, administrace také musí`);
    switch (spec.kind) {
      case 'list':
        assert.equal(cf.widget, 'list', where);
        assert.ok(typeof cf.max === 'number' && cf.max <= spec.max, `${where}: max ${cf.max} > ${spec.max}`);
        if (spec.min > 0) assert.ok((cf.min ?? 0) >= spec.min, `${where}: min`);
        if (spec.of.kind === 'object') checkFields(spec.of.fields, cf.fields, where);
        else checkField(spec.of, cf.field, `${where}[]`);
        return;
      case 'line':
      case 'text': {
        assert.equal(cf.widget, spec.kind === 'text' ? 'text' : 'string', where);
        assert.ok(Array.isArray(cf.pattern) && cf.pattern.length === 2, `${where}: chybí pattern s délkou`);
        const re = new RegExp(cf.pattern[0]); // Decap uses no flags
        assert.ok(!re.test('x'.repeat(spec.max + 1)), `${where}: administrace pustí ${spec.max + 1} znaků`);
        assert.ok(re.test('x'.repeat(spec.max)), `${where}: administrace nepustí ${spec.max} znaků`);
        if (spec.kind === 'text') assert.ok(re.test('a\nb'), `${where}: víceřádkový text`);
        return;
      }
      case 'enum':
        assert.equal(cf.widget, 'select', where);
        assert.deepEqual(cf.options.map((o) => /value: "([^"]+)"/.exec(o)[1]).sort(), [...IKONY].sort(), where);
        return;
      case 'photo':
        assert.equal(cf.widget, 'image', where);
        assert.equal(cf.choose_url, false, where);
        return;
      case 'ico':
        assert.equal(cf.widget, 'string', where);
        assert.ok(Array.isArray(cf.pattern), `${where}: chybí pattern`);
        assert.equal(cf.pattern[0], '^\\d{8}$', `${where}: IČO = 8 číslic`);
        return;
      case 'phone':
      case 'email':
      case 'facebook':
        assert.equal(cf.widget, 'string', where);
        assert.ok(Array.isArray(cf.pattern), `${where}: chybí pattern`);
        return;
      default:
        assert.fail(`${where}: neznámý druh pole ${spec.kind}`);
    }
  }

  for (const f of files) {
    const fileName = f.file.replace('content/', '');
    test(`pole a limity: ${fileName}`, () => checkFields(SCHEMA[fileName].fields, f.fields, fileName));
  }

  const patternOf = (file, name) => new RegExp(files.find((f) => f.file === `content/${file}`).fields.find((x) => x.name === name).pattern[0]);

  test('co administrace přijme jako e-mail, telefon a Facebook, přijme i build', () => {
    const samples = {
      email: ['ivona@seznam.cz', 'a.b+c@x.cz', '.jana@seznam.cz', 'jana.@x.cz', 'a..b@c.cz', `${'a'.repeat(64)}@x.cz`, `a@${'b'.repeat(250)}.cz`,
        'spy%40evil.cz%2Civona@seznam.cz', 'a,b@seznam.cz', 'a?cc=x@seznam.cz', 'a&b@seznam.cz', 'a@b-.cz', 'a@-b.cz'],
      telefon: ['+420 739 039 559', '739039559', '+420739039559', '739 039 559', '+420 000 000 000'],
      facebook: ['https://www.facebook.com/groups/698688478954254', 'https://www.facebook.com/share/g/1AbC/', 'https://www.facebook.com/zabava?mibextid=x',
        'https://www.facebook.com/profile.php?id=123', 'https://www.facebook.com/profile.php', 'https://www.facebook.com/l.php?u=x',
        'https://www.facebook.com/dialog/feed', 'https://www.facebook.com/' + 'x'.repeat(280), 'https://www.facebook.com/a/../l.php'],
    };
    const fileOf = { email: 'kontakt.json', telefon: 'kontakt.json', facebook: 'nastaveni.json' };
    for (const [field, values] of Object.entries(samples)) {
      const re = patternOf(fileOf[field], field);
      for (const v of values) {
        if (re.test(v)) assert.ok(buildAccepts(fileOf[field], field, v), `${field}: administrace přijme „${v.slice(0, 50)}“, build ne`);
      }
    }
    assert.ok(!patternOf('kontakt.json', 'email').test('spy%40evil.cz%2Civona@seznam.cz'));
  });

  // normalizeFacebook (build) decodes the path, compares case-insensitively and refuses "/",
  // /vN.N/, invalid %-encoding and more. The CMS pattern must refuse at least all of that.
  test('Facebook: co build odmítne (zakázané cesty, %-kódování, velká písmena), odmítne i administrace', () => {
    const re = patternOf('nastaveni.json', 'facebook');
    const fb = 'https://www.facebook.com/';
    const refused = ['l.php?u=x', 'L.PHP?u=x', 'Lm.php', 'LOGIN.php', 'Sharer.php?u=x', 'sharer/sharer.php', 'Sharer/x', 'DIALOG/feed',
      'v2.0/dialog/feed', 'V19.0/x', 'v3', 'Flx/warn/?u=x', 'PROFILE.PHP', 'Profile.php?id=', 'profile.php?id=' + '1'.repeat(21),
      'profile.php?ID=123', 'profile.php#x', '?x=1', '#x', '?', '%6c.php?u=x', '%6C%2Ephp', '%2e%2e/l.php', 'a/%2E%2E/l.php',
      'a%2F..%2Fl.php', 'a%2f%2e%2e%2fl.php', '%5cl.php', '%ZZ', 'abc%', 'abc%C3', '%C3%28', '%FF', '%C0%AF', '%ED%A0%80', 'a/../l.php', '.', '..', '..?x=1', '.#x'];
    for (const v of refused) {
      assert.ok(!buildAccepts('nastaveni.json', 'facebook', fb + v), `build má odmítnout „${v}“`);
      assert.ok(!re.test(fb + v), `administrace má odmítnout „${v}“`);
    }
    const accepted = ['zabavadeti', 'ZabavaProDeti', 'groups/698688478954254', 'share/g/1AbC/', 'profile.php?id=100063', 'Profile.php?id=1&sk=photos',
      'p/Z%C3%A1bava-pro-d%C4%9Bti-100063/', 'zabava?mibextid=x', 'loginx', 'dialogy', 'v2x', 'emoji%F0%9F%98%80'];
    for (const v of accepted) {
      assert.ok(re.test(fb + v), `administrace má přijmout „${v}“`);
      assert.ok(buildAccepts('nastaveni.json', 'facebook', fb + v), `build má přijmout „${v}“`);
    }
  });

  test('Facebook: náhodné adresy – co přijme administrace, přijme i build', () => {
    const re = patternOf('nastaveni.json', 'facebook');
    const pieces = ['l.php', 'L.PHP', 'lm.php', 'login', 'sharer', 'Sharer', 'dialog', 'flx', 'v2.0', 'V12', 'profile.php', 'PROFILE.PHP',
      'profile_redirect.php', '?id=', '123', '1'.repeat(21), '&', '#', '/', '.', '..', '%2e', '%2E', '%2f', '%6c', '%5C', '%C3%A1', '%C3',
      '%E2%82%AC', '%F0%9F%98%80', '%FF', '%ZZ', '%', 'a', 'zabava', 'groups', 'p', '-', '?', '=', '+', '~', '_', 'x'];
    let seed = 12345;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let accepted = 0;
    for (let k = 0; k < 20000; k++) {
      let v = 'https://www.facebook.com/';
      for (let j = 1 + rnd(6); j > 0; j--) v += pieces[rnd(pieces.length)];
      if (!re.test(v)) continue;
      accepted++;
      assert.ok(buildAccepts('nastaveni.json', 'facebook', v), `administrace přijme „${v}“, build ne`);
    }
    assert.ok(accepted > 1000, `vzorek přijatých adres je příliš malý (${accepted})`);
  });

  // Rules config.yml cannot express (check digit of IČO, a photo needs a description, references
  // need the note about their origin) are checked on save by the publish guard (preSave) – the
  // same way as by the build.
  test('pravidla mezi poli: pojistka při uložení (preSave) rozhoduje stejně jako build', () => {
    const t = {};
    vm.runInNewContext(readFileSync(path.join(ROOT, 'static', 'admin', 'publish-guard.js'), 'utf8'), {
      window: { __publishGuardTest: t, console: { error: () => {} } },
    });
    const icoPattern = patternOf('provozovatel.json', 'ico');
    for (const ico of ['00718131', '00718132', '27082440', '27082441', '12345678', '00000000', '1234567', '0071813a']) {
      const adminAccepts = icoPattern.test(ico) && t.checkEntryData('provozovatel', { ico }).length === 0;
      assert.equal(adminAccepts, buildAccepts('provozovatel.json', 'ico', ico), ico);
      if (icoPattern.test(ico)) assert.equal(adminAccepts, isValidIco(ico), ico);
    }
    const sluzby = (popis) => {
      const d = structuredClone(RAW['sluzby.json']);
      d.polozky[0].fotka = [...IMAGES.keys()].map((n) => `/uploads/${n}`)[0];
      d.polozky[0].fotka_popis = popis;
      return d;
    };
    for (const popis of ['', '   ', 'Fotka z akce']) {
      const d = structuredClone(RAW);
      d['sluzby.json'] = sluzby(popis);
      assert.equal(t.checkEntryData('sluzby', d['sluzby.json']).length === 0, validateContent(d, IMAGES).errors.length === 0, `popis „${popis}“`);
    }
    for (const [polozky, overeni] of [[RAW['reference.json'].polozky, ''], [[], ''], [RAW['reference.json'].polozky, 'Text']]) {
      const d = structuredClone(RAW);
      Object.assign(d['reference.json'], { polozky, overeni });
      assert.equal(t.checkEntryData('reference', d['reference.json']).length === 0, validateContent(d, IMAGES).errors.length === 0, `reference ${polozky.length}/${overeni}`);
    }
  });
});
