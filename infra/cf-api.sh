#!/usr/bin/env bash
# Wrapper för alla Cloudflare API-anrop i politiker-webapp-projektet.
# Usage: cf-api.sh <METHOD> <path-efter-/client/v4> [data-fil]
set -euo pipefail
source ~/.claude/credentials.env

METHOD="$1"
API_PATH="$2"
DATA_FILE="${3:-}"

ARGS=(-s -X "$METHOD" "https://api.cloudflare.com/client/v4${API_PATH}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN_POLITIKER}" \
  -H "Content-Type: application/json")

if [[ -n "$DATA_FILE" ]]; then
  ARGS+=(--data "@${DATA_FILE}")
fi

curl "${ARGS[@]}"
