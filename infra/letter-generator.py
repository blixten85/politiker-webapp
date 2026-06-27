#!/usr/bin/env python3
"""
Fas 2 — brevgenerator för politiker-webapp.
Hämtar nya monitored_items, väljer matchande politiker,
genererar medborgarbrev via Claude AI, lagrar i civic_letter_drafts
+ campaign_recipients.
Körs av systemd-timer (letter-generator.timer) dagligen kl 08:00.
"""
import urllib.request, json, os, sys, hashlib, logging, uuid
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s letter-gen %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger()

ENV_FILE      = os.path.expanduser("~/.appdata/.config/.env")
CF_ACCOUNT_ID = "b74f8c0c6a92f3006483840cf27372fd"
CF_DB_ID      = "e9ecf94f-fa71-4004-a5b8-f9317eb4d4e9"
SENDER_NAME   = "Anders Eriksson"
MAX_ITEMS_PER_RUN      = 5   # nya ärenden per dag
MAX_RECIPIENTS_PER_ITEM = 15  # politiker per ärende

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

def ensure_tables(cf_token):
    d1_query("""
        CREATE TABLE IF NOT EXISTS campaign_recipients (
            id TEXT PRIMARY KEY,
            draft_id TEXT NOT NULL,
            politician_id TEXT NOT NULL,
            politician_email TEXT NOT NULL,
            politician_name TEXT NOT NULL,
            area_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            sent_at INTEGER,
            error TEXT
        )
    """, cf_token)
    d1_query("CREATE INDEX IF NOT EXISTS idx_camp_rec_status ON campaign_recipients(status)", cf_token)
    d1_query("""
        CREATE TABLE IF NOT EXISTS public_letters (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            account_id TEXT,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            area_name TEXT,
            published_at INTEGER NOT NULL
        )
    """, cf_token)

def fetch_new_items(cf_token):
    result = d1_query(
        "SELECT id, source, item_type, title, url, area_name, area_type, summary FROM monitored_items WHERE letter_queued = 0 ORDER BY created_at ASC LIMIT ?",
        cf_token, [MAX_ITEMS_PER_RUN],
    )
    return result.get("results", [])

def fetch_politicians_for_item(item, cf_token):
    if item["area_type"] == "riksdag":
        result = d1_query(
            "SELECT id, name, email, area_name, party, role FROM politicians WHERE area_type = 'riksdag' AND verification_status != 'dead_via_send' ORDER BY RANDOM() LIMIT ?",
            cf_token, [MAX_RECIPIENTS_PER_ITEM],
        )
    else:
        area = item["area_name"] or ""
        # Extrahera det geografiska namnet (t.ex. "Stockholms län" → "Stockholm")
        keyword = area.replace("läns landsting", "").replace("landsting", "").replace("Region ", "").replace(" läns", "").replace(" län", "").strip()
        result = d1_query(
            "SELECT id, name, email, area_name, party, role FROM politicians WHERE area_type = 'region' AND (area_name LIKE ? OR area_name LIKE ?) AND verification_status != 'dead_via_send' ORDER BY RANDOM() LIMIT ?",
            cf_token, [f"%{keyword}%", f"%{area}%", MAX_RECIPIENTS_PER_ITEM],
        )
    return result.get("results", [])

RELEVANCE_PROMPT = """Avgör om följande nyhet eller riksdagsärende är relevant för MINST ETT av dessa ämnesområden:
- Sociala frågor: sjukvård, äldreomsorg, psykiatri, bostad, hemlöshet, barnfattigdom, skola, välfärd, pension, lön, sysselsättning, ekonomisk ojämlikhet
- Ekonomisk politik: skatter, statsbudget, offentliga utgifter, privatiseringar, arbetsmarknad
- Biståndskorruption: svenska biståndsmedel (Sida), korruption i mottagarländer, vapenexport till konfliktländer, pengaflöden som gynnar eliter snarare än befolkning

Svara med ENBART "ja" eller "nej".

Titel: {title}
Sammanfattning: {summary}"""

def is_relevant(item, anthropic_key):
    prompt = RELEVANCE_PROMPT.format(
        title=item["title"],
        summary=(item.get("summary") or "")[:400],
    )
    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 5,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": anthropic_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read())
    answer = resp["content"][0]["text"].strip().lower()
    return answer.startswith("ja")

