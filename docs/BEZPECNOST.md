# Bezpečnostní přehled (model hrozeb)

Dokument popisuje, **proti čemu je web chráněný, čím, a co zůstává na lidech**. Postup nastavení
je v [NAVOD.md](../NAVOD.md). Tady je vysvětleno, proč je to nastavené právě takhle.

## Co chráníme

1. **Obsah webu.** Nikdo cizí nesmí změnit, co je na https://www.zabavadeti.cz.
2. **Návštěvníky.** Web nesmí nikoho sledovat ani mu podstrčit škodlivý kód.
3. **Účty a doménu.** GitHub, Cloudflare a registrátor jsou klíče od celého webu.
4. **Osobní údaje.** Hlavně fotky dětí a jejich metadata.

## Jak je web postavený (stručně)

```
Návštěvník ──► Cloudflare (CDN, HTTPS, HSTS, ochrana proti DDoS) ──► hotové statické soubory (dist/)

Editorka / admin ──► /admin/  ──► [Zámek 1: Cloudflare Access, PIN na povolený e-mail]
                                     │
                                     ▼
                     /api/auth, /api/callback (Cloudflare Pages Functions)
                                     │   [sám ověří podpis tokenu Access (Cf-Access-Jwt-Assertion)]
                                     │   [Zámek 2: GitHub přihlášení s 2FA
                                     │    + povinný seznam ALLOWED_GITHUB_USERS]
                                     ▼
                     GitHub repozitář 11Lucie/zabavadeti
                       editorka: návrh ve větvi cms/… (pull request)
                       [Zámek 3: ruleset na main – schválení vlastníkem kódu (CODEOWNERS),
                        schválení posledního pushe, zneplatnění starých schválení, bez force push]
                                     │  admin zkontroluje Files changed a sloučí na GitHubu
                                     ▼
                     Cloudflare Pages: [volitelně zámek 4: otisk kódu v Build command]
                     sestaví „node build.mjs“ (kontroly) ──► nová verze webu
```

**Zámky 1 a 2 chrání jen administraci a přihlašovací proxy na webu, ne GitHub samotný.** Kdo má
GitHub účet editorky (nebo její token), pracuje přímo na github.com a api.github.com. Proti tomu
chrání jen zámek 3 (ruleset + kontrola Files changed adminem) a volitelný zámek 4.

- **Web:** statické HTML/CSS/obrázky. Žádný server, databáze, PHP ani přihlašovací formulář.
  Build (`node build.mjs`) nepoužívá žádné npm balíčky.
- **Administrace:** Decap CMS jako jeden vendorovaný soubor na `/admin/` (žádné CDN), režim
  `editorial_workflow`, a naše pojistka `static/admin/publish-guard.js` (viz „Pojistka zveřejnění“
  níže). `manual-init.js` zakáže Decapu samostatný start a administraci spustí až pojistka, takže
  bez pojistky administrace vůbec neběží.
- **Přihlášení:** malý OAuth prostředník v `functions/api/` (kód sdílený z `lib/`), tajemství jen
  v proměnných prostředí Cloudflare.
- **HTTP hlavičky:** `dist/_headers` vzniká spojením `headers/site.txt`, pravidel pro dlouhou cache
  souborů s otiskem (generuje build) a `headers/admin.txt`. Cloudflare hlavičky z více pravidel
  slučuje, proto pravidla pro administraci nejdřív zděděné hlavičky odpojí
  (`! Content-Security-Policy` apod.) a pak nastaví vlastní, volnější CSP, kterou Decap potřebuje.
  Volnější CSP je jen v administraci, a ta je schovaná za Access.

## Selhání „bezpečně“ (fail closed)

Chybné nastavení nesmí ochranu potichu vypnout. Proto:

