'use strict';

/**
 * Phase 5 — memory store contract (CRUD + restart serialization).
 *
 * REAL vs MOCK:
 * - MOCK: `MemoryMemoryRepo` — the in-memory test double exported by
 *   src/main/memoryStore.ts, explicitly labeled MOCK here. The production
 *   adapter (SqliteMemoryRepo / better-sqlite3, Electron ABI) is exercised only
 *   in the labeled harness test/computer-electron.electron.cjs.
 * - REAL: nothing else in this file — these are the repo seam's own guarantees
 *   (equality filters, fresh copies, oldest-first order, duplicate/unknown-id
 *   errors, serialize→from restart survival) that MemoryService builds on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { MemoryMemoryRepo } = loadTs('src/main/memoryStore.ts');

/** Full MemoryRecord factory — every field explicit, overrides last. */
function rec(overrides = {}) {
  return {
    id: 'mem-000000000001',
    scope: 'global',
    ownerId: 'system',
    projectId: null,
    agentId: null,
    taskId: null,
    computerId: null,
    type: 'fact',
    content: 'hello world',
    sourceKind: 'user',
    sourceRef: null,
    author: 'user',
    confidence: 0.9,
    importance: 3,
    approved: true,
    status: 'active',
    supersededBy: null,
    version: 1,
    accessList: [],
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('MOCK repo: insert/get roundtrip returns a fresh copy (no aliasing)', () => {
  const repo = new MemoryMemoryRepo();
  const original = rec({ accessList: ['agent-2'] });
  repo.insert(original);

  const got = repo.get(original.id);
  assert.ok(got, 'inserted record is readable');
  assert.deepEqual(got, original, 'full roundtrip, field for field');
  assert.notEqual(got, original, 'get must not hand out the internal row');

  // Mutating what the caller got must never reach the store.
  got.content = 'mutated by caller';
  got.accessList.push('agent-3');
  const again = repo.get(original.id);
  assert.equal(again.content, 'hello world', 'content write did not leak into the repo');
  assert.deepEqual(again.accessList, ['agent-2'], 'accessList mutation did not leak into the repo');

  assert.equal(repo.get('mem-missing'), null, 'unknown id → null, not a throw');
});

test('MOCK repo: list returns oldest-first fresh copies with equality filters', () => {
  const repo = new MemoryMemoryRepo();
  repo.insert(rec({ id: 'mem-b', content: 'project fact', scope: 'project', ownerId: 'proj-1', projectId: 'proj-1', createdAt: 20, status: 'active' }));
  repo.insert(rec({ id: 'mem-a', content: 'global fact', scope: 'global', ownerId: 'system', createdAt: 10, status: 'proposed' }));
  repo.insert(rec({ id: 'mem-c', content: 'agent fact', scope: 'agent', ownerId: 'agent-1', agentId: 'agent-1', createdAt: 30, status: 'active' }));
  repo.insert(rec({ id: 'mem-d', content: 'task fact', scope: 'task', ownerId: 'plan-1', taskId: 'plan-1', createdAt: 40, status: 'deleted' }));

  assert.deepEqual(repo.list().map((r) => r.id), ['mem-a', 'mem-b', 'mem-c', 'mem-d'], 'oldest-first');
  assert.deepEqual(repo.list({ scope: 'project' }).map((r) => r.id), ['mem-b']);
  assert.deepEqual(repo.list({ status: 'active' }).map((r) => r.id), ['mem-b', 'mem-c'], 'status filter is exact');
  assert.deepEqual(repo.list({ status: 'all' }).map((r) => r.id), ['mem-a', 'mem-b', 'mem-c', 'mem-d'], "status 'all' matches everything");
  assert.deepEqual(repo.list({ ownerId: 'system' }).map((r) => r.id), ['mem-a']);
  assert.deepEqual(repo.list({ projectId: 'proj-1' }).map((r) => r.id), ['mem-b']);
  assert.deepEqual(repo.list({ agentId: 'agent-1' }).map((r) => r.id), ['mem-c']);
  assert.deepEqual(repo.list({ taskId: 'plan-1' }).map((r) => r.id), ['mem-d']);
  assert.deepEqual(repo.list({ scope: 'global', status: 'active' }), [], 'combined filters AND together');

  // list hands out copies too.
  const listed = repo.list({ scope: 'global' })[0];
  listed.content = 'mutated';
  assert.equal(repo.list({ scope: 'global' })[0].content, 'global fact');
});

test('MOCK repo: update rewrites the row; duplicate insert and unknown update throw', () => {
  const repo = new MemoryMemoryRepo();
  const r = rec();
  repo.insert(r);

  const fresh = repo.get(r.id);
  fresh.status = 'superseded';
  fresh.supersededBy = 'mem-successor';
  fresh.version = 2;
  fresh.updatedAt = 99;
  repo.update(fresh);

  const after = repo.get(r.id);
  assert.equal(after.status, 'superseded');
  assert.equal(after.supersededBy, 'mem-successor');
  assert.equal(after.version, 2);
  assert.equal(after.updatedAt, 99);

  assert.throws(() => repo.insert(rec()), /already exists/, 'duplicate id rejected');
  assert.throws(() => repo.update(rec({ id: 'mem-nope' })), /not found/, 'unknown id update rejected');
});

test('MOCK repo: delete removes the row (hard delete — the service soft-deletes)', () => {
  const repo = new MemoryMemoryRepo();
  repo.insert(rec());
  repo.delete(rec().id);
  assert.equal(repo.get(rec().id), null, 'row gone');
  assert.deepEqual(repo.list(), [], 'listing is empty');
  assert.doesNotThrow(() => repo.delete('mem-never-existed'), 'delete is idempotent');
});

test('MOCK repo: serialize→from survives a restart, snapshot is deep', () => {
  const repo = new MemoryMemoryRepo();
  repo.insert(rec({ id: 'mem-r1', content: 'survives restart', createdAt: 1, accessList: ['agent-9'] }));
  repo.insert(rec({ id: 'mem-r2', scope: 'agent', ownerId: 'agent-1', agentId: 'agent-1', status: 'proposed', createdAt: 2 }));

  const snapshot = repo.serialize(); // "app dies here"
  assert.equal(typeof snapshot, 'string');

  // Writes after the snapshot must not appear in it (deep copy, not a view).
  repo.insert(rec({ id: 'mem-r3', content: 'written after snapshot', createdAt: 3 }));
  assert.equal(snapshot.includes('mem-r3'), false, 'snapshot must not see later writes');

  const restored = MemoryMemoryRepo.from(snapshot); // "next launch"
  assert.deepEqual(restored.list().map((r) => r.id), ['mem-r1', 'mem-r2'], 'both records survive the restart');
  assert.equal(restored.get('mem-r1').content, 'survives restart');
  assert.deepEqual(restored.get('mem-r1').accessList, ['agent-9'], 'accessList restored as a real array');
  assert.equal(restored.get('mem-r2').status, 'proposed', 'lifecycle status preserved');
  assert.notEqual(restored.get('mem-r1'), repo.get('mem-r1'), 'restored rows are independent of the live repo');

  // The restored repo is fully functional (roundtrip is not read-only).
  assert.doesNotThrow(() => restored.update(restored.get('mem-r2')));
  assert.deepEqual(restored.list({ status: 'proposed' }).map((r) => r.id), ['mem-r2']);

  // A second restart cycle still holds.
  const again = MemoryMemoryRepo.from(restored.serialize());
  assert.equal(again.list().length, 2, 'serialize→from is stable across repeated restarts');
});
