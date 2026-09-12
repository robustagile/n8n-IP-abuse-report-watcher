# AbuseWatch — Requirements

## Goal

Know, without having to remember to look, whether any of your own public IP addresses has
started showing up in abuse reports on AbuseIPDB — and know it early enough to act.

The failure mode this exists to prevent: a machine behind one of your addresses is
compromised and starts attacking other people; strangers report it; your address collects a
reputation; and the first *you* hear of it is mail bouncing or a provider blocking you,
days later.

## Watched addresses

Configurable and extensible by design: a single `WATCHED` list of `{ ip, label }` at the
top of the `Config` Code node. Adding an address is one line; nothing else in the workflow
needs touching, and the schedule, the API calls, the state rows and the Slack rendering all
fan out from that list.

The committed workflow ships two RFC 5737 documentation addresses as examples
(`203.0.113.10` "Home", `198.51.100.25` "Web server"); a deployment replaces them with its
own. Only addresses you own or administer belong in the list — this is a self-watch, and
AbuseIPDB's terms govern the rest.

## Reporting contract

1. **Check hourly.**
2. **If new reports appeared since the previous check** — post to Slack immediately (one
   combined message through an incoming webhook, Slack `mrkdwn`), with each new report's
   category, reporter country and comment.
3. **If all clear** — do not post. Once a day is enough: from **16:00 local**, post
   `All clean`.
4. Quiet hours produce no Slack traffic at all.

## Derived requirements

These were not stated explicitly but follow from the contract, and are implemented:

- **"New" must mean new since last seen, not new today.** Reports are fingerprinted
  individually, so a message is never repeated and nothing is missed between runs.
- **Adding an address must not dump its history.** The first successful read of an address
  is a silent baseline.
- **Silence must be trustworthy.** If a check could not run, the daily recap must not claim
  "all clean" — and a persistently broken check must say so, without turning into an hourly
  alarm.
- **The daily recap must survive a missed tick.** n8n does not backfill a skipped schedule,
  so the recap is owed by date, not fired at an exact hour.
- **A failed check must not corrupt the "already seen" state**, or the next successful run
  would re-report everything.
- **Reporter comments are untrusted input** and must not be able to inject links or
  mentions into the Slack channel.
- **The repo must be publishable.** No secret and no deployment coordinate in any committed
  file.

## Out of scope

- Acting on a report (firewall rules, submitting a delisting request).
- Watching addresses that are not yours.
- Reporting attackers *to* AbuseIPDB — this is a read-only watch.
