import type { Env } from "./index";

const SVT_REGIONS: Record<string, string> = {
  blekinge: "Blekinge", dalarna: "Dalarna", gavleborg: "Gävleborg",
  halland: "Halland", helsingborg: "Helsingborg", jonkoping: "Jönköping",
  norrbotten: "Norrbotten", skane: "Skåne", smaland: "Småland",
  stockholm: "Stockholm", soder: "Södertälje", ost: "Region Östergötland",
  vast: "Väst", vasterbotten: "Västerbotten", vasternorrland: "Västernorrland",
  vastmanland: "Västmanland", orebro: "Örebro", uppsala: "Uppsala",
  sormland: "Södermanland",
};

const NATIONAL_SOURCES = [
  { url: "https://www.svt.se/nyheter/rss.xml",                                source: "svt_national",  area: "Sverige" },
  { url: "https://www.svt.se/nyheter/utrikes/rss.xml",                        source: "svt_utrikes",   area: "Utrikes" },
  { url: "https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/", source: "aftonbladet",   area: "Sverige" },
  { url: "https://feeds.expressen.se/nyheter/",                               source: "expressen",     area: "Sverige" },
];

const RIKSDAG_TYPES = [
  { type: "mot", label: "motion" },
  { type: "prop", label: "proposition" },
  { type: "bet", label: "betankande" },
];

interface RssItem { title: string; url: string; summary: string }

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/) ?? item.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim() ?? "";
    const url   = (item.match(/<link>([\s\S]*?)<\/link>/) ?? item.match(/<guid[^>]*>(https?:\/\/[\s\S]*?)<\/guid>/))?.[1]?.trim() ?? "";
    const desc  = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/) ?? item.match(/<description>([\s\S]*?)<\/description>/))?.[1] ?? "";
    const summary = desc.replace(/<[^>]*>/g, "").replace(/</g, "").trim().slice(0, 500);
    if (title && url) items.push({ title, url, summary });
  }
  return items;
}

async function itemId(url: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function fetchRss(url: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": "politiker-webapp-monitor/1.0" }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

interface DbItem {
  id: string; source: string; item_type: string; title: string;
  url: string; area_name: string; area_type: string; summary: string;
}

async function batchUpsert(env: Env, items: DbItem[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    const stmts = batch.map(it =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO monitored_items (id,source,item_type,title,url,area_name,area_type,summary,letter_queued,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)"
      ).bind(it.id, it.source, it.item_type, it.title, it.url, it.area_name, it.area_type, it.summary, Date.now())
    );
    const results = await env.DB.batch(stmts);
    inserted += results.reduce((s, r) => s + (r.meta.changes ?? 0), 0);
  }
  return inserted;
}

export async function runMonitor(env: Env): Promise<void> {
  const items: DbItem[] = [];

  // Riksdagen RSS
  for (const { type, label } of RIKSDAG_TYPES) {
    try {
      const xml = await fetchRss(`https://www.riksdagen.se/sv/sok/?avd=dokument&doktyp=${type}&utformat=rss&sidnr=1`);
      for (const entry of parseRss(xml)) {
        items.push({
          id: await itemId(entry.url), source: "riksdagen", item_type: label,
          title: entry.title, url: entry.url, area_name: "Riksdagen",
          area_type: "riksdag", summary: entry.summary,
        });
      }
    } catch (e) { console.error(`monitor: fel vid riksdagen/${type}:`, e); }
  }

  // SVT regionalt
  for (const [slug, areaName] of Object.entries(SVT_REGIONS)) {
    try {
      const xml = await fetchRss(`https://www.svt.se/nyheter/lokalt/${slug}/rss.xml`);
      for (const entry of parseRss(xml)) {
        items.push({
          id: await itemId(entry.url), source: `svt_${slug}`, item_type: "news",
          title: entry.title, url: entry.url, area_name: areaName,
          area_type: "region", summary: entry.summary,
        });
      }
    } catch (e) { console.error(`monitor: fel vid svt_${slug}:`, e); }
  }

  // Nationella källor
  for (const s of NATIONAL_SOURCES) {
    try {
      const xml = await fetchRss(s.url);
      for (const entry of parseRss(xml)) {
        items.push({
          id: await itemId(entry.url), source: s.source, item_type: "news",
          title: entry.title, url: entry.url, area_name: s.area,
          area_type: "riksdag", summary: entry.summary,
        });
      }
    } catch (e) { console.error(`monitor: fel vid ${s.source}:`, e); }
  }

  const inserted = await batchUpsert(env, items);
  console.log(`monitor: ${items.length} poster hämtade, ${inserted} nya`);
}
