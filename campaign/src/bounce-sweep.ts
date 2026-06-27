import type { Env } from "./index";
import { sendSmtpMail, escapeHtml } from "../../shared/smtp";
import { callAnthropic, ANTHROPIC_HAIKU } from "../../shared/anthropic";

const MAX_PER_RUN = 150;
const SWEEP_DAYS  = 90;

interface Politician {
  id: string; name: string; email: string; area_name: string;
}

async function generateSweepLetter(env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    "SELECT title, summary, item_type FROM monitored_items WHERE letter_queued=1 ORDER BY created_at DESC LIMIT 1"
  ).all<{ title: string; summary: string | null; item_type: string }>();

  const topic = results[0];
  const context = topic
    ? `Aktuellt ärende: ${topic.title}\nSammanfattning: ${(topic.summary ?? "").slice(0, 400)}`
    : "Allmänt medborgaransvar och kommunal service";

  return callAnthropic(env.ANTHROPIC_API_KEY, {
    model: ANTHROPIC_HAIKU,
    maxTokens: 600,
    prompt: `Du är ${env.SENDER_NAME}, engagerad svensk medborgare. Du skriver till en kommunpolitiker.

${context}

Skriv ett kort medborgarbrev (150–200 ord) som:
1. Börjar med "Kära [NAMN],"
2. Refererar till ett konkret lokalt problem: sjukvård, skola, bostad, äldrevård eller ekonomisk ojämlikhet
3. Ställer en tydlig fråga om vad kommunen konkret gör eller planerar
4. Avslutas med att du förväntar dig svar
5. Undertecknas "${env.SENDER_NAME}, medborgare"

Skriv ENBART brevtexten.`,
  });
}

export async function runBounceSweep(env: Env): Promise<void> {
  const cutoff = Date.now() - SWEEP_DAYS * 86400 * 1000;

  const { results: politicians } = await env.DB.prepare(`
    SELECT p.id, p.name, p.email, p.area_name FROM politicians p
    WHERE p.area_type='kommun' AND p.verification_status!='dead_via_send'
      AND p.id NOT IN (SELECT DISTINCT politician_id FROM campaign_recipients WHERE sent_at > ?)
    ORDER BY RANDOM() LIMIT ?
  `).bind(cutoff, MAX_PER_RUN).all<Politician>();

  if (!politicians.length) { console.log("bounce-sweep: alla kommunpolitiker kontaktade"); return; }

  const template = await generateSweepLetter(env);
  const config = {
    host: "smtp.gmail.com", port: 587,
    user: env.GMAIL_EMAIL, password: env.GMAIL_PASSWORD,
    fromAddress: env.GMAIL_EMAIL,
  };

  let sent = 0, failed = 0;
  const now = Date.now();

  for (const pol of politicians) {
    const body = template.replace("[NAMN]", pol.name);
    try {
      await sendSmtpMail(config, {
        to: pol.email,
        subject: "Fråga från medborgare",
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
      });

      const draftId = crypto.randomUUID();
      const recId   = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO civic_letter_drafts (id,subject,html_body,topic_source_url,status,approve_token,created_at) VALUES (?,?,?,NULL,'approved',?,?)")
          .bind(draftId, "Bounce-sweep", body, draftId.slice(0, 32), now),
        env.DB.prepare("INSERT OR IGNORE INTO campaign_recipients (id,draft_id,politician_id,politician_email,politician_name,area_name,status,sent_at) VALUES (?,?,?,?,?,?,'sent',?)")
          .bind(recId, draftId, pol.id, pol.email, pol.name, pol.area_name, now),
      ]);
      sent++;
    } catch {
      failed++;
    }
  }

  console.log(`bounce-sweep: ${sent} skickade, ${failed} misslyckade`);
}
