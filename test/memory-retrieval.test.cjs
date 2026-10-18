'use strict';

/**
 * Phase 5 — retrieval pipeline (design §5): rank order, budget cap, ACL before
 * ranking, readerProjectId vs projectId, active-only default, limit.
 *
 * REAL vs MOCK:
 * - REAL: `MemoryService.retrieve` — the shipped scoring formula
 *   (0.5·textOverlap + 0.25·confidence + 0.15·importance/5 + 0.10·recency),
 *   prefilter, ACL filter and budget loop all run untouched.
 * - MOCK: `MemoryMemoryRepo` (in-memory double) and an injected `now` so the
 *   recency term is deterministic across every record in a test.
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

test('ranking: higher overlap, then confidence, then importance, sorts first', () => {
  const { svc } = makeService();
  // Same scope+owner+type on purpose — contents are pairwise dissimilar
  // (jaccard < 0.5) so no write supersedes another; only scoring differs.
  const high = writeUser(svc, {
    content: 'alpha bravo charlie delta echo foxtrot golf hotel india',
    confidence: 0.95, importance: 5,
  });
  const medConf = writeUser(svc, {
    content: 'alpha bravo charlie juliet kilo lima mike november oscar',
    confidence: 0.5, importance: 5,
  });
  const lowImp = writeUser(svc, {
    content: 'alpha bravo charlie papa quebec romeo sierra tango uniform',
    confidence: 0.95, importance: 0,
  });
  const lowText = writeUser(svc, {
    content: 'alpha victor whiskey xray yankee zulu aaab',
    confidence: 0.95, importance: 5,
  });

  const res = svc.retrieve(USER, { query: 'alpha bravo charlie' });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(
    res.value.records.map((r) => r.id),
    [high.id, medConf.id, lowImp.id, lowText.id],
    'full overlap + high confidence + high importance first; weakest text overlap last'
  );

  // Each dimension is independently observable (compare by id — retrieve
  // hands back fresh copies, never the objects write() returned).
  const order = res.value.records.map((r) => r.id);
  assert.ok(order.indexOf(medConf.id) < order.indexOf(lowImp.id),
    'equal overlap + importance: higher confidence ranks first');
  assert.ok(order.indexOf(lowImp.id) < order.indexOf(lowText.id),
    'equal overlap + confidence: higher importance ranks first');
  assert.equal(order[0], high.id, 'the fully-matching record wins outright');
  assert.equal(res.value.total, 4, 'every ACL-passing candidate counted before the cap');
});

test('budgetChars caps the output: usedChars never exceeds the budget, truncated flips', () => {
  const { svc } = makeService();
  const first = writeUser(svc, { content: 'a'.repeat(40), confidence: 0.9, importance: 5 });
  const second = writeUser(svc, { content: 'b'.repeat(40), confidence: 0.9, importance: 5 });

  // Comfortable budget: both fit, nothing truncated.
  const roomy = svc.retrieve(USER, { budgetChars: 100 });
  assert.equal(roomy.value.records.length, 2);
  assert.equal(roomy.value.usedChars, 80, 'usedChars is the sum of returned content lengths');
  assert.equal(roomy.value.truncated, false);

  // Tight budget: the second record does not fit → stop, flag truncation.
  const tight = svc.retrieve(USER, { budgetChars: 60 });
  assert.equal(tight.value.records.length, 1, 'only the top record fits');
  assert.equal(tight.value.records[0].id, first.id, 'ranking decides who wins the budget');
  assert.equal(tight.value.usedChars, 40, 'usedChars is strictly within the budget');
  assert.ok(tight.value.usedChars <= 60);
  assert.equal(tight.value.truncated, true, 'the caller is told content was left behind');
  assert.equal(tight.value.total, 2, 'total still reports the ACL-passing candidates');

  // A record that can never fit is skipped, and the skip is still visible.
  const { svc: svc2 } = makeService();
  writeUser(svc2, { content: 'z'.repeat(200) });
  const impossible = svc2.retrieve(USER, { budgetChars: 100 });
  assert.deepEqual(impossible.value.records, [], 'nothing fits under the budget');
  assert.equal(impossible.value.usedChars, 0);
  assert.equal(impossible.value.truncated, true, 'an unreturned candidate marks the result truncated');
  assert.equal(impossible.value.total, 1, 'the record existed — it just could not fit');
});

test('ACL filters BEFORE ranking: a sibling never sees the private record, not even in totals', () => {
  const { svc } = makeService();
  // agent-1's private record is the strongest match by every term — if the
  // index ranked first and filtered after, it would surface for agent-2.
  const privateRec = writeUser(svc, {
    scope: 'agent', agentId: 'agent-1',
    content: 'competitors pricing strategy belongs to agent one',
    confidence: 1, importance: 5,
  });
  const siblingRec = writeUser(svc, {
    scope: 'agent', agentId: 'agent-2',
    content: 'competitors pricing strategy belongs to agent two',
    confidence: 0.1, importance: 1,
  });
  const globalRec = writeUser(svc, { content: 'competitors pricing is public knowledge', confidence: 0.5 });

  const res = svc.retrieve(agent('agent-2'), { query: 'competitors pricing strategy' });
  assert.equal(res.ok, true, res.error);
  const ids = res.value.records.map((r) => r.id);
  assert.equal(ids.includes(privateRec.id), false, 'the private record never appears for a sibling');
  assert.equal(res.value.records.some((r) => r.agentId === 'agent-1'), false, 'no agent-1 record leaks through');
  assert.equal(res.value.total, 2, 'total counts ONLY records that passed ACL (filter ran before ranking)');
  assert.ok(ids.includes(siblingRec.id), 'the sibling keeps its own record');
  assert.ok(ids.includes(globalRec.id), 'global stays visible');

  // The owner sees its own record (ranked first) plus global — never the
  // sibling's private record, which is just as private in the other direction.
  const asOwner = svc.retrieve(agent('agent-1'), { query: 'competitors pricing strategy' });
  assert.deepEqual(asOwner.value.records.map((r) => r.id), [privateRec.id, globalRec.id],
    'owner sees its own record ranked first, global second');
  assert.equal(asOwner.value.total, 2, 'the sibling private record is excluded from the owner too');
});

test('readerProjectId (trusted ACL ctx) vs projectId (hard filter) are distinct', () => {
  const { svc } = makeService();
  const globalRec = writeUser(svc, { content: 'budget forecast alpha' });
  const mineProj = writeUser(svc, { scope: 'project', projectId: 'proj-7', content: 'budget forecast beta' });
  const otherProj = writeUser(svc, { scope: 'project', projectId: 'proj-8', content: 'budget forecast gamma' });
  const q = { query: 'budget forecast' };

  // readerProjectId widens READ ACCESS without filtering anything out:
  // global + that project's records come back, other projects stay excluded.
  const withCtx = svc.retrieve(agent('agent-1'), { ...q, readerProjectId: 'proj-7' });
  assert.deepEqual(withCtx.value.records.map((r) => r.id).sort(), [globalRec.id, mineProj.id].sort(),
    'readerProjectId sees global + that project (nothing filtered out)');
  assert.ok(!withCtx.value.records.some((r) => r.id === otherProj.id), 'other projects are still ACL-blocked');

  const withOtherCtx = svc.retrieve(agent('agent-1'), { ...q, readerProjectId: 'proj-8' });
  assert.deepEqual(withOtherCtx.value.records.map((r) => r.id).sort(), [globalRec.id, otherProj.id].sort());

  // Without the trusted ctx an agent sees only global.
  const noCtx = svc.retrieve(agent('agent-1'), q);
  assert.deepEqual(noCtx.value.records.map((r) => r.id), [globalRec.id],
    'no readerProjectId → project records unreadable for an agent');

  // projectId is a plain HARD FILTER — it drops global even for the user.
  const filtered = svc.retrieve(USER, { ...q, projectId: 'proj-7' });
  assert.deepEqual(filtered.value.records.map((r) => r.id), [mineProj.id],
    'projectId filter excludes global (projectId null)');

  // Combined with the trusted ctx the agent lands on exactly that project.
  const both = svc.retrieve(agent('agent-1'), { ...q, projectId: 'proj-7', readerProjectId: 'proj-7' });
  assert.deepEqual(both.value.records.map((r) => r.id), [mineProj.id]);

  // An agent WITHOUT the ctx cannot use the hard filter to read project rows.
  const forged = svc.retrieve(agent('agent-1'), { ...q, projectId: 'proj-7' });
  assert.equal(forged.value.records.length, 0, 'a hard filter never widens permission');
});

test('default retrieval is active-only; status:"all" is the UI browse path', () => {
  const { svc } = makeService();
  const activeFact = writeUser(svc, { content: 'an active fact remains' });
  const doomed = writeUser(svc, { content: 'a fact to delete' });
  writeUser(svc, { type: 'preference', content: 'old preference value' });
  const currentPref = writeUser(svc, { type: 'preference', content: 'current preference value' });
  const proposal = svc.write(input({ type: 'fact', content: 'agent proposal fact' }), agent('agent-1'));
  assert.equal(proposal.ok, true, proposal.error);
  assert.equal(proposal.value.record.status, 'proposed');
  assert.equal(svc.remove(doomed.id, USER).ok, true);

  const active = svc.retrieve(USER, {});
  assert.deepEqual(
    active.value.records.map((r) => r.id).sort(),
    [activeFact.id, currentPref.id].sort(),
    'only active rows: proposed/superseded/deleted are excluded by default'
  );
  assert.equal(active.value.total, 2);

  const browse = svc.retrieve(USER, { status: 'all' });
  assert.equal(browse.value.records.length, 5, 'status all surfaces the full lifecycle for the panel');
  const statuses = new Set(browse.value.records.map((r) => r.status));
  assert.deepEqual([...statuses].sort(), ['active', 'deleted', 'proposed', 'superseded']);

  assert.deepEqual(svc.retrieve(USER, { status: 'proposed' }).value.records.map((r) => r.id),
    [proposal.value.record.id], 'approval queues are queryable by status');
});

test('limit is honored (and reported through truncated)', () => {
  const { svc } = makeService();
  const written = [];
  for (let i = 0; i < 5; i += 1) {
    written.push(writeUser(svc, { content: `unique${i} content${i}` }));
  }

  const capped = svc.retrieve(USER, { limit: 2 });
  assert.equal(capped.value.records.length, 2, 'limit caps the returned set');
  assert.equal(capped.value.total, 5, 'total still reflects the whole match set');
  assert.equal(capped.value.truncated, true, 'hitting the limit marks truncation');

  const all = svc.retrieve(USER, {});
  assert.equal(all.value.records.length, 5, 'default limit (50) covers the whole set here');
  assert.equal(all.value.truncated, false);

  const one = svc.retrieve(USER, { limit: 1 });
  assert.equal(one.value.records.length, 1);
  assert.deepEqual(one.value.records[0].id, written[0].id, 'top-ranked record survives the cap');
  assert.equal(one.value.usedChars, one.value.records[0].content.length);
});
