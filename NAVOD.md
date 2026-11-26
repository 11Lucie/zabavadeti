# Návod k webu Zábava pro děti

Kdo co potřebuje:

- **Lucie (správkyně, admin):** všechno, hlavně části B, D, E a F.
- **Ivona (majitelka webu):** zatím nic. Účet do administrace **nemá** a texty či fotky posílá Lucii.
  Kdyby někdy chtěla upravovat sama, Lucie ji přidá (krok B12) a Ivoně pak stačí část C.
- Kdo chce vědět, proti čemu přesně je web chráněný, najde podrobný přehled v [docs/BEZPECNOST.md](docs/BEZPECNOST.md).

Názvy tlačítek v GitHubu a Cloudflare jsou **anglicky**, protože tak je na obrazovce opravdu uvidíte.
Administrace webu je česky. Obě služby občas přestaví menu. Když tlačítko nenajdete přesně tam,
kde ho návod popisuje, hledejte ho podle názvu (třeba ve vyhledávání v nastavení) nebo se zeptejte Clauda.

---

## A) Co je kde a proč je to bezpečné

Web jsou **hotové soubory (stránky a fotky), které nikde nic nepočítají**. Nemá databázi, nemá
WordPress, nemá pluginy ani přihlašovací formulář, takže na veřejném webu není co „nabourat“.
Hostuje ho Cloudflare, který zvládá i velké nápory a útoky.

Úpravy se dělají v **administraci na adrese https://www.zabavadeti.cz/admin/**. Před každou
změnou na webu stojí zámky:

1. **Cloudflare Access:** do administrace se dostane jen ten, komu přijde jednorázový kód (PIN)
   na předem povolený e-mail (teď jen Luciin). Přihlašovací část webu si to navíc sama ověřuje:
   kdyby Access někdo omylem vypnul, přihlášení přestane fungovat úplně (nepustí nikoho).
2. **Přihlášení přes GitHub s dvoufázovým ověřením (2FA):** samotné heslo nestačí, je potřeba i
   kód z mobilu nebo bezpečnostní klíč. Účty, které nejsou na seznamu povolených (teď jen `11Lucie`),
   administrace odmítne. Přihlášení platí nejvýš 8 hodin, pak se přihlašuje znovu.
3. **Schválení adminem:** až bude mít Ivona účet, uloží jen návrh. Na web se dostane až ve chvíli,
   kdy ho Lucie zkontroluje a zveřejní. Hlídá to přímo GitHub, ne jen administrace.
4. **Pojistka kódu (doporučená):** Cloudflare před každým nasazením ověří, že se kód webu nezměnil
   bez Luciina vědomí (krok B8).

**Důležité:** zámky 1 a 2 hlídají jen administraci na webu. Kdo by ukradl účet na GitHubu, může
pracovat přímo na github.com a Access ani seznam povolených ho tam nezastaví. Proti tomu chrání
zámek 3 (u návrhů od Ivony Lucie na GitHubu kontroluje, **které soubory mění**, část D) a zámek 4.
Administrace má navíc pojistku: zveřejní jen návrh, který Lucie v tomtéž okně sama uložila a který
se od té doby nezměnil, a jen když mění text zveřejňované stránky a přidává nové fotky.

Obsah webu (texty a fotky) je uložený na GitHubu, v repozitáři `11Lucie/zabavadeti`. Každá změna
se tam zapíše, takže je vždy vidět, kdo co změnil, a jde ji vrátit.

---

## B) Jednorázové nastavení (pro Lucii)

Kroky dělejte **v tomto pořadí**, každý stačí udělat jednou. Kde je napsáno „Claude to udělá“,
stačí mu to říct. Hesla, kódy a platební údaje ale vždycky zadáváte jen vy.

| Krok | Co | Stav |
|---|---|---|
| 1 | GitHub: účet, repozitář, přihlašovací aplikace | ✔ hotovo 25. 11. 2026 |
| 2 | Nahrání projektu na GitHub | |
| 3 | Pravidla pro hlavní větev (ruleset) | |
| 4 | Cloudflare Pages a proměnné (vč. client secret) | |
| 5 | Doména do Cloudflare (web se zatím nemění) | |
| 6 | Cloudflare Access na administraci | |
| 7 | Přepnutí domény na nový web | |
| 8 | Ověření, DNSSEC a pojistka kódu | |
| 9 | E-mail na doméně: rozloučení se schránkou info@ | |
| 10 | Záloha a zrušení hostingu u Českého hostingu | |
| 11 | Za měsíc: HSTS preload (volitelné) | |
| 12 | Pokud by Ivona někdy chtěla upravovat sama (volitelné) | |

Sloupec „Stav“ doplňuje Claude. **Po zapnutí pojistky kódu (krok 8)** je i taková úprava návodu
změnou mimo texty a fotky: změní otisk `CODE_HASH` a nasazení se zastaví, dokud nezapíšete nový
(krok 8, body 1–5). Proto stav zapisujte nejlépe spolu s jinou údržbou, ne jako samostatnou změnu.

### 1. GitHub: účet, repozitář, přihlašovací aplikace – ✔ hotovo 25. 11. 2026

Hotové (není potřeba nic dělat, jen pro přehled):

- ✔ Repozitář **`11Lucie/zabavadeti`** (veřejný) je založený.
- ✔ **GitHub Actions** jsou vypnuté (projekt je nepotřebuje; čím méně zapnutých věcí, tím menší
  prostor pro útok).
- ✔ **Private vulnerability reporting** je zapnuté: kdo na webu najde chybu, nahlásí ji jen vám,
  soukromě (odkaz je v souboru `security.txt` na webu).
- ✔ **Secret protection** a **Push protection** jsou zapnuté: GitHub zastaví nahrání omylem
  vloženého hesla či klíče.
- ✔ **Přihlašovací aplikace (OAuth App)** pro administraci je vytvořená
  (**Settings** → **Developer settings** → **OAuth Apps**):
  - callback URL přesně `https://www.zabavadeti.cz/api/callback` (jediná), wildcard matching vypnutý,
  - **Enable Device Flow** vypnuté,
  - **Expire user access tokens** zapnuté: přihlášení do administrace platí nejvýš 8 hodin.
  - **Client secret zatím neexistuje.** Vygenerujete ho až v kroku 4, rovnou do Cloudflare.

Zkontrolujte, jestli máte (pokud ne, udělejte teď):

- **2FA na GitHubu:** ikona vpravo nahoře → **Settings** → **Password and authentication** →
  **Two-factor authentication**. Nejlepší je **passkey** nebo aplikace (GitHub Mobile, Google či
  Microsoft Authenticator), **SMS raději ne** (duplikát SIM). **Záchranné kódy (recovery codes)**
  uložte mimo počítač (vytisknout do šuplíku nebo do správce hesel).
- **2FA na svém e-mailu** (u Seznamu: nastavení účtu → **Zabezpečení**). Chodí na něj PIN do
  administrace a obnova hesla ke GitHubu, Cloudflare i k doméně. Záchranný telefon a e-mail u účtu
  musí být aktuální a vaše.
- Vše děláte pod účtem **11Lucie**, nikdy pod pracovním účtem.
- **Skrytý e-mail v úpravách:** **Settings** → **Emails** → zaškrtnout **Keep my email addresses
  private** (a v **Settings** → **Public profile** → **Public email** nechat „Don't show my email
  address“). Administrace ukládá změny vaším GitHub účtem a GitHub k nim jinak připíše váš
  **skutečný e-mail**, který pak kdokoli uvidí ve veřejné historii repozitáře. Se zaškrtnutím
  se místo něj použije adresa `…@users.noreply.github.com`.

**Proč veřejný repozitář nevadí:**

- Je v něm jen to, co je stejně vidět na webu: texty, fotky a kód stránek. **Žádná hesla ani klíče**
  (ty jsou jen v Cloudflare, krok 4).
- U soukromého repozitáře by na bezplatném GitHubu **nefungovala pravidla hlídající schvalování**
  (krok 3). Veřejný repozitář je tedy paradoxně bezpečnější.
- **Pozor:** na GitHubu je vidět **každá fotka, která se kdy nahrála**, i když ji později smažete
  (zůstane v „historii“), a také neschválené návrhy. Nahrávejte jen to, co opravdu chcete zveřejnit.
- Návrh (pull request) může do veřejného repozitáře poslat **kdokoli na GitHubu**. Na web se bez
  vašeho schválení nedostane. Cizí návrhy zavírejte bez sloučení (část D).

### 2. Nahrání projektu na GitHub

Claude to udělá. Řekněte mu „nahraj projekt na GitHub“. Postup:

