# Přibalený kód třetích stran: Decap CMS

Administrace webu (`/admin/`) běží na **Decap CMS**. Nenačítáme ho z cizího serveru (CDN),
ale máme jeho přesnou kopii přímo v repozitáři. Díky tomu víme, co přesně běží, a nikdo
nám ho nemůže potichu vyměnit.

## Co je přibaleno

| Soubor | Co to je |
|---|---|
| `static/admin/decap-cms.js` | minifikovaný balík `dist/decap-cms.js` z npm balíčku `decap-cms`, beze změny |
| `static/admin/decap-cms.js.LICENSE.txt` | licence knihoven uvnitř balíku (beze změny; odkazuje na něj komentář na 1. řádku `decap-cms.js`) |
| `static/admin/LICENSE-decap-cms.txt` | licence MIT samotného Decap CMS + kopie licencí knihoven |
| `static/admin/index.html`, `static/admin/config.yml` | naše vlastní soubory (stránka administrace a nastavení) |
| `static/admin/manual-init.js` | náš soubor, jediný řádek `window.CMS_MANUAL_INIT = true;`. Načítá se **před** `decap-cms.js` (s vlastním SRI), aby se Decap nespustil sám a administraci spustila až pojistka. |
| `static/admin/publish-guard.js` | naše vlastní pojistka zveřejnění (není součást Decapu, popis v `docs/BEZPECNOST.md`, oddíl „Pojistka zveřejnění“): pamatuje si commit, který správkyně uložila (`postSave`), před „Publish“ přes API GitHubu ověří, že se návrh od té doby nezměnil a mění jen soubor zveřejňované stránky a nové fotky (`prePublish`), a pustí jen sloučení přesně ověřeného commitu (obal `window.fetch`). Nakonec zavolá `CMS.init()`. Načítá se za `decap-cms.js` s vlastním SRI v `index.html`. |

| Údaj | Hodnota |
|---|---|
| Balíček | `decap-cms` (npm) |
| Verze | **3.17.3** |
| Datum vydání na npm | 2026-10-26 10:48:35 UTC |
| Tarball | `https://registry.npmjs.org/decap-cms/-/decap-cms-3.17.3.tgz` |
| Integrita tarballu (npm `dist.integrity`) | `sha512-aoNAV1throw76ieMmCVe5qb3EbhbbFdXwG+fTupQqvKVwJYnJVQiFdAwvWeP9+H5prNeXS6mrVbW9cxGD/m6tg==` – ověřeno proti staženému souboru (shodné) |
| SHA-1 tarballu (npm `shasum`) | `f8f37a82d5a86d674cd45e89a980086b3de3ee05` – shodné |
| Provenance | balíček má na npm podpisy registru a SLSA provenance (`npm view decap-cms@3.17.3 dist`) |
| SHA-256 `static/admin/decap-cms.js` | `b96249532ab219c5a78b57ed4ac05eb92e6446819ac217ced6f81318a0d98e70` |
| SRI (v `index.html`) | `sha384-RWRzuHfiZSWCt3nEvG7B0v3cMgM1C2UuJmgBSL92GQh4uXmNSkbcthql/mNBqvjr` |
| Velikost | 4 858 826 bajtů |

**Proč 3.17.3:** nejnovější stabilní verze (bez `-beta`/`-rc`) vydaná nejpozději 2026-11-11,
tj. aspoň dva týdny stará v den výběru (2026-11-25). Novější 3.18.0 (2026-11-18) byla v tu chvíli
příliš čerstvá – čekáme, jestli se v ní neobjeví chyba nebo podvržený kód.

Skripty balíčku se nikdy nespouštěly: použili jsme jen `npm pack` (stáhne archiv, nic nespouští)
a ruční rozbalení v dočasné složce mimo projekt.

### Co jsme záměrně NEpřibalili

Balík umí za běhu dotahovat další soubory („chunky“) ze stejné složky:

- `NNNN.decap-cms.js` se zvýrazňováním syntaxe CodeMirror – potřebuje je jen widget `code`
  (a editor Markdownu). Ty v administraci nepoužíváme.
