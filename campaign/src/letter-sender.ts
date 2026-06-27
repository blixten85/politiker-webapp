import type { Env } from "./index";
import { sendSmtpMail } from "../../shared/smtp";

const MAX_PER_RUN = 20;

interface PendingRecipient {
  id: string; politician_email: string; politician_name: string;
  subject: string; html_body: string;
}

export async function runLetterSender(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`
    SELECT cr.id, cr.politician_email, cr.politician_name, cld.subject, cld.html_body
    FROM campaign_recipients cr
    JOIN civic_letter_drafts cld ON cld.id = cr.draft_id
    WHERE cr.status='pending' AND cld.status='approved'
    ORDER BY cr.rowid ASC LIMIT ?
  `).bind(MAX_PER_RUN).all<PendingRecipient>();

  if (!results.length) { console.log("letter-sender: inga väntande brev"); return; }

  const config = {
    host: "smtp.gmail.com", port: 587,
    user: env.GMAIL_EMAIL, password: env.GMAIL_PASSWORD,
    fromAddress: env.GMAIL_EMAIL,
  };

  let sent = 0, failed = 0;
  const now = Date.now();

  for (const rec of results) {
    try {
      await sendSmtpMail(config, {
        to: rec.politician_email,
        subject: rec.subject,
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${rec.html_body.replace(/</g, "&lt;")}</pre>`,
      });
      await env.DB.prepare("UPDATE campaign_recipients SET status='sent', sent_at=? WHERE id=?").bind(now, rec.id).run();
      sent++;
    } catch (e) {
      const err = String(e).slice(0, 200);
      await env.DB.prepare("UPDATE campaign_recipients SET status='failed', error=? WHERE id=?").bind(err, rec.id).run();
      failed++;
    }
  }

  console.log(`letter-sender: ${sent} skickade, ${failed} misslyckade`);
}