| Co chybí nebo je špatně | Co se stane |
|---|---|
| `ALLOWED_GITHUB_USERS` (teď jen `11Lucie`) prázdné, chybí, obsahuje překlep (e-mail, středník, mezeru ve jménu) | `/api/auth` i `/api/callback` vrátí 500, **nikdo** se nepřihlásí, kód se nevymění za token |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` chybí nebo jsou neplatné | totéž (500) |
| Požadavek nepřišel přes Cloudflare Access (chybí nebo nesedí podpis, publikum, platnost tokenu) | 403 |
| Klíče Access nejdou načíst | 503 |
| Požadavek na jiné adrese než `https://www.zabavadeti.cz` (holá doména, `*.pages.dev`, cizí host) | 400 (výchozí seznam je přímo v kódu, `ALLOWED_ORIGINS` ho jen nahradí) |
| GitHub vrátí token s širším oprávněním, než je nastavené (`repo` místo `public_repo`) | 403, celé povolení aplikace se na GitHubu zruší, token se do prohlížeče nedostane |
| Pojistka zveřejnění nemůže ověřit návrh (výpadek, chybí přihlášení, návrh se během kontroly změnil, správkyně ho v tomto okně neuložila, od uložení přibyl commit) | zveřejnění v administraci se zastaví; požadavek na sloučení s jiným než ověřeným commitem pojistka GitHubu vůbec nepošle |
| `CODE_HASH` chybí nebo nesedí s otiskem nasazovaného kódu (je-li zapnutý zámek 4) | build v Cloudflare skončí chybou, na webu zůstane předchozí verze |
| Pojistka se nenačte (chyba SRI, 404, chyba v souboru) | administrace se nespustí (zůstane „Načítám administraci…“), Decap bez pojistky neběží |
| Neznámý soubor ve `static/`, `functions/` nebo v kořeni repozitáře (např. `wrangler.toml`/`.json`/`.jsonc`, `.npmrc`, `package-lock.json`, `bun.lockb`, `_worker.js`), `package.json` se závislostmi nebo instalačními skripty, symbolický odkaz, submodul, nepovolený typ souboru ve výstupu | build skončí chybou, na webu zůstane předchozí verze |

## Tabulka hrozeb

