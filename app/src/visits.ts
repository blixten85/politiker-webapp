import { randomId } from "../../shared/crypto";
import type { Env } from "./db";

// Salt för besökarhashen. Behöver inte vara hemligt på samma sätt som t.ex.
// MAIL_CRED_KEY — det enda det skyddar är att en läckt visits-tabell inte
// trivialt ska kunna kopplas till en IP. Hashen är ändå irreversibel utan
// både IP och user-agent (som aldrig lagras). Sätt env.VISITOR_SALT för att
// rotera vid behov; annars används denna konstant.
const DEFAULT_SALT = "politiker-webapp-visit-v1";

async function visitorHash(env: Env, req: Request): Promise<string> {
  const ip = req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For") ?? "okänd";
  const ua = req.headers.get("User-Agent") ?? "okänd";
  const salt = env.VISITOR_SALT ?? DEFAULT_SALT;
  const data = new TextEncoder().encode(`${salt}|${ip}|${ua}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Spelar in en sidladdning. Best-effort: anropas via ctx.waitUntil och får
// aldrig blockera eller fälla svaret. Lagrar bara hash + tidpunkt.
export async function recordVisit(env: Env, req: Request): Promise<void> {
  try {
    const hash = await visitorHash(env, req);
    await env.DB.prepare("INSERT INTO visits (id, visitor_hash, visited_at) VALUES (?, ?, ?)")
      .bind(randomId(), hash, Date.now())
      .run();
  } catch {
    // Tabellen kan saknas innan migrationen körts, eller skrivningen kan fela —
    // besöksloggning ska aldrig påverka sidladdningen.
  }
}