def generate_letter(item, politician, anthropic_key):
    pol_desc = politician["name"]
    if politician.get("role"):
        pol_desc += f", {politician['role']}"
    if politician.get("party"):
        pol_desc += f" ({politician['party']})"
    pol_desc += f" – {politician['area_name']}"

    item_type_sv = {"motion": "motion", "proposition": "proposition",
                    "betankande": "betänkande", "news": "nyhet"}.get(item["item_type"], "ärende")

    prompt = f"""Du är Anders Eriksson, kritisk och engagerad svensk medborgare. Du fokuserar på:
- Sociala och ekonomiska frågor: sjukvård, äldreomsorg, bostad, välfärd, pension, skola, ekonomisk ojämlikhet
- Missbruk av svenska biståndsmedel: korruption där stöd hamnar hos eliter istället för befolkning, svenska vapen som säljs till länder som sedan använder dem mot sin egen befolkning, mediekarusellen där folk ser nyheter, donerar pengar och pengarna hamnar i samma korrupta system igen

Mottagare: {pol_desc}

Ärende ({item_type_sv}): {item['title']}
Sammanfattning: {(item.get('summary') or '')[:600]}
Källa: {item['url']}

Identifiera det konkreta problemet eller sveket i ärendet. Skriv ett medborgarbrev (240–320 ord) som:
1. Hälsar politikern vid namn
2. Beskriver problemet konkret — vad som gått fel, vem som drabbats och hur systemet sviker vanliga människor
3. Stärk argumentet med ett eller två relevanta fakta eller forskningsresultat: t.ex. SCB-statistik, OECD-rapport om Sverige, Riksrevisionens granskningar, WHO-data, Transparency International-index eller liknande. Uppge källa kortfattat i parentes.
4. Håller politikern ansvarig: vad har de eller deras parti gjort (eller INTE gjort) som bidragit till detta?
5. Kräver ett konkret svar med specifik åtgärd och tidsram — inte vaga löften
6. Avslutar med att du förväntar dig ett faktiskt svar
7. Undertecknas "Anders Eriksson"

Ton: saklig, direkt och krävande. Inga tomma artighetsfraser. Inga hejapå-kommentarer.
Skriv ENBART brevtexten, ingen ämnesrad, inga kommentarer."""

    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 800,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": anthropic_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read())
    return resp["content"][0]["text"].strip()

def make_subject(item):
    prefix = {"motion": "Motion", "proposition": "Proposition",
               "betankande": "Betänkande", "news": "Nyhet"}.get(item["item_type"], "Ärende")
    title = item["title"][:80]
    return f"{prefix}: {title}"

def main():
    env = load_env()
    cf_token = env.get("CLOUDFLARE_API_TOKEN_POLITIKER")
    anthropic_key = env.get("ANTHROPIC_API_KEY")

    if not cf_token:
        log.error("CLOUDFLARE_API_TOKEN_POLITIKER saknas i %s", ENV_FILE)
        sys.exit(1)
    if not anthropic_key:
        log.error("ANTHROPIC_API_KEY saknas i %s", ENV_FILE)
        sys.exit(1)

    ensure_tables(cf_token)

    items = fetch_new_items(cf_token)
    if not items:
        log.info("Inga nya ärenden att bearbeta")
        return

    log.info("%d nya ärenden", len(items))
    total_drafts = 0

    for item in items:
        if not is_relevant(item, anthropic_key):
            log.info("Inte relevant, hoppar över: %s", item["title"][:60])
            d1_query("UPDATE monitored_items SET letter_queued = 2 WHERE id = ?", cf_token, [item["id"]])
            continue

        politicians = fetch_politicians_for_item(item, cf_token)
        if not politicians:
            log.info("Inga matchande politiker för: %s", item["title"][:60])
            d1_query("UPDATE monitored_items SET letter_queued = 1 WHERE id = ?", cf_token, [item["id"]])
            continue

        log.info("Ärende '%s' → %d politiker", item["title"][:60], len(politicians))

        first_published = False
        for pol in politicians:
            try:
                body_text = generate_letter(item, pol, anthropic_key)
                subject = make_subject(item)
                draft_id = str(uuid.uuid4())
                approve_token = hashlib.sha256(draft_id.encode()).hexdigest()[:32]
                now = int(datetime.now(timezone.utc).timestamp() * 1000)

                d1_query(
                    "INSERT OR IGNORE INTO civic_letter_drafts (id, subject, html_body, topic_source_url, status, approve_token, created_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)",
                    cf_token,
                    [draft_id, subject, body_text, item["url"], approve_token, now],
                )
                rec_id = str(uuid.uuid4())
                d1_query(
                    "INSERT OR IGNORE INTO campaign_recipients (id, draft_id, politician_id, politician_email, politician_name, area_name) VALUES (?, ?, ?, ?, ?, ?)",
                    cf_token,
                    [rec_id, draft_id, pol["id"], pol["email"], pol["name"], pol["area_name"]],
                )
                total_drafts += 1
                log.info("  Utkast skapat → %s (%s)", pol["name"], pol["email"])
                if not first_published:
                    pub_id = str(uuid.uuid4())
                    d1_query(
                        "INSERT OR IGNORE INTO public_letters (id, source, account_id, subject, body, area_name, published_at) VALUES (?, 'campaign', NULL, ?, ?, ?, ?)",
                        cf_token,
                        [pub_id, subject, body_text, item.get("area_name"), now],
                    )
                    first_published = True
            except Exception as e:
                log.warning("  Misslyckades för %s: %s", pol["name"], e)

        d1_query("UPDATE monitored_items SET letter_queued = 1 WHERE id = ?", cf_token, [item["id"]])

    log.info("Klart: %d brevutkast skapade", total_drafts)

if __name__ == "__main__":
    main()
