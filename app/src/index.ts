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
  adminResetPassword,
  setAccountDisabled,
} from "./auth";
import { getAdminStats, exportAdminData } from "./admin-stats";
import {
  addMailCredential,
  listMailCredentials,
  deleteMailCredential,
  addMicrosoftGraphMailCredential,
  updateMailCredentialCapPct,
  PROVIDER_PRESETS,
  getCeiling,
  MICROSOFT_GRAPH_DAILY_LIMIT,
} from "./mail-credentials";
import { listAreas, listParties, listRoles, searchPoliticiansInAreas } from "./db";
import { createAndEnqueueSendJob, getSendJobsForAccount } from "./send";
import { submitFeedback } from "./feedback";
import { processAttachments, type AttachmentInput } from "./attachments";
import { createApiKey, listApiKeys, revokeApiKey, getAccountFromApiKey } from "./api-keys";
import { draftLetter } from "./draft-letter";
import { getAuthorizeUrl, handleOAuthCallback, getLinkAuthorizeUrl, handleOAuthLinkCallback, getOAuthIdentities, unlinkOAuthIdentity, providerSharesLoginCallback } from "./oauth";
import {
  approveCivicLetterDraft,
  rejectCivicLetterDraft,
  createCivicLetterDraft,
  sendApprovalNotification,
  getCivicLetterDraft,
  setCivicLetterStatus,
  getApprovedUnsentDraft,
  redactApproveToken,
} from "./civic-outreach";
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
    const resp = await handleRequest(req, env, url);
    // Cloudflares "Speed Brain"-funktion injicerar en Speculation-Rules-header
    // som ber webbläsaren spekulativt förhämta länkar (t.ex. OAuth-startlänkar)
    // — förhämtningar serveras ur ett separat cache-lager som inte rensas av
    // vanlig purge, vilket orsakade inloggningsknapparna att verka "bara ladda
    // om sidan". Tar bort headern helt så ingen sida på den här domänen
    // förhämtas spekulativt.
    const headers = new Headers(resp.headers);
    headers.delete("Speculation-Rules");
    // /api/* svarar aldrig statiskt (sessioner, OAuth-redirects, dynamisk data) —
    // tvinga no-store så Cloudflares edge-cache aldrig fastnar på ett gammalt svar.
    if (url.pathname.startsWith("/api/")) {
      headers.set("Cache-Control", "no-store");
    }

    // Logga API-fel (4xx utom 401/404, alla 5xx) till worker_errors för att
    // ge auto-triage-boten kontext om vad som gick fel server-sidan.
    // 401 = inte inloggad (förväntat), 404 = okänd rutt (förväntat) — loggas ej.
    // Endpoint = pathname only, aldrig query-params (kan innehålla tokens).
    if (
      url.pathname.startsWith("/api/") &&
      resp.status >= 400 &&
      resp.status !== 401 &&
      resp.status !== 404
    ) {
      try {
        const clone = resp.clone();
        const data = await clone.json<{ error?: string }>();
        const errorMessage = data.error ?? "okänt fel";
        const sessionToken = getCookie(req, "session");
        const account = sessionToken ? await getAccountFromSession(env, sessionToken) : null;
        await env.DB.prepare(
          "INSERT INTO worker_errors (id, account_id, method, endpoint, status, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(randomId(), account?.id ?? null, req.method, url.pathname, resp.status, errorMessage, Date.now())
          .run();
      } catch {
        // best effort — loggfel blockerar aldrig svaret
      }
    }

    return new Response(resp.body, { status: resp.status, headers });
  },
};

