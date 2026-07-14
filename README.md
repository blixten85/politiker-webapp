# Politiker-webapp

Gratis verktyg där medborgare kan skapa konto, koppla sitt **eget** mailkonto
(Gmail/Outlook/iCloud/Yahoo/generisk SMTP, eller logga in passwordlöst med
Microsoft Graph), välja vilka folkvalda de vill kontakta, och skicka
personaliserade brev — utan att plattformen själv blir avsändare. Live på
[politiker.denied.se](https://politiker.denied.se).

## Vilka politiker finns med?

- **EU**: alla 718 ledamöter i Europaparlamentet, samtliga 27 medlemsländer, med parti
- **Riksdagen**: alla 349 nuvarande ledamöter, med parti
- **Regeringen**: 11 departement (registratorsadresser — inga personliga mailadresser till statsråd finns/publiceras)
- **Region**: alla 21 regioner
- **Kommun**: alla 290 kommuner
- **Svenska kyrkan**: kyrkovalda i kyrkostyrelsen, kyrkomötets presidium och Uppsala stiftsstyrelse (de organ som publicerar personliga mailadresser), med nomineringsgrupp

För kommun/region är parti och befattning (t.ex. "Ordförande") tillagt
där det går att fastställa — antingen direkt vid skrapning (mailto/troman/
netpublicator, ~94% av kommunerna) eller via matchning mot Valmyndighetens
öppna data om nuvarande ledamöter. Se `politiker-kontakter`-repot för
skrapningslogiken.

## Funktioner

- **Konto**: e-post+lösenord eller OAuth-inloggning (Google, GitHub, Microsoft), TOTP 2FA, glömt lösenord, länka fler inloggningssätt till samma konto efteråt
- **Mailkoppling**: Gmail/Outlook/iCloud/Yahoo/generisk SMTP, eller Microsoft Graph utan lösenord — med ett hårdkodat säkerhetstak (10% under leverantörens kända gräns) som användaren själv kan sänka ytterligare
- **3-stegs wizard** (mottagare → brev → granska): nivåerna (EU/riksdag/regering/region/kommun/Svenska kyrkan) väljs via stora kort med levande mottagarantal (exakt, server-deduperat via `/api/recipients/count`). En framträdande **namnsökning** högst upp låter användaren hitta en enskild politiker och rikta till eller utesluta hen. Detaljerad filtrering (enskilda områden, befattning, parti-uteslutning) ligger bakom en hopfällbar "Avancerat"-sektion — stora grupper (>30 områden) hopfällda från start, sökning forcerar alltid utfällt. Befattningar grupperas kanoniskt (allt ordförande-aktigt inkl. vice → "Ordförande"; Ledamot/Ersättare/Gruppledare) så samma roll inte listas per stavningsvariant — nivå väljs genom att kombinera befattning med områdesfiltret.
- **AI-brevutkast** (valfritt): beskriv ett ämne (eller låt AI:n själv hitta ett aktuellt) — researchar via riktig websökning och föreslår ett utkast som användaren läser igenom, redigerar och skickar under eget namn, inget skickas automatiskt
- **Brev**: HTML/textredigerare, ämnesrad (full åäö/UTF-8-stöd), bilagor (PDF/txt/doc/docx, automatisk konvertering till brevtext)
- **Rate limiting per mailkonto**: en Durable Object per mailkoppling ger sann delad sändningstakt mellan parallella utskick mot samma konto — väntar in en ledig "token" istället för att riskera leverantörens spärr. Olika mailkonton (även under samma användarkonto) har helt oberoende takter och blockerar aldrig varandra.
- **Flerspråkigt gränssnitt**: 18 språk (svenska, engelska, nordiska språk, tyska, franska, spanska, polska, turkiska, ryska, ukrainska, arabiska, persiska, somaliska, kinesiska, hindi) — automatisk detektion + manuellt val, hela gränssnittet inklusive dynamiska meddelanden
- **API-nycklar**: programmatisk åtkomst (`Authorization: Bearer <nyckel>`) som alternativ till webbläsarinloggning
- **Kontakt/FAQ**: inbyggd kontaktväg och vanliga frågor, separat från felrapportering — FAQ förklarar bland annat exakt vilken politikerdata som finns och hur mottagarfiltren kombineras
- **Admin-panel**: konton, feedback, statistik (med diagram), export (CSV/JSON) per sektion eller allt i ett — samt en separat, fristående export av politiker-listan
- **Felrapportering**: oväntade JS-fel loggas till konsolen; användaren kan rapportera via kontaktformuläret
- **Autonom kampanj-Worker** (`campaign/`): cron-driven Worker (05–09 UTC dagligen) som självständigt hämtar nyheter från SVT, Aftonbladet, Expressen och Riksdagen, filtrerar socialt relevanta ärenden med Claude, genererar personaliserade medborgarbrev och skickar dem via Gmail till kommunpolitiker, regionpolitiker och riksdagsledamöter — utan mänsklig inblandning. Inkluderar bounce-sweep (kontaktar kommunpolitiker som inte nåtts på 90 dagar). Klientfel rapporteras automatiskt som GitHub-issues direkt från app-Workern (gratis via GitHub API, ingen LLM)
- **Kvartalsbrev + nyhetsbrev**: den 1:a i varje kvartal researchar och författar campaign-Workern ETT gemensamt medborgarbrev (utifrån kvartalets bevakade ärenden) som skickas till **samtliga ~17 000 politiker i landet** via Cloudflare Email Service. Nyhetsbrevsprenumeranter (dubbel opt-in, Turnstile-skyddat, inget konto behövs) får exakt samma brev samma dag, med avregistreringslänk i varje utskick. Hela kedjan nyhetsbevakning → research → brev → utskick till politiker + prenumeranter är automatiserad

## Struktur

- `app/` — huvud-Worker: statisk frontend (`public/`, inkl. `i18n.js`, `components/` för wizard-stegen) + API (auth, mail-credentials, mottagarval, brev, AI-utkast, feedback, API-nycklar, admin)
- `sender/` — Queue consumer-Worker: faktisk SMTP-/Graph-sändning + `rate-limiter.ts` (Durable Object, token bucket per mailkoppling)
- `campaign/` — kampanj-Worker (`politiker-webapp-campaign`): autonom cron-kampanj som dagligen hämtar nyheter/riksdagsärenden, genererar medborgarbrev med Claude och skickar dem via Gmail
- `shared/` — kod som delas mellan Workers (kryptering, SMTP-klient, TOTP, Graph-mail, leverantörs-takter, typer)
- `infra/` — Cloudflare-provisionering (`cf-api.sh`, `az-graph-api.sh`, `schema.sql`) + `bounce-processor.py` (systemd-tjänst för Gmail-bouncehantering)

## Köra din egen kopia (ett kommando)

Hela stacken — Cloudflare-resurser, databas, secrets och alla tre Workers —
sätts upp av `infra/setup.sh`. Du behöver bara ett Cloudflare-konto och Node 18+.

```bash
git clone https://github.com/blixten85/politiker-webapp.git
cd politiker-webapp
bash infra/setup.sh
```

**Första körningen** skapar `~/.claude/credentials.env` (genererar `MAIL_CRED_KEY`
automatiskt) och avslutar så du kan fylla i dina värden. Minst:

- `SYSTEM_SMTP_PASSWORD` — SMTP-konto för verifierings-/notismail
- `GITHUB_FEEDBACK_TOKEN` — fine-grained PAT med `Issues:Write` (för feedback/felrapporter)
- `CUSTOM_DOMAIN` — egen domän (lämna tom → deploy till `*.workers.dev`)
- Valfritt: `ANTHROPIC_API_KEY` + `GMAIL_EMAIL`/`GMAIL_PASSWORD` (autonom kampanj), `OAUTH_*_CLIENT_SECRET` (social inloggning)

**Andra körningen** gör resten automatiskt och idempotent:

1. `wrangler login` (öppnar webbläsare om du inte är inloggad)
2. Skapar D1, KV, Queue och R2 i ditt konto — och patchar `wrangler.jsonc` med dina resurs-ID:n
3. Applicerar `infra/schema.sql` (bara på en nyskapad databas — rör aldrig befintlig data)
4. Sätter secrets och deployar `app`, `sender` och (om kampanj-creds finns) `campaign`
5. Installerar `bounce-processor` som systemd-timer (Linux + Gmail-creds)

Kör om `bash infra/setup.sh` när som helst för att uppdatera deployen.
SMTP-host/-user/-from och OAuth-client-ID:n bor i `app/wrangler.jsonc` → `vars`
om du vill ändra dem.

> Databasen skapas tom på politikerdata — importera den från
> [`politiker-kontakter`](https://github.com/blixten85/politiker-kontakter)-repot,
> som publicerar hela kontaktdatabasen som färdig SQL:
>
> ```bash
> wrangler d1 execute politiker_webapp --remote \
>   --file ../politiker-kontakter/data/politiker.sql
> ```

Kampanj-Workern deployas även automatiskt vid push till `main` via Cloudflare Workers Builds.

### Lokal utveckling

```bash
cd app && npm install && cp .dev.vars.example .dev.vars  # fyll i riktiga värden
cd ../sender && npm install
npx wrangler dev --remote
```

`MAIL_CRED_KEY` måste vara **samma värde** i app och sender (app krypterar, sender dekrypterar).

### Felspårning (Sentry)

Alla tre Workers (`app`, `sender`, `campaign`) skickar fel och loggar till
Sentry via `@sentry/cloudflare` (`Sentry.withSentry(...)` runt varje export).
DSN:en ligger som en vanlig `var` i respektive `wrangler.jsonc` (den är inte
hemlig — bara ett skrivmål).

**Source maps** laddas upp efter varje deploy (`postdeploy`-hook i
`package.json`) så Sentry visar riktig TS-kod i stacktraces istället för
bundlat/minifierat JS. Detta kräver att följande miljövariabler finns
tillgängliga när `sentry:sourcemaps`-scriptet körs:

- `SENTRY_ORG=anders-gh`
- `SENTRY_PROJECT=politiker-webapp`
- `SENTRY_AUTH_TOKEN` — en Sentry-auktoriseringstoken med rätt att skapa releases/ladda upp source maps

**Viktigt — två olika platser för `SENTRY_AUTH_TOKEN`:**
- En `SENTRY_AUTH_TOKEN` **secret** är redan satt på Worker-nivå (`wrangler secret put`)
  för app/sender/campaign — den är tillgänglig för koden **vid körning** (runtime), inte
  under byggsteget.
- Eftersom detta repo deployas via **Cloudflare Workers Builds** (inte GitHub
  Actions, inte lokal `npm run deploy` i normalfallet) körs `sentry:sourcemaps`
  som en del av **byggsteget** på Cloudflare, i en helt separat miljö från
  Worker-runtimen. Workers Builds-projektinställningarna (Dashboard → Workers
  & Pages → respektive Worker → Settings → Build) måste därför ha
  `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` och `SENTRY_PROJECT` satta som
  **build-time-miljövariabler**, annars körs `sentry-cli` utan autentisering
  och source maps-uppladdningen misslyckas tyst/hörs bara i byggloggen.
  Detta sätts manuellt av operatören — inte automatiserat här.
- Vi kunde inte verifiera exakt vilket byggkommando Workers Builds kör för
  dessa tre projekt via API (token saknade rättigheter för
  build-configuration-endpointen) — om `npm run deploy` inte är det
  konfigurerade byggkommandot kommer `postdeploy`-hooken (och därmed
  source maps-uppladdningen) inte att triggas automatiskt. Verifiera detta
  i Dashboardens bygginställningar per Worker.

## Status

Live på politiker.denied.se. Inloggning med e-post, Google, GitHub och
Microsoft är fullt konfigurerad och verifierad live, liksom
passwordlös mailkoppling via Microsoft Graph.

**Avsiktligt inte byggt** (väntar på donationsintäkter för att täcka kostnad):
- **Apple-inloggning** — kräver betalt Apple Developer-konto (99 USD/år) + JWT-signerad client secret.
- **Gmail-OAuth för mailsändning** — kräver Googles CASA-säkerhetsgranskning (några hundra till tusentals USD, återkommande årligen).

### Driftsövervakning

Två oberoende hälsokontroller, ingen beroende av den andra eller av
operatörens egen server:
- Lokal cron-rutin på operatörens server (full skrivåtkomst, mejlar status)
- Molnbaserad daglig rutin (`politiker-webapp-cloud-healthcheck`, läsbehörighet
  endast) som postar till Slack

En tredje molnrutin (`politiker-webapp-token-maintenance`, veckovis) håller
Cloudflare API-tokens förnyade automatiskt och varnar i Slack om den
GitHub-token som inte kan roteras programmatiskt (GitHub saknar API för
att skapa/rotera personliga åtkomsttokens) börjar närma sig sin utgång.

### Kända Workers-specifika fallgropar

Hittade och fixade under utveckling/drift:
- PBKDF2 i Workers' WebCrypto stödjer max 100 000 iterationer (inte t.ex. 210 000).
- `socket.startTls()` kräver att writer/reader släpps med `.releaseLock()`
  innan anropet — `.close()` håller kvar låset och TLS-uppgraderingen kastar fel.
- Cloudflares scoped API-tokens stödjer inte `/accounts/{id}/workers/domains`
  (kräver Global API Key) — custom domain kopplas istället via
  `/accounts/{id}/workers/domains/records/{id}` (PUT, fungerar med scoped token)
  efter att posten finns, eller manuellt i dashboarden första gången.
- Kontot har Cloudflare Access (Zero Trust) med default-deny — en egen
  Access-app med "bypass"-policy (`everyone`) krävdes för att göra
  politiker.denied.se publik, utan att röra de andra apparnas privata policies.
- **`run_worker_first` krävs för `/api/*`-vägar** när `not_found_handling`
  är satt till `single-page-application` — annars kan Cloudflares
  static-asset-lager servera SPA-fallbacken direkt för API-anrop **utan att
  Workern körs alls**, vilket i kombination med Cloudflares "Speed Brain"
  (spekulativ förhämtning av länkar) orsakade att OAuth-inloggningsknappar
  tystnade och bara verkade ladda om sidan, fast i ett cache-lager som inte
  rensas av vanlig `purge_cache`.
