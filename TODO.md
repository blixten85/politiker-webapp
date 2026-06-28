# TODO

## Prioriterade förbättringar

1. **Lägg till riktiga tester**
   CI kör i dag bara `npm install` och `npx tsc --noEmit` för `app`, `sender` och `campaign`. Det är för tunt för ett system med auth, OAuth, köhantering, SMTP och adminflöden.

   Börja med högvärdestester för:
   - auth och lösenordsåterställning
   - OAuth-state och callback-flöden
   - mottagarfiltrering
   - send-job och rate-limit

2. **Bryt upp frontend-koden mer**
   `app/public/app.js` är stor och fungerar som samlingspunkt för mycket av klientlogiken. Dela upp den mer per domän:
   - auth
   - settings
   - wizard steg 1–3
   - admin
   - feedback
   - public letters

3. **Lazy-loada översättningar**
   `app/public/i18n.js` innehåller alla språk i en enda stor fil. Det gör första sidladdningen onödigt tung.

   Förslag:
   - en fil per språk
   - dynamisk import för språk utöver standardspråket

4. **Förenkla och dela upp API-routningen**
   `app/src/index.ts` innehåller både routingtabeller och specialfall i samma fil. Flytta ut route-logik till separata moduler för:
   - auth/OAuth
   - admin
   - public letters
   - civic-letter

   Låt `index.ts` mest fungera som composition entrypoint.

5. **Hårdsäkra eller tona ned den autonoma issue-fixern**
   `campaign/src/issue-fixer.ts` läser användarrapporter, ber Claude skriva om hela filer och öppnar PR automatiskt. Det är kraftfullt men riskabelt.

   Lägg in minst ett extra skydd:
   - diff-validering
   - tillåten fil-/funktionslista
   - fallback till patch/issue i stället för direkt commit när säkerheten är låg

6. **Rätta logikmiss i mottagarförhandsvisningen**
   UI:t sparar valda roller som normaliserade `role_key`, och backend filtrerar också på normaliserad roll. Men förhandsräkningen i `app/public/app.js` jämför mot `r.role` i stället för `r.role_key`.

   Det kan ge fel mottagarantal när rollfilter används.

7. **Se över automatisk felrapportering i klienten**
   Kommentaren säger att riktiga JS-fel skickas till `/api/feedback`, men `autoReportError()` loggar i praktiken bara till konsolen.

   Antingen:
   - koppla den till faktisk rapportering
   - eller justera kommentaren så att beteendet är tydligt

## Styrkor att bevara

- Tydlig uppdelning mellan `app/`, `sender/`, `campaign/` och `shared/`
- Bra användning av Durable Object för delad rate limiting
- Överlag tydlig struktur för en vanilla-frontend på Cloudflare Workers

## Rekommenderad startordning

1. Lägg till tester
2. Dela upp `app/public/app.js`
3. Fixa rollfilter-previewn
