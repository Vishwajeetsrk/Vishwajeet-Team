'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { CEOOrchestrator } = loadTs('src/main/ceo.ts');

function makeAgents() {
  return [
    { id: 'a1', name: 'Alice', role: 'researcher', skills: ['web'], tools: ['browser'], status: 'idle', currentTaskId: null, permissions: ['read'] },
    { id: 'a2', name: 'Bob', role: 'engineer', skills: ['react'], tools: ['terminal', 'browser'], status: 'idle', currentTaskId: null, permissions: ['read', 'write'] },
    { id: 'a3', name: 'Carol', role: 'qa', skills: ['testing'], tools: ['terminal'], status: 'idle', currentTaskId: null, permissions: ['read'] },
  ];
}

test('creates a goal', () => {
  const ceo = new CEOOrchestrator();
  const goal = ceo.createGoal({ title: 'Test Goal', description: 'A test', createdBy: 'user1' });
  assert.ok(goal.id);
  assert.equal(goal.status, 'DRAFT');
  assert.equal(goal.taskIds.length, 0);
});

test('adds task plans to a goal', () => {
  const ceo = new CEOOrchestrator();
  const goal = ceo.createGoal({ title: 'Test', description: 'Test', createdBy: 'u' });
  ceo.addTaskPlan(goal.id, {
    title: 'Task 1',
    description: 'First task',
    requirements: {},
    dependencies: [],
    acceptanceCriteria: ['Done'],
    requiresApproval: false,
  });
  assert.equal(goal.taskIds.length, 1);
});

test('validates plan detects cycles', () => {
  const ceo = new CEOOrchestrator();
  const goal = ceo.createGoal({ title: 'Test', description: 'Test', createdBy: 'u' });
  const t1 = ceo.addTaskPlan(goal.id, { title: 'T1', description: '', requirements: { roles: ['engineer'] }, dependencies: [], acceptanceCriteria: [], requiresApproval: false });
  const t2 = ceo.addTaskPlan(goal.id, { title: 'T2', description: '', requirements: { roles: ['engineer'] }, dependencies: [t1.id], acceptanceCriteria: [], requiresApproval: false });
  t1.dependencies.push(t2.id);
  const result = ceo.validatePlan(goal.id);
  assert.equal(result.valid, false);
});

test('delegates tasks to matching agents', () => {
  const ceo = new CEOOrchestrator();
  const goal = ceo.createGoal({ title: 'Build site', description: '', createdBy: 'u' });
  ceo.addTaskPlan(goal.id, {
    title: 'Research',
    description: 'Research competitors',
    requirements: { roles: ['researcher'] },
    dependencies: [],
    acceptanceCriteria: ['Report'],
    requiresApproval: false,
  });
  ceo.addTaskPlan(goal.id, {
    title: 'Implement',
    description: 'Build the site',
    requirements: { roles: ['engineer'] },
    dependencies: [],
    acceptanceCriteria: ['Deployed'],
    requiresApproval: false,
  });

  const result = ceo.delegate(goal.id, makeAgents());
  assert.equal(result.success, true);
  assert.equal(result.assignments.length, 2);
  const names = result.assignments.map((a) => a.agentName);
  assert.ok(names.includes('Alice'));
  assert.ok(names.includes('Bob'));
});

test('blocks delegation when no agent matches', () => {
  const ceo = new CEOOrchestrator();
  const goal = ceo.createGoal({ title: 'Test', description: '', createdBy: 'u' });
  ceo.addTaskPlan(goal.id, {
    title: 'Design',
    description: '',
    requirements: { roles: ['designer'] },
    dependencies: [],
    acceptanceCriteria: [],
    requiresApproval: false,
  });
  const result = ceo.delegate(goal.id, makeAgents());
  assert.equal(result.success, false);
  assert.ok(result.errors.length > 0);
});

test('getReadyTasks returns independent tasks', () => {
  const ceo = new CEOOrchestrator();
  const goal = ceo.createGoal({ title: 'Test', description: '', createdBy: 'u' });
  const t1 = ceo.addTaskPlan(goal.id, { title: 'T1', description: '', requirements: {}, dependencies: [], acceptanceCriteria: [], requiresApproval: false });
  ceo.addTaskPlan(goal.id, { title: 'T2', description: '', requirements: {}, dependencies: [t1.id], acceptanceCriteria: [], requiresApproval: false });
  const ready = ceo.getReadyTasks(goal.id);
  assert.deepEqual(ready, [t1.id]);
});
