import { hashPassword, verifyPassword, randomId, randomVerificationCode } from "../../shared/crypto";
import { sendSmtpMail } from "../../shared/smtp";
import { createAccount, getAccountByEmail, getAccountById, verifyAccountEmail, type Env } from "./db";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dagar

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

export async function login(env: Env, email: string, password: string): Promise<{ sessionToken: string }> {
  const account = await getAccountByEmail(env.DB, email);
  if (!account) throw new Error("Fel e-post eller lösenord");
  const ok = await verifyPassword(password, account.password_hash as string, account.password_salt as string);
  if (!ok) throw new Error("Fel e-post eller lösenord");
  if (!account.email_verified) throw new Error("E-postadressen är inte verifierad än");

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