| Hrozba | Jak je ošetřena | Co zbývá |
|---|---|---|
| **SQL injection, zranitelné pluginy a šablony, neaktualizovaný systém** (nejčastější útok na WordPress) | Na webu není databáze, PHP, pluginy ani serverový kód, který by zpracovával vstup návštěvníků. Web jsou jen hotové soubory. | Nic z této kategorie. Zbývá **starý WordPress**: dokud běží na starém hostingu, je zranitelný. Proto ho po přepnutí zálohovat a smazat a hosting zrušit (NAVOD B10). |
| **XSS z obsahu** (škodlivý skript vložený do textu, např. přes ukradený účet editorky) | Všechna pole jsou prostý text a build je při vkládání do HTML escapuje, takže `<script>` se zobrazí jako text. CSP veřejného webu nepovoluje inline skripty ani cizí zdroje (žádné `connect-src`; styly, obrázky a písma jen z vlastní domény: `style-src 'self'`, `img-src 'self'`, `font-src 'self'`). Kontrola hotového HTML hlídá i neobvyklé zápisy (`<script/src=…>`, komentáře `<!-->`, `--!>`) a počet všech výskytů `<script`. Každá změna obsahu prochází schválením. | Chyba v kódu buildu by escapování mohla obejít. CSP je druhá vrstva, která by spuštění skriptu stejně zablokovala. Trusted Types zatím nejsou zapnuté (viz „Zásady“). |
| **Skryté a klamavé znaky v textu** (neviditelné znaky, obrácení směru textu, skrytý text pro roboty) | Build odmítne řídicí a formátovací znaky Unicode (kategorie Cc, Cf, Co, Cs: např. RLM/LRM, znaky nulové šířky, „tag“ znaky), všechny znaky, které se nekreslí (vlastnost Unicode `Default_Ignorable_Code_Point`: variation selectory U+FE00–FE0F a U+E0100–E01EF, CGJ U+034F, mongolské U+180B–180F, khmerské U+17B4/17B5, prázdné znaky Hangul …), prázdný Braillův znak U+2800, oddělovače řádků a čtyři a více kombinačních znamének za sebou („zalgo“ text). Výjimky pro emoji: ZWJ uvnitř emoji sekvence a U+FE0F hned za emoji nebo v „keycap“ (číslice v rámečku). | Administrace (config.yml) tyto znaky nehlídá – návrh s nimi jde uložit, build ho ale odmítne a web zůstane v předchozí verzi. |
| **Podvržené odkazy v kontaktech** (mailto s více adresami, přesměrování přes Facebook) | E-mail nesmí obsahovat `%`, `,`, `?`, `&`; kontrola HTML hlídá, že každý `mailto:` má právě jednu obyčejnou adresu. Odkaz na Facebook nesmí vést na přesměrovávače a dialogy (`l.php`, `flx`, `dialog`, `login` …), build ho očistí od parametrů (kromě `profile.php?id=`). Administrace (config.yml) má stejné limity, aby nepouštěla, co build odmítne. | Úplně podvodnou stránku na facebook.com technika nepozná – hlídá ji schválení. |
| **XSS / škodlivý kód v administraci** | Administrace je za Cloudflare Access, takže ji cizí člověk vůbec nenačte. Decap je vendorovaný s ověřeným hashem (viz `docs/VENDOR.md`), bez načítání z CDN. Vlastní CSP pro `/admin/`. | CSP administrace musí být volnější, protože Decap je velká JS aplikace. Chyba přímo v Decapu se řeší pravidelnou aktualizací (NAVOD E). |
| **Clickjacking** (web vložený do cizí stránky, aby uživatel nevědomky klikal) | Hlavičky zakazují vkládání do rámců (`frame-ancestors` v CSP, `X-Frame-Options`). | Prakticky nic. Veřejný web navíc nemá žádné akce, které by šlo „vykliknout“. |
| **MIME sniffing** (prohlížeč si soubor vyloží jako jiný typ, např. obrázek jako HTML) | Hlavička `X-Content-Type-Options: nosniff`. Build ověřuje u nahraných obrázků skutečný obsah (magic bytes), nejen příponu. | – |
| **Odposlech a podvržení spojení (SSL strip)** | Always Use HTTPS, HSTS na webu (`www`) i v nastavení zóny Cloudflare, takže hlavičku dostane i holá doména `zabavadeti.cz` a její přesměrování. Stejná hodnota (12 měsíců, `includeSubDomains`) v Cloudflare, v `headers/site.txt` i v odpovědích `/api/*`. HSTS preload až po měsíci (NAVOD B11). | První návštěva holé domény před zápisem do preload seznamu. |
| **Únos relace, krádež cookies** | Veřejný web žádné cookies nemá, takže není co ukrást. | Přihlášení do administrace žije v prohlížeči správkyně (případně editorky): cookie Cloudflare Access (platí 24 h) a token GitHubu v úložišti prohlížeče. **Access token GitHubu nechrání** – dá se použít přímo proti GitHubu. V OAuth App je zapnuté „Expire user access tokens“, takže token platí nejvýš 8 hodin; obnovovací token (refresh token), který k němu GitHub vydá, přihlašovací proxy zahodí a do prohlížeče ho nepošle. Odhlášení v administraci token jen smaže z prohlížeče, na GitHubu platí do vypršení. Dřív ho jde odvolat jen na GitHubu (NAVOD E: čtvrtletní „Revoke all user tokens“, F). |
| **CSRF v přihlašování (OAuth)** (podstrčení cizího přihlášení) | `/api/auth` vygeneruje náhodný `state` a uloží ho do cookie s prefixem `__Host-` (jen HTTPS, jen tato doména, nejde podvrhnout ze subdomény). `/api/callback` ho porovná a bez shody nic nevydá. Spuštění přihlášení z cizí stránky (`Sec-Fetch-Site: cross-site`) se odmítne a chybný callback rozběhnuté přihlášení nesmaže. | Po vypršení relace Access může být potřeba kliknout na přihlášení dvakrát (aplikace to česky vysvětlí). |
| **Únik přístupového tokenu** | Token se předá do okna administrace přes `postMessage` jen na origin, ze kterého přihlášení začalo, a ten musí být na pevném seznamu (výchozí `https://www.zabavadeti.cz` přímo v kódu), nikdy na `*`. Odpovědi mají `Cache-Control: no-store`, nic se neukládá v cache. Token nikdy není v URL. Callback URL v OAuth App je jediná, bez wildcard matching. Token s širším oprávněním, než je nastavené, se zruší. | Token je v prohlížeči uživatelky. Rozsah `public_repo` dovoluje zápis do **všech veřejných repozitářů** daného účtu (GitHub OAuth App neumí omezit na jedno repo; uměla by to GitHub App, viz NAVOD G). Rozsah `repo` se záměrně nepoužívá, protože by otevřel i soukromé repozitáře. Token platí nejvýš 8 hodin, viz řádek výše. |
| **Krádež účtu editorky** (phishing, uniklé heslo, ukradený token; týká se až přidání editorky – teď web spravuje jen admin, NAVOD B12) | GitHub 2FA (ideálně passkey). Editorka má roli Write a ruleset na `main` vyžaduje **schválení vlastníkem kódu** (`.github/CODEOWNERS` = Lucie), **schválení posledního pushe** a **zneplatnění starých schválení**, takže sama nic nezveřejní – ani přes vlastní PR, ani přes návrh z forku, ani přidáním commitu do Luciina návrhu. Admin zveřejňuje její návrhy **jen na GitHubu** po kontrole **Files changed** a **Commits** a nikdy u nich nepoužije volbu „Merge without waiting for requirements to be met (bypass rules)“ (NAVOD D). Pojistka v administraci zveřejní jen návrh, který admin v tomtéž okně sama uložila a který se od té doby nezměnil, a jen se souborem zveřejňované stránky a novými fotkami (viz „Pojistka zveřejnění“). Build odmítne cokoli neznámého ve `static/` a `functions/`. Volitelně otisk kódu v Build command (zámek 4). Náhledové buildy větví jsou vypnuté. | **Access a `ALLOWED_GITHUB_USERS` tu nepomáhají** – chrání jen administraci na webu, útočník s jejím účtem pracuje přímo na GitHubu. Útočník může vytvořit návrh a ve veřejném repozitáři je vidět. Zbytkové riziko: admin přehlédne změnu kódu ve Files changed a zámek 4 není zapnutý, nebo na GitHubu použije volbu „bypass“ (jako majitelka ji má k dispozici a GitHub ji nezastaví). 2FA u osobního účtu nejde vynutit, editorku je třeba požádat. |
| **Krádež účtu admina** | 2FA (ideálně passkey), záchranné kódy offline, 2FA i na e-mailu, Access, `ALLOWED_GITHUB_USERS`. | **Největší zbývající riziko.** Admin může pravidla obejít (výjimka v rulesetu platí i pro sloučení z administrace a pro údržbu z počítače). Sem patří i **přihlášení ke GitHubu uložené v Luciině počítači** (Git Credential Manager), přes které Claude nahrává údržbu: je to klíč k přímému zveřejnění. Řeší se pečlivostí: passkey, nezadávat heslo mimo `github.com`, chránit e-mail a počítač (šifrovaný disk, zámek obrazovky). Pro git v počítači lze místo plného přihlášení použít „fine-grained“ token jen pro tento repozitář (Contents a Pull requests, bez Administration, s expirací) – pak nejde měnit ruleset ani jiné repozitáře. |
| **Podvržený kód v návrhu** (do větve `cms/…` se přes git/API přidá změna `build.mjs`, `functions/`, `static/_worker.js` …) | Návrhy editorky jen přes GitHub po kontrole Files changed a Commits (NAVOD D). Pojistka `publish-guard.js` v administraci. Build odmítne vše neznámé v kořeni repozitáře (povolené jsou jen známé soubory a složky; výslovně `wrangler.toml`/`.json`/`.jsonc`, které Cloudflare čte dřív než náš build a mohl by jimi zveřejnit jinou složku a přepsat proměnné, `.npmrc`, zámky balíčků jako `package-lock.json` nebo `bun.lockb`, `_worker.js`, `_routes.json`, `_redirects`, `_headers`), `package.json` se závislostmi nebo s automaticky spouštěnými skripty, řídicí soubory Cloudflare Pages (`_worker.js`, `_redirects`, `_routes.json`, i jako složka) a vše neznámé ve `static/` (povoleno jen `admin/` s pevným seznamem souborů, `uploads/`, `.well-known/security.txt`, `favicon.svg`, `site.webmanifest`) a ve `functions/` (jen `api/auth.js`, `api/callback.js`). Volitelný zámek 4 (otisk kódu v Build command v Cloudflare, mimo dosah repozitáře). | Kontroly v buildu může útočník v témže návrhu smazat (změnou `build.mjs`) – to je ale vidět ve Files changed a zastaví to zámek 4. Instalace balíčků by proběhla ještě **před** buildem; proto `SKIP_DEPENDENCY_INSTALL=1` v Cloudflare a kontrola Files changed. Úplné oddělení by vyžadovalo dva repozitáře (obsah a kód). |
| **Přepsání nebo smazání Luciiných větví `cms/…` editorkou** (role Write smí zapisovat do všech větví kromě `main`, i přepsat je) | Vědomé riziko: GitHub u osobního repozitáře neumí omezit zápis do větví podle toho, komu patří. Pojistka v administraci se váže na přesný commit, který Lucie sama uložila: když editorka (nebo někdo s jejím účtem) do Luciiny větve cokoli přidá nebo ji přepíše, zveřejnění v administraci se zastaví. Smazaná větev zavře návrh, takže se nic nezveřejní. Na GitHubu nový commit zneplatní schválení. | Editorka může Luciin rozpracovaný návrh zničit (smazat nebo přepsat) – Lucie ho pak uloží znovu. Na GitHubu se u takového návrhu nesmí použít volba „bypass“. |
| **Zlomyslný upload** (soubor maskovaný jako obrázek, SVG se skriptem, obří soubor, „dekompresní bomba“) | Povoleny jen `.jpg .jpeg .png .webp`. Build kontroluje název (`^[a-z0-9][a-z0-9._-]*$`, ne názvy vyhrazené ve Windows jako `con.jpg`), skutečný typ souboru podle magic bytes, velikost (5 MB), rozměry (12 000 px na stranu, 40 milionů pixelů), jinak build skončí chybou a nic se nezveřejní. **SVG není povolené** (může obsahovat skript). Na `/uploads/` platí přísná CSP se `sandbox`, takže i podvržený soubor by se v prohlížeči nemohl spustit. Upload navíc prochází schválením. | Chybová stránka 404 pod `/uploads/` je kvůli sandboxu bez stylů – vědomý kompromis. |
| **Supply chain** (napadený cizí balíček nebo CDN) | Build nemá **žádné npm závislosti** (hlídá test; `SKIP_DEPENDENCY_INSTALL=1` v Cloudflare vypne instalaci úplně). Decap CMS je jeden vendorovaný soubor v repozitáři s ověřeným hashem (postup v `docs/VENDOR.md`). Web ani administrace nenačítají nic z cizích CDN. Cloudflare aplikace na GitHubu má přístup jen k tomuto repozitáři. GitHub Actions jsou vypnuté. V repozitáři nesmí být symbolické odkazy ani submoduly (kontrola v buildu). | Důvěřujeme samotnému Decapu (při aktualizaci) a platformám GitHub a Cloudflare. Aktualizace Decapu jen podle `docs/VENDOR.md`, nikdy „naslepo“. |
| **DDoS, hádání hesel (brute force)** | Web běží na síti Cloudflare, která útoky na přetížení odráží. Na webu **není žádný přihlašovací formulář**. Přihlašování řeší Cloudflare Access (PIN na e-mail) a GitHub, oba mají vlastní omezení počtu pokusů. | Při extrémním útoku může být web chvíli pomalý. |
| **Podvržení domény / DNS** (převod domény, změna nameserverů, falešné DNS odpovědi, opuštěné záznamy) | DNS u Cloudflare se zapnutým **DNSSEC**. U registrátora **2FA**, **zámek / blokace domény** a automatické prodlužování. HTTPS s HSTS. Po zrušení starého hostingu se smažou všechny záznamy, které na něj ukazovaly (NAVOD B10), a DNS se kontroluje čtvrtletně. Kontaktní e-mail registrátora a držitele domény nesmí být rušená schránka `info@zabavadeti.cz` (NAVOD B5, B9). | Účet u registrátora je nejcennější klíč. Jeho zabezpečení závisí na registrátorovi a na tom, jak ho Lucie nastaví. |
| **Podvržené e-maily „od zabavadeti.cz“** | Pokud doména poštu nepoužívá: `SPF v=spf1 -all`, `DMARC p=reject`, null MX (`0 .`). Přijímající servery pak falešné e-maily odmítnou. | Platí jen pro tuto doménu. Proti podvodným e-mailům z podobně znějících domén to nepomůže. Nastavuje se až při rozloučení se schránkou `info@zabavadeti.cz` u starého hostingu: nejdřív kontrola, že info@ není přihlašovací ani záchranný e-mail žádné služby, a export pošty, pak smazání starých záznamů pošty a teprve potom nové (NAVOD B9). |
| **Zrušená schránka `info@zabavadeti.cz`** (přihlašovací nebo záchranný e-mail nějaké služby) | Před změnou DNS pošty se schránka projde a u nalezených služeb (hlavně registrátor a držitel domény, hosting, Facebook, Google) se e-mail změní na trvalou adresu (NAVOD B9). Null MX zajistí, že poštu pro doménu nikdo nepřijímá, dokud jsou DNS pod kontrolou Lucie. | Přehlédnutá služba: u ní nepůjde obnovit heslo. Kdyby se adresa ukázala potřebná, jde ji zdarma přeposílat přes Cloudflare Email Routing (pak bez null MX). |
| **Náhledová prostředí a jiné adresy** (`*.pages.dev`, holá doména) | Automatické náhledy větví jsou vypnuté. Access chrání `zabavadeti.pages.dev` a `*.zabavadeti.pages.dev` (postup Cloudflare přes „Enable access policy“, NAVOD B6) a také `zabavadeti.cz/admin` a `/api`. Přihlašovací proxy navíc funguje jen na `https://www.zabavadeti.cz` a sama ověřuje token Access. Tajemství jsou jen v prostředí Production. | Po změnách v Cloudflare ověřit v anonymním okně, že `https://zabavadeti.pages.dev/admin/` chce přihlášení Access. |
| **Veřejné návrhy a soubory v repozitáři** | Návrh může poslat kdokoli (i z forku), na web se ale bez schválení nedostane. Cizí návrhy se zavírají bez sloučení a větve mažou (NAVOD D). | Obsah nahraný do návrhu nebo forku zůstává na GitHubu dostupný i po smazání větve (vlastnost GitHubu). U citlivého obsahu požádat GitHub Support o odstranění. |
| **Soukromí návštěvníků / GDPR** | Žádné cookies, žádná analytika, žádné externí zdroje (písma, skripty, mapy, vložená videa), na které by prohlížeč posílal IP adresu. Písma (Baloo 2 a Plus Jakarta Sans, licence SIL OFL) jsou uložená přímo na webu a načítají se jen z vlastní domény (`/assets/*.woff2`, `font-src 'self'`, přednačtení `<link rel="preload" crossorigin>` jde také na vlastní doménu) – žádný požadavek na Google Fonts ani jinou CDN, takže se IP adresa návštěvníka nikam nepředává. Původ a otisky souborů jsou v `docs/VENDOR.md`. Proto web **nepotřebuje lištu se souhlasem**. Cloudflare nesmí do stránek nic vkládat (Email Obfuscation, Rocket Loader, Web Analytics vypnuté). | Cloudflare jako hosting technicky vidí IP adresy návštěvníků, stejně jako každý hosting. Pokud by se v Cloudflare zapnuly bezpečnostní funkce proti botům, může nastavit technickou cookie nutnou pro bezpečnost (ta souhlas nevyžaduje). |
| **Poloha v EXIF a fotky dětí** | Administrace fotky před nahráním překóduje a metadata odstraní. Build varuje před GPS v EXIF (i ve více blocích), v XMP, v textových blocích PNG a ve WebP. Návod editorce vysvětluje, jak polohu z fotek odstranit, a vyžaduje souhlas rodičů. Fotky nahrané mimo administraci (Claude, GitHub) se předem zbaví metadat (NAVOD B10, bod 3). Admin fotky před zveřejněním kontroluje. | Web na automatické mazání metadat **nespoléhá**. Varování přichází až po uložení návrhu – co se jednou nahraje do veřejného repozitáře, zůstává v historii i po smazání (odstranění by vyžadovalo přepsání historie). |
| **Únik tajemství** (`GITHUB_CLIENT_SECRET`) | Je uložené **jen** v proměnných Cloudflare jako Secret (šifrovaně), nikdy v repozitáři, e-mailu ani v kódu. Repozitář je veřejný právě proto, že v něm nic tajného není. `.gitignore` vylučuje `.env*` a `.dev.vars*`. GitHub u veřejných repozitářů hlídá omylem nahraná tajemství (Secret scanning, Push protection). | Při podezření na únik: vygenerovat nový secret, ostatní smazat, odhlásit všechny tokeny (NAVOD F). Obecný OAuth secret GitHub nemusí poznat – rozhoduje opatrnost. |
| **Ztráta nebo poškození dat** | Historie webu je na GitHubu a v pravidelných neměnných snímcích (`git bundle`) u Lucie mimo GitHub (NAVOD E). Ruleset brání force push a smazání `main` pro všechny kromě admina. Rollback v Cloudflare vrátí web během minuty. Smazaný repozitář jde 90 dní obnovit. | Admin (nebo ukradený admin účet) pravidla obchází a smazání celého repozitáře ruleset nehlídá – proto snímky mimo GitHub. Ztratit se mohou změny od posledního snímku. |

