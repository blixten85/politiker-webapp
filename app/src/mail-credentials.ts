import { encryptSecret, randomId } from "../../shared/crypto";
import { testSmtpAuth } from "../../shared/smtp";
import type { Env } from "./db";

// providerDailyLimit = leverantörens kända verkliga gräns (mottagare/dygn) per
// juni 2026 — kan ändras av leverantören utan att vi får besked, se README
// för påminnelse om periodisk omkontroll. safetyMarginPct avgör hur stor andel
// av den gränsen vi faktiskt tillåter, så att personens egen vanliga
// mailanvändning på samma konto inte trängs ut.
export const PROVIDER_PRESETS: Record<
  string,
  { host: string; port: number; helpUrl: string; providerDailyLimit: number | null; safetyMarginPct: number }
> = {
  gmail: {
    host: "smtp.gmail.com",
    port: 587,
    helpUrl: "https://myaccount.google.com/apppasswords",
    providerDailyLimit: 100, // SMTP-specifik gräns för fria Gmail-konton (verifierad jun 2026) — lägre än de 500 som ofta nämns, vilket gäller webbgränssnittet/API, inte SMTP-relä
    safetyMarginPct: 0.6,
  },
  outlook: {
    host: "smtp.office365.com",
    port: 587,
    helpUrl: "https://account.live.com/proofs/AppPassword",
    providerDailyLimit: 300, // personligt Outlook.com-konto
    safetyMarginPct: 0.6,
  },
  icloud: {
    host: "smtp.mail.me.com",
    port: 587,
    helpUrl: "https://appleid.apple.com/account/manage",
    providerDailyLimit: 1000, // verifierat empiriskt tidigare i projektet
    safetyMarginPct: 0.5,
  },
  yahoo: {
    host: "smtp.mail.yahoo.com",
    port: 587,
    helpUrl: "https://login.yahoo.com/account/security",
    providerDailyLimit: 500,
    safetyMarginPct: 0.6,
  },
  generic: { host: "", port: 587, helpUrl: "", providerDailyLimit: null, safetyMarginPct: 1 },
};

function suggestedDailyCap(provider: string): number | null {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset || preset.providerDailyLimit === null) return null;
  return Math.floor(preset.providerDailyLimit * preset.safetyMarginPct);
}

export async function addMailCredential(
  env: Env,
  accountId: string,
  input: { provider: string; host?: string; port?: number; user: string; password: string; fromAddress: string },
): Promise<{ id: string; dailyCap: number | null }> {
  const preset = PROVIDER_PRESETS[input.provider];
  if (!preset) throw new Error("Okänd leverantör");
  const host = input.provider === "generic" ? input.host! : preset.host;
  const port = input.provider === "generic" ? input.port! : preset.port;
  if (!host || !port) throw new Error("Host/port saknas");

  // Verifiera mot leverantören innan vi sparar något — direkt feedback till användaren.
  await testSmtpAuth({ host, port, user: input.user, password: input.password, fromAddress: input.fromAddress });

  const id = randomId();
  const encryptedPassword = await encryptSecret(input.password, env.MAIL_CRED_KEY);
  const dailyCap = suggestedDailyCap(input.provider);
  await env.DB.prepare(
    `INSERT INTO mail_credentials (id, account_id, provider, smtp_host, smtp_port, smtp_user, encrypted_password, from_address, verified_at, daily_cap, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, accountId, input.provider, host, port, input.user, encryptedPassword, input.fromAddress, Date.now(), dailyCap, Date.now())
    .run();

  return { id, dailyCap };
}

export async function listMailCredentials(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, provider, smtp_host, smtp_port, from_address, verified_at, daily_cap, created_at FROM mail_credentials WHERE account_id = ?",
  )
    .bind(accountId)
    .all();
  return results; // observera: lösenord/encrypted_password skickas aldrig till klienten
}

export async function deleteMailCredential(env: Env, accountId: string, credentialId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM mail_credentials WHERE id = ? AND account_id = ?").bind(credentialId, accountId).run();
}
