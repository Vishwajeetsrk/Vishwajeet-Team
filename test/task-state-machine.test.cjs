'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  TaskState,
  isValidTransition,
  getAllowedTransitions,
  isTerminalState,
  isActiveState,
  assertValidTransition,
} = loadTs('src/shared/taskStateMachine.ts');

test('valid transitions from CREATED', () => {
  assert.equal(isValidTransition(TaskState.CREATED, TaskState.PLANNED), true);
  assert.equal(isValidTransition(TaskState.CREATED, TaskState.CANCELLED), true);
  assert.equal(isValidTransition(TaskState.CREATED, TaskState.RUNNING), false);
});

test('valid transitions from RUNNING', () => {
  assert.equal(isValidTransition(TaskState.RUNNING, TaskState.REVIEW), true);
  assert.equal(isValidTransition(TaskState.RUNNING, TaskState.FAILED), true);
  assert.equal(isValidTransition(TaskState.RUNNING, TaskState.WAITING), true);
  assert.equal(isValidTransition(TaskState.RUNNING, TaskState.BLOCKED), true);
  assert.equal(isValidTransition(TaskState.RUNNING, TaskState.COMPLETED), false);
});

test('valid transitions from REVIEW', () => {
  assert.equal(isValidTransition(TaskState.REVIEW, TaskState.COMPLETED), true);
  assert.equal(isValidTransition(TaskState.REVIEW, TaskState.FAILED), true);
  assert.equal(isValidTransition(TaskState.REVIEW, TaskState.RUNNING), true);
});

test('terminal states have no outgoing transitions', () => {
  assert.equal(isTerminalState(TaskState.COMPLETED), true);
  assert.equal(isTerminalState(TaskState.CANCELLED), true);
  assert.equal(isTerminalState(TaskState.FAILED), false);
  assert.deepEqual(getAllowedTransitions(TaskState.COMPLETED), []);
  assert.deepEqual(getAllowedTransitions(TaskState.CANCELLED), []);
});

test('active states are RUNNING and REVIEW', () => {
  assert.equal(isActiveState(TaskState.RUNNING), true);
  assert.equal(isActiveState(TaskState.REVIEW), true);
  assert.equal(isActiveState(TaskState.CREATED), false);
});

test('same-state transition is valid', () => {
  assert.equal(isValidTransition(TaskState.RUNNING, TaskState.RUNNING), true);
});

test('assertValidTransition throws on invalid transition', () => {
  assert.throws(() => assertValidTransition(TaskState.COMPLETED, TaskState.RUNNING));
});

test('FAILED can be retried to ASSIGNED', () => {
  assert.equal(isValidTransition(TaskState.FAILED, TaskState.ASSIGNED), true);
});
