import { decryptSecret, randomId } from "../../shared/crypto";
import { sendSmtpMail, SmtpError } from "../../shared/smtp";
import type { SendJobMessage } from "../../shared/types";

interface Env {
  DB: D1Database;
  MAIL_CRED_KEY: string;
}

const BOUNCE_ABORT_RATE = 25; // % — samma typ av kretsbrytare som send_daily_batch.sh
const MIN_FOR_RATE_CHECK = 10;

export default {
  async queue(batch: MessageBatch<SendJobMessage>, env: Env): Promise<void> {
    // Gruppera per send_job så kretsbrytaren räknar per jobb, inte per hela batchen
    const byJob = new Map<string, SendJobMessage[]>();
    for (const msg of batch.messages) {
      const arr = byJob.get(msg.body.sendJobId) ?? [];
      arr.push(msg.body);
      byJob.set(msg.body.sendJobId, arr);
    }

    for (const [sendJobId, messages] of byJob) {
      await processJobMessages(env, sendJobId, messages, batch);
    }
  },
};

async function processJobMessages(
  env: Env,
  sendJobId: string,
  messages: SendJobMessage[],
  batch: MessageBatch<SendJobMessage>,
): Promise<void> {
  const credentialRow = await env.DB.prepare(
    "SELECT smtp_host, smtp_port, smtp_user, encrypted_password, from_address FROM mail_credentials WHERE id = ?",
  )
    .bind(messages[0].mailCredentialId)
    .first<{ smtp_host: string; smtp_port: number; smtp_user: string; encrypted_password: string; from_address: string }>();

  if (!credentialRow) {
    for (const m of batch.messages) m.ack(); // mailkonto borttaget — kan inte skickas, släpp jobbet
    await markJobAborted(env, sendJobId, "Mailkontot finns inte längre");
    return;
  }

  const password = await decryptSecret(credentialRow.encrypted_password, env.MAIL_CRED_KEY);

  let bounceCount = 0;
  let attempted = 0;
  let aborted = false;

  for (const m of messages) {
    const queueMsg = batch.messages.find((qm) => qm.body === m)!;
    if (aborted) {
      queueMsg.retry(); // låt resten vänta till nästa batch / manuell granskning
      continue;
    }

    attempted++;
    try {
      const greeting = firstName(m.recipientName) ? `Hej ${firstName(m.recipientName)}!` : "Hej!";
      const html = `<p>${greeting}</p>\n${m.htmlBody}`;
      await sendSmtpMail(
        {
          host: credentialRow.smtp_host,
          port: credentialRow.smtp_port,
          user: credentialRow.smtp_user,
          password,
          fromAddress: credentialRow.from_address,
        },
        { to: m.recipientEmail, html },
      );
      await logSend(env, m, "ok", null);
      queueMsg.ack();
    } catch (err) {
      bounceCount++;
      const errorMsg = err instanceof SmtpError || err instanceof Error ? err.message : "Okänt fel";
      await logSend(env, m, "bounce", errorMsg);
      queueMsg.ack(); // permanent fel (fel uppgifter etc.) — inte meningsfullt att retrya om och om igen

      if (bounceCount >= 5 && attempted >= MIN_FOR_RATE_CHECK) {
        const rate = (bounceCount / attempted) * 100;
        if (rate >= BOUNCE_ABORT_RATE) {
          aborted = true;
          await markJobAborted(env, sendJobId, `Hög bounce-andel (${rate.toFixed(0)}%) — stoppat för granskning`);
        }
      }
    }
  }

  await env.DB.prepare(
    `UPDATE send_jobs SET sent_count = sent_count + ?, bounce_count = bounce_count + ?, status = ?
     WHERE id = ?`,
  )
    .bind(attempted - bounceCount, bounceCount, aborted ? "aborted" : "sending", sendJobId)
    .run();

  await maybeFinishJob(env, sendJobId);
}

async function logSend(env: Env, m: SendJobMessage, status: "ok" | "bounce", error: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO send_log (id, send_job_id, account_id, recipient_email, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(), m.sendJobId, m.accountId, m.recipientEmail, status, error, Date.now())
    .run();
}

async function markJobAborted(env: Env, sendJobId: string, _reason: string): Promise<void> {
  await env.DB.prepare("UPDATE send_jobs SET status = 'aborted', finished_at = ? WHERE id = ?")
    .bind(Date.now(), sendJobId)
    .run();
}

async function maybeFinishJob(env: Env, sendJobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT total_recipients, sent_count, bounce_count, status FROM send_jobs WHERE id = ?")
    .bind(sendJobId)
    .first<{ total_recipients: number; sent_count: number; bounce_count: number; status: string }>();
  if (!job) return;
  if (job.status === "aborted") return;
  if (job.sent_count + job.bounce_count >= job.total_recipients) {
    await env.DB.prepare("UPDATE send_jobs SET status = 'done', finished_at = ? WHERE id = ?").bind(Date.now(), sendJobId).run();
  }
}

function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
