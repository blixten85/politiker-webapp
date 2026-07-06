import { hashPassword, verifyPassword, randomId, randomVerificationCode } from "../../shared/crypto";
import { sendSmtpMail } from "../../shared/smtp";
import { generateTotpSecret, totpAuthUri, verifyTotpCode } from "../../shared/totp";
import { createAccount, getAccountByEmail, getAccountById, verifyAccountEmail, deleteAccount, type Env } from "./db";
import { enforceAttemptLimit, recordFailedAttempt, clearAttempts } from "./rate-limit";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dagar
const RESET_TTL_MS = 30 * 60 * 1000; // 30 min

// Brute-force-spärrar (försök inom glidande fönster). Lösenords-/TOTP-koll
// och e-postverifiering har annars inga försöksgränser — utan detta är en
// 6-siffrig TOTP/verifieringskod gissningsbar med tillräckligt många anrop.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const CODE_MAX_ATTEMPTS = 10;
const CODE_WINDOW_SECONDS = 60 * 60;

// Dummy-hash att verifiera mot när e-posten inte finns, så att en inloggning
// mot en okänd adress kostar lika mycket tid (PBKDF2) som en mot en känd —
// annars skulle svarstiden avslöja vilka adresser som är registrerade.
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA=="; // 16 nollbytes, base64
const DUMMY_HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

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
  await enforceAttemptLimit(env, "verify", accountId, { max: CODE_MAX_ATTEMPTS, windowSeconds: CODE_WINDOW_SECONDS });
  const ok = await verifyAccountEmail(env.DB, accountId, code);
  if (!ok) {
    await recordFailedAttempt(env, "verify", accountId, CODE_WINDOW_SECONDS);
    throw new Error("Felaktig eller utgången kod");
  }
  await clearAttempts(env, "verify", accountId);
}

export async function login(
  env: Env,
  email: string,
  password: string,
  totpCode?: string,
): Promise<{ sessionToken: string }> {
  // Spärren gäller per e-post och räknar även försök mot icke-existerande
  // konton — annars skulle ett uteblivet lockout avslöja vilka adresser som
  // saknas. Misslyckade inloggningar (fel konto/lösenord/TOTP) räknas upp,
  // ett lyckat login nollställer.
  await enforceAttemptLimit(env, "login", email, { max: LOGIN_MAX_ATTEMPTS, windowSeconds: LOGIN_WINDOW_SECONDS });

  const account = await getAccountByEmail(env.DB, email);

  // Verifiera lösenordet INNAN något kontospecifikt tillstånd avslöjas.
  // Allt som gäller ett enskilt konto (inaktiverat, overifierat) får bara
  // visas för den som redan bevisat lösenordet — annars kan felmeddelandena
  // användas för att kartlägga vilka adresser som är registrerade. Okända
  // konton verifieras mot en dummy så svarstiden blir densamma.
  // (Konton skapade via OAuth har ett slumpat oanvändbart lösenord och
  // faller därför naturligt igenom som "fel lösenord" — de loggar in via
  // leverantörsknappen istället.)
  const passwordOk = await verifyPassword(
    password,
    (account?.password_hash as string) ?? DUMMY_HASH,
    (account?.password_salt as string) ?? DUMMY_SALT,
  );
  if (!account || !passwordOk) {
    await recordFailedAttempt(env, "login", email, LOGIN_WINDOW_SECONDS);
    throw new Error("Fel e-post eller lösenord");
  }

  if (account.disabled) throw new Error("Kontot är inaktiverat — kontakta support om du tror detta är ett fel");
  if (!account.email_verified) throw new Error("E-postadressen är inte verifierad än");

  if (account.totp_enabled) {
    if (!totpCode) throw new Error("TOTP_REQUIRED");
    const validTotp = await verifyTotpCode(account.totp_secret as string, totpCode);
    if (!validTotp) {
      await recordFailedAttempt(env, "login", email, LOGIN_WINDOW_SECONDS);
      throw new Error("Fel TOTP-kod");
    }
  }

  await clearAttempts(env, "login", email);
  const sessionToken = randomId() + randomId();
  await env.SESSIONS.put(`session:${sessionToken}`, account.id as string, { expirationTtl: SESSION_TTL_SECONDS });
  return { sessionToken };
}

