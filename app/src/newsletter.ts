// Nyhetsbrev: anmälan med dubbel opt-in, bekräftelse och avregistrering.
// Prenumeranter får kvartalsbrevet — samma AI-researchade brev som varje
// kvartal skickas till samtliga politiker i landet. Själva utskicket sker i
// campaign/src/newsletter-sender.ts, den här modulen hanterar bara listan.

import { randomId } from "../../shared/crypto";
import { sendResendMail } from "../../shared/resend";
import { sendSystemMail } from "./auth";
import type { Env } from "./db";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BASE_URL = "https://politiker.denied.se";

interface Subscriber {
  id: string;
  email: string;
  token: string;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
}

// Svaret är alltid samma oavsett om adressen redan finns — anmälningsflödet
// ska inte gå att använda för att lista vilka adresser som prenumererar.
export async function subscribe(env: Env, email: string): Promise<void> {
  email = email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error("Ogiltig e-postadress");

  const existing = await env.DB.prepare(
    "SELECT id, email, token, confirmed_at, unsubscribed_at FROM newsletter_subscribers WHERE email = ?",
  ).bind(email).first<Subscriber>();

  const now = Date.now();
  let id: string;
  let token: string;

  if (existing) {
    if (existing.confirmed_at && !existing.unsubscribed_at) return; // redan aktiv — skicka inget
    // Obekräftad eller tidigare avregistrerad: nytt token, ny bekräftelse.
    id = existing.id;
    token = randomId();
    await env.DB.prepare(
      "UPDATE newsletter_subscribers SET token = ?, unsubscribed_at = NULL, confirmed_at = NULL, created_at = ? WHERE id = ?",
    ).bind(token, now, id).run();
  } else {
    id = randomId();
    token = randomId();
    await env.DB.prepare(
      "INSERT INTO newsletter_subscribers (id, email, token, created_at) VALUES (?, ?, ?, ?)",
    ).bind(id, email, token, now).run();
  }

  const confirmUrl = `${BASE_URL}/api/newsletter/confirm?id=${id}&token=${token}`;
  const subject = "Bekräfta din prenumeration — Politiker-kontakt";
  const html = `<p>Hej!</p>
<p>Du (eller någon annan) har anmält den här adressen till Politiker-kontakts
nyhetsbrev. Som prenumerant får du varje kvartal samma medborgarbrev som då
skickas till samtliga politiker i landet — research, källor och krav —
direkt i inkorgen.</p>
<p><a href="${confirmUrl}">Bekräfta prenumerationen</a></p>
<p>Om du inte anmält dig kan du ignorera det här mailet — utan bekräftelse
skickas inga nyhetsbrev.</p>`;

  // Föredra Resend (egen avsändardomän med DKIM), falla tillbaka på
  // system-SMTP (iCloud) om nyckeln saknas eller sändningen misslyckas —
  // anmälan ska aldrig stanna på mailvägen.
  if (env.RESEND_API_KEY) {
    try {
      await sendResendMail(env.RESEND_API_KEY, {
        to: email,
        from: "Politiker-kontakt <nyhetsbrev@send.denied.se>",
        subject,
        html,
        text: html.replace(/<[^>]+>/g, ""),
      });
      return;
    } catch (e) {
      console.warn(`newsletter: Resend misslyckades (${String(e).slice(0, 120)}), faller tillbaka på system-SMTP`);
    }
  }
  await sendSystemMail(env, email, subject, html);
}

function htmlPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a2e}
a{color:#2563eb}</style></head>
<body><h1>${title}</h1>${body}<p><a href="/">Till Politiker-kontakt</a></p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function findByIdAndToken(env: Env, id: string | null, token: string | null): Promise<Subscriber | null> {
  if (!id || !token) return null;
  const sub = await env.DB.prepare(
    "SELECT id, email, token, confirmed_at, unsubscribed_at FROM newsletter_subscribers WHERE id = ?",
  ).bind(id).first<Subscriber>();
  if (!sub || sub.token !== token) return null;
  return sub;
}

export async function confirm(env: Env, id: string | null, token: string | null): Promise<Response> {
  const sub = await findByIdAndToken(env, id, token);
  if (!sub) return htmlPage("Ogiltig länk", "<p>Länken är felaktig eller har ersatts av en nyare bekräftelselänk.</p>");
  if (!sub.confirmed_at) {
    await env.DB.prepare(
      "UPDATE newsletter_subscribers SET confirmed_at = ?, unsubscribed_at = NULL WHERE id = ?",
    ).bind(Date.now(), sub.id).run();
  }
  return htmlPage(
    "Prenumerationen är bekräftad",
    "<p>Tack! Du får nu, en gång per kvartal, samma medborgarbrev som skickas till samtliga politiker i landet. Varje utskick innehåller en avregistreringslänk.</p>",
  );
}

export async function unsubscribe(env: Env, id: string | null, token: string | null): Promise<Response> {
  const sub = await findByIdAndToken(env, id, token);
  if (!sub) return htmlPage("Ogiltig länk", "<p>Länken är felaktig. Kontakta oss via kontaktformuläret om du vill bli borttagen manuellt.</p>");
  if (!sub.unsubscribed_at) {
    await env.DB.prepare(
      "UPDATE newsletter_subscribers SET unsubscribed_at = ? WHERE id = ?",
    ).bind(Date.now(), sub.id).run();
  }
  return htmlPage("Avregistrerad", "<p>Du får inga fler nyhetsbrev. Du kan anmäla dig igen när som helst på startsidan.</p>");
}