1. Claude spustí testy (`npm test`) a zkontroluje, že v projektu ani v jeho historii není nic
   tajného ani soukromého (repozitář bude hned veřejný i s celou historií).
2. Nahraje projekt příkazy `git remote add origin https://github.com/11Lucie/zabavadeti.git` a
   `git push -u origin main`.
3. Když se otevře okno přihlášení ke GitHubu, přihlaste se účtem **11Lucie** (ne pracovním).
   **Pozor na uložené přihlášení:** Git v počítači si pamatuje účty přes **Git Credential Manager**.
   Pokud v něm už je uložený jiný (např. pracovní) účet, může se nabídnout výběr účtu – zvolte
   **11Lucie** – nebo se nahrání pod jiným účtem rovnou zkusí. Claude proto před nahráním pro tuto
   složku nastaví `git config credential.username 11Lucie` (aby se nabízel správný účet) a po
   nahrání na GitHubu zkontroluje, že nahrání patří účtu 11Lucie. Kdyby se
   ukázal jiný účet, nic dalšího nedělejte a řekněte to Claudovi.
4. Kdyby GitHub nahrání odmítl („rejected“, „fetch first“), repozitář není prázdný. Nic
   nepřepisujte („force“) a nechte Clauda zjistit proč.
5. Na https://github.com/11Lucie/zabavadeti zkontrolujte, že jsou vidět soubory projektu, a v záložce
   **Security** že GitHub nehlásí žádné nalezené tajemství.

### 3. Pravidla pro hlavní větev (ruleset)

Tohle je **zámek č. 3**. GitHub díky němu nedovolí změnit web bez vašeho schválení. Dokud Ivona
nemá účet, nikdo jiný do repozitáře zapisovat nemůže, ale pravidla nastavte už teď: chrání hlavní
větev před smazáním a přepsáním a na pozdější přidání editorky se nezapomene.

1. V repozitáři **Settings** → vlevo **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. **Ruleset Name:** třeba `Ochrana webu`. **Enforcement status:** **Active**.
3. **Bypass list** → **Add bypass** → roli **Repository admin** (nic jiného tam nepřidávejte),
   a pokud se nabídne volba, **Always allow**.
   - Tím vy (majitelka) můžete zveřejňovat a Claude nahrávat údržbu bez dalšího schválení. Vlastní
     úpravy byste jinak neměla kým schválit (GitHub nedovolí schválit sám sobě).
   - **Pozor:** výjimka platí pro všechno, co uděláte vy. U neschváleného návrhu se vám na GitHubu
     objeví volba „Merge without waiting for requirements to be met (bypass rules)“ – u cizích
     návrhů (i Ivoniných) ji nikdy nepoužívejte (část D).
4. **Target branches** → **Add target** → **Include default branch** (to je `main`).
5. **Branch rules** zaškrtněte:
   - **Restrict deletions** (hlavní větev nejde smazat),
   - **Block force pushes** (nejde přepsat historii a zamést stopy),
   - **Require a pull request before merging** a v něm **všechny** tyto volby:
     - **Required approvals: 1**,
     - **Dismiss stale pull request approvals when new commits are pushed** (když se do návrhu po
       vašem schválení něco přidá, schválení zmizí),
     - **Require approval of the most recent reviewable push** (editorka nemůže do vašeho návrhu
       něco přidat a sama ho schválit),
     - **Require review from Code Owners** (podle souboru `.github/CODEOWNERS` se počítá jen
       **vaše** schválení, ne schválení kohokoli s právem zápisu).
6. **Create**.

Pravidla „Restrict deletions“ a „Block force pushes“ platí pro všechny **kromě vás**. Proto je
důležitá i záloha mimo GitHub (část E).

### 4. Cloudflare Pages a proměnné (vč. client secret)

**Účet a projekt:**

1. Založte si účet na https://dash.cloudflare.com a hned zapněte 2FA: ikona vpravo nahoře →
   **My Profile** → **Authentication** → **Two-Factor Authentication**. Záchranné kódy uložte
   stejně jako u GitHubu.
2. **Workers & Pages** → **Create** → záložka **Pages** → **Connect to Git** (nebo **Import an
   existing Git repository**). Když vidíte jen „Workers“, hledejte odkaz typu „Looking to deploy Pages?“.
3. Při propojení s GitHubem zvolte **Only select repositories** → `zabavadeti`. Cloudflare tak
   uvidí jen tenhle jeden repozitář.
4. Nastavení projektu:
   - **Project name:** `zabavadeti` (web poběží i na `zabavadeti.pages.dev`),
   - **Production branch:** `main`,
   - **Framework preset:** **None**,
   - **Build command:** `node build.mjs` (přísnější varianta s pojistkou kódu přijde v kroku 8),
   - **Build output directory:** `dist`, kořenová složka (root directory) prázdná.
   - **Environment variables:** přidejte `SKIP_DEPENDENCY_INSTALL` = `1`. Projekt nepoužívá žádné
     npm balíčky. Bez této proměnné by Cloudflare před každým sestavením spouštěl instalaci balíčků
     (`npm install`) – sestavení by sice prošlo, ale podvržený návrh se závislostí nebo souborem
     `.npmrc` by tak mohl spustit cizí kód dřív, než ho náš build stihne zkontrolovat a odmítnout.
5. **Save and Deploy**. Za 1–2 minuty je web na `https://zabavadeti.pages.dev`. Administrace tam
   přihlásit nepůjde a ani nemá (přihlášení funguje jen na www.zabavadeti.cz po krocích 6 a 7).
   **Do kroku 6 (bod 6) jde ale stránka `https://zabavadeti.pages.dev/admin/` otevřít komukoli.**
   Nic se tam bez přihlášení přes GitHub nestane: přihlašovací část webu bez vyplněných
   `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` nepustí nikoho, pustila by jen účty z `ALLOWED_GITHUB_USERS`
   a přihlášení stejně míří na www.zabavadeti.cz. Kdo chce mít klid hned, udělá zamknutí
   `pages.dev` z kroku 6 (body 1, 2 a 6) rovnou teď – na doméně nezávisí.

**Hned potom v projektu → Settings:**

- **Build** (dříve **Builds & deployments**) → **Branch control** → u **Preview branch** (nebo
  **Configure Preview deployments**) zvolte **None**. Jinak by Cloudflare každou větev návrhu
  `cms/…` zveřejnil na vlastní adrese `něco.zabavadeti.pages.dev` – i s případně podstrčeným kódem.
  Kdyby šla jen volba **Custom branches**, nastavte ji tak, aby žádná větev `cms/*` nepasovala.
- **Web Analytics** nechte vypnutou. Web záměrně nic nesleduje, a proto nepotřebuje lištu s cookies.

**Client secret a proměnné prostředí:**

1. V druhé záložce otevřete na GitHubu **Settings** → **Developer settings** → **OAuth Apps** →
   aplikace administrace. Opište **Client ID** (není tajný).
2. Klikněte na **Generate a new client secret**. **Client secret je tajný**, GitHub ho ukáže jen
   jednou. Zkopírujte ho **rovnou do Cloudflare** (bod 3) a nikam jinam: ne do e-mailu, souboru,
   chatu ani Claudovi. Kdyby se ztratil, vygenerujte nový a starý smažte.
3. Cloudflare → projekt → **Settings** → **Variables and Secrets** → prostředí **Production** → **Add**:

   | Název | Hodnota | Typ |
   |---|---|---|
   | `GITHUB_CLIENT_ID` | Client ID z bodu 1 | Text |
   | `GITHUB_CLIENT_SECRET` | Client secret z bodu 2 | **Secret** (ve starším rozhraní tlačítko **Encrypt**) |
   | `ALLOWED_GITHUB_USERS` | `11Lucie` | Text |
   | `SKIP_DEPENDENCY_INSTALL` | `1` (už z průvodce; musí být v **Production i Preview**) | Text |
   | `ACCESS_TEAM_DOMAIN` | doplníte v kroku 6 | Text |
   | `ACCESS_AUD` | doplníte v kroku 6 | Text |
   | `CODE_HASH` | doplníte v kroku 8 | Text |

   - Nic dalšího nepřidávejte. `OAUTH_SCOPE` **nevyplňujte** (výchozí `public_repo` je správně;
     `repo` by administraci otevřel i případné soukromé repozitáře účtu). `ALLOWED_ORIGINS` také ne
     (adresa `https://www.zabavadeti.cz` je přímo v kódu).
   - Do prostředí **Preview** tajné hodnoty **nedávejte**.
   - `ALLOWED_GITHUB_USERS` je **povinná**. Když chybí nebo v ní je překlep (e-mail místo jména,
     středník místo čárky), administrace **nepustí nikoho** a ukáže „Přihlašování není na serveru
     správně nastavené“. Totéž platí, dokud nejsou vyplněné `ACCESS_TEAM_DOMAIN` a `ACCESS_AUD`
     (krok 6) – to je v pořádku.
