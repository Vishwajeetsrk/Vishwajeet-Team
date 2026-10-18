'use strict';

/**
 * Phase 6 — the PURE action-policy evaluator (design §3 catalog table,
 * §4/§6 precedence, §5 autoMode gate, §9 "action-policy").
 *
 * REAL vs MOCK:
 * - REAL: `evaluatePolicy`, `isExternalRequest` and `autoApproveEnv` loaded
 *   from src/shared/actionPolicy.ts through the house TS harness — the exact
 *   function `PolicyService.checkAgentTool` / `checkAsync` call at runtime.
 *   The module is pure (no electron, no fs, no config import), so requests and
 *   contexts are plain literals; `security-bypass.test.cjs` greps that purity.
 * - MOCK: none.
 *
 * What this file proves: the precedence order is
 *   user actor > emergency STOP > emergency externalDisabled > user override >
 *   catalog > unknown fail-safe, that overrides can never defeat an emergency,
 *   and that every unknown agent action resolves to require-approval (fail
 *   closed, never fail open).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { evaluatePolicy, isExternalRequest, autoApproveEnv } = loadTs('src/shared/actionPolicy.ts');

const AGENT = { kind: 'agent', agentId: 'agent-1' };
const USER = { kind: 'user' };
const OFF = { stopped: false, paused: false, externalDisabled: false };
const STOPPED = { stopped: true, paused: false, externalDisabled: false };
const EXT_OFF = { stopped: false, paused: false, externalDisabled: true };

/** evaluate with an emergency state and optional user overrides. */
function ev(req, emergency = OFF, overrides) {
  return evaluatePolicy(req, { emergency, ...(overrides ? { overrides } : {}) });
}
const hive = (action, actor = AGENT, extra = {}) => ({ domain: 'hive-tool', action, actor, ...extra });
const comp = (action, actor = AGENT) => ({ domain: 'computer-op', action, actor });

test('user actor is ALWAYS allowed — even under STOP, externalDisabled and a deny override', () => {
  const stopped = { stopped: true, paused: true, externalDisabled: true };
  const denyAll = {
    'hive-tool:*': 'deny', 'computer-op:*': 'deny', 'memory-write:*': 'deny', 'system:*': 'deny'
  };
  const r = ev(hive('Bash', USER), stopped, denyAll);
  assert.equal(r.decision, 'allow');
  assert.equal(r.ruleId, 'actor:user');

  // Emergency binds agents, never the operator — on every domain.
  assert.equal(ev({ domain: 'system', action: 'emergency-off', actor: USER }, stopped, denyAll).decision, 'allow');
  assert.equal(ev({ domain: 'integration-outbound', action: 'slack.postMessage', actor: USER }, stopped).decision, 'allow');
  assert.equal(ev(comp('dispose', USER), stopped, denyAll).decision, 'allow');
});

test('emergency STOP denies an agent even when a user override says allow', () => {
  // Exact-key override …
  const r1 = ev(hive('Read'), STOPPED, { 'hive-tool:Read': 'allow' });
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.ruleId, 'emergency:stopped');
  // … and the wildcard override. Overrides never reach the top of the stack.
  const r2 = ev(hive('Read'), STOPPED, { 'hive-tool:*': 'allow' });
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.ruleId, 'emergency:stopped');
  // A deny-everything override is not needed for STOP to bite either.
  assert.equal(ev(hive('Bash'), STOPPED).decision, 'deny');
  assert.match(ev(hive('Bash'), STOPPED).reason, /Emergency STOP/);
  // … while a non-stopped agent keeps the catalog verdict.
  assert.equal(ev(hive('Read')).decision, 'allow');
});

