import { randomId } from "../../shared/crypto";
import { getRecipientsForAreas, countSentToday } from "./db";
import type { Env } from "./db";
import type { SendJobMessage } from "../../shared/types";

export async function createAndEnqueueSendJob(
  env: Env,
  accountId: string,
  input: { letterId: string; htmlBody: string; mailCredentialId: string; areaNames: string[] },
): Promise<{ sendJobId: string; totalRecipients: number }> {
  const account = await env.DB.prepare("SELECT daily_send_cap FROM accounts WHERE id = ?").bind(accountId).first<{ daily_send_cap: number }>();
  if (!account) throw new Error("Konto saknas");

  const recipients = await getRecipientsForAreas(env.DB, input.areaNames);
  if (recipients.length === 0) throw new Error("Inga mottagare matchar valda områden");

  const alreadySentToday = await countSentToday(env.DB, accountId);
  const remainingQuota = account.daily_send_cap - alreadySentToday;
  if (remainingQuota <= 0) {
    throw new Error(`Dygnsgränsen (${account.daily_send_cap} mottagare/dygn) är nådd för idag — försök igen imorgon.`);
  }
  if (recipients.length > remainingQuota) {
    throw new Error(
      `Valda områden ger ${recipients.length} mottagare, men du har bara ${remainingQuota} kvar av dagens gräns (${account.daily_send_cap}/dygn). Välj färre områden eller vänta till imorgon.`,
    );
  }

  const sendJobId = randomId();
  await env.DB.prepare(
    `INSERT INTO send_jobs (id, account_id, letter_id, mail_credential_id, total_recipients, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(sendJobId, accountId, input.letterId, input.mailCredentialId, recipients.length, Date.now())
    .run();

  for (const r of recipients) {
    const message: SendJobMessage = {
      sendJobId,
      accountId,
      mailCredentialId: input.mailCredentialId,
      recipientEmail: r.email,
      recipientName: r.name,
      htmlBody: input.htmlBody,
    };
    await env.SEND_QUEUE.send(message);
  }

  return { sendJobId, totalRecipients: recipients.length };
}

export async function getSendJobsForAccount(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, total_recipients, sent_count, bounce_count, status, created_at, finished_at
     FROM send_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(accountId)
    .all();
  return results;
}
