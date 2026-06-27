#!/usr/bin/env python3
"""
Autonom issue-fixer för politiker-webapp.
Läser Gmail IMAP för nya feedback-mail, hämtar GitHub-issue-kontext,
kör Claude CLI för att analysera och fixa buggen, skapar PR.
Körs av systemd-timer (issue-fixer.timer) dagligen kl 11:00.
Max 3 issues per körning.
"""
import imaplib, email, re, os, sys, json, subprocess, logging, urllib.request
from email.header import decode_header

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s issue-fixer %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger()

ENV_FILE      = os.path.expanduser("~/.appdata/.config/.env")
REPO_PATH     = "/home/berduf/GitHub/politiker-webapp"
GITHUB_REPO   = "blixten85/politiker-webapp"
MAIL_SUBJECT  = "Ny feedback"
MAX_PER_RUN   = 3
AUTOFIX_LABEL = "autofix-attempted"

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

def decode_str(s):
    parts = decode_header(s or "")
    result = []
    for part, charset in parts:
        if isinstance(part, bytes):
            result.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(part)
    return "".join(result)

def fetch_issue_body(issue_url):
    # Konvertera https://github.com/owner/repo/issues/123 → API-URL
    m = re.search(r"github\.com/([^/]+/[^/]+)/issues/(\d+)", issue_url)
    if not m:
        return None, None
    repo, num = m.group(1), m.group(2)
    api_url = f"https://api.github.com/repos/{repo}/issues/{num}"
    req = urllib.request.Request(
        api_url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "politiker-issue-fixer"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    labels = [l["name"] for l in data.get("labels", [])]
    return data.get("body", ""), labels, int(num)

def add_label(issue_num, label):
    subprocess.run(
        ["gh", "issue", "edit", str(issue_num), "--repo", GITHUB_REPO, "--add-label", label],
        capture_output=True, timeout=30,
    )

def run_claude_fix(issue_num, issue_body):
    prompt = f"""Du är en autonom kodfix-agent för politiker.denied.se.
Repot finns på: {REPO_PATH}
Branch: kör alltid från senaste main

En produktionsbugg (GitHub issue #{issue_num}) har rapporterats:

---
{issue_body[:3000]}
---

GÖR FÖLJANDE:
1. cd {REPO_PATH} && git fetch origin && git checkout -b claude/autofix-{issue_num} origin/main
2. Läs relevant fil baserat på stack-trace eller felbeskrivning
3. Hitta rotorsaken och gör minimal fix (ändra BARA vad som krävs)
4. git add <ändrade filer> && git commit -m "Fix: autofix av issue #{issue_num}"
5. git push origin claude/autofix-{issue_num}
6. gh pr create --base main --head claude/autofix-{issue_num} --title "Autofix issue #{issue_num}" --body "Automatisk fix av https://github.com/{GITHUB_REPO}/issues/{issue_num}"

Om du inte kan hitta en säker fix — skriv "INGEN FIX" och gör ingenting.
Ingen refaktorisering. Inga extra ändringar."""

    log.info("Kör Claude för issue #%d", issue_num)
    result = subprocess.run(
        ["claude", "--dangerously-skip-permissions", "-p", prompt],
        cwd=REPO_PATH,
        capture_output=True,
        text=True,
        timeout=300,
        env={**os.environ, "ANTHROPIC_API_KEY": load_env().get("ANTHROPIC_API_KEY", "")},
    )
    output = result.stdout + result.stderr
    log.info("Claude output (issue #%d): %s", issue_num, output[:500])
    return "INGEN FIX" not in output

def main():
    env = load_env()
    imap_user = env.get("GMAIL_EMAIL")
    imap_pw   = env.get("GMAIL_PASSWORD")
    if not imap_user or not imap_pw:
        log.error("GMAIL_EMAIL / GMAIL_PASSWORD saknas"); sys.exit(1)

    mail = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    mail.login(imap_user, imap_pw)
    mail.select("INBOX")

    _, data = mail.search(None, f'(UNSEEN SUBJECT "{MAIL_SUBJECT}")')
    if not data or not data[0]:
        log.info("Inga nya feedback-mail")
        mail.logout()
        return

    seqnums = data[0].split()
    log.info("%d nya feedback-mail", len(seqnums))
    processed = 0

    for seq in seqnums:
        if processed >= MAX_PER_RUN:
            log.info("Max %d issues per körning nådd", MAX_PER_RUN)
            break

        _, fdata = mail.fetch(seq, "(RFC822)")
        raw = next((i[1] for i in fdata if isinstance(i, tuple) and isinstance(i[1], bytes)), None)
        if not raw:
            continue

        msg = email.message_from_bytes(raw)
        subject = decode_str(msg.get("Subject", ""))

        # Extrahera GitHub-issue-URL från mail-body
        body_text = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() in ("text/plain", "text/html"):
                    body_text += part.get_payload(decode=True).decode(errors="replace")
        else:
            body_text = msg.get_payload(decode=True).decode(errors="replace")

        issue_urls = re.findall(r"https://github\.com/[^\s\"<>]+/issues/\d+", body_text)
        if not issue_urls:
            log.info("Inget GitHub-issue-URL hittades i mail: %s", subject)
            mail.store(seq, "+FLAGS", "\\Seen")
            continue

        issue_url = issue_urls[0]
        log.info("Bearbetar issue: %s", issue_url)

        try:
            issue_body, labels, issue_num = fetch_issue_body(issue_url)
        except Exception as e:
            log.warning("Kunde inte hämta issue: %s", e)
            mail.store(seq, "+FLAGS", "\\Seen")
            continue

        if AUTOFIX_LABEL in (labels or []):
            log.info("Issue #%d redan bearbetad, hoppar över", issue_num)
            mail.store(seq, "+FLAGS", "\\Seen")
            continue

        # Markera issue som under bearbetning innan Claude körs
        add_label(issue_num, AUTOFIX_LABEL)

        success = run_claude_fix(issue_num, issue_body)
        if success:
            log.info("Fix skapad för issue #%d", issue_num)
        else:
            log.info("Ingen fix möjlig för issue #%d", issue_num)

        mail.store(seq, "+FLAGS", "\\Seen")
        processed += 1

    mail.logout()
    log.info("Klart: %d issues bearbetade", processed)

if __name__ == "__main__":
    main()