test('externalDisabled denies integration-outbound AND external-capable hive tools, but not local reads', () => {
  // integration-outbound is external by definition.
  const out = ev({ domain: 'integration-outbound', action: 'slack.postMessage', actor: AGENT }, EXT_OFF);
  assert.equal(out.decision, 'deny');
  assert.equal(out.ruleId, 'emergency:externalDisabled');

  // WebFetch is external by NAME (EXTERNALISH matches /web/ …).
  const web = ev(hive('WebFetch'), EXT_OFF);
  assert.equal(web.decision, 'deny');
  assert.equal(web.ruleId, 'emergency:externalDisabled');

  // A local read is untouched by the external gate …
  const read = ev(hive('Read'), EXT_OFF);
  assert.equal(read.decision, 'allow');
  assert.equal(read.ruleId, 'catalog:hive-safe');
  // … and Bash (not external by name) still lands on its catalog verdict
  // rather than being denied by the external flag.
  const bash = ev(hive('Bash'), EXT_OFF);
  assert.equal(bash.decision, 'require-approval');
  assert.equal(bash.ruleId, 'catalog:hive-bash');
});

test('user overrides beat the catalog in both directions — and never an emergency', () => {
  // Tighten a safe tool to require-approval.
  const tighten = ev(hive('Read'), OFF, { 'hive-tool:Read': 'require-approval' });
  assert.equal(tighten.decision, 'require-approval');
  assert.equal(tighten.ruleId, 'override:hive-tool:Read');

  // Deny a tool the catalog would send to the desk.
  const deny = ev(hive('Bash'), OFF, { 'hive-tool:Bash': 'deny' });
  assert.equal(deny.decision, 'deny');
  assert.equal(deny.ruleId, 'override:hive-tool:Bash');

  // Allow a tool the catalog gates.
  const allow = ev(hive('Bash'), OFF, { 'hive-tool:Bash': 'allow' });
  assert.equal(allow.decision, 'allow');
  assert.equal(allow.ruleId, 'override:hive-tool:Bash');

  // Wildcard overrides apply too (the ruleId still names the concrete key).
  const star = ev(hive('Edit'), OFF, { 'hive-tool:*': 'deny' });
  assert.equal(star.decision, 'deny');
  assert.equal(star.ruleId, 'override:hive-tool:Edit');

  // The exact key wins over the wildcard.
  const both = ev(hive('Bash'), OFF, { 'hive-tool:*': 'deny', 'hive-tool:Bash': 'allow' });
  assert.equal(both.decision, 'allow');

  // NEVER over an emergency: STOP still denies an `allow` override …
  const stop = ev(hive('Bash'), STOPPED, { 'hive-tool:Bash': 'allow' });
  assert.equal(stop.decision, 'deny');
  assert.equal(stop.ruleId, 'emergency:stopped');
  // … and externalDisabled still denies an `allow` override on an external tool.
  const ext = ev(hive('WebFetch'), EXT_OFF, { 'hive-tool:WebFetch': 'allow' });
  assert.equal(ext.decision, 'deny');
  assert.equal(ext.ruleId, 'emergency:externalDisabled');
  const out = ev({ domain: 'integration-outbound', action: 'mail.send', actor: AGENT }, EXT_OFF,
    { 'integration-outbound:*': 'allow' });
  assert.equal(out.decision, 'deny');
  assert.equal(out.ruleId, 'emergency:externalDisabled');
});

test('unknown agent tools fail SAFE to require-approval (never allow)', () => {
  for (const action of ['DoMagic', 'ListDir', 'RunTool', 'XeployToProd']) {
    const r = ev(hive(action));
    assert.equal(r.decision, 'require-approval', `unknown tool ${action} must not be allowed`);
    assert.equal(r.ruleId, 'catalog:hive-unknown');
  }
  // A zero-override context never silently grants: even an empty-string action.
  assert.notEqual(ev(hive('')).decision, 'allow');
});