4. **Po každé změně proměnných** web znovu sestavte: **Deployments** → u posledního nasazení
   **⋯** → **Retry deployment**. Jinak se změna neprojeví.

### 5. Doména do Cloudflare (web se zatím nemění)

Doména přejde pod **DNS Cloudflare** (bez toho nejde zámek č. 1 ani DNSSEC jedním kliknutím).
Starý WordPress i schránka `info@zabavadeti.cz` u Českého hostingu zatím **běží dál beze změny**.

1. **Zjistěte, kde je doména registrovaná** (kde se za `zabavadeti.cz` platí; může to být také
   Český hosting – v jeho administraci https://muj.cesky-hosting.cz pak uvidíte službu „doména“
   zvlášť vedle „webhostingu“). Účet u registrátora je **nejcennější klíč ze všech** (kdo ho ovládne,
   přesměruje web i poštu kamkoliv). Proto tam:
   - zapněte **2FA**, pokud ho registrátor nabízí,
   - zapněte **automatické prodloužení domény** (propadlou doménu může koupit kdokoliv),
   - zkontrolujte **kontaktní e-mail účtu i držitele domény**: musí to být adresa, která zůstane
     (třeba váš Seznam s 2FA), **ne `info@zabavadeti.cz`** – ta v kroku 9 zanikne a chodí na ni
     i kód potřebný k převodu domény,
   - zeptejte se na **blokaci změn / zámek domény** (u `.cz` blokace změny držitele a převodu
     přes CZ.NIC). Zabrání převodu domény bez vašeho vědomí.
2. **Opište si všechny DNS záznamy u Českého hostingu.** V jeho administraci najděte u domény
   správu DNS (záznamy) a uložte si celý seznam (snímek obrazovky nebo export). Hlavně `A`,
   `CNAME`, `MX`, `TXT` (SPF), záznamy `…._domainkey` (DKIM) a jména jako `mail`, `webmail`, `ftp`,
   `autodiscover`. Cloudflare sám najde jen část z nich.
3. **DNSSEC:** pokud ho má doména zapnutý u současného poskytovatele (u `.cz` časté), **vypněte ho
   u registrátora dřív, než změníte nameservery**, a počkejte, až se to projeví (registrátor řekne
   jak dlouho, obvykle hodiny až dny). Jinak by doména na čas úplně přestala fungovat, web i pošta.
   Nový DNSSEC zapnete v kroku 8.
4. V Cloudflare **Add a domain** (**Add a site**) → `zabavadeti.cz` → plán **Free**.
5. Cloudflare načte záznamy. **Porovnejte je se seznamem z bodu 2 a chybějící doplňte.** Všechny
   záznamy nechte zatím na šedém mráčku (**DNS only**), aby se starý web a pošta ničím nezměnily.
   Záznamy pošty (`MX`, `mail`, `webmail`, `autodiscover` …) musí být šedé vždycky.
   Seznam si uložte (**Import and Export** → **Export**).
6. Cloudflare ukáže dva **nameservery**. U registrátora je zadejte místo stávajících. Do 1–2 dnů
   přijde e-mail, že je doména v Cloudflare aktivní.
7. **Kontrola:** starý web se otevírá jako dřív a e-mail poslaný na `info@zabavadeti.cz` dorazí
   (podívejte se do webmailu Českého hostingu).

**Až bude doména aktivní** (Cloudflare → doména):

1. **SSL/TLS** → **Edge Certificates** → **Always Use HTTPS** zapnout, **Minimum TLS Version**
   **TLS 1.2**.
2. Tamtéž **HTTP Strict Transport Security (HSTS)** → **Enable HSTS**: **Max Age** 12 months,
   **No-Sniff header** zapnout, **Preload** vypnuto (krok 11). **includeSubDomains** zapněte jen
   tehdy, když žádná subdoména starého hostingu (`webmail.`, `ftp.` …) nejde otevřít jen přes
   obyčejné HTTP – prohlížeče by ji pak přestaly otevírat. Když si nejste jistá, nechte ho vypnuté
   a zapněte v kroku 10. (Hlavičku HSTS posílá i samotný web, ale jen z `www`; tímto ji dostane
   i holá adresa `zabavadeti.cz`. Cílová hodnota je stejná jako ve webu: 12 měsíců a includeSubDomains.)
3. **Scrape Shield** → **Email Address Obfuscation:** **vypnout**. Ze stejného důvodu nechte vypnuté
   **Rocket Loader** (**Speed** → **Optimization**) a vkládání **Web Analytics**. Cloudflare by jinak
   do stránek vkládal vlastní skripty a web žádné vložené skripty mít nemá.
4. **Security** → **Bots** → **Bot Fight Mode** (i „Super Bot Fight Mode“ a **JavaScript
   Detections**) nechte **vypnuté**. Ukládaly by návštěvníkům cookies a vkládaly skript. Stránka
   Ochrana soukromí s tím nepočítá – kdybyste to změnila, musí se upravit i ona (`privacyMain`
   v `src/render.mjs`).

### 6. Cloudflare Access na administraci

Access se nastavuje **před přepnutím domény**, takže administrace na www.zabavadeti.cz nebude
nikdy volně dostupná.

1. V Cloudflare otevřete **Zero Trust**. Napoprvé zvolíte název týmu (např. `zabavadeti`) a plán
   **Free**. Cloudflare může chtít platební kartu, i když se nic neplatí. Zadáváte ji jen vy.
2. **Settings** → **Authentication** → **Login methods** → **Add new** → **One-time PIN** (kód
   přijde e-mailem). Jiné způsoby přihlášení nepřidávejte.
3. **Access** (nebo **Access controls**) → **Applications** → **Add an application** → **Self-hosted**:
   - **Application name:** `Administrace webu`, **Session Duration:** `24 hours`,
   - **Destinations** (přes **Add public hostname**): `www.zabavadeti.cz` s cestou (path) `admin`,
     `www.zabavadeti.cz` s cestou `api`, `zabavadeti.cz` s cestou `admin`, `zabavadeti.cz` s cestou `api`.
4. **Policy:** název `Jen Lucie`, **Action: Allow**, **Include** → **Emails** → **jen váš e-mail**.
   Nikdy „Everyone“, „Bypass“, „Service Auth“ ani celou doménu e-mailu (např. `@seznam.cz`).
5. Uložte, aplikaci otevřete a do proměnných Pages (prostředí Production) zapište:
   - **Application Audience (AUD) Tag** (dlouhý kód z písmen a číslic) → `ACCESS_AUD`,
   - **Team domain** (Zero Trust → **Settings** → **Custom Pages** nebo **Team domain**, tvar
     `něco.cloudflareaccess.com`) → `ACCESS_TEAM_DOMAIN`.

   Pak **Retry deployment**. Přihlašovací část webu tím sama ověřuje, že každý požadavek prošel
   přes Access; kdyby Access chyběl, nepustí nikoho.
6. **Zamknout `zabavadeti.pages.dev` a náhledy `*.zabavadeti.pages.dev`:**
   1. Projekt Pages → **Settings** → **General** → **Access policy** → **Enable access policy**.
   2. **Manage** → v nové aplikaci v Zero Trust u **Public hostname** smažte z pole **Subdomain**
      hvězdičku `*`, aby zůstalo jen `zabavadeti.pages.dev` (při hlášce o existujícím názvu aplikaci
      přejmenujte). Policy: jen váš e-mail. Uložte.
   3. V projektu Pages zapněte **Enable access policy** znovu. Vznikne aplikace pro
      `*.zabavadeti.pages.dev`; i u ní policy jen váš e-mail.
   4. V Zero Trust → **Applications** jsou teď tři aplikace: `Administrace webu`,
      `zabavadeti.pages.dev` a `*.zabavadeti.pages.dev`.
   5. V anonymním okně ověřte, že `https://zabavadeti.pages.dev/admin/` chce e-mail.

### 7. Přepnutí domény na nový web

V tuto chvíli přestane být starý WordPress na adrese zabavadeti.cz vidět. Pošta na `info@` jede dál
(záznamy pošty se nemění).

