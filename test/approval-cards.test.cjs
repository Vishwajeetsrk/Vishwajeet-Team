/**
 * PRD-2 — inline approval cards.
 * The cards decide through the SAME `approvals:*` IPC the desk uses (main-side
 * user-pinned actor). Contract: no new decision surface, no actor spoofing, no
 * policy/emergency writes from the composer, held read-only items excluded,
 * wired into the composer, and all three locales carry the key set.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('ApprovalCards decides only through the existing approvals:* IPC', () => {
  const src = read('src/renderer/src/components/ApprovalCards.tsx');
  assert.ok(src.includes('window.cth.approvalsList'), 'reads the desk queue');
  assert.ok(src.includes('window.cth.approvalsApprove'), 'approve path');
  assert.ok(src.includes('window.cth.approvalsDeny'), 'deny path');
  assert.ok(src.includes('window.cth.onSecurityUpdated'), 'live ring subscription');
  // No new decision channel, no policy/emergency/secret writes, no actor arg.
  for (const bad of ['approvalsDecide', 'securityEmergency', 'policySet',
    'securityAutoApproveInternal', 'decidedBy', "actor: '"]) {
    assert.ok(!src.includes(bad), `must not use ${bad}`);
  }
});

test('held read-only items never get inline buttons', () => {
  const src = read('src/renderer/src/components/ApprovalCards.tsx');
  assert.ok(src.includes('!i.readOnly'), 'mine filter drops readOnly');
  assert.ok(src.includes('!i.readOnly') && src.includes('i.actor !== agentId'),
    'otherCount also drops readOnly');
  // Guard: nothing decidable → render nothing.
  assert.ok(/mine\.length === 0 && otherCount === 0\) return null/.test(src),
    'empty-and-nothing-to-link renders nothing');
});

test('composer mounts the cards with the agent id, and only there', () => {
  const composer = read('src/renderer/src/components/MessageQueueComposer.tsx');
  assert.ok(composer.includes("import { ApprovalCards } from './ApprovalCards'"));
  assert.ok(composer.includes('<ApprovalCards agentId={agent.id} />'),
    'cards are per-agent, keyed to the composer agent');
  for (const other of ['AgentDetailPanel.tsx', 'FullscreenTerminal.tsx', 'CommandCenterPanel.tsx']) {
    const s = read(`src/renderer/src/components/${other}`);
    assert.ok(!s.includes('<ApprovalCards'), `${other} must not double-mount`);
  }
});

test('the desk link switches tabs only to real CCTab keys', () => {
  const ccp = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(ccp.includes("window.addEventListener('cth:cc-tab'"), 'listener exists');
  assert.ok(ccp.includes('TABS.some((def) => def.key === want)'),
    'unknown tab names are rejected before setTab');
  const cards = read('src/renderer/src/components/ApprovalCards.tsx');
  assert.ok(cards.includes("new CustomEvent('cth:cc-tab', { detail: { tab: 'security' } })"));
});

test('all three locales carry the approvalCards key set', () => {
  const base = JSON.parse(read('src/renderer/src/i18n/locales/en.json')).approvalCards;
  assert.ok(base, 'en.approvalCards exists');
  const keys = Object.keys(base).sort();
  for (const loc of ['ar', 'zh-CN']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    assert.deepEqual(Object.keys(json.approvalCards ?? {}).sort(), keys, `${loc} keys`);
    for (const [k, v] of Object.entries(base)) {
      // Parameterized keys must keep their placeholders across locales.
      const params = (String(v).match(/\{\{\w+\}\}/g) ?? []).sort();
      const other = (String(json.approvalCards[k]).match(/\{\{\w+\}\}/g) ?? []).sort();
      assert.deepEqual(other, params, `${loc}.${k} placeholders`);
    }
  }
});
