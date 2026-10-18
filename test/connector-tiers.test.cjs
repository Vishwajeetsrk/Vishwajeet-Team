'use strict';

/**
 * Connector cost tiers (free-first lane): every template in the catalog names
 * who pays, free connectors need no key and document their quota, and paid
 * connectors are approval-every-call through the existing broker + M1 policy
 * chain. Static source-text contract (no network, no secrets).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const shared = loadTs('src/shared/integrations.ts');
const {
  INTEGRATION_TEMPLATES,
  ALL_CONNECTOR_COSTS,
  validateConnectorTemplate,
  paidConnectorIds,
  freeConnectorIds
} = shared;
const hire = loadTs('src/shared/hire.ts');

test('every template names a valid cost tier + approval flag', () => {
  assert.deepEqual([...ALL_CONNECTOR_COSTS].sort(), ['byok', 'free', 'paid']);
  const ids = new Set();
  for (const t of INTEGRATION_TEMPLATES) {
    assert.ok(typeof t.idSuggestion === 'string' && t.idSuggestion.length > 0, 'template missing idSuggestion');
    assert.ok(!ids.has(t.idSuggestion), `duplicate template id ${t.idSuggestion}`);
    ids.add(t.idSuggestion);
    assert.ok(ALL_CONNECTOR_COSTS.includes(t.cost), `${t.idSuggestion}: bad cost ${t.cost}`);
    assert.equal(typeof t.requiresApproval, 'boolean', `${t.idSuggestion}: requiresApproval must be boolean`);
    const v = validateConnectorTemplate(t);
    assert.equal(v.ok, true, `${t.idSuggestion}: ${v.ok ? '' : v.error}`);
  }
});

test('free tier is real: no key, quota documented, https, docs', () => {
  const free = INTEGRATION_TEMPLATES.filter((t) => t.cost === 'free');
  assert.ok(free.length >= 5, `expected a real free bench, got ${free.length}`);
  assert.deepEqual(freeConnectorIds().sort(), free.map((t) => t.idSuggestion).sort());
  for (const t of free) {
    assert.equal(t.authType, 'none', `${t.idSuggestion}: free must use authType none`);
    assert.ok(!t.secretLabel && !t.secretHelp, `${t.idSuggestion}: free must not ask for a secret`);
    assert.ok(t.quotaNote && t.quotaNote.length > 10, `${t.idSuggestion}: free must document its quota`);
    assert.ok(t.docsUrl && t.docsUrl.startsWith('https://'), `${t.idSuggestion}: free must link docs`);
    assert.ok(t.baseUrl.startsWith('https://'), `${t.idSuggestion}: free baseUrl must be https`);
  }
  const ids = free.map((t) => t.idSuggestion);
  for (const want of ['github-public', 'open-meteo', 'npm-registry', 'pypi', 'open-library', 'hacker-news', 'rest-countries']) {
    assert.ok(ids.includes(want), `free bench missing ${want}`);
  }
});

test('byok/paid templates explain the credential; paid is approval-every-call', () => {

  for (const t of INTEGRATION_TEMPLATES.filter((t) => t.cost !== 'free')) {
    assert.ok(t.secretLabel && t.secretHelp, `${t.idSuggestion}: must explain the credential`);
  }
  const paid = paidConnectorIds();
  assert.ok(paid.includes('stripe'), 'stripe moves money and must be paid-tier');
  for (const t of INTEGRATION_TEMPLATES.filter((t) => t.cost === 'paid')) {
    assert.equal(t.requiresApproval, true, `${t.idSuggestion}: paid must require approval`);
  }
  for (const id of freeConnectorIds()) {
    const t = INTEGRATION_TEMPLATES.find((x) => x.idSuggestion === id);
    assert.equal(t.requiresApproval, false, `${id}: free must not demand per-call approval`);
  }
});

test('broker checks policy BEFORE touching secrets or records', () => {
  const broker = read('src/main/integrationBroker.ts');
  const policyIdx = broker.indexOf('policy_denied');
  assert.ok(policyIdx > 0, 'broker policy gate missing');
  const secretIdx = broker.indexOf('getSecret(');
  assert.ok(secretIdx > policyIdx, 'secret resolution must come AFTER the policy gate');
  assert.ok(broker.includes('authorizeOutbound'), 'broker must consult authorizeOutbound');
  const index = read('src/main/index.ts');
  assert.ok(index.includes('authorizeOutbound: (workerId, integrationId)'), 'index must inject the outbound authorizer');
  assert.ok(index.includes('approvalDesk.consumeRetry'), 'paid retry path must ride one-shot approvals');
});

test('LinkedIn via Publora: verified publish path, approval-every-call', () => {
  const t = INTEGRATION_TEMPLATES.find((x) => x.idSuggestion === 'linkedin-publora');
  assert.ok(t, 'linkedin-publora template missing');
  assert.equal(t.baseUrl, 'https://api.publora.com/api/v1');
  assert.equal(t.authType, 'header');
  assert.equal(t.authHeader, 'x-publora-key');
  assert.equal(t.cost, 'byok');
  assert.equal(t.requiresApproval, true, 'publishing moves reputation — approval-every-call');
  assert.ok(t.secretLabel && t.secretHelp, 'must explain the key + platform ID flow');
  assert.ok(t.quotaNote && t.quotaNote.includes('15'), 'must state the free tier');
  const v = validateConnectorTemplate(t);
  assert.equal(v.ok, true, v.ok ? '' : v.error);
});

test('hire skill allowlist covers the served read-only set, nothing else', () => {
  const skillsDir = path.join(root, 'resources', 'skills');
  const served = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(skillsDir, n, 'SKILL.md')));
  assert.ok(served.length >= 10, `expected the served skill set, got ${served.length}`);
  for (const id of hire.BUNDLED_SKILL_IDS) {
    assert.ok(served.includes(id), `allowlisted skill ${id} has no served SKILL.md`);
  }
  for (const id of ['temporal', 'capabilities', 'today', 'last7Days', 'last30Days']) {
    assert.ok(hire.BUNDLED_SKILL_IDS.has(id), `served read-only skill ${id} must be hire-referenceable`);
  }
  // Still closed: arbitrary paths never pass validation.
  const bad = hire.validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'x', skills: ['../../evil'] });
  assert.equal(bad.ok, false, 'path-like skill must be rejected');
});
