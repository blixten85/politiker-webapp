import { signup, verifyEmail, login, getAccountFromSession } from "./auth";
import { addMailCredential, listMailCredentials, deleteMailCredential } from "./mail-credentials";
import { listAreas } from "./db";
import { createAndEnqueueSendJob, getSendJobsForAccount } from "./send";
import { submitFeedback } from "./feedback";
import { randomId } from "../../shared/crypto";
import type { Env } from "./db";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

function setSessionCookie(token: string): string {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);
    }

    try {
      const sessionToken = getCookie(req, "session");
      const account = await getAccountFromSession(env, sessionToken);

      if (url.pathname === "/api/signup" && req.method === "POST") {
        const { email, password } = await req.json<{ email: string; password: string }>();
        const result = await signup(env, email, password);
        return json(result);
      }

      if (url.pathname === "/api/verify" && req.method === "POST") {
        const { accountId, code } = await req.json<{ accountId: string; code: string }>();
        await verifyEmail(env, accountId, code);
        return json({ ok: true });
      }

      if (url.pathname === "/api/login" && req.method === "POST") {
        const { email, password } = await req.json<{ email: string; password: string }>();
        const { sessionToken: token } = await login(env, email, password);
        const resp = json({ ok: true });
        resp.headers.set("Set-Cookie", setSessionCookie(token));
        return resp;
      }

      if (url.pathname === "/api/me" && req.method === "GET") {
        if (!account) return json({ loggedIn: false });
        return json({ loggedIn: true, email: account.email, dailySendCap: account.daily_send_cap });
      }

      // Allt nedanför kräver inloggning
      if (!account) return json({ error: "Inte inloggad" }, 401);
      const accountId = account.id as string;

      if (url.pathname === "/api/areas" && req.method === "GET") {
        return json(await listAreas(env.DB));
      }

      if (url.pathname === "/api/mail-credentials" && req.method === "GET") {
        return json(await listMailCredentials(env, accountId));
      }

      if (url.pathname === "/api/mail-credentials" && req.method === "POST") {
        const input = await req.json<Parameters<typeof addMailCredential>[2]>();
        const result = await addMailCredential(env, accountId, input);
        return json(result);
      }

      if (url.pathname.startsWith("/api/mail-credentials/") && req.method === "DELETE") {
        const id = url.pathname.split("/").pop()!;
        await deleteMailCredential(env, accountId, id);
        return json({ ok: true });
      }

      if (url.pathname === "/api/send" && req.method === "POST") {
        const input = await req.json<{ letterHtml: string; mailCredentialId: string; areaNames: string[] }>();
        const letterId = randomId();
        await env.DB.prepare("INSERT INTO letters (id, account_id, html_body, created_at) VALUES (?, ?, ?, ?)")
          .bind(letterId, accountId, input.letterHtml, Date.now())
          .run();
        const result = await createAndEnqueueSendJob(env, accountId, {
          letterId,
          htmlBody: input.letterHtml,
          mailCredentialId: input.mailCredentialId,
          areaNames: input.areaNames,
        });
        return json(result);
      }

      if (url.pathname === "/api/send-jobs" && req.method === "GET") {
        return json(await getSendJobsForAccount(env, accountId));
      }

      if (url.pathname === "/api/feedback" && req.method === "POST") {
        const { message, context } = await req.json<{ message: string; context?: Record<string, unknown> }>();
        const result = await submitFeedback(env, { accountId, message, context });
        return json(result);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Okänt fel" }, 400);
    }
  },
};
