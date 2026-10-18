'use strict';

/**
 * Phase 3 service tests.
 *
 * REAL vs MOCKED:
 * - REAL: HiveManager against a temp harness home — messages are written to
 *   actual inbox files through the genuine `hive.send()` router, tasks through
 *   the genuine tasks.json ledger, goals through the real GoalStore.
 * - MOCKED: PTY/session facts (`ptyForAgent`) and agent process spawning
 *   (`spawnSession`) — Electron/node-pty are not available in this runner.
 *   Reply delivery into `onRouted` simulates the routed-observer fan-out that
 *   index.ts wires to the live 1.5s outbox router.
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

function makeEnv({ disabled = false, spawnResult = { ok: true } } = {}) {
  const home = disabled ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'md-ceo-svc-'));
  const hive = new HiveManager(() => home);
  if (home) {
    hive.ensureHive();
    const reg = {
      godId: 'god',
      agents: {
        'agent-1': { id: 'agent-1', name: 'Alice', role: 'researcher', capabilities: ['web'], cwd: home, status: 'idle', archived: false },
        'agent-2': { id: 'agent-2', name: 'Bob', role: 'engineer', capabilities: ['react'], cwd: home, status: 'idle', archived: false },
        'agent-3': { id: 'agent-3', name: 'Old QA', role: 'qa', capabilities: [], cwd: home, status: 'gone', archived: true },
      },
    };
    fs.writeFileSync(path.join(home, 'hive', 'registry.json'), JSON.stringify(reg, null, 2));
    for (const id of Object.keys(reg.agents)) {
      fs.mkdirSync(path.join(home, 'hive', 'agents', id, 'inbox'), { recursive: true });
    }
  }
  const store = new GoalStore(hive);
  const ptyMap = new Map();
  const emitted = [];
  const spawnCalls = [];
  const svc = new CeoService({
    hive,
    store,
    ptyForAgent: (id) => ptyMap.get(id) ?? null,
    spawnSession: async (id) => {
      spawnCalls.push(id);
      if (spawnResult.ok) ptyMap.set(id, `pty-${id}`);
      return spawnResult;
    },
    emit: (channel, payload) => emitted.push({ channel, payload }),
  });
  const inboxDir = (id) => path.join(home, 'hive', 'agents', id, 'inbox');
  const inboxFiles = (id) => (home ? fs.readdirSync(inboxDir(id)).filter((f) => f.endsWith('.json')) : []);
  const ledger = () => (home ? hive.tasks().tasks : []);
  return { home, hive, store, svc, ptyMap, emitted, spawnCalls, inboxFiles, inboxDir, ledger };
}

function readMsg(env, agentId, file) {
  return JSON.parse(fs.readFileSync(path.join(env.inboxDir(agentId), file), 'utf8'));
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

function snapshotTask(env, goalId, planId) {
  const fresh = new GoalStore(env.hive);
  const goal = fresh.findGoal(goalId);
  assert.ok(goal, 'goal restored from disk');
  return goal.tasks.find((t) => t.planId === planId);
}

// ─── 4+5: dispatch through the real mailbox with correlation ────────────────

test('execute dispatches through the real mailbox: card + inbox file + correlation', () => {
  const env = makeEnv();
  const created = env.svc.createGoal(makeGoalInput());
  assert.equal(created.ok, true);
  const goalId = created.goalId;

  const result = env.svc.execute(goalId);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.dispatched, 1);

  // Ledger card through the genuine tasks.json path.
  const cards = env.ledger();
  assert.equal(cards.length, 1);
  const planId = result.outcomes[0].planId;
  assert.equal(cards[0].id, planId);
  assert.equal(cards[0].assignee, 'agent-1');
  assert.equal(cards[0].status, 'todo');

  // Inbox file through the genuine hive.send() router.
  const files = env.inboxFiles('agent-1');
  assert.equal(files.length, 1);
  const msg = readMsg(env, 'agent-1', files[0]);
  assert.equal(msg.act, 'request');
  assert.equal(msg.conversation, goalId);
  assert.equal(msg.from, 'god');
  assert.equal(msg.requires_reply, true);
  assert.ok(msg.body.includes(`GOAL=${goalId}`));
  assert.ok(msg.body.includes(`TASK=${planId}`));
  assert.ok(msg.body.includes('Report delivered'));
  assert.ok(msg.body.includes('Required response format'));

  // Runtime record persisted with dispatch evidence.
  const task = snapshotTask(env, goalId, planId);
  assert.equal(task.state, 'ASSIGNED');
  assert.equal(task.agentId, 'agent-1');
  assert.equal(task.dispatchMessageId, msg.id);
  assert.equal(task.attempts, 1);
  assert.equal(task.sessionState, 'offline', 'no live PTY — honestly offline');
  assert.ok(task.events.some((e) => e.kind === 'dispatched' && e.messageId === msg.id));
});

// ─── 6: unavailable agent ───────────────────────────────────────────────────

test('archived agents are never dispatched to; failure is surfaced', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput({ roles: ['qa'] })).goalId;
  const result = env.svc.execute(goalId);
  assert.equal(result.dispatched, 0);
  assert.ok(result.errors.some((e) => e.includes('No agent available')));
  assert.equal(env.inboxFiles('agent-3').length, 0, 'archived agent inbox untouched');
  assert.equal(env.ledger().length, 0, 'no card written for an unassigned task');
  const planId = result.outcomes[0].planId;
  assert.equal(result.outcomes[0].state, 'BLOCKED');
  const task = snapshotTask(env, goalId, planId);
  assert.equal(task.state, 'BLOCKED');
  assert.ok(task.error);
});

// ─── 7: dependency enforcement + multi-wave ─────────────────────────────────

test('dependencies gate dispatch; completing wave 1 enables wave 2', () => {
  const env = makeEnv();
  const created = env.svc.createGoal({
    title: 'Pipeline',
    description: '',
    tasks: [
      { title: 'Design', description: '', roles: ['researcher'], skills: [], dependencies: [], acceptanceCriteria: [], requiresApproval: false },
      { title: 'Build', description: '', roles: ['engineer'], skills: [], dependencies: [0], acceptanceCriteria: [], requiresApproval: false },
    ],
  });
  const goalId = created.goalId;

  const wave1 = env.svc.execute(goalId);
  assert.equal(wave1.dispatched, 1);
  const [design, build] = wave1.outcomes;
  assert.ok(design.ok);
  assert.ok(!build.ok);
  assert.equal(build.detail, 'waiting on dependencies');
  assert.equal(env.inboxFiles('agent-1').length + env.inboxFiles('agent-2').length, 1, 'only wave 1 dispatched');

  // Complete wave 1 through the reply path + human acceptance.
  const dispatchFile = env.inboxFiles('agent-1')[0];
  const dispatchMsg = readMsg(env, 'agent-1', dispatchFile);
  env.svc.onRouted({ ...dispatchMsg, id: 'r-agree-1', from: 'agent-1', act: 'agree', in_reply_to: dispatchMsg.id, conversation: goalId, body: 'on it' });
  env.svc.onRouted({ ...dispatchMsg, id: 'r-done-1', from: 'agent-1', act: 'done', in_reply_to: dispatchMsg.id, conversation: goalId, body: 'design ready at /docs/design.md' });
  assert.equal(env.svc.accept(goalId, design.planId).ok, true);

  const wave2 = env.svc.execute(goalId);
  assert.equal(wave2.dispatched, 1, 'dependency satisfied — build dispatched');
  const engineerFiles = env.inboxFiles('agent-2');
  assert.equal(engineerFiles.length, 1);
  assert.equal(snapshotTask(env, goalId, build.planId).state, 'ASSIGNED');
});

// ─── 8: duplicate dispatch prevention ───────────────────────────────────────

test('re-running execute never double-dispatches', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const again = env.svc.execute(goalId);
  assert.equal(again.dispatched, 0);
  assert.ok(again.outcomes[0].detail.includes('already dispatched'));
  assert.equal(env.inboxFiles('agent-1').length, 1, 'still exactly one message');
  const goal = env.store.findGoal(goalId);
  assert.equal(goal.tasks[0].attempts, 1, 'attempt counter unchanged');
});

// ─── 9: acknowledgement + progress ──────────────────────────────────────────

test('agree starts the task; ledger flips to doing; reply is deduplicated', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const goal = env.store.findGoal(goalId);
  const task = goal.tasks[0];
  const dispatchId = task.dispatchMessageId;

  const reply = { id: 'r-1', from: 'agent-1', act: 'agree', in_reply_to: dispatchId, conversation: goalId, subject: '', body: 'starting' };
  env.svc.onRouted(reply);
  assert.equal(snapshotTask(env, goalId, task.planId).state, 'RUNNING');
  assert.equal(env.ledger()[0].status, 'doing');

  const eventsBefore = snapshotTask(env, goalId, task.planId).events.length;
  env.svc.onRouted(reply); // duplicate delivery
  assert.equal(snapshotTask(env, goalId, task.planId).events.length, eventsBefore, 'duplicate ignored');
});

// ─── 10: completion verification / acceptance gate ──────────────────────────

test('done moves to REVIEW with result; only human accept completes', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];

  env.svc.onRouted({ id: 'r-done', from: 'agent-1', act: 'done', in_reply_to: task.dispatchMessageId, conversation: goalId, body: 'Report at artifacts/report.md' });
  const reviewed = snapshotTask(env, goalId, task.planId);
  assert.equal(reviewed.state, 'REVIEW', 'agent claim never auto-completes');
  assert.equal(reviewed.result, 'Report at artifacts/report.md');
  assert.equal(env.ledger()[0].status, 'doing', 'still in progress on the kanban');
  assert.equal(env.store.findGoal(goalId).status, 'ACTIVE', 'goal not complete until accepted');

  assert.equal(env.svc.accept(goalId, task.planId).ok, true);
  const done = snapshotTask(env, goalId, task.planId);
  assert.equal(done.state, 'COMPLETED');
  assert.equal(env.ledger()[0].status, 'done');
  assert.equal(env.ledger()[0].result, 'Report at artifacts/report.md');
  assert.equal(env.store.findGoal(goalId).status, 'COMPLETED');
});

test('accept is refused without a recorded result and from non-review states', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];

  const early = env.svc.accept(goalId, task.planId);
  assert.equal(early.ok, false);
  assert.ok(early.errors[0].includes('ASSIGNED'));

  // done with an empty body → no result → acceptance refused
  env.svc.onRouted({ id: 'r-empty', from: 'agent-1', act: 'done', in_reply_to: task.dispatchMessageId, conversation: goalId, body: '   ' });
  const noResult = env.svc.accept(goalId, task.planId);
  assert.equal(noResult.ok, false);
  assert.ok(noResult.errors[0].includes('no result'));
});

// ─── 11: invalid, duplicated, delayed and unrelated responses ───────────────

test('malformed, spoofed, unrelated and late replies are handled safely', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];
  const dispatchId = task.dispatchMessageId;
  const state = () => snapshotTask(env, goalId, task.planId).state;

  // Unrelated conversation
  env.svc.onRouted({ id: 'x-1', from: 'agent-1', act: 'done', in_reply_to: dispatchId, conversation: 'some-other-goal', body: 'hi' });
  assert.equal(state(), 'ASSIGNED');

  // Wrong sender (origin validation): reply id matches, sender does not
  env.svc.onRouted({ id: 'x-2', from: 'agent-2', act: 'done', in_reply_to: dispatchId, conversation: goalId, body: 'spoof' });
  assert.equal(state(), 'ASSIGNED');

  // Missing conversation entirely
  env.svc.onRouted({ id: 'x-3', from: 'agent-1', act: 'done', in_reply_to: dispatchId, conversation: '', body: 'nope' });
  assert.equal(state(), 'ASSIGNED');

  // Our own dispatch message echoing through the router is ignored
  const dispatchMsg = readMsg(env, 'agent-1', env.inboxFiles('agent-1')[0]);
  env.svc.onRouted(dispatchMsg);
  assert.equal(state(), 'ASSIGNED');

  // Out-of-order: agree AFTER done must not regress REVIEW → RUNNING
  env.svc.onRouted({ id: 'x-4', from: 'agent-1', act: 'done', in_reply_to: dispatchId, conversation: goalId, body: 'finished' });
  assert.equal(state(), 'REVIEW');
  env.svc.onRouted({ id: 'x-5', from: 'agent-1', act: 'agree', in_reply_to: dispatchId, conversation: goalId, body: 'late ack' });
  assert.equal(state(), 'REVIEW', 'late agree ignored');
  const events = snapshotTask(env, goalId, task.planId).events;
  assert.ok(events.some((e) => e.kind === 'accepted:ignored'));
});

test('refuse blocks the task; query parks it in WAITING', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];
  const dispatchId = task.dispatchMessageId;

  env.svc.onRouted({ id: 'q-1', from: 'agent-1', act: 'query', in_reply_to: dispatchId, conversation: goalId, body: 'Which competitors?' });
  assert.equal(snapshotTask(env, goalId, task.planId).state, 'WAITING');
  assert.equal(env.ledger()[0].status, 'blocked');

  env.svc.onRouted({ id: 'q-2', from: 'agent-1', act: 'refuse', in_reply_to: dispatchId, conversation: goalId, body: 'out of scope' });
  const blocked = snapshotTask(env, goalId, task.planId);
  assert.equal(blocked.state, 'BLOCKED');
  assert.ok(blocked.error.includes('out of scope'));
});

// ─── 12: PTY startup failure + unexpected exit (MOCKED spawn) ───────────────

test('spawn failure is surfaced without changing task state', async () => {
  const env = makeEnv({ spawnResult: { ok: false, error: 'ENOENT: cli missing' } });
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];

  const res = await env.svc.ensureSession('agent-1');
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('ENOENT'));
  assert.deepEqual(env.spawnCalls, ['agent-1'], 'went through the injected lifecycle, not a second dispatcher');
  const after = snapshotTask(env, goalId, task.planId);
  assert.equal(after.state, 'ASSIGNED', 'state unchanged on spawn failure');
  assert.equal(after.sessionState, 'offline');
  assert.ok(after.error.includes('session spawn failed'));
});

test('successful ensureSession flips sessionState to starting', async () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const res = await env.svc.ensureSession('agent-1');
  assert.equal(res.ok, true);
  assert.equal(snapshotTask(env, goalId, env.store.findGoal(goalId).tasks[0].planId).sessionState, 'starting');
});

test('unexpected PTY exit blocks active tasks with the exit code', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];
  env.svc.onRouted({ id: 'e-1', from: 'agent-1', act: 'agree', in_reply_to: task.dispatchMessageId, conversation: goalId, body: 'go' });

  env.svc.noteSessionExit('agent-1', 1);
  const after = snapshotTask(env, goalId, task.planId);
  assert.equal(after.state, 'BLOCKED');
  assert.equal(after.sessionState, 'offline');
  assert.ok(after.error.includes('code 1'));
  assert.equal(env.ledger()[0].status, 'blocked');
});

// ─── 13: cancellation + bounded retries ─────────────────────────────────────

test('task cancellation removes the card, notifies the agent, is terminal', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];
  const before = env.inboxFiles('agent-1').length;

  const res = env.svc.cancel(goalId, task.planId);
  assert.equal(res.ok, true);
  const cancelled = snapshotTask(env, goalId, task.planId);
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(env.ledger().length, 0, 'card removed via upstream dismiss semantics');
  assert.equal(env.inboxFiles('agent-1').length, before + 1, 'cancellation notice sent');

  const again = env.svc.cancel(goalId, task.planId);
  assert.equal(again.ok, false, 'terminal states are not re-cancelled');
  assert.equal(env.svc.accept(goalId, task.planId).ok, false, 'cancelled tasks cannot be accepted');
});

test('redelivery is explicit and bounded by maxAttempts', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const goal = env.store.findGoal(goalId);
  const task = goal.tasks[0];
  const firstMsgId = task.dispatchMessageId;

  // Simulate a lost dispatch: file vanished, no reply ever arrived.
  fs.unlinkSync(path.join(env.inboxDir('agent-1'), `${firstMsgId}.json`));

  const res = env.svc.redeliver(goalId, task.planId);
  assert.equal(res.ok, true);
  const after = snapshotTask(env, goalId, task.planId);
  assert.equal(after.attempts, 2);
  assert.notEqual(after.dispatchMessageId, firstMsgId, 'new correlation id');
  assert.equal(env.inboxFiles('agent-1').length, 1, 'resent once');

  // Exhaust the budget.
  const doc = env.store.get();
  doc.goals[0].tasks[0].attempts = doc.goals[0].tasks[0].maxAttempts;
  env.store.persist(doc);
  const exhausted = env.svc.redeliver(goalId, task.planId);
  assert.equal(exhausted.ok, false);
  assert.ok(exhausted.errors[0].includes('exhausted'));
  assert.equal(env.inboxFiles('agent-1').length, 1, 'no send after exhaustion');
});

// ─── 14: restart reconciliation without blind redispatch ────────────────────

test('restart: state restored, no redispatch, awaiting-session recorded', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];
  assert.equal(env.inboxFiles('agent-1').length, 1);

  // Cold restart: brand-new store + service, same hive on disk.
  const store2 = new GoalStore(env.hive);
  const svc2 = new CeoService({
    hive: env.hive,
    store: store2,
    ptyForAgent: () => null,
    emit: () => {},
  });
  svc2.reconcile();

  const restored = store2.findGoal(goalId);
  assert.ok(restored, 'goal survives restart');
  const t = restored.tasks[0];
  assert.equal(t.state, 'ASSIGNED');
  assert.equal(t.dispatchMessageId, task.dispatchMessageId, 'correlation preserved');
  assert.equal(t.sessionState, 'offline');
  assert.ok(t.events.some((e) => e.kind === 'reconciled:awaiting-session'));
  assert.equal(env.inboxFiles('agent-1').length, 1, 'NO duplicate dispatch on restart');
});

test('restart: consumed dispatch with no reply is recorded, not resent', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];
  const inbox = env.inboxDir('agent-1');
  fs.mkdirSync(path.join(inbox, '.done'), { recursive: true });
  fs.renameSync(path.join(inbox, `${task.dispatchMessageId}.json`), path.join(inbox, '.done', `${task.dispatchMessageId}.json`));

  const store2 = new GoalStore(env.hive);
  const svc2 = new CeoService({ hive: env.hive, store: store2, ptyForAgent: () => null, emit: () => {} });
  svc2.reconcile();

  const t = store2.findGoal(goalId).tasks[0];
  assert.equal(t.state, 'ASSIGNED', 'uncertain task keeps its state');
  assert.ok(t.events.some((e) => e.kind === 'reconciled:mailbox-consumed'));
  assert.equal(env.inboxFiles('agent-1').length, 0, 'nothing re-sent automatically');
});

test('restart: RUNNING task with a lost session becomes BLOCKED', () => {
  const env = makeEnv();
  const goalId = env.svc.createGoal(makeGoalInput()).goalId;
  env.svc.execute(goalId);
  const task = env.store.findGoal(goalId).tasks[0];
  env.svc.onRouted({ id: 'a-1', from: 'agent-1', act: 'agree', in_reply_to: task.dispatchMessageId, conversation: goalId, body: 'go' });
  assert.equal(snapshotTask(env, goalId, task.planId).state, 'RUNNING');

  const store2 = new GoalStore(env.hive);
  const svc2 = new CeoService({ hive: env.hive, store: store2, ptyForAgent: () => null, emit: () => {} });
  svc2.reconcile();

  const t = store2.findGoal(goalId).tasks[0];
  assert.equal(t.state, 'BLOCKED');
  assert.ok(t.error.includes('session lost'));
  assert.equal(env.inboxFiles('agent-1').length, 1, 'no redispatch during reconcile');
});

// ─── hive disabled ──────────────────────────────────────────────────────────

test('hive disabled: honest error, no partial writes', () => {
  const env = makeEnv({ disabled: true });
  const res = env.svc.createGoal(makeGoalInput());
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes('hive disabled'));
});
