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

För kommun/region är parti och befattning (t.ex. "Ordförande") tillagt
där det går att fastställa — antingen direkt vid skrapning (mailto/troman/
netpublicator, ~94% av kommunerna) eller via matchning mot Valmyndighetens
öppna data om nuvarande ledamöter. Se `politiker-kontakter`-repot för
skrapningslogiken.

## Funktioner

- **Konto**: e-post+lösenord eller OAuth-inloggning (Google, GitHub, Microsoft), TOTP 2FA, glömt lösenord, länka fler inloggningssätt till samma konto efteråt
- **Mailkoppling**: Gmail/Outlook/iCloud/Yahoo/generisk SMTP, eller Microsoft Graph utan lösenord — med ett hårdkodat säkerhetstak (10% under leverantörens kända gräns) som användaren själv kan sänka ytterligare
- **3-stegs wizard** (mottagare → brev → granska): de fem nivåerna (EU/riksdag/regering/region/kommun) väljs via stora kort med levande mottagarantal. Detaljerad filtrering (enskilda områden, befattning, parti-/individuell exkludering) finns kvar oförändrad bakom en hopfällbar "Avancerat"-sektion — stora grupper (>30 områden) hopfällda från start, sökning forcerar alltid utfällt. Befattningslistan normaliseras (skiftläge/whitespace) så samma roll inte listas separat per stavningsvariant.
- **AI-brevutkast** (valfritt): beskriv ett ämne (eller låt AI:n själv hitta ett aktuellt) — researchar via riktig websökning och föreslår ett utkast som användaren läser igenom, redigerar och skickar under eget namn, inget skickas automatiskt
- **Brev**: HTML/textredigerare, ämnesrad (full åäö/UTF-8-stöd), bilagor (PDF/txt/doc/docx, automatisk konvertering till brevtext)
- **Rate limiting per mailkonto**: en Durable Object per mailkoppling ger sann delad sändningstakt mellan parallella utskick mot samma konto — väntar in en ledig "token" istället för att riskera leverantörens spärr. Olika mailkonton (även under samma användarkonto) har helt oberoende takter och blockerar aldrig varandra.
- **Flerspråkigt gränssnitt**: 18 språk (svenska, engelska, nordiska språk, tyska, franska, spanska, polska, turkiska, ryska, ukrainska, arabiska, persiska, somaliska, kinesiska, hindi) — automatisk detektion + manuellt val, hela gränssnittet inklusive dynamiska meddelanden
- **API-nycklar**: programmatisk åtkomst (`Authorization: Bearer <nyckel>`) som alternativ till webbläsarinloggning
- **Kontakt/FAQ**: inbyggd kontaktväg och vanliga frågor, separat från felrapportering — FAQ förklarar bland annat exakt vilken politikerdata som finns och hur mottagarfiltren kombineras
- **Admin-panel**: konton, feedback, statistik (med diagram), export (CSV/JSON) per sektion eller allt i ett — samt en separat, fristående export av politiker-listan
- **Automatisk felrapportering**: oväntade JS-fel skickas till `/api/feedback` utan att användaren behöver göra något

## Struktur

- `app/` — huvud-Worker: statisk frontend (`public/`, inkl. `i18n.js`, `components/` för wizard-stegen) + API (auth, mail-credentials, mottagarval, brev, AI-utkast, feedback, API-nycklar, admin)
- `sender/` — Queue consumer-Worker: faktisk SMTP-/Graph-sändning + `rate-limiter.ts` (Durable Object, token bucket per mailkoppling)
- `shared/` — kod som delas mellan de två (kryptering, SMTP-klient, TOTP, Graph-mail, leverantörs-takter, typer)
- `infra/` — Cloudflare-provisionering (`cf-api.sh`, `az-graph-api.sh`, `schema.sql`)

## Sätta upp lokalt

```bash
cd app && npm install && cp .dev.vars.example .dev.vars  # fyll i riktiga värden
cd ../sender && npm install
```

`MAIL_CRED_KEY` måste vara **samma värde** i båda `.dev.vars`/secrets (app krypterar, sender dekrypterar).

```bash
openssl rand -base64 32   # generera MAIL_CRED_KEY
```

## Deploy

```bash
cd app && npx wrangler secret put MAIL_CRED_KEY
npx wrangler secret put SYSTEM_SMTP_PASSWORD
npx wrangler secret put GITHUB_FEEDBACK_TOKEN
npx wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET
npx wrangler secret put OAUTH_GITHUB_CLIENT_SECRET
npx wrangler secret put OAUTH_MICROSOFT_CLIENT_SECRET
npx wrangler deploy

cd ../sender && npx wrangler secret put MAIL_CRED_KEY   # samma värde som ovan
npx wrangler secret put OAUTH_MICROSOFT_CLIENT_SECRET    # samma värde som ovan, för tokenförnyelse
npx wrangler deploy
```

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