## Pojistka zveřejnění (`static/admin/publish-guard.js`)

Je to **záchranná síť, ne atomická záruka**. Finální ochrana je na GitHubu: ruleset s CODEOWNERS a
kontrola Files changed a Commits adminem. Pojistka dělá tohle:

1. **Spouští administraci.** `index.html` načte nejdřív `manual-init.js` (`CMS_MANUAL_INIT = true`),
   pak Decap a nakonec pojistku; teprve pojistka po zaregistrování kontrol zavolá `CMS.init()`.
   Když se nenačte, administrace neběží (fail closed).
2. **Pamatuje si, co admin uložila.** Při uložení zachytí odpověď GitHubu na zápis větve `cms/…`,
   který poslal sám Decap, a po události `postSave` si zapamatuje přesné SHA (v paměti a
   v `sessionStorage` tohoto okna).
3. **Kontroluje před zveřejněním** (`prePublish`): otevřený PR z větve tohoto repozitáře, jeho poslední
   commit = zapamatované SHA, změněné soubory jen `content/<stránka>.json` zveřejňované stránky
   (`modified`) a nové fotky ve `static/uploads/` (jen `added`), na konci znovu SHA.
4. **Hlídá sloučení:** požadavek Decapu `PUT /pulls/<n>/merge` pustí jen jednou, do 2 minut a jen
   se SHA, které právě ověřila. GitHub pak sloučí jen přesně tento commit (parametr `sha`), jinak
   sloučení odmítne. Tím se zavírá okno mezi kontrolou a načtením návrhu v Decapu. Zablokovaný
   požadavek GitHubu vůbec neodejde; Decap místo něj dostane syntetickou odpověď **409** s českým
   vysvětlením. (Kdyby pojistka požadavek odmítla chybou sítě, Decap by ho 5× opakoval s rostoucí
   pauzou, asi minutu; odpověď HTTP 409 předá rovnou uživatelce a `mergePR` ji neopakuje – zvláštně
   zachází jen s 405. Ověřuje test v `tests/publish-guard.test.mjs` proti vendorovanému balíku.)