1. **Přesměrování `zabavadeti.cz` → `www.zabavadeti.cz`:** **Rules** → **Redirect Rules** →
   **Create rule** → **Custom filter expression** → **Edit expression**:
   `(http.host eq "zabavadeti.cz" and ssl)`. Akce **Dynamic**, výraz
   `concat("https://www.zabavadeti.cz", http.request.uri.path)`, kód **301**, **Preserve query
   string** zapnout. (Část `and ssl` je schválně: `http://zabavadeti.cz` nejdřív převede na HTTPS
   volba Always Use HTTPS a teprve pak se přesměruje na www – to pořadí vyžaduje HSTS preload.)
2. Projekt Pages → **Custom domains** → **Set up a custom domain** → `www.zabavadeti.cz` → potvrdit.
   Cloudflare by měl nabídnout vytvoření nebo úpravu DNS záznamu pro `www` (`CNAME` na
   `zabavadeti.pages.dev`). Pokud starý záznam pro `www` (na Český hosting) zůstane nebo Cloudflare
   ohlásí, že už existuje, smažte v **DNS** → **Records** **jen ten starý záznam pro `www`** (ne
   záznamy pošty) a doménu v Pages potvrďte znovu. Hotovo je, když je u domény v Pages „Active“.
3. Totéž pro `zabavadeti.cz` (bez www).
4. V **DNS** → **Records** zkontrolujte, že `www` i `zabavadeti.cz` míří na Pages a že záznamy
   pošty (`MX`, `mail` atd.) zůstaly beze změny.
5. **Zkouška pošty:** z jiné adresy (např. ze Seznamu) pošlete e-mail na `info@zabavadeti.cz`
   a ve webmailu Českého hostingu ověřte, že dorazil. Když nedorazí, zkontrolujte záznamy pošty
   proti seznamu z kroku 5 (bod 2), nebo se zeptejte Clauda. (Zkouška není potřeba jen tehdy,
   když už máte z kroku 9, bod 1 ověřené, že info@ nikdo a nic nepotřebuje.)

### 8. Ověření, DNSSEC a pojistka kódu

**Ověření** (v anonymním okně prohlížeče):

- `https://www.zabavadeti.cz` – nový web se zámečkem v adresním řádku,
- `http://zabavadeti.cz` – skončí na `https://www.zabavadeti.cz`,
- `https://zabavadeti.cz/admin/` – skončí na `https://www.zabavadeti.cz/admin/` nebo u přihlášení Access,
- `https://www.zabavadeti.cz/admin/` – **musí se objevit přihlášení Cloudflare Access** (žádost o
  e-mail). Když se rovnou ukáže administrace, Access nefunguje – zpět ke kroku 6,
- `https://zabavadeti.pages.dev/admin/` – také chce e-mail.

Pak se přihlaste do administrace (PIN z e-mailu → **Přihlásit pomocí GitHub**), udělejte drobnou
změnu a zveřejněte ji (část D, „Vlastní úpravy“). Za 1–2 minuty ji uvidíte na webu a v Cloudflare
→ **Deployments** je nasazení se zelenou fajfkou. Claude ověří i hlavičky (`curl -sI`) podle
docs/BEZPECNOST.md, „Co ověřit po nasazení“.

**DNSSEC** (brání podvržení adresy webu): Cloudflare → doména → **DNS** → **Settings** →
**Enable DNSSEC**. Zobrazené údaje (DS záznam; u `.cz` se tomu říká **KeySet**) zadejte
u registrátora, často jedním tlačítkem nebo to udělá za vás. Hotovo je, když Cloudflare ukáže
„Success“ / „Active“.

**CAA záznam nepřidávejte.** Přínos je malý a chybný záznam by zablokoval obnovu certifikátu.

**Pojistka kódu (CODE_HASH, „zámek č. 4“, doporučeno):** Cloudflare před každým sestavením ověří,
že se **kód webu nezměnil bez vašeho vědomí**. Změny textů a fotek (`content/*.json`,
`static/uploads/`) projdou vždycky; jakákoli jiná změna (i v dokumentaci, třeba v tomto návodu –
včetně tabulky „Stav“ na začátku části B) nasazení zastaví a na webu zůstane předchozí verze.
Kontrola je v nastavení Cloudflare, kam se přes GitHub nikdo nedostane. Zapněte ji až teď, kdy je
ověřené, že vše funguje (během ladění by se otisk měnil s každou opravou).

**Otisk se počítá jen z verze, kterou jste sama zkontrolovala** – jinak by pojistka „posvětila“
i cizí změnu, která se do GitHubu dostala mezitím. Pořadí je proto vždycky stejné:

1. Claude nahraje svou změnu na GitHub (`git push`) a stáhne aktuální stav (`git fetch origin`).
2. Claude vám ukáže, co je v `origin/main` nového od verze, ke které patří současný otisk
   (`git log --format='%h %an %ad %s' <stará verze>..origin/main` a seznam změněných souborů).
   **Zkontrolujte, že jsou tam jen commity od vás (Claudova údržba pod účtem 11Lucie) a návrhy,
   které jste sama schválila.** Cokoli jiného = nepočítat, postupovat podle části F.
3. Claude ověří, že v kořeni repozitáře není žádný soubor `wrangler.*` (`wrangler.toml`,
   `wrangler.json`, `wrangler.jsonc`): Cloudflare ho čte ještě před Build command a jeho
   proměnné by mohly přepsat ty z nastavení. Build (`scripts/check.mjs`) takový soubor odmítá
   a `node scripts/code-hash.mjs` s ním otisk vůbec nespočítá.
4. Claude spočítá otisk **přesně té zkontrolované verze** (jejího čísla commitu, ne „toho, co je
   zrovna na GitHubu“) tímto výpočtem v Git Bash – je stejný jako v Build command níže, jen místo
   `HEAD` je číslo commitu:

   ```
   git ls-tree -r -z --full-tree <commit> | LC_ALL=C grep -zvE '^100644 blob [0-9a-f]{40,64}[[:blank:]](content/[a-z0-9-]+[.]json|static/uploads/[a-z0-9][a-z0-9._-]*)$' | sha256sum | cut -c1-64
   ```

   Pro kontrolu ho spočítá i `node scripts/code-hash.mjs <commit>`; obě čísla se musí shodovat.
   Dostanete 64 znaků. (Výpočet bere názvy souborů přesně tak, jak jsou – i s mezerami nebo jinými
   neobvyklými znaky –, takže se žádný soubor nemůže z otisku „vytratit“.)
5. Cloudflare → projekt → **Settings** → **Variables and Secrets** → Production → přidejte
   (později přepište) `CODE_HASH` = ten otisk.

Poprvé pak ještě (**nejdřív proměnnou, pak příkaz** – bez proměnné by každé nasazení selhalo):

6. **Settings** → **Build** → **Build command** nahraďte tímto (jeden řádek, zkopírujte celý):

   ```
   H=$(git ls-tree -r -z --full-tree HEAD | LC_ALL=C grep -zvE '^100644 blob [0-9a-f]{40,64}[[:blank:]](content/[a-z0-9-]+[.]json|static/uploads/[a-z0-9][a-z0-9._-]*)$' | sha256sum | cut -c1-64); if [ "$H" != "$CODE_HASH" ]; then echo "Kód webu se změnil bez schválení (otisk $H). Nasazení zastaveno."; exit 1; fi; node build.mjs
   ```

7. **Deployments** → **Retry deployment** a ověřte, že nasazení prošlo (zelená fajfka). Když ne,
   v logu je otisk, který Cloudflare spočítal; ukažte ho Claudovi.

- **Po každé údržbě od Clauda** (kód, administrace, dokumentace) se opakují body 1–5 a pak
  **Retry deployment**. Když to zapomenete, nic se nerozbije – web jen zůstane ve staré verzi
  a zveřejňování textů se zastaví, dokud otisk nepřepíšete.
- Když v logu uvidíte „Kód webu se změnil bez schválení“ a žádnou údržbu jste nedělala, postupujte
  podle části F.

### 9. E-mail na doméně: rozloučení se schránkou info@

Schránka `info@zabavadeti.cz` u Českého hostingu se zruší spolu s hostingem a na doméně pak nebude
žádná pošta. Aby nikdo nemohl posílat podvodné e-maily „od zabavadeti.cz“, doména to ve DNS řekne
všem poštovním serverům. **Od změny DNS (bod 4) přestane info@ přijímat poštu**, proto body 1–3
udělejte dřív, dokud schránka funguje.

