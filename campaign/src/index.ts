import * as Sentry from "@sentry/cloudflare";
import { runMonitor } from "./monitor";
import { runLetterGenerator } from "./letter-generator";
import { runLetterSender } from "./letter-sender";
import { runNewsletterSender } from "./newsletter-sender";
import { runQuarterlyCampaign, runQuarterlyDrain } from "./quarterly-campaign";
import { runBounceSweep } from "./bounce-sweep";
import type { EmailSendBinding } from "../../shared/types";

export interface Env {
  DB: D1Database;
  EMAIL?: EmailSendBinding; // Cloudflare Email Service — primär utskickskanal
  RESEND_API_KEY?: string; // Resend — fallback (wrangler secret)
  ANTHROPIC_API_KEY: string;
  GMAIL_EMAIL: string;
  GMAIL_PASSWORD: string;
  GITHUB_FEEDBACK_TOKEN: string;
  SENDER_NAME: string;
  GITHUB_REPO: string;
  SENTRY_DSN?: string;
}

// Cron-tider (UTC):
//   05:00 → monitor        (07:00 CET)
//   06:00 → letter-gen     (08:00 CET)
//   07:00 → letter-sender  (09:00 CET)
//   08:00 → bounce-sweep   (10:00 CET)
//   06:30 den 1:a i jan/apr/jul/okt → kvartalsbrevet (research + författande,
//     köar SAMTLIGA politiker; prenumeranterna får samma brev samma dag)
//
// runNewsletterSender + runQuarterlyDrain körs i VARJE daglig slot, i den
// ordningen (prenumeranter har prioritet över politiker-kön) — båda via
// Resend, no-op utan kö/RESEND_API_KEY.
//
// Klientfel rapporteras numera direkt till GitHub (gratis) via app-Workern,
// utan någon LLM-driven autofix — den gamla issue-fixern (Claude skrev om hela
// filer, ~$3-4/issue) är borttagen.

const QUARTERLY_CRON = "30 6 1 1,4,7,10 *";

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    enableLogs: true,
  }),
  {
    async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      const hour = new Date(event.scheduledTime).getUTCHours();
      ctx.waitUntil(
        (async () => {
          if (event.cron === QUARTERLY_CRON) { await runQuarterlyCampaign(env); return; }
          switch (hour) {
            case 5:  await runMonitor(env);        break;
            case 6:  await runLetterGenerator(env); break;
            case 7:  await runLetterSender(env);    break;
            case 8:  await runBounceSweep(env);     break;
          }
          // Prenumeranterna har prioritet: nyhetsbrevet dräneras FÖRE
          // politiker-kön i varje slot, så kvartalsdräneringen aldrig hinner
          // äta upp Resends dagskvot före ett nyhetsbrevsutskick.
          await runNewsletterSender(env);
          await runQuarterlyDrain(env);
        })()
      );
    },
  } satisfies ExportedHandler<Env>,
);
