import * as Sentry from "@sentry/cloudflare";
import { decryptSecret, encryptSecret, randomId } from "../../shared/crypto";
import { sendSmtpMail, SmtpError } from "../../shared/smtp";
import { sendGraphMail, refreshMicrosoftToken } from "../../shared/graph-mail";
import type { SendJobMessage } from "../../shared/types";
import { messagesPerMinuteFor } from "../../shared/provider-rates";
import { CredentialRateLimiter } from "./rate-limiter";

export { CredentialRateLimiter };

interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  MAIL_CRED_KEY: string;
  RATE_LIMITER: DurableObjectNamespace;
  OAUTH_MICROSOFT_CLIENT_ID?: string;
  OAUTH_MICROSOFT_CLIENT_SECRET?: string;
  SENTRY_DSN?: string;
}

interface CredentialRow {
  provider: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  encrypted_password: string;
  from_address: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_token_expires_at: number | null;
}

const BOUNCE_ABORT_RATE = 25; // % — samma typ av kretsbrytare som send_daily_batch.sh
const MIN_FOR_RATE_CHECK = 10;

// Frågar credentialns Durable Object om det finns en "token" att skicka med
// just nu — DELAD mellan ALLA jobb som använder samma mailkonto (oavsett
// vilken kö-invocation som frågar, tack vare DO:ns serialisering), så två
// jobb mot samma konto aldrig tillsammans överskrider leverantörens takt.
// Olika mailkonton har varsin DO-instans och konkurrerar aldrig om samma kvot.
async function acquireSendSlot(env: Env, credentialId: string, provider: string): Promise<{ granted: boolean; retryAfterMs?: number }> {
  const refillPerMinute = messagesPerMinuteFor(provider);
  const id = env.RATE_LIMITER.idFromName(credentialId);
  const stub = env.RATE_LIMITER.get(id);
  try {
    const resp = await stub.fetch("https://rate-limiter/acquire", {
      method: "POST",
      body: JSON.stringify({ capacity: 1, refillPerMinute }),
    });
    return resp.json<{ granted: boolean; retryAfterMs?: number }>();
  } catch (err) {
    // DO-anrop eller parse misslyckades — neka slot så anroparen kan retrya
    return { granted: false, retryAfterMs: 1000 };
  }
}

// MAX_WAIT_MS: hur länge EN meddelandebehandling väntar in-process på en
// ledig token innan den ger upp och lämnar tillbaka meddelandet till kön.
// Avsiktligt rymligt (4 min) eftersom queue()-invocations tillåts köra
// betydligt längre än ett vanligt HTTP-svar, och varje gång vi istället
// måste falla tillbaka på queueMsg.retry() förbrukar det en av meddelandets
// begränsade max_retries-försök trots att inget faktiskt misslyckats —
// ju mer vi kan absorbera här inne, desto mindre risk att ett legitimt
// mejl ger upp permanent bara på grund av en tillfällig backlog.
const MAX_WAIT_MS = 4 * 60 * 1000;
const POLL_INTERVAL_CAP_MS = 15_000;

async function waitForSendSlot(env: Env, credentialId: string, provider: string): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (true) {
    const slot = await acquireSendSlot(env, credentialId, provider);
    if (slot.granted) return true;
    const waitMs = Math.min(slot.retryAfterMs ?? 1000, POLL_INTERVAL_CAP_MS);
    if (Date.now() + waitMs > deadline) return false;
    await sleep(waitMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default Sentry.withSentry<Env, SendJobMessage>(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    // 100% under Sentrys trial-period (för max insikt) — sänk till 0.1-0.2
    // när trialen tar slut för att undvika kvot-/kostnadsproblem.
    tracesSampleRate: 1.0,
    enableLogs: true,
  }),
  {
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
  } satisfies ExportedHandler<Env, SendJobMessage>,
);

