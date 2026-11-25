# Zábava pro děti – Měřín a okolí

Zdrojový kód webu **https://www.zabavadeti.cz** (animátorka Ivona Mutlová).

> **Autorská práva:** © 2026 Ivona Mutlová a Lucie K. Všechna práva vyhrazena.
> Repozitář je veřejný jen kvůli bezpečnému nasazení a správě webu. Texty, fotografie,
> grafika ani kód se nesmí kopírovat ani dále používat bez písemného svolení.
> Výjimky: písma Baloo 2 a Plus Jakarta Sans (SIL Open Font License, `docs/licence-pisem/`)
> a Decap CMS (MIT, `static/admin/LICENSE-decap-cms.txt`) mají vlastní licence.

Statický web bez serveru a databáze: texty jsou v `content/*.json`, build z nich
vyrobí hotové HTML do složky `dist/` (úvodní stránka, `/ochrana-soukromi/` a 404) a Cloudflare Pages ho zveřejní. Obsah se
upravuje přes administraci na `/admin/` (Decap CMS). Návod pro lidi je v
`NAVOD.md`, bezpečnost v `docs/BEZPECNOST.md`.

## Požadavky

- Node.js 22 nebo novější (Cloudflare Pages používá verzi ze souboru `.node-version`, tj. 22;
  kód nepoužívá nic, co by bylo jen v novějších verzích – testy občas pusťte i na Node 22).
- Žádné npm balíčky – build i testy používají jen vestavěné moduly Node.js,
  `npm install` není potřeba (v Cloudflare je nastavené `SKIP_DEPENDENCY_INSTALL=1`; build i test
  hlídají, že `package.json` nemá závislosti ani instalační skripty a že v kořeni není `.npmrc`,
  zámek balíčků ani `wrangler.*`).

## Příkazy

| Příkaz | Co dělá |
| --- | --- |
| `node build.mjs` (`npm run build`) | Zkontroluje obsah a fotky a sestaví web do `dist/`. Při chybě skončí nenulovým kódem a česky vypíše, který soubor a které pole opravit. |
| `node scripts/check.mjs` (`npm run check`) | Samostatná kontrola fotek ve `static/uploads/` (skutečný typ podle obsahu, max. 5 MB a 40 Mpx, bezpečný název, varování o GPS), povolených souborů v kořeni repozitáře, ve `static/` a `functions/`, `package.json` bez závislostí, symbolických odkazů v gitu a hotového webu v `dist/` (žádné inline skripty/styly, `on*` atributy ani cizí zdroje; skripty jen ze `/assets/`, v administraci ze `/admin/`). |
| `node scripts/serve.mjs` (`npm run serve`) | Lokální náhled `dist/` na http://127.0.0.1:8787 (port jde změnit proměnnou `PORT`). Uplatňuje hlavičky z `dist/_headers` stejně jako Cloudflare. |
| `npm run dev` | Build a hned náhled. |
| `npm test` | Testy (`node --test tests/*.test.mjs`). Pracují s dočasnou kopií dat, skutečný obsah nemění. |

Lokální server neumí Pages Functions – adresy `/api/*` (přihlášení do
administrace přes GitHub) vrací 501. Přihlašovací funkce jde lokálně spustit
přes `npx wrangler pages dev dist` (wrangler není závislostí projektu). Proměnné
pro to patří jen do `.dev.vars` (je v `.gitignore`), nikdy produkční secret –
použijte zvláštní testovací GitHub OAuth App s callbackem na localhost. Povinné je
i `ALLOWED_GITHUB_USERS`; ověření Cloudflare Access a seznam povolených adres se na
`http://localhost` a `http://127.0.0.1` nevyžadují. Na produkci (`config.yml`,
`base_url`) se lokálně přihlásit nejde.

## Struktura

