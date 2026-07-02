import type { Env } from "./index";
import { sendSmtpMail, escapeHtml } from "../../shared/smtp";

// Nyhetsbrevsutskick: prenumeranterna får samma medborgarbrev som skickas
// till politikerna (public_letters, source='campaign' — det publicerade
// brevet per bevakat ärende). Skickas som ETT dagligt digest per prenumerant
// med alla nya brev, istället för ett mail per brev — upp till fem ärenden
// kan generera brev samma dag och ingen vill ha fem separata mail.
//
// Körs i samma cron-slot som letter-sender (07 UTC), efter politiker-
// utskicken, och delar samma Gmail-konto och dagliga volymutrymme.

const MAX_SUBSCRIBERS_PER_RUN = 50;
const LETTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // enqueue:a aldrig äldre brev än en vecka

const BASE_URL = "https://politiker.denied.se";

interface Subscriber { id: string; email: string; token: string }
interface PendingLetter { send_id: string; letter_id: string; subject: string; body: string }

function digestHtml(letters: PendingLetter[], sub: Subscriber): string {
  const unsubUrl = `${BASE_URL}/api/newsletter/unsubscribe?id=${sub.id}&token=${sub.token}`;
  const sections = letters.map(l => `
    <h2 style="font-size:1.05rem;margin:1.5rem 0 .25rem">${escapeHtml(l.subject)}</h2>
    <pre style="font-family:inherit;white-space:pre-wrap;margin:0">${escapeHtml(l.body)}</pre>`).join("\n<hr>\n");
  return `<p>Hej!</p>
<p>Här ${letters.length === 1 ? "är dagens medborgarbrev som skickats" : `är dagens ${letters.length} medborgarbrev som skickats`}
till politikerna via <a href="${BASE_URL}">Politiker-kontakt</a>:</p>
${sections}
<hr>
<p style="color:#666;font-size:.85rem">Du får det här för att du prenumererar på
Politiker-kontakts nyhetsbrev. <a href="${unsubUrl}">Avregistrera dig</a>.</p>`;
}

export async function runNewsletterSender(env: Env): Promise<void> {
  // 1. Enqueue: alla (nya kampanjbrev × bekräftade prenumeranter) som saknar
  //    en send-rad. INSERT OR IGNORE + UNIQUE(letter_id, subscriber_id) gör
  //    steget idempotent — en krasch mitt i ger bara omkörning, inga dubbletter.
  const cutoff = Date.now() - LETTER_MAX_AGE_MS;
  await env.DB.prepare(`
    INSERT OR IGNORE INTO newsletter_sends (id, letter_id, subscriber_id)
    SELECT lower(hex(randomblob(16))), pl.id, ns.id
    FROM public_letters pl
    CROSS JOIN newsletter_subscribers ns
    WHERE pl.source = 'campaign' AND pl.published_at > ?
      AND ns.confirmed_at IS NOT NULL AND ns.unsubscribed_at IS NULL
  `).bind(cutoff).run();

  // 2. Prenumeranter med väntande brev (avregistrerade filtreras bort även
  //    här — de kan ha hunnit avregistrera sig efter enqueue-steget).
  const { results: subscribers } = await env.DB.prepare(`
    SELECT DISTINCT ns.id, ns.email, ns.token
    FROM newsletter_subscribers ns
    JOIN newsletter_sends s ON s.subscriber_id = ns.id AND s.status = 'pending'
    WHERE ns.confirmed_at IS NOT NULL AND ns.unsubscribed_at IS NULL
    LIMIT ?
  `).bind(MAX_SUBSCRIBERS_PER_RUN).all<Subscriber>();

  if (!subscribers.length) { console.log("newsletter: inga väntande utskick"); return; }

  const config = {
    host: "smtp.gmail.com", port: 587,
    user: env.GMAIL_EMAIL, password: env.GMAIL_PASSWORD,
    fromAddress: env.GMAIL_EMAIL,
  };

  let sent = 0, failed = 0;
  for (const sub of subscribers) {
    const { results: letters } = await env.DB.prepare(`
      SELECT s.id AS send_id, pl.id AS letter_id, pl.subject, pl.body
      FROM newsletter_sends s
      JOIN public_letters pl ON pl.id = s.letter_id
      WHERE s.subscriber_id = ? AND s.status = 'pending'
      ORDER BY pl.published_at ASC
    `).bind(sub.id).all<PendingLetter>();
    if (!letters.length) continue;

    const subject = letters.length === 1
      ? `Nyhetsbrev: ${letters[0].subject.slice(0, 80)}`
      : `Nyhetsbrev: ${letters.length} nya brev till politikerna`;

    const now = Date.now();
    try {
      await sendSmtpMail(config, { to: sub.email, subject, html: digestHtml(letters, sub) });
      await env.DB.batch(letters.map(l =>
        env.DB.prepare("UPDATE newsletter_sends SET status='sent', sent_at=? WHERE id=?").bind(now, l.send_id),
      ));
      sent++;
    } catch (e) {
      const err = String(e).slice(0, 200);
      await env.DB.batch(letters.map(l =>
        env.DB.prepare("UPDATE newsletter_sends SET status='failed', error=? WHERE id=?").bind(err, l.send_id),
      ));
      failed++;
    }
  }

  console.log(`newsletter: ${sent} digest skickade, ${failed} misslyckade`);
}
