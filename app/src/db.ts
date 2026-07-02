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
  ISSUE_FIXER_INBOX?: string;
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;
  OAUTH_MICROSOFT_CLIENT_ID?: string;
  OAUTH_MICROSOFT_CLIENT_SECRET?: string;
  CIVIC_OUTLOOK_PASSWORD?: string;
  ANTHROPIC_API_KEY?: string;
  VISITOR_SALT?: string;
  TURNSTILE_SECRET?: string; // Turnstile siteverify-hemlighet (wrangler secret)
  RESEND_API_KEY?: string; // Resend — nyhetsbrevets bekräftelsemail (wrangler secret)
}

export async function getAccountByEmail(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
}

export async function getAccountById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
}

// Permanent, oåterkallelig radering av ett konto och ALL dess kopplade data.
// Diagnostik-/feedback-rader (nullbara account_id) anonymiseras istället för
// att raderas — de är inte personlig kontodata och behålls avidentifierade.
// Besöksstatistiken (visits) är redan anonym och rör inte enskilda konton.
// Sessionskakor i KV kan inte räknas upp, men blir verkningslösa direkt:
// getAccountFromSession slår upp kontot som nu är borta och returnerar null.
export async function deleteAccount(env: Env, accountId: string): Promise<void> {
  // Skydda mot att radera det SISTA admin-kontot — annars går det inte längre
  // att administrera plattformen (gäller både självbetjäning och adminvyn).
  const target = await env.DB.prepare("SELECT is_admin FROM accounts WHERE id = ?").bind(accountId).first<{ is_admin: number }>();
  if (target?.is_admin) {
    const row = await env.DB.prepare("SELECT COUNT(*) as n FROM accounts WHERE is_admin = 1").first<{ n: number }>();
    if ((row?.n ?? 0) <= 1) throw new Error("Kan inte radera det sista admin-kontot — utse en annan administratör först");
  }

  // R2-objekt (brevbilagor) städas separat — batchen nedan tar bara D1-rader.
  const { results: attachmentRows } = await env.DB.prepare(
    "SELECT r2_key FROM letter_attachments WHERE letter_id IN (SELECT id FROM letters WHERE account_id = ?)",
  ).bind(accountId).all<{ r2_key: string }>();

  await env.DB.batch([
    env.DB.prepare("DELETE FROM letter_attachments WHERE letter_id IN (SELECT id FROM letters WHERE account_id = ?)").bind(accountId),
    env.DB.prepare("DELETE FROM send_log WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM send_jobs WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM public_letters WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM letters WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM mail_credentials WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM oauth_identities WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(accountId),
    env.DB.prepare("UPDATE feedback SET account_id = NULL WHERE account_id = ?").bind(accountId),
    env.DB.prepare("UPDATE worker_errors SET account_id = NULL WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
  ]);

  if (attachmentRows.length > 0) {
    // Best-effort: kvarlämnade R2-objekt är föräldralösa men oåtkomliga utan
    // letter_attachments-raden, så ett misslyckande här läcker ingen data.
    try {
      await env.ATTACHMENTS.delete(attachmentRows.map((r) => r.r2_key));
    } catch {
      /* föräldralösa objekt städas vid behov manuellt — blockerar inte raderingen */
    }
  }
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

// En sökträff = EN person (grupperad på e-post — samma adress = samma person;
// olika personer med samma namn har olika adresser) med ALLA sina
// befattningar/anknytningar samlade, så besökaren ser vem hen riktar sig till.
export interface PoliticianSearchHit {
  name: string;
  email: string;
  affiliations: { role: string | null; area_name: string; party: string | null }[];
}

// CHAR(30)/CHAR(31) = ASCII record-/unit-separator. Förekommer aldrig i namn,
// områden eller partier, så de är säkra fält-/radavgränsare i GROUP_CONCAT.
const AFF_SEP = "\x1e";
const FIELD_SEP = "\x1f";

// Sökning bland politiker — global, eller begränsad till valda områden.
// Används för att låta användaren hitta, rikta till eller exkludera enskilda.
export async function searchPoliticiansInAreas(db: D1Database, areaNames: string[], query: string): Promise<PoliticianSearchHit[]> {
  // Tomt areaNames = sök bland ALLA politiker (global individsökning) — så
  // användaren kan rikta till / exkludera enskilda utan att först välja område.
  let sql = `SELECT email, MAX(name) as name,
       GROUP_CONCAT(
         COALESCE(NULLIF(TRIM(role), ''), '') || CHAR(31) || area_name || CHAR(31) || COALESCE(party, ''),
         CHAR(30)
       ) as affiliations
     FROM politicians
     WHERE name LIKE ? AND email IS NOT NULL AND email != ''`;
  const params: unknown[] = [`%${query}%`];
  if (areaNames.length > 0) {
    sql += ` AND area_name IN (${areaNames.map(() => "?").join(",")})`;
    params.push(...areaNames);
  }
  sql += ` GROUP BY email ORDER BY name LIMIT 50`;
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ email: string; name: string; affiliations: string | null }>();

  return results.map((r) => {
    const seen = new Set<string>();
    const affiliations: PoliticianSearchHit["affiliations"] = [];
    for (const part of (r.affiliations ?? "").split(AFF_SEP)) {
      if (seen.has(part)) continue; // dedupa identiska (roll, område, parti)
      seen.add(part);
      const [role, area_name, party] = part.split(FIELD_SEP);
      affiliations.push({ role: role || null, area_name: area_name ?? "", party: party || null });
    }
    return { name: r.name, email: r.email, affiliations };
  });
}

export async function getRecipientsForAreas(
  db: D1Database,
  areaNames: string[],
  excludeParties: string[] = [],
  excludeEmails: string[] = [],
  includeRoles: string[] = [],
  includeEmails: string[] = [],
) {
  // Oberoende filter, valfri ordning:
  //  - "pool" = politiker som matchar valda områden OCH valda befattningar
  //    (tomt område = alla områden, tom roll = alla roller). Poolen tas bara
  //    med om användaren faktiskt valt minst ett område eller en befattning —
  //    annars skickar vi inte oavsiktligt till hela landet.
  //  - includeEmails = enskilt utvalda ("rikta till"), alltid med oavsett pool.
  //  - excludeParties drabbar bara poolen, inte de enskilt utvalda.
  //  - excludeEmails plockas bort sist (vinner över allt).
  // Dedupar på e-post så ingen får dubbla brev (samma person kan ligga i
  // flera områden, t.ex. både kommun och region).
  const byEmail = new Map<string, { name: string; email: string; area_name: string }>();

  const hasPoolIntent = areaNames.length > 0 || includeRoles.length > 0;
  if (hasPoolIntent) {
    let sql = `SELECT name, email, area_name FROM politicians WHERE 1=1`;
    const params: unknown[] = [];
    if (areaNames.length > 0) {
      sql += ` AND area_name IN (${areaNames.map(() => "?").join(",")})`;
      params.push(...areaNames);
    }
    if (includeRoles.length > 0) {
      // includeRoles innehåller normaliserade nycklar (lower+trim, se
      // listRoles) — matcha mot samma normalisering av den lagrade kolumnen,
      // annars missas mottagare vars roll har annat skiftläge än det valda.
      sql += ` AND LOWER(TRIM(role)) IN (${includeRoles.map(() => "?").join(",")})`;
      params.push(...includeRoles);
    }
    if (excludeParties.length > 0) {
      sql += ` AND (party IS NULL OR party NOT IN (${excludeParties.map(() => "?").join(",")}))`;
      params.push(...excludeParties);
    }
    const { results } = await db
      .prepare(sql)
      .bind(...params)
      .all<{ name: string; email: string; area_name: string }>();
    for (const r of results) byEmail.set(r.email, r);
  }

  if (includeEmails.length > 0) {
    const ph = includeEmails.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT name, email, area_name FROM politicians WHERE email IN (${ph})`)
      .bind(...includeEmails)
      .all<{ name: string; email: string; area_name: string }>();
    for (const r of results) byEmail.set(r.email, r);
  }

  for (const e of excludeEmails) byEmail.delete(e);
  return [...byEmail.values()];
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