```
content/          texty webu (JSON, prostý text, schéma viz src/validate.mjs);
                  provozovatel.json = povinné údaje provozovatele (patička, ochrana soukromí)
static/           soubory kopírované do webu beze změny (jen povolený seznam, viz check.mjs)
  uploads/        fotky nahrané přes administraci (/uploads/…)
  admin/          administrace Decap CMS (samostatná část) + publish-guard.js (pojistka zveřejnění,
                  spouští administraci) a manual-init.js (Decap se nespustí bez pojistky)
  .well-known/    security.txt
src/              šablony (render.mjs), styly (styles.css), ikony (icons.mjs), písma a konfety (assets/),
                  přepínač vzhledu (theme.js), tlačítko Kopírovat (copy.js),
                  escapování (escape.mjs), validace obsahu (validate.mjs),
                  bezpečné čtení souborů bez symbolických odkazů (safe-fs.mjs)
headers/          bezpečnostní HTTP hlavičky: site.txt (web) + admin.txt (administrace)
functions/, lib/  OAuth proxy pro přihlášení do administrace (Cloudflare Pages Functions);
                  lib/access.js ověřuje token Cloudflare Access
.github/          CODEOWNERS (schvalovat smí jen správkyně)
scripts/          check.mjs (kontroly), serve.mjs (lokální náhled), code-hash.mjs (otisk kódu CODE_HASH)
docs/             BEZPECNOST.md (model hrozeb), VENDOR.md (Decap CMS a písma), licence-pisem/
.claude/          launch.json (lokální náhled pro Clauda, port 8787)
tests/            testy (node:test)
build.mjs         build
```

## Jak funguje build

1. Zkontroluje fotky ve `static/uploads/` (typ podle magických bajtů, ne podle
   přípony; SVG, HTML a cokoli jiného odmítne; max. 5 MB, 12 000 px na stranu a
   40 Mpx; názvy vyhrazené ve Windows odmítne; upozorní na GPS polohu v EXIF, XMP
   a textových blocích PNG).
2. Načte a zvaliduje `content/*.json` (bez symbolických odkazů, max. 1 MB) – typy,
   povinná pole, délky, povolené ikony, telefon, e-mail, odkaz na Facebook, IČO (8 číslic
   a kontrolní číslice), cesty k fotkám (soubor musí existovat), pravidla mezi poli (fotka služby
   potřebuje popis, reference potřebují text o svém původu), neviditelné znaky Unicode. Neznámá pole jsou
   chyba (překlep v názvu pole).
3. Zkontroluje, že kořen repozitáře, `static/` a `functions/` obsahují jen povolené soubory
   (žádné `wrangler.toml`/`.json`/`.jsonc`, `.npmrc`, zámky balíčků, `_worker.js`, `_redirects`,
   `_routes.json`, cizí HTML ani nové funkce; v kořeni s gitem rozhoduje seznam souborů v gitu,
   takže místní `.dev.vars` nevadí), že `package.json` nemá závislosti ani instalační skripty
   a že v gitu nejsou symbolické odkazy ani submoduly.
4. Smaže `dist/`, zkopíruje `static/` (symbolické odkazy odmítne), vygeneruje
   `index.html`, `ochrana-soukromi/index.html` (z šablony a `content/provozovatel.json`),
   `404.html`, `robots.txt`, `sitemap.xml`, CSS s otiskem obsahu v názvu (`/assets/styles.<hash>.css`), přepínač vzhledu (`/assets/theme.<hash>.js`), tlačítko Kopírovat (`/assets/copy.<hash>.js`),
   designové soubory ze `src/assets/` (písma a konfety, viz „Vzhled a písma“)
   a `_headers` (= `headers/site.txt`, pravidla dlouhé cache přesně pro všechny soubory
   s otiskem, `headers/admin.txt`).
5. Zkontroluje výstup: žádné řídicí soubory Cloudflare Pages, HTML/SVG/JS jen tam,
   kam je dává build; SVG soubory bez skriptů, `on*`, `<foreignObject>`, stylů a odkazů ven; v HTML žádné inline `<script>` (kromě JSON-LD), `<style>`,
   atributy `style=` a `on*=`, `javascript:` odkazy, externí zdroje ani `mailto:`
   s více adresami.

