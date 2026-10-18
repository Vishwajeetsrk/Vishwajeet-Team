'use strict';

/**
 * Phase 6 — emergency suite (design §9 "emergency: flags, pauseAll→ControlRegistry
 * propagation, stop beats allow"; §6 semantics: stopped ⇒ PreToolUse denied +
 * broker refused + webhook inbound QUEUED but not processed; user unaffected).
 *
 * REAL vs MOCK:
 * - REAL: the shipped `evaluatePolicy` (pure evaluator) for the precedence facts,
 *   plus SOURCE text of the shipped src/main/index.ts for the wiring facts
 *   (webhook queueing, pause-all propagation, KV persistence) — the wiring lives
 *   in IPC handlers that need Electron, so the greps assert the shipped code.
 * - MOCK: none.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { evaluatePolicy, EMERGENCY_OFF } = loadTs('src/shared/actionPolicy.ts');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');

const STOPPED = { stopped: true, paused: false, externalDisabled: false };
const EXT_OFF = { stopped: false, paused: false, externalDisabled: true };
const OFF = { ...EMERGENCY_OFF };
const AGENT = { kind: 'agent', agentId: 'agent-1' };
const USER = { kind: 'user' };

test('stop beats allow: STOP denies every agent action even with an allow override', () => {
  const ctx = { emergency: STOPPED, overrides: { 'hive-tool:Read': 'allow', 'hive-tool:Bash': 'allow' } };
  for (const action of ['Read', 'Edit', 'Bash', 'WebFetch', 'TotallyUnknown']) {
    const r = evaluatePolicy({ domain: 'hive-tool', action, actor: AGENT }, ctx);
    assert.equal(r.decision, 'deny', `${action} must be denied under STOP`);
    assert.equal(r.ruleId, 'emergency:stopped');
  }
  // Computer + memory + integrations are agents too under STOP.
  assert.equal(evaluatePolicy({ domain: 'computer-op', action: 'get', actor: AGENT }, ctx).decision, 'deny');
  assert.equal(evaluatePolicy({ domain: 'integration-outbound', action: 'slack', actor: AGENT }, ctx).decision, 'deny');
  assert.equal(evaluatePolicy({ domain: 'memory-write', action: 'write', actor: AGENT }, ctx).decision, 'deny');
});

test('the operator is never bound: user actions pass even under STOP', () => {
  const r = evaluatePolicy({ domain: 'hive-tool', action: 'Bash', actor: USER }, { emergency: STOPPED });
  assert.equal(r.decision, 'allow');
  assert.equal(r.ruleId, 'actor:user');
});

test('externalDisabled denies externals regardless of override, internals stay catalog-decided', () => {
  const ctx = { emergency: EXT_OFF, overrides: { 'integration-outbound:slack': 'allow', 'hive-tool:WebFetch': 'allow' } };
  assert.equal(evaluatePolicy({ domain: 'integration-outbound', action: 'slack', actor: AGENT }, ctx).decision, 'deny');
  assert.equal(evaluatePolicy({ domain: 'hive-tool', action: 'WebFetch', actor: AGENT }, ctx).decision, 'deny');
  // A safe internal tool is NOT collateral of externalDisabled.
  const internal = evaluatePolicy({ domain: 'hive-tool', action: 'Read', actor: AGENT }, ctx);
  assert.equal(internal.decision, 'allow');
  // …and with STOP cleared the same override works again (flag is not sticky).
  assert.equal(evaluatePolicy({ domain: 'hive-tool', action: 'WebFetch', actor: AGENT }, { emergency: OFF, overrides: ctx.overrides }).decision, 'allow');
});

test('wiring: webhook inbound QUEUES on STOP (forced hold) — never dispatches', () => {
  const hold = MAIN.indexOf('const stoppedNow = emergencyFlags().stopped;');
  const dispatch = MAIN.indexOf('if (emergencyFlags().stopped) {');
  assert.ok(hold > 0, 'handleWebhookMessage must check emergency STOP');
  assert.ok(dispatch > 0, 'dispatchWebhookWork must refuse under STOP (release stays pending)');
  // The forced hold must route into the held-pending flow (the existing 202 path).
  const holdRegion = MAIN.slice(hold, hold + 900);
  assert.match(holdRegion, /stoppedNow \|\| !isAutoAllowed/, 'STOP forces the held-pending path');
  assert.match(holdRegion, /appendTriggerHistory\(\{ \.\.\.base, decision: 'pending' \}\)/, 'a pending history row is the queue');
  assert.match(holdRegion, /return \{ token, pending: true \}/, 'the caller still gets its 202-style token');
  assert.match(holdRegion, /emergency:stopped/, 'the hold is audited with ruleId emergency:stopped');
  // M3 grew this refusal block: it now ALSO records the refusal on the job
  // ledger (visible history) before returning false — window widened, intent
  // unchanged.
  const dispatchRegion = MAIN.slice(dispatch, dispatch + 1300);
  assert.match(dispatchRegion, /return false/, 'a refused dispatch returns false (entry stays pending)');
  assert.match(dispatchRegion, /emergency:stopped/, 'the refusal is audited');
  assert.match(dispatchRegion, /recordRefused/, 'the refusal is recorded on the job ledger (M3)');
});

test('wiring: pause-all drives ControlRegistry; clearing does NOT mass-resume', () => {
  const start = MAIN.indexOf("ipcMain.handle('security:emergency'");
  const end = MAIN.indexOf("ipcMain.handle('security:autoApproveInternal'");
  assert.ok(start > 0 && end > start, 'the emergency handler must exist');
  const region = MAIN.slice(start, end);

  assert.match(region, /for \(const id of Object\.keys\(hive\.registry\(\)\.agents\)\) control\.pause\(id, true\)/,
    'paused=true must pause EVERY registered agent');
  assert.match(region, /wasPaused && next\.paused === false/,
    'clearing pause is tracked…');
  assert.doesNotMatch(region, /control\.resume\(/,
    'clearing pause must NOT mass-resume — resume is per-agent, deliberate');
  // Flags persist through the service (KV), and the handler never trusts a renderer actor.
  assert.match(region, /policyService\.setEmergency\(next\)/, 'flags go through PolicyService (persisted + audited)');
});

test('wiring: flags persist to KV and the broker consults the same policy', () => {
  assert.match(MAIN, /EMERGENCY_KV_KEY = 'security\.emergency'/, 'emergency flags ride PersistStore KV');
  assert.match(MAIN, /persist\.setKv\(EMERGENCY_KV_KEY, f\)/, 'setEmergency path persists');
  // Broker outbound → checkAsync ⇒ emergency (stopped/externalDisabled) reaches it.
  const broker = MAIN.indexOf('authorizeOutbound:');
  assert.ok(broker > 0, 'the broker must carry the policy gate');
  const brokerRegion = MAIN.slice(broker, broker + 900);
  assert.match(brokerRegion, /policyService\.checkAsync\(/, 'broker decisions come from PolicyService');
  assert.match(brokerRegion, /approvalDesk\.consumeRetry\(/, 'one-shot desk approvals ride the broker too');
});
