#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Daglig hälsokontroll för politiker-webapp. Körs lokalt på mp100 (inte i
molnet) eftersom den behöver Cloudflare-token/D1-åtkomst som inte ska lämna
servern. Skickar ett kort statusmejl till FEEDBACK_NOTIFY_EMAIL varje dag;
om något är trasigt försöker den först diagnosticera (samma typ av fel vi
stötte på under utvecklingen: fel custom-domain-koppling, saknad
Access-bypass-policy) innan den bara rapporterar ett fel.
"""

import json
import os
import subprocess
import sys
import time

import requests

ACCOUNT_ID = "b74f8c0c6a92f3006483840cf27372fd"
ZONE_ID = "9b017d0f7284906721545dcca5fdf61e"
D1_UUID = "e9ecf94f-fa71-4004-a5b8-f9317eb4d4e9"
APP_WORKER = "politiker-webapp-app"
SENDER_WORKER = "politiker-webapp-sender"
DOMAIN = "politiker.denied.se"

ENV_FILE = os.path.expanduser("~/.claude/credentials.env")


def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k] = v
    return env


def cf_get(token, path):
    resp = requests.get(f"https://api.cloudflare.com/client/v4{path}", headers={"Authorization": f"Bearer {token}"}, timeout=15)
    return resp.json()


def cf_d1_query(token, sql):
    resp = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{D1_UUID}/query",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"sql": sql},
        timeout=15,
    )
    return resp.json()


def main():
    env = load_env()
    token = env["CLOUDFLARE_API_TOKEN_POLITIKER"]
    problems = []
    notes = []

    # 1. Publikt HTTP-svar
    try:
        r = requests.get(f"https://{DOMAIN}/", timeout=10)
        if r.status_code != 200:
            problems.append(f"https://{DOMAIN}/ svarade {r.status_code} (förväntat 200)")
        r2 = requests.get(f"https://{DOMAIN}/api/me", timeout=10)
        r2.json()  # kastar om inte giltig JSON
        if r2.status_code != 200:
            problems.append(f"/api/me svarade {r2.status_code}")
    except Exception as e:
        problems.append(f"Kunde inte nå {DOMAIN}: {e}")

    # 2. Workers existerar
    scripts = cf_get(token, f"/accounts/{ACCOUNT_ID}/workers/scripts")
    script_names = {s["id"] for s in scripts.get("result", [])}
    for name in (APP_WORKER, SENDER_WORKER):
        if name not in script_names:
            problems.append(f"Worker '{name}' saknas helt i kontot!")

    # 3. D1 nåbar
    try:
        d1_resp = cf_d1_query(token, "SELECT COUNT(*) as n FROM politicians")
        if not d1_resp.get("success"):
            problems.append(f"D1-fråga misslyckades: {d1_resp.get('errors')}")
        else:
            n = d1_resp["result"][0]["results"][0]["n"]
            notes.append(f"D1: {n} politiker i databasen")
    except Exception as e:
        problems.append(f"Kunde inte nå D1: {e}")

    # 4. Fastnade sändningsjobb (>24h i pending/sending)
    try:
        cutoff_ms = int((time.time() - 86400) * 1000)
        stuck_resp = cf_d1_query(
            token, f"SELECT COUNT(*) as n FROM send_jobs WHERE status IN ('pending','sending') AND created_at < {cutoff_ms}"
        )
        if stuck_resp.get("success"):
            stuck_n = stuck_resp["result"][0]["results"][0]["n"]
            if stuck_n > 0:
                problems.append(f"{stuck_n} sändningsjobb har varit pending/sending i över 24h — sender-workern kan ha fastnat")
    except Exception as e:
        problems.append(f"Kunde inte kontrollera kö-status: {e}")

    # 5. Diagnos om något är trasigt: vanligaste felen vi stötte på under utvecklingen
    if problems:
        try:
            domain_resp = cf_get(token, f"/accounts/{ACCOUNT_ID}/workers/domains?domain={DOMAIN}")
            domains = domain_resp.get("result", [])
            if domains and domains[0].get("service") != APP_WORKER:
                problems.append(
                    f"DIAGNOS: Custom domain {DOMAIN} pekar mot '{domains[0].get('service')}' istället för '{APP_WORKER}' — "
                    f"samma fel som under utvecklingen, fixa med PUT /workers/domains/records/{domains[0].get('id')}"
                )
        except Exception:
            pass

        try:
            apps_resp = cf_get(token, f"/accounts/{ACCOUNT_ID}/access/apps")
            apps = apps_resp.get("result", [])
            politiker_app = next((a for a in apps if a.get("domain") == DOMAIN), None)
            if not politiker_app:
                problems.append(f"DIAGNOS: Ingen Access-app hittades för {DOMAIN} — publik bypass-policy kan ha försvunnit")
            elif not any(p.get("decision") == "bypass" for p in politiker_app.get("policies", [])):
                problems.append(f"DIAGNOS: Access-appen för {DOMAIN} har ingen bypass-policy längre — sidan kan vara blockerad för besökare")
        except Exception:
            pass

    status = "OK" if not problems else f"PROBLEM ({len(problems)})"
    body_lines = [f"Status: {status}", ""]
    if notes:
        body_lines += notes + [""]
    if problems:
        body_lines.append("Problem:")
        body_lines += [f"- {p}" for p in problems]
    body = "\n".join(body_lines)

    subject = f"Politiker-webapp hälsokontroll: {status}"
    send_status_mail(subject, body)
    print(body)
    if problems:
        sys.exit(1)


def send_status_mail(subject, body):
    msg = f"From: Anders Eriksson <anders.eriksson@denied.se>\nTo: anders.eriksson@denied.se\nSubject: {subject}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\n\n{body}\n"
    subprocess.run(["msmtp", "-a", "default", "-t"], input=msg, text=True, check=False)


if __name__ == "__main__":
    main()
