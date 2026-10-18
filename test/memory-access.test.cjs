'use strict';

/**
 * Phase 5 — access matrix (design §4): who may READ each scope, cross-agent
 * denial, access_list grant → revocation, "user always reads", and the
 * task-agent write gate wired through deps.taskAgent.
 *
 * REAL vs MOCK:
 * - REAL: `MemoryService` — canRead/retrieve/write permission checks run as
 *   shipped; access_list entries are mutated through the REAL repo seam exactly
 *   the way a future panel/approval hook would.
 * - MOCK: `MemoryMemoryRepo` (in-memory double) and `deps.taskAgent` (the
 *   goal-ledger lookup from index.ts is replaced by a fixed map).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { MemoryService } = loadTs('src/main/memoryService.ts');
const { MemoryMemoryRepo } = loadTs('src/main/memoryStore.ts');

const USER = { kind: 'user' };
const agent = (agentId) => ({ kind: 'agent', agentId });
const FIXED_NOW = 1_700_000_000_000;

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

function makeService(deps = {}) {
  const repo = new MemoryMemoryRepo();
  const svc = new MemoryService({ repo, now: () => FIXED_NOW, ...deps });
  return { repo, svc };
}

function writeUser(svc, overrides) {
  const res = svc.write(input(overrides), USER);
  assert.equal(res.ok, true, `setup write failed: ${res.error}`);
  return res.value.record;
}

test('access matrix: canRead per scope for user, owner, sibling and unassigned agents', () => {
  const { svc } = makeService();
  const globalRec = writeUser(svc, { content: 'company wide rule' });
  const projectRec = writeUser(svc, { scope: 'project', projectId: 'proj-x', content: 'project convention' });
  const agentRec = writeUser(svc, { scope: 'agent', agentId: 'agent-1', content: 'agent one notebook' });
  const taskRec = writeUser(svc, { scope: 'task', taskId: 'plan-1', agentId: 'agent-1', content: 'assigned task context' });
  const computerRec = writeUser(svc, { scope: 'computer', computerId: 'cmp-1', agentId: 'agent-1', content: 'computer paths' });
  const orphanComputerRec = writeUser(svc, { scope: 'computer', computerId: 'cmp-2', content: 'unassigned computer paths' });

  const a1 = agent('agent-1');
  const a2 = agent('agent-2');

  // global → everyone (design §4, first row).
  assert.equal(svc.canRead(globalRec, USER), true);
  assert.equal(svc.canRead(globalRec, a1), true);
  assert.equal(svc.canRead(globalRec, a2), true);

  // project → user always; agent only with the trusted reader project ctx.
  assert.equal(svc.canRead(projectRec, USER), true, 'user always reads project scope');
  assert.equal(svc.canRead(projectRec, a1), false, 'agent without readerProjectId denied');
  assert.equal(svc.canRead(projectRec, a1, { projectId: 'proj-x' }), true, 'matching readerProjectId grants read');
  assert.equal(svc.canRead(projectRec, a2, { projectId: 'other-proj' }), false, 'wrong project denied');

  // agent scope → user, owner, never a sibling.
  assert.equal(svc.canRead(agentRec, USER), true, 'user always reads agent scope');
  assert.equal(svc.canRead(agentRec, a1), true, 'owner reads its own private record');
  assert.equal(svc.canRead(agentRec, a2), false, 'sibling agent denied');

  // task scope → user + the assigned agent (rec.agentId), never others.
  assert.equal(svc.canRead(taskRec, USER), true);
  assert.equal(svc.canRead(taskRec, a1), true, 'assigned agent reads task memory');
  assert.equal(svc.canRead(taskRec, a2), false, 'unassigned agent denied');

  // computer scope → user + the agent bound to the record.
  assert.equal(svc.canRead(computerRec, USER), true);
  assert.equal(svc.canRead(computerRec, a1), true);
  assert.equal(svc.canRead(computerRec, a2), false);
  assert.equal(svc.canRead(orphanComputerRec, a1), false, 'no agent bound → no agent reads it');
  assert.equal(svc.canRead(orphanComputerRec, USER), true, 'user still reads unbound computer memory');
});

test('retrieval filters ACL before ranking: a sibling never sees foreign scopes', () => {
  const { svc } = makeService();
  writeUser(svc, { content: 'global readable marker' });
  writeUser(svc, { scope: 'project', projectId: 'proj-x', content: 'project readable marker' });
  writeUser(svc, { scope: 'agent', agentId: 'agent-1', content: 'private marker of agent one' });
  writeUser(svc, { scope: 'task', taskId: 'plan-1', agentId: 'agent-1', content: 'task marker of agent one' });
  writeUser(svc, { scope: 'computer', computerId: 'cmp-1', agentId: 'agent-1', content: 'computer marker of agent one' });

  // agent-2 with the trusted reader project: global + project only.
  const asSibling = svc.retrieve(agent('agent-2'), { readerProjectId: 'proj-x' });
  assert.equal(asSibling.ok, true);
  assert.deepEqual(
    asSibling.value.records.map((r) => r.scope).sort(),
    ['global', 'project'],
    'sibling sees exactly global + project, never agent/task/computer records of agent-1'
  );
  assert.equal(asSibling.value.total, 2, 'total counts only ACL-passing records (filter before ranking)');

  // The owner sees its own records too.
  const asOwner = svc.retrieve(agent('agent-1'), { readerProjectId: 'proj-x' });
  assert.deepEqual(asOwner.value.records.map((r) => r.scope).sort(), ['agent', 'computer', 'global', 'project', 'task']);

  // The user sees everything.
  const asUser = svc.retrieve(USER, {});
  assert.equal(asUser.value.total, 5, 'user always reads every scope');
});

test('cross-agent denial: get/history refuse the private record, retrieval never lists it', () => {
  const { svc } = makeService();
  const mine = writeUser(svc, { scope: 'agent', agentId: 'agent-1', content: 'notebook of agent one' });

  const deniedGet = svc.get(mine.id, agent('agent-2'));
  assert.equal(deniedGet.ok, false);
  assert.equal(deniedGet.code, 'ACCESS_DENIED');

  const deniedHistory = svc.history(mine.id, agent('agent-2'));
  assert.equal(deniedHistory.ok, false);
  assert.equal(deniedHistory.code, 'ACCESS_DENIED');

  const deniedRetrieve = svc.retrieve(agent('agent-2'), { scope: 'agent' });
  assert.equal(deniedRetrieve.ok, true);
  assert.deepEqual(deniedRetrieve.value.records, [], 'no private record in the sibling result');
  assert.equal(deniedRetrieve.value.total, 0, 'ACL ran before the total was counted');

  assert.equal(svc.get(mine.id, agent('agent-1')).ok, true, 'owner still reads it');
  assert.equal(svc.get(mine.id, USER).ok, true, 'user still reads it');
});

test('access_list grant then revocation flips on the very next retrieve', () => {
  const { repo, svc } = makeService();
  const res = svc.write(input({ scope: 'agent', agentId: 'agent-1', content: 'shared notebook entry' }), agent('agent-1'));
  assert.equal(res.ok, true, res.error);
  const id = res.value.record.id;

  // No grant yet — sibling is excluded.
  assert.equal(svc.retrieve(agent('agent-2'), { scope: 'agent' }).value.total, 0);

  // GRANT: the record's accessList gains agent-2 (written through the repo seam).
  const granted = repo.get(id);
  granted.accessList.push('agent-2');
  repo.update(granted);
  const afterGrant = svc.retrieve(agent('agent-2'), { scope: 'agent' });
  assert.equal(afterGrant.value.total, 1, 'granted agent reads on the next retrieval');
  assert.equal(afterGrant.value.records[0].id, id);
  assert.equal(svc.get(id, agent('agent-2')).ok, true, 'direct get also honours the grant');

  // REVOCATION: entry removed → excluded again, no cache to stale.
  const revoked = repo.get(id);
  revoked.accessList = revoked.accessList.filter((a) => a !== 'agent-2');
  repo.update(revoked);
  assert.equal(svc.retrieve(agent('agent-2'), { scope: 'agent' }).value.total, 0, 'revocation takes effect immediately');
  assert.equal(svc.get(id, agent('agent-2')).code, 'ACCESS_DENIED');
  assert.equal(svc.retrieve(agent('agent-1'), { scope: 'agent' }).value.total, 1, 'owner unaffected by the revocation');
});

test('task-agent write gate via deps.taskAgent (mocked goal-ledger lookup)', () => {
  const taskAgent = (taskId) => (taskId === 'plan-1' ? 'agent-1' : null);
  const { svc, repo } = makeService({ taskAgent });

  // Assigned agent → allowed, lands ACTIVE (task is an agent-active scope).
  const assigned = svc.write(
    input({ scope: 'task', taskId: 'plan-1', content: 'finding from the assigned agent' }),
    agent('agent-1'),
  );
  assert.equal(assigned.ok, true, assigned.error);
  assert.equal(assigned.value.record.status, 'active');
  assert.equal(assigned.value.record.approved, false, 'agent-authored, never user-approved');
  assert.equal(assigned.value.record.agentId, 'agent-1', 'author denormalized for ACL');
  assert.equal(assigned.value.record.ownerId, 'plan-1');

  // Task with no assigned agent → denied.
  const unassigned = svc.write(
    input({ scope: 'task', taskId: 'plan-2', content: 'nobody owns this plan' }),
    agent('agent-1'),
  );
  assert.equal(unassigned.ok, false);
  assert.equal(unassigned.code, 'PERMISSION_DENIED');
  assert.match(unassigned.error, /not the assigned agent for task/);

  // Assigned to someone else → denied.
  const foreign = svc.write(
    input({ scope: 'task', taskId: 'plan-1', content: 'wrong agent tries to write' }),
    agent('agent-2'),
  );
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'PERMISSION_DENIED');

  // Agents may never write computer scope (design §4 write matrix).
  const computer = svc.write(
    input({ scope: 'computer', computerId: 'cmp-1', content: 'agent tries computer memory' }),
    agent('agent-1'),
  );
  assert.equal(computer.ok, false);
  assert.equal(computer.code, 'PERMISSION_DENIED');
  assert.match(computer.error, /may not write computer-scope memory/);

  // Cross-agent private scope → denied (own id only).
  const foreignAgentScope = svc.write(
    input({ scope: 'agent', agentId: 'agent-2', content: 'agent one impersonates agent two' }),
    agent('agent-1'),
  );
  assert.equal(foreignAgentScope.ok, false);
  assert.equal(foreignAgentScope.code, 'PERMISSION_DENIED');

  assert.equal(repo.list().length, 1, 'only the authorized write persisted');
});

test('user writes are always authorized across every scope', () => {
  const { svc, repo } = makeService({ taskAgent: () => null });
  for (const overrides of [
    { scope: 'global', content: 'user global' },
    { scope: 'project', projectId: 'proj-x', content: 'user project' },
    { scope: 'agent', agentId: 'agent-2', content: 'user writes for an agent' },
    { scope: 'task', taskId: 'plan-1', content: 'user task memory' },
    { scope: 'computer', computerId: 'cmp-1', content: 'user computer memory' },
  ]) {
    const res = svc.write(input(overrides), USER);
    assert.equal(res.ok, true, `user write ${overrides.scope} failed: ${res.error}`);
    assert.equal(res.value.record.status, 'active', 'user writes land active in every scope');
    assert.equal(res.value.record.approved, true);
  }
  assert.equal(repo.list().length, 5, 'one row per scope, no rejections for the user');
});
