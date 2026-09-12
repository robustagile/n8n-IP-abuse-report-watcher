# AbuseWatch — maintainer / agent notes

Automation that watches a configurable list of **your own** public IP addresses on
**AbuseIPDB** and reports to Slack. The deliverable is an **n8n workflow**, not a
conventional code repo.

`README.md` is the user-facing guide (what it does, why, and how to install it). This file
is the companion for whoever — human or agent — *changes* the thing: where the source of
truth is, which decisions are load-bearing, and what not to re-litigate.

This repo is **safe to publish**: no secret value and no live deployment coordinate is
committed.

## Reporting contract

- **Hourly** check. If new abuse reports appeared since the previous check, post to Slack
  straight away with the reporter categories and comments.
- **Once a day from 16:00 local**, post an "all clean" recap even when nothing happened,
  so silence is never ambiguous. "From", not "at" — see *Why the recap is date-stamped*.
- Otherwise **post nothing** — quiet hours stay quiet.

## How this project is built

- The workflow is driven through the **`n8n-mcp`** MCP server (configured in `.mcp.json`,
  reading `${N8N_API_URL}` / `${N8N_API_KEY}` from the environment). Build / validate /
  deploy via the `n8n-mcp` tools — there is no local source tree to compile.
- **Source of truth:** the exported workflow JSON in `workflows/abuse-report-watcher.json`,
  carrying `<<PLACEHOLDERS>>`. The n8n instance is the deploy target, not the source.
- Posting goes through a Slack **incoming webhook**; messages are Slack `mrkdwn` in a
  single `text` field. Cross-run memory lives in an n8n **Data Table**.

## Architecture (single workflow, 12 nodes)

```
Schedule Hourly (cron 0 * * * *) ─┐
Manual Check (webhook, on demand) ┴→ Config ─┬→ Check AbuseIPDB ─┐
                                             ├───────────────────┴→ Merge Config + Response ─┐
                                             └→ Get State ───────────────────────────────────┴→ Merge State
                                                                                                    │
                                                                                                    ▼
                                                                                                 Analyze
                                                                                            ┌───────┴───────┐
                                                                                     Post Gate       Explode States
                                                                                            │               │
                                                                                     Post to Slack     Save State
```

- **`Config`** is the single place to edit. `WATCHED` is a list of `{ ip, label }`;
  everything downstream fans out from it automatically. Also holds `MAX_AGE_DAYS` and
  `FORCE_POST`. The committed copy carries RFC 5737 documentation addresses as examples.
- **`Check AbuseIPDB`** runs once per address. `onError: continueRegularOutput` means a
  failed call still emits one item, so the branch stays **aligned by position** with
  `Config` — that alignment is what `Merge Config + Response` relies on to re-attach
  `ip`/`label`.
- **`Get State`** reads the whole state table in one shot (`executeOnce`, no filter
  conditions = all rows), rather than once per address.
- **`Analyze`** does everything stateful: diffs reports, renders the Slack text, and
  decides whether the run is worth posting at all. `TZ` / `TZ_LABEL` at the top must match
  the workflow's own timezone setting.
- **`Post Gate`** returns zero items on a quiet run, which stops the branch — that is how
  the workflow stays silent without an IF node.
- **`Save State`** upserts one row per address into the Data Table, matched on `ip`. It
  runs on **every** execution, including silent ones.

Note that n8n's public API cannot add a column to an existing Data Table, so a schema
change means creating a new table and repointing the two Data Table nodes at it.
`tools/create-datatable.sh` creates one with the expected schema.

## How "new" is decided

Each report is fingerprinted as `reportedAt|reporterId`. The state row keeps the full set
of fingerprints currently inside the API's `maxAgeInDays` window as a JSON array in
`seen_keys`.

- **New reports** = fingerprints in this response that are not in `seen_keys`.
- The set **self-prunes**: it is replaced each successful run by whatever the API returned,
  and the API only ever returns reports inside the window, so it cannot grow without bound.
- **Baseline rule:** an address with a blank `seen_keys` has never been read successfully.
  Its first good read is recorded as a *baseline* and reports nothing as "new", so adding
  an address does not dump its entire back catalogue into Slack. Blank is distinct from
  `'[]'`, which means "checked, genuinely zero reports".
- **A failed check never overwrites good state.** On failure the previous `seen_keys`,
  `total_reports` and `last_reported_at` are carried forward untouched and only
  `fail_streak` and `last_error` move.
- **Fallback:** if `reports[]` is ever absent (a non-verbose response), the diff falls back
  to comparing `totalReports` against the stored count and says detail is unavailable.

## Why the AbuseIPDB API and not the `/check/` page

`https://www.abuseipdb.com/check/<ip>` is behind Cloudflare and returns **403** to any
server-side fetch — and scraping it would be against AbuseIPDB's terms. The workflow uses
**API v2** (`GET https://api.abuseipdb.com/api/v2/check`) instead, which is a documented,
free endpoint and returns exactly what the report diff needs.

