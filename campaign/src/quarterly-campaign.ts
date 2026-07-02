import type { Env } from "./index";
import { callAnthropic, ANTHROPIC_SONNET } from "../../shared/anthropic";
import { sendResendMail, ResendQuotaError } from "../../shared/resend";

// Kvartalsbrevet: EN gång per kvartal researchas och författas ETT brev
// (utifrån kvartalets socialt relevanta bevakade ärenden) som skickas till
// SAMTLIGA politiker i databasen — alla nivåer, hela landet — och samtidigt
// till nyhetsbrevsprenumeranterna (newsletter-sender plockar upp brevet via
// public_letters source='quarterly').
//
// Skiljer sig från det dagliga kampanjflödet (letter-generator), som skickar
// personaliserade brev till ett litet urval per ärende. Kvartalsbrevet är ett
// gemensamt brev till alla, och dräneras via Resend
// (quarterly-drain) istället för Gmail — 17 000+ mottagare ryms inte i en
// Gmail-kvot.

// Markör som skiljer kvartalsutkast från dagliga utkast i civic_letter_drafts
// (tabellen har ingen source-kolumn; topic_source_url är fri text).
export const QUARTERLY_MARKER = "internal:quarterly";

const RESEARCH_ITEMS = 40;

interface CorpusItem { title: string; summary: string | null; url: string }

function currentQuarterStartMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1);
}

export async function runQuarterlyCampaign(env: Env): Promise<void> {
  const quarterStart = currentQuarterStartMs(new Date());

  // Idempotens: max ett kvartalsbrev per kvartal, oavsett omkörningar.
  const existing = await env.DB.prepare(
    "SELECT id FROM public_letters WHERE source = 'quarterly' AND published_at >= ? LIMIT 1",
  ).bind(quarterStart).first();
  if (existing) { console.log("quarterly: kvartalets brev finns redan"); return; }

  // Research-underlag: kvartalets bevakade ärenden som passerade den sociala
  // relevans-filtreringen (letter_queued=1 sätts av letter-generator).
  const { results: items } = await env.DB.prepare(
    "SELECT title, summary, url FROM monitored_items WHERE letter_queued = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT ?",
  ).bind(quarterStart - 92 * 24 * 3600 * 1000, RESEARCH_ITEMS).all<CorpusItem>();

  const corpus = items.map(i => `- ${i.title}: ${(i.summary ?? "").slice(0, 200)} (${i.url})`).join("\n")
    || "(inga bevakade ärenden detta kvartal — utgå från allmänt kända, aktuella svenska samhällsproblem)";

  const raw = await callAnthropic(env.ANTHROPIC_API_KEY, {
    model: ANTHROPIC_SONNET,
    maxTokens: 2000,
    prompt: `Du är ${env.SENDER_NAME}, kritisk och engagerad svensk medborgare. En gång per kvartal skriver du ETT gemensamt brev till samtliga förtroendevalda i Sverige — kommun, region, riksdag, regering och EU-parlament.

Underlag — kvartalets bevakade nyheter och riksdagsärenden:
${corpus}

Skriv kvartalsbrevet (500–700 ord) som:
1. Inleds "Till dig som förtroendevald," (brevet går till alla — ingen personlig hälsning)
2. Väljer de 2–3 viktigaste samhällsproblemen ur underlaget och beskriver dem konkret — vad som gått fel och hur systemet sviker vanliga människor
3. Citerar minst tre relevanta fakta från SCB, OECD, Riksrevisionen, WHO eller Transparency International (källa i parentes)
4. Håller de förtroendevalda kollektivt ansvariga — vad som gjorts och INTE gjorts
5. Kräver konkreta svar med specifika åtgärder och tidsramar
6. Avslutas med att du förväntar dig ett faktiskt svar
7. Undertecknas "${env.SENDER_NAME}"

Ton: saklig, direkt, krävande. Inga tomma artighetsfraser.
Svara med EXAKT detta format:
ÄMNE: <ämnesrad, max 80 tecken>
<tom rad>
<brevtexten>`,
  });

  const match = raw.match(/^ÄMNE:\s*(.+)\n+([\s\S]+)$/);
  if (!match) throw new Error("quarterly: kunde inte tolka ÄMNE/brödtext ur modellsvaret");
  const subject = match[1].trim().slice(0, 120);
  const body = match[2].trim();

  const draftId = crypto.randomUUID();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO civic_letter_drafts (id, subject, html_body, topic_source_url, status, approve_token, created_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)",
    ).bind(draftId, subject, body, QUARTERLY_MARKER, draftId.slice(0, 32), now),
    // Samma brev publiceras för nyhetsbrevet — newsletter-sender skickar allt
    // med source='quarterly' till bekräftade prenumeranter.
    env.DB.prepare(
      "INSERT INTO public_letters (id, source, account_id, subject, body, area_name, published_at) VALUES (?, 'quarterly', NULL, ?, ?, NULL, ?)",
    ).bind(crypto.randomUUID(), subject, body, now),
  ]);

  // Mottagare: SAMTLIGA politiker, alla nivåer, dedupliceriat på e-postadress
  // (samma person kan finnas i flera områden). En INSERT...SELECT istället för
  // 17 000 separata anrop.
  const res = await env.DB.prepare(`
    INSERT INTO campaign_recipients (id, draft_id, politician_id, politician_email, politician_name, area_name)
    SELECT lower(hex(randomblob(16))), ?, id, email, name, area_name
    FROM politicians
    WHERE verification_status IS NULL OR verification_status NOT IN ('dead', 'dead_via_send')
    GROUP BY email
  `).bind(draftId).run();

  console.log(`quarterly: brev "${subject}" skapat, ${res.meta.changes} mottagare köade`);
}

