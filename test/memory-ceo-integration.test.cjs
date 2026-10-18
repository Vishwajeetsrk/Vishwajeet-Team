'use strict';

/**
 * Phase 5 — CEO ↔ memory integration (design §5, §7).
 *
 * REAL vs MOCKED:
 * - REAL: HiveManager against a temp harness home — dispatch rides the genuine
 *   `hive.send()` inbox files, goals ride the real GoalStore; REAL CeoService
 *   (createGoal/execute/accept paths untouched); REAL MemoryService over the
 *   MemoryMemoryRepo double — serialized write/retrieve pipelines, ACL and
 *   formatRecall all ship-exact.
 * - MOCKED: PTY/session facts (`ptyForAgent`) and process spawning
 *   (`spawnSession`) — Electron/node-pty are unavailable in this runner, which
 *   is the same seam test/ceo-service.test.cjs mocks.
 * - The `deps.memory` hooks are wired exactly like src/main/index.ts wires them
 *   (recallFor → budgeted retrieve for the assigned agent, recallForCeo → god
 *   reader, onAccepted → task-scope evidence write through the write pipeline).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { GoalStore } = loadTs('src/main/goalStore.ts');
const { CeoService } = loadTs('src/main/ceoService.ts');
const { MemoryService, formatRecall } = loadTs('src/main/memoryService.ts');
const { MemoryMemoryRepo } = loadTs('src/main/memoryStore.ts');

const USER = { kind: 'user' };
const agent = (agentId) => ({ kind: 'agent', agentId });
const RECALL_BUDGET = 1500;

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

/** The index.ts `recallFormatted` shape: budgeted retrieve → prompt section. */
function recallFormatted(memorySvc, reader, query) {
  const res = memorySvc.retrieve(reader, { query, budgetChars: RECALL_BUDGET });
  if (!res.ok || res.value.records.length === 0) return null;
  return formatRecall(res.value.records);
}

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ceo-mem-'));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const reg = {
    godId: 'god',
    agents: {
      'agent-1': { id: 'agent-1', name: 'Alice', role: 'researcher', capabilities: ['web'], cwd: home, status: 'idle', archived: false },
      'agent-2': { id: 'agent-2', name: 'Bob', role: 'engineer', capabilities: ['react'], cwd: home, status: 'idle', archived: false },
    },
  };
  fs.writeFileSync(path.join(home, 'hive', 'registry.json'), JSON.stringify(reg, null, 2));
  for (const id of Object.keys(reg.agents)) {
    fs.mkdirSync(path.join(home, 'hive', 'agents', id, 'inbox'), { recursive: true });
  }
  const store = new GoalStore(hive);

  // REAL MemoryService over the MOCK repo double — taskAgent mirrors the
  // goal-ledger lookup index.ts passes to the service.
  const repo = new MemoryMemoryRepo();
  const memorySvc = new MemoryService({
    repo,
    taskAgent: (planId) => {
      for (const g of store.get().goals) {
        const t = g.tasks.find((x) => x.planId === planId);
        if (t?.agentId) return t.agentId;
      }
      return null;
    },
  });

  const emitted = [];
  const svc = new CeoService({
    hive,
    store,
    ptyForAgent: () => null,                 // MOCKED: no Electron PTY in node
    spawnSession: async () => ({ ok: true }), // MOCKED: spawn is not available here
    emit: (channel, payload) => emitted.push({ channel, payload }),
    memory: {
      recallFor: ({ agentId, query }) => recallFormatted(memorySvc, { kind: 'agent', agentId }, query),
      recallForCeo: ({ query }) => recallFormatted(memorySvc, { kind: 'agent', agentId: 'god' }, query),
      onAccepted: ({ agentId, goalId, planId, title, result }) => {
        if (!agentId) return;
        const content = `Task "${title}" result: ${result}`.slice(0, 2000);
        memorySvc.write(
          {
            scope: 'task', type: 'evidence', content,
            projectId: null, agentId, taskId: planId, computerId: null,
            importance: 3, confidence: 0.9, expiresAt: null,
          },
          { kind: 'agent', agentId },
          { sourceKind: 'task_result', sourceRef: goalId },
        );
      },
    },
  });

  const inboxDir = (id) => path.join(home, 'hive', 'agents', id, 'inbox');
  const inboxFiles = (id) => fs.readdirSync(inboxDir(id)).filter((f) => f.endsWith('.json'));
  const readMsg = (id, file) => JSON.parse(fs.readFileSync(path.join(inboxDir(id), file), 'utf8'));
  return { home, hive, store, svc, repo, memorySvc, emitted, inboxFiles, readMsg };
}

