import { runMonitor } from "./monitor";
import { runLetterGenerator } from "./letter-generator";
import { runLetterSender } from "./letter-sender";
import { runNewsletterSender } from "./newsletter-sender";
import { runBounceSweep } from "./bounce-sweep";

// Objekt-API:t för Email Service-bindingen (send({to, from, ...})) finns ännu
// inte i @cloudflare/workers-types — typa den minimalt själv tills dess.
export interface EmailSendBinding {
  send(options: {
    to: string | string[];
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export interface Env {
  DB: D1Database;
  EMAIL?: EmailSendBinding; // Cloudflare Email Service (nyhetsbrev) — valfri tills denied.se är onboardad
  ANTHROPIC_API_KEY: string;
  GMAIL_EMAIL: string;
  GMAIL_PASSWORD: string;
  GITHUB_FEEDBACK_TOKEN: string;
  SENDER_NAME: string;
  GITHUB_REPO: string;
}

// Cron-tider (UTC):
//   05:00 → monitor        (07:00 CET)
//   06:00 → letter-gen     (08:00 CET)
//   07:00 → letter-sender  (09:00 CET) + nyhetsbrev till prenumeranterna
//   08:00 → bounce-sweep   (10:00 CET)
//
// Klientfel rapporteras numera direkt till GitHub (gratis) via app-Workern,
// utan någon LLM-driven autofix — den gamla issue-fixern (Claude skrev om hela
// filer, ~$3-4/issue) är borttagen.

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const hour = new Date(event.scheduledTime).getUTCHours();
    ctx.waitUntil(
      (async () => {
        switch (hour) {
          case 5:  await runMonitor(env);        break;
          case 6:  await runLetterGenerator(env); break;
          case 7:  await runLetterSender(env); await runNewsletterSender(env); break;
          case 8:  await runBounceSweep(env);     break;
        }
      })()
    );
  },
};
