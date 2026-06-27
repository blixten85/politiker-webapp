#!/usr/bin/env python3
"""
Fas 2 — brevsändare för politiker-webapp.
Hämtar pending campaign_recipients, skickar via Outlook SMTP,
uppdaterar status i D1.
Körs av systemd-timer (letter-sender.timer) dagligen kl 09:00.
Max 20 utskick per körning för att undvika spamklassificering.
"""
import urllib.request, json, os, sys, smtplib, logging
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.header import Header

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s letter-sender %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger()

ENV_FILE      = os.path.expanduser("~/.appdata/.config/.env")
CF_ACCOUNT_ID = "b74f8c0c6a92f3006483840cf27372fd"
CF_DB_ID      = "e9ecf94f-fa71-4004-a5b8-f9317eb4d4e9"
MAX_PER_RUN   = 20
SENDER_NAME   = "Anders Eriksson"
SMTP_HOST     = "smtp.gmail.com"
SMTP_PORT     = 587

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

def send_via_gmail(from_addr, from_pw, to_addr, to_name, subject, body_text):
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

def fetch_pending(cf_token):
    result = d1_query(
        """SELECT cr.id, cr.draft_id, cr.politician_email, cr.politician_name,
                  cld.subject, cld.html_body
           FROM campaign_recipients cr
           JOIN civic_letter_drafts cld ON cld.id = cr.draft_id
           WHERE cr.status = 'pending' AND cld.status = 'approved'
           ORDER BY cr.rowid ASC LIMIT ?""",
        cf_token, [MAX_PER_RUN],
    )
    return result.get("results", [])


def main():
    env = load_env()
    cf_token  = env.get("CLOUDFLARE_API_TOKEN_POLITIKER")
    from_addr = env.get("GMAIL_EMAIL")
    from_pw   = env.get("GMAIL_PASSWORD")
    if not cf_token:
        log.error("CLOUDFLARE_API_TOKEN_POLITIKER saknas"); sys.exit(1)
    if not from_addr or not from_pw:
        log.error("GMAIL_EMAIL / GMAIL_PASSWORD saknas"); sys.exit(1)

    pending = fetch_pending(cf_token)
    if not pending:
        log.info("Inga väntande brev")
        return

    log.info("%d brev att skicka (max %d)", len(pending), MAX_PER_RUN)
    sent = failed = 0
    now = int(datetime.now(timezone.utc).timestamp() * 1000)

    for rec in pending:
        try:
            send_via_gmail(
                from_addr, from_pw,
                rec["politician_email"],
                rec["politician_name"],
                rec["subject"],
                rec["html_body"],
            )
            d1_query(
                "UPDATE campaign_recipients SET status='sent', sent_at=? WHERE id=?",
                cf_token, [now, rec["id"]],
            )
            log.info("  Skickat → %s (%s)", rec["politician_name"], rec["politician_email"])
            sent += 1
        except Exception as e:
            err = str(e)[:200]
            d1_query(
                "UPDATE campaign_recipients SET status='failed', error=? WHERE id=?",
                cf_token, [err, rec["id"]],
            )
            log.warning("  Misslyckades %s: %s", rec["politician_email"], err)
            failed += 1

    log.info("Klart: %d skickade, %d misslyckade", sent, failed)

if __name__ == "__main__":
    main()
