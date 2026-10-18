'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  validateDependencies,
  detectCycle,
  getReadyTasks,
  getBlockedTasks,
  topologicalSort,
} = loadTs('src/shared/dependencyGraph.ts');

test('validates dependencies exist', () => {
  const nodes = [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: [] },
  ];
  const existing = new Set(['a', 'b']);
  const result = validateDependencies(nodes, existing);
  assert.equal(result.valid, true);
});

test('detects missing dependency', () => {
  const nodes = [{ id: 'a', dependencies: ['missing'] }];
  const existing = new Set(['a']);
  const result = validateDependencies(nodes, existing);
  assert.equal(result.valid, false);
  assert.ok(result.errors[0].includes('missing'));
});

test('detects self-dependency', () => {
  const nodes = [{ id: 'a', dependencies: ['a'] }];
  const existing = new Set(['a']);
  const result = validateDependencies(nodes, existing);
  assert.equal(result.valid, false);
});

test('detects cycle', () => {
  const nodes = [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: ['c'] },
    { id: 'c', dependencies: ['a'] },
  ];
  const cycle = detectCycle(nodes);
  assert.ok(cycle);
  assert.equal(cycle.length, 3);
});

test('no cycle in valid DAG', () => {
  const nodes = [
    { id: 'a', dependencies: ['b', 'c'] },
    { id: 'b', dependencies: ['c'] },
    { id: 'c', dependencies: [] },
  ];
  const cycle = detectCycle(nodes);
  assert.equal(cycle, null);
});

test('getReadyTasks returns tasks with no incomplete dependencies', () => {
  const nodes = [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: [] },
    { id: 'c', dependencies: [] },
  ];
  const completed = new Set();
  const ready = getReadyTasks(nodes, completed);
  assert.deepEqual(ready.sort(), ['b', 'c']);
});

test('getBlockedTasks returns tasks with incomplete dependencies', () => {
  const nodes = [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: [] },
  ];
  const completed = new Set();
  const blocked = getBlockedTasks(nodes, completed);
  assert.deepEqual(blocked, ['a']);
});

test('topologicalSort orders dependencies first', () => {
  const nodes = [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: ['c'] },
    { id: 'c', dependencies: [] },
  ];
  const sorted = topologicalSort(nodes);
  assert.deepEqual(sorted, ['c', 'b', 'a']);
});
