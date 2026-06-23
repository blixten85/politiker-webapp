import { randomId } from "../../shared/crypto";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  SEND_QUEUE: Queue;
  ASSETS: Fetcher;
  ATTACHMENTS: R2Bucket;
  MAIL_CRED_KEY: string;
  SYSTEM_SMTP_HOST: string;
  SYSTEM_SMTP_PORT: string;
  SYSTEM_SMTP_USER: string;
  SYSTEM_SMTP_PASSWORD: string;
  SYSTEM_FROM_ADDRESS: string;
  GITHUB_FEEDBACK_TOKEN: string;
  FEEDBACK_NOTIFY_EMAIL: string;
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;
  OAUTH_MICROSOFT_CLIENT_ID?: string;
  OAUTH_MICROSOFT_CLIENT_SECRET?: string;
  CIVIC_OUTLOOK_PASSWORD?: string;
}

export async function getAccountByEmail(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
}

export async function getAccountById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
}

export async function createAccount(
  db: D1Database,
  fields: { email: string; passwordHash: string; passwordSalt: string; verificationCode: string },
) {
  const id = randomId();
  const now = Date.now();
  const expires = now + 30 * 60 * 1000; // 30 min
  await db
    .prepare(
      `INSERT INTO accounts (id, email, password_hash, password_salt, password_set_by_user, email_verified, verification_code, verification_expires_at, created_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    )
    .bind(id, fields.email, fields.passwordHash, fields.passwordSalt, fields.verificationCode, expires, now)
    .run();
  return id;
}

export async function verifyAccountEmail(db: D1Database, accountId: string, code: string): Promise<boolean> {
  const account = await db
    .prepare("SELECT verification_code, verification_expires_at FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ verification_code: string; verification_expires_at: number }>();
  if (!account) return false;
  if (account.verification_code !== code) return false;
  if (Date.now() > account.verification_expires_at) return false;
  await db.prepare("UPDATE accounts SET email_verified = 1 WHERE id = ?").bind(accountId).run();
  return true;
}

export async function listAreas(db: D1Database) {
  const { results } = await db
    .prepare("SELECT DISTINCT area_name, area_type FROM politicians ORDER BY area_type, area_name")
    .all();
  return results;
}

export async function getRecipientsForAreas(db: D1Database, areaNames: string[]) {
  if (areaNames.length === 0) return [];
  const placeholders = areaNames.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT name, email, area_name FROM politicians WHERE area_name IN (${placeholders})`)
    .bind(...areaNames)
    .all<{ name: string; email: string; area_name: string }>();
  return results;
}

export async function countSentToday(db: D1Database, accountId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const row = await db
    .prepare("SELECT COUNT(*) as n FROM send_log WHERE account_id = ? AND sent_at >= ? AND status = 'ok'")
    .bind(accountId, startOfDay.getTime())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Räknar sänt per SPECIFIK mailkoppling, inte hela kontot — skyddar
// leverantörskontot (t.ex. Gmail) från att bli av-rate-limitat/bannat,
// oberoende av kontots övergripande dygnsgräns mot platiker-webapp.
export async function countSentTodayForCredential(db: D1Database, mailCredentialId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const row = await db
    .prepare(
      `SELECT COUNT(*) as n FROM send_log sl
       JOIN send_jobs sj ON sj.id = sl.send_job_id
       WHERE sj.mail_credential_id = ? AND sl.sent_at >= ? AND sl.status = 'ok'`,
    )
    .bind(mailCredentialId, startOfDay.getTime())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getMailCredential(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM mail_credentials WHERE id = ?").bind(id).first();
}