- `?ipAddress=<ip>&maxAgeInDays=90&verbose` — `verbose` is a bare presence flag (no
  `=value`), which is why the whole query string is built into the node's URL rather than
  via "Send Query Parameters". `verbose=true` is **not** the documented form.
- Free tier is **1,000 checks/day**. Two addresses × 24 hourly runs = **48/day**, so there
  is plenty of headroom to add more addresses (~40 before quota becomes a concern).
- The key is sent as a `Key:` **header** via an n8n `httpHeaderAuth` credential named
  `AbuseIPDB API Key`, restricted to the `api.abuseipdb.com` domain so it cannot leak to
  another host. Header name `Key` and the allowed-domain restriction are both load-bearing:
  see README → *Create the n8n credential*.

## Why the recap is date-stamped rather than hour-matched

n8n's Schedule Trigger does **not** backfill a missed tick. Keyed on "the hour is exactly
16", an instance that happened to be down or restarting at 16:00 would simply skip that
day's recap — and since the recap exists precisely so that silence can be read as "checked
and clean", a skipped one makes silence ambiguous again.

So the rule is **"`DIGEST_HOUR` or later, and today's recap has not gone out yet"**. The
date of the last recap lives in the `last_digest_on` column, written to every row each run
and read back as the newest value. Normally it fires at 16:00; after an outage it catches
up on the next run.

The trade-off: `Save State` runs on its own branch from `Analyze`, so a Slack post that
fails all three retries still leaves the day stamped as reported. That is deliberate —
coupling state-keeping to Slack availability would risk re-reporting findings that were
already sent.

## Noise control

- Transient failures are silent. Slack is told only when a check has failed **3 times in a
  row** (`FAIL_ALERT_AFTER`), and then at most **once a day** thereafter
  (`FAIL_RENAG_EVERY = 24`) rather than every hour.
- Report bullets are capped at `MAX_BULLETS = 8` per address, with an "…and N more" line.
- Reporter comments are attacker-influenced free text. They are **Slack-escaped**
  (`&`, `<`, `>`), flattened to one line and clipped to 160 chars before rendering, so a
  comment cannot inject a fake link or mention into the channel. This is required, not
  cosmetic.

## Secrets — how they're kept out of the repo

- **n8n stores credentials encrypted in its own database.** The AbuseIPDB key exists only
  as an n8n credential; the exported workflow references it by name, with a blank id.
- **`.env` (gitignored) is the single source of truth** for rebuilding instance state.
  **`.env.template`** is committed and documents every key with placeholder values.
- The committed `workflows/abuse-report-watcher.json` carries `<<SLACK_WEBHOOK_URL>>`,
  `<<DATATABLE_ID>>` and `<<MANUAL_WEBHOOK_PATH>>`. `tools/build-deploy.sh` renders them
  from `.env` into the gitignored `deploy.workflow.json`; a raw re-export goes there too,
  never over the committed copy.
- Before saving over the committed copy, grep it for `hooks.slack.com`, the real webhook
  path and the Data Table id; all must come back empty.
- **Deployment facts never enter a committed file.** Real addresses, workflow and
  credential ids, execution numbers and findings live in `.env` and on the instance —
  `STATE.md` tracks the state of the *technology*, not of any one deployment.

## Testing

`tools/test-analyze.js` is a dependency-free Node harness for the `Analyze` node — the only
node with non-trivial logic. It pulls the code out of `workflows/abuse-report-watcher.json`
rather than keeping its own copy, so it always tests what is committed:

```bash
node tools/test-analyze.js
```

Fixtures use RFC 5737 documentation addresses. Workflow *wiring* is verified on the
instance instead, since merge alignment, `executeOnce` and Data Table upsert semantics are
n8n runtime behaviour, not JavaScript.

## n8n API gotchas (when editing via the MCP tools)

- The public API **PUT rejects unknown `settings` keys**, including `errorWorkflow`, so
  linking an error workflow is UI-only.
- Activate / deactivate via `POST /workflows/{id}/activate|deactivate`.
- `Get State` with an empty `filters` object returns every row (n8n's `executeSelectMany`
  only rejects an empty filter for operations that require one, and `get` does not). It
  also needs `executeOnce: true`, otherwise it re-reads the table once per address.
- Switching the HTTP node to `continueErrorOutput` would desynchronise
  `combineByPosition` — leave it on `continueRegularOutput`.
- At 24 runs/day with full `verbose` payloads, execution history grows fast; consider
  `saveDataSuccessExecution: 'none'` once a deployment is known good.

## Conventions

- Keep project docs together in `CLAUDE/`.
- `STATE.md` is the living status doc — read it first to resume work, and update it when a
  capability, a verification or a known gap changes. Keep it deployment-neutral.
- After editing a Code node in the n8n UI, re-export to
  `workflows/abuse-report-watcher.json` with placeholders re-applied, **then** run
  `node tools/test-analyze.js`.
- Export the live workflow after each meaningful change; never commit a raw export.
- Trunk-based: commit to the default branch, and only when asked.
