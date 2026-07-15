#!/usr/bin/env bash
# Wrapper för Microsoft Graph API-anrop via politiker-webapp-management
# service principal (client-credentials, ingen interaktiv inloggning behövs).
# Behörighet: Application.ReadWrite.OwnedBy — kan bara hantera apparna den
# själv äger (Politiker-webbapp, AZURE_POLITIKER_APP_OBJECT_ID i .env).
#
# Usage: az-graph-api.sh <METHOD> <path-efter-/v1.0> [data-fil]
set -euo pipefail
source ~/.claude/credentials.env

METHOD="$1"
API_PATH="$2"
DATA_FILE="${3:-}"

TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/${AZURE_MGMT_TENANT_ID}/oauth2/v2.0/token" \
  -d "client_id=${AZURE_MGMT_CLIENT_ID}" \
  -d "client_secret=${AZURE_MGMT_CLIENT_SECRET}" \
  -d "scope=https://graph.microsoft.com/.default" \
  -d "grant_type=client_credentials" | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

ARGS=(-s -X "$METHOD" "https://graph.microsoft.com/v1.0${API_PATH}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json")

if [[ -n "$DATA_FILE" ]]; then
  ARGS+=(--data "@${DATA_FILE}")
fi

curl "${ARGS[@]}"
