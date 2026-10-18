'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { CEOLiveIntegration } = loadTs('src/main/ceoLive.ts');

function makeMockHive() {
  const tasks = [];
  const messages = [];
  const registry = {
    godId: 'god-1',
    agents: {
      'agent-1': { id: 'agent-1', name: 'Alice', role: 'researcher', capabilities: ['web'], status: 'idle', archived: false },
      'agent-2': { id: 'agent-2', name: 'Bob', role: 'engineer', capabilities: ['react'], status: 'idle', archived: false },
      'agent-3': { id: 'agent-3', name: 'Archived', role: 'qa', capabilities: [], status: 'gone', archived: true },
    },
  };

  return {
    taskStore: tasks,
    messages,
    registry() { return registry; },
    tasks() { return { tasks }; },
    addTask(task) {
      if (tasks.some((t) => t.id === task.id)) return false;
      tasks.push(task);
      return true;
    },
    patchTask(id, patch) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx < 0) return false;
      tasks[idx] = { ...tasks[idx], ...patch, id };
      return true;
    },
    send(msg) {
      messages.push(msg);
      return msg;
    },
  };
}

test('creates a goal and persists tasks to hive', () => {
  const hive = makeMockHive();
  const ceo = new CEOLiveIntegration(hive, { godId: 'god-1', persistTasks: true, deliverToInbox: true });

  const goal = ceo.createGoal('Build site', 'A test goal', 'user-1');
  ceo.addTaskPlan(goal.id, {
    title: 'Research',
    description: 'Research competitors',
    requirements: { roles: ['researcher'] },
    dependencies: [],
    acceptanceCriteria: ['Report'],
    requiresApproval: false,
  });

  const result = ceo.executeGoal(goal.id);
  assert.equal(result.errors.length, 0);
  assert.equal(result.tasksCreated, 1);
  assert.equal(result.tasksDelivered, 1);
  assert.equal(hive.taskStore.length, 1);
  assert.equal(hive.messages.length, 1);
  assert.equal(hive.messages[0].to, 'agent-1');
});

test('excludes archived agents from delegation', () => {
  const hive = makeMockHive();
  const ceo = new CEOLiveIntegration(hive, { godId: 'god-1', persistTasks: true, deliverToInbox: true });

  const goal = ceo.createGoal('Test', '', 'user-1');
  ceo.addTaskPlan(goal.id, {
    title: 'QA',
    description: 'Test it',
    requirements: { roles: ['qa'] },
    dependencies: [],
    acceptanceCriteria: [],
    requiresApproval: false,
  });

  const result = ceo.executeGoal(goal.id);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes('No agent available'));
});

test('delivers task brief to agent inbox', () => {
  const hive = makeMockHive();
  const ceo = new CEOLiveIntegration(hive, { godId: 'god-1', persistTasks: true, deliverToInbox: true });

  const goal = ceo.createGoal('Deploy', '', 'user-1');
  ceo.addTaskPlan(goal.id, {
    title: 'Deploy to prod',
    description: 'Deploy the app',
    requirements: { roles: ['engineer'] },
    dependencies: [],
    acceptanceCriteria: ['Live at URL'],
    requiresApproval: true,
  });

  ceo.executeGoal(goal.id);
  const msg = hive.messages[0];
  assert.equal(msg.act, 'request');
  assert.ok(msg.body.includes('Deploy the app'));
  assert.ok(msg.body.includes('requires approval'));
  assert.equal(msg.requires_reply, true);
});

test('updates task status via patchTask', () => {
  const hive = makeMockHive();
  const ceo = new CEOLiveIntegration(hive, { godId: 'god-1', persistTasks: true, deliverToInbox: false });

  const goal = ceo.createGoal('Test', '', 'user-1');
  ceo.addTaskPlan(goal.id, {
    title: 'Task',
    description: '',
    requirements: { roles: ['researcher'] },
    dependencies: [],
    acceptanceCriteria: [],
    requiresApproval: false,
  });

  const result = ceo.executeGoal(goal.id);
  const taskId = result.assignments[0].taskId;
  assert.equal(ceo.updateTaskStatus(taskId, 'doing'), true);
  assert.equal(hive.taskStore[0].status, 'doing');
});

test('getGoalTasks returns only tasks for this goal', () => {
  const hive = makeMockHive();
  const ceo = new CEOLiveIntegration(hive, { godId: 'god-1', persistTasks: true, deliverToInbox: false });

  const goal = ceo.createGoal('Test', '', 'user-1');
  ceo.addTaskPlan(goal.id, {
    title: 'Task A',
    description: '',
    requirements: {},
    dependencies: [],
    acceptanceCriteria: [],
    requiresApproval: false,
  });

  ceo.executeGoal(goal.id);
  const tasks = ceo.getGoalTasks(goal.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Task A');
});
