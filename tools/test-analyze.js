// Exercises the "Analyze" Code node against fixture AbuseIPDB payloads.
// The logic is read straight out of the exported workflow, so this can never
// drift from what is deployed.  Run it with:  node tools/test-analyze.js
const fs = require('fs');
const path = require('path');

const WF = path.join(__dirname, '..', 'workflows', 'abuse-report-watcher.json');
const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
const analyze = wf.nodes.find((n) => n.name === 'Analyze');
if (!analyze) throw new Error('no "Analyze" node in ' + WF);
const src = analyze.parameters.jsCode;
const run = new Function('$input', src + '\n');
const mk = (arr) => ({ all: () => arr.map((json) => ({ json })), first: () => ({ json: arr[0] }) });

const cfg = (ip, label) => ({
  __kind: 'abusewatch_check', ip, label, maxAgeInDays: 90, forcePost: false,
  checkUrl: 'https://www.abuseipdb.com/check/' + ip,
});
const rep = (at, who, cats, comment) => ({
  reportedAt: at, reporterId: who, categories: cats, comment, reporterCountryCode: 'CN',
});

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
  if (!cond) { fails++; if (extra) console.log(extra); }
}

// ---- 1. First ever run: no state rows at all -> baseline, nothing flagged as new
console.log('\n== 1. baseline (empty state table) ==');
let out = run(mk([
  Object.assign(cfg('203.0.113.10', 'Home'), { data: { ipAddress: '203.0.113.10', abuseConfidenceScore: 0, totalReports: 0, reports: [] } }),
  Object.assign(cfg('198.51.100.25', 'Web server'), {
    data: { ipAddress: '198.51.100.25', abuseConfidenceScore: 31, totalReports: 2, lastReportedAt: '2026-09-10T10:00:00+00:00',
      reports: [rep('2026-09-10T10:00:00+00:00', 7, [18, 22], 'ssh brute force'), rep('2026-09-01T08:00:00+00:00', 9, [14], 'port scan')] },
  }),
  {}, // alwaysOutputData filler from an empty Data Table
]))[0].json;
console.log(out.text);
check('posts the baseline', out.shouldPost === true);
check('nothing reported as new', out.anyNew === false);
check('baseline flag set', out.anyBaseline === true);
check('seen_keys captured for the busy IP', JSON.parse(out.states[1].seen_keys).length === 2);
check('clean IP stores an empty (not blank) key set', out.states[0].seen_keys === '[]');

// ---- 2. Second run, one genuinely new report
console.log('\n== 2. one new report arrives ==');
const state = out.states;
out = run(mk([
  Object.assign(cfg('203.0.113.10', 'Home'), { data: { ipAddress: '203.0.113.10', abuseConfidenceScore: 0, totalReports: 0, reports: [] } }),
  Object.assign(cfg('198.51.100.25', 'Web server'), {
    data: { ipAddress: '198.51.100.25', abuseConfidenceScore: 44, totalReports: 3, lastReportedAt: '2026-09-12T09:30:00+00:00',
      reports: [rep('2026-09-12T09:30:00+00:00', 11, [21], 'POST /wp-login.php <script>x</script> & co'),
                rep('2026-09-10T10:00:00+00:00', 7, [18, 22], 'ssh brute force'),
                rep('2026-09-01T08:00:00+00:00', 9, [14], 'port scan')] },
  }),
  ...state,
]))[0].json;
console.log(out.text);
check('posts', out.shouldPost === true);
check('flags new', out.anyNew === true);
check('only the one new report is listed', (out.text.match(/^• /gm) || []).length === 1);
check('category names resolved', out.text.includes('Web App Attack'));
check('reporter comment is Slack-escaped', out.text.includes('&lt;script&gt;') && out.text.includes('&amp;'));
check('clean IP still reported as quiet', out.text.includes('no new reports'));

