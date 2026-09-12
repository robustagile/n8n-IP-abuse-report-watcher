# AbuseWatch — Project State

_Status of the workflow itself: what is built, what is proven, what is known to be missing.
Not a log of any particular deployment. See `README.md` for how to run it and `CLAUDE.md`
for the design decisions behind it._

## TL;DR

**Complete and in production use.** All of the reporting contract in
`CLAUDE/REQUIREMENTS.md` is implemented, the logic is covered by a test harness, and the
runtime behaviour has been verified by running the workflow on a live n8n instance against
the real AbuseIPDB API. There is no outstanding work required to make it function.

## Implementation status

| Capability | State |
|---|---|
| Hourly check of an arbitrary list of addresses | ✅ done — `Config.WATCHED` fan-out, one API call per address |
| Immediate Slack post on new reports, with category / country / comment | ✅ done |
| Silence on quiet runs | ✅ done — `Post Gate` emits zero items |
| Daily "all clean" recap, owed by date rather than fired on an exact hour | ✅ done — `last_digest_on` |
| Per-report diffing (`reportedAt\|reporterId` fingerprints) | ✅ done |
| Silent baseline on an address's first successful read | ✅ done |
| Failure handling that never corrupts good state | ✅ done — previous values carried forward |
| Failure alerting at 3 strikes, then daily | ✅ done — `FAIL_ALERT_AFTER` / `FAIL_RENAG_EVERY` |
| Escaping of attacker-influenced reporter comments | ✅ done |
| Non-verbose API response fallback (count diff) | ✅ done |
| On-demand trigger with `?force=1` | ✅ done — webhook node |
| Deployment tooling (Data Table creation, placeholder rendering) | ✅ done — `tools/*.sh` |
| Publishable repo: no secrets, no deployment coordinates | ✅ done — placeholders + gitignored `.env` |

## What is verified, and how

Logic — `node tools/test-analyze.js`, 31 assertions driving the real `Analyze` code
(read out of the workflow JSON) against fixture payloads shaped to the documented API
schema:

| | |
|---|---|
| ✅ Baseline on an empty state table | nothing flagged as new, fingerprints captured |
| ✅ A single new report among old ones | only the new one is listed, categories resolved |
| ✅ Quiet run | posts only when the daily recap is owed |
| ✅ API failure | `seen_keys` preserved, `fail_streak` incremented, silent at 1–2 |
| ✅ Third consecutive failure | alert raised; then the 24-run re-nag cadence |
| ✅ Failure followed by success | no re-report of the back catalogue |
| ✅ Non-verbose response | falls back to counting, says detail is unavailable |
| ✅ Slack escaping | `&`, `<`, `>` in a reporter comment neutralised |
| ✅ Daily recap catch-up | fixed-clock cases at 15:00 / 16:30 / 22:00 local, including a missed 16:00 tick |

Wiring — observed in live executions on an n8n instance, because merge alignment,
`executeOnce` and Data Table upsert semantics are n8n runtime behaviour rather than
JavaScript:

| | |
|---|---|
| ✅ `Config` fan-out produces one API call per address | item counts held at N throughout |
| ✅ `Merge Config + Response` keeps `ip`/`label` with the matching response | positional pairing correct for both addresses |
| ✅ `Get State` with no filter conditions returns all rows, once | not once per address |
| ✅ Upsert is keyed on `ip` | row ids stable across runs, no duplicates |
| ✅ Quiet run posts nothing | `Post Gate` emitted 0 items; `Post to Slack` never ran |
| ✅ Slack post path | 3-strike alert delivered, Slack returned `ok` |
| ✅ Error text is readable, not nested JSON | `401: Authentication failed. …` |
| ✅ A real AbuseIPDB `verbose` payload | parsed, baseline written, recap posted |

## Known gaps and accepted trade-offs

- **A failed Slack post still stamps the day as reported.** `Save State` runs on its own
  branch from `Analyze`, so if all three Slack retries fail, `last_digest_on` has already
  moved. Deliberate: coupling state-keeping to Slack availability would risk re-reporting
  findings that were already sent.
- **Data Table columns cannot be added after creation** through n8n's public API. A schema
  change means creating a new table and repointing the two Data Table nodes at it.
- **The manual trigger is authenticated only by an unguessable path.** Worst case for a
  leaked path is someone causing the workflow to check the addresses it already checks.
- **Execution history grows quickly** — 24 runs/day, each storing full `verbose` API
  payloads. `saveDataSuccessExecution: 'none'` is the fix once a deployment is known good;
  it ships as `'all'` so a first real payload can be inspected.
- **No backfill of a missed *check*.** Only the daily recap catches up; if the instance is
  down for an hour, reports that arrived and were superseded in that window are still
  caught (fingerprints are diffed against the full API window), but the Slack post for them
  arrives late rather than on the hour.
- **An error workflow cannot be linked through the public API** — the PUT rejects unknown
  `settings` keys including `errorWorkflow`. It has to be set in the n8n editor.

## Possible next steps

None of these are required; the workflow is complete as specified.

1. **Reduce `MAX_AGE_DAYS`** from 90 to 30 if a long history proves noisy, or raise
   `MAX_BULLETS` if a busy address gets truncated too often.
2. **A second notification channel** (email, Telegram) alongside Slack, for the failure
   alerts in particular — today a broken Slack webhook is a silent failure.
3. **Report enrichment**: resolve reporter country/ISP, or group bullets by category when
   a burst arrives.
4. **Act on a finding** — firewall rules, a delisting request — explicitly out of scope for
   v1, which is a read-only watch.
5. **Multi-channel routing**: post different labels to different Slack channels once the
   watched list grows beyond a handful of addresses.

## Version history

- **v1** — single workflow, 12 nodes: hourly check, per-report diffing, baseline, failure
  suppression, date-stamped daily recap, Data Table state, on-demand trigger.
  Public release: placeholdered workflow, deployment scripts, test harness, full docs.