async function processJobMessages(
  env: Env,
  sendJobId: string,
  messages: SendJobMessage[],
  batch: MessageBatch<SendJobMessage>,
): Promise<void> {
  const credentialId = messages[0].mailCredentialId;
  let credentialRow = await env.DB.prepare(
    `SELECT provider, smtp_host, smtp_port, smtp_user, encrypted_password, from_address,
            oauth_access_token, oauth_refresh_token, oauth_token_expires_at
     FROM mail_credentials WHERE id = ?`,
  )
    .bind(credentialId)
    .first<CredentialRow>();

  if (!credentialRow) {
    for (const m of batch.messages) m.ack(); // mailkonto borttaget — kan inte skickas, släpp jobbet
    await markJobAborted(env, sendJobId, "Mailkontot finns inte längre");
    return;
  }

  // Förnya Microsoft-token i förväg om den snart går ut (inom 5 min) — undvik att göra det per mottagare.
  if (credentialRow.provider === "microsoft_graph" && credentialRow.oauth_token_expires_at! < Date.now() + 5 * 60 * 1000) {
    credentialRow = await refreshAndPersistMicrosoftToken(env, credentialId, credentialRow);
  }

  // Hämta brevkropp + ev. bilagor en gång per utskick (inte en gång per
  // mottagare) — letter_id ligger på send_jobs, samma brev och bilagor gäller
  // alla mottagare i jobbet. html_body skickas medvetet inte i kömeddelandet
  // (skulle dupliceras per mottagare), utan hämtas härifrån.
  const job = await env.DB.prepare(
    "SELECT sj.letter_id, l.html_body FROM send_jobs sj JOIN letters l ON l.id = sj.letter_id WHERE sj.id = ?",
  )
    .bind(sendJobId)
    .first<{ letter_id: string; html_body: string }>();
  if (!job) {
    for (const m of batch.messages) m.ack(); // brevet finns inte längre — kan inte skickas
    await markJobAborted(env, sendJobId, "Brevet finns inte längre");
    return;
  }
  const attachments = await fetchAttachments(env, job.letter_id);

  let bounceCount = 0;
  let attempted = 0;
  let aborted = false;

  for (const m of messages) {
    const queueMsg = batch.messages.find((qm) => qm.body === m)!;
    if (aborted) {
      queueMsg.retry(); // låt resten vänta till nästa batch / manuell granskning
      continue;
    }

    if (!(await waitForSendSlot(env, credentialId, credentialRow.provider))) {
      // Väntat förbi taket utan att få en token — ovanligt (stor backlog +
      // låg takt). queueMsg.retry() här (inte ack) så meddelandet kommer
      // tillbaka senare istället för att tappas, men det förbrukar tyvärr en
      // av meddelandets max_retries trots att inget faktiskt misslyckades —
      // se MAX_WAIT_MS-kommentaren ovanför waitForSendSlot för varför taket
      // satts generöst för att göra detta sällsynt.
      queueMsg.retry({ delaySeconds: 30 });
      continue;
    }

    attempted++;
    try {
      const greeting = firstName(m.recipientName) ? `Hej ${firstName(m.recipientName)}!` : "Hej!";
      const html = `<p>${greeting}</p>\n${job.html_body}`;
      await sendOneMail(env, credentialRow, m.recipientEmail, html, m.subject, attachments);
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

async function sendOneMail(
  env: Env,
  credentialRow: CredentialRow,
  to: string,
  html: string,
  subject: string | undefined,
  attachments: Array<{ filename: string; contentType: string; bytes: ArrayBuffer }>,
): Promise<void> {
  if (credentialRow.provider === "microsoft_graph") {
    const accessToken = await decryptSecret(credentialRow.oauth_access_token!, env.MAIL_CRED_KEY);
    await sendGraphMail(accessToken, { to, html, subject, attachments }); // JSON-API — ingen RFC2047-kodning behövs, UTF-8 funkar direkt
    return;
  }

  const password = await decryptSecret(credentialRow.encrypted_password, env.MAIL_CRED_KEY);
  await sendSmtpMail(
    {
      host: credentialRow.smtp_host,
      port: credentialRow.smtp_port,
      user: credentialRow.smtp_user,
      password,
      fromAddress: credentialRow.from_address,
    },
    { to, html, subject, attachments },
  );
}

async function fetchAttachments(
  env: Env,
  letterId: string,
): Promise<Array<{ filename: string; contentType: string; bytes: ArrayBuffer }>> {
  const { results } = await env.DB.prepare(
    "SELECT filename, content_type, r2_key FROM letter_attachments WHERE letter_id = ? AND mode = 'attach'",
  )
    .bind(letterId)
    .all<{ filename: string; content_type: string; r2_key: string }>();

  const attachments: Array<{ filename: string; contentType: string; bytes: ArrayBuffer }> = [];
  for (const row of results) {
    const obj = await env.ATTACHMENTS.get(row.r2_key);
    if (!obj) continue; // borttagen — skippa snarare än att krascha hela utskicket
    attachments.push({ filename: row.filename, contentType: row.content_type, bytes: await obj.arrayBuffer() });
  }
  return attachments;
}

async function refreshAndPersistMicrosoftToken(env: Env, credentialId: string, credentialRow: CredentialRow): Promise<CredentialRow> {
  const refreshToken = await decryptSecret(credentialRow.oauth_refresh_token!, env.MAIL_CRED_KEY);
  const fresh = await refreshMicrosoftToken(env.OAUTH_MICROSOFT_CLIENT_ID!, env.OAUTH_MICROSOFT_CLIENT_SECRET!, refreshToken);

  const encryptedAccessToken = await encryptSecret(fresh.accessToken, env.MAIL_CRED_KEY);
  const encryptedRefreshToken = await encryptSecret(fresh.refreshToken, env.MAIL_CRED_KEY);
  await env.DB.prepare(
    "UPDATE mail_credentials SET oauth_access_token = ?, oauth_refresh_token = ?, oauth_token_expires_at = ? WHERE id = ?",
  )
    .bind(encryptedAccessToken, encryptedRefreshToken, fresh.expiresAt, credentialId)
    .run();

  return { ...credentialRow, oauth_access_token: encryptedAccessToken, oauth_refresh_token: encryptedRefreshToken, oauth_token_expires_at: fresh.expiresAt };
}

async function logSend(env: Env, m: SendJobMessage, status: "ok" | "bounce", error: string | null): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO send_log (id, send_job_id, account_id, recipient_email, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(randomId(), m.sendJobId, m.accountId, m.recipientEmail, status, error, now)
    .run();

  // Riktiga utskick är samtidigt det mest tillförlitliga sättet att verifiera
  // att en politiker-adress fortfarande är levande — uppdatera direkt, ingen
  // separat batch-körning eller probing mot leverantörer behövs.
  await env.DB.prepare("UPDATE politicians SET verification_status = ?, last_verified_at = ? WHERE email = ?")
    .bind(status === "ok" ? "valid_via_send" : "dead_via_send", now, m.recipientEmail)
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
