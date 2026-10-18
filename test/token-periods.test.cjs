/**
 * PRD-5 — token limits per period (5h rolling / daily / weekly / monthly).
 * Gates: windows follow the machine's LOCAL clock (day = local midnight,
 * week = Monday 00:00, month = the 1st, 5h = rolling); only WORK tokens
 * (input+output+cache_creation) cross the ledger — cache reads never count;
 * the first ledger row per (agent, session) is a baseline and produces no
 * gain; a cumulative DECREASE re-baselines without crediting the dropped
 * tail; cold ledger (never folded) never trips the breaker; period caps are
 * additive on top of the legacy flat caps, which keep their exact behavior.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const shared = loadTs('src/shared/tokenPeriods.ts');
const ledgerMod = loadTs('src/main/tokenPeriods.ts');
const breakerMod = loadTs('src/main/breaker.ts');
const root = path.join(__dirname, '..');

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Build an epoch-ms from LOCAL clock parts. */
const local = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();

test('periodWindowStartMs follows the local clock', () => {
  const { periodWindowStartMs } = shared;
  // Wed 2026-10-14 15:00 local → day starts at that day's local midnight.
  const wed = local(2026, 9, 14, 15, 0);
  assert.equal(periodWindowStartMs('day', wed), local(2026, 9, 14, 0, 0));
  // Week starts MONDAY: Wed's week began Mon 2026-10-12 00:00.
  assert.equal(periodWindowStartMs('week', wed), local(2026, 9, 12, 0, 0));
  // Month starts the 1st at local midnight.
  assert.equal(periodWindowStartMs('month', wed), local(2026, 9, 1, 0, 0));
  // 5h is a ROLLING window: exactly now−5h.
  assert.equal(periodWindowStartMs('5h', wed), wed - 5 * HOUR_MS);
  // Monday 00:00 local: day and week windows begin at now itself.
  const monMid = local(2026, 9, 12, 0, 0);
  assert.equal(periodWindowStartMs('day', monMid), monMid);
  assert.equal(periodWindowStartMs('week', monMid), monMid);
  // Friday crossing a month boundary: Fri 2026-10-02 belongs to the week that
  // started Mon Sep 28, while the month window starts Oct 1.
  const fri = local(2026, 9, 2, 9, 0);
  assert.equal(periodWindowStartMs('week', fri), local(2026, 8, 28, 0, 0));
  assert.equal(periodWindowStartMs('month', fri), local(2026, 9, 1, 0, 0));
});

test('validatePeriodTokens accepts clears and positive ints, rejects everything else', () => {
  const { validatePeriodTokens } = shared;
  assert.equal(validatePeriodTokens(undefined), true);
  assert.equal(validatePeriodTokens(null), true);
  assert.equal(validatePeriodTokens(1000), true);
  assert.equal(validatePeriodTokens(10_000_000_000), true);
  assert.equal(validatePeriodTokens(0), false);
  assert.equal(validatePeriodTokens(-5), false);
  assert.equal(validatePeriodTokens(1.5), false);
  assert.equal(validatePeriodTokens(Number.NaN), false);
  assert.equal(validatePeriodTokens(10_000_000_001), false);
  assert.equal(validatePeriodTokens('1000'), false);
});

test('mergePeriodCap is a pure read-modify-write per target', () => {
  const { mergePeriodCap } = shared;
  // Office set → present; does not touch agents.
  let next = mergePeriodCap({}, 'office', 'day', 500);
  assert.deepEqual(next.office, { day: 500 });
  assert.equal(next.agents, undefined);
  // Original object untouched (pure).
  assert.equal(mergePeriodCap({}, 'office', 'day', 500) === next, false);
  // Per-agent set nested under its own id.
  next = mergePeriodCap(next, 'a1', '5h', 100);
  assert.deepEqual(next.agents, { a1: { '5h': 100 } });
  assert.deepEqual(next.office, { day: 500 });
  // Clearing the office day removes just that cell.
  next = mergePeriodCap(next, 'office', 'day', null);
  assert.deepEqual(next.office, {});
  // Clearing an agent's LAST period cell removes the agent row entirely.
  next = mergePeriodCap(next, 'a1', '5h', undefined);
  assert.deepEqual(next.agents, {});
});

test('TokenPeriodLedger folds cumulative rows: baseline, Δ, work-only tokens', () => {
  const { TokenPeriodLedger } = ledgerMod;
  const now = Date.now();
  const t0 = now - 60_000; // one minute ago — inside every window
  const row = (agent, sess, ts, input, output, cacheRead, cacheCreation) =>
    JSON.stringify({ agent_id: agent, session_id: sess, ts, input, output, cache_read: cacheRead, cache_creation: cacheCreation, model: 'm', usd: 0.01 });
  // Row 1 = baseline (no gain credited). Row 2 adds (input+output) work.
  // cache_read ONLY in row 2 must not count.
  const text = [
    row('a1', 's1', t0, 100, 50, 0, 10),
    row('a1', 's1', t0 + 20_000, 200, 100, 9999, 20)
  ].join('\n');
  const led = TokenPeriodLedger.fromText(text);
  // Baseline work = 160; second row cumulative = 320 (cache_read excluded) → Δ 160.
  assert.equal(led.usageIn('day', 'a1', now), 160);
  // Office sums all agents with any burn; a2 unknown → only a1 so far.
  assert.equal(led.usageIn('day', null, now), 160);
  assert.equal(led.usageIn('5h', 'a1', now), 160);
  assert.equal(led.usageIn('week', 'a1', now), 160);
  assert.equal(led.usageIn('month', 'a1', now), 160);
  assert.equal(led.usageIn('day', 'ghost', now), 0);
});

