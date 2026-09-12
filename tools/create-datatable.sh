#!/usr/bin/env bash
# Creates the n8n Data Table this workflow uses for cross-run memory, with the
# exact schema the "Get State" / "Save State" nodes expect, and prints its id.
#
#   ./tools/create-datatable.sh [table-name]
#
# Needs N8N_API_URL and N8N_API_KEY (see .env / .env.template). Put the printed
# id into DATATABLE_ID in .env — it is what tools/build-deploy.sh substitutes
# for the <<DATATABLE_ID>> placeholder in the committed workflow.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }

: "${N8N_API_URL:?set N8N_API_URL (e.g. https://your-n8n-host/api/v1)}"
: "${N8N_API_KEY:?set N8N_API_KEY (n8n Settings -> API -> Create an API key)}"
NAME="${1:-abuse_watch_state}"

read -r -d '' BODY <<JSON || true
{"name":"$NAME","columns":[
  {"name":"ip","type":"string"},
  {"name":"label","type":"string"},
  {"name":"last_check_at","type":"string"},
  {"name":"last_reported_at","type":"string"},
  {"name":"total_reports","type":"number"},
  {"name":"abuse_score","type":"number"},
  {"name":"seen_keys","type":"string"},
  {"name":"fail_streak","type":"number"},
  {"name":"last_error","type":"string"},
  {"name":"last_digest_on","type":"string"}
]}
JSON

RESP=$(curl -fsS -X POST "$N8N_API_URL/data-tables" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' \
  -d "$BODY")

ID=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
[ -n "$ID" ] || { echo "unexpected response: $RESP" >&2; exit 1; }
echo "Created Data Table '$NAME'"
echo "DATATABLE_ID=$ID"
