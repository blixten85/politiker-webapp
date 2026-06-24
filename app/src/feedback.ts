import { randomId } from "../../shared/crypto";
import { sendSystemMail } from "./auth";
import type { Env } from "./db";

const FEEDBACK_REPO = "blixten85/politiker-webapp";

export async function submitFeedback(
  env: Env,
  input: {
    accountId: string | null;
    message: string;
    context?: Record<string, unknown>;
    type?: "bug" | "contact";
    replyTo?: string;
  },
): Promise<{ githubIssueUrl: string | null }> {
  const isContact = input.type === "contact";
  let githubIssueUrl: string | null = null;

  // Allmänna kontaktfrågor skapar inte en GitHub-issue (är inte buggar/buggrapporter
  // som hör hemma i kodspårningen) — bara felrapporter gör det.
  if (!isContact) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${FEEDBACK_REPO}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_FEEDBACK_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "politiker-webapp-feedback",
        },
        body: JSON.stringify({
          title: `Feedback: ${input.message.slice(0, 60)}${input.message.length > 60 ? "…" : ""}`,
          body: [
            input.message,
            "",
            "---",
            `Konto: ${input.accountId ?? "ej inloggad"}`,
            input.context ? `Kontext: \`\`\`json\n${JSON.stringify(input.context, null, 2)}\n\`\`\`` : "",
            "",
            "@claude",
          ].join("\n"),
          labels: ["feedback", "user-reported"],
        }),
      });
      if (resp.ok) {
        const issue = (await resp.json()) as { html_url: string };
        githubIssueUrl = issue.html_url;
      }
    } catch {
      // GitHub-issue är "best effort" — mejlkopian nedan är huvudvägen för att felet inte ska gå förlorat.
    }
  }

  await env.DB.prepare(
    "INSERT INTO feedback (id, account_id, message, github_issue_url, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(randomId(), input.accountId, input.message, githubIssueUrl, Date.now())
    .run();

  await sendSystemMail(
    env,
    env.FEEDBACK_NOTIFY_EMAIL,
    isContact ? "Ny kontaktfråga — politiker.denied.se" : "Ny feedback — politiker.denied.se",
    [
      input.replyTo ? `<p>Svar önskas till: ${escapeHtml(input.replyTo)}</p>` : "",
      `<p>${escapeHtml(input.message)}</p>`,
      !isContact ? `<p>GitHub-issue: ${githubIssueUrl ? `<a href="${githubIssueUrl}">${githubIssueUrl}</a>` : "kunde inte skapas"}</p>` : "",
    ].join(""),
  );

  return { githubIssueUrl };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