test('TokenPeriodLedger re-baselines on cumulative decrease without crediting the tail', () => {
  const { TokenPeriodLedger } = ledgerMod;
  const now = Date.now();
  const t0 = now - 60_000;
  const row = (agent, sess, ts, input, output, cacheRead, cacheCreation) =>
    JSON.stringify({ agent_id: agent, session_id: sess, ts, input, output, cache_read: cacheRead, cache_creation: cacheCreation, model: 'm', usd: 0.01 });
  // 160 baseline → +320 (gain 160) → reset to 0 (re-baseline, no credit) → 80 (gain 80).
  const text = [
    row('a1', 's1', t0, 100, 60, 0, 0),
    row('a1', 's1', t0 + 10_000, 200, 120, 1000, 0),
    row('a1', 's1', t0 + 20_000, 0, 0, 0, 0),
    row('a1', 's1', t0 + 30_000, 50, 30, 0, 0)
  ].join('\n');
  const led = TokenPeriodLedger.fromText(text);
  assert.equal(led.usageIn('day', 'a1', now), 240);
});

test('TokenPeriodLedger separates agents+sessions and drops out-of-window rows', () => {
  const { TokenPeriodLedger } = ledgerMod;
  const now = Date.now();
  const row = (agent, sess, ts, input, output, cacheRead, cacheCreation) =>
    JSON.stringify({ agent_id: agent, session_id: sess, ts, input, output, cache_read: cacheRead, cache_creation: cacheCreation, model: 'm', usd: 0.01 });
  const old = now - 40 * DAY_MS; // 40 days ago — outside every period window
  const text = [
    row('a1', 's1', old, 1000, 1000, 0, 0), // baseline (old) — cold
    row('a1', 's2', now - 60_000, 100, 50, 0, 0), // NEW session on same agent → own baseline
    row('a2', 's1', now - 125_000, 100, 0, 0, 0), // a2 baseline
    row('a2', 's1', now - 120_000, 170, 0, 0, 0) // a2 gain: 70 in-window
  ].join('\n');
  const led = TokenPeriodLedger.fromText(text);
  // a1's fresh session row is its own baseline → 0 credited for a1.
  assert.equal(led.usageIn('day', 'a1', now), 0);
  // a0-keyed baseline rows credit nothing; a2's second row adds Δ 70.
  assert.equal(led.usageIn('day', 'a2', now), 70);
  assert.equal(led.usageIn('day', null, now), 70);
  // Snapshot: only agents with EVER-credited burn appear in the map.
  const snap = led.snapshot(now);
  assert.equal(snap.ready, true);
  assert.deepEqual(Object.keys(snap.agents), ['a2']);
  assert.equal(snap.agents.a2.day, 70);
  assert.equal(snap.office.day, 70);
});

test('cold ledger never reports a number: callers must not treat no-data as zero', () => {
  const { TokenPeriodLedger } = ledgerMod;
  // No refresh ever called → never folded → usageIn must return null.
  const led = new TokenPeriodLedger(() => null);
  assert.equal(led.usageIn('day', 'a1', Date.now()), null);
  assert.equal(led.usageIn('day', null, Date.now()), null);
  const snap = led.snapshot(Date.now());
  assert.equal(snap.ready, false);
});

test('breaker: per-agent period caps trip, cold ledger fails open', () => {
  const { CircuitBreaker } = breakerMod;
  const cfg = { enabled: true, tokenPeriodCaps: { agents: { a1: { day: 500 } } } };
  // Warm ledger: a1 burned 600 work tokens today (over 500).
  const brk = new CircuitBreaker(() => cfg, (period, agentId) => {
    if (agentId === 'a1') return 600;
    return 0;
  });
  const mk = (id) => ({ agentId: id, sample: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, usd: 0 }, progressing: false });
  const [d1] = brk.tick([mk('a1')], Date.now());
  assert.deepEqual(d1.state.reason, `token limit (daily): 600 work tokens over the 500 cap in this period`);
  assert.notEqual(d1.state.level, 'healthy');
  assert.ok(d1.state.level !== null);
  // Same wiring, but the resolver reports NO data (cold) → no trip at all.
  const cold = new CircuitBreaker(() => cfg, () => null);
  const [c1] = cold.tick([mk('a1')], Date.now());
  assert.equal(c1.state.level, 'healthy');
  assert.equal(c1.state.reason, '');
});