Veškerý obsah se v šablonách escapuje (`& < > " '`), JSON-LD je serializovaný
s `<` → `\u003c`. Web nepoužívá cookies, analytiku ani nic z cizích serverů
(ani písma). Písma načítá jen z vlastní domény a jediný JavaScript je malý
přepínač vzhledu (viz níže), takže CSP může být velmi přísná (`default-src 'none'`,
`script-src 'self'`, `style-src 'self'`, `img-src 'self'`, `font-src 'self'`).

## Vzhled a písma

- Moderní „produktový“ vzhled v dětském duchu: hluboká námořnická plocha (tmavý motiv,
  hlavní vzhled) nebo čistě světlá, v obou barevné rozostřené záře v pozadí
  (`radial-gradient`), velká zaoblená písma nadpisů, poslední slovo nadpisu na barevném
  zvýrazňovacím obdélníku (`highlight()` v `src/render.mjs`, třída `hl`), pilulková tlačítka
  (plné a obrysové), „bento“ mřížka zaoblených barevných dlaždic a lepivá hlavička s jediným
  výrazným tlačítkem s telefonním číslem.
- Každá sekce má svou barvu (`SECTION_COLORS` v `src/render.mjs`): Služby žlutá, O mně
  růžová, Reference modrá, Kontakt zelená. V barvě sekce je vyplněný štítek nad nadpisem,
  zvýrazněné slovo nadpisu, záře v pozadí sekce a podtržení položky menu po najetí. Sekce se
  střídají v odstínu pozadí (`section-band`). Zvýraznění (`hl`) je jen v hlavním nadpisu
  a v nadpisech sekcí.
- Texty prochází českou typografií (`czechTypography()` v `src/escape.mjs`): nedělitelná
  mezera za jednopísmennými předložkami a spojkami, za zkratkami (§, č., čl., odst., písm.)
  a mezi skupinami číslic (telefon, PSČ) – jen v textu, nikdy v atributech ani v JSON-LD.
- Sytá hravá paleta: růžová, sluníčková, elektrická modrá, svěží zelená, oranžová – v obou
  motivech stejná. Dlaždice služeb, štítky (pilulky), ikony a reference mají vždy jeden tvar
  a liší se jen velikostí a barvou akcentu (obrys v barvě akcentu a tónované pozadí) (třídy `acc-pink`, `acc-sun`, `acc-blue`,
  `acc-green`, `acc-orange`, render je střídá podle pořadí).
- Ikony služeb (`src/icons.mjs`) jsou barevné dlaždice s plnou kresbou: dlaždice má barvu
  akcentu karty, tvary jsou bílé, detaily tmavé a druhý akcent; barvy jdou jen přes třídy
  a tokeny. Malé ikony rozhraní jsou obrysové v `currentColor`.
- Služby: každá dlaždice je celá odkaz na Kontakt („… – domluvit termín“, bez dalších
  ovládacích prvků uvnitř); po najetí myší (jen `@media (hover: hover)`) nebo při fokusu
  z klávesnice se vyplní svou sytou barvou s tmavým textem. Služba s fotkou je velká dlaždice
  (2 × 2 buňky, na tabletu přes celou šířku) a jde první; poslední karta se roztáhne přes zbytek řádku, aby
  mřížka neměla na konci díru (`lastSpan()` spočítá třídy `wN-K` pro mřížku o 2, 3 a 4
  sloupcích). Na mobilu je z karet kompaktní seznam.
- Fotky jsou vždy celé (přirozený poměr stran, žádný ořez) a nic přes ně neleží – žádný
  text ani tmavý přechod. U služby je text vedle fotky (na mobilu pod ní); úvodní fotka leží
  na barevné ploše a slogan je pod ní.
- V hlavičce jsou vedle přepínače vzhledu rychlé kontakty: telefon (`tel:`) a Facebook
  (odkaz z `content/nastaveni.json`, `rel="noopener noreferrer"`). Na počítači je telefon
  jediné výrazné tlačítko s číslem, na mobilu kulaté tlačítko 44 × 44 px vedle menu.