// ---- 3. Third run, nothing changed, not 4pm -> silent
console.log('\n== 3. quiet run ==');
const state2 = out.states;
const quiet = () => run(mk([
  Object.assign(cfg('203.0.113.10', 'Home'), { data: { ipAddress: '203.0.113.10', abuseConfidenceScore: 0, totalReports: 0, reports: [] } }),
  Object.assign(cfg('198.51.100.25', 'Web server'), {
    data: { ipAddress: '198.51.100.25', abuseConfidenceScore: 44, totalReports: 3, lastReportedAt: '2026-09-12T09:30:00+00:00',
      reports: [rep('2026-09-12T09:30:00+00:00', 11, [21], 'POST /wp-login.php'),
                rep('2026-09-10T10:00:00+00:00', 7, [18, 22], 'ssh brute force'),
                rep('2026-09-01T08:00:00+00:00', 9, [14], 'port scan')] },
  }),
  ...state2,
]))[0].json;
out = quiet();
console.log(out.text);
check('no new reports detected', out.anyNew === false);
check('posts only when the daily recap is owed', out.shouldPost === out.isDigest,
  '        shouldPost=' + out.shouldPost + ' isDigest=' + out.isDigest + ' localHour=' + out.localHour);
check('message reads as the all-clean recap', out.text.includes('all clean') && out.text.includes('4pm ET'));

// ---- 4. API failure must not destroy the stored baseline
console.log('\n== 4. API failure ==');
out = run(mk([
  Object.assign(cfg('203.0.113.10', 'Home'), { error: { message: '401 - Authentication failed' } }),
  Object.assign(cfg('198.51.100.25', 'Web server'), { error: 'ECONNRESET' }),
  ...state2,
]))[0].json;
check('seen_keys preserved through the failure', out.states[1].seen_keys === state2[1].seen_keys);
check('fail streak incremented to 1', out.states[0].fail_streak === 1);
check('single failure stays quiet outside 4pm', out.anyFailAlert === false);
const bumped = state2.map((s, i) => Object.assign({}, s, { fail_streak: 2, seen_keys: s.seen_keys }));
out = run(mk([
  Object.assign(cfg('203.0.113.10', 'Home'), { error: { message: '401 - Authentication failed' } }),
  Object.assign(cfg('198.51.100.25', 'Web server'), { error: 'ECONNRESET' }),
  ...bumped,
]))[0].json;
console.log(out.text);
check('third consecutive failure raises the alarm', out.anyFailAlert === true && out.shouldPost === true);

// ---- 5. verbose reports[] missing -> fall back to counting
console.log('\n== 5. non-verbose fallback ==');
out = run(mk([
  Object.assign(cfg('198.51.100.25', 'Web server'), { data: { ipAddress: '198.51.100.25', abuseConfidenceScore: 50, totalReports: 5 } }),
  Object.assign({}, state2[1], { total_reports: 3 }),
]))[0].json;
console.log(out.text);
check('counts the difference as new', out.anyNew === true && out.text.includes('2 new'));

// ---- 6. a state row whose seen_keys was never written (failure on the very first run)
console.log('\n== 6. first-ever run failed, then succeeds ==');
out = run(mk([
  Object.assign(cfg('203.0.113.77', 'New box'), {
    data: { ipAddress: '203.0.113.77', abuseConfidenceScore: 12, totalReports: 4, lastReportedAt: '2026-09-11T00:00:00+00:00',
      reports: [rep('2026-09-11T00:00:00+00:00', 1, [15], 'a'), rep('2026-09-10T00:00:00+00:00', 2, [15], 'b'),
                rep('2026-09-09T00:00:00+00:00', 3, [15], 'c'), rep('2026-09-08T00:00:00+00:00', 4, [15], 'd')] },
  }),
  { ip: '203.0.113.77', label: 'New box', seen_keys: '', fail_streak: 2, total_reports: 0, abuse_score: 0, last_reported_at: '' },
]))[0].json;
console.log(out.text);
check('treated as baseline, not 4 new reports', out.anyNew === false && out.anyBaseline === true);
check('fail streak reset after success', out.states[0].fail_streak === 0);


