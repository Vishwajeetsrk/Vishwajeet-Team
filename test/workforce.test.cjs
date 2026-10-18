'use strict';

/**
 * M4 Workforce Catalog: specialist roles + capability-first selection.
 * Gate: a goal requiring a skill selects a matching CONFIGURED specialist;
 * an unconfigured profile is visibly inert, never selected.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const wf = loadTs('src/shared/workforce.ts');

function profile(overrides = {}) {
  return {
    id: 'p1', name: 'Pam-1', roleId: 'researcher',
    provider: 'claude', model: 'claude-sonnet-4-6',
    ...overrides
  };
}

function candidate(p, roleId, available = true) {
  const role = wf.roleById(roleId ?? p.roleId);
  assert.ok(role, 'role must exist in test setup');
  return { profile: p, role, available };
}

test('catalog contract: 8 roles, shaped, valid providers + known permissions', () => {
  const v = wf.validateWorkforceCatalog();
  assert.equal(v.ok, true, v.ok ? '' : v.error);
  assert.equal(wf.SPECIALIST_CATALOG.length, 8);
  for (const id of ['researcher', 'engineer', 'designer', 'qa', 'devops', 'content-seo', 'data-analyst', 'ops']) {
    const r = wf.roleById(id);
    assert.ok(r, `role ${id} missing`);
    assert.ok(r.responsibilities.length > 0 && r.skills.length > 0, `${id}: content`);
    assert.ok(['claude', 'antigravity', 'codex', 'cursor'].includes(r.defaultProvider), `${id}: provider`);
    for (const p of r.permissions) {
      assert.ok(wf.WORKFORCE_PERMISSION_IDS.includes(p), `${id}: unknown permission ${p}`);
    }
  }
});

test('configured = provider + model + known role; inert reason names the gap', () => {
  assert.equal(wf.isProfileConfigured(profile()), true);
  assert.equal(wf.isProfileConfigured(profile({ model: undefined })), false);
  assert.equal(wf.isProfileConfigured(profile({ provider: undefined })), false);
  assert.equal(wf.isProfileConfigured(profile({ roleId: 'nope' })), false);
  assert.match(wf.inertReason(profile({ model: undefined })), /no model/);
  assert.match(wf.inertReason(profile({ provider: undefined })), /no provider/);
  assert.equal(wf.inertReason(profile()), null);
  const inert = wf.inertProfiles([profile(), profile({ id: 'p2', model: undefined })]);
  assert.equal(inert.length, 1);
  assert.equal(inert[0].profile.id, 'p2');
});

test('gate: a skill requirement selects the matching configured specialist', () => {
  const cands = [
    candidate(profile({ id: 'eng', name: 'Eng', roleId: 'engineer' }), 'engineer'),
    candidate(profile({ id: 'res', name: 'Res', roleId: 'researcher' }), 'researcher')
  ];
  const sel = wf.selectSpecialistForTask(cands, { skills: ['fact-check'] });
  assert.ok(sel.selected, `nothing selected: ${sel.reason}`);
  assert.equal(sel.selected.profile.id, 'res');
  assert.match(sel.reason, /Researcher/);
});

test('capability beats idleness: busy capable outranks idle incapable', () => {
  const cands = [
    candidate(profile({ id: 'idle-eng', name: 'IdleEng', roleId: 'engineer' }), 'engineer', true),
    candidate(profile({ id: 'busy-qa', name: 'BusyQa', roleId: 'qa' }), 'qa', false)
  ];
  const sel = wf.selectSpecialistForTask(cands, { skills: ['reproduce-bug'] });
  assert.ok(sel.selected, `nothing selected: ${sel.reason}`);
  assert.equal(sel.selected.profile.id, 'busy-qa');
});

test('unconfigured profiles are never selected, even when they match', () => {
  const cands = [
    candidate(profile({ id: 'ghost', name: 'Ghost', roleId: 'researcher', model: undefined }), 'researcher'),
    candidate(profile({ id: 'eng', name: 'Eng', roleId: 'engineer' }), 'engineer')
  ];
  // The only fact-checker is inert, and the configured engineer has no such
  // skill — so the answer is null (no false match), never the ghost.
  const sel = wf.selectSpecialistForTask(cands, { skills: ['fact-check'] });
  assert.equal(sel.selected, null);
  assert.match(sel.reason, /No specialist matches/);
  // …but configure the ghost and it wins on capability.
  const cands2 = [
    candidate(profile({ id: 'ghost', name: 'Ghost', roleId: 'researcher', model: 'claude-sonnet-4-6' }), 'researcher'),
    candidate(profile({ id: 'eng', name: 'Eng', roleId: 'engineer' }), 'engineer')
  ];
  const sel2 = wf.selectSpecialistForTask(cands2, { skills: ['fact-check'] });
  assert.ok(sel2.selected, `nothing selected: ${sel2.reason}`);
  assert.equal(sel2.selected.profile.id, 'ghost');
});

test('no configured specialist: reason says so (configure vs broaden)', () => {
  const sel = wf.selectSpecialistForTask(
    [candidate(profile({ id: 'g', roleId: 'researcher', model: undefined }), 'researcher')],
    { skills: ['fact-check'] }
  );
  assert.equal(sel.selected, null);
  assert.match(sel.reason, /No configured specialist/);
});

test('required permissions filter: mismatch can never be selected', () => {
  const cands = [
    candidate(profile({ id: 'res', name: 'Res', roleId: 'researcher' }), 'researcher'),
    candidate(profile({ id: 'dev', name: 'Dev', roleId: 'devops' }), 'devops')
  ];
  const sel = wf.selectSpecialistForTask(cands, { requiredPermissions: ['computer:sensitive'] });
  assert.ok(sel.selected, `nothing selected: ${sel.reason}`);
  assert.equal(sel.selected.profile.id, 'dev');
});

test('no capability match: null with closest alternative named', () => {
  const cands = [candidate(profile({ id: 'eng', name: 'Eng', roleId: 'engineer' }), 'engineer')];
  const sel = wf.selectSpecialistForTask(cands, { skills: ['underwater-basket-weaving'] });
  assert.equal(sel.selected, null);
  assert.match(sel.reason, /No specialist matches/);
  assert.equal(sel.alternatives.length, 1);
});

function hireManifest(overrides = {}) {
  return {
    spec: 'munder-difflin/hire@1',
    name: 'Doc Writer',
    description: 'SEO content writer for the blog, keyword maps and meta descriptions',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    ...overrides
  };
}

test('hire bridge: role inference from the manifest words', () => {
  assert.equal(wf.inferRoleForHire('SEO content writer for the blog, keyword maps and meta descriptions'), 'content-seo');
  assert.equal(wf.inferRoleForHire('QA engineer, reproduces bugs'), 'qa');
  assert.equal(wf.inferRoleForHire('Fixes bugs and refactors code'), 'engineer');
  assert.equal(wf.inferRoleForHire('Assistant'), null);
  assert.equal(wf.inferRoleForHire(undefined, undefined), null);
  // One generic word matches two roles equally — declining beats guessing.
  assert.equal(wf.inferRoleForHire('writer'), null);
});

test('hire bridge: full manifest becomes a ready, selectable profile', () => {
  const r = wf.workforceProfileFromHire(hireManifest());
  assert.ok(r.profile, `no profile: ${r.reason}`);
  assert.equal(r.inferredRole, 'content-seo');
  assert.equal(wf.isProfileConfigured(r.profile), true);
  assert.match(r.reason, /ready/);
  const sel = wf.selectSpecialistForTask(
    [{ profile: r.profile, role: wf.roleById(r.inferredRole), available: true }],
    { skills: ['seo-write'] }
  );
  assert.ok(sel.selected, `not selected: ${sel.reason}`);
});

test('hire bridge: missing provider/model lands inert with the gap named', () => {
  const r = wf.workforceProfileFromHire(hireManifest({ provider: undefined, model: undefined }));
  assert.ok(r.profile, 'profile must still exist (visible, not selectable)');
  assert.equal(wf.isProfileConfigured(r.profile), false);
  assert.match(r.reason, /no provider|no model/);
  const sel = wf.selectSpecialistForTask(
    [{ profile: r.profile, role: wf.roleById(r.inferredRole), available: true }],
    { skills: ['seo-write'] }
  );
  assert.equal(sel.selected, null);
});

test('hire bridge: no confident role means no profile, never a guess', () => {
  const r = wf.workforceProfileFromHire(hireManifest({ name: 'X', description: 'Assistant' }));
  assert.equal(r.profile, null);
  assert.equal(r.inferredRole, null);
  assert.match(r.reason, /no confident role/);
});

test('staffNewAgent: role skills land on the record when none given', () => {
  const s = wf.staffNewAgent({ role: 'SEO content writer, keyword maps', provider: 'claude' });
  assert.equal(s.inferredRole, 'content-seo');
  assert.ok(s.capabilities.includes('seo-write'), `role skills missing: ${s.capabilities}`);
  assert.equal(s.staffed, true);
  assert.match(s.reason, /staffed/);
});

test('staffNewAgent: explicit capabilities always win', () => {
  const s = wf.staffNewAgent({ role: 'SEO content writer', provider: 'claude', capabilities: ['custom-a', 'custom-a'] });
  assert.deepEqual(s.capabilities, ['custom-a']);
  assert.equal(s.staffed, true);
});

test('staffNewAgent: unknown role or engine spawns anyway, flagged', () => {
  const noRole = wf.staffNewAgent({ role: 'Assistant', provider: 'claude' });
  assert.equal(noRole.inferredRole, null);
  assert.deepEqual(noRole.capabilities, []);
  assert.equal(noRole.staffed, false);
  const noEngine = wf.staffNewAgent({ role: 'Fixes bugs and refactors code' });
  assert.equal(noEngine.inferredRole, 'engineer');
  assert.equal(noEngine.staffed, false);
  assert.match(noEngine.reason, /no provider/);
});

test('spawnAgentCore staffs every agent before the registry write', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.ok(src.includes("import { staffNewAgent } from '../shared/workforce'"), 'staffing import missing');
  const spawnIdx = src.indexOf('async function spawnAgentCore');
  const ensureIdx = src.indexOf('hive.ensureAgent(', spawnIdx);
  const staffIdx = src.indexOf('staffNewAgent({', spawnIdx);
  assert.ok(spawnIdx > 0 && ensureIdx > spawnIdx && staffIdx > spawnIdx && staffIdx < ensureIdx,
    'staffing must run inside spawnAgentCore before ensureAgent');
});

test('workforce tab: registered, rendered, wired to the catalog', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const shell = fs.readFileSync(path.join(root, 'src/renderer/src/components/CommandCenterPanel.tsx'), 'utf8');
  assert.ok(shell.includes("import { WorkforceTab } from './WorkforceTab';"), 'WorkforceTab import missing');
  assert.ok(shell.includes("key: 'workforce'"), 'TABS lost the workforce key');
  assert.ok(shell.includes("labelKey: 'commandCenter.tabs.workforce'"), 'workforce TABS entry missing');
  assert.ok(shell.includes("{tab === 'workforce' && <WorkforceTab />}"), 'body does not render WorkforceTab');
  const tab = fs.readFileSync(path.join(root, 'src/renderer/src/components/WorkforceTab.tsx'), 'utf8');
  assert.ok(tab.includes("from '@shared/workforce'"), 'tab must use the shared catalog');
  assert.ok(tab.includes('inferRoleForHire') && tab.includes('selectSpecialistForTask'),
    'tab must infer roles and run capability-first matching');
  assert.ok(tab.includes('inertReason') || tab.includes('workforce.noRole'), 'inert states must name their gap');
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(fs.readFileSync(
      path.join(root, `src/renderer/src/i18n/locales/${loc}.json`), 'utf8'));
    assert.ok(json.commandCenter?.tabs?.workforce, `${loc}: tabs.workforce`);
    for (const k of ['intro', 'configured', 'inert', 'noRole', 'matchPlaceholder',
      'bestMatch', 'noMatch', 'skills', 'empty']) {
      assert.ok(json.workforce?.[k], `${loc}: workforce.${k}`);
    }
  }
});

test('PRD-3: inference cache hits on repeat descriptions with identical results', () => {
  wf.clearWorkforceMatchCache();
  const a = wf.inferRoleForHire('SEO content writer for the blog, keyword maps and meta descriptions');
  const s1 = wf.workforceMatchStats();
  assert.equal(s1.misses, 1);
  assert.equal(s1.hits, 0);
  const b = wf.inferRoleForHire('SEO content writer for the blog, keyword maps and meta descriptions');
  const s2 = wf.workforceMatchStats();
  assert.equal(a, b);
  assert.equal(s2.hits, 1);
  assert.equal(s2.misses, 1);
  wf.clearWorkforceMatchCache();
  const s3 = wf.workforceMatchStats();
  assert.deepEqual([s3.hits, s3.misses, s3.size], [0, 0, 0]);
});

test('PRD-3: permission-first reorder changes nothing observable', () => {
  const cands = [
    candidate(profile({ id: 'res', name: 'Res', roleId: 'researcher' }), 'researcher'),
    candidate(profile({ id: 'dev', name: 'Dev', roleId: 'devops' }), 'devops')
  ];
  // Match + mismatch paths both behave exactly as before the reorder.
  const ok = wf.selectSpecialistForTask(cands, { requiredPermissions: ['computer:sensitive'] });
  assert.equal(ok.selected?.profile.id, 'dev');
  const noPerm = wf.selectSpecialistForTask(cands, { requiredPermissions: ['computer:unknown'] });
  assert.equal(noPerm.selected, null);
  const noReq = wf.selectSpecialistForTask(cands, {});
  assert.ok(noReq.selected, 'unconstrained still selects');
});

test('PRD-3: repeated roster inference stays fast', () => {
  const descs = [
    'SEO content writer for the blog, keyword maps and meta descriptions',
    'QA engineer, reproduces bugs',
    'Fixes bugs and refactors code',
    'CI pipelines and deploys, log triage',
    'Assistant'
  ];
  wf.clearWorkforceMatchCache();
  const t0 = Date.now();
  for (let i = 0; i < 2000; i++) wf.inferRoleForHire(descs[i % descs.length]);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `2000 cached inferences took ${ms}ms (budget 1000ms)`);
  assert.ok(wf.workforceMatchStats().hits > 1900, 'repeats must hit the cache');
});