test('catalog: hive-tool matrix', () => {
  const cases = [
    ['Read', 'allow', 'catalog:hive-safe'],
    ['Grep', 'allow', 'catalog:hive-safe'],
    ['TodoWrite', 'allow', 'catalog:hive-safe'],
    ['Edit', 'allow', 'catalog:hive-mutating'],
    ['Write', 'allow', 'catalog:hive-mutating'],
    ['NotebookEdit', 'allow', 'catalog:hive-mutating'],
    ['Bash', 'require-approval', 'catalog:hive-bash'],
    ['WebFetch', 'require-approval', 'catalog:hive-external'],
    ['WebSearch', 'require-approval', 'catalog:hive-external'],
    ['SlackSend', 'require-approval', 'catalog:hive-external'],
    ['DoMagic', 'require-approval', 'catalog:hive-unknown'],
  ];
  for (const [action, decision, ruleId] of cases) {
    const r = ev(hive(action));
    assert.equal(r.decision, decision, `hive-tool ${action}`);
    assert.equal(r.ruleId, ruleId, `hive-tool ${action} rule`);
    // Catalog verdicts carry the agent id for the audit trail.
    assert.match(r.reason, /agent agent-1/);
  }
});

test('catalog: computer-op (inspection free, lifecycle/sensitive gated) + memory-write + system', () => {
  // Read-only inspection ops are allowed …
  for (const action of ['get', 'list', 'status', 'captureScreen', 'workspaceInfo']) {
    const r = ev(comp(action));
    assert.equal(r.decision, 'allow', `computer-op ${action}`);
    assert.equal(r.ruleId, 'computer:readonly');
  }
  // … lifecycle and sensitive ops need a human …
  for (const action of ['start', 'stop', 'dispose', 'permissions', 'takeControl', 'navigate']) {
    const r = ev(comp(action));
    assert.equal(r.decision, 'require-approval', `computer-op ${action}`);
    assert.equal(r.ruleId, 'computer:sensitive');
  }
  // … and an unknown computer op fails safe.
  const unknown = ev(comp('hover'));
  assert.equal(unknown.decision, 'require-approval');
  assert.equal(unknown.ruleId, 'computer:unknown');

  // memory-write is internal (the Phase 5 service ACL is the enforcement).
  const mem = ev({ domain: 'memory-write', action: 'write', actor: AGENT });
  assert.equal(mem.decision, 'allow');
  assert.equal(mem.ruleId, 'catalog:memory');

  // system is user-only: denied for agents, whatever the action.
  const sys = ev({ domain: 'system', action: 'emergency-off', actor: AGENT });
  assert.equal(sys.decision, 'deny');
  assert.equal(sys.ruleId, 'catalog:system-agent');
});

test('isExternalRequest: declared flag, integration domain, and external-ish hive names only', () => {
  // Caller-declared external effect (the broker sets it on every outbound).
  assert.equal(isExternalRequest(hive('Read', AGENT, { external: true })), true);
  // integration-outbound is external by definition, no flag needed.
  assert.equal(isExternalRequest({ domain: 'integration-outbound', action: 'x', actor: AGENT }), true);
  // hive tools are external only when their NAME matches the EXTERNALISH battery.
  assert.equal(isExternalRequest(hive('WebFetch')), true);
  assert.equal(isExternalRequest(hive('githubPush')), true);
  assert.equal(isExternalRequest(hive('Read')), false);
  assert.equal(isExternalRequest(hive('Bash')), false);
  // The name battery does NOT leak onto other domains: a computer op called
  // `navigate` and a memory write are local unless declared external.
  assert.equal(isExternalRequest(comp('navigate')), false);
  assert.equal(isExternalRequest(comp('openBrowser', AGENT)), false);
  assert.equal(isExternalRequest({ domain: 'memory-write', action: 'write', actor: AGENT }), false);
});

test('autoApproveEnv truth table — autoMode alone NEVER arms the shim', () => {
  assert.equal(autoApproveEnv(true, true), true, 'autoMode + explicit opt-in arms');
  assert.equal(autoApproveEnv(true, false), false, 'autoMode alone does not arm');
  assert.equal(autoApproveEnv(true, undefined), false, 'missing flag fails closed');
  assert.equal(autoApproveEnv(false, true), false, 'flag without autoMode does not arm');
  assert.equal(autoApproveEnv(false, false), false);
  assert.equal(autoApproveEnv(false, undefined), false);
  // Strict `=== true` on the flag: truthy non-booleans are refused too.
  assert.equal(autoApproveEnv(true, 1), false);
  assert.equal(autoApproveEnv(true, 'true'), false);
});
