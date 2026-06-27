import type { Env } from "./index";

const MAX_PER_RUN   = 3;
const AUTOFIX_LABEL = "autofix-attempted";

// Mappar deplojat filnamn → källfil i repot
const FILE_MAP: Record<string, string> = {
  "app.js":    "app/public/app.js",
  "i18n.js":   "app/public/i18n.js",
  "style.css": "app/public/style.css",
  "index.ts":  "app/src/index.ts",
};

interface GithubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

async function ghApi(token: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "politiker-webapp-campaign",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await resp.json() as { content: Array<{ text: string }> };
  return data.content[0].text.trim();
}

function parseStackTrace(body: string): { file: string; line: number } | null {
  const m = body.match(/(\w+\.(?:js|ts|css)):(\d+)/);
  if (!m) return null;
  return { file: m[1], line: parseInt(m[2]) };
}

function parseErrorMessage(body: string): string {
  const m = body.match(/\[Auto-rapport\] ([^\n]+)/);
  return m?.[1] ?? body.slice(0, 200);
}

export async function runIssueFixer(env: Env): Promise<void> {
  const repo = env.GITHUB_REPO;
  const issues = await ghApi(env.GITHUB_FEEDBACK_TOKEN,
    `/repos/${repo}/issues?labels=user-reported&state=open&per_page=20`
  ) as GithubIssue[];

  const toFix = issues.filter(i =>
    !i.labels.some(l => l.name === AUTOFIX_LABEL)
  ).slice(0, MAX_PER_RUN);

  if (!toFix.length) { console.log("issue-fixer: inga nya issues att åtgärda"); return; }

  // Hämta HEAD-SHA för main
  const mainRef = await ghApi(env.GITHUB_FEEDBACK_TOKEN, `/repos/${repo}/git/ref/heads/main`) as { object: { sha: string } };
  const mainSha = mainRef.object.sha;

  for (const issue of toFix) {
    const errorMsg = parseErrorMessage(issue.body ?? "");
    const stack    = parseStackTrace(issue.body ?? "");
    const sourcePath = stack ? FILE_MAP[stack.file] : null;

    // Markera som under bearbetning
    await ghApi(env.GITHUB_FEEDBACK_TOKEN, `/repos/${repo}/issues/${issue.number}/labels`, "POST",
      { labels: [AUTOFIX_LABEL] }
    );

    if (!sourcePath) {
      console.log(`issue-fixer: #${issue.number} — kan inte mappa stack-trace, hoppar över`);
      continue;
    }

    try {
      // Hämta källfil från GitHub
      const fileData = await ghApi(env.GITHUB_FEEDBACK_TOKEN,
        `/repos/${repo}/contents/${sourcePath}?ref=main`
      ) as { content: string; sha: string };

      const content = atob(fileData.content.replace(/\n/g, ""));
      const lines   = content.split("\n");
      const lineNum = stack!.line;
      const context = lines.slice(Math.max(0, lineNum - 30), lineNum + 30).join("\n");

      // Be Claude generera fix
      const fixPrompt = `Du är en kodfix-agent för politiker.denied.se.

Fel rapporterat i produktion (issue #${issue.number}):
Felmeddelande: ${errorMsg}
Fil: ${sourcePath}, rad ${lineNum}

Kod runt felet (rad ${Math.max(1, lineNum - 30)}–${lineNum + 30}):
\`\`\`
${context}
\`\`\`

Fullständigt issue-innehåll:
${(issue.body ?? "").slice(0, 1000)}

Returnera ENBART den fullständiga fixade filen (hela innehållet, inte bara ändringen).
Om du inte kan göra en säker fix, svara exakt: INGEN FIX`;

      const fixedContent = await callClaude(env.ANTHROPIC_API_KEY, fixPrompt);

      if (fixedContent.startsWith("INGEN FIX")) {
        console.log(`issue-fixer: #${issue.number} — Claude kunde inte hitta fix`);
        continue;
      }

      // Skapa branch
      const branch = `claude/autofix-${issue.number}`;
      await ghApi(env.GITHUB_FEEDBACK_TOKEN, `/repos/${repo}/git/refs`, "POST", {
        ref: `refs/heads/${branch}`, sha: mainSha,
      });

      // Commita fix
      await ghApi(env.GITHUB_FEEDBACK_TOKEN, `/repos/${repo}/contents/${sourcePath}`, "PUT", {
        message: `Fix: autofix av issue #${issue.number} — ${errorMsg.slice(0, 60)}`,
        content: btoa(unescape(encodeURIComponent(fixedContent))),
        sha: fileData.sha,
        branch,
      });

      // Öppna PR
      await ghApi(env.GITHUB_FEEDBACK_TOKEN, `/repos/${repo}/pulls`, "POST", {
        title: `Autofix issue #${issue.number}: ${errorMsg.slice(0, 50)}`,
        body: `Automatisk fix av https://github.com/${repo}/issues/${issue.number}\n\nGenererad av issue-fixer Worker.`,
        head: branch,
        base: "main",
      });

      console.log(`issue-fixer: PR skapad för issue #${issue.number}`);
    } catch (e) {
      console.error(`issue-fixer: fel vid fix av #${issue.number}:`, e);
    }
  }
}