- Tlačítka v úvodu a v Kontaktu ukazují skutečné číslo a e-mail (ne každý počítač umí otevřít
  `tel:`/`mailto:`). V Kontaktu je vedle nich tlačítko „Kopírovat“ (`src/copy.js`, build ho
  otiskne do `/assets/copy.<hash>.js`, `defer`): bez JavaScriptu nebo schránky zůstane skryté
  (`hidden`), potvrzení „Zkopírováno“ ohlásí oblast `role="status"`.
- Designové soubory jsou ve `src/assets/` (jen `.svg` a `.woff2`, max. 256 kB,
  název malými písmeny): `konfety.svg` (střídmá dekorace) a čtyři soubory písem. Build
  každý soubor zkontroluje (SVG jen jako obyčejná kresba ze seznamu povolených prvků přes `checkSvg`; samostatně otevřené SVG má v `_headers` sandbox CSP, písmo podle
  prvních bajtů `wOFF`/`wOF2` přes `checkFontFile`), přidá do názvu otisk obsahu
  (`/assets/konfety.<hash>.svg`) a přepíše odkazy v CSS (`rewriteCssUrls`). V CSS smí být
  jen `url("/assets/<název>")` – žádné `data:`, cizí adresy, `@import` ani `image-set()`.
  Testy hlídají, že každý soubor ze `src/assets/` i každá třída a ikona se opravdu používá.
- **Písma** (licence SIL Open Font License, texty licencí v `docs/licence-pisem/`, původ
  a otisky v `docs/VENDOR.md`) jsou uložená přímo na webu – prohlížeč je stahuje jen
  z vlastní domény (`font-src 'self'`), nic z Google Fonts ani jiného cizího serveru:
  - **Baloo 2** (`baloo-latin.woff2`, `baloo-latin-ext.woff2`) – zaoblené písmo nadpisů
    a loga. Obě části se přednačítají (`<link rel="preload" as="font" crossorigin>`,
    seznam `PRELOAD_FONTS` v `build.mjs`), aby velký nadpis po načtení „neposkočil“.
  - **Plus Jakarta Sans** (`jakarta-latin.woff2`, `jakarta-latin-ext.woff2`) – text.

  Obě rodiny jsou variabilní (řezy 400–800 v jednom souboru) a rozdělené na část
  `latin` a `latin-ext` (české znaky jako ě, š, č, ř, ž, ů); `unicode-range` zajistí, že
  prohlížeč stáhne jen to, co stránka potřebuje. Všechna písma mají `font-display: swap`.

## Světlý a tmavý vzhled

- Výchozí vzhled se řídí nastavením systému (Windows, telefon) přes
  `prefers-color-scheme` – funguje i bez JavaScriptu.
- V hlavičce je tlačítko, které cykluje **podle systému → opačný motiv, než
  má systém → motiv systému → podle systému** (při světlém systému tedy
  podle systému → tmavý → světlý, při tmavém podle systému → světlý → tmavý),
  takže první klepnutí vždy viditelně změní vzhled. Po návratu tlačítkem Zpět
  (bfcache) si stránka volbu načte znovu.
  Volba se pamatuje v `localStorage` pod klíčem `zabavadeti-vzhled`
  (`light`/`dark`; „podle systému“ = klíč smazaný) a platí pro všechny stránky
  včetně 404. Bez JavaScriptu je tlačítko skryté.
- Skript `src/theme.js` build otiskne do `/assets/theme.<hash>.js` a vloží do
  `<head>` hned za CSS (bez `defer`), aby nastavil `data-theme` na `<html>`
  ještě před vykreslením. Žádný inline kód – `check.mjs` povolí na veřejných
  stránkách jen `<script src="/assets/…">`.