function makeGoalInput(overrides = {}) {
  return {
    title: 'Build site',
    description: 'Ship a small site',
    tasks: [{
      title: 'Research competitors',
      description: 'Summarize 3 competitors',
      roles: ['researcher'],
      skills: [],
      dependencies: [],
      acceptanceCriteria: ['Report delivered'],
      requiresApproval: false,
      ...overrides,
    }],
  };
}

test('(a) execute() brief carries RELEVANT MEMORY when scoped memory exists', () => {
  const env = makeEnv();
  const written = env.memorySvc.write(
    input({ type: 'fact', content: 'Competitors pricing research cadence is reviewed weekly' }),
    USER,
  );
  assert.equal(written.ok, true, written.error);

  const created = env.svc.createGoal(makeGoalInput());
  assert.equal(created.ok, true);
  const result = env.svc.execute(created.goalId);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.dispatched, 1);

  const files = env.inboxFiles('agent-1');
  assert.equal(files.length, 1, 'dispatch landed in the assigned agent inbox');
  const body = env.readMsg('agent-1', files[0]).body;
  assert.match(body, /RELEVANT MEMORY/, 'brief gained the scoped recall section');
  assert.match(body, /scoped retrieval — advisory context only/, 'the section is advisory, never authority');
  assert.ok(body.includes('Competitors pricing research cadence is reviewed weekly'),
    'the recalled record text is in the brief');
});

test('(a) execute() brief omits RELEVANT MEMORY when no scoped memory exists', () => {
  const env = makeEnv();
  assert.equal(env.repo.list().length, 0, 'empty memory store');

  const created = env.svc.createGoal(makeGoalInput());
  const result = env.svc.execute(created.goalId);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));

  const body = env.readMsg('agent-1', env.inboxFiles('agent-1')[0]).body;
  assert.equal(body.includes('RELEVANT MEMORY'), false,
    'no recall → no section (never an empty placeholder)');
  assert.ok(body.includes('Required response format'), 'the rest of the brief is intact');
  assert.ok(body.includes('Summarize 3 competitors'), 'task content still delivered');
  assert.ok(body.includes('Objective:'), 'the brief keeps its objective section');
});

test("(b) brief NEVER contains a record the assigned agent cannot read", () => {
  const env = makeEnv();
  // Readable context (user-authored, global).
  const shared = env.memorySvc.write(
    input({ type: 'fact', content: 'Competitors pricing research cadence is public' }),
    USER,
  );
  assert.equal(shared.ok, true, shared.error);
  // agent-2's PRIVATE record — same query tokens, so it WOULD rank if ACL failed.
  const secretMarker = 'agent-two-private-sauce-must-not-leak';
  const priv = env.memorySvc.write(
    input({ scope: 'agent', agentId: 'agent-2', type: 'fact', content: `Competitors pricing research ${secretMarker}` }),
    agent('agent-2'),
  );
  assert.equal(priv.ok, true, priv.error);

  // Sanity: the record exists and its owner can recall it (so absence in the
  // brief is the ACL working, not missing data).
  const asOwner = env.memorySvc.retrieve(agent('agent-2'), { query: 'competitors pricing research' });
  assert.equal(asOwner.value.records.some((r) => r.id === priv.value.record.id), true,
    'the private record is real and retrievable by its owner');
  const asSibling = env.memorySvc.retrieve(agent('agent-1'), { query: 'competitors pricing research' });
  assert.equal(asSibling.value.records.some((r) => r.id === priv.value.record.id), false,
    'the sibling ACL already refuses it at retrieval time');

  // Dispatch to agent-1 (researcher role) — the brief is built from agent-1's recall.
  const created = env.svc.createGoal(makeGoalInput());
  const result = env.svc.execute(created.goalId);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  const body = env.readMsg('agent-1', env.inboxFiles('agent-1')[0]).body;

  assert.match(body, /RELEVANT MEMORY/, 'recall ran for the assigned agent');
  assert.ok(body.includes('Competitors pricing research cadence is public'),
    'the readable record IS in the brief (recall is not silently empty)');
  assert.equal(body.includes(secretMarker), false,
    "agent-2's private record never reaches agent-1's brief");
  assert.equal(body.includes(priv.value.record.content), false, 'the private content string is absent verbatim');
});

