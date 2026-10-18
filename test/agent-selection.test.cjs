'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { selectAgentForTask } = loadTs('src/shared/agentSelection.ts');

const agents = [
  { id: '1', name: 'Alice', role: 'engineer', skills: ['react', 'node'], tools: ['terminal', 'browser'], status: 'idle', currentTaskId: null, permissions: ['read', 'write'] },
  { id: '2', name: 'Bob', role: 'designer', skills: ['figma', 'css'], tools: ['browser'], status: 'idle', currentTaskId: null, permissions: ['read'] },
  { id: '3', name: 'Charlie', role: 'engineer', skills: ['python'], tools: ['terminal'], status: 'working', currentTaskId: 't1', permissions: ['read', 'write'] },
];

test('selects best matching agent by role', () => {
  const result = selectAgentForTask(agents, { roles: ['designer'] });
  assert.equal(result.selected?.name, 'Bob');
});

test('selects agent by skills', () => {
  const result = selectAgentForTask(agents, { skills: ['react'] });
  assert.equal(result.selected?.name, 'Alice');
});

test('excludes busy agents', () => {
  const result = selectAgentForTask(agents, { roles: ['engineer'] });
  assert.notEqual(result.selected?.name, 'Charlie');
});

test('returns null when no agent matches', () => {
  const result = selectAgentForTask(agents, { roles: ['nonexistent'] });
  assert.equal(result.selected, null);
  assert.ok(result.reason.length > 0);
});

test('respects required permissions', () => {
  const result = selectAgentForTask(agents, { requiredPermissions: ['write'] });
  assert.equal(result.selected?.name, 'Alice');
});

test('returns alternatives', () => {
  const result = selectAgentForTask(agents, { roles: ['engineer'] });
  assert.ok(result.alternatives.length > 0);
});

test('assigns any idle agent when task has no requirements', () => {
  const result = selectAgentForTask(agents, {});
  assert.ok(result.selected);
  assert.notEqual(result.selected.name, 'Charlie');
});