test('breaker: office period cap trips only the window’s biggest spender', () => {
  const { CircuitBreaker } = breakerMod;
  const cfg = { enabled: true, tokenPeriodCaps: { office: { day: 1000 } } };
  const brk = new CircuitBreaker(() => cfg, (period, agentId) => {
    if (agentId === null) return 1500; // floor total over the office cap
    if (agentId === 'a1') return 1200; // biggest spender
    if (agentId === 'a2') return 300;
    return 0;
  });
  const mk = (id) => ({ agentId: id, sample: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, usd: 0 }, progressing: false });
  const decisions = brk.tick([mk('a1'), mk('a2')], Date.now());
  const a1 = decisions.find((d) => d.state.agentId === 'a1');
  const a2 = decisions.find((d) => d.state.agentId === 'a2');
  assert.deepEqual(a1.state.reason, 'token period cap (daily): floor total 1,500 over the 1,000 cap in this period');
  assert.notEqual(a1.state.level, 'healthy');
  // The blame is SINGLE: a2 just recovers (stays healthy), it is not tripped.
  assert.equal(a2.state.level, 'healthy');
});

test('legacy flat caps are untouched: same reasons, period layer only added', () => {
  const { CircuitBreaker } = breakerMod;
  const cfg = { enabled: true, agentTokenCaps: { a1: 5 } };
  const brk = new CircuitBreaker(() => cfg, () => null);
  const sample = { input: 3, output: 7, cacheRead: 100, cacheCreation: 0, usd: 0 };
  const [d] = brk.tick([{ agentId: 'a1', sample, progressing: false }], Date.now());
  // Work tokens (no cacheRead) = 10 > 5 → exact legacy reason text.
  assert.deepEqual(d.state.reason, 'token limit: 10 work tokens over the agent cap of 5 (110 total incl. cache reads)');
});

test('wiring: config setter, IPC channels, breaker arms, preload + Settings UI, locales', () => {
  const read = (p) => require('node:fs').readFileSync(path.join(root, p), 'utf8');
  // config.ts: atomic per-target setter; invalid values REFUSE the write.
  const cfg = read('src/main/config.ts');
  assert.ok(cfg.includes('setTokenPeriodCap('));
  assert.ok(cfg.includes("'invalid token period cap'"));
  assert.ok(cfg.includes('mergePeriodCap('));
  assert.ok(cfg.includes('tokenPeriodCaps?: TokenPeriodCapsCfg'));
  // index.ts: ledger born from the hive root ledger file, fed into the breaker,
  // folded on every fleet beat + once at boot, and exposed over IPC.
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes('new TokenPeriodLedger('));
  assert.ok(idx.includes("'config:setTokenPeriodCap'"));
  assert.ok(idx.includes("'config:tokenPeriodUsage'"));
  assert.ok(idx.includes('tokenPeriodLedger.refreshFully()'));
  assert.ok(idx.includes('tokenPeriodLedger.refresh()'));
  // breaker.ts: office blame map + cold-ledger skip.
  const brk = read('src/main/breaker.ts');
  assert.ok(brk.includes('officeTrips'));
  assert.ok(brk.includes('tokenPeriodCaps'));
  assert.ok(brk.includes('if (used === null) continue;'));
  // preload: the two new methods exist and hit those channels.
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes("ipcRenderer.invoke('config:setTokenPeriodCap'"));
  assert.ok(pre.includes("ipcRenderer.invoke('config:tokenPeriodUsage')"));
  assert.ok(pre.includes('setTokenPeriodCap: ('));
  assert.ok(pre.includes('tokenPeriodUsage: ('));
  // Settings UI reads/writes both config field and usage snapshot.
  const ui = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(ui.includes('periodsTitle'));
  assert.ok(ui.includes('settings.autonomy.period.'));
  assert.ok(ui.includes('periodUsed'));
  assert.ok(ui.includes('window.cth.setTokenPeriodCap('));
  assert.ok(ui.includes('window.cth.tokenPeriodUsage('));
  const store = read('src/renderer/src/store/config.ts');
  assert.ok(store.includes('tokenPeriodCaps?:'));
  // Locales ×3: every periods key present, non-empty, and locale sets match.
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const j = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    const a = j.settings.autonomy;
    for (const k of ['periodsTitle', 'periodsDesc', 'periodsOffice', 'period.5h', 'period.day', 'period.week', 'period.month', 'periodUsed', 'periodCold', 'periodSaved', 'periodHint']) {
      assert.ok(typeof a[k] === 'string' && a[k].length > 0, `${loc} missing ${k}`);
    }
  }
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  const ar = JSON.parse(read('src/renderer/src/i18n/locales/ar.json'));
  const zh = JSON.parse(read('src/renderer/src/i18n/locales/zh-CN.json'));
  const keys = (j) => Object.keys(j.settings.autonomy).sort().join('|');
  assert.equal(keys(en), keys(ar));
  assert.equal(keys(en), keys(zh));
});