- `2598/4928/7405.decap-cms.js` + dva soubory `.wasm` – kodér formátu WebP (jSquash). Použil by se,
  jen kdyby `media_processing` převádělo obrázky do WebP. My převádíme do JPEG (prohlížeč to umí
  sám přes `canvas`), takže WebAssembly ani tyto soubory nejsou potřeba a CSP nemusí povolovat
  `'wasm-unsafe-eval'`.
- `*.map` (zdrojové mapy) – jen pro ladění; poslední řádek balíku na ně odkazuje, prohlížeč
  je hledá pouze při otevřených vývojářských nástrojích (404 nevadí).

Kdyby se v budoucnu do `config.yml` přidal widget `code`/`markdown` nebo WebP převod, je nutné
chunky dobalit (a upravit CSP) – jinak administrace nahlásí chybu načítání.

## Kontrola balíku: externí adresy a nebezpečné konstrukce

Balík jsme prohledali (`grep`) na adresy, které by mohl za běhu kontaktovat:

| Adresa | K čemu | Potřebujeme? | V CSP |
|---|---|---|---|
| `https://api.github.com` | REST/GraphQL API GitHubu – čtení a ukládání obsahu, uživatel | ano | `connect-src` |
| `https://avatars.githubusercontent.com` | profilová fotka přihlášeného uživatele | ano (kosmetika) | `img-src` |
| `https://www.githubstatus.com/api/v2/components.json` | kontrola, zda GitHub nemá výpadek | ne – blokováno; Decap chybu zachytí a pokračuje (v konzoli bude varování „Failed getting GitHub status“) | – |
| `turbo.decapcms.org`, `sb.decapcms.org` | placená služba „Decap Turbo“ | ne (jen při `turbo_site_id` v konfiguraci) | – |
| `api.netlify.com` | výchozí OAuth server Netlify | ne – máme vlastní `base_url` | – |
| `claude://claude.ai/...` | tlačítko „AI pomocník“ (jen přesměrování, neodesílá data samo) | ne | – |
| GitLab, Bitbucket, Gitea, Azure, Cloudinary, Uploadcare, S3, OpenStreetMap, Pusher | jiné backendy a knihovny médií / widget mapy | ne | – |
| `raw.githubusercontent.com` | jen identifikátor JSON schématu v knihovně AJV, nic se nestahuje | ne | – |

Fonty: balík žádné písmo nestahuje (`@font-face` ani Google Fonts v něm nejsou) – používá písma systému.
Telemetrie ani analytika v balíku nejsou.

Konstrukce vyžadující výjimky v CSP:

- `new Function(...)` – knihovna **AJV** jím za běhu kompiluje validační schéma konfigurace
  (Decap ověřuje `config.yml` při každém startu). Bez `'unsafe-eval'` start administrace selže.
  Ostatní výskyty (`eval("require(...)")`, `new Function("return this")`) jsou v `try/catch`
  nebo v nepoužitých větvích. ⇒ `script-src 'self' 'unsafe-eval'` – **jen pro `/admin/*`**,
  veřejný web tuto výjimku nemá. Inline skripty nejsou povolené, takže útočník by stejně
  musel nejdřív dostat vlastní skript na stránku.
- Emotion (CSS-in-JS) vkládá styly do `<style>` ⇒ `style-src 'self' 'unsafe-inline'`.
- Náhledy obrázků a nahrávání: `URL.createObjectURL` a `fetch(blob:...)` při převodu na base64
  před nahráním ⇒ `img-src … blob: data:` a `connect-src … blob:`.
- Náhledový panel editoru je `<iframe srcdoc>`. Ten se do `frame-src` nepočítá, a navíc ho
  v `config.yml` vypínáme (`editor: preview: false`); `frame-src 'self'` je jen pojistka.
- Web Workery ani audio/video balík nepoužívá ⇒ `worker-src`/`media-src` zůstávají `'none'`
  (z `default-src`).

