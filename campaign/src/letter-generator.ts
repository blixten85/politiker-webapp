import type { Env } from "./index";

const MAX_ITEMS    = 5;
const MAX_MAIN     = 10;
const MAX_KOMMUN   = 5;

interface MonitoredItem {
  id: string; source: string; item_type: string; title: string;
  url: string; area_name: string | null; area_type: string; summary: string | null;
}
interface Politician {
  id: string; name: string; email: string; area_name: string; party: string | null; role: string | null;
}

async function callClaude(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { content?: Array<{ text: string }> };
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("Anthropic: tomt svar");
  return text.trim();
}

async function isRelevant(item: MonitoredItem, apiKey: string): Promise<boolean> {
  const answer = await callClaude(apiKey, `Avgör om följande nyhet eller riksdagsärende berör MINST ETT av dessa ämnen:
- Sociala rättigheter och välfärd: sjukvård, abort/reproduktiva rättigheter, äldreomsorg, psykiatri, funktionsnedsättning, barnfamiljer, hemlöshet
- Bostad och stadsplanering: bostadsbrist, hyresrätt, segregation
- Ekonomi och arbetsmarknad: skatter, pension, lön, sysselsättning, ojämlikhet, fattigdom
- Utbildning: förskola, grundskola, gymnasiet, högskoleutbildning, studiestöd
- Rättsväsen: brottslighet, diskriminering, medborgerliga rättigheter
- Bistånd och utrikespolitik: biståndsmedel, korruption, vapenexport

Hoppa BARA över: natur/miljö/strandskydd utan social koppling, tekniska detaljfrågor, "Motionen utgår".
Svara ENBART "ja" eller "nej".

Titel: ${item.title}
Sammanfattning: ${(item.summary ?? "").slice(0, 400)}`, 5);
  return answer.toLowerCase().startsWith("ja");
}

async function generateLetter(item: MonitoredItem, pol: Politician, senderName: string, apiKey: string): Promise<string> {
  const polDesc = [pol.name, pol.role, pol.party ? `(${pol.party})` : null, pol.area_name].filter(Boolean).join(", ");
  const typeLabel: Record<string, string> = { motion: "motion", proposition: "proposition", betankande: "betänkande", news: "nyhet" };
  return callClaude(apiKey, `Du är ${senderName}, kritisk och engagerad svensk medborgare.

Mottagare: ${polDesc}
Ärende (${typeLabel[item.item_type] ?? "ärende"}): ${item.title}
Sammanfattning: ${(item.summary ?? "").slice(0, 600)}
Källa: ${item.url}

Skriv ett medborgarbrev (240–320 ord) som:
1. Hälsar politikern vid namn
2. Beskriver problemet konkret — vad som gått fel och hur systemet sviker vanliga människor
3. Citerar ett relevant faktum från SCB, OECD, Riksrevisionen, WHO eller Transparency International (källa i parentes)
4. Håller politikern ansvarig för vad de/deras parti gjort eller INTE gjort
5. Kräver konkret svar med specifik åtgärd och tidsram
6. Avslutas med att du förväntar dig ett faktiskt svar
7. Undertecknas "${senderName}"

Ton: saklig, direkt, krävande. Inga tomma artighetsfraser.
Skriv ENBART brevtexten.`, 800);
}

function randomId(): string {
  return crypto.randomUUID();
}

function makeSubject(item: MonitoredItem): string {
  const prefix: Record<string, string> = { motion: "Motion", proposition: "Proposition", betankande: "Betänkande", news: "Nyhet" };
  return `${prefix[item.item_type] ?? "Ärende"}: ${item.title.slice(0, 80)}`;
}

export async function runLetterGenerator(env: Env): Promise<void> {
  const { results: items } = await env.DB.prepare(
    "SELECT id,source,item_type,title,url,area_name,area_type,summary FROM monitored_items WHERE letter_queued=0 ORDER BY created_at ASC LIMIT ?"
  ).bind(MAX_ITEMS).all<MonitoredItem>();

  if (!items.length) { console.log("letter-gen: inga nya ärenden"); return; }

  let totalDrafts = 0;

  for (const item of items) {
    if (!await isRelevant(item, env.ANTHROPIC_API_KEY)) {
      await env.DB.prepare("UPDATE monitored_items SET letter_queued=2 WHERE id=?").bind(item.id).run();
      continue;
    }

    // Hämta riksdag/region-politiker
    let politicians: Politician[];
    if (item.area_type === "riksdag") {
      const { results } = await env.DB.prepare(
        "SELECT id,name,email,area_name,party,role FROM politicians WHERE area_type='riksdag' AND verification_status!='dead_via_send' ORDER BY RANDOM() LIMIT ?"
      ).bind(MAX_MAIN).all<Politician>();
      politicians = results;
    } else {
      const kw = (item.area_name ?? "").replace(/läns? landsting|landsting|Region /g, "").trim();
      const { results } = await env.DB.prepare(
        "SELECT id,name,email,area_name,party,role FROM politicians WHERE area_type='region' AND (area_name LIKE ? OR area_name LIKE ?) AND verification_status!='dead_via_send' ORDER BY RANDOM() LIMIT ?"
      ).bind(`%${kw}%`, `%${item.area_name ?? ""}%`, MAX_MAIN).all<Politician>();
      politicians = results;
    }

    // Lägg till kommunpolitiker
    const existingIds = politicians.map(p => p.id);
    const notIn = existingIds.length ? `AND id NOT IN (${existingIds.map(() => "?").join(",")})` : "";
    const { results: kommun } = await env.DB.prepare(
      `SELECT id,name,email,area_name,party,role FROM politicians WHERE area_type='kommun' AND verification_status!='dead_via_send' ${notIn} ORDER BY RANDOM() LIMIT ?`
    ).bind(...existingIds, MAX_KOMMUN).all<Politician>();
    politicians = [...politicians, ...kommun];

    if (!politicians.length) {
      await env.DB.prepare("UPDATE monitored_items SET letter_queued=1 WHERE id=?").bind(item.id).run();
      continue;
    }

    let firstPublished = false;
    let itemDrafts = 0;
    const subject = makeSubject(item);
    const now = Date.now();

    for (const pol of politicians) {
      try {
        const body = await generateLetter(item, pol, env.SENDER_NAME, env.ANTHROPIC_API_KEY);
        const draftId = randomId();
        const recId   = randomId();

        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO civic_letter_drafts (id,subject,html_body,topic_source_url,status,approve_token,created_at) VALUES (?,?,?,?,'approved',?,?)")
            .bind(draftId, subject, body, item.url, draftId.slice(0, 32), now),
          env.DB.prepare("INSERT OR IGNORE INTO campaign_recipients (id,draft_id,politician_id,politician_email,politician_name,area_name) VALUES (?,?,?,?,?,?)")
            .bind(recId, draftId, pol.id, pol.email, pol.name, pol.area_name),
        ]);

        if (!firstPublished) {
          await env.DB.prepare("INSERT OR IGNORE INTO public_letters (id,source,account_id,subject,body,area_name,published_at) VALUES (?,?,NULL,?,?,?,?)")
            .bind(randomId(), "campaign", subject, body, item.area_name, now).run();
          firstPublished = true;
        }
        totalDrafts++;
        itemDrafts++;
      } catch (e) {
        console.error(`letter-gen: fel för ${pol.name}:`, e);
      }
    }

    if (itemDrafts > 0) {
      await env.DB.prepare("UPDATE monitored_items SET letter_queued=1 WHERE id=?").bind(item.id).run();
    }
  }

  console.log(`letter-gen: ${totalDrafts} brevutkast skapade`);
}
