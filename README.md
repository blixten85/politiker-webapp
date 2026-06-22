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

## Status

Live på politiker.denied.se. Signup/verifiering/login/mailkoppling/D1-synk
verifierat end-to-end 2026-06-22 (16 073 politiker, 257 områden synkade).

Kända Workers-specifika fallgropar som hittades och fixades under verifiering:
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
