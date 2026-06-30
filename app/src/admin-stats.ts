import type { Env } from "./db";

export interface AdminStats {
  totalAccounts: number;
  totalLetters: number;
  totalSent: number;
  totalBounced: number;
  totalVisitors: number; // unika besökare (COUNT DISTINCT), all tid
  visitorCountries: { country: string; n: number }[]; // unika besökare per land
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

  // Defensivt: visits-tabellen (och country-kolumnen) kan saknas innan
  // migrationerna körts.
  let totalVisitors = 0;
  let visitorCountries: { country: string; n: number }[] = [];
  try {
    const v = await env.DB.prepare("SELECT COUNT(DISTINCT visitor_hash) as n FROM visits").first<{ n: number }>();
    totalVisitors = v?.n ?? 0;
    const c = await env.DB.prepare(
      `SELECT country, COUNT(DISTINCT visitor_hash) as n FROM visits
       WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC, country`,
    ).all<{ country: string; n: number }>();
    visitorCountries = c.results;
    // Besökare vars land aldrig kunde resolvas (country IS NULL) faller ur
    // frågan ovan. Lägg dem i en "Okänt"-hink så landsuppdelningen blir en
    // äkta partition som summerar till totalVisitors — annars ser siffrorna
    // ut att inte stämma (t.ex. 24 totalt men bara 17 fördelat på länder).
    const knownSum = visitorCountries.reduce((sum, r) => sum + r.n, 0);
    const unknown = totalVisitors - knownSum;
    if (unknown > 0) visitorCountries.push({ country: "??", n: unknown });
  } catch {
    /* tabellen/kolumnen finns inte än */
  }

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
    totalVisitors,
    visitorCountries,
    dailySeries,
    leaderboard,
  };
}

export type Granularity = "minute" | "hour" | "day" | "week" | "month" | "quarter" | "half" | "year";

export interface TimeSeriesPoint {
  bucket: string;
  sent: number;
  visitors: number;
}

// Vitlista granularitet → (SQL-bucketuttryck, tidsfönster). Kolumnnamnet
// substitueras in — granularitet kommer aldrig in i SQL:en som fri text, så
// ingen injektionsyta. Fönstret begränsar antalet rader/buckets per
// upplösning så frågorna förblir billiga (fina upplösningar = kort fönster).
const DAY = 24 * 60 * 60 * 1000;
const GRAN: Record<Granularity, { expr: (col: string) => string; windowMs: number | null }> = {
  minute: { expr: (c) => `strftime('%Y-%m-%d %H:%M', ${c} / 1000, 'unixepoch')`, windowMs: 6 * 60 * 60 * 1000 },
  hour: { expr: (c) => `strftime('%Y-%m-%d %H:00', ${c} / 1000, 'unixepoch')`, windowMs: 7 * DAY },
  day: { expr: (c) => `date(${c} / 1000, 'unixepoch')`, windowMs: 365 * DAY },
  week: { expr: (c) => `strftime('%Y-W%W', ${c} / 1000, 'unixepoch')`, windowMs: 2 * 365 * DAY },
  month: { expr: (c) => `strftime('%Y-%m', ${c} / 1000, 'unixepoch')`, windowMs: 5 * 365 * DAY },
  quarter: {
    expr: (c) => `strftime('%Y', ${c} / 1000, 'unixepoch') || '-Q' || ((cast(strftime('%m', ${c} / 1000, 'unixepoch') as integer) + 2) / 3)`,
    windowMs: null,
  },
  half: {
    expr: (c) => `strftime('%Y', ${c} / 1000, 'unixepoch') || '-H' || ((cast(strftime('%m', ${c} / 1000, 'unixepoch') as integer) + 5) / 6)`,
    windowMs: null,
  },
  year: { expr: (c) => `strftime('%Y', ${c} / 1000, 'unixepoch')`, windowMs: null },
};

// Tidsserie för admin-grafen: skickade brev (additivt) OCH unika besökare
// (COUNT DISTINCT — INTE additivt, måste beräknas per bucket i SQL, inte
// rollas upp från en finare serie i frontend). Slås ihop per bucket.
export async function getTimeSeries(env: Env, granularity: Granularity): Promise<TimeSeriesPoint[]> {
  const g = GRAN[granularity] ?? GRAN.month;
  const since = g.windowMs === null ? 0 : Date.now() - g.windowMs;

  const sentRows = await env.DB.prepare(
    `SELECT ${g.expr("sent_at")} as bucket, COUNT(*) as n
     FROM send_log WHERE status = 'ok' AND sent_at >= ?
     GROUP BY bucket`,
  )
    .bind(since)
    .all<{ bucket: string; n: number }>();

  let visitorRows: { bucket: string; n: number }[] = [];
  try {
    const r = await env.DB.prepare(
      `SELECT ${g.expr("visited_at")} as bucket, COUNT(DISTINCT visitor_hash) as n
       FROM visits WHERE visited_at >= ?
       GROUP BY bucket`,
    )
      .bind(since)
      .all<{ bucket: string; n: number }>();
    visitorRows = r.results;
  } catch {
    /* visits-tabellen finns inte än */
  }

  const byBucket = new Map<string, TimeSeriesPoint>();
  for (const { bucket, n } of sentRows.results) byBucket.set(bucket, { bucket, sent: n, visitors: 0 });
  for (const { bucket, n } of visitorRows) {
    const p = byBucket.get(bucket) ?? { bucket, sent: 0, visitors: 0 };
    p.visitors = n;
    byBucket.set(bucket, p);
  }

  return [...byBucket.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
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
  section: "accounts" | "feedback" | "stats" | "politicians" | "all",
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
  // Politiker-tabellen är helt separat från konton — innehåller ALDRIG
  // användardata, bara offentliga tjänsteadresser till folkvalda.
  const politiciansRows = async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, name, email, area_name, area_type, last_scraped_at FROM politicians ORDER BY area_type, area_name, name",
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
  } else if (section === "politicians") {
    data = await politiciansRows();
    baseName = "politiker";
  } else if (section === "stats") {
    const stats = await getAdminStats(env);
    data = format === "csv" ? stats.dailySeries : (stats as unknown as Record<string, unknown>);
    baseName = "statistik";
  } else {
    const [accounts, feedback, stats, politicians] = await Promise.all([accountsRows(), feedbackRows(), getAdminStats(env), politiciansRows()]);
    data = { accounts, feedback, stats, politicians };
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