export async function getAccountFromSession(env: Env, sessionToken: string | null) {
  if (!sessionToken) return null;
  const accountId = await env.SESSIONS.get(`session:${sessionToken}`);
  if (!accountId) return null;
  const account = await getAccountById(env.DB, accountId);
  if (account?.disabled) return null; // inaktiverade konton tappar omedelbart åtkomst, även med giltig sessionskaka
  return account;
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

  const account = await env.DB.prepare("SELECT id, email, reset_expires_at FROM accounts WHERE reset_token = ?")
    .bind(token)
    .first<{ id: string; email: string; reset_expires_at: number }>();
  if (!account || Date.now() > account.reset_expires_at) {
    throw new Error("Återställningslänken är ogiltig eller har gått ut");
  }

  const { hash, salt } = await hashPassword(newPassword);

  // Nollställ inloggningsspärren FÖRE token-/lösenordsuppdateringen (CodeRabbit-
  // fynd): om clearAttempts skulle kasta efter att UPDATE lyckats hade
  // användaren redan bytt lösenord men återstått utelåst med en nu ogiltig
  // återställningslänk — omöjlig att lösa själv.
  await clearAttempts(env, "login", account.email);

  await env.DB.prepare(
    "UPDATE accounts SET password_hash = ?, password_salt = ?, password_set_by_user = 1, reset_token = NULL, reset_expires_at = NULL WHERE id = ?",
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
  await enforceAttemptLimit(env, "totp-setup", accountId, { max: CODE_MAX_ATTEMPTS, windowSeconds: CODE_WINDOW_SECONDS });
  const account = await getAccountById(env.DB, accountId);
  if (!account || !account.totp_secret) throw new Error("Ingen TOTP-uppsättning pågår");
  const valid = await verifyTotpCode(account.totp_secret as string, code);
  if (!valid) {
    await recordFailedAttempt(env, "totp-setup", accountId, CODE_WINDOW_SECONDS);
    throw new Error("Fel kod — kontrollera att klockan på din enhet är rätt");
  }
  await clearAttempts(env, "totp-setup", accountId);
  await env.DB.prepare("UPDATE accounts SET totp_enabled = 1 WHERE id = ?").bind(accountId).run();
}

export async function setPassword(env: Env, accountId: string, newPassword: string): Promise<void> {
  if (newPassword.length < 10) throw new Error("Lösenordet måste vara minst 10 tecken");
  const { hash, salt } = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE accounts SET password_hash = ?, password_salt = ?, password_set_by_user = 1 WHERE id = ?").bind(hash, salt, accountId).run();
}

export async function disableTotp(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET totp_enabled = 0, totp_secret = NULL WHERE id = ?").bind(accountId).run();
}

// Admin-initierad: till skillnad från requestPasswordReset (självbetjäning,
// avslöjar aldrig om kontot finns) känner admin redan till kontot, så vi
// skickar alltid länken direkt.
export async function adminResetPassword(env: Env, targetAccountId: string): Promise<void> {
  const account = await getAccountById(env.DB, targetAccountId);
  if (!account) throw new Error("Konto saknas");

  const token = randomId() + randomId();
  await env.DB.prepare("UPDATE accounts SET reset_token = ?, reset_expires_at = ? WHERE id = ?")
    .bind(token, Date.now() + RESET_TTL_MS, targetAccountId)
    .run();

  const resetUrl = `https://politiker.denied.se/?reset=${token}`;
  await sendSystemMail(
    env,
    account.email as string,
    "Återställ ditt lösenord — politiker.denied.se",
    `<p>En administratör har begärt en lösenordsåterställning åt dig. Klicka för att sätta ett nytt lösenord: <a href="${resetUrl}">${resetUrl}</a></p><p>Länken gäller i 30 minuter. Kontakta oss om du inte förväntade dig detta.</p>`,
  );
}

export async function setAccountDisabled(env: Env, targetAccountId: string, disabled: boolean): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET disabled = ? WHERE id = ?").bind(disabled ? 1 : 0, targetAccountId).run();
}

// Självbetjäning: kontoinnehavaren raderar sitt EGET konto permanent. Kräver
// återautentisering — lösenord om ett sådant är satt av användaren, och TOTP
// om 2FA är aktiverat — så att en kapad men inte återautentiserad session inte
// kan radera kontot. Konton skapade enbart via OAuth (utan eget lösenord och
// utan 2FA) bekräftas av den aktiva sessionen i sig.
export async function deleteOwnAccount(env: Env, accountId: string, password?: string, totpCode?: string): Promise<void> {
  const account = await getAccountById(env.DB, accountId);
  if (!account) throw new Error("Konto saknas");

  if (account.password_set_by_user) {
    const ok = await verifyPassword(password ?? "", account.password_hash as string, account.password_salt as string);
    if (!ok) throw new Error("Fel lösenord");
  }
  if (account.totp_enabled) {
    if (!totpCode) throw new Error("TOTP_REQUIRED");
    const valid = await verifyTotpCode(account.totp_secret as string, totpCode);
    if (!valid) throw new Error("Fel TOTP-kod");
  }

  await deleteAccount(env, accountId);
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
