import { randomId } from "../../shared/crypto";
import { getRecipientsForAreas, countSentToday, countSentTodayForCredential, getMailCredential } from "./db";
import type { Env } from "./db";
import type { SendJobMessage } from "../../shared/types";

export async function createAndEnqueueSendJob(
  env: Env,
  accountId: string,
  input: {
    letterId: string;
    subject?: string;
    mailCredentialId: string;
    areaNames: string[];
    excludeParties?: string[];
    excludeEmails?: string[];
    includeRoles?: string[];
    includeEmails?: string[];
  },
): Promise<{ sendJobId: string; totalRecipients: number }> {
  const account = await env.DB.prepare("SELECT daily_send_cap FROM accounts WHERE id = ?").bind(accountId).first<{ daily_send_cap: number }>();
  if (!account) throw new Error("Konto saknas");

  const credential = await getMailCredential(env.DB, input.mailCredentialId);
  if (!credential || credential.account_id !== accountId) throw new Error("Mailkoppling saknas");

  const recipients = await getRecipientsForAreas(
    env.DB,
    input.areaNames,
    input.excludeParties ?? [],
    input.excludeEmails ?? [],
    input.includeRoles ?? [],
    input.includeEmails ?? [],
  );
  if (recipients.length === 0) throw new Error("Inga mottagare matchar valda filter — välj område, befattning eller enskilda politiker");

  const alreadySentToday = await countSentToday(env.DB, accountId);
  const accountRemaining = account.daily_send_cap - alreadySentToday;

  let remainingQuota = accountRemaining;
  let limitLabel = `kontots dygnsgräns (${account.daily_send_cap}/dygn)`;

  if (credential.daily_cap != null) {
    const sentViaCredentialToday = await countSentTodayForCredential(env.DB, input.mailCredentialId);
    const credentialRemaining = (credential.daily_cap as number) - sentViaCredentialToday;
    if (credentialRemaining < remainingQuota) {
      remainingQuota = credentialRemaining;
      limitLabel = `dygnsgränsen för detta mailkonto (${credential.daily_cap}/dygn, satt för att skydda ditt ${credential.provider}-konto från att bli av-rate-limitat)`;
    }
  }

  if (remainingQuota <= 0) {
    throw new Error(`${limitLabel} är nådd för idag — försök igen imorgon.`);
  }
  if (recipients.length > remainingQuota) {
    throw new Error(
      `Valda filter ger ${recipients.length} mottagare, men du har bara ${remainingQuota} kvar av ${limitLabel}. Smalna av urvalet eller vänta till imorgon.`,
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
      subject: input.subject,
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
