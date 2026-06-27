#!/usr/bin/env python3
"""
Bounce processor för politiker-webapp.
Läser studsade mail från Outlook IMAP, markerar döda adresser i Cloudflare D1.
Körs av systemd-timer (se bounce-processor.timer).
"""
import imaplib, email, re, sys, os, json, urllib.request, urllib.error, logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s bounce-processor %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger()

ENV_FILE = os.path.expanduser("~/.appdata/.config/.env")
CF_ACCOUNT_ID = "b74f8c0c6a92f3006483840cf27372fd"
CF_DB_ID = "e9ecf94f-fa71-4004-a5b8-f9317eb4d4e9"

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


SKIP_DOMAINS = {
    "denied.se","icloud.com","apple.com","microsoft.com","google.com",
    "gmail.com","hotmail.com","live.com","outlook.com","yahoo.com",
    "telia.com","tele2.com","comhem.se",
}
SKIP_PATTERNS = [
    r"\.prod\.outlook\.com$", r"\.swep\d+\.", r"\.eurprd\d+\.",
    r"outbound\.", r"^mailer-daemon@", r"^postmaster@",
    r"^[0-9a-f]{20,}@", r"@[0-9a-f]{20,}\.",
]

def is_politician_addr(addr):
    addr = addr.lower()
    domain = addr.split("@", 1)[-1] if "@" in addr else ""
    if domain in SKIP_DOMAINS:
        return False
    for p in SKIP_PATTERNS:
        if re.search(p, addr, re.I):
            return False
    local = addr.split("@")[0]
    return bool(re.search(r"[a-zA-ZåäöÅÄÖ.-]", local)) and len(local) > 2

def extract_bounced_addresses(raw_bytes):
    full = raw_bytes.decode(errors="ignore")
    found = set()

    # DSN-headers (RFC 3464) — mest tillförlitliga
    for addr in re.findall(
        r"(?:Final-Recipient|Original-Recipient)[^\n]*?<?([\w.+%-]+@[\w.\-]+\.\w+)>?",
        full, re.I
    ):
        found.add(addr.lower())

    # Postfix: <addr>: SMTP-svar
    for addr in re.findall(r"<([\w.+%-]+@[\w.\-]+\.\w+)>\s*(?::\s*\n|\s*\()", full):
        found.add(addr.lower())

    # "The following address(es) failed/could not be delivered"
    for addr in re.findall(
        r"following address.*?<([\w.+%-]+@[\w.\-]+\.\w+)>", full, re.I | re.S
    ):
        found.add(addr.lower())

    # Microsoft NDR: "Delivery has failed to these recipients"
    for addr in re.findall(
        r"failed to these recipients[^\n]*\n\s*\n?\s*([\w.+%-]+@[\w.\-]+\.\w+)",
        full, re.I
    ):
        found.add(addr.lower())

    # Exchange/O365: Recipient address i NDR-tabell
    for addr in re.findall(
        r"Recipient Address:\s*([\w.+%-]+@[\w.\-]+\.\w+)", full, re.I
    ):
        found.add(addr.lower())

    return {a for a in found if is_politician_addr(a)}

def mark_dead_in_d1(addresses, cf_token):
    if not addresses:
        return 0
    placeholders = ",".join(f"'{a}'" for a in addresses)
    sql = (
        f"UPDATE politicians SET verification_status='dead_via_send', "
        f"last_verified_at=strftime('%s','now')*1000 WHERE email IN ({placeholders})"
    )
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_DB_ID}/query"
    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={
            "Authorization": f"Bearer {cf_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    if not data.get("success"):
        raise RuntimeError(f"D1 API error: {data.get('errors')}")
    rows = data["result"][0]["meta"].get("changes", 0)
    return rows

def main():
    env = load_env()
    cf_token  = env.get("CLOUDFLARE_API_TOKEN_POLITIKER")
    imap_user = env.get("OUTLOOK_EMAIL")
    imap_pw   = env.get("OUTLOOK_PASSWORD")
    if not cf_token:
        log.error("CLOUDFLARE_API_TOKEN_POLITIKER saknas"); sys.exit(1)
    if not imap_user or not imap_pw:
        log.error("OUTLOOK_EMAIL / OUTLOOK_PASSWORD saknas"); sys.exit(1)

    mail = imaplib.IMAP4_SSL("outlook.office365.com", 993)
    mail.login(imap_user, imap_pw)

    all_bounced = set()
    processed_seqs = []

    for folder in ["INBOX", "Junk"]:
        status, _ = mail.select(folder)
        if status != "OK":
            continue

        # Sök olästa studs-mail (UNSEEN filtrerar bort redan behandlade)
        _, data = mail.search(None, '(UNSEEN OR SUBJECT "Undeliverable" SUBJECT "Delivery Status Notification")')
        if not data or not data[0]:
            continue
        seqnums = [s for s in data[0].split() if s]
        log.info("Mapp %s: %d olästa studs-mail", folder, len(seqnums))

        for seq in seqnums:
            _, fdata = mail.fetch(seq, "(BODY.PEEK[])")
            raw = next(
                (i[1] for i in fdata if isinstance(i, tuple) and isinstance(i[1], bytes)),
                next((i for i in fdata if isinstance(i, bytes) and len(i) > 200), None)
            )
            if not raw:
                continue
            addrs = extract_bounced_addresses(raw)
            if addrs:
                log.info("Seq %s: hittade %s", seq.decode(), addrs)
                all_bounced |= addrs
            # Markera som läst oavsett (undvik att behandla igen)
            mail.store(seq, "+FLAGS", "\\Seen")
            processed_seqs.append(seq)

    mail.logout()

    if not all_bounced:
        log.info("Inga nya studsade adresser hittades")
        return

    log.info("Markerar %d adresser som dead_via_send i D1: %s", len(all_bounced), all_bounced)
    try:
        changed = mark_dead_in_d1(all_bounced, cf_token)
        log.info("D1 uppdaterade %d rader", changed)
    except Exception as e:
        log.error("D1-uppdatering misslyckades: %s", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