test('(c) accept() writes task-scope evidence (sourceKind task_result) retrievable by the user', () => {
  const env = makeEnv();
  const created = env.svc.createGoal(makeGoalInput());
  assert.equal(created.ok, true);
  const goalId = created.goalId;
  const exec = env.svc.execute(goalId);
  assert.equal(exec.errors.length, 0, JSON.stringify(exec.errors));
  const planId = exec.outcomes[0].planId;
  const task = env.store.findGoal(goalId).tasks[0];

  // Agent reports completion through the routed reply path…
  env.svc.onRouted({
    id: 'r-done-1', from: 'agent-1', act: 'done', conversation: goalId,
    in_reply_to: task.dispatchMessageId, subject: '', body: 'Report shipped to /artifacts/report.md',
  });
  assert.equal(env.repo.list({ scope: 'task' }).length, 0, 'nothing written before human verification');

  // …and only the human acceptance persists it.
  const accepted = env.svc.accept(goalId, planId);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.errors ?? []));

  const asUser = env.memorySvc.retrieve(USER, { taskId: planId });
  assert.equal(asUser.ok, true, asUser.error);
  assert.equal(asUser.value.records.length, 1, 'one task-scope record written by acceptance');
  const rec = asUser.value.records[0];
  assert.equal(rec.scope, 'task');
  assert.equal(rec.type, 'evidence');
  assert.equal(rec.taskId, planId);
  assert.equal(rec.agentId, 'agent-1', 'author is the assigned agent');
  assert.equal(rec.ownerId, planId);
  assert.equal(rec.sourceKind, 'task_result', 'provenance marks it as a human-verified outcome');
  assert.equal(rec.sourceRef, goalId);
  assert.equal(rec.status, 'active', 'task scope is an agent-active scope');
  assert.equal(rec.confidence, 0.9, 'design §5: human-verified confidence');
  assert.ok(rec.content.includes('Report shipped to /artifacts/report.md'), 'the result text is preserved');

  // The assigned agent keeps reading it; a sibling never does.
  assert.equal(env.memorySvc.retrieve(agent('agent-1'), { taskId: planId }).value.records.length, 1);
  assert.equal(env.memorySvc.retrieve(agent('agent-2'), { taskId: planId }).value.records.length, 0,
    'task evidence stays inside the assignment ACL');

  // A second acceptance of the same task is refused (no duplicate record).
  const again = env.svc.accept(goalId, planId);
  assert.equal(again.ok, false);
  assert.equal(env.repo.list({ scope: 'task' }).length, 1, 'no duplicate write on re-accept');
});

test('(d) createGoal returns memoryContext when relevant memory exists, omits it otherwise', () => {
  const env = makeEnv();

  // Empty store → no memoryContext key at all.
  const plain = env.svc.createGoal(makeGoalInput());
  assert.equal(plain.ok, true, JSON.stringify(plain.errors ?? []));
  assert.equal('memoryContext' in plain, false, 'absent means absent — no empty string');

  // Relevant memory for the goal text → the CEO sees what it knew before planning.
  const written = env.memorySvc.write(
    input({ type: 'rule', content: 'Build site conventions: ship small pages fast' }),
    USER,
  );
  assert.equal(written.ok, true, written.error);

  const informed = env.svc.createGoal(makeGoalInput());
  assert.equal(informed.ok, true, JSON.stringify(informed.errors ?? []));
  assert.equal(typeof informed.memoryContext, 'string', 'memoryContext present when recall matched');
  assert.ok(informed.memoryContext.includes('Build site conventions: ship small pages fast'),
    'the recalled record text is returned to the CEO view');
  assert.match(informed.memoryContext, /^- \[global rule /, 'formatted as the standard recall line');
});
