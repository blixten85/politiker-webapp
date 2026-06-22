import { encryptSecret, randomId } from "../../shared/crypto";
import { testSmtpAuth } from "../../shared/smtp";
import type { Env } from "./db";

export const PROVIDER_PRESETS: Record<string, { host: string; port: number; helpUrl: string }> = {
  gmail: { host: "smtp.gmail.com", port: 587, helpUrl: "https://myaccount.google.com/apppasswords" },
  outlook: { host: "smtp.office365.com", port: 587, helpUrl: "https://account.live.com/proofs/AppPassword" },
  icloud: { host: "smtp.mail.me.com", port: 587, helpUrl: "https://appleid.apple.com/account/manage" },
  generic: { host: "", port: 587, helpUrl: "" },
};

export async function addMailCredential(
  env: Env,
  accountId: string,
  input: { provider: string; host?: string; port?: number; user: string; password: string; fromAddress: string },
): Promise<{ id: string }> {
  const preset = PROVIDER_PRESETS[input.provider];
  if (!preset) throw new Error("Okänd leverantör");
  const host = input.provider === "generic" ? input.host! : preset.host;
  const port = input.provider === "generic" ? input.port! : preset.port;
  if (!host || !port) throw new Error("Host/port saknas");

  // Verifiera mot leverantören innan vi sparar något — direkt feedback till användaren.
  await testSmtpAuth({ host, port, user: input.user, password: input.password, fromAddress: input.fromAddress });

  const id = randomId();
  const encryptedPassword = await encryptSecret(input.password, env.MAIL_CRED_KEY);
  await env.DB.prepare(
    `INSERT INTO mail_credentials (id, account_id, provider, smtp_host, smtp_port, smtp_user, encrypted_password, from_address, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, accountId, input.provider, host, port, input.user, encryptedPassword, input.fromAddress, Date.now(), Date.now())
    .run();

  return { id };
}

export async function listMailCredentials(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, provider, smtp_host, smtp_port, from_address, verified_at, created_at FROM mail_credentials WHERE account_id = ?",
  )
    .bind(accountId)
    .all();
  return results; // observera: lösenord/encrypted_password skickas aldrig till klienten
}

export async function deleteMailCredential(env: Env, accountId: string, credentialId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM mail_credentials WHERE id = ? AND account_id = ?").bind(credentialId, accountId).run();
}
