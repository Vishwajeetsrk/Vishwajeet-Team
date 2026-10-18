'use strict';

/**
 * Phase 6 — PolicyService runtime binding (design §2 wiring, §4 hook
 * semantics: require-approval → immediate deny + desk item + one-shot retry
 * token; §5 gate; §9 "policy service").
 *
 * REAL vs MOCK:
 * - REAL: `PolicyService` + `ApprovalDesk` + `AuditStore` composed over temp
 *   directories on the real filesystem — the same three objects main/index.ts
 *   constructs at module load (index.ts:418-445). Every verdict, desk row and
 *   audit line below is produced by the shipped code.
 * - MOCK: none. Only the two injected seams the production wiring also
 *   injects: `overrides` / `emergency` / `persistEmergency` (stand-ins for
 *   `readConfig().security` and the PersistStore KV, exactly as index.ts
 *   passes them). No clock injection is needed — nothing here is timing-bound
 *   (token TTL lives in ApprovalDesk, covered by approvals-desk.test.cjs).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { PolicyService } = loadTs('src/main/policyService.ts');
const { ApprovalDesk } = loadTs('src/main/approvals.ts');
const { AuditStore } = loadTs('src/main/audit.ts');

const AGENT_ID = 'agent-1';
const AGENT = { kind: 'agent', agentId: AGENT_ID };
const OFF = { stopped: false, paused: false, externalDisabled: false };

function makeStack(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const audit = new AuditStore(() => dir);
  const desk = new ApprovalDesk(() => path.join(dir, 'approvals.json'));
  let emergency = { ...OFF };
  let overrides = {};
  const persisted = [];

  const svc = new PolicyService({
    overrides: () => overrides,
    emergency: () => ({ ...emergency }),
    persistEmergency: (flags) => { persisted.push(flags); emergency = { ...flags }; },
    desk,
    audit,
  });

  return {
    dir, audit, desk, svc, persisted,
    setOverrides: (o) => { overrides = o; },
    setEmergencyState: (e) => { emergency = { ...e }; },
  };
}

const decisions = (audit) => audit.query({ kind: 'policy-decision' });
const emergencies = (audit) => audit.query({ kind: 'emergency-changed' });

test('checkAgentTool: a safe tool is allowed and audited as a policy-decision', (t) => {
  const { audit, svc } = makeStack(t);

  const v = svc.checkAgentTool(AGENT_ID, 'Read');
  assert.equal(v.deny, false, 'Read is catalog-safe');
  assert.equal(v.reason, undefined);

  const rows = decisions(audit);
  assert.equal(rows.length, 1, 'one row recorded');
  const [row] = rows;
  assert.equal(row.actor, AGENT_ID, 'the agent, not the operator, is the audit actor');
  assert.equal(row.domain, 'hive-tool');
  assert.equal(row.action, 'Read');
  assert.equal(row.decision, 'allow');
  assert.equal(row.ruleId, 'catalog:hive-safe');
  assert.ok(row.at && row.detail, 'timestamped with the evaluator reason');
  assert.ok(!row.approvalId, 'an allow creates no approval reference');
});

test('checkAgentTool: a gated tool is denied with a pending desk item + approvalId in the reason', (t) => {
  const { audit, desk, svc } = makeStack(t);

  const v = svc.checkAgentTool(AGENT_ID, 'Bash');
  assert.equal(v.deny, true, 'require-approval at the hook is an immediate deny');
  assert.ok(v.approvalId, 'the verdict carries the desk item id');
  assert.ok(v.reason.includes(v.approvalId), 'the operator can find the item from the deny reason');
  assert.match(v.reason, /Approval Desk/);
  assert.match(v.reason, /operator approval/i);

  assert.equal(desk.pendingCount(), 1, 'exactly one pending item');
  const item = desk.get(v.approvalId);
  assert.equal(item.status, 'pending');
  assert.equal(item.domain, 'hive-tool');
  assert.equal(item.action, 'Bash');
  assert.equal(item.actor, AGENT_ID, 'desk rows name the agent as actor');
  assert.equal(item.ruleId, 'catalog:hive-bash');
  assert.equal(item.decidedBy, undefined, 'nobody has decided yet');

  const [row] = decisions(audit);
  assert.equal(row.decision, 'require-approval');
  assert.equal(row.ruleId, 'catalog:hive-bash');
  assert.equal(row.approvalId, v.approvalId, 'the audit row points at the same item');

  // Repeating the call before a decision dedupes onto the SAME pending item.
  const v2 = svc.checkAgentTool(AGENT_ID, 'Bash');
  assert.equal(v2.approvalId, v.approvalId, 'pending items dedupe');
  assert.equal(desk.pendingCount(), 1);
});

test('checkAgentTool: operator approval → retry-token allow once, then a NEW desk item', (t) => {
  const { audit, desk, svc } = makeStack(t);

  const first = svc.checkAgentTool(AGENT_ID, 'Bash');
  assert.equal(first.deny, true);
  assert.equal(desk.decide(first.approvalId, true, 'user').ok, true, 'user decision');
  assert.equal(desk.pendingCount(), 0, 'the decided item leaves the queue');

  // The agent's next identical call passes via the one-shot retry token …
  const retried = svc.checkAgentTool(AGENT_ID, 'Bash');
  assert.equal(retried.deny, false, 'approved call goes through');
  assert.equal(retried.approvalId, undefined, 'no new item on the covered call');
  const tokenRow = decisions(audit)[0];
  assert.equal(tokenRow.ruleId, 'retry-token', 'the allow is audited as a retry token');
  assert.equal(tokenRow.decision, 'allow');
  assert.equal(tokenRow.actor, AGENT_ID);
  assert.match(tokenRow.detail, /one-shot/);

  // … and the token is spent: the NEXT call is gated again with a fresh item.
  const third = svc.checkAgentTool(AGENT_ID, 'Bash');
  assert.equal(third.deny, true, 'tokens are single use');
  assert.notEqual(third.approvalId, first.approvalId, 'a brand-new desk item');
  assert.equal(desk.pendingCount(), 1);
  const newPending = desk.get(third.approvalId);
  assert.equal(newPending.status, 'pending');
  assert.equal(newPending.id !== first.approvalId, true);
  assert.equal(decisions(audit)[0].approvalId, third.approvalId);
  assert.equal(decisions(audit)[0].ruleId, 'catalog:hive-bash');
});

test('checkAsync: integration-outbound is require-approval with a held desk item', (t) => {
  const { audit, desk, svc } = makeStack(t);

  const v = svc.checkAsync(AGENT, 'integration-outbound', 'slack.postMessage', '#general');
  assert.equal(v.decision, 'require-approval');
  assert.equal(v.ruleId, 'catalog:integration');
  assert.ok(v.approvalId, 'async callers hold on a desk item');
  assert.match(v.reason, /outbound integration call/i);

  const item = desk.get(v.approvalId);
  assert.equal(item.status, 'pending');
  assert.equal(item.domain, 'integration-outbound');
  assert.equal(item.action, 'slack.postMessage');
  assert.equal(item.target, '#general', 'the target is carried for the desk UI');
  assert.equal(item.actor, AGENT_ID);
  assert.match(item.detail, /\(external effect\)/, 'outbound is tagged external in the desk detail');

  const [row] = decisions(audit);
  assert.equal(row.decision, 'require-approval');
  assert.equal(row.approvalId, v.approvalId);
  assert.equal(row.target, '#general');
});

test('checkAsync: integration-outbound FORCES external:true (externalDisabled denies it)', (t) => {
  const { audit, svc, setEmergencyState } = makeStack(t);
  setEmergencyState({ stopped: false, paused: false, externalDisabled: true });

  // The action NAME is not external-ish, yet the outbound domain is denied —
  // only possible because checkAsync declared external for integration-outbound.
  const outbound = svc.checkAsync(AGENT, 'integration-outbound', 'push');
  assert.equal(outbound.decision, 'deny');
  assert.equal(outbound.ruleId, 'emergency:externalDisabled');
  assert.equal(decisions(audit)[0].decision, 'deny');

  // The SAME action name through a non-external domain is untouched by the
  // external gate (it lands on the catalog instead) — proving the deny above
  // came from the forced external flag, not from the name.
  const local = svc.checkAsync(AGENT, 'hive-tool', 'push');
  assert.equal(local.decision, 'require-approval');
  assert.equal(local.ruleId, 'catalog:hive-unknown');
  assert.equal(local.approvalId !== undefined, true);

  // A local, internal write is allowed even with externals cut.
  const mem = svc.checkAsync(AGENT, 'memory-write', 'write');
  assert.equal(mem.decision, 'allow');
  assert.equal(mem.ruleId, 'catalog:memory');
});

test('setEmergency: persists through deps.persistEmergency and audits emergency-changed', (t) => {
  const { audit, svc, persisted } = makeStack(t);

  assert.deepEqual(svc.emergency(), OFF, 'flags start off');

  const next = svc.setEmergency({ stopped: true });
  assert.equal(persisted.length, 1, 'persistEmergency called once');
  assert.deepEqual(persisted[0], { stopped: true, paused: false, externalDisabled: false });
  assert.deepEqual(next, persisted[0], 'the returned flags are the persisted ones');
  assert.deepEqual(svc.emergency(), next, 'the emergency() seam sees the change');

  const emergRows = emergencies(audit);
  assert.equal(emergRows.length, 1, 'one emergency event recorded');
  const [row] = emergRows;
  assert.equal(row.kind, 'emergency-changed');
  assert.equal(row.actor, 'user', 'emergency changes are operator actions');
  assert.equal(row.decision, JSON.stringify(next), 'the new state is the audited decision');
  assert.match(row.detail, /^from \{/, 'the previous state is the audited detail');

  // STOP now binds agents …
  const v = svc.checkAgentTool(AGENT_ID, 'Read');
  assert.equal(v.deny, true, 'STOP beats the catalog allow');
  assert.match(v.reason, /Emergency STOP/);
  assert.equal(decisions(audit)[0].ruleId, 'emergency:stopped');

  // … and clearing it restores normal evaluation.
  const cleared = svc.setEmergency({ stopped: false });
  assert.deepEqual(cleared, OFF);
  assert.equal(persisted.length, 2, 'every change persists');
  assert.equal(svc.checkAgentTool(AGENT_ID, 'Read').deny, false, 'back to catalog');
  assert.equal(emergencies(audit).length, 2, 'both changes audited');
});

test('user overrides from deps.overrides are wired through the evaluator', (t) => {
  const { audit, desk, svc, setOverrides } = makeStack(t);

  // Tighten: Read is catalog-allow, the override forces a desk item.
  setOverrides({ 'hive-tool:Read': 'require-approval' });
  const held = svc.checkAgentTool(AGENT_ID, 'Read');
  assert.equal(held.deny, true);
  assert.match(held.reason, /override/i);
  assert.equal(decisions(audit)[0].ruleId, 'override:hive-tool:Read');
  assert.equal(desk.get(held.approvalId).ruleId, 'override:hive-tool:Read');

  // Relax: Bash is catalog-gated, the override allows it outright.
  setOverrides({ 'hive-tool:Read': 'require-approval', 'hive-tool:Bash': 'allow' });
  const allowed = svc.checkAgentTool(AGENT_ID, 'Bash');
  assert.equal(allowed.deny, false, 'a user override beats the catalog');
  assert.equal(decisions(audit)[0].ruleId, 'override:hive-tool:Bash');
  assert.equal(decisions(audit)[0].decision, 'allow');

  // Deny: the reason is the override's, not the held-for-approval text.
  setOverrides({ 'hive-tool:Read': 'deny' });
  const refused = svc.checkAgentTool(AGENT_ID, 'Read');
  assert.equal(refused.deny, true);
  assert.match(refused.reason, /override denies hive-tool:Read/);
  assert.ok(!refused.reason.includes('Approval Desk'), 'a deny is not a desk hold');

  // Clearing overrides (empty map) returns to the catalog defaults.
  setOverrides({});
  assert.equal(svc.checkAgentTool(AGENT_ID, 'Read').deny, false);
});

test('auditMemoryWrite: memory writes are audited (allow + audit), never desk-gated', (t) => {
  const { audit, desk, svc } = makeStack(t);
  const memoryRows = () => audit.query({ kind: 'memory-write' });

  svc.auditMemoryWrite(AGENT, true);
  svc.auditMemoryWrite({ kind: 'user' }, false, 'SECRET_DETECTED');

  const rows = memoryRows();
  assert.equal(rows.length, 2, 'one row per write path');
  const [rejected, stored] = rows; // newest-first
  assert.equal(stored.actor, AGENT_ID, 'agent writes carry the agent id');
  assert.equal(stored.decision, 'stored');
  assert.equal(rejected.actor, 'user');
  assert.equal(rejected.decision, 'rejected');
  assert.equal(rejected.ruleId, 'SECRET_DETECTED', 'the service ACL code rides as ruleId');

  // Audit-only: no desk items, no policy-decision rows from memory writes.
  assert.equal(desk.pendingCount(), 0, 'memory-write never queues an approval');
  assert.equal(decisions(audit).length, 0, 'auditMemoryWrite does not emit policy-decision rows');
});