Čeština: balík obsahuje lokalizaci `cs` (např. „Přihlásit pomocí GitHub“) ⇒ `locale: cs`.

## CSP administrace (`headers/admin.txt`)

```
default-src 'none';
script-src 'self' 'unsafe-eval';            # balík ze stejné domény; eval kvůli AJV (viz výše)
style-src 'self' 'unsafe-inline';           # CSS-in-JS
img-src 'self' data: blob: https://avatars.githubusercontent.com;
connect-src 'self' blob: https://api.github.com;   # 'self' = /admin/config.yml
frame-src 'self';                           # pojistka pro náhledový iframe
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Pravidla v `headers/admin.txt` se v buildu připojují **za** `headers/site.txt`. Cloudflare Pages
hlavičky ze všech pasujících pravidel slučuje (dvě CSP by se sečetly a administrace by nefungovala),
proto pravidlo `/admin/*` nejdřív odpojí zděděné hlavičky (`! Content-Security-Policy`,
`! Cross-Origin-Opener-Policy`, `! Cross-Origin-Embedder-Policy`, …) a pak nastaví vlastní.
`Cross-Origin-Embedder-Policy` se odpojuje, protože `require-corp` z veřejného webu by zablokovalo
profilové fotky z GitHubu.

`index.html` a `config.yml` mají `Cache-Control: no-store`; `decap-cms.js` má `no-cache`
(prohlížeč si ho nechá, ale vždy ověří, že se nezměnil). To je důležité kvůli SRI: kdyby
prohlížeč použil starý balík s novým `index.html`, kontrola integrity by ho zablokovala.

Pozor: **`_headers` se neuplatňují na odpovědi Pages Functions** (`/api/auth`, `/api/callback`).
Ty si všechny bezpečnostní hlavičky nastavují samy v `lib/oauth.js`.

## Přihlašovací okno a Cross-Origin-Opener-Policy (COOP)

Průběh přihlášení:

1. `/admin/` otevře vyskakovací okno na `/api/auth` (stejná doména).
2. `/api/auth` přesměruje okno na `github.com` (cizí doména), uživatel povolí přístup.
3. GitHub přesměruje okno zpět na `/api/callback` (opět naše doména).
4. Stránka z `/api/callback` pošle přes `window.opener.postMessage` token zpět do `/admin/`.

Krok 4 potřebuje, aby okno po návratu z GitHubu pořád mělo `window.opener`. COOP rozhoduje
o „skupině oken“: když stránka se `same-origin` otevře okno a to přejde na cizí doménu
(github.com), prohlížeč okno od otvírající stránky **trvale odpojí** – ani po návratu na naši
doménu už `window.opener` nebude. Proto:

- `/admin/*`: `Cross-Origin-Opener-Policy: same-origin-allow-popups` – administrace je chráněná
  před cizími okny, která by ji otevřela, ale okna, která otevře sama, si ponechá. Tuto hodnotu
  doporučují i poskytovatelé přihlašování přes vyskakovací okno.
- `/api/auth` i `/api/callback`: `Cross-Origin-Opener-Policy: unsafe-none` (nastaveno v kódu
  funkcí), aby okno zůstalo ve stejné skupině jako administrace.

Bezpečnost přesto drží: token se posílá jen s `targetOrigin` = přesně naše doména (nikdy `"*"`)
a jen jako odpověď na zprávu, jejíž `e.origin` je naše doména a `e.source` je `window.opener`.
Cizí stránka, která by si `/api/auth` otevřela sama, token nedostane. Ověřit v reálném prohlížeči
(viz níže).

## Aktualizace Decap CMS – postup

Dělejte v Git Bash, **v dočasné složce mimo projekt**, nikdy `npm install` v projektu.

```bash
# 0) Spustit v Git Bash ve složce projektu (cd do složky projektu) a zapamatovat si ji
P="$(git rev-parse --show-toplevel)"

# 1) Zjistit verze a vybrat nejnovější stabilní starou aspoň 14 dní
npm view decap-cms time --json
V=3.x.y                                  # vybraná verze

# 2) Stáhnout tarball (nic se nespouští) a ověřit integritu
T=$(mktemp -d) && cd "$T"
npm pack "decap-cms@$V" --ignore-scripts
npm view "decap-cms@$V" dist.integrity   # musí se shodovat s řádkem níže
echo "sha512-$(openssl dgst -sha512 -binary decap-cms-$V.tgz | base64 -w0)"

# 3) Rozbalit a zkontrolovat
mkdir x && tar -xzf "decap-cms-$V.tgz" -C x
ls x/package/dist | grep -v '\.map$'     # nové chunky? (viz "Co jsme NEpřibalili")
grep -oE 'https?://[a-zA-Z0-9.-]+' x/package/dist/decap-cms.js | sort | uniq -c | sort -rn | head -60
grep -c 'new Function' x/package/dist/decap-cms.js
grep -o 'media_processing' x/package/dist/decap-cms.js | head -1   # volba stále existuje?

# 4) Zkopírovat do projektu (P = složka projektu, nastavená v kroku 0)
cp x/package/dist/decap-cms.js "$P/static/admin/decap-cms.js"
cp x/package/dist/decap-cms.js.LICENSE.txt "$P/static/admin/decap-cms.js.LICENSE.txt"
#    a v LICENSE-decap-cms.txt nahradit část pod čarou novým decap-cms.js.LICENSE.txt + číslo verze

# 5) Nové otisky: SHA-256 do této tabulky, SRI do static/admin/index.html (atribut integrity)
sha256sum "$P/static/admin/decap-cms.js"
echo "sha384-$(openssl dgst -sha384 -binary "$P/static/admin/decap-cms.js" | base64 -w0)"

# 6) Pojistka zveřejnění musí v nové verzi dál fungovat: událost prePublish se volá před
#    sloučením a chyba z ní zveřejnění zastaví. Obě konstrukce musí v balíku zůstat:
grep -c 'registerEventListener' "$P/static/admin/decap-cms.js"      # aspoň 1
grep -o 'await this.invokePrePublishEvent(e),await this.implementation.publishUnpublishedEntry' "$P/static/admin/decap-cms.js" | head -1
grep -o 'storageKey="decap-cms-user"' "$P/static/admin/decap-cms.js" | head -1   # odkud pojistka čte token
#    Decap musí dál: respektovat CMS_MANUAL_INIT, volat postSave i v editorial workflow, slučovat
#    s parametrem sha a zapisovat větve přes REST (PATCH git/refs/heads/…, POST git/refs) globálním fetch.
#    Část z toho hlídá i test (tests/oauth.test.mjs); když se něco změní, upravit pojistku a testy.
grep -o 'window.CMS_MANUAL_INIT?console.log' "$P/static/admin/decap-cms.js" | head -1
grep -o 'await this.invokePostSaveEvent(l.get("entry"))' "$P/static/admin/decap-cms.js" | head -1
grep -o 'sha:e.head.sha,merge_method' "$P/static/admin/decap-cms.js" | head -1
grep -o 'git/refs/${e}/${encodeURIComponent(t)}`,{method:"PATCH"' "$P/static/admin/decap-cms.js" | head -1
grep -c 'return fetch(e,t)' "$P/static/admin/decap-cms.js"   # aspoň 1 (požadavky jdou přes globální fetch)

# 7) Testy (kontrolují i shodu SRI s balíkem a s pojistkou)
cd "$P" && node --test tests/
```

Když se změní `static/admin/publish-guard.js` nebo `static/admin/manual-init.js`, je potřeba
přepočítat i jejich SRI v `index.html`
(`openssl dgst -sha384 -binary static/admin/publish-guard.js | base64 -w0`); test to hlídá.

**Vyzkoušení nové verze** (náhledové nasazení ani tajné hodnoty v prostředí Preview kvůli tomu
**nezapínejte** – viz NAVOD, krok B4; přihlášení na náhledu stejně fungovat nemůže, protože
`config.yml` má `base_url` napevno `https://www.zabavadeti.cz` a přihlašovací proxy přijímá jen tuto adresu):

1. **Lokálně:** `node build.mjs` a `PORT=8801 node scripts/serve.mjs`. Administrace s dočasným
   backendem `test-repo` (změnu v `config.yml` **necommitovat**): načtení bez porušení CSP,
   formuláře, nahrání fotky – stejně jako v části „Co už je ověřené lokálně“. Server pak ukončit.
2. **Před sloučením** si v Cloudflare → **Deployments** poznamenat poslední dobré nasazení.
3. **Po nasazení na www** hned vyzkoušet přihlášení, uložení konceptu, nahrání fotky a zveřejnění
   neškodné změny (a ihned ji vrátit), případně koncept smazat.
4. Když něco selže: **Rollback** v Cloudflare a `git revert` v `main`.
5. Je-li zapnutý „zámek 4“ (otisk kódu v Build command, NAVOD B8): aktualizaci nahrát do `main`,
   Lucie zkontroluje nové commity v `origin/main` a nový otisk se spočítá z čísla zkontrolovaného
   commitu (NAVOD B8, body 1–5; výpočet i v README, „Nasazení“), Lucie ho zapíše
   do proměnné `CODE_HASH` a dá **Retry deployment**. Do té doby nasazení selže a na webu zůstane
   předchozí verze (bod 3 tedy až po přepsání otisku).

## Co už je ověřené lokálně (2026-11-25, Chromium, hlavičky z `headers/admin.txt`)

- **Pozor na YAML:** neuvozovaná hodnota s „: “ (např. nápověda „… velká karta: fotka …“) udělá
  z `config.yml` neplatný YAML a administrace ukáže jen „Error loading the CMS configuration“
  (ověřeno). Proto jsou všechny texty v `config.yml` v uvozovkách a `tests/config-sync.test.mjs`
  (`lintYaml`) každou neuvozovanou hodnotu s mezerou nebo zvláštním znakem odmítne. Po opravě
  ověřeno v prohlížeči: s backendem `github` se zobrazí „Přihlásit pomocí GitHub“ bez chyby
  v konzoli, s dočasným `test-repo` (jen v kopii mimo projekt) se otevře všech 7 částí včetně
  Provozovatele a položky služby; nápovědy s dvojtečkou jsou celé a vzor pro Facebook odmítne
  `https://www.facebook.com/%6c.php?u=x` a přijme `https://www.facebook.com/p/Z%C3%A1bava-…/`.
- Administrace se s touto CSP načte, `config.yml` projde vnitřní kontrolou Decapu, rozhraní je česky.
- Bez `'unsafe-eval'` se nenačte („EvalError … 'unsafe-eval' is not an allowed source“ z AJV) – výjimka je nutná.
- Formuláře všech šesti tehdejších částí se zobrazí; vzory pro telefon a e-mail hlásí česky chybu.
  (Část Provozovatel a pole Fotka služby, Text u odkazu na Facebook a Odkud reference pocházejí
  přibyly později – shodu jejich polí a limitů s buildem hlídá `tests/config-sync.test.mjs`,
  v prohlížeči je ověřit podle oddílu níže.)
- Nahrání `Fotka Ivony Černá 2024.PNG` (s backendem `test-repo`) vytvořilo `fotka-ivony-cerna-2024.jpg`
  a cestu `/uploads/fotka-ivony-cerna-2024.jpg`; žádné porušení CSP.

## Co ověřit po nasazení (nelze otestovat bez skutečného prohlížeče a GitHubu)

- Přihlášení přes vyskakovací okno v Chrome, Firefoxu a Safari (COOP `same-origin-allow-popups`).
- Konzole prohlížeče na `/admin/` bez porušení CSP (kromě očekávaného `githubstatus.com`).
- Nahrání fotky: soubor se uloží jako `.jpg` s malými písmeny a bez diakritiky.
- Všech sedm částí (včetně Provozovatel) se otevře, pole fotky služby a popisu fotky funguje a
  „Neuloženo: …“ z pojistky (`preSave`) se ukáže při neplatném IČO nebo fotce služby bez popisu.
- Po 8 hodinách od přihlášení (vypršení tokenu, „Expire user access tokens“) administrace hlásí
  chybu a po odhlášení a novém přihlášení funguje.

# Přibalená písma: Baloo 2 a Plus Jakarta Sans

Veřejný web používá dvě rodiny písem z Google Fonts s licencí **SIL Open Font License 1.1**
(volné použití i přibalení na web; texty licencí jsou v `docs/licence-pisem/`). Soubory **nejsou
odkazované z Google Fonts** – jsou uložené ve `src/assets/` a build je publikuje pod `/assets/`
s otiskem obsahu v názvu, takže prohlížeč návštěvníka nekontaktuje žádný cizí server
(`font-src 'self'`).

Stažené 2026-11-25 jednorázově: CSS z `https://fonts.googleapis.com/css2?family=…&display=swap`
(s moderním User-Agentem, aby vrátil WOFF2 a variabilní písma) určilo adresy souborů na
`fonts.gstatic.com`; vzaté jsou jen části `latin` a `latin-ext` (čeština je v `latin-ext`).
Každý soubor začíná bajty `wOF2` (ověřeno; build to kontroluje znovu přes `checkFontFile`)
a pokrytí českých znaků (á č ď é ě í ň ó ř š ť ú ů ý ž a velká písmena) bylo ověřeno v tabulce
`cmap`. Fredoka (první kandidátka) češtinu neumí (chybí ě, ř, č …), proto Baloo 2.

| Soubor | Rodina, verze | Řezy | Zdroj | Velikost | SHA-256 |
|---|---|---|---|---|---|
| `src/assets/baloo-latin.woff2` | Baloo 2, Google Fonts v23 | variabilní 400–800 | `https://fonts.gstatic.com/s/baloo2/v23/wXKrE3kTposypRyd51jcAA.woff2` | 33 188 B | `26fb4610d4bc976d2584ca15e66c11465dbc1f267a10dca668fcb3080dfe59c1` |
| `src/assets/baloo-latin-ext.woff2` | Baloo 2, Google Fonts v23 | variabilní 400–800 | `https://fonts.gstatic.com/s/baloo2/v23/wXKrE3kTposypRyd51bcANwr.woff2` | 27 384 B | `dfd52ee2e67ff597c9a47238d59adcee2b27d8adf9245e2d53a46dd73db99dde` |
| `src/assets/jakarta-latin.woff2` | Plus Jakarta Sans, Google Fonts v12 | variabilní 400–800 | `https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yw.woff2` | 27 348 B | `153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79` |
| `src/assets/jakarta-latin-ext.woff2` | Plus Jakarta Sans, Google Fonts v12 | variabilní 400–800 | `https://fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko40yyygA.woff2` | 21 728 B | `38e3b8fd8045048eb311d90170a4429ed2c8f405852dc3d91b5af8452758703f` |

| Licence | Zdroj | SHA-256 |
|---|---|---|
| `docs/licence-pisem/Baloo2-OFL.txt` | `https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/OFL.txt` | `ad09b05dc8bc678c9daf7c4c5f7ef1f55e5726127f4330b2e98e40b9dffcb860` |
| `docs/licence-pisem/PlusJakartaSans-OFL.txt` | `https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/OFL.txt` | `995c7199cab65954f545996326755daee7b63cc6b42b06c13da1f9502ab08a99` |

Rozsahy znaků (`unicode-range`) v `@font-face` (`src/styles.css`) jsou převzaté z téhož CSS
Google Fonts. Při aktualizaci písma stáhněte nové soubory stejným postupem do prázdné dočasné
složky, ověřte `wOF2` a češtinu, nahraďte soubory ve `src/assets/` (stejné názvy) a opravte
tuto tabulku. Build (`PRELOAD_FONTS` v `build.mjs`) přednačítá obě části Baloo 2.
