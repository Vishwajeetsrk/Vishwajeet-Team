'use strict';

/**
 * Phase 5 — retention (design §4 rules 5-6): expiry exclusion, boot-time
 * reconcile(), soft delete, and history that survives deletion.
 *
 * REAL vs MOCK:
 * - REAL: `MemoryService` retention paths — lazy expiry inside retrieve(),
 *   reconcile(), remove() soft-delete and history() chain walking.
 * - MOCK: `MemoryMemoryRepo` (in-memory double) plus an injected `now` clock so
 *   "future" and "expired" are exact, not timing-dependent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { MemoryService } = loadTs('src/main/memoryService.ts');
const { MemoryMemoryRepo } = loadTs('src/main/memoryStore.ts');

const USER = { kind: 'user' };
const agent = (agentId) => ({ kind: 'agent', agentId });
const T0 = 1_700_000_000_000;

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
  const log = [];
  let clock = deps.clock ?? T0;
  const svc = new MemoryService({
    repo,
    now: () => clock,
    log: (evt) => log.push(evt),
    ...deps,
  });
  return {
    repo, svc, log,
    advanceTo(t) { clock = t; },
    now() { return clock; },
  };
}

test('expired records drop out of retrieval the moment the clock passes expiresAt', () => {
  const env = makeService();
  const shortLived = env.svc.write(input({ content: 'ephemeral note', expiresAt: T0 + 60_000 }), USER);
  assert.equal(shortLived.ok, true, shortLived.error);
  const keeper = env.svc.write(input({ content: 'permanent note', expiresAt: null }), USER).value.record;

  // Before expiry: both retrievable.
  const before = env.svc.retrieve(USER, {});
  assert.deepEqual(before.value.records.map((r) => r.id).sort(),
    [shortLived.value.record.id, keeper.id].sort(), 'both active before the deadline');

  // Cross the deadline.
  env.advanceTo(T0 + 60_001);
  const after = env.svc.retrieve(USER, {});
  assert.deepEqual(after.value.records.map((r) => r.id), [keeper.id],
    'expired record excluded from retrieval');
  assert.equal(after.value.total, 1, 'the expired row is not even counted');
  assert.equal(env.repo.get(shortLived.value.record.id).status, 'expired',
    'retrieve lazily persisted the expiry — it will not come back');

  // The panel can still inspect WHY it is gone via the browse path.
  const browse = env.svc.retrieve(USER, { status: 'all' });
  assert.deepEqual(browse.value.records.map((r) => r.id).sort(),
    [shortLived.value.record.id, keeper.id].sort(), "status:'all' keeps expired rows visible");

  // Second pass: nothing left to expire, and the keeper is untouched.
  env.advanceTo(T0 + 120_000);
  assert.deepEqual(env.svc.retrieve(USER, {}).value.records.map((r) => r.id), [keeper.id]);
  assert.equal(env.repo.get(keeper.id).status, 'active', 'non-expiring records stay active');
});

test('reconcile() marks due records expired at boot (injectable now, no replay)', () => {
  const env = makeService();
  const due = env.svc.write(input({ content: 'alpha due note', expiresAt: T0 + 1_000 }), USER).value.record;
  const fresh = env.svc.write(input({ content: 'bravo fresh note', expiresAt: T0 + 86_400_000 }), USER).value.record;
  const forever = env.svc.write(input({ content: 'charlie immortal note', expiresAt: null }), USER).value.record;
  assert.equal(env.repo.get(due.id).status, 'active', 'freshly written, not yet due');

  // Boot: clock advanced past the first expiry.
  env.advanceTo(T0 + 5_000);
  const rec = env.svc.reconcile();
  assert.equal(rec.loaded, 3, 'every row was examined');
  assert.equal(rec.expired, 1, 'exactly the due record expired');

  assert.equal(env.repo.get(due.id).status, 'expired', 'due record marked expired in the store');
  assert.equal(env.repo.get(fresh.id).status, 'active', 'still-valid record untouched');
  assert.equal(env.repo.get(forever.id).status, 'active', 'no-expiry record untouched');
  assert.ok(env.log.some((e) => e.event === 'memory-expired' && e.count === 1), 'expiry is audited');

  // The expired record is gone from recall, the others remain.
  const recall = env.svc.retrieve(USER, {});
  assert.deepEqual(recall.value.records.map((r) => r.id).sort(), [fresh.id, forever.id].sort());

  // reconcile is idempotent — nothing expires twice.
  const again = env.svc.reconcile();
  assert.deepEqual(again, { loaded: 3, expired: 0 });
  assert.equal(env.repo.get(due.id).status, 'expired', 'status unchanged on the second pass');
});

test('delete is soft: excluded from retrieval, user still inspects, agents are refused', () => {
  const env = makeService();
  const kept = env.svc.write(input({ content: 'still needed fact' }), USER).value.record;
  const doomed = env.svc.write(input({ content: 'obsolete fact' }), USER).value.record;

  // Only the user may delete.
  const agentDelete = env.svc.remove(doomed.id, agent('agent-1'));
  assert.equal(agentDelete.ok, false);
  assert.equal(agentDelete.code, 'PERMISSION_DENIED');

  const del = env.svc.remove(doomed.id, USER);
  assert.equal(del.ok, true, del.error);
  assert.deepEqual(del.value, { id: doomed.id });

  const row = env.repo.get(doomed.id);
  assert.equal(row.status, 'deleted', 'soft delete — the row survives for history');
  assert.equal(row.content, 'obsolete fact', 'content is preserved, not erased');
  assert.ok(env.log.some((e) => e.event === 'memory-deleted' && e.id === doomed.id));

  // Default retrieval excludes it…
  assert.deepEqual(env.svc.retrieve(USER, {}).value.records.map((r) => r.id), [kept.id]);
  assert.equal(env.svc.retrieve(USER, {}).value.total, 1);

  // …but the user (and only the user) can still open it.
  assert.equal(env.svc.get(doomed.id, USER).ok, true, 'user reads deleted rows');
  assert.equal(env.svc.get(doomed.id, agent('agent-1')).code, 'ACCESS_DENIED', 'agents never read deleted rows');
  const agentBrowse = env.svc.retrieve(agent('agent-1'), { status: 'all' });
  assert.equal(agentBrowse.value.records.some((r) => r.id === doomed.id), false,
    'even a status:all browse is ACL-filtered for agents');

  // Deleting twice is a no-op, not an error.
  assert.deepEqual(env.svc.remove(doomed.id, USER).value, { id: doomed.id });
  assert.equal(env.repo.get(doomed.id).status, 'deleted');
  assert.equal(env.svc.remove('mem-missing', USER).code, 'NOT_FOUND');
});

test("a deleted record's supersession history stays retrievable", () => {
  const env = makeService();
  const v1 = env.svc.write(input({ type: 'preference', content: 'Reply within one day' }), USER).value.record;
  const v2 = env.svc.write(input({ type: 'preference', content: 'Reply within four hours' }), USER).value.record;
  const v3 = env.svc.write(input({ type: 'preference', content: 'Reply within one hour' }), USER).value.record;
  assert.deepEqual([v1.version, v2.version, v3.version], [1, 2, 3]);

  // User deletes the CURRENT answer.
  assert.equal(env.svc.remove(v3.id, USER).ok, true);

  // The chain is still fully inspectable from the newest id…
  const fromNewest = env.svc.history(v3.id, USER);
  assert.equal(fromNewest.ok, true, fromNewest.error);
  assert.deepEqual(fromNewest.value.map((r) => r.id), [v1.id, v2.id, v3.id]);
  assert.deepEqual(fromNewest.value.map((r) => r.status), ['superseded', 'superseded', 'deleted']);

  // …and from the root of the chain.
  const fromRoot = env.svc.history(v1.id, USER);
  assert.equal(fromRoot.ok, true, fromRoot.error);
  assert.deepEqual(fromRoot.value.map((r) => r.id), [v1.id, v2.id, v3.id]);

  // Deleting the root does not break the walk either.
  assert.equal(env.svc.remove(v1.id, USER).ok, true);
  assert.deepEqual(env.svc.history(v3.id, USER).value.map((r) => r.id), [v1.id, v2.id, v3.id],
    'superseded rows stay walkable after they are deleted');

  // Agents may not inspect a deleted chain.
  assert.equal(env.svc.history(v3.id, agent('agent-1')).code, 'ACCESS_DENIED');

  // Retrieval returns nothing — the deleted answer is gone from prompts.
  assert.equal(env.svc.retrieve(USER, { type: 'preference' }).value.total, 0);
});
