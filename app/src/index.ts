import * as Sentry from "@sentry/cloudflare";
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
  deleteOwnAccount,
} from "./auth";
import { getAdminStats, exportAdminData, getTimeSeries, type Granularity } from "./admin-stats";
import { recordVisit } from "./visits";
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
import { listAreas, listParties, listRoles, searchPoliticiansInAreas, getRecipientsForAreas, deleteAccount } from "./db";
import { createAndEnqueueSendJob, getSendJobsForAccount } from "./send";
import { submitFeedback, reportClientError } from "./feedback";
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
import { subscribe as subscribeNewsletter, confirm as confirmNewsletter, unsubscribe as unsubscribeNewsletter } from "./newsletter";
import { getMicrosoftMailAuthorizeUrl } from "../../shared/graph-mail";
import { randomId } from "../../shared/crypto";
import { verifyTurnstile } from "./turnstile";
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

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    enableLogs: true,
  }),
  {
    async fetch(req: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
      const url = new URL(req.url);

    // Anonym besöksinspelning på faktiska sidladdningar (SPA-roten "/"). Övriga
    // paths är statiska assets (app.js, style.css, bilder) och räknas inte.
    // Best-effort via waitUntil — blockerar aldrig svaret.
    if (req.method === "GET" && url.pathname === "/") {
      execCtx.waitUntil(recordVisit(env, req));
    }

    const resp = await handleRequest(req, env, url);
    // Cloudflares "Speed Brain"-funktion injicerar en Speculation-Rules-header
    // som ber webbläsaren spekulativt förhämta länkar (t.ex. OAuth-startlänkar)
    // — förhämtningar serveras ur ett separat cache-lager som inte rensas av
    // vanlig purge, vilket orsakade inloggningsknapparna att verka "bara ladda
    // om sidan". Tar bort headern helt så ingen sida på den här domänen
    // förhämtas spekulativt.
    const headers = new Headers(resp.headers);
    headers.delete("Speculation-Rules");
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
  } satisfies ExportedHandler<Env>,
);

// --- Tabelldriven routing för de inloggade JSON-endpointsen ---------------
// De auth-känsliga vägarna (OAuth-redirects, cookie-sättning, civic-letter-
// token, signup/login/feedback) ligger KVAR som explicita handlers i
// handleRequest — de har var sin särlogik och inget att vinna på en tabell.
// Det här gäller bara de ~25 likformiga "parsa → anropa funktion → json"-
// vägarna som tidigare var en lång if-kedja. Ordning bevaras: första
// matchande (rx + metod) vinner, exakt som förr.

interface RouteCtx {
  env: Env;
  req: Request;
  url: URL;
  accountId: string;
  isAdmin: boolean;
}
type RouteHandler = (c: RouteCtx, m: RegExpMatchArray) => Promise<Response> | Response;
interface RouteDef {
  method: string;
  rx: RegExp;
  h: RouteHandler;
}

async function runRoutes(routes: RouteDef[], c: RouteCtx): Promise<Response | null> {
  for (const rt of routes) {
    if (c.req.method !== rt.method) continue;
    const m = c.url.pathname.match(rt.rx);
    if (m) return rt.h(c, m);
  }
  return null;
}

