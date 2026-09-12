#!/usr/bin/env bash
# Renders the committed, placeholder-carrying workflow into an importable file
# by substituting this deployment's values from .env.
#
#   ./tools/build-deploy.sh [outfile]   # default outfile: deploy.workflow.json (gitignored)
#
# Placeholders replaced:
#   <<SLACK_WEBHOOK_URL>>     from SLACK_WEBHOOK_URL
#   <<DATATABLE_ID>>          from DATATABLE_ID       (tools/create-datatable.sh prints it)
#   <<MANUAL_WEBHOOK_PATH>>   from MANUAL_WEBHOOK_PATH, or the last path segment
#                             of MANUAL_WEBHOOK_URL, or a fresh random UUID
#
# The result is a deploy artifact: never commit it, and never save it over
# workflows/abuse-report-watcher.json.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }

SRC=workflows/abuse-report-watcher.json
OUT="${1:-deploy.workflow.json}"

: "${SLACK_WEBHOOK_URL:?set SLACK_WEBHOOK_URL in .env}"
: "${DATATABLE_ID:?set DATATABLE_ID in .env (run tools/create-datatable.sh first)}"
PATH_VALUE="${MANUAL_WEBHOOK_PATH:-}"
if [ -z "$PATH_VALUE" ] && [ -n "${MANUAL_WEBHOOK_URL:-}" ]; then
  PATH_VALUE="${MANUAL_WEBHOOK_URL##*/}"
fi
if [ -z "$PATH_VALUE" ]; then
  PATH_VALUE=$(python3 -c 'import uuid; print(uuid.uuid4())')
  echo "note: no MANUAL_WEBHOOK_PATH/MANUAL_WEBHOOK_URL set — generated $PATH_VALUE" >&2
fi

SLACK_WEBHOOK_URL="$SLACK_WEBHOOK_URL" DATATABLE_ID="$DATATABLE_ID" PATH_VALUE="$PATH_VALUE" \
python3 - "$SRC" "$OUT" <<'PY'
import json, os, sys
src, out = sys.argv[1], sys.argv[2]
text = open(src, encoding='utf-8').read()
for ph, env in (('<<SLACK_WEBHOOK_URL>>', 'SLACK_WEBHOOK_URL'),
                ('<<DATATABLE_ID>>', 'DATATABLE_ID'),
                ('<<MANUAL_WEBHOOK_PATH>>', 'PATH_VALUE')):
    value = json.dumps(os.environ[env])[1:-1]   # JSON-escape, keep it inside the quotes
    if ph not in text:
        print('warning: %s not found in %s' % (ph, src), file=sys.stderr)
    text = text.replace(ph, value)
json.loads(text)  # fail loudly rather than write broken JSON
open(out, 'w', encoding='utf-8').write(text)
PY

echo "Wrote $OUT — import it in n8n (Workflows -> Import from File)."
echo "Manual trigger path: $PATH_VALUE"