1. **Zjistěte, jestli info@ není přihlašovací nebo záchranný e-mail nějaké služby.** Kdyby byl,
   po zrušení schránky by u ní nešlo obnovit heslo a mohla byste o účet přijít. Projděte
   ve webmailu schránku (hledejte „heslo“, „password“, „ověření“, „registrace“, „welcome“) a
   zkontrolujte hlavně:
   - **registrátora a kontakt držitele domény** (krok 5, bod 1) – nejdůležitější,
   - účet u **Českého hostingu**,
   - **Facebook** (stránka a účet, přes který se spravuje), **Google** (firemní profil, YouTube),
     **Firmy.cz / Seznam**, Instagram, katalogy a rezervační služby,
   - GitHub, Cloudflare, banku, pojišťovnu, úřady (pokud tam Ivona info@ uváděla).

   Kde info@ najdete, změňte e-mail na adresu, která zůstane (potvrzovací e-mail ještě dorazí do
   info@). Na web se info@ neuvádí (web používá Ivonin Seznam).
2. **Exportujte poštu**, kterou chcete mít: ve webmailu nebo v poštovním programu (Thunderbird,
   Outlook – připojit schránku přes IMAP a zkopírovat zprávy do místní složky). Zprávy z WordPressu
   můžou obsahovat osobní údaje zákazníků: uložte je bezpečně (ne do projektu, repozitář je
   veřejný) a nepotřebné smažte.
3. Kdyby se ukázalo, že adresu info@ potřebujete dál, nepokračujte a zeptejte se Clauda (Cloudflare
   umí zdarma přeposílat poštu z domény na jinou adresu).
4. **DNS** (Cloudflare → **DNS** → **Records**): smažte staré záznamy pošty – `MX`, staré SPF
   (`TXT` začínající `v=spf1`), DKIM (`…._domainkey`), staré DMARC (`_dmarc`) a `mail`, `webmail`,
   `smtp`, `pop`, `imap`, `autoconfig`, `autodiscover`. Pak přidejte (**Add record**):

   | Typ | Name | Obsah | Význam |
   |---|---|---|---|
   | `MX` | `@` | mail server `.` (tečka), priorita `0` | „Na tuhle doménu poštu nedoručujte.“ |
   | `TXT` | `@` | `v=spf1 -all` | „Z této domény se žádné e-maily neposílají.“ |
   | `TXT` | `_dmarc` | `v=DMARC1; p=reject;` | „Kdyby přece jen nějaký přišel, zahoďte ho.“ |

   Staré záznamy pošty mažte **dřív**, než přidáte nové: na doméně smí být jen jeden SPF a jeden
   DMARC (dva najednou poštovní servery berou jako chybu a neplatí pak ani jeden) a „prázdný“ `MX`
   s tečkou musí být jediný `MX`. A žádný starý `MX` nesmí zůstat ukazovat na zrušený hosting –
   kdo by si tam později založil schránku pro @zabavadeti.cz, mohl by přijímat poštu pro tuto
   doménu (třeba obnovu hesla).

### 10. Záloha a zrušení hostingu u Českého hostingu

**Dokud starý WordPress někde běží, je to díra**, i když na něj doména už neukazuje. Neaktualizovaný
WordPress je nejčastější cíl automatických útoků a útočník ho najde i podle IP adresy hostingu.

1. **Počkejte pár dní** po kroku 7, jestli nový web funguje.
2. **Zálohujte WordPress** (soubory + databáze). V administraci Českého hostingu hledejte u
   webhostingu „zálohy“ / „backup“, případně soubory přes FTP a databázi přes phpMyAdmin (export),
   nebo požádejte podporu. Zkontrolujte, že záloha jde otevřít a že máte **všechny fotky** (složka
   `wp-content/uploads`). I databáze může obsahovat osobní údaje (zprávy z formuláře, komentáře):
   ukládejte ji bezpečně, mimo projekt.
3. Fotky, které chcete na novém webu, nahrajte přes administraci, nebo je předejte Claudovi.
   **Fotky, které Claude nahrává přímo (ne přes administraci), musí před nahráním zbavit polohy a
   jiných metadat** (`magick mogrify -strip`) a zkontrolovat příkazem `node scripts/check.mjs`.
4. **Smažte instalaci WordPressu** (soubory i databázi) – web nebude zranitelný ani do konce
   zaplaceného období. Udělejte to **před úklidem DNS** (bod 5): přístupy jako `ftp.zabavadeti.cz`
   nebo správa souborů hostingu mohou záviset právě na záznamech, které se v bodě 5 mažou.
5. **Ukliďte DNS** (Cloudflare → **DNS** → **Records**): smažte všechny záznamy, které ukazují na
   starý hosting (jeho IP adresu nebo jména jako `…cesky-hosting.cz`), hlavně `*` (hvězdička),
   `ftp`, `cpanel` a staré `A`/`AAAA`. Ponechte jen: záznamy `www` a `zabavadeti.cz` od Pages,
   ochranu pošty z kroku 9 a ověřovací `TXT` služeb, které dál používáte (když si nejste jistá,
   zeptejte se Clauda). Proč: záznam na zrušený hosting může „ožít“ – kdo si tu adresu později
   pronajme, mohl by pod jménem zabavadeti.cz provozovat podvodnou stránku. Seznam si exportujte.
