import { randomId, generateApiKey, sha256Hex } from "../../shared/crypto";
import { getAccountById, type Env } from "./db";

export async function createApiKey(env: Env, accountId: string, name: string): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const keyHash = await sha256Hex(key);
  const id = randomId();
  await env.DB.prepare("INSERT INTO api_keys (id, account_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, accountId, keyHash, name || "Namnlös nyckel", Date.now())
    .run();
  return { id, key }; // klartexten returneras bara här, en gång
}

export async function listApiKeys(env: Env, accountId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at, last_used_at FROM api_keys WHERE account_id = ? ORDER BY created_at DESC",
  )
    .bind(accountId)
    .all();
  return results;
}

export async function revokeApiKey(env: Env, accountId: string, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND account_id = ?").bind(id, accountId).run();
}

export async function getAccountFromApiKey(env: Env, key: string) {
  if (!key.startsWith("pwapi_")) return null;
  const keyHash = await sha256Hex(key);
  const row = await env.DB.prepare("SELECT id, account_id FROM api_keys WHERE key_hash = ?").bind(keyHash).first<{ id: string; account_id: string }>();
  if (!row) return null;

  // Uppdatera last_used_at "best effort" — väntar inte på den, ska inte sakta ner requesten
  env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run().catch(() => {});

  const account = await getAccountById(env.DB, row.account_id);
  if (account?.disabled) return null; // inaktiverade konton tappar omedelbart åtkomst, även via API-nyckel
  return account;
}
