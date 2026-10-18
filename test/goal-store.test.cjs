'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { GoalStore, validateGoalsFile, GOALS_SCHEMA_VERSION, MAX_EVENTS_PER_TASK, MAX_PROCESSED_MESSAGES } = loadTs('src/main/goalStore.ts');

function makeHive() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-goal-store-'));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { hive, home, goalsPath: path.join(home, 'hive', 'goals.json') };
}

function sampleGoal(id = 'goal-1') {
  return {
    id,
    title: 'Build site',
    description: 'A test goal',
    status: 'DRAFT',
    taskIds: ['plan-1'],
    createdBy: 'human',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    plans: [{
      id: 'plan-1',
      title: 'Research',
      description: 'Research competitors',
      requirements: { roles: ['researcher'] },
      dependencies: [],
      acceptanceCriteria: ['Report'],
      requiresApproval: false,
    }],
    tasks: [{
      planId: 'plan-1',
      state: 'PLANNED',
      agentId: null,
      agentName: null,
      agentRole: null,
      dispatchMessageId: null,
      attempts: 0,
      maxAttempts: 3,
      sessionState: 'unknown',
      result: null,
      error: null,
      events: [],
      updatedAt: new Date().toISOString(),
    }],
    processedMessageIds: [],
  };
}

test('persists a goal and restores it in a fresh store (restart)', () => {
  const { hive, goalsPath } = makeHive();
  const store = new GoalStore(hive);
  store.mutate((doc) => doc.goals.push(sampleGoal()));

  assert.ok(fs.existsSync(goalsPath), 'goals.json written to hive root');

  // Simulate restart: new store instance, cold cache.
  const reloaded = new GoalStore(hive);
  const doc = reloaded.load();
  assert.equal(doc.version, GOALS_SCHEMA_VERSION);
  assert.equal(doc.goals.length, 1);
  assert.equal(doc.goals[0].title, 'Build site');
  assert.equal(doc.goals[0].plans[0].requirements.roles[0], 'researcher');
  assert.equal(doc.goals[0].tasks[0].state, 'PLANNED');
  assert.equal(reloaded.findGoal('goal-1').plans[0].id, 'plan-1');
});

test('writes are atomic — no temp files left behind', () => {
  const { hive, home, goalsPath } = makeHive();
  const store = new GoalStore(hive);
  store.mutate((doc) => doc.goals.push(sampleGoal()));
  store.mutate((doc) => { doc.goals[0].title = 'Renamed'; });

  const root = path.join(home, 'hive');
  const leftovers = fs.readdirSync(root).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  const parsed = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  assert.equal(parsed.goals[0].title, 'Renamed');
});

test('corrupt JSON is quarantined, not overwritten silently', () => {
  const { hive, goalsPath } = makeHive();
  fs.writeFileSync(goalsPath, '{ this is not json', 'utf8');

  const store = new GoalStore(hive);
  const doc = store.load();
  assert.equal(doc.goals.length, 0, 'fresh document after quarantine');
  assert.ok(!fs.existsSync(goalsPath), 'corrupt file moved away');
  const siblings = fs.readdirSync(path.dirname(goalsPath)).filter((f) => f.startsWith('goals.json.corrupt-'));
  assert.equal(siblings.length, 1, 'quarantine copy retained for inspection');
});

test('unsupported schema version is quarantined', () => {
  const { hive, goalsPath } = makeHive();
  fs.writeFileSync(goalsPath, JSON.stringify({ version: 99, goals: [] }), 'utf8');

  const store = new GoalStore(hive);
  const doc = store.load();
  assert.equal(doc.version, GOALS_SCHEMA_VERSION);
  assert.equal(doc.goals.length, 0);
  const siblings = fs.readdirSync(path.dirname(goalsPath)).filter((f) => f.startsWith('goals.json.corrupt-'));
  assert.equal(siblings.length, 1);
});

test('invalid entries are dropped individually; valid ones survive', () => {
  const good = sampleGoal('good');
  const bad = { id: 'bad', title: 'x', status: 'NOT_A_STATUS' };
  const outcome = validateGoalsFile({ version: 1, savedAt: new Date().toISOString(), goals: [good, bad] });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.doc.goals.length, 1);
  assert.equal(outcome.doc.goals[0].id, 'good');
  assert.ok(outcome.issues.length >= 1, 'issue reported for dropped entry');

  const planless = validateGoalsFile({ version: 1, goals: [{ ...good, plans: [{ title: 'no id' }] }] });
  assert.equal(planless.ok, true);
  assert.equal(planless.doc.goals[0].plans.length, 0, 'invalid plan dropped');
});

test('validation rejects wrong container shapes and caps collections', () => {
  assert.equal(validateGoalsFile(null).ok, false);
  assert.equal(validateGoalsFile([]).ok, false);
  assert.equal(validateGoalsFile({ version: 2, goals: [] }).ok, false);
  assert.equal(validateGoalsFile({ version: 1, goals: 'nope' }).ok, false);

  const goal = sampleGoal();
  goal.processedMessageIds = Array.from({ length: MAX_PROCESSED_MESSAGES + 50 }, (_, i) => `m${i}`);
  goal.tasks[0].events = Array.from({ length: MAX_EVENTS_PER_TASK + 20 }, (_, i) => ({
    at: new Date().toISOString(), kind: 'k', detail: `${i}`,
  }));
  const outcome = validateGoalsFile({ version: 1, goals: [goal] });
  assert.ok(outcome.doc.goals[0].processedMessageIds.length <= MAX_PROCESSED_MESSAGES);
  assert.ok(outcome.doc.goals[0].tasks[0].events.length <= MAX_EVENTS_PER_TASK);
});

test('missing goals.json yields an empty document without creating a file', () => {
  const { hive, goalsPath } = makeHive();
  const store = new GoalStore(hive);
  const doc = store.load();
  assert.equal(doc.goals.length, 0);
  assert.ok(!fs.existsSync(goalsPath), 'no eager write on read');
});

test('mutate is idempotent for repeated identical upserts', () => {
  const { hive, goalsPath } = makeHive();
  const store = new GoalStore(hive);
  store.mutate((doc) => {
    if (!doc.goals.some((g) => g.id === 'goal-1')) doc.goals.push(sampleGoal());
  });
  store.mutate((doc) => {
    if (!doc.goals.some((g) => g.id === 'goal-1')) doc.goals.push(sampleGoal());
  });
  const parsed = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  assert.equal(parsed.goals.length, 1, 'no duplicate goal records');
});
