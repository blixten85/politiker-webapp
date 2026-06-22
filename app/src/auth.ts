import { hashPassword, verifyPassword, randomId, randomVerificationCode } from "../../shared/crypto";
import { sendSmtpMail } from "../../shared/smtp";
import { generateTotpSecret, totpAuthUri, verifyTotpCode } from "../../shared/totp";
import { createAccount, getAccountByEmail, getAccountById, verifyAccountEmail, type Env } from "./db";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dagar
const RESET_TTL_MS = 30 * 60 * 1000; // 30 min

export async function signup(env: Env, email: string, password: string): Promise<{ accountId: string }> {
  const existing = await getAccountByEmail(env.DB, email);
  if (existing) throw new Error("E-postadressen är redan registrerad");
  if (password.length < 10) throw new Error("Lösenordet måste vara minst 10 tecken");

  const { hash, salt } = await hashPassword(password);
  const code = randomVerificationCode();
  const accountId = await createAccount(env.DB, { email, passwordHash: hash, passwordSalt: salt, verificationCode: code });

  await sendSystemMail(env, email, "Bekräfta din e-postadress — politiker.denied.se", verificationEmailHtml(code));

  return { accountId };
}

export async function verifyEmail(env: Env, accountId: string, code: string): Promise<void> {
  const ok = await verifyAccountEmail(env.DB, accountId, code);
  if (!ok) throw new Error("Felaktig eller utgången kod");
}

export async function login(
  env: Env,
  email: string,
  password: string,
  totpCode?: string,
): Promise<{ sessionToken: string }> {
  const account = await getAccountByEmail(env.DB, email);
  if (!account) throw new Error("Fel e-post eller lösenord");
  if (!account.password_hash) throw new Error("Det här kontot använder inloggning via leverantör — använd den knappen istället");
  const ok = await verifyPassword(password, account.password_hash as string, account.password_salt as string);
  if (!ok) throw new Error("Fel e-post eller lösenord");
  if (!account.email_verified) throw new Error("E-postadressen är inte verifierad än");

  if (account.totp_enabled) {
    if (!totpCode) throw new Error("TOTP_REQUIRED");
    const validTotp = await verifyTotpCode(account.totp_secret as string, totpCode);
    if (!validTotp) throw new Error("Fel TOTP-kod");
  }

  const sessionToken = randomId() + randomId();
  await env.SESSIONS.put(`session:${sessionToken}`, account.id as string, { expirationTtl: SESSION_TTL_SECONDS });
  return { sessionToken };
}

export async function getAccountFromSession(env: Env, sessionToken: string | null) {
  if (!sessionToken) return null;
  const accountId = await env.SESSIONS.get(`session:${sessionToken}`);
  if (!accountId) return null;
  return getAccountById(env.DB, accountId);
}

export async function requestPasswordReset(env: Env, email: string): Promise<void> {
  const account = await getAccountByEmail(env.DB, email);
  if (!account) return; // avslöja inte om e-posten finns eller inte

  const token = randomId() + randomId();
  await env.DB.prepare("UPDATE accounts SET reset_token = ?, reset_expires_at = ? WHERE id = ?")
    .bind(token, Date.now() + RESET_TTL_MS, account.id)
    .run();

  const resetUrl = `https://politiker.denied.se/?reset=${token}`;
  await sendSystemMail(
    env,
    email,
    "Återställ ditt lösenord — politiker.denied.se",
    `<p>Klicka för att återställa ditt lösenord: <a href="${resetUrl}">${resetUrl}</a></p><p>Länken gäller i 30 minuter. Om du inte begärt detta kan du ignorera mejlet.</p>`,
  );
}

export async function resetPassword(env: Env, token: string, newPassword: string): Promise<void> {
  if (newPassword.length < 10) throw new Error("Lösenordet måste vara minst 10 tecken");

  const account = await env.DB.prepare("SELECT id, reset_expires_at FROM accounts WHERE reset_token = ?")
    .bind(token)
    .first<{ id: string; reset_expires_at: number }>();
  if (!account || Date.now() > account.reset_expires_at) {
    throw new Error("Återställningslänken är ogiltig eller har gått ut");
  }

  const { hash, salt } = await hashPassword(newPassword);
  await env.DB.prepare(
    "UPDATE accounts SET password_hash = ?, password_salt = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?",
  )
    .bind(hash, salt, account.id)
    .run();
}

export async function startTotpSetup(env: Env, accountId: string): Promise<{ secret: string; authUri: string }> {
  const account = await getAccountById(env.DB, accountId);
  if (!account) throw new Error("Konto saknas");
  const secret = generateTotpSecret();
  await env.DB.prepare("UPDATE accounts SET totp_secret = ?, totp_enabled = 0 WHERE id = ?").bind(secret, accountId).run();
  return { secret, authUri: totpAuthUri(secret, account.email as string) };
}

export async function confirmTotpSetup(env: Env, accountId: string, code: string): Promise<void> {
  const account = await getAccountById(env.DB, accountId);
  if (!account || !account.totp_secret) throw new Error("Ingen TOTP-uppsättning pågår");
  const valid = await verifyTotpCode(account.totp_secret as string, code);
  if (!valid) throw new Error("Fel kod — kontrollera att klockan på din enhet är rätt");
  await env.DB.prepare("UPDATE accounts SET totp_enabled = 1 WHERE id = ?").bind(accountId).run();
}

export async function disableTotp(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").bind(accountId).run();
}

export async function sendSystemMail(env: Env, to: string, subject: string, html: string): Promise<void> {
  await sendSmtpMail(
    {
      host: env.SYSTEM_SMTP_HOST,
      port: parseInt(env.SYSTEM_SMTP_PORT, 10),
      user: env.SYSTEM_SMTP_USER,
      password: env.SYSTEM_SMTP_PASSWORD,
      fromAddress: env.SYSTEM_FROM_ADDRESS,
    },
    { to, subject, html },
  );
}

function verificationEmailHtml(code: string): string {
  return `<p>Hej!</p><p>Din verifieringskod är: <strong>${code}</strong></p><p>Koden gäller i 30 minuter.</p>`;
}
