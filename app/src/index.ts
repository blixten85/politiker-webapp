import {
  signup,
  verifyEmail,
  login,
  getAccountFromSession,
  requestPasswordReset,
  resetPassword,
  startTotpSetup,
  confirmTotpSetup,
  disableTotp,
  setPassword,
} from "./auth";
import { addMailCredential, listMailCredentials, deleteMailCredential, addMicrosoftGraphMailCredential } from "./mail-credentials";
import { listAreas } from "./db";
import { createAndEnqueueSendJob, getSendJobsForAccount } from "./send";
import { submitFeedback } from "./feedback";
import { getAuthorizeUrl, handleOAuthCallback } from "./oauth";
import { getMicrosoftMailAuthorizeUrl } from "../../shared/graph-mail";
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

    // --- OAuth start/callback returnerar redirects, inte JSON — hanteras separat. ---
    const oauthMatch = url.pathname.match(/^\/api\/oauth\/([a-z]+)\/(start|callback)$/);
    if (oauthMatch) {
      const [, provider, step] = oauthMatch;
      try {
        if (step === "start") {
          const state = randomId();
          await env.SESSIONS.put(`oauthstate:${state}`, "1", { expirationTtl: 600 });
          return Response.redirect(getAuthorizeUrl(provider, env, state), 302);
        }
        // callback
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return json({ error: "Saknar code/state" }, 400);
        const validState = await env.SESSIONS.get(`oauthstate:${state}`);
        if (!validState) return json({ error: "Ogiltig eller utgången state — försök igen" }, 400);
        await env.SESSIONS.delete(`oauthstate:${state}`);

        const { accountId } = await handleOAuthCallback(provider, env, code);
        const sessionToken = randomId() + randomId();
        await env.SESSIONS.put(`session:${sessionToken}`, accountId, { expirationTtl: 60 * 60 * 24 * 30 });
        const resp = Response.redirect("https://politiker.denied.se/", 302);
        const headers = new Headers(resp.headers);
        headers.set("Set-Cookie", setSessionCookie(sessionToken));
        return new Response(null, { status: 302, headers });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "OAuth-fel" }, 400);
      }
    }

    // --- OAuth-koppling för MAILSÄNDNING (Microsoft Graph) — kräver att man
    // redan är inloggad på politiker-webapp (kopplar credential till befintligt konto). ---
    const oauthMailMatch = url.pathname.match(/^\/api\/oauth-mail\/microsoft\/(start|callback)$/);
    if (oauthMailMatch) {
      const [, step] = oauthMailMatch;
      try {
        const sessionToken = getCookie(req, "session");
        const account = await getAccountFromSession(env, sessionToken);
        if (!account) return json({ error: "Inte inloggad" }, 401);

        if (step === "start") {
          if (!env.OAUTH_MICROSOFT_CLIENT_ID) {
            return json({ error: "Microsoft-koppling för mailsändning är inte konfigurerad än" }, 400);
          }
          const state = randomId();
          await env.SESSIONS.put(`oauthmailstate:${state}`, account.id as string, { expirationTtl: 600 });
          return Response.redirect(getMicrosoftMailAuthorizeUrl(env.OAUTH_MICROSOFT_CLIENT_ID, state), 302);
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return json({ error: "Saknar code/state" }, 400);
        const stateAccountId = await env.SESSIONS.get(`oauthmailstate:${state}`);
        if (!stateAccountId) return json({ error: "Ogiltig eller utgången state — försök igen" }, 400);
        await env.SESSIONS.delete(`oauthmailstate:${state}`);

        await addMicrosoftGraphMailCredential(env, stateAccountId, code);
        return new Response(null, { status: 302, headers: { Location: "https://politiker.denied.se/" } });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "OAuth-fel" }, 400);
      }
    }

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
        const { email, password, totpCode } = await req.json<{ email: string; password: string; totpCode?: string }>();
        const { sessionToken: token } = await login(env, email, password, totpCode);
        const resp = json({ ok: true });
        resp.headers.set("Set-Cookie", setSessionCookie(token));
        return resp;
      }

      if (url.pathname === "/api/logout" && req.method === "POST") {
        if (sessionToken) await env.SESSIONS.delete(`session:${sessionToken}`);
        const resp = json({ ok: true });
        resp.headers.set("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
        return resp;
      }

      if (url.pathname === "/api/request-password-reset" && req.method === "POST") {
        const { email } = await req.json<{ email: string }>();
        await requestPasswordReset(env, email);
        return json({ ok: true }); // alltid ok, avslöjar inte om kontot finns
      }

      if (url.pathname === "/api/reset-password" && req.method === "POST") {
        const { token, newPassword } = await req.json<{ token: string; newPassword: string }>();
        await resetPassword(env, token, newPassword);
        return json({ ok: true });
      }

      if (url.pathname === "/api/me" && req.method === "GET") {
        if (!account) return json({ loggedIn: false });
        return json({
          loggedIn: true,
          email: account.email,
          dailySendCap: account.daily_send_cap,
          isAdmin: !!account.is_admin,
          totpEnabled: !!account.totp_enabled,
        });
      }

      // Feedback/felrapportering kräver INTE inloggning — fel kan inträffa
      // innan ett konto finns (t.ex. under signup), och vi vill aldrig
      // tvinga en bugg-rapportör att först logga in.
      if (url.pathname === "/api/feedback" && req.method === "POST") {
        const { message, context } = await req.json<{ message: string; context?: Record<string, unknown> }>();
        const result = await submitFeedback(env, { accountId: account ? (account.id as string) : null, message, context });
        return json(result);
      }

      // Allt nedanför kräver inloggning
      if (!account) return json({ error: "Inte inloggad" }, 401);
      const accountId = account.id as string;
      const isAdmin = !!account.is_admin;

      if (url.pathname === "/api/totp/setup" && req.method === "POST") {
        return json(await startTotpSetup(env, accountId));
      }

      if (url.pathname === "/api/totp/confirm" && req.method === "POST") {
        const { code } = await req.json<{ code: string }>();
        await confirmTotpSetup(env, accountId, code);
        return json({ ok: true });
      }

      if (url.pathname === "/api/totp/disable" && req.method === "POST") {
        await disableTotp(env, accountId);
        return json({ ok: true });
      }

      if (url.pathname === "/api/set-password" && req.method === "POST") {
        const { newPassword } = await req.json<{ newPassword: string }>();
        await setPassword(env, accountId, newPassword);
        return json({ ok: true });
      }

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

      // --- Admin-endpoints: kräver is_admin = 1. Övriga konton ser ALDRIG
      // varandras data via vanliga endpoints ovan (alla filtrerar på egen
      // account_id) — admin-vyerna nedan är det enda undantaget, och de är
      // läs-orienterade översikter, inte ett sätt att agera å andra kontons vägnar.
      if (url.pathname.startsWith("/api/admin/")) {
        if (!isAdmin) return json({ error: "Kräver admin-behörighet" }, 403);

        if (url.pathname === "/api/admin/accounts" && req.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT id, email, email_verified, daily_send_cap, is_admin, created_at FROM accounts ORDER BY created_at DESC",
          ).all();
          return json(results);
        }

        if (url.pathname === "/api/admin/feedback" && req.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100").all();
          return json(results);
        }

        if (url.pathname === "/api/admin/send-jobs" && req.method === "GET") {
          const { results } = await env.DB.prepare(
            `SELECT sj.*, a.email FROM send_jobs sj JOIN accounts a ON a.id = sj.account_id ORDER BY sj.created_at DESC LIMIT 100`,
          ).all();
          return json(results);
        }

        return json({ error: "Not found" }, 404);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Okänt fel" }, 400);
    }
  },
};
