import type { Env } from "./index";
import { sendSmtpMail, escapeHtml } from "../../shared/smtp";
import { sendResendMail } from "../../shared/resend";

const NEWSLETTER_FROM = "Politiker-kontakt <nyhetsbrev@send.denied.se>";

// Nyhetsbrevsutskick: prenumeranterna får KVARTALSBREVET — samma AI-
// researchade och -författade brev som skickas till samtliga politiker i
// landet (public_letters, source='quarterly', skapas av quarterly-campaign
// den 1:a i jan/apr/jul/okt). Nyhetsbrevet går alltså ut kvartalsvis,
// samma dag som politikerutskicket börjar — inte dagligen; de dagliga
// kampanjbreven (source='campaign') rör aldrig prenumeranterna.
//
// Körs i samma cron-slot som letter-sender (07 UTC). Slotten är i praktiken
// en no-op alla dagar utom kvartalsdagarna (och dagarna efter, tills alla
// prenumeranter betats av).

const MAX_SUBSCRIBERS_PER_RUN = 50;
const LETTER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // fångar sena bekräftelser utan att skicka gamla kvartalsbrev

const BASE_URL = "https://politiker.denied.se";

interface Subscriber { id: string; email: string; token: string }
interface PendingLetter { send_id: string; letter_id: string; subject: string; body: string }

function digestHtml(letters: PendingLetter[], sub: Subscriber): string {
  const unsubUrl = `${BASE_URL}/api/newsletter/unsubscribe?id=${sub.id}&token=${sub.token}`;
  const sections = letters.map(l => `
    <h2 style="font-size:1.05rem;margin:1.5rem 0 .25rem">${escapeHtml(l.subject)}</h2>
    <pre style="font-family:inherit;white-space:pre-wrap;margin:0">${escapeHtml(l.body)}</pre>`).join("\n<hr>\n");
  return `<p>Hej!</p>
<p>Här ${letters.length === 1 ? "är kvartalets medborgarbrev som just nu skickas" : `är kvartalets ${letters.length} medborgarbrev som just nu skickas`}
till samtliga politiker i landet via <a href="${BASE_URL}">Politiker-kontakt</a>:</p>
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
    WHERE pl.source = 'quarterly' AND pl.published_at > ?
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

  const smtpConfig = {
    host: "smtp.gmail.com", port: 587,
    user: env.GMAIL_EMAIL, password: env.GMAIL_PASSWORD,
    fromAddress: env.GMAIL_EMAIL,
  };

  // Föredra Resend (egen avsändardomän med DKIM, List-Unsubscribe-header för
  // en-klicks-avregistrering i mailklienter) — falla tillbaka på Gmail-SMTP
  // om nyckeln saknas eller sändningen misslyckas, så utskicken aldrig
  // stannar. Prenumeranterna har prioritet över kvartalsdräneringen:
  // runNewsletterSender körs FÖRE runQuarterlyDrain i varje cron-slot, så
  // nyhetsbrevet tar aldrig slut på dagskvoten på grund av politiker-kön.
  async function deliver(to: string, subject: string, html: string, unsubUrl: string): Promise<void> {
    const text = html.replace(/<[^>]+>/g, "");
    const headers = {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
    // Kanalordning: Cloudflare Email Service -> Resend -> Gmail-SMTP.
    if (env.EMAIL) {
      try {
        await env.EMAIL.send({
          to,
          from: { email: "nyhetsbrev@denied.se", name: "Politiker-kontakt" },
          subject, html, text, headers,
        });
        return;
      } catch (e) {
        console.warn(`newsletter: Email Service misslyckades (${String(e).slice(0, 120)}), provar Resend`);
      }
    }
    if (env.RESEND_API_KEY) {
      try {
        await sendResendMail(env.RESEND_API_KEY, { to, from: NEWSLETTER_FROM, subject, html, text, headers });
        return;
      } catch (e) {
        console.warn(`newsletter: Resend misslyckades (${String(e).slice(0, 120)}), faller tillbaka på SMTP`);
      }
    }
    await sendSmtpMail(smtpConfig, { to, subject, html });
  }

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
    const unsubUrl = `${BASE_URL}/api/newsletter/unsubscribe?id=${sub.id}&token=${sub.token}`;
    try {
      await deliver(sub.email, subject, digestHtml(letters, sub), unsubUrl);
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
