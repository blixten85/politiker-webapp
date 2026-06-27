#!/usr/bin/env python3
"""
Bevakningsskript för politiker-webapp.
Hämtar nya motioner från riksdagen + lokala nyheter från SVT,
lagrar i D1-tabellen monitored_items.
Körs av systemd-timer (monitor.timer) dagligen.
"""
import urllib.request, urllib.error, xml.etree.ElementTree as ET
import json, os, sys, hashlib, logging
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s monitor %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger()

ENV_FILE = os.path.expanduser("~/.appdata/.config/.env")
CF_ACCOUNT_ID = "b74f8c0c6a92f3006483840cf27372fd"
CF_DB_ID = "e9ecf94f-fa71-4004-a5b8-f9317eb4d4e9"
UA = "Mozilla/5.0 (compatible; politikerkontakt-monitor/1.0)"

# SVT lokalnyheter per SVT-region → area_name i DB
SVT_REGIONS = {
    "blekinge":         "Blekinge",
    "dalarna":          "Dalarna",
    "gavleborg":        "Gävleborgs län",
    "halland":          "Region Halland",
    "jamtland":         "Jämtlands län",
    "jonkoping":        "Jönköpings län",
    "norrbotten":       "Norrbottens län",
    "skane":            "Region Skåne",
    "smaland":          "Kronobergs län",
    "stockholm":        "Stockholms län",
    "sormland":         "Södermanlands län",
    "uppsala":          "Uppsala län",
    "varmland":         "Värmlands län",
    "vast":             "Västra Götalandsregionen",
    "vasterbotten":     "Västerbottens län",
    "vasternorrland":   "Västernorrlands län",
    "vastmanland":      "Västmanlands län",
    "orebro":           "Örebro läns landsting",
    "ost":              "Region Östergötland",
}

def load_env():
    env = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env

def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def item_id(url):
    return hashlib.sha1(url.encode()).hexdigest()[:20]

def parse_rss(content):
    root = ET.fromstring(content)
    items = []
    for item in root.findall(".//item"):
        title = item.findtext("title", "").strip()
        link = item.findtext("link", "").strip()
        pub = item.findtext("pubDate", "").strip()
        desc = item.findtext("description", "").strip()
        if title and link:
            items.append({"title": title, "url": link, "published": pub, "summary": desc[:500]})
    return items

def d1_query(sql, cf_token, params=None):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_DB_ID}/query"
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {cf_token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    if not data.get("success"):
        raise RuntimeError(f"D1 error: {data.get('errors')}")
    return data["result"][0]

def ensure_table(cf_token):
    d1_query("""
        CREATE TABLE IF NOT EXISTS monitored_items (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            item_type TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            area_name TEXT,
            area_type TEXT,
            summary TEXT,
            published_at INTEGER,
            created_at INTEGER NOT NULL,
            letter_queued INTEGER NOT NULL DEFAULT 0
        )
    """, cf_token)

def upsert_items(items, cf_token):
    inserted = 0
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    BATCH = 50
    for start in range(0, len(items), BATCH):
        batch = items[start:start + BATCH]
        placeholders = ",".join("(?,?,?,?,?,?,?,?,?,?)" for _ in batch)
        params = []
        for item in batch:
            params += [
                item["id"], item["source"], item["item_type"],
                item["title"], item["url"],
                item.get("area_name"), item.get("area_type"),
                item.get("summary", ""),
                item.get("published_at"), now,
            ]
        try:
            result = d1_query(
                f"INSERT OR IGNORE INTO monitored_items (id, source, item_type, title, url, area_name, area_type, summary, published_at, created_at) VALUES {placeholders}",
                cf_token, params,
            )
            inserted += result["meta"].get("changes", 0)
        except Exception as e:
            log.warning("Batch %d misslyckades: %s", start, e)
    return inserted

def fetch_riksdagen_motioner():
    sources = [
        ("mot", "motion"),
        ("prop", "proposition"),
        ("bet", "betankande"),
    ]
    items = []
    for doktyp, item_type in sources:
        try:
            content = fetch(
                f"https://data.riksdagen.se/dokumentlista/?doktyp={doktyp}&utformat=rss&sort=datum&sortorder=desc&sz=50"
            )
            for entry in parse_rss(content):
                items.append({
                    "id": item_id(entry["url"]),
                    "source": "riksdagen",
                    "item_type": item_type,
                    "title": entry["title"],
                    "url": entry["url"],
                    "area_name": None,
                    "area_type": "riksdag",
                    "summary": entry["summary"],
                    "published_at": None,
                })
            log.info("Riksdagen %s: %d poster", doktyp, len(items))
        except Exception as e:
            log.warning("Riksdagen %s misslyckades: %s", doktyp, e)
    return items

def fetch_svt_local():
    items = []
    for slug, area_name in SVT_REGIONS.items():
        try:
            content = fetch(f"https://www.svt.se/nyheter/lokalt/{slug}/rss.xml")
            for entry in parse_rss(content):
                items.append({
                    "id": item_id(entry["url"]),
                    "source": "svt_lokal",
                    "item_type": "news",
                    "title": entry["title"],
                    "url": entry["url"],
                    "area_name": area_name,
                    "area_type": "region",
                    "summary": entry["summary"],
                    "published_at": None,
                })
        except Exception as e:
            log.warning("SVT %s misslyckades: %s", slug, e)
    log.info("SVT lokalt: %d poster totalt", len(items))
    return items

def main():
    env = load_env()
    cf_token = env.get("CLOUDFLARE_API_TOKEN_POLITIKER")
    if not cf_token:
        log.error("CLOUDFLARE_API_TOKEN_POLITIKER saknas i %s", ENV_FILE)
        sys.exit(1)

    ensure_table(cf_token)

    all_items = []
    all_items += fetch_riksdagen_motioner()
    all_items += fetch_svt_local()

    inserted = upsert_items(all_items, cf_token)
    log.info("Klart: %d nya poster av %d insamlade", inserted, len(all_items))

if __name__ == "__main__":
    main()
