'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  validateCreateGoal,
  validateGoalRef,
  validateTaskRef,
  validateAgentRef,
  LIMITS,
} = loadTs('src/main/ceoIpcValidation.ts');

const validTask = {
  title: 'Do the thing',
  description: '',
  roles: ['engineer'],
  skills: [],
  dependencies: [],
  acceptanceCriteria: ['It works'],
  requiresApproval: false,
};

test('accepts a minimal valid goal and trims the title', () => {
  const res = validateCreateGoal({ title: '  Ship it  ', tasks: [validTask] });
  assert.equal(res.ok, true);
  assert.equal(res.value.title, 'Ship it');
  assert.equal(res.value.tasks.length, 1);
  assert.equal(res.value.tasks[0].requiresApproval, false);
});

test('rejects non-objects, empty task lists and missing titles', () => {
  assert.equal(validateCreateGoal(null).ok, false);
  assert.equal(validateCreateGoal('goal').ok, false);
  assert.equal(validateCreateGoal([]).ok, false);
  assert.equal(validateCreateGoal({ title: 'x', tasks: [] }).ok, false);
  assert.equal(validateCreateGoal({ title: '', tasks: [validTask] }).ok, false);
  assert.equal(validateCreateGoal({ title: 'x' }).ok, false, 'tasks default is NOT silent — a goal needs at least one task');
});

test('enforces length caps', () => {
  assert.equal(validateCreateGoal({ title: 'x'.repeat(LIMITS.title + 1), tasks: [validTask] }).ok, false);
  assert.equal(
    validateCreateGoal({ title: 'ok', description: 'd'.repeat(LIMITS.description + 1), tasks: [validTask] }).ok,
    false
  );
  assert.equal(
    validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, title: 't'.repeat(LIMITS.title + 1) }] }).ok,
    false
  );
  const manyTasks = Array.from({ length: LIMITS.tasks + 1 }, (_, i) => ({ ...validTask, title: `t${i}` }));
  assert.equal(validateCreateGoal({ title: 'ok', tasks: manyTasks }).ok, false);
  assert.equal(
    validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, roles: ['r'.repeat(LIMITS.stringItem + 1)] }] }).ok,
    false
  );
});

test('validates dependency indexes (range, type, self-reference)', () => {
  assert.equal(
    validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, dependencies: [5] }] }).ok,
    false,
    'out of range'
  );
  assert.equal(
    validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, dependencies: [0] }] }).ok,
    false,
    'self reference on a single task'
  );
  assert.equal(
    validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, dependencies: ['0'] }] }).ok,
    false,
    'non-integer'
  );
  const ok = validateCreateGoal({
    title: 'ok',
    tasks: [
      { ...validTask, title: 'a' },
      { ...validTask, title: 'b', dependencies: [0] },
    ],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.tasks[1].dependencies, [0]);
});

test('rejects wrong-typed fields inside tasks', () => {
  assert.equal(validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, requiresApproval: 'yes' }] }).ok, false);
  assert.equal(validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, roles: 'engineer' }] }).ok, false);
  assert.equal(validateCreateGoal({ title: 'ok', tasks: [{ ...validTask, acceptanceCriteria: [42] }] }).ok, false);
  assert.equal(validateCreateGoal({ title: 'ok', tasks: ['not an object'] }).ok, false);
});

test('reference validators reject empty/oversized/non-string ids', () => {
  assert.equal(validateGoalRef('').ok, false);
  assert.equal(validateGoalRef(null).ok, false);
  assert.equal(validateGoalRef('x'.repeat(201)).ok, false);
  assert.equal(validateGoalRef('g-1').ok, true);

  assert.equal(validateTaskRef(null).ok, false);
  assert.equal(validateTaskRef({ goalId: 'g' }).ok, false);
  assert.equal(validateTaskRef({ goalId: 'g', planId: 3 }).ok, false);
  assert.deepEqual(validateTaskRef({ goalId: 'g', planId: 'p' }).value, { goalId: 'g', planId: 'p' });

  assert.equal(validateAgentRef('   ').ok, false);
  assert.equal(validateAgentRef(7).ok, false);
  assert.equal(validateAgentRef('agent-1').ok, true);
});