const AUTHED_ROUTES: RouteDef[] = [
  { method: "POST", rx: /^\/api\/totp\/setup$/, h: async (c) => json(await startTotpSetup(c.env, c.accountId)) },
  { method: "POST", rx: /^\/api\/totp\/confirm$/, h: async (c) => {
      const { code } = await c.req.json<{ code: string }>();
      await confirmTotpSetup(c.env, c.accountId, code);
      return json({ ok: true });
    } },
  { method: "POST", rx: /^\/api\/totp\/disable$/, h: async (c) => {
      await disableTotp(c.env, c.accountId);
      return json({ ok: true });
    } },
  { method: "POST", rx: /^\/api\/set-password$/, h: async (c) => {
      const { newPassword } = await c.req.json<{ newPassword: string }>();
      await setPassword(c.env, c.accountId, newPassword);
      return json({ ok: true });
    } },
  { method: "POST", rx: /^\/api\/delete-account$/, h: async (c) => {
      const { password, totpCode } = await c.req.json<{ password?: string; totpCode?: string }>();
      await deleteOwnAccount(c.env, c.accountId, password, totpCode);
      // Avsluta den aktiva sessionen och nolla kakan — kontot finns inte längre.
      const token = getCookie(c.req, "session");
      if (token) await c.env.SESSIONS.delete(`session:${token}`);
      const resp = json({ ok: true });
      resp.headers.set("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
      return resp;
    } },
  { method: "GET", rx: /^\/api\/oauth-identities$/, h: async (c) => json(await getOAuthIdentities(c.env, c.accountId)) },
  { method: "DELETE", rx: /^\/api\/oauth-identities\/([a-z]+)$/, h: async (c, m) => {
      await unlinkOAuthIdentity(c.env, c.accountId, m[1]);
      return json({ ok: true });
    } },
  { method: "GET", rx: /^\/api\/api-keys$/, h: async (c) => json(await listApiKeys(c.env, c.accountId)) },
  { method: "POST", rx: /^\/api\/api-keys$/, h: async (c) => {
      const { name } = await c.req.json<{ name: string }>();
      return json(await createApiKey(c.env, c.accountId, name));
    } },
  { method: "DELETE", rx: /^\/api\/api-keys\/([^/]+)$/, h: async (c, m) => {
      await revokeApiKey(c.env, c.accountId, m[1]);
      return json({ ok: true });
    } },
  { method: "GET", rx: /^\/api\/areas$/, h: async (c) => json(await listAreas(c.env.DB)) },
  { method: "GET", rx: /^\/api\/parties$/, h: async (c) => json(await listParties(c.env.DB)) },
  { method: "GET", rx: /^\/api\/roles$/, h: async (c) => json(await listRoles(c.env.DB)) },
  { method: "GET", rx: /^\/api\/politicians\/search$/, h: async (c) => {
      const areaNames = c.url.searchParams.getAll("areaName");
      const q = c.url.searchParams.get("q") ?? "";
      if (q.length < 2) return json([]);
      // areaNames får vara tomt = global sökning bland alla politiker.
      return json(await searchPoliticiansInAreas(c.env.DB, areaNames, q));
    } },
  { method: "GET", rx: /^\/api\/mail-credentials$/, h: async (c) => json(await listMailCredentials(c.env, c.accountId)) },
  { method: "GET", rx: /^\/api\/provider-ceilings$/, h: async (c) => {
      const providers = [...Object.keys(PROVIDER_PRESETS), "microsoft_graph"];
      const result: Record<string, { providerDailyLimit: number | null; ceiling: number | null }> = {};
      for (const p of providers) {
        result[p] = {
          providerDailyLimit: p === "microsoft_graph" ? MICROSOFT_GRAPH_DAILY_LIMIT : PROVIDER_PRESETS[p].providerDailyLimit,
          ceiling: getCeiling(p),
        };
      }
      return json(result);
    } },
  { method: "POST", rx: /^\/api\/mail-credentials$/, h: async (c) => {
      const input = await c.req.json<Parameters<typeof addMailCredential>[2]>();
      return json(await addMailCredential(c.env, c.accountId, input));
    } },
  // cap-pct före den bredare :id-DELETE — mer specifik väg först.
  { method: "POST", rx: /^\/api\/mail-credentials\/([^/]+)\/cap-pct$/, h: async (c, m) => {
      const { userCapPct } = await c.req.json<{ userCapPct: number }>();
      return json(await updateMailCredentialCapPct(c.env, c.accountId, m[1], userCapPct));
    } },
  { method: "DELETE", rx: /^\/api\/mail-credentials\/([^/]+)$/, h: async (c, m) => {
      await deleteMailCredential(c.env, c.accountId, m[1]);
      return json({ ok: true });
    } },
  { method: "POST", rx: /^\/api\/draft-letter$/, h: async (c) => {
      // Litet dygnstak — anropet kostar pengar (LLM + websökning) per
      // gång, oberoende av om mottagarlistan/utskicket annars är fritt.
      // OBS: best-effort, inte en hård spärr — KV är eventually consistent
      // och count+put är inte atomiskt, så några samtidiga requests kan i
      // teorin slinka förbi gränsen. Acceptabelt för ett kostnadsskydd i
      // den här skalan; en Durable Object skulle krävas för en hård gräns.
      const DAILY_DRAFT_LIMIT = 10;
      const rateLimitKey = `draft-rate:${c.accountId}:${new Date().toISOString().slice(0, 10)}`;
      const currentCount = parseInt((await c.env.SESSIONS.get(rateLimitKey)) ?? "0", 10);
      if (currentCount >= DAILY_DRAFT_LIMIT) {
        return json({ error: `Max ${DAILY_DRAFT_LIMIT} AI-utkast per dygn, prova igen imorgon.` }, 429);
      }

      const { topic, areaType } = await c.req.json<{ topic?: string; areaType?: string }>();
      try {
        const result = await draftLetter(c.env, { topic, areaType });
        await c.env.SESSIONS.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 60 * 60 * 24 });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "Okänt fel" }, 502);
      }
    } },
  { method: "POST", rx: /^\/api\/recipients\/count$/, h: async (c) => {
      // Exakt (deduperat) mottagarantal för förhandsvisningen — samma filter
      // som /api/send. Rollfiltret är globalt/kanoniskt och kan inte längre
      // beräknas roll×område på klienten, så antalet räknas här.
      const input = await c.req
        .json<{
          areaNames?: string[];
          excludeParties?: string[];
          excludeEmails?: string[];
          includeRoles?: string[];
          includeEmails?: string[];
        }>()
        .catch(() => ({}) as Record<string, never>);
      const recipients = await getRecipientsForAreas(
        c.env.DB,
        input.areaNames ?? [],
        input.excludeParties ?? [],
        input.excludeEmails ?? [],
        input.includeRoles ?? [],
        input.includeEmails ?? [],
      );
      return json({ count: recipients.length });
    } },
  { method: "POST", rx: /^\/api\/send$/, h: async (c) => {
      const input = await c.req.json<{
        letterHtml: string;
        subject?: string;
        mailCredentialId: string;
        areaNames: string[];
        excludeParties?: string[];
        excludeEmails?: string[];
        includeRoles?: string[];
        includeEmails?: string[];
        attachments?: AttachmentInput[];
      }>();
      const letterId = randomId();
      await c.env.DB.prepare("INSERT INTO letters (id, account_id, html_body, created_at) VALUES (?, ?, ?, ?)")
        .bind(letterId, c.accountId, input.letterHtml, Date.now())
        .run();

      let htmlBody = input.letterHtml;
      if (input.attachments && input.attachments.length > 0) {
        const { extractedHtml } = await processAttachments(c.env, letterId, input.attachments);
        htmlBody += extractedHtml;
        await c.env.DB.prepare("UPDATE letters SET html_body = ? WHERE id = ?").bind(htmlBody, letterId).run();
      }
      const result = await createAndEnqueueSendJob(c.env, c.accountId, {
        letterId,
        subject: input.subject,
        mailCredentialId: input.mailCredentialId,
        areaNames: input.areaNames,
        excludeParties: input.excludeParties,
        excludeEmails: input.excludeEmails,
        includeRoles: input.includeRoles,
        includeEmails: input.includeEmails,
      });
      return json(result);
    } },
  { method: "GET", rx: /^\/api\/send-jobs$/, h: async (c) => json(await getSendJobsForAccount(c.env, c.accountId)) },
  { method: "GET", rx: /^\/api\/public\/letters$/, h: async (c) => {
      const page = Math.max(0, parseInt(c.url.searchParams.get("page") ?? "0", 10));
      const { results } = await c.env.DB.prepare(
        "SELECT id, source, subject, substr(body, 1, 400) AS excerpt, area_name, published_at FROM public_letters ORDER BY published_at DESC LIMIT 20 OFFSET ?"
      ).bind(page * 20).all();
      return json({ letters: results });
    } },
  { method: "GET", rx: /^\/api\/public\/letters\/(.+)$/, h: async (c, m) => {
      const row = await c.env.DB.prepare(
        "SELECT subject, body FROM public_letters WHERE id = ?"
      ).bind(m[1]).first<{ subject: string; body: string }>();
      if (!row) return json({ error: "Hittades inte" }, 404);
      return json(row);
    } },
  { method: "POST", rx: /^\/api\/letters\/([^/]+)\/publish$/, h: async (c, m) => {
      const letterId = m[1];
      const letter = await c.env.DB.prepare(
        "SELECT l.id, l.html_body FROM letters l JOIN send_jobs sj ON sj.letter_id = l.id WHERE l.id = ? AND sj.account_id = ? LIMIT 1"
      ).bind(letterId, c.accountId).first<{ id: string; html_body: string }>();
      if (!letter) return json({ error: "Brevet hittades inte" }, 404);
      const already = await c.env.DB.prepare(
        "SELECT id FROM public_letters WHERE source = 'user' AND account_id = ?"
      ).bind(c.accountId).first();
      if (already) return json({ error: "Du har redan publicerat ett brev" }, 409);
      const firstLine = letter.html_body.replace(/[<>]/g, "").split(/\n/).find(l => l.trim().length > 20) ?? "Medborgarbrev";
      const subject = firstLine.trim().slice(0, 100);
      const pubId = randomId();
      await c.env.DB.prepare(
        "INSERT INTO public_letters (id, source, account_id, subject, body, area_name, published_at) VALUES (?, 'user', ?, ?, ?, NULL, ?)"
      ).bind(pubId, c.accountId, subject, letter.html_body.replace(/[<>]/g, ""), null, Date.now()).run();
      return json({ ok: true, id: pubId });
    } },
];

