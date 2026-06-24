import type { Env } from "./db";

// AI-hjälp åt en INLOGGAD användare: researchar (riktig websökning via
// Anthropics web_search-verktyg) ett ämne och föreslår ett brevutkast.
// Användaren läser igenom, redigerar och skickar själv under sitt eget
// namn/mailkonto — inget skickas automatiskt eller anonymt. Skild från
// civic-outreach.ts (den pausade, ANONYMA kampanjen där AI:n författar
// och skickar utan en mänsklig avsändare bakom varje brev).

const MODEL = "claude-sonnet-4-6";

export interface DraftLetterResult {
  subject: string;
  htmlBody: string;
  sources: string[];
}

export async function draftLetter(
  env: Env,
  input: { topic?: string; areaType?: string },
): Promise<DraftLetterResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("AI-utkast är inte konfigurerat (ANTHROPIC_API_KEY saknas)");
  }

  const topicInstruction = input.topic?.trim()
    ? `Ämnet är: "${input.topic.trim()}".`
    : "Hitta själv ett aktuellt, konkret samhällsämne som är relevant just nu (sök efter färska nyheter) — välj något specifikt, inte ett brett ämne.";

  const recipientHint = input.areaType
    ? `Brevet ska kunna skickas till förtroendevalda av typen "${input.areaType}" (kommun/region/riksdag/regering/EU) — anpassa tonen därefter.`
    : "";

  const systemPrompt = `Du hjälper en svensk medborgare att skriva ett brev till sina folkvalda.
${topicInstruction} ${recipientHint}

Sök på webben efter relevant, aktuell information om ämnet innan du skriver.
Skriv ETT konkret, sakligt och respektfullt brev på svenska — inte vädjande, inte aggressivt.
Brevet ska vara skrivet i FÖRSTA PERSON som om avsändaren (en vanlig medborgare) skrev det själv.
Inkludera "[förnamn]" exakt en gång, där en personlig hälsning naturligt passar (det ersätts automatiskt per mottagare).

Svara ENDAST med ett JSON-objekt på exakt denna form, ingen övrig text:
{"subject": "kort ämnesrad", "htmlBody": "<p>brevtext med HTML-stycken</p>"}`;

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: "Skriv brevutkastet enligt instruktionerna." }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      }),
      // Websökning kan dra ut på tiden — ge upp ordentligt innan Workerns
      // egen wall-time-gräns träffas, så felet syns som ett tydligt 502
      // istället för att hela requesten dör tyst.
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("Anthropic-anropet tog för lång tid (websökning) — försök igen");
    }
    throw err;
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API-fel (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "server_tool_use"; name: string }
      | { type: "web_search_tool_result"; content: Array<{ url?: string }> }
    >;
  }>();

  const sources: string[] = [];
  for (const block of data.content) {
    if (block.type === "web_search_tool_result") {
      for (const item of block.content) {
        if (item.url) sources.push(item.url);
      }
    }
  }

  // Med web_search aktiverat kan modellen lägga in textblock FÖRE det
  // faktiska svaret (t.ex. en kort kommentar innan den söker) — gå igenom
  // alla textblock och använd det SISTA som faktiskt innehåller ett giltigt
  // {subject, htmlBody}-objekt, inte bara det första textblocket.
  const textBlocks = data.content.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
  if (textBlocks.length === 0) throw new Error("AI-svaret innehöll ingen text");

  let parsed: { subject?: string; htmlBody?: string } | null = null;
  for (const block of [...textBlocks].reverse()) {
    const jsonMatch = block.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;
    try {
      const candidate = JSON.parse(jsonMatch[0]) as { subject?: string; htmlBody?: string };
      if (candidate.subject && candidate.htmlBody) {
        parsed = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!parsed) throw new Error("Kunde inte tolka AI-svaret som ett giltigt brevutkast");

  return { subject: parsed.subject!, htmlBody: parsed.htmlBody!, sources: [...new Set(sources)] };
}
