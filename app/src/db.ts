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
  ANTHROPIC_API_KEY?: string;
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
    .prepare(
      "SELECT area_name, area_type, COUNT(*) as count FROM politicians GROUP BY area_name, area_type ORDER BY area_type, area_name",
    )
    .all();
  return results;
}

// Distinkta partier per område — bara rader där parti faktiskt är känt
// (idag bara EU-parlamentariker). Används för att låta användaren
// exkludera ett parti ur en annars bred kategori-markering.
export async function listParties(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT area_type, area_name, party, COUNT(*) as count FROM politicians
       WHERE party IS NOT NULL GROUP BY area_type, area_name, party ORDER BY area_type, area_name, party`,
    )
    .all();
  return results;
}

// Distinkta befattningar per område — bara rader där befattning faktiskt
// är känd. Används för att låta användaren begränsa till t.ex. bara
// "Ordförande" inom valda områden.
// Skrapad befattningstext varierar i skiftläge/whitespace mellan källor
// ("Ordförande"/"ordförande"/"ORDFÖRANDE") — grupperar på en normaliserad
// nyckel (lower+trim) så samma roll inte listas separat flera gånger.
// OBS: slår INTE ihop olika STAVNINGAR/förkortningar av samma roll (t.ex.
// "v ordf" vs "Vice ordförande") — det kräver en handgjord synonymtabell,
// inte gjort här. Visar den vanligaste skrivningen per normaliserad grupp.
export async function listRoles(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT area_type, area_name, role, LOWER(TRIM(role)) as role_key, COUNT(*) as count
       FROM politicians WHERE role IS NOT NULL AND TRIM(role) != ''
       GROUP BY area_type, area_name, role ORDER BY area_type, area_name, role_key, count DESC`,
    )
    .all<{ area_type: string; area_name: string; role: string; role_key: string; count: number }>();

  const merged = new Map<string, { area_type: string; area_name: string; role: string; role_key: string; count: number }>();
  for (const row of results) {
    const key = `${row.area_type}|${row.area_name}|${row.role_key}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += row.count;
    } else {
      merged.set(key, { ...row });
    }
  }
  return [...merged.values()];
}

// Sökning bland politiker inom redan valda områden — används för att
// låta användaren plocka ut och exkludera enskilda mottagare ur en
// annars bred kategori-/områdesmarkering.
export async function searchPoliticiansInAreas(db: D1Database, areaNames: string[], query: string) {
  if (areaNames.length === 0) return [];
  const placeholders = areaNames.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT name, email, area_name, party FROM politicians
       WHERE area_name IN (${placeholders}) AND name LIKE ?
       ORDER BY name LIMIT 50`,
    )
    .bind(...areaNames, `%${query}%`)
    .all<{ name: string; email: string; area_name: string; party: string | null }>();
  return results;
}

export async function getRecipientsForAreas(
  db: D1Database,
  areaNames: string[],
  excludeParties: string[] = [],
  excludeEmails: string[] = [],
  includeRoles: string[] = [],
) {
  if (areaNames.length === 0) return [];
  const areaPlaceholders = areaNames.map(() => "?").join(",");
  let sql = `SELECT name, email, area_name FROM politicians WHERE area_name IN (${areaPlaceholders})`;
  const params: unknown[] = [...areaNames];

  if (excludeParties.length > 0) {
    sql += ` AND (party IS NULL OR party NOT IN (${excludeParties.map(() => "?").join(",")}))`;
    params.push(...excludeParties);
  }
  if (excludeEmails.length > 0) {
    sql += ` AND email NOT IN (${excludeEmails.map(() => "?").join(",")})`;
    params.push(...excludeEmails);
  }
  if (includeRoles.length > 0) {
    // includeRoles innehåller normaliserade nycklar (lower+trim, se
    // listRoles) — matcha mot samma normalisering av den lagrade kolumnen,
    // annars missas mottagare vars roll har annat skiftläge än det valda.
    sql += ` AND LOWER(TRIM(role)) IN (${includeRoles.map(() => "?").join(",")})`;
    params.push(...includeRoles);
  }

  const { results } = await db
    .prepare(sql)
    .bind(...params)
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