// ---- 7. a stuck failure must not drum on Slack every single hour
console.log('\n== 7. sustained failure re-nag cadence ==');
const alertedAt = [];
for (let streak = 0; streak < 60; streak++) {
  const r = run(mk([
    Object.assign(cfg('203.0.113.10', 'Home'), { error: 'ECONNRESET' }),
    { ip: '203.0.113.10', label: 'Home', seen_keys: '[]', fail_streak: streak, total_reports: 0, abuse_score: 0, last_reported_at: '' },
  ]))[0].json;
  if (r.anyFailAlert) alertedAt.push(streak + 1);
}
console.log('  alerts fire at consecutive-failure counts:', alertedAt.join(', '));
check('first alert on the 3rd failure', alertedAt[0] === 3);
check('then roughly daily, not hourly', alertedAt.length <= 4, '        got ' + alertedAt.length + ' alerts across 60 failures');


// ---- 8. the daily recap must survive a missed 16:00 tick
// Runs against a fixed clock so both branches are covered whatever time it is now.
console.log('\n== 8. daily recap catch-up (fixed clock) ==');
const TZ = 'America/New_York';
const at = (isoNow, rows) => {
  const Real = Date;
  function Fake(...a) { return a.length ? new Real(...a) : new Real(isoNow); }
  Fake.prototype = Real.prototype;
  Fake.now = () => new Real(isoNow).getTime();
  Fake.parse = Real.parse;
  Fake.UTC = Real.UTC;
  return new Function('$input', 'Date', src)(mk(rows), Fake)[0].json;
};
const etDate = (isoNow) => new Intl.DateTimeFormat('en-CA',
  { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoNow));
const quietRow = (digestOn) => ([
  Object.assign(cfg('203.0.113.10', 'Home'), { data: { ipAddress: '203.0.113.10', abuseConfidenceScore: 0, totalReports: 0, reports: [] } }),
  { ip: '203.0.113.10', label: 'Home', seen_keys: '[]', fail_streak: 0, total_reports: 0, abuse_score: 0, last_reported_at: '', last_digest_on: digestOn },
]);

// 2026-09-12 is EDT (UTC-4): 19:00Z = 15:00 ET, 20:30Z = 16:30 ET, 03:00Z = 23:00 ET prev day.
const BEFORE = '2026-09-12T19:00:00Z';   // 15:00 ET
const AFTER  = '2026-09-12T20:30:00Z';   // 16:30 ET - the "missed the 16:00 tick" case
const LATE   = '2026-09-13T02:00:00Z';   // 22:00 ET same ET day
const TODAY  = etDate(AFTER);

let r = at(BEFORE, quietRow('2026-01-01'));
check('15:00 ET, recap stale -> still silent', r.isDigest === false && r.shouldPost === false);
check('   and the stale date is carried forward, not stamped', r.states[0].last_digest_on === '2026-01-01');

r = at(AFTER, quietRow('2026-01-01'));
check('16:30 ET after a missed 16:00 tick -> recap is caught up', r.isDigest === true && r.shouldPost === true);
check('   and it stamps today so it will not repeat', r.states[0].last_digest_on === TODAY);
check('   and it reads as the all-clean recap', r.text.includes('all clean'));

r = at(LATE, quietRow(TODAY));
check('22:00 ET, recap already sent today -> silent', r.isDigest === false && r.shouldPost === false);

r = at(AFTER, quietRow(''));
check('never-sent recap posts on the first run past 4pm', r.isDigest === true);

// A brand new address still baselines rather than waiting for 4pm.
r = at(BEFORE, [Object.assign(cfg('203.0.113.90', 'New'), { data: { ipAddress: '203.0.113.90', abuseConfidenceScore: 0, totalReports: 0, reports: [] } })]);
check('baseline still posts outside the recap window', r.shouldPost === true && r.anyBaseline === true);

console.log(fails === 0 ? '\nALL CHECKS PASSED' : '\n' + fails + ' CHECK(S) FAILED');
process.exit(fails === 0 ? 0 : 1);