// Dränerar kvartalsbrevets mottagare via Resend — körs i varje cron-slot
// (4 ggr/dag). Gmail-vägen (letter-sender) rör aldrig kvartalsutkast: utan
// RESEND_API_KEY väntar kön orörd istället för att kvävas i Gmail-kvoten.
//
// Takten styrs i praktiken av Resend-planens dagskvot: free (100/dag) tar
// ~6 månader för hela landet — uppgradera till Pro (50 000/mån) under
// kvartalsmånaden så är kön dränerad på nån dag. 429 pausar snällt tills
// nästa slot, oavsett plan. Prenumeranterna påverkas inte: nyhetsbrevet
// dräneras alltid FÖRE den här kön i varje slot.
const DRAIN_PER_RUN = 300;

export async function runQuarterlyDrain(env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) return;

  const { results } = await env.DB.prepare(`
    SELECT cr.id, cr.politician_email, cld.subject, cld.html_body
    FROM campaign_recipients cr
    JOIN civic_letter_drafts cld ON cld.id = cr.draft_id
    WHERE cr.status = 'pending' AND cld.status = 'approved' AND cld.topic_source_url = ?
    ORDER BY cr.rowid ASC LIMIT ?
  `).bind(QUARTERLY_MARKER, DRAIN_PER_RUN).all<{ id: string; politician_email: string; subject: string; html_body: string }>();

  if (!results.length) return;

  let sent = 0, failed = 0;
  for (const rec of results) {
    const now = Date.now();
    try {
      await sendResendMail(env.RESEND_API_KEY, {
        to: rec.politician_email,
        from: `${env.SENDER_NAME} <kampanj@send.denied.se>`,
        replyTo: env.GMAIL_EMAIL, // svar ska nå en riktig, läst inkorg
        subject: rec.subject,
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${rec.html_body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
        text: rec.html_body,
      });
      await env.DB.prepare("UPDATE campaign_recipients SET status='sent', sent_at=? WHERE id=?").bind(now, rec.id).run();
      sent++;
    } catch (e) {
      // Kvot-/rate-fel (429): lämna som pending så nästa slot försöker igen.
      if (e instanceof ResendQuotaError) {
        console.warn(`quarterly-drain: pausar på kvot (${e.message.slice(0, 120)})`);
        break;
      }
      await env.DB.prepare("UPDATE campaign_recipients SET status='failed', error=? WHERE id=?").bind(String(e).slice(0, 200), rec.id).run();
      failed++;
    }
    // Resend rate-limitar på 2 anrop/sekund — pacea utskicken.
    await new Promise(r => setTimeout(r, 600));
  }
  console.log(`quarterly-drain: ${sent} skickade, ${failed} misslyckade`);
}