5. **Kontroluje před uložením** (`preSave`) pravidla, která `config.yml` neumí: kontrolní číslici IČO,
   popis u fotky služby a text o původu referencí. Tytéž kontroly dělá build (`src/validate.mjs`), takže
   návrh, který by zastavil sestavení webu, nejde ani uložit.

Důsledek: návrh, který admin v tomto okně neuložila (typicky návrh editorky), v administraci
zveřejnit nejde – zveřejňuje se na GitHubu (NAVOD D). Pozor: **opětovné uložení v administraci
převezme commity, které už na větvi návrhu jsou** (Decap zapíše nový commit nad aktuální stav větve
a pojistka si zapamatuje právě ten). Uložení tedy „posvětí“ i cizí commit, který do větve přibyl
dřív. Proto se před opětovným uložením vlastního návrhu (třeba po zavření prohlížeče) nejdřív na
GitHubu zkontrolují **Commits** – všechny musí být adminovy (NAVOD D). Co pojistka neřeší: ukradený účet admina,
chybu přímo v Decapu, zveřejnění na GitHubu s volbou „bypass“ a změny, které by Decap provedl jinou
cestou než zachycenými požadavky (proto se při aktualizaci Decapu ověřuje podle `docs/VENDOR.md`).

## Co ověřit po nasazení

