/**
 * PRD-6 — temps for any agent (0..4 per-agent temp allowance).
 * Gates: an allowance is an integer in [0,4]; 0 (the default) declines every
 * agent-authored temp; an agent may hold no more than ITS OWN allowance of
 * live temps, though the office-wide maxConcurrentWorkers backstop is separate
 * and unchanged; agent-authored requests must name a REGISTERED agent in
 * `from`, and a declined request informs BOTH god and the requesting agent;
 * god-originated requests keep the exact legacy behavior (no from needed).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ta = loadTs('src/main/tempAllowance.ts');
const root = path.join(__dirname, '..');
const read = (p) => require('node:fs').readFileSync(path.join(root, p), 'utf8');

test('normalizeTempAllowance keeps only integers in [0,4]', () => {
  assert.equal(ta.normalizeTempAllowance(0), 0);
  assert.equal(ta.normalizeTempAllowance(1), 1);
  assert.equal(ta.normalizeTempAllowance(4), 4);
  assert.equal(ta.normalizeTempAllowance(-1), undefined);
  assert.equal(ta.normalizeTempAllowance(1.5), undefined);
  assert.equal(ta.normalizeTempAllowance(5), undefined);
  assert.equal(ta.normalizeTempAllowance('3'), undefined);
  assert.equal(ta.normalizeTempAllowance(Number.NaN), undefined);
  assert.equal(ta.normalizeTempAllowance(undefined), undefined);
});

test('canAgentSpawnTemp: 0 declines, full declines, spare admits', () => {
  // No allowance granted → the ONLY default is no.
  assert.deepEqual(
    ta.canAgentSpawnTemp({ holder: 'pam', allowance: 0, agentLiveTemps: 0 }).ok,
    false
  );
  const none = ta.canAgentSpawnTemp({ holder: 'pam', allowance: 0, agentLiveTemps: 0 });
  assert.ok(none.reason.includes('pam'));
  assert.ok(none.reason.includes('no temp allowance'));
  // At the cap → declined, and the reason names the count and the allowance.
  const full = ta.canAgentSpawnTemp({ holder: 'pam', allowance: 2, agentLiveTemps: 2 });
  assert.equal(full.ok, false);
  assert.ok(full.reason.includes('2 of 2 allowed temps'));
  // Room → admitted.
  assert.deepEqual(
    ta.canAgentSpawnTemp({ holder: 'pam', allowance: 4, agentLiveTemps: 3 }).ok,
    true
  );
});

test('config: atomic per-agent setter + persisted field', () => {
  const cfg = read('src/main/config.ts');
  assert.ok(cfg.includes('export function setAgentTempAllowance('));
  assert.ok(cfg.includes("'invalid temp allowance'"));
  assert.ok(cfg.includes('normalizeTempAllowance('));
  assert.ok(cfg.includes('tempAllowances?: Record<string, number>'));
});

test('wiring: gate sits on the shared queue, failures mail the agent, dispatch follows the hirer', () => {
  const idx = read('src/main/index.ts');
  // The gate uses the pure decision; unknown agents are refused; live temps
  // counted through the rec.from stamp.
  assert.ok(idx.includes('canAgentSpawnTemp({'));
  assert.ok(idx.includes('normalizeTempAllowance('));
  assert.ok(idx.includes("hive.registry().agents[requester]"));
  assert.ok(idx.includes('.filter((r) => r.from === requester)'));
  assert.ok(idx.includes('spawnedAt: Date.now(), tokenCap, from }'));
  // Dispatch + completion doctrine goes to whoever hired the temp.
  assert.ok(idx.includes('to ${from} with "act":"done"'));
  assert.ok(idx.includes("hive.send({ to: workerId, conversation: `worker-${reqId}`, act: 'request', subject: meta.name, body: `${prefix}${objective}${suffix}` }, from);"));
  // Declined requests reach their author, not just god.
  assert.ok(idx.includes("subject: `temp request declined (${reqId})`"));
  // IPC + preload expose the setter.
  assert.ok(idx.includes("'config:setAgentTempAllowance'"));
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes("ipcRenderer.invoke('config:setAgentTempAllowance'"));
  assert.ok(pre.includes('setAgentTempAllowance: ('));
  // God prompt documents the from field; the agent prompt documents the road.
  const hiveDoc = read('src/main/hive.ts');
  assert.ok(hiveDoc.includes('a registered agent id, which makes it THAT agent'));
  assert.ok(hiveDoc.includes('TEMP ALLOWANCE'));
  // UI: the per-agent stepper lives in the Command Center roster.
  const panel = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.ok(panel.includes('TempAllowanceEditor'));
  assert.ok(panel.includes('setAgentTempAllowance('));
  assert.ok(panel.includes('!a.isGod'));
  // Locales ×3 have the three keys, non-empty, across all locales.
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const j = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    for (const k of ['tempAllowanceTitle', 'tempAllowanceOn', 'tempAllowanceOff']) {
      assert.ok(typeof j.commandCenter[k] === 'string' && j.commandCenter[k].length > 0, `${loc} missing ${k}`);
    }
  }
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  const ar = JSON.parse(read('src/renderer/src/i18n/locales/ar.json'));
  const zh = JSON.parse(read('src/renderer/src/i18n/locales/zh-CN.json'));
  const keys = (j) => Object.keys(j.commandCenter).sort().join('|');
  assert.equal(keys(en), keys(ar));
  assert.equal(keys(en), keys(zh));
});