- Barvy jsou CSS proměnné v `src/styles.css`: světlé v `:root`, tmavé ve dvou
  stejných blocích (`@media screen and (prefers-color-scheme: dark)` a
  `:root[data-theme="dark"]`); tisk je vždy světlý. Novou barvu přidávejte jako
  token do všech tří míst, i když má v obou motivech stejnou hodnotu (jedinou
  výjimkou je `--print-ink`, který se používá jen při tisku). Test
  `tests/theme.test.mjs` hlídá, že mimo tokeny nejsou barvy zapsané natvrdo,
  že oba tmavé bloky jsou shodné a že v nich žádná barva z `:root` nechybí.
  Kontrasty obou palet splňují WCAG AA (text 4.5:1, ovládací prvky, obrysy a fokus 3:1;
  barevné plochy s textem – tlačítka, štítky sekcí, zvýraznění, vyplněné dlaždice – aspoň
  5.5:1, text na tónovaných kartách aspoň 7:1):
  test spočítá každou dvojici popředí/pozadí v obou motivech a hlídá, že každá nová
  barva textu nebo pozadí do kontrastního testu přibude. Syté akcenty jsou v obou motivech
  stejné a text i kresba na nich je vždy tmavá (`--on-accent`); hlavní tlačítko je malinové
  s bílým tučným textem. Test počítá kontrast i v průsvitné hlavičce nad bílým i černým obsahem. Okraj kulatých tlačítek (`--control-line`) má proti
  pozadí i kartám aspoň 3:1.
  Barva lišty prohlížeče (`THEME_COLORS` v `src/render.mjs`) musí odpovídat `--bg`.

## Nasazení (Cloudflare Pages)

Postup krok za krokem je v `NAVOD.md`, část B (projekt v Cloudflare B4, pojistka kódu B8).

- Build command: `node build.mjs`, po ověření nasazení varianta s ověřením otisku kódu
  (`CODE_HASH`, NAVOD.md krok B8); output directory: `dist`, kořen repozitáře jako root
  directory (kvůli složce `functions/`). Náhledová nasazení větví (Preview branch) vypnutá.
- Proměnné prostředí (Production): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (Secret),
  `ALLOWED_GITHUB_USERS` (teď jen `11Lucie` – web spravuje jen admin), `ACCESS_TEAM_DOMAIN`,
  `ACCESS_AUD` – všechny povinné, bez nich přihlášení nepustí nikoho; dále
  `SKIP_DEPENDENCY_INSTALL=1` (Production i Preview) a po zapnutí pojistky `CODE_HASH`.
  `ALLOWED_ORIGINS` ani `OAUTH_SCOPE` se nenastavují (výchozí `https://www.zabavadeti.cz`
  a `public_repo` jsou v `lib/oauth.js`).
- `CODE_HASH` se počítá (po `git fetch origin`) v Git Bash stejně jako v Build command, jen nad
  číslem commitu, který Lucie zkontrolovala (`git log <stará verze>..origin/main` – jen její
  commity a schválené návrhy; postup a pořadí v NAVOD.md B8), místo `HEAD`:

  ```
  git ls-tree -r -z --full-tree <commit> | LC_ALL=C grep -zvE '^100644 blob [0-9a-f]{40,64}[[:blank:]](content/[a-z0-9-]+[.]json|static/uploads/[a-z0-9][a-z0-9._-]*)$' | sha256sum | cut -c1-64
  ```

  Totéž spočítá `node scripts/code-hash.mjs <commit>` (odmítne commit s `wrangler.*` v kořeni);
  `tests/code-hash.test.mjs` hlídá, že oba výpočty dávají stejný výsledek, že se žádný soubor
  nevytratí kvůli mezeře či jinému znaku v názvu a že NAVOD obsahuje přesně tentýž Build command.
  Mění ho každá změna mimo `content/*.json` a `static/uploads/*` (obyčejné soubory s bezpečným
  názvem), i v dokumentaci – po každé údržbě ho je potřeba v Cloudflare přepsat a dát Retry deployment.
- GitHub OAuth App: jediná callback URL `https://www.zabavadeti.cz/api/callback`, bez wildcard
  matchingu a Device Flow, se zapnutým „Expire user access tokens“ (token platí 8 hodin;
  refresh token proxy zahodí, Decap ho neumí použít – po vypršení se uživatelka přihlásí znovu).
- Přesměrování `zabavadeti.cz` → `www.zabavadeti.cz` se nastavuje v Cloudflare
  (Redirect Rules), ne v tomto repozitáři.
