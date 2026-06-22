# Politiker-webapp

Gratis verktyg där medborgare kan skapa konto, koppla sitt **eget** mailkonto
(Gmail/Outlook/iCloud/generisk SMTP), välja kommuner/regioner/riksdag/regering
att kontakta, och skicka personaliserade brev till sina folkvalda — utan att
plattformen själv blir avsändare.

Se `~/.claude/plans/virtual-inventing-bear.md` för bakgrund/arkitekturbeslut.

## Struktur

- `app/` — huvud-Worker: statisk frontend + API (auth, mail-credentials, mottagarval, brev, feedback)
- `sender/` — Queue consumer-Worker: faktisk SMTP-sändning via `cloudflare:sockets`
- `shared/` — kod som delas mellan de två (kryptering, SMTP-klient, typer)
- `infra/` — Cloudflare-provisionering (`cf-api.sh`, `schema.sql`, `cloudflare-resources.json`)

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
npx wrangler deploy

cd ../sender && npx wrangler secret put MAIL_CRED_KEY   # samma värde som ovan
npx wrangler deploy
```

## Kvarstående TODO innan skarp lansering

- [ ] **PayPal-donationsknapp**: `app/public/index.html` har en platshållare (`TODO_PAYPAL_BUTTON_ID`) — skapa en riktig Donate-knapp på paypal.com/donate/buttons och ersätt.
- [ ] **GitHub-repo för feedback**: `blixten85/politiker-webapp` måste skapas, och en fine-grained PAT (endast `Issues:Write` på detta repo) genereras till `GITHUB_FEEDBACK_TOKEN`.
- [ ] **Scraper→D1-synk**: körs separat, se `politiker-kontakter`-repot.
- [ ] **cloudflare:sockets-detaljer**: `shared/smtp.ts` är skriven mot dokumenterat beteende men inte körd live än — testa noggrant mot `wrangler dev --remote` innan skarpt bruk (se planens verifieringssteg).
