# politiker-webapp — AI Agent Guide

Gratis webbverktyg där medborgare skapar konto, kopplar sitt **eget**
mailkonto (Gmail/Outlook/iCloud/generisk SMTP), väljer kommuner/regioner/
riksdag/regering att kontakta, och skickar personaliserade brev till sina
folkvalda — utan att plattformen själv blir avsändare. Live på
politiker.denied.se.

## Tech Stack

- TypeScript, Cloudflare Workers (inget tungt frontend-ramverk — vanilla HTML/JS)
- Cloudflare D1 (SQLite), KV (sessioner), Queues (asynkron sändning)
- `cloudflare:sockets` för utgående SMTP — egenskriven minimal klient, ingen extern mail-dependency
- Wrangler för dev/deploy

## Dev Commands

```bash
cd app && npm install && cp .dev.vars.example .dev.vars  # fyll i riktiga värden
cd ../sender && npm install

npx wrangler dev --remote   # i app/ eller sender/
npx tsc --noEmit            # typecheck
```

## Project Structure

```
app/      # Huvud-Worker: statisk frontend + API (auth, mail-credentials, mottagarval, brev, feedback)
sender/   # Queue consumer-Worker: faktisk SMTP-sändning
shared/   # Delad kod (kryptering, SMTP-klient, TOTP, typer)
infra/    # Cloudflare-provisionering (cf-api.sh, schema.sql, healthcheck.py)
```

## Conventions

- `MAIL_CRED_KEY` (AES-nyckel för krypterade SMTP-lösenord) måste vara **identisk** i app och sender — sätts via `wrangler secret put`, aldrig hårdkodad
- Lösenord hashas med PBKDF2 via Web Crypto — **max 100 000 iterationer**, Workers' runtime tillåter inte mer
- `socket.startTls()` kräver `.releaseLock()` på writer/reader innan anropet, inte `.close()` — annars kastar uppgraderingen fel
- Aldrig logga eller exponera SMTP-lösenord, TOTP-secrets eller session-tokens
- Alla databasfrågor filtrerar på `account_id` — konton är helt isolerade från varandra utom via `/api/admin/*` (kräver `is_admin = 1`)

## Allowed
- Create branches
- Modify code
- Run tests
- Open PRs

## Forbidden
- Push directly to main/master
- Merge PRs
- Delete branches
- Disable workflows
- Modify secrets
- Change GitHub org settings

## Requirements
- All tests must pass
- Keep PRs focused
- Never include unrelated changes
- Never commit credentials
- Never force push