// Admin-endpoints: kräver is_admin = 1 (grindas i handleRequest innan dessa
// körs). Läs-orienterade översikter — övriga konton ser ALDRIG varandras data.
// next-approved före :id-GET så den inte slukas av param-matchningen.
const ADMIN_ROUTES: RouteDef[] = [
  { method: "GET", rx: /^\/api\/admin\/accounts$/, h: async (c) => {
      const { results } = await c.env.DB.prepare(
        "SELECT id, email, email_verified, daily_send_cap, is_admin, disabled, created_at FROM accounts ORDER BY created_at DESC",
      ).all();
      return json(results);
    } },
  { method: "POST", rx: /^\/api\/admin\/accounts\/([^/]+)\/reset-password$/, h: async (c, m) => {
      await adminResetPassword(c.env, m[1]);
      return json({ ok: true });
    } },
  { method: "POST", rx: /^\/api\/admin\/accounts\/([^/]+)\/toggle-disabled$/, h: async (c, m) => {
      const { disabled } = await c.req.json<{ disabled: boolean }>();
      await setAccountDisabled(c.env, m[1], disabled);
      return json({ ok: true });
    } },
  { method: "DELETE", rx: /^\/api\/admin\/accounts\/([^/]+)$/, h: async (c, m) => {
      // Hindra admin från att av misstag radera sitt eget inloggade konto här.
      if (m[1] === c.accountId) return json({ error: "Du kan inte radera ditt eget konto från adminvyn" }, 400);
      await deleteAccount(c.env, m[1]);
      return json({ ok: true });
    } },
  { method: "POST", rx: /^\/api\/admin\/civic-letter$/, h: async (c) => {
      const { subject, htmlBody, topicSourceUrl } = await c.req.json<{ subject: string; htmlBody: string; topicSourceUrl?: string }>();
      const draft = await createCivicLetterDraft(c.env, { subject, htmlBody, topicSourceUrl });
      await sendApprovalNotification(c.env, draft);
      return json({ ok: true, draftId: draft.id });
    } },
  { method: "GET", rx: /^\/api\/admin\/civic-letter\/next-approved$/, h: async (c) => {
      const draft = await getApprovedUnsentDraft(c.env);
      return json(draft ? redactApproveToken(draft) : null);
    } },
  { method: "GET", rx: /^\/api\/admin\/civic-letter\/([a-zA-Z0-9]+)$/, h: async (c, m) => {
      const draft = await getCivicLetterDraft(c.env, m[1]);
      if (!draft) return json({ error: "Hittades inte" }, 404);
      return json(redactApproveToken(draft));
    } },
  { method: "POST", rx: /^\/api\/admin\/civic-letter\/([a-zA-Z0-9]+)\/status$/, h: async (c, m) => {
      const { status } = await c.req.json<{ status: string }>();
      if (status !== "sending" && status !== "done") {
        return json({ error: "Ogiltig status — måste vara 'sending' eller 'done'" }, 400);
      }
      try {
        await setCivicLetterStatus(c.env, m[1], status);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "Fel" }, 400);
      }
      return json({ ok: true });
    } },
  { method: "GET", rx: /^\/api\/admin\/feedback$/, h: async (c) => {
      const { results } = await c.env.DB.prepare("SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100").all();
      return json(results);
    } },
  { method: "GET", rx: /^\/api\/admin\/send-jobs$/, h: async (c) => {
      const { results } = await c.env.DB.prepare(
        `SELECT sj.*, a.email FROM send_jobs sj JOIN accounts a ON a.id = sj.account_id ORDER BY sj.created_at DESC LIMIT 100`,
      ).all();
      return json(results);
    } },
  { method: "GET", rx: /^\/api\/admin\/stats$/, h: async (c) => json(await getAdminStats(c.env)) },
  { method: "GET", rx: /^\/api\/admin\/timeseries$/, h: async (c) => {
      const g = (c.url.searchParams.get("granularity") ?? "month") as Granularity;
      return json({ series: await getTimeSeries(c.env, g) });
    } },
  { method: "GET", rx: /^\/api\/admin\/export$/, h: async (c) => {
      const section = (c.url.searchParams.get("section") ?? "all") as "accounts" | "feedback" | "stats" | "politicians" | "all";
      const format = (c.url.searchParams.get("format") ?? "json") as "csv" | "json";
      const { filename, content, contentType } = await exportAdminData(c.env, section, format);
      return new Response(content, {
        headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"` },
      });
    } },
];

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
          const sessionToken = getCookie(req, "session");
          const account = await getAccountFromSession(env, sessionToken);
          if (!account || (account.id as string) !== linkAccountId) {
            return json({ error: "State tillhör en annan session — försök igen" }, 400);
          }
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
        const { email, password, turnstileToken } = await req.json<{ email: string; password: string; turnstileToken?: string }>();
        if (!(await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, req.headers.get("CF-Connecting-IP")))) {
          return json({ error: "Bekräfta att du inte är en robot och försök igen." }, 400);
        }
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
        const { email, turnstileToken } = await req.json<{ email: string; turnstileToken?: string }>();
        if (!(await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, req.headers.get("CF-Connecting-IP")))) {
          return json({ error: "Bekräfta att du inte är en robot och försök igen." }, 400);
        }
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

      // Nyhetsbrev: anmälan (Turnstile-skyddad, dubbel opt-in) samt
      // bekräftelse-/avregistreringslänkar från mailen. Kräver INTE
      // inloggning — prenumeranter behöver inget konto.
      if (url.pathname === "/api/newsletter/subscribe" && req.method === "POST") {
        const { email, turnstileToken } = await req.json<{ email: string; turnstileToken?: string }>();
        if (!(await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, req.headers.get("CF-Connecting-IP")))) {
          return json({ error: "Bekräfta att du inte är en robot och försök igen." }, 400);
        }
        await subscribeNewsletter(env, email);
        return json({ ok: true }); // alltid ok, avslöjar inte om adressen redan prenumererar
      }

      if (url.pathname === "/api/newsletter/confirm" && req.method === "GET") {
        return confirmNewsletter(env, url.searchParams.get("id"), url.searchParams.get("token"));
      }

      if (url.pathname === "/api/newsletter/unsubscribe" && req.method === "GET") {
        return unsubscribeNewsletter(env, url.searchParams.get("id"), url.searchParams.get("token"));
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

      // Automatisk klient-felrapportering (oväntade JS-undantag). Kräver INTE
      // inloggning. Svaret blockeras aldrig av GitHub-anropet — körs i
      // bakgrunden via waitUntil; klienten bryr sig inte om resultatet.
      if (url.pathname === "/api/client-error" && req.method === "POST") {
        const { message, stack, url: pageUrl } = await req.json<{ message?: string; stack?: string; url?: string }>();
        if (message) await reportClientError(env, { message, stack, url: pageUrl });
        return json({ ok: true });
      }

      // Allt nedanför kräver inloggning
      if (!account) return json({ error: "Inte inloggad" }, 401);
      const ctx: RouteCtx = { env, req, url, accountId: account.id as string, isAdmin: !!account.is_admin };

      const authedResp = await runRoutes(AUTHED_ROUTES, ctx);
      if (authedResp) return authedResp;

      // Admin-grind: alla /api/admin/* kräver is_admin = 1.
      if (url.pathname.startsWith("/api/admin/")) {
        if (!ctx.isAdmin) return json({ error: "Kräver admin-behörighet" }, 403);
        const adminResp = await runRoutes(ADMIN_ROUTES, ctx);
        return adminResp ?? json({ error: "Not found" }, 404);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Okänt fel" }, 400);
    }
}
