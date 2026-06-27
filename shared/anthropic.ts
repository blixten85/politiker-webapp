// Delad Anthropic Messages-klient för campaign-Workern. Tidigare fanns tre
// nästan identiska kopior (letter-generator, issue-fixer, bounce-sweep) som
// drev isär i felhantering — en plats istället, så validering/retry-logik
// gäller alla anrop lika.

export const ANTHROPIC_HAIKU = "claude-haiku-4-5-20251001";
export const ANTHROPIC_SONNET = "claude-sonnet-4-6";

export async function callAnthropic(
  apiKey: string,
  opts: { model: string; maxTokens: number; prompt: string },
): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: opts.prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { content?: Array<{ text: string }> };
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("Anthropic: tomt svar");
  return text.trim();
}