6. **Zrušte hosting.** V administraci Českého hostingu (https://muj.cesky-hosting.cz) si nejdřív
   ujasněte, jaké služby tam máte:
   - **webhosting** (prostor pro web a poštu) → ten se **ruší**,
   - **doména** (registrace `zabavadeti.cz`) → ta **zůstává**. Pokud je doména placená jako součást
     hostingu (např. „doména zdarma k hostingu“), zjistěte nejdřív (i u podpory), jak ji zachovat –
     zrušení hostingu nesmí zrušit doménu.
   - U hostingu hledejte **výpovědní lhůtu** a **automatické prodloužení** (vypnout, aby se znovu
     nezaplatil). U domény naopak automatické prodloužení **nechte zapnuté**.
   - Účet u Českého hostingu nerušte, pokud je u něj doména. Jeho kontaktní e-mail nesmí být info@.
7. Pokud jste v kroku 5 nechala u HSTS v Cloudflare vypnuté **includeSubDomains**, teď ho zapněte.

### 11. Za měsíc: HSTS preload (volitelné, nevratné na dlouho)

Web i Cloudflare posílají prohlížečům příkaz „choď sem jen přes HTTPS“. Zápis do seznamu
zabudovaného přímo v prohlížečích (https://hstspreload.org) ho ještě zpevní. **Vyřazení ze seznamu
trvá měsíce** a celou dobu by doména i všechny subdomény šly jen přes HTTPS. Nejdřív po měsíci
bez problémů a po kroku 10:

1. V Cloudflare HSTS (krok 5) musí být zapnuté **includeSubDomains**; teď zapněte i **Preload**.
2. Claude doplní do `headers/site.txt` `; preload` (hodnota musí zůstat stejná jako v Cloudflare;
   je to změna kódu, takže pak nový `CODE_HASH`).
3. Claude ověří `curl -sI http://zabavadeti.cz` (přesměrování na `https://zabavadeti.cz/`) a
   `curl -sI https://zabavadeti.cz` (hlavička `Strict-Transport-Security` s `preload`).
4. Na https://hstspreload.org zadejte **`zabavadeti.cz`** (bez www), jen když kontrola projde bez chyb.

### 12. Pokud by Ivona někdy chtěla upravovat sama (volitelné)

Teď to není potřeba. Kdyby to Ivona chtěla:

1. **Ivona** si na https://github.com založí účet (vlastní e-mail, silné heslo, které nepoužívá
   jinde), **zapne 2FA** (nejlépe passkey nebo GitHub Mobile), uloží si záchranné kódy, **zapne 2FA
   i na e-mailu** (chodí na něj PIN), zaškrtne **Settings** → **Emails** → **Keep my email
   addresses private** (jinak by se její e-mail objevil ve veřejné historii každé její úpravy)
   a pošle Lucii své **uživatelské jméno** na GitHubu.
   Vynutit 2FA u osobního repozitáře nejde (jen u organizací), proto si to u ní ověřte.
2. **Lucie** v repozitáři: **Settings** → **Collaborators** → **Add people** → Ivonino jméno →
   role **Write** (Ivona přijme pozvánku z e-mailu). Díky pravidlům z kroku 3 sama nic nezveřejní.
   **Nikdy jí nedávejte roli Admin** (admin může pravidla vypnout).
3. **Lucie** v Cloudflare: `ALLOWED_GITHUB_USERS` = `11Lucie,ivonino-jmeno` (oddělené čárkou)
   → **Retry deployment** (nový `CODE_HASH` není potřeba, proměnné do otisku nepatří).
4. **Lucie** v Zero Trust: v policy aplikace `Administrace webu` přidat Ivonin e-mail (u aplikací
   pro `pages.dev` jen pokud chcete).
5. Společně vyzkoušejte, že Ivona uloží návrh a vy ho vidíte ke schválení (část D, „Návrhy od Ivony“).

Kdyby si Ivona změnila uživatelské jméno na GitHubu, je potřeba ho změnit i v `ALLOWED_GITHUB_USERS`.

**Když spolupráce skončí:**

1. **Nejdřív** ji odeberte z **Collaborators** (to jí bere přístup k repozitáři; samotné odebrání
   z `ALLOWED_GITHUB_USERS` nebo Access nestačí, už vydaný token GitHubu ještě až 8 hodin platí).
   Zkontrolujte, že tam není ani nevyřízená pozvánka.
2. Pak ji odeberte z `ALLOWED_GITHUB_USERS` (→ **Retry deployment**) a z Access policy.
3. Ivona si může na GitHubu v **Settings** → **Applications** → **Authorized OAuth Apps** u
   aplikace administrace kliknout na **Revoke**.
4. Při podezření na zneužití postupujte podle části F.

---

## C) Jak upravovat web

Teď podle této části upravuje web Lucie. Kdyby Ivona dostala účet (krok B12), platí i pro ni.

### Přihlášení

1. Otevřete **https://www.zabavadeti.cz/admin/** (nejlépe si ji uložte do záložek).
2. Objeví se okno Cloudflare. Napište svůj e-mail a nechte si poslat kód.
3. Do e-mailu přijde **šestimístný kód (PIN)**. Opište ho. Platí jen chvíli.
4. Klikněte na **Přihlásit pomocí GitHub**. V okně GitHubu: jméno, heslo a **kód z mobilu** (2FA).
   Napoprvé GitHub požádá o povolení pro aplikaci administrace → **Authorize**.
5. Hláška „Přihlášení nejde spustit z jiné stránky“: zavřete okno a klikněte na přihlášení ještě
   jednou (stává se to po vypršení přihlášení k Cloudflare).
6. **Přihlášení platí nejvýš 8 hodin.** Když administrace po delší době začne hlásit chyby při
   načítání nebo ukládání, odhlaste se (**Odhlásit**, vpravo nahoře) a přihlaste znovu. Delší práci
   ukládejte průběžně.

**Bezpečnost:**

- Heslo a kód z mobilu zadávejte jen na stránce, jejíž adresa začíná `https://github.com/`.
  Kdo píše nebo volá, že „potřebuje váš kód“, je podvodník.
- Po práci se v administraci **odhlaste** a administraci otevírejte jen na vlastním počítači.
- E-mail o „bezpečnostní chybě na webu“ neotvírejte a přepošlete ho beze změny Lucii.

### Úprava textu

1. Vlevo vyberte stránku (Základní nastavení webu, Úvod, Co nabízím (služby), O mně, Reference,
   Kontakt, Provozovatel).
2. Upravte text v políčkách. Píše se **obyčejný text**, bez značek nebo kódu (třeba `<b>` se na
   webu zobrazí tak, jak je napsané). Když je text moc dlouhý, administrace to řekne.
3. Nahoře klikněte na **Uložit**. Tím se uloží **návrh** (koncept), na webu se ještě nic nemění.
4. Zveřejnění: Lucie podle části D („Vlastní úpravy“). Ivona přepne stav návrhu na **V revizi**
   (u tlačítka stavu nahoře), aby Lucie poznala, že je hotový; tlačítko **Publikovat** u ní skončí
   chybou – zveřejňuje jen Lucie, schválně.

### Fotky

- **Fotky nahrávejte jen přes pole fotky v otevřené stránce** (Úvod, O mně nebo u služby), **nikdy
  v záložce „Média“** nahoře. Nahrání v Médiích se neuloží jako návrh, ale přímo na web (u Ivony
  skončí chybou).
- **Každé nové fotce dejte nový název**, ideálně s datem, např. `oslava-2026-11.jpg`. Když se
  administrace zeptá, jestli soubor „already exists… replace?“ (už existuje, přepsat?), klikněte
  na **Zrušit** a fotku přejmenujte.
- **V administraci fotky nemažte.** Když se objeví chyba při ukládání nebo mazání fotky, napište
  Lucii (Lucie: část D, „Pozor na fotky“).
- Povolené jsou jen **JPG, PNG a WEBP**, **do 5 MB** jedna fotka, **název bez diakritiky a mezer**,
  malými písmeny, např. `oslava-narozenin.jpg`. Web jiné názvy odmítne.
- **Fotky z mobilu v sobě často nesou polohu** (GPS), takže můžou prozradit adresu. Před nahráním
  vypněte v mobilu ukládání polohy do fotek, nebo ji vypněte při sdílení (iPhone: **Možnosti** →
  **Poloha**), nebo fotku upravte v aplikaci, která polohu maže. Na to, že to web vyřeší sám,
  nespoléhejte.
- **Fotky cizích dětí jen se souhlasem rodičů** (ideálně písemným; GDPR). Bezpečnější jsou fotky,
  na kterých děti nejdou poznat (zezadu, detail malování na obličej).
- **Co jednou nahrajete, zůstává na GitHubu navždy**, i když to později smažete nebo návrh zahodíte.

### Fotka u služby

1. Otevřete **Co nabízím (služby)** a rozklikněte službu (např. „Maskoti na vaši akci“).
2. V poli **Fotka služby** nahrajte fotku (platí pravidla výše). Služba se na webu ukáže jako
   **velká karta s fotkou** na začátku nabídky (ikona zůstane malá přímo na fotce).
3. Vyplňte **Popis fotky** – jednou větou, co je na ní. **Bez popisu administrace návrh neuloží**
   („Neuloženo: … má fotku, ale chybí popis fotky“).
4. Ikonu nechte vybranou: použije se i tehdy, když fotku později odeberete (tlačítko u pole fotky;
   popis pak smažte).

### Údaje provozovatele

- Stránka **Provozovatel (povinné údaje)**: jméno, IČO, adresa, zápis v rejstříku, živnostenský
  úřad (teď Městský úřad Velké Meziříčí – na stránce Ochrana soukromí jako úřad, který na
  podnikání dohlíží) a e-mail pro dotazy k osobním údajům. Zobrazují se v patičce a na stránce
  **Ochrana soukromí a cookies**, jak vyžaduje zákon. Měňte je jen při skutečné změně.
- **IČO se kontroluje** (8 číslic a kontrolní číslice). Při překlepu administrace neuloží a ukáže
  „Neuloženo: IČO … není platné“. Opište ho znovu z živnostenského listu.
- Text stránky Ochrana soukromí v administraci není – web ho skládá sám. Kdyby web měl začít
  používat něco nového (formulář, rezervační systém, Google Analytics, vložený příspěvek
  z Facebooku), řekněte nejdřív Claudovi – text by se musel upravit.
- Odkaz na Facebook a větu na jeho kartě v části Kontakt změníte v **Základním nastavení webu**.

### Reference

- Jen reference od **skutečných zákazníků**, se kterými autor souhlasí. Nevymýšlet a neměnit smysl
  (zkrátit nebo opravit překlep je v pořádku).
- Pod referencemi se malým písmem zobrazuje text z pole **Odkud reference pocházejí**. Vyžaduje ho
  zákon o ochraně spotřebitele a **musí odpovídat pravdě**. Když se způsob získávání referencí
  změní (třeba převzetí hodnocení z Facebooku), text upravte.

### Když si nevíte rady

Nic nerozbijete. Dokud se návrh nezveřejní, web zůstává, jak byl. Lucie se zeptá Clauda, Ivona napíše Lucii.

---

## D) Jak schvalovat a zveřejňovat (pro Lucii)

### Vlastní úpravy v administraci

1. Po uložení (část C) přepněte stav návrhu na **Připraveno** (u tlačítka stavu; bez toho
   administrace hlásí „Změňte stav na „Připraveno“ před publikováním“).
2. **Publikovat** → **Publikovat teď**, a to **ve stejném okně (záložce) prohlížeče, ve kterém jste
   návrh uložila**. Pojistka si při uložení zapamatovala přesně ten commit a zveřejní jen ho.
3. Za 1–2 minuty zkontrolujte web a v Cloudflare → **Deployments**, že nasazení prošlo.

Návrhy **nenechávejte otevřené**: uložte a hned zveřejněte.

Když administrace zůstane jen na textu „Načítám administraci…“, nenačetla se pojistka a
administrace se proto záměrně nespustila. Obnovte stránku (Ctrl+F5); když to nepomůže, řekněte Claudovi.

**Co znamenají hlášky pojistky („Zveřejnění zastaveno: …“):**

- **„… tento návrh jste v tomto okně administrace neuložila …“** – pojistka neví, co v návrhu je.
  - **Návrh od Ivony** (nebo kohokoli jiného) zveřejněte **jen na GitHubu** podle postupu níže.
  - **Váš vlastní návrh a mezitím jste zavřela okno:** nejdřív na GitHubu otevřete jeho Pull request
    → **Commits**: **všechny musí být vaše** (nebo od administrace vaším jménem). Cizí commit = nic
    nedělat a říct Claudovi. Teprve pak návrh v administraci otevřete, uložte (klidně s drobnou
    úpravou) a hned zveřejněte. Nové uložení totiž převezme i všechno, co už ve větvi návrhu je.
- **„… návrh se od vašeho posledního uložení změnil …“** – do návrhu někdo něco přidal nebo ho
  přepsal. **Nezveřejňujte ho**, podívejte se na GitHubu na **Commits** a **Files changed**, a když
  změnu nepoznáte, řekněte Claudovi.
- **„… mění i jiné soubory než text této stránky a nové fotky …“** – to se přes administraci vůbec
  nedá udělat. Nezveřejňujte a řekněte Claudovi (část F).
- **„… sloučení návrhu neprošlo kontrolou pojistky …“** / **„… návrh se během kontroly změnil“** –
  na GitHub se nic neodeslalo. Zkontrolujte návrh na GitHubu (Files changed a Commits).
- **„Neuloženo: …“** při ukládání – v textu je chyba, kterou by web nesestavil (neplatné IČO, fotka
  služby bez popisu, chybějící text o původu referencí). Opravte ji a uložte znovu.

**Pozor na fotky v administraci:** záložka **Média** a mazání fotky v okně pro výběr fotky ukládají
**přímo na web, bez návrhu**.
- Nemažte fotky, které web používá, a nepřepisujte je souborem se stejným názvem. Příští sestavení
  by selhalo a web by zůstal ve staré verzi.
- Oprava: na GitHubu u commitu „Smazání obrázku: …“ udělejte **Revert** (nebo požádejte Clauda).
- Staré nepoužívané fotky nechte uklidit Clauda.

**Dva návrhy mění stejnou stránku:** zveřejňujte je postupně. Kdyby se v historii `main` objevil
commit „Automatically generated. Merged on Decap CMS / Force merge of: …“, administrace návrh
„přetlačila“ a mohla přepsat dřívější změnu. Zkontrolujte web a případně změnu vraťte.

### Návrhy od Ivony nebo od kohokoli jiného: jen na GitHubu

Dokud Ivona nemá účet, žádné takové návrhy nečekejte. **Návrh, který jste nečekala** (cizí jméno,
návrh z „forku“, podivný název), **zavřete bez sloučení** (**Close pull request**) a větev smažte.

Proč jen na GitHubu: tlačítko **Publikovat** v administraci sloučí **celou větev návrhu**, i soubory,
které v administraci nejsou vidět (kód webu). Vy máte výjimku z pravidel (krok B3), takže GitHub se
nic dalšího neptá. Kdyby Ivoně někdo ukradl účet, mohl by do jejího návrhu přidat škodlivý kód.
Pojistka v administraci proto návrh, který jste sama neuložila, zveřejnit nedovolí.

Každý návrh je na GitHubu jako **Pull request** (záložka **Pull requests**). V administraci ho
najdete v části **Schvalování** – tam si přečtete texty a prohlédnete fotky (pozor na fotky dětí
a polohu, část C).

1. Na GitHubu otevřete Pull request → záložka **Files changed**. **Smí se měnit jen** soubory
   `content/….json` a fotky `static/uploads/….jpg` (`.jpeg`, `.png`, `.webp`). Cokoli jiného
   (`functions/`, `static/admin/`, `build.mjs`, `headers/`, `.github/`, `package.json`, soubor
   začínající podtržítkem, **`wrangler.toml` / `.json` / `.jsonc`**, `.npmrc`, `package-lock.json`,
   `yarn.lock`, `bun.lockb` …), **„Symbolic link“**, změna práv souboru nebo **přepsaná či smazaná
   existující fotka** = **neschvalovat** a zeptat se Clauda. Může jít o ukradený účet.
   Změnu v `content/provozovatel.json` si s Ivonou vždy ověřte (údaje vyžaduje zákon).
2. Záložka **Commits**: všechny změny mají být od Ivony (nebo od administrace jejím jménem) a
   poslední commit je ten, který jste právě zkontrolovala.
3. **Review changes** → **Approve** → **Submit review**.
4. **Hned potom** na téže stránce **Merge pull request** (nebo **Squash and merge**) → **Confirm merge**.
   - **Nikdy nezaškrtávejte „Merge without waiting for requirements to be met (bypass rules)“.**
     Když se objeví, vaše schválení už neplatí (nejčastěji do návrhu po kontrole přibyl commit).
     Nic neslučujte a začněte znovu od bodu 1. Totéž, když uvidíte nový commit.
   - GitHub sloučení někdy odmítne sám („Head branch was modified“). **Spoléhat se na to nedá:**
     jako majitelka máte výjimku a „bypass“ vám dovolí. Rozhoduje vaše kontrola.
5. Za 1–2 minuty zkontrolujte v Cloudflare → **Deployments**, že nasazení prošlo. Když selhalo,
   v logu je česky proč; změnu vraťte (níže) nebo se zeptejte Clauda.

### Vrácení změny

- **Nejrychleji (během minuty):** Cloudflare → **Workers & Pages** → projekt → **Deployments** →
  u předchozího dobrého nasazení **⋯** → **Rollback to this deployment**. Při příštím zveřejnění se
  ale nasadí aktuální stav z GitHubu, takže chybnou změnu vraťte i tam.
- **Natrvalo:** na GitHubu zveřejněný Pull request → **Revert** → vznikne nový Pull request →
  **Merge pull request**. Nebo požádejte Clauda.
- Chyba sestavení „soubor … ve složce static/uploads neexistuje“ = smazala se fotka, kterou web
  používá. Vraťte to smazání (Revert).

---

## E) Údržba a pravidelné kontroly

**Jednou za měsíc (5 minut, stačí říct Claudovi „udělej zálohu webu“):**

- Claude stáhne aktuální stav z GitHubu (`git fetch origin` a `git pull --ff-only`) a uloží
  neměnný snímek celého repozitáře včetně neschválených návrhů:
  `git bundle create zabavadeti-RRRR-MM-DD.bundle --all` (ověří ho `git bundle verify`).
  Kdyby `git pull --ff-only` selhal, někdo přepsal historii na GitHubu – to je důvod k části F,
  ne k „vynucení“.
- Snímek uložte **mimo GitHub i mimo počítač** (externí disk nebo soukromé úložiště, nikdy ne do
  veřejného repozitáře). Nechte si několik posledních.

**Jednou za čtvrt roku (20 minut):**

- GitHub → repozitář → **Settings** → **Collaborators**: jen lidé, kteří tam mají být (teď nikdo),
  žádná nevyřízená pozvánka.
- **Rules** → **Rulesets**: pravidlo **Active**, v **Bypass list** jen **Repository admin**,
  v „Require a pull request“ všechny čtyři volby z kroku B3.
- **Deploy keys**, **Webhooks**, **GitHub Apps** (**Integrations**): nic neznámého (Cloudflare jen
  s přístupem k tomuto repozitáři); **Actions** pořád vypnuté.
- Vaše **Settings** → **SSH and GPG keys**, **Developer settings** → **Personal access tokens**,
  **Applications** (**Authorized OAuth Apps** i **Authorized GitHub Apps**): znáte všechno?
- **Developer settings** → **OAuth Apps** → aplikace administrace: jediná callback adresa
  `https://www.zabavadeti.cz/api/callback`, wildcard matching vypnuté, **Expire user access tokens**
  zapnuté. Pak tamtéž **Revoke all user tokens** (preventivně; jen se znovu přihlásíte).
- Cloudflare → `ALLOWED_GITHUB_USERS` (teď jen `11Lucie`) a Zero Trust → policy: jen aktuální lidé?
- Cloudflare → Pages → **Settings**: **Build command** je pojistka z kroku B8 (nebo `node build.mjs`),
  **Preview branch** je **None**, v **Variables** jen proměnné z kroku B4 (`OAUTH_SCOPE` ani
  `ALLOWED_ORIGINS` tam nejsou).
- Zero Trust → **Login methods** jen One-time PIN; **Applications** jen tři z kroku B6 a jejich
  policy pouští jen váš e-mail (a Ivonin, pokud jste ji přidala).
- Cloudflare → **Manage Account** → **Members**: jen vy? **My Profile** → **API Tokens**: žádné neznámé.
- Cloudflare → **DNS** → **Records**: jen známé záznamy (Pages pro www a zabavadeti.cz, ochrana
  pošty, případné ověřovací TXT)? Žádná `*` ani záznam na starý hosting? Seznam exportujte k zálohám.
- U registrátora: doména se automaticky prodlužuje, kontaktní e-mail platí (a není info@).

**Jednou za půl roku:**

- Aktualizovat administraci (Decap CMS) podle [docs/VENDOR.md](docs/VENDOR.md). Stačí říct Claudovi
  „aktualizuj Decap podle docs/VENDOR.md“ (pak nový `CODE_HASH`).
- Na https://securityheaders.com a https://observatory.mozilla.org zadat `https://www.zabavadeti.cz`.
  Pokud známka výrazně klesla, řekněte Claudovi.

**Jednou za rok:**

- Prodloužit datum **Expires** v `security.txt` (https://www.zabavadeti.cz/.well-known/security.txt,
  teď do 25. 11. 2027). Bez platného data kontakt pro hlášení chyb neplatí. Stačí říct Claudovi.
- Vyzkoušet, že máte záchranné kódy k GitHubu, Cloudflare a e-mailu a víte, kde jsou.

---

## F) Co dělat při podezření na útok

Příznaky: na webu je něco, co nikdo nepsal; přišel e-mail o přihlášení, které jste nedělala;
na GitHubu je návrh nebo změna, o které nevíte; nasazení hlásí „Kód webu se změnil bez schválení“.

Postupujte v tomto pořadí, nic z toho nic nerozbije:

1. **Vrátit web hned:** Cloudflare → **Deployments** → **Rollback to this deployment** u posledního
   dobrého nasazení (část D).
2. **Zavřít přístupy** (útočník si mohl nechat „zadní vrátka“, proto projděte všechno):
   - **Hesla a 2FA:** změňte hesla ke GitHubu, Cloudflare, e-mailu (chodí přes něj PINy) a
     k registrátorovi. Zkontrolujte 2FA (nikdo nepřidal vlastní telefon, klíč nebo passkey),
     e-mailové adresy u účtů a odhlaste neznámá zařízení (GitHub → **Password and authentication**
     a **Sessions**). V e-mailu zkontrolujte pravidla přeposílání a filtry.
   - **GitHub – váš účet:** **SSH and GPG keys**, **Personal access tokens** (classic i
     fine-grained), **Authorized OAuth Apps** a **Authorized GitHub Apps**: smažte, co nepoznáváte.
   - **GitHub – repozitář:** **Collaborators**, **Deploy keys**, **Webhooks**, **GitHub Apps**
     (Cloudflare jen s „Only select repositories“), **Actions** vypnuté, ruleset **Active**,
     v **Bypass list** jen **Repository admin**, všechna pravidla zaškrtnutá.
   - **Přihlašovací aplikace (OAuth App):** callback jen `https://www.zabavadeti.cz/api/callback`;
     **Revoke all user tokens** (odhlásí všechny); **Generate a new client secret**, nový vložit do
     Cloudflare (`GITHUB_CLIENT_SECRET`), **všechny ostatní** secrety smazat → **Retry deployment**.
   - **Cloudflare:** **Members**, **API Tokens**, **Audit log** (co se kdy měnilo).
   - **Cloudflare Pages:** **Build command** (pojistka z B8), výstup `dist`, **Preview branch** = None,
     **Variables** jen ty z kroku B4 (`OAUTH_SCOPE` ani `ALLOWED_ORIGINS` tam nejsou, `CODE_HASH`
     odpovídá otisku, který vám spočítá Claude), Access policy na náhledech.
   - **Zero Trust:** **Login methods** jen One-time PIN; všechny **Applications** a jejich policy
     (Allow jen pro váš e-mail, případně Ivonin; žádné Bypass, Service Auth ani Everyone);
     **Service tokens** žádné.
   - `ALLOWED_GITHUB_USERS`: jen `11Lucie` → **Retry deployment**.
   - **DNS:** žádné neznámé záznamy (třeba nová subdoména); DNSSEC zapnutý.
   - **Registrátor:** nameservery jsou pořád ty od Cloudflare, kontaktní údaje sedí, zámek domény platí.
   - Pokud může být napadený **váš počítač**: u **Authorized OAuth Apps** odvolejte i „Git Credential
     Manager“ a znovu se přihlaste až po vyčištění počítače.
3. **Znovu zkontrolovat Deployments** a případně zopakovat Rollback (útočník mohl první vrácení
   mezitím přepsat).
4. **Zkontrolovat a opravit obsah:** GitHub → **Commits** a **Pull requests** → co se změnilo a kdo
   to udělal. Ať Claude porovná `main` na GitHubu se zálohou v počítači (`git fetch`; „forced update“
   = přepsaná historie, Claude umí vrátit správný stav). Cizí návrhy zavřete, větve `cms/…` smažte,
   opravu udělejte přes **Revert** (část D).
5. **Smazaný repozitář** jde do 90 dnů obnovit (GitHub → vaše **Settings** → **Repositories** →
   **Deleted repositories**). Jinak ho Claude obnoví z posledního snímku (`git clone zabavadeti-….bundle`).
6. Citlivý nebo nezákonný obsah, který zůstal v historii veřejného repozitáře: požádejte GitHub
   Support o odstranění (sensitive data removal).
7. Požádejte Clauda o pomoc a popište mu, co jste viděla.

---

## G) Poctivě: co zabezpečení neřeší

Stoprocentní bezpečnost neexistuje. Tahle sestava odstraňuje celé skupiny útoků, na které
WordPress běžně doplácí (zranitelné pluginy, databáze, hádání hesel). Zbývá ale pár věcí:

- **Podvodné e-maily a falešné přihlašovací stránky (phishing).** Útočník se může pokusit vylákat
  heslo i kód z mobilu. Nejlepší obranou je **passkey** a zadávat heslo jen na `github.com`.
  Access chrání jen administraci, na GitHubu ne.
- **Účet u registrátora domény a váš e-mail.** Kdo ovládne tyhle dva, může převzít doménu nebo si
  nechat poslat PIN. Proto 2FA i tam (kroky B1 a B5) a kontaktní e-mail domény mimo info@ (krok B9).
- **Váš počítač.** Zavirovaný počítač vidí útočník stejně jako vy. Přihlášení ke GitHubu uložené
  v počítači (Claude přes něj nahrává údržbu) má vaši výjimku z pravidel, takže umí zveřejnit přímo.
  Počítač chraňte (aktualizace, šifrovaný disk, zámek obrazovky, žádný sdílený účet).
- **Oprávnění přihlášení přes GitHub je širší, než by bylo ideální.** Přihlášení do administrace
  uloží v prohlížeči klíč (token), který umí zapisovat do všech vašich **veřejných** repozitářů,
  ne jen do tohoto, a funguje přímo proti GitHubu, i bez Access. Díky volbě **Expire user access
  tokens** platí nejvýš 8 hodin (obnovovací klíč přihlašovací část webu zahodí a do prohlížeče ho
  nepošle). Odhlášení v administraci ho jen smaže z prohlížeče; zrušit ho dřív jde na GitHubu
  (Revoke, části E a F). Proto administraci otevírejte jen na vlastním počítači a po práci se
  odhlaste. Úzké oprávnění jen na tento repozitář by umožnila „GitHub App“ místo dnešní „OAuth App“
  – změnu je potřeba nejdřív vyzkoušet (zeptejte se Clauda).
- **Výpadek GitHubu nebo Cloudflare.** Web pak nemusí jít upravit, výjimečně ani zobrazit. Data
  nezmizí: celý web je na GitHubu a v pravidelných zálohách (část E).
- **Přetížení webu (DDoS)** řeší Cloudflare. U velkých útoků by se web mohl na chvíli zpomalit.
- **Obsah samotný.** Technika neohlídá, jestli je fotka dítěte zveřejněná se souhlasem nebo jestli
  je v textu chyba. To je na lidech.
- **Lidské chyby v nastavení.** Kde to jde, web selže „bezpečně“: bez `ALLOWED_GITHUB_USERS` nebo
  bez nastavení Access nepustí do administrace nikoho, bez správného `CODE_HASH` se nic nenasadí.
  Vypnutý ruleset ale technika nepozná. Proto čtvrtletní kontrola (část E).
- **Zapomenutá služba na info@.** Když se v kroku B9 nějaká služba přehlédne, nepůjde u ní po
  zrušení schránky obnovit heslo. Proto se před zrušením schránka pečlivě projde.