V anonymním okně prohlížeče:

1. `https://www.zabavadeti.cz/admin/` a `https://www.zabavadeti.cz/api/auth` → musí se ukázat
   přihlášení **Cloudflare Access**, ne administrace.
2. `https://zabavadeti.pages.dev/admin/` → totéž. `https://zabavadeti.cz/admin/` → přesměruje na www
   (nebo ukáže přihlášení Access), nikdy rovnou administraci.
3. `http://zabavadeti.cz` → přesměruje na `https://www.zabavadeti.cz`.
4. https://securityheaders.com a https://observatory.mozilla.org pro `https://www.zabavadeti.cz`
   → dobrá známka (A a lepší).
5. Přihlášení cizím GitHub účtem (který není v `ALLOWED_GITHUB_USERS`) → administrace ho odmítne.
6. *Až po přidání editorky (NAVOD B12):* editorka zkusí návrh zveřejnit sama → GitHub to odmítne
   (vyžaduje schválení).
7. *Až po přidání editorky:* Lucie uloží v administraci testovací koncept, Ivona ho na GitHubu
   schválí → **Merge** zůstane zablokovaný (schválit smí jen vlastník kódu). Ivona po Luciině
   schválení svého návrhu přidá další změnu → schválení zmizí.
8. Lucie zveřejní testovací koncept v administraci (stav **Připraveno** → **Publikovat** →
   **Publikovat teď**) → v historii `main` (GitHub → **Commits**) je
   commit s číslem návrhu (např. „… (#12)“), ne „Automatically generated. Merged on Decap CMS“.
   Zveřejnit jde jen ve stejném okně, ve kterém koncept uložila; v novém okně administrace
   ukáže „Zveřejnění zastaveno: tento návrh jste v tomto okně administrace neuložila“.
   Koncept editorky (až bude mít účet) v administraci zveřejnit nejde (stejná hláška).
9. Odkaz „Napište mi“ na webu míří na `mailto:` s adresou (ne na `/cdn-cgi/l/email-protection`)
   a konzole prohlížeče na veřejném webu je bez chyb CSP.
10. https://www.zabavadeti.cz/.well-known/security.txt se zobrazí a odkaz na hlášení chyb na GitHubu
    funguje (Private vulnerability reporting zapnuté).
11. https://www.zabavadeti.cz/ochrana-soukromi/ se zobrazí, v patičce každé stránky je provozovatel
    s IČO a odkaz na tuto stránku, v prohlížeči nejsou žádné cookies (nástroje pro vývojáře →
    Application → Cookies je prázdné) a odkaz na Facebook nic nenačítá, dokud se na něj neklikne.

Hlavičky (Claude, příkazem `curl` v Git Bash):

- `curl -sI https://www.zabavadeti.cz | grep -i strict-transport` → **právě jedna** hlavička
  `max-age=31536000; includeSubDomains` (dokud je v Cloudflare dočasně vypnuté includeSubDomains,
  NAVOD B5, může se lišit; po NAVOD B10 už musí sedět přesně).
- `curl -sI https://zabavadeti.cz | grep -i -e strict-transport -e location` → přesměrování na www
  **a** hlavička HSTS (z nastavení zóny).
- `curl -sI http://zabavadeti.cz | grep -i location` → `https://zabavadeti.cz/` (nejdřív HTTPS na
  stejné adrese – podmínka pro HSTS preload).
- `curl -sI https://www.zabavadeti.cz/neexistuje` → 404 s plnou CSP, `X-Frame-Options: DENY` a
  `nosniff` (ověří, že Cloudflare uplatňuje `_headers` i na stránku 404).
- `curl -sI https://www.zabavadeti.cz/assets/neexistuje.css` → 404 **bez** `immutable`.
- `curl -sI https://www.zabavadeti.cz/uploads/neexistuje.jpg` → 404 s CSP `sandbox` a `nosniff`.
- `curl -s -o /dev/null -w '%{http_code}\n' https://zabavadeti.cz/api/auth` → nikdy přesměrování
  na github.com (Access, přesměrování na www, nebo 400).

Automatické testy kódu (`npm test`, soubory v `tests/`) ověřují build, kontroly, přihlašovací
funkce, pojistku zveřejnění a shodu administrace s kontrolou buildu. Spouští je Claude při každé
změně kódu.

## Zásady pro budoucí změny

- Nepřidávat skripty, písma, mapy, videa ani analytiku z cizích serverů. Rozbilo by to CSP a
  soukromí (byla by potřeba lišta se souhlasem). Vlastní písma a SVG patří do `src/assets/`
  (build je zkontroluje a otiskne); nové písmo jen jako WOFF/WOFF2 s vlastní nebo volnou
  licencí (text licence do `docs/licence-pisem/`, původ a sha256 do `docs/VENDOR.md`), nikdy
  odkazem na Google Fonts apod. Za běhu web nedělá žádný požadavek mimo vlastní doménu.
- Stránka `/ochrana-soukromi/` (šablona `privacyMain` v `src/render.mjs`) tvrdí, že web nemá
  formuláře, cookies, analytiku ani cizí zdroje a že v prohlížeči ukládá jen volbu vzhledu. Každá
  změna, která by na tom něco měnila, musí upravit i tento text a datum `PRIVACY_UPDATED`.
- Nepřidávat npm závislosti do buildu.
- Do repozitáře nikdy nedávat hesla, klíče ani zálohy s osobními údaji. Je veřejný.
- Neměnit rozsah přihlášení na `repo` a nedávat editorce roli Admin.
- Decap aktualizovat jen podle `docs/VENDOR.md`.
- Nový soubor ve `static/`, `functions/` nebo v kořeni repozitáře je potřeba přidat do seznamu
  povolených v `scripts/check.mjs` (jinak build selže).
- Je-li zapnutý zámek 4, mění otisk kódu (`CODE_HASH`) **každá** změna mimo `content/*.json`
  a `static/uploads/*` – i v dokumentaci (`NAVOD.md`, `docs/`) nebo v testech. Postup (NAVOD B8, body 1–5):
  změnu nahrát na GitHub, Lucie zkontroluje nové commity v `origin/main` (jen její a schválené návrhy),
  otisk se spočítá z čísla právě toho commitu (výpočet z NAVOD B8 nebo `node scripts/code-hash.mjs <commit>`),
  Lucie ho přepíše v Cloudflare a dá Retry deployment. Soubory `wrangler.*` do repozitáře nepatří vůbec (nastavení je v Cloudflare).
- Po každé změně `static/admin/publish-guard.js` nebo `manual-init.js` přepočítat jejich SRI ve
  `static/admin/index.html` (hlídá test). Nová stránka v `config.yml` = doplnit ji i do `ENTRY_FILES`
  v pojistce (hlídá `tests/config-sync.test.mjs`).
- Limity polí měnit vždy v `src/validate.mjs` **i** ve `static/admin/config.yml` (hlídá test
  `tests/config-sync.test.mjs`).
- Při změně domény upravit najednou: `DEFAULT_ALLOWED_ORIGINS` v `lib/oauth.js` (nebo proměnnou
  `ALLOWED_ORIGINS`), `base_url` ve `static/admin/config.yml`, callback URL v GitHub OAuth App a
  aplikace v Cloudflare Access.
- **Trusted Types** (`require-trusted-types-for 'script'`) do CSP veřejného webu zatím nepřidávat:
  přínos je u tohoto webu teoretický a při zapnutém Email Address Obfuscation v Cloudflare by
  rozbily odkazy na e-mail. Přidat jde, až bude ověřené, že Cloudflare do stránek nic nevkládá.
