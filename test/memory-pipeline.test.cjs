'use strict';

/**
 * Phase 5 — the WRITE pipeline (design §5): secret detection, dedupe,
 * supersession, approval rules, conflicts, and the metadata-only event stream.
 *
 * REAL vs MOCK:
 * - REAL: `MemoryService` (all pipeline branches) and `redactSecrets` from
 *   src/main/hive.ts — the SAME battery the write path uses as its detector, so
 *   the test proves the rejection is real rather than self-referential.
 * - MOCK: `MemoryMemoryRepo` (in-memory double) plus captured `log`/`emit`
 *   callbacks standing in for hive.appendLog / liveWebContents().send.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { MemoryService } = loadTs('src/main/memoryService.ts');
const { MemoryMemoryRepo } = loadTs('src/main/memoryStore.ts');
const { redactSecrets } = loadTs('src/main/hive.ts');

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
  const log = [];
  const emitted = [];
  const svc = new MemoryService({
    repo,
    now: () => FIXED_NOW,
    log: (evt) => log.push(evt),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    ...deps,
  });
  return { repo, svc, log, emitted };
}

test('secret content is rejected (SECRET_DETECTED) — detected by the real redactSecrets battery', () => {
  const { svc, repo, log } = makeService();
  const secrets = [
    `Deploys use the key sk-proj-AbCdEf1234567890GhIjKl in the pipeline`,
    `Bucket creds: AKIAABCDEF1234567890 on the staging account`,
    `The API call signs with bearer aBcD12345678 in staging`,
  ];
  for (const content of secrets) {
    // The detector is real: the battery would alter this exact string…
    assert.notEqual(redactSecrets(content), content, `fixture is not secret-shaped: ${content}`);

    const res = svc.write(input({ content }), USER);
    assert.equal(res.ok, false, 'write must refuse secret-shaped content');
    assert.equal(res.code, 'SECRET_DETECTED');
    assert.match(res.error, /secret or credential/);
  }
  assert.equal(repo.list().length, 0, 'nothing secret-adjacent is ever stored');
  assert.equal(log.filter((e) => e.event === 'memory-rejected').length, 3, 'each rejection audited');
  assert.ok(log.every((e) => e.reason !== 'content'), 'audit carries a reason, never the content');
});

test('duplicate normalized content → dedup:true with the existing record, no second row', () => {
  const { svc, repo, log } = makeService();
  const first = svc.write(input({ type: 'preference', content: 'Prefer tabs over spaces' }), USER);
  assert.equal(first.ok, true, first.error);

  const second = svc.write(input({ type: 'preference', content: '  prefer   TABS over spaces ' }), USER);
  assert.equal(second.ok, true, second.error);
  assert.equal(second.value.dedup, true, 'normalized duplicate detected');
  assert.equal(second.value.record.id, first.value.record.id, 'the ORIGINAL record is returned');
  assert.equal(repo.list().length, 1, 'no second row inserted');
  assert.ok(log.some((e) => e.event === 'memory-deduplicated' && e.id === first.value.record.id));

  // Different content in the same scope+owner+type is NOT a duplicate.
  const third = svc.write(input({ type: 'preference', content: 'Dark mode everywhere' }), USER);
  assert.equal(third.ok, true);
  assert.equal(third.value.dedup, undefined, 'distinct content takes the write path');
  assert.equal(repo.list().length, 2);
});

test('user conflict with an active record supersedes: version bump, superseded_by, full history', () => {
  const { svc, repo, log } = makeService();
  const v1 = svc.write(input({ type: 'preference', content: 'Ship on Thursdays' }), USER).value.record;
  assert.equal(v1.version, 1);
  assert.equal(v1.status, 'active');

  const v2res = svc.write(input({ type: 'preference', content: 'Ship on Fridays instead' }), USER);
  assert.equal(v2res.ok, true, v2res.error);
  const v2 = v2res.value.record;
  assert.equal(v2.dedup, undefined, 'different claim, not a duplicate');
  assert.notEqual(v2.id, v1.id, 'a superseding write is a NEW record');
  assert.equal(v2.version, 2, 'version bumped across the supersession');
  assert.equal(v2.status, 'active');

  const old = repo.get(v1.id);
  assert.equal(old.status, 'superseded', 'old row keeps its history, never erased');
  assert.equal(old.supersededBy, v2.id, 'superseded_by points at the successor');
  assert.equal(old.version, 1, 'the old row keeps its own version');
  assert.ok(log.some((e) => e.event === 'memory-superseded' && e.id === v1.id && e.supersededBy === v2.id));

  // Retrieval shows only the current answer…
  const active = svc.retrieve(USER, { scope: 'global' });
  assert.deepEqual(active.value.records.map((r) => r.id), [v2.id]);

  // …while history walks the whole chain, oldest → newest.
  const history = svc.history(v2.id, USER);
  assert.equal(history.ok, true, history.error);
  assert.deepEqual(history.value.map((r) => r.id), [v1.id, v2.id], 'chain ordered oldest first');
  assert.deepEqual(history.value.map((r) => r.status), ['superseded', 'active']);
  assert.deepEqual(history.value.map((r) => r.version), [1, 2]);

  // Superseding once more extends the same chain.
  const v3 = svc.write(input({ type: 'preference', content: 'Ship on Mondays now' }), USER).value.record;
  assert.equal(v3.version, 3);
  assert.deepEqual(svc.history(v3.id, USER).value.map((r) => r.id), [v1.id, v2.id, v3.id]);
});

test('agent → project/global lands PROPOSED (never active) and is invisible to prompt retrieval', () => {
  const { svc, repo } = makeService();
  const project = svc.write(
    input({ scope: 'project', projectId: 'proj-x', content: 'agent proposal for the project' }),
    agent('agent-1'),
  );
  assert.equal(project.ok, true, project.error);
  assert.equal(project.value.record.status, 'proposed', 'approval gate, design §4');
  assert.equal(project.value.record.approved, false);
  assert.equal(project.value.record.author, 'agent-1', 'author is the acting agent');
  assert.equal(project.value.record.sourceKind, 'agent');

  const global = svc.write(input({ scope: 'global', content: 'agent proposal for global rules' }), agent('agent-1'));
  assert.equal(global.ok, true, global.error);
  assert.equal(global.value.record.status, 'proposed');
  assert.equal(global.value.record.ownerId, 'system');

  // Prompt-bound retrieval is active-only — proposals never reach a brief.
  const recall = svc.retrieve(agent('agent-1'), {});
  assert.equal(recall.ok, true);
  assert.deepEqual(recall.value.records, [], 'proposed records are excluded from retrieval');
  assert.equal(recall.value.total, 0);

  // The UI browse path (status:'all') still sees them for approval.
  const browse = svc.retrieve(USER, { status: 'all' });
  assert.equal(browse.value.records.length, 2, 'proposed rows visible when status is all');

  // Only the user can approve — then they become active.
  const denied = svc.approve(project.value.record.id, agent('agent-1'));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  const approved = svc.approve(project.value.record.id, USER);
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.value.status, 'active');
  assert.equal(approved.value.approved, true);
  assert.equal(repo.get(project.value.record.id).status, 'active');
  assert.equal(svc.retrieve(agent('agent-1'), { scope: 'project', readerProjectId: 'proj-x' }).value.total, 1,
    'approved proposal now recallable');
});

test('agent conflict with an APPROVED active record → CONFLICT (approved decisions outrank agents)', () => {
  const { svc, repo } = makeService();
  const decided = svc.write(
    input({ scope: 'project', projectId: 'proj-x', type: 'decision', content: 'Adopt SQLite for all persistence' }),
    USER,
  ).value.record;
  assert.equal(decided.approved, true, 'user decisions are approved');

  const clash = svc.write(
    input({ scope: 'project', projectId: 'proj-x', type: 'decision', content: 'Adopt flat files for all persistence' }),
    agent('agent-1'),
  );
  assert.equal(clash.ok, false, 'an agent may not override an approved decision');
  assert.equal(clash.code, 'CONFLICT');
  assert.match(clash.error, /approved record/);

  const survivor = repo.get(decided.id);
  assert.equal(survivor.status, 'active', 'the approved record is untouched');
  assert.equal(survivor.supersededBy, null);
  assert.equal(repo.list().length, 1, 'the rejected write inserted nothing');
});

test('agent conflict with its OWN unapproved active record supersedes (latest same-class wins)', () => {
  const { svc } = makeService();
  const first = svc.write(
    input({ scope: 'agent', agentId: 'agent-1', type: 'preference', content: 'Prefer vim keybindings' }),
    agent('agent-1'),
  );
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.record.status, 'active');
  assert.equal(first.value.record.approved, false, 'own-scope writes are active but never user-approved');

  const second = svc.write(
    input({ scope: 'agent', agentId: 'agent-1', type: 'preference', content: 'Prefer emacs keybindings' }),
    agent('agent-1'),
  );
  assert.equal(second.ok, true, second.error);
  assert.equal(second.value.dedup, undefined);
  assert.equal(second.value.record.version, 2, 'superseded, not conflicted');
  assert.equal(second.value.record.status, 'active');

  const old = svc.get(first.value.record.id, agent('agent-1'));
  assert.equal(old.ok, true, 'history stays inspectable for the owner');
  assert.equal(old.value.status, 'superseded');
  assert.equal(old.value.supersededBy, second.value.record.id);
});

test('events: durable log carries metadata only (no content), emit rings memory:updated', () => {
  const { svc, repo, log, emitted } = makeService();
  const marker = 'Quarterly revenue target is 42 million dollars';
  const writeRes = svc.write(input({ type: 'fact', content: marker }), USER);
  assert.equal(writeRes.ok, true, writeRes.error);
  const id = writeRes.value.record.id;

  svc.edit(id, { content: null, importance: 5, confidence: null, expiresAt: undefined }, USER);
  svc.retrieve(USER, { query: 'revenue target' });
  svc.remove(id, USER);

  // 1. Every log entry is a memory event…
  assert.ok(log.length >= 4, `expected several events, got ${log.length}`);
  for (const evt of log) {
    assert.equal(evt.kind, 'memory', 'durable events are tagged kind:memory');
    assert.equal('content' in evt, false, `content field leaked into ${JSON.stringify(evt)}`);
    assert.equal('query' in evt, false, 'query text never reaches the log');
  }

  // 2. …and the record's content never appears anywhere in the serialized log.
  assert.equal(JSON.stringify(log).includes(marker), false, 'record content leaked into the audit log');
  assert.ok(log.some((e) => e.event === 'memory-written' && e.id === id && e.status === 'active' && e.actor === 'user'));
  assert.ok(log.some((e) => e.event === 'memory-updated'), 'field edit audited');
  assert.ok(log.some((e) => e.event === 'memory-retrieved' && typeof e.count === 'number' && typeof e.chars === 'number'),
    'retrieval logs counts and sizes only');
  assert.ok(log.some((e) => e.event === 'memory-deleted' && e.id === id));

  // 3. The renderer push fired on every mutation, metadata only.
  const rings = emitted.filter((e) => e.channel === 'memory:updated');
  assert.ok(rings.length >= 4, `memory:updated ring missing (got ${rings.length})`);
  for (const { payload } of rings) {
    assert.equal(typeof payload.reason, 'string', 'ring names the reason');
    assert.equal('content' in payload, false, 'ring never carries content');
  }
  assert.ok(rings.some((e) => e.payload.reason === 'memory-written' && e.payload.id === id));
  assert.ok(rings.some((e) => e.payload.reason === 'memory-deleted' && e.payload.id === id));
  assert.equal(JSON.stringify(emitted).includes(marker), false, 'content never crosses the renderer push');
  assert.equal(repo.get(id).status, 'deleted', 'delete is soft — the row survives for history');
});

test('structure guards re-run in the service (non-IPC callers cannot bypass validation)', () => {
  const { svc, repo } = makeService();
  const cases = [
    { content: '   ', code: 'VALIDATION', re: /non-empty string/ },
    { content: 'x'.repeat(2001), code: 'VALIDATION', re: /exceeds 2000 characters/ },
    { scope: 'universe', code: 'VALIDATION', re: /unknown scope/ },
  ];
  for (const c of cases) {
    const res = svc.write(input(c), USER);
    assert.equal(res.ok, false, `guard missed: ${JSON.stringify(c)}`);
    assert.equal(res.code, c.code);
    assert.match(res.error, c.re);
  }
  // A scope missing its primary reference never reaches the repo either.
  const noOwner = svc.write(input({ scope: 'task', taskId: null, content: 'orphan task memory' }), USER);
  assert.equal(noOwner.ok, false);
  assert.equal(noOwner.code, 'VALIDATION');
  assert.equal(repo.list().length, 0, 'every rejected write persisted nothing');
});
