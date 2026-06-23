import type { Env } from "./db";

export interface AdminStats {
  totalAccounts: number;
  totalLetters: number;
  totalSent: number;
  totalBounced: number;
  dailySeries: { day: string; sent: number }[]; // senaste 365 dagarna, ok-status
  leaderboard: { email: string; sentCount: number }[]; // topp 50
}

export async function getAdminStats(env: Env): Promise<AdminStats> {
  const totals = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM accounts) as totalAccounts,
       (SELECT COUNT(*) FROM letters) as totalLetters,
       (SELECT COUNT(*) FROM send_log WHERE status = 'ok') as totalSent,
       (SELECT COUNT(*) FROM send_log WHERE status = 'bounce') as totalBounced`,
  ).first<{ totalAccounts: number; totalLetters: number; totalSent: number; totalBounced: number }>();

  const since365 = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const { results: dailySeries } = await env.DB.prepare(
    `SELECT date(sent_at / 1000, 'unixepoch') as day, COUNT(*) as sent
     FROM send_log WHERE status = 'ok' AND sent_at >= ?
     GROUP BY day ORDER BY day`,
  )
    .bind(since365)
    .all<{ day: string; sent: number }>();

  const { results: leaderboard } = await env.DB.prepare(
    `SELECT a.email as email, COUNT(sl.id) as sentCount
     FROM accounts a LEFT JOIN send_log sl ON sl.account_id = a.id AND sl.status = 'ok'
     GROUP BY a.id ORDER BY sentCount DESC LIMIT 50`,
  ).all<{ email: string; sentCount: number }>();

  return {
    totalAccounts: totals?.totalAccounts ?? 0,
    totalLetters: totals?.totalLetters ?? 0,
    totalSent: totals?.totalSent ?? 0,
    totalBounced: totals?.totalBounced ?? 0,
    dailySeries,
    leaderboard,
  };
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(","));
  return lines.join("\n");
}

export async function exportAdminData(
  env: Env,
  section: "accounts" | "feedback" | "stats" | "all",
  format: "csv" | "json",
): Promise<{ filename: string; content: string; contentType: string }> {
  const accountsRows = async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, email, is_admin, email_verified, disabled, daily_send_cap, created_at FROM accounts ORDER BY created_at",
    ).all<Record<string, unknown>>();
    return results;
  };
  const feedbackRows = async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, account_id, message, github_issue_url, created_at FROM feedback ORDER BY created_at DESC",
    ).all<Record<string, unknown>>();
    return results;
  };

  let data: Record<string, unknown> | Record<string, unknown>[];
  let baseName: string;

  if (section === "accounts") {
    data = await accountsRows();
    baseName = "konton";
  } else if (section === "feedback") {
    data = await feedbackRows();
    baseName = "feedback";
  } else if (section === "stats") {
    const stats = await getAdminStats(env);
    data = format === "csv" ? stats.dailySeries : (stats as unknown as Record<string, unknown>);
    baseName = "statistik";
  } else {
    const [accounts, feedback, stats] = await Promise.all([accountsRows(), feedbackRows(), getAdminStats(env)]);
    data = { accounts, feedback, stats };
    baseName = "allt";
  }

  const date = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    return {
      filename: `politiker-webapp-${baseName}-${date}.json`,
      content: JSON.stringify(data, null, 2),
      contentType: "application/json",
    };
  }

  // CSV stödjer bara en tabell i taget — "all" som CSV exporterar kontona (vanligaste behovet);
  // för fullständig export rekommenderas JSON.
  const rows = Array.isArray(data) ? data : section === "all" ? ((data as { accounts: Record<string, unknown>[] }).accounts) : [data as Record<string, unknown>];
  return {
    filename: `politiker-webapp-${baseName}-${date}.csv`,
    content: toCsv(rows),
    contentType: "text/csv",
  };
}
