/**
 * PRD-8 — agent files & hire-desk templates.
 * Gates: the shared catalog is exactly 36 valid role templates in 6 families
 * of 6 (the 5 legacy briefings keep their existing locale keys); the identity
 * file gains a limits section at spawn (office/per-agent session caps, the
 * period budget layer, temp allowance, god ceilings, and — for everyone — the
 * durable-state pointer that also mentions handoff.md); provenance rides the
 * spawn into the registry (source + templateId).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => require('node:fs').readFileSync(path.join(root, p), 'utf8');
const templates = loadTs('src/shared/agentTemplates.ts');
const files = loadTs('src/shared/agentFiles.ts');

const FAMILY_SIZE = 6;
const LEGACY_KEYS = [
  'addAgent.templatesHint.repoJanitor.label',
  'addAgent.templatesHint.docsWriter.label',
  'addAgent.templatesHint.bugTriager.label',
  'addAgent.templatesHint.researchAssistant.label',
  'addAgent.templatesHint.releaseManager.label'
];

test('the catalog holds exactly 36 templates, 6 per family, each fully formed', () => {
  assert.equal(templates.AGENT_TEMPLATES.length, 36);
  const families = new Set(templates.AGENT_TEMPLATES.map((t) => t.family));
  assert.equal(families.size, 6);
  for (const fam of templates.TEMPLATE_FAMILIES) {
    assert.equal(templates.templatesOfFamily(fam.id).length, FAMILY_SIZE, fam.id);
  }
  const ids = new Set();
  for (const t of templates.AGENT_TEMPLATES) {
    assert.ok(!ids.has(t.id), 'unique id: ' + t.id);
    ids.add(t.id);
    assert.ok(t.labelKey && t.labelKey.endsWith('.label'));
    assert.ok(t.description.trim() && t.goal.trim() && t.goal.length > 40);
    assert.ok(
      ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley',
        'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'].includes(t.character),
      'cast character: ' + t.character
    );
  }
  // The original five pickers keep their locale keys — no churn in the locales.
  for (const key of LEGACY_KEYS) {
    assert.ok(templates.AGENT_TEMPLATES.some((t) => t.labelKey === key), key);
  }
  // New labels use the templateCatalog namespace (templates stays a string).
  assert.ok(templates.AGENT_TEMPLATES.every(
    (t) => t.labelKey.startsWith('addAgent.templatesHint.') || t.labelKey.startsWith('addAgent.templateCatalog.')
  ));
});

test('every catalog label resolves in all three locales', () => {
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const j = require(path.join(root, 'src/renderer/src/i18n/locales', loc + '.json'));
    assert.equal(Object.keys(j.addAgent.families).length, 6, loc + ': families');
    assert.equal(typeof j.addAgent.templates, 'string', loc + ': templates label stays a string');
    assert.ok(j.addAgent.templatesSearch, loc + ': search placeholder');
    for (const fam of templates.TEMPLATE_FAMILIES) {
      assert.ok(j.addAgent.families[fam.labelKey.split('.').pop()], fam.labelKey);
    }
    const labels = j.addAgent.templateCatalog;
    assert.equal(Object.keys(labels).length, 31, loc + ': new catalog labels');
    for (const t of templates.AGENT_TEMPLATES) {
      const id = t.id;
      const expected = t.labelKey.startsWith('addAgent.templatesHint.')
        ? j.addAgent.templatesHint[id].label
        : labels[id] && labels[id].label;
      assert.ok(expected && expected.trim().length >= 2, loc + ': ' + t.id);
    }
  }
});

test('identity.md gains a limits & durable-state section', () => {
  const full = files.identityLimitsBlock({
    officeTokenCap: 400_000,
    tokenCap: 150_000,
    officePeriodCaps: { '5h': 50_000 },
    periodCaps: { '5h': 50_000, day: 100_000 },
    tempAllowance: 2,
    maySpawnTemps: true,
    maxWorkers: 8
  }, false);
  assert.ok(full.includes('# #') === false);
  assert.ok(full.startsWith('\n## Limits & durable state'));
  assert.ok(full.includes('Session token cap (yours): 150,000'));
  assert.ok(full.includes('Period token caps (yours): 5h 50,000 / day 100,000 / week — / month —'));
  assert.ok(full.includes('Live temp allowance: up to 2 temps'));
  assert.ok(full.includes('handoff.md'));
  assert.ok(full.endsWith('\n'));
  // Zero means off: dashes win honestly (this agent simply has no budget).
  const empty = files.identityLimitsBlock({ officeTokenCap: 0 });
  assert.ok(empty.includes('—'));
  // god gets the office ceilings spelled out.
  const god = files.identityLimitsBlock({ maySpawnTemps: false, maxWorkers: 4 }, true);
  assert.ok(god.includes('4 live worker terminals'));
  assert.ok(god.includes('disabled for you'));
  // No snapshot at all → still points at durable state.
  assert.ok(files.identityLimitsBlock(undefined).includes('memory.md'));
});

test('wiring: spawn threads limits, provenance lands in the registry, modal ships the catalog', () => {
  // Main reads the live config once at spawn and passes the snapshot in.
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes('const spawnLimits: AgentLimitsSnapshot = {'));
  assert.ok(idx.includes('officeTokenCap: cfgSpawn.costCapTokens'));
  assert.ok(idx.includes('periodCaps: agentPeriodCaps'));
  assert.ok(idx.includes('tempAllowance: cfgSpawn.tempAllowances?.[spawnId]'));
  assert.ok(idx.includes('maySpawnTemps: cfgSpawn.orchestratorMaySpawn'));
  assert.ok(idx.includes('maySpawnTemps: cfgSpawn.orchestratorMaySpawn, maxWorkers: cfgSpawn.maxConcurrentWorkers'));
  // hive: meta fields + opt-in limits + both writers use identityText.
  const hive = read('src/main/hive.ts');
  assert.ok(hive.includes("source?: 'manual' | 'template' | 'hire' | 'worker'"));
  assert.ok(hive.includes('templateId?: string'));
  assert.ok(hive.includes('limits?: AgentLimitsSnapshot'));
  assert.equal(hive.match(/identityLimitsBlock/g).length, 2); // import + the one identityText call
  assert.ok(hive.includes('this.identityText(meta, opts.limits)'));
  // Modal: picker component + provenance into the spawn payload.
  const modal = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.ok(modal.includes("from '@shared/agentTemplates'"));
  assert.ok(modal.includes('function TemplatePicker('));
  assert.ok(modal.includes('setAppliedTemplateId(t.id)'));
  assert.ok(modal.includes("source: hireMeta ? 'hire' : appliedTemplateId ? 'template' : 'manual'"));
  assert.ok(modal.includes('templateId: appliedTemplateId ?? undefined'));
  // locale parity across the three files is asserted by the i18n test above;
  // here pin the shared module is import-free so any side can load it.
  assert.ok(!read('src/shared/agentTemplates.ts').includes('import '));
});
