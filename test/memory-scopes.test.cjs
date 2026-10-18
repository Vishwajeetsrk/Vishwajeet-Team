'use strict';

/**
 * Phase 5 — one write + read per memory scope, with retrieval targeting.
 *
 * REAL vs MOCK:
 * - REAL: `MemoryService` (src/main/memoryService.ts) — full write pipeline,
 *   canRead, retrieve, over the repo seam.
 * - MOCK: `MemoryMemoryRepo` (in-memory test double from memoryStore.ts).
 *   Production SQLite lives in the labeled electron harness only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { MemoryService } = loadTs('src/main/memoryService.ts');
const { MemoryMemoryRepo } = loadTs('src/main/memoryStore.ts');

const USER = { kind: 'user' };
const FIXED_NOW = 1_700_000_000_000;

function makeService() {
  const repo = new MemoryMemoryRepo();
  const svc = new MemoryService({ repo, now: () => FIXED_NOW });
  return { repo, svc };
}

/** Complete MemoryWriteInput — overrides last. */
function input(overrides = {}) {
  return {
    scope: 'global',
    type: 'fact',
    content: 'default content',
    projectId: null,
    agentId: null,
    taskId: null,
    computerId: null,
    importance: null,
    confidence: null,
    expiresAt: null,
    ...overrides,
  };
}

function write(svc, overrides, ctx) {
  const res = svc.write(input(overrides), USER, ctx);
  assert.equal(res.ok, true, `write failed: ${res.error}`);
  return res.value.record;
}

test('global scope: ownerId denormalizes to "system", readable by id', () => {
  const { svc } = makeService();
  const rec = write(svc, { content: 'Global rule: always summarize reports' });

  assert.equal(rec.scope, 'global');
  assert.equal(rec.ownerId, 'system', 'global owner is the system');
  assert.equal(rec.projectId, null);
  assert.equal(rec.agentId, null);
  assert.equal(rec.taskId, null);
  assert.equal(rec.computerId, null);
  assert.equal(rec.approved, true, 'user writes land approved');
  assert.equal(rec.status, 'active');
  assert.equal(rec.version, 1);

  const got = svc.get(rec.id, USER);
  assert.equal(got.ok, true);
  assert.equal(got.value.ownerId, 'system');
  assert.equal(got.value.content, 'Global rule: always summarize reports');
});

test('project scope: ownerId denormalizes to the projectId', () => {
  const { svc } = makeService();
  const rec = write(svc, { scope: 'project', projectId: 'proj-atlas', content: 'Atlas ships on Fridays' });

  assert.equal(rec.scope, 'project');
  assert.equal(rec.ownerId, 'proj-atlas', 'project owner is the projectId');
  assert.equal(rec.projectId, 'proj-atlas');
  assert.equal(rec.agentId, null);

  const got = svc.get(rec.id, USER);
  assert.equal(got.ok, true);
  assert.equal(got.value.ownerId, 'proj-atlas');
});

test('agent scope: ownerId denormalizes to the agentId', () => {
  const { svc } = makeService();
  const rec = write(svc, { scope: 'agent', agentId: 'agent-1', content: 'agent-1 prefers tabular diffs' });

  assert.equal(rec.scope, 'agent');
  assert.equal(rec.ownerId, 'agent-1', 'agent owner is the agentId');
  assert.equal(rec.agentId, 'agent-1', 'denormalized agent ref for ACL');

  const got = svc.get(rec.id, USER);
  assert.equal(got.ok, true);
  assert.equal(got.value.ownerId, 'agent-1');
  assert.equal(got.value.agentId, 'agent-1');
});

test('task scope: ownerId denormalizes to the taskId (plan id)', () => {
  const { svc } = makeService();
  const rec = write(svc, { scope: 'task', taskId: 'plan-77', content: 'Plan 77 found the flaky test' });

  assert.equal(rec.scope, 'task');
  assert.equal(rec.ownerId, 'plan-77', 'task owner is the plan id');
  assert.equal(rec.taskId, 'plan-77');
  assert.equal(rec.agentId, null, 'user write with no agent ref stays unassigned');

  const got = svc.get(rec.id, USER);
  assert.equal(got.ok, true);
  assert.equal(got.value.ownerId, 'plan-77');
});

test('computer scope: ownerId denormalizes to the computerId', () => {
  const { svc } = makeService();
  const rec = write(svc, { scope: 'computer', computerId: 'cmp-orion', content: 'Workspace root lives on D:\\work' });

  assert.equal(rec.scope, 'computer');
  assert.equal(rec.ownerId, 'cmp-orion', 'computer owner is the computerId');
  assert.equal(rec.computerId, 'cmp-orion');
  assert.equal(rec.projectId, null);
  assert.equal(rec.agentId, null);

  const got = svc.get(rec.id, USER);
  assert.equal(got.ok, true);
  assert.equal(got.value.ownerId, 'cmp-orion');
  assert.equal(got.value.computerId, 'cmp-orion');
});

test('a scope without its primary reference is rejected before persisting', () => {
  const { svc, repo } = makeService();
  const missing = svc.write(input({ scope: 'project', content: 'no project' }), USER);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'VALIDATION');
  assert.match(missing.error, /requires its primary reference/);

  const unknown = svc.write(input({ scope: 'universe', content: 'nope' }), USER);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'VALIDATION');
  assert.match(unknown.error, /unknown scope/);
  assert.equal(repo.list().length, 0, 'nothing persisted for rejected writes');
});

test('retrieval targeting: scope / projectId / agentId / taskId filters select the right record', () => {
  const { svc } = makeService();
  const globalRec = write(svc, { content: 'global marker content', type: 'rule' });
  const projectRec = write(svc, { scope: 'project', projectId: 'proj-atlas', content: 'project marker content' });
  const agentRec = write(svc, { scope: 'agent', agentId: 'agent-1', content: 'agent marker content' });
  const taskRec = write(svc, { scope: 'task', taskId: 'plan-77', content: 'task marker content' });
  const computerRec = write(svc, { scope: 'computer', computerId: 'cmp-orion', content: 'computer marker content' });

  const ids = (q) => svc.retrieve(USER, q).value.records.map((r) => r.id);

  assert.deepEqual(ids({ scope: 'global' }), [globalRec.id], 'scope filter → global only');
  assert.deepEqual(ids({ scope: 'project' }), [projectRec.id], 'scope filter → project only');
  assert.deepEqual(ids({ scope: 'agent' }), [agentRec.id], 'scope filter → agent only');
  assert.deepEqual(ids({ scope: 'task' }), [taskRec.id], 'scope filter → task only');
  assert.deepEqual(ids({ scope: 'computer' }), [computerRec.id], 'scope filter → computer only');

  assert.deepEqual(ids({ projectId: 'proj-atlas' }), [projectRec.id],
    'projectId hard filter excludes global (projectId null) and every other scope');
  assert.deepEqual(ids({ agentId: 'agent-1' }), [agentRec.id],
    'agentId filter targets the denormalized agent ref');
  assert.deepEqual(ids({ taskId: 'plan-77' }), [taskRec.id], 'taskId filter targets the plan');

  // Combined targeting + a text query narrows further.
  assert.deepEqual(ids({ scope: 'project', projectId: 'proj-atlas', query: 'marker' }), [projectRec.id]);
  assert.deepEqual(ids({ scope: 'task', taskId: 'plan-999' }), [], 'wrong id → empty, never a neighbour');

  assert.equal(svc.retrieve(USER, {}).value.records.length, 5, 'unfiltered retrieval sees all five scopes');
});
