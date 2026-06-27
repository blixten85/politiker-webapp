import { randomId } from "../../shared/crypto";
import { sendSystemMail } from "./auth";
import type { Env } from "./db";

const FEEDBACK_REPO = "blixten85/politiker-webapp";

interface WorkerError {
  method: string;
  endpoint: string;
  status: number;
  error_message: string;
  created_at: number;
}

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

  // Hämta serverfel för kontot (senaste 48h) — ger auto-triage-boten
  // serverkontext utan att exponera hemligheter (endpoint=pathname, ingen body).
  const since48h = Date.now() - 48 * 60 * 60 * 1000;
  const serverErrors: WorkerError[] = [];
  if (input.accountId) {
    const { results } = await env.DB.prepare(
      "SELECT method, endpoint, status, error_message, created_at FROM worker_errors WHERE account_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 20",
    )
      .bind(input.accountId, since48h)
      .all<WorkerError>();
    serverErrors.push(...results);
  }

  // Rensa gamla rader (>48h) — best effort, piggybacks på befintlig skrivning.
  env.DB.prepare("DELETE FROM worker_errors WHERE created_at < ?").bind(since48h).run().catch(() => {});

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
            input.context ? `Klientkontext: \`\`\`json\n${JSON.stringify(input.context, null, 2)}\n\`\`\`` : "",
            serverErrors.length > 0
              ? `Serverfel (senaste 48h):\n\`\`\`\n${serverErrors.map(e => {
                  const ts = new Date(e.created_at).toISOString();
                  return `${ts}  ${e.method} ${e.endpoint}  ${e.status}  ${e.error_message}`;
                }).join("\n")}\n\`\`\``
              : "",
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

  const mailSubject = isContact ? "Ny kontaktfråga — politiker.denied.se" : "Ny feedback — politiker.denied.se";
  const mailHtml = [
    input.replyTo ? `<p>Svar önskas till: ${escapeHtml(input.replyTo)}</p>` : "",
    `<p>${escapeHtml(input.message)}</p>`,
    !isContact ? `<p>GitHub-issue: ${githubIssueUrl ? `<a href="${githubIssueUrl}">${githubIssueUrl}</a>` : "kunde inte skapas"}</p>` : "",
  ].join("");

  await sendSystemMail(env, env.FEEDBACK_NOTIFY_EMAIL, mailSubject, mailHtml);
  // Skicka även till issue-fixer-inkorgen så att morgon-scriptet kan agera autonomt
  if (!isContact && env.ISSUE_FIXER_INBOX) {
    await sendSystemMail(env, env.ISSUE_FIXER_INBOX, mailSubject, mailHtml).catch(() => {});
  }

  return { githubIssueUrl };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