async function handleRequest(req: Request, env: Env, url: URL): Promise<Response> {

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
        const storedState = await env.SESSIONS.get(`oauthstate:${state}`);
        if (!storedState) return json({ error: "Ogiltig eller utgången state — försök igen" }, 400);
        await env.SESSIONS.delete(`oauthstate:${state}`);

        // Leverantörer med sharesLoginCallback (GitHub) lägger "link:<accountId>"
        // i state-värdet för länkflödet, eftersom de bara stödjer en callback-URL.
        if (storedState.startsWith("link:")) {
          const linkAccountId = storedState.slice("link:".length);
          await handleOAuthLinkCallback(provider, env, code, linkAccountId);
          return Response.redirect("https://politiker.denied.se/", 302);
        }

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

    // --- Civilsamhälls-brev: godkänn/avslå-länkar i granskningsmailet, ingen
    // inloggning krävs (token i URL:en är behörigheten). Inget skickas
    // förrän /approve anropats — ingen passiv timeout finns. ---
    const civicLetterMatch = url.pathname.match(/^\/api\/civic-letter\/([a-zA-Z0-9]+)\/(approve|reject)$/);
    if (civicLetterMatch) {
      const [, draftId, action] = civicLetterMatch;
      const token = url.searchParams.get("token");
      if (!token) return json({ error: "Saknar token" }, 400);
      try {
        if (action === "approve") {
          await approveCivicLetterDraft(env, draftId, token);
          return new Response("Godkänt — brevet skickas i kommande dagliga omgångar.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        await rejectCivicLetterDraft(env, draftId, token);
        return new Response("Avslaget — inget skickas.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "Fel" }, 400);
      }
    }

    // --- OAuth-LÄNKNING: koppla en ytterligare inloggningsleverantör till ett
    // REDAN INLOGGAT konto, utan att matcha på e-post eller skapa nya konton
    // (se oauth.ts: handleOAuthLinkCallback). ---
    const oauthLinkMatch = url.pathname.match(/^\/api\/oauth-link\/([a-z]+)\/(start|callback)$/);
    if (oauthLinkMatch) {
      const [, provider, step] = oauthLinkMatch;
      try {
        const sessionToken = getCookie(req, "session");
        const account = await getAccountFromSession(env, sessionToken);
        if (!account) return json({ error: "Inte inloggad" }, 401);

        if (step === "start") {
          const state = randomId();
          if (providerSharesLoginCallback(provider)) {
            // GitHub: lagra som "link:<accountId>" under login-state-nyckeln så
            // att callbacken till /api/oauth/<provider>/callback kan skilja flödena.
            await env.SESSIONS.put(`oauthstate:${state}`, `link:${account.id as string}`, { expirationTtl: 600 });
          } else {
            await env.SESSIONS.put(`oauthlinkstate:${state}`, account.id as string, { expirationTtl: 600 });
          }
          return Response.redirect(getLinkAuthorizeUrl(provider, env, state), 302);
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return json({ error: "Saknar code/state" }, 400);
        const stateAccountId = await env.SESSIONS.get(`oauthlinkstate:${state}`);
        if (!stateAccountId) return json({ error: "Ogiltig eller utgången state — försök igen" }, 400);
        await env.SESSIONS.delete(`oauthlinkstate:${state}`);
        if (stateAccountId !== account.id) return json({ error: "State tillhör en annan session — försök igen" }, 400);

        await handleOAuthLinkCallback(provider, env, code, stateAccountId);
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
      let account = await getAccountFromSession(env, sessionToken);

      // Alternativ till sessionskaka: Authorization: Bearer <api-nyckel> —
      // för programmatisk åtkomst utan webbläsare/inloggning.
      if (!account) {
        const authHeader = req.headers.get("Authorization");
        if (authHeader?.startsWith("Bearer ")) {
          account = await getAccountFromApiKey(env, authHeader.slice("Bearer ".length));
        }
      }

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
        const { message, context, type, replyTo } = await req.json<{
          message: string;
          context?: Record<string, unknown>;
          type?: "bug" | "contact";
          replyTo?: string;
        }>();
        const result = await submitFeedback(env, { accountId: account ? (account.id as string) : null, message, context, type, replyTo });
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

      if (url.pathname === "/api/oauth-identities" && req.method === "GET") {
        return json(await getOAuthIdentities(env, accountId));
      }

      const unlinkMatch = url.pathname.match(/^\/api\/oauth-identities\/([a-z]+)$/);
      if (unlinkMatch && req.method === "DELETE") {
        await unlinkOAuthIdentity(env, accountId, unlinkMatch[1]);
        return json({ ok: true });
      }

      if (url.pathname === "/api/api-keys" && req.method === "GET") {
        return json(await listApiKeys(env, accountId));
      }

      if (url.pathname === "/api/api-keys" && req.method === "POST") {
        const { name } = await req.json<{ name: string }>();
        return json(await createApiKey(env, accountId, name));
      }

      if (url.pathname.startsWith("/api/api-keys/") && req.method === "DELETE") {
        const id = url.pathname.split("/").pop()!;
        await revokeApiKey(env, accountId, id);
        return json({ ok: true });
      }

      if (url.pathname === "/api/areas" && req.method === "GET") {
        return json(await listAreas(env.DB));
      }

      if (url.pathname === "/api/parties" && req.method === "GET") {
        return json(await listParties(env.DB));
      }

      if (url.pathname === "/api/roles" && req.method === "GET") {
        return json(await listRoles(env.DB));
      }

      if (url.pathname === "/api/politicians/search" && req.method === "GET") {
        const areaNames = url.searchParams.getAll("areaName");
        const q = url.searchParams.get("q") ?? "";
        if (areaNames.length === 0 || q.length < 2) return json([]);
        return json(await searchPoliticiansInAreas(env.DB, areaNames, q));
      }

      if (url.pathname === "/api/mail-credentials" && req.method === "GET") {
        return json(await listMailCredentials(env, accountId));
      }

      if (url.pathname === "/api/provider-ceilings" && req.method === "GET") {
        const providers = [...Object.keys(PROVIDER_PRESETS), "microsoft_graph"];
        const result: Record<string, { providerDailyLimit: number | null; ceiling: number | null }> = {};
        for (const p of providers) {
          result[p] = {
            providerDailyLimit: p === "microsoft_graph" ? MICROSOFT_GRAPH_DAILY_LIMIT : PROVIDER_PRESETS[p].providerDailyLimit,
            ceiling: getCeiling(p),
          };
        }
        return json(result);
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

      const capPctMatch = url.pathname.match(/^\/api\/mail-credentials\/([^/]+)\/cap-pct$/);
      if (capPctMatch && req.method === "POST") {
        const { userCapPct } = await req.json<{ userCapPct: number }>();
        const result = await updateMailCredentialCapPct(env, accountId, capPctMatch[1], userCapPct);
        return json(result);
      }

      if (url.pathname === "/api/draft-letter" && req.method === "POST") {
        // Litet dygnstak — anropet kostar pengar (LLM + websökning) per
        // gång, oberoende av om mottagarlistan/utskicket annars är fritt.
        // OBS: best-effort, inte en hård spärr — KV är eventually consistent
        // och count+put är inte atomiskt, så några samtidiga requests kan i
        // teorin slinka förbi gränsen. Acceptabelt för ett kostnadsskydd i
        // den här skalan; en Durable Object skulle krävas för en hård gräns.
        const DAILY_DRAFT_LIMIT = 10;
        const rateLimitKey = `draft-rate:${accountId}:${new Date().toISOString().slice(0, 10)}`;
        const currentCount = parseInt((await env.SESSIONS.get(rateLimitKey)) ?? "0", 10);
        if (currentCount >= DAILY_DRAFT_LIMIT) {
          return json({ error: `Max ${DAILY_DRAFT_LIMIT} AI-utkast per dygn, prova igen imorgon.` }, 429);
        }

        const { topic, areaType } = await req.json<{ topic?: string; areaType?: string }>();
        try {
          const result = await draftLetter(env, { topic, areaType });
          await env.SESSIONS.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 60 * 60 * 24 });
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Okänt fel" }, 502);
        }
      }

      if (url.pathname === "/api/send" && req.method === "POST") {
        const input = await req.json<{
          letterHtml: string;
          subject?: string;
          mailCredentialId: string;
          areaNames: string[];
          excludeParties?: string[];
          excludeEmails?: string[];
          includeRoles?: string[];
          attachments?: AttachmentInput[];
        }>();
        const letterId = randomId();
        await env.DB.prepare("INSERT INTO letters (id, account_id, html_body, created_at) VALUES (?, ?, ?, ?)")
          .bind(letterId, accountId, input.letterHtml, Date.now())
          .run();

        let htmlBody = input.letterHtml;
        if (input.attachments && input.attachments.length > 0) {
          const { extractedHtml } = await processAttachments(env, letterId, input.attachments);
          htmlBody += extractedHtml;
          await env.DB.prepare("UPDATE letters SET html_body = ? WHERE id = ?").bind(htmlBody, letterId).run();
        }
        const result = await createAndEnqueueSendJob(env, accountId, {
          letterId,
          htmlBody,
          subject: input.subject,
          mailCredentialId: input.mailCredentialId,
          areaNames: input.areaNames,
          excludeParties: input.excludeParties,
          excludeEmails: input.excludeEmails,
          includeRoles: input.includeRoles,
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
            "SELECT id, email, email_verified, daily_send_cap, is_admin, disabled, created_at FROM accounts ORDER BY created_at DESC",
          ).all();
          return json(results);
        }

        const resetMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/reset-password$/);
        if (resetMatch && req.method === "POST") {
          await adminResetPassword(env, resetMatch[1]);
          return json({ ok: true });
        }

        const disableMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/toggle-disabled$/);
        if (disableMatch && req.method === "POST") {
          const { disabled } = await req.json<{ disabled: boolean }>();
          await setAccountDisabled(env, disableMatch[1], disabled);
          return json({ ok: true });
        }

        if (url.pathname === "/api/admin/civic-letter" && req.method === "POST") {
          const { subject, htmlBody, topicSourceUrl } = await req.json<{ subject: string; htmlBody: string; topicSourceUrl?: string }>();
          const draft = await createCivicLetterDraft(env, { subject, htmlBody, topicSourceUrl });
          await sendApprovalNotification(env, draft);
          return json({ ok: true, draftId: draft.id });
        }

        const civicGetMatch = url.pathname.match(/^\/api\/admin\/civic-letter\/([a-zA-Z0-9]+)$/);
        if (civicGetMatch && req.method === "GET") {
          const draft = await getCivicLetterDraft(env, civicGetMatch[1]);
          if (!draft) return json({ error: "Hittades inte" }, 404);
          return json(redactApproveToken(draft));
        }

        const civicStatusMatch = url.pathname.match(/^\/api\/admin\/civic-letter\/([a-zA-Z0-9]+)\/status$/);
        if (civicStatusMatch && req.method === "POST") {
          const { status } = await req.json<{ status: string }>();
          if (status !== "sending" && status !== "done") {
            return json({ error: "Ogiltig status — måste vara 'sending' eller 'done'" }, 400);
          }
          try {
            await setCivicLetterStatus(env, civicStatusMatch[1], status);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : "Fel" }, 400);
          }
          return json({ ok: true });
        }

        if (url.pathname === "/api/admin/civic-letter/next-approved" && req.method === "GET") {
          const draft = await getApprovedUnsentDraft(env);
          return json(draft ? redactApproveToken(draft) : null);
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

        if (url.pathname === "/api/admin/stats" && req.method === "GET") {
          return json(await getAdminStats(env));
        }

        if (url.pathname === "/api/admin/export" && req.method === "GET") {
          const section = (url.searchParams.get("section") ?? "all") as "accounts" | "feedback" | "stats" | "all";
          const format = (url.searchParams.get("format") ?? "json") as "csv" | "json";
          const { filename, content, contentType } = await exportAdminData(env, section, format);
          return new Response(content, {
            headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"` },
          });
        }

        return json({ error: "Not found" }, 404);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Okänt fel" }, 400);
    }
}
