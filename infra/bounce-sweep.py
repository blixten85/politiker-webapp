#!/usr/bin/env python3
"""
Kvartalsvis bounce-sweep för politiker-webapp.
Skickar dagligen till 150 kommunpolitiker som inte kontaktats på 90 dagar,
vilket ger full täckning av ~14 000 kommunpolitiker var 90:e dag.
Genererar ETT brev per körning (en Claude-anrop) och personaliserar hälsningen.
Körs av systemd-timer (bounce-sweep.timer) dagligen kl 10:00.
"""
import urllib.request, json, os, sys, smtplib, logging, uuid
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.header import Header

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s bounce-sweep %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger()

ENV_FILE      = os.path.expanduser("~/.appdata/.config/.env")
CF_ACCOUNT_ID = "b74f8c0c6a92f3006483840cf27372fd"
SMTP_HOST     = "smtp-mail.outlook.com"
SMTP_PORT     = 587
CF_DB_ID      = "e9ecf94f-fa71-4004-a5b8-f9317eb4d4e9"
SENDER_NAME   = "Anders Eriksson"
MAX_PER_RUN   = 150
SWEEP_DAYS    = 90

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

def send_via_outlook(from_addr, from_pw, to_addr, to_name, subject, body_text):
    msg = MIMEText(body_text, "plain", "utf-8")
    msg["From"]    = f"{SENDER_NAME} <{from_addr}>"
    msg["To"]      = f"{to_name} <{to_addr}>"
    msg["Subject"] = str(Header(subject, "utf-8"))
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=60) as server:
        server.ehlo()
        server.starttls()
        server.login(from_addr, from_pw)
        server.send_message(msg)

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

def fetch_uncovered(cf_token):
    cutoff = int((datetime.now(timezone.utc).timestamp() - SWEEP_DAYS * 86400) * 1000)
    result = d1_query(
        """SELECT p.id, p.name, p.email, p.area_name, p.party, p.role
           FROM politicians p
           WHERE p.area_type = 'kommun'
             AND p.verification_status != 'dead_via_send'
             AND p.id NOT IN (
               SELECT DISTINCT politician_id FROM campaign_recipients
               WHERE sent_at > ?
             )
           ORDER BY RANDOM()
           LIMIT ?""",
        cf_token, [cutoff, MAX_PER_RUN],
    )
    return result.get("results", [])

def fetch_recent_topic(cf_token):
    result = d1_query(
        """SELECT title, summary, url, item_type FROM monitored_items
           WHERE letter_queued = 1
           ORDER BY created_at DESC LIMIT 1""",
        cf_token,
    )
    rows = result.get("results", [])
    return rows[0] if rows else None

def generate_sweep_letter(topic, anthropic_key):
    if topic:
        item_type_sv = {"motion": "motion", "proposition": "proposition",
                        "betankande": "betänkande", "news": "nyhet"}.get(topic["item_type"], "ärende")
        context = f"Aktuellt ärende ({item_type_sv}): {topic['title']}\nSammanfattning: {(topic.get('summary') or '')[:400]}"
    else:
        context = "Aktuellt: allmänt medborgaransvar och kommunal service"

    prompt = f"""Du är Anders Eriksson, engagerad svensk medborgare. Du skriver till en kommunpolitiker.

{context}

Skriv ett kort medborgarbrev (150–200 ord) som:
1. Börjar med "[NAMN]" som platshållare för politikerns namn (ersätts automatiskt)
2. Refererar till ett konkret lokalt problem kopplat till ovanstående ämne: sjukvård, skola, bostad, äldrevård eller ekonomisk ojämlikhet
3. Ställer en tydlig fråga om vad kommunen konkret gör eller planerar att göra
4. Avslutas med att du förväntar dig svar
5. Undertecknas "Anders Eriksson, medborgare"

Skriv ENBART brevtexten. Börja brevet med "Kära [NAMN],"."""

    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 600,
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

def send_via_msmtp(from_addr, to_addr, to_name, subject, body_text):
    msg = MIMEText(body_text, "plain", "utf-8")
    msg["From"]    = f"{SENDER_NAME} <{from_addr}>"
    msg["To"]      = f"{to_name} <{to_addr}>"
    msg["Subject"] = str(Header(subject, "utf-8"))
    proc = subprocess.run(
        ["msmtp", "--read-envelope-from", "-t"],
        input=msg.as_bytes(),
        capture_output=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode(errors="replace").strip())

def record_sent(pol_id, pol_email, pol_name, area_name, cf_token):
    draft_id = str(uuid.uuid4())
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    d1_query(
        "INSERT OR IGNORE INTO civic_letter_drafts (id, subject, html_body, topic_source_url, status, approve_token, created_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)",
        cf_token,
        [draft_id, "Bounce-sweep", "sweep", None, draft_id[:32], now],
    )
    rec_id = str(uuid.uuid4())
    d1_query(
        "INSERT OR IGNORE INTO campaign_recipients (id, draft_id, politician_id, politician_email, politician_name, area_name, status, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)",
        cf_token,
        [rec_id, draft_id, pol_id, pol_email, pol_name, area_name, now],
    )

def main():
    env = load_env()
    cf_token      = env.get("CLOUDFLARE_API_TOKEN_POLITIKER")
    anthropic_key = env.get("ANTHROPIC_API_KEY")
    from_addr     = env.get("OUTLOOK_EMAIL")
    from_pw       = env.get("OUTLOOK_PASSWORD")
    if not cf_token:
        log.error("CLOUDFLARE_API_TOKEN_POLITIKER saknas"); sys.exit(1)
    if not anthropic_key:
        log.error("ANTHROPIC_API_KEY saknas"); sys.exit(1)
    if not from_addr or not from_pw:
        log.error("OUTLOOK_EMAIL / OUTLOOK_PASSWORD saknas"); sys.exit(1)

    politicians = fetch_uncovered(cf_token)
    if not politicians:
        log.info("Alla kommunpolitiker kontaktade inom %d dagar — inget att göra", SWEEP_DAYS)
        return

    log.info("%d kommunpolitiker att kontakta idag", len(politicians))

    topic = fetch_recent_topic(cf_token)
    letter_template = generate_sweep_letter(topic, anthropic_key)
    subject = "Fråga från medborgare"
    log.info("Brevmall genererad (%d tecken)", len(letter_template))

    sent = failed = 0
    for pol in politicians:
        personalized = letter_template.replace("[NAMN]", pol["name"])
        try:
            send_via_outlook(from_addr, from_pw, pol["email"], pol["name"], subject, personalized)
            record_sent(pol["id"], pol["email"], pol["name"], pol["area_name"], cf_token)
            sent += 1
        except Exception as e:
            log.warning("Misslyckades %s (%s): %s", pol["name"], pol["email"], e)
            failed += 1

    log.info("Klart: %d skickade, %d misslyckade", sent, failed)

if __name__ == "__main__":
    main()
