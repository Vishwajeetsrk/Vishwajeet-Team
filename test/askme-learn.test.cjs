'use strict';

/**
 * Learn loop: operator answers and dismissals on the ASK ME board become
 * agent-scope `preference` memories, so recall teaches agents how the human
 * wants things done. No new pipeline — the existing user-actor write path
 * (auto-approve, dedup, secret-scan) carries the lessons.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { validateMemoryWrite } = loadTs('src/main/memoryIpcValidation.ts');

function lessonInput(scope, ref) {
  const base = {
    content: 'Operator answered "x" with "y"',
    type: 'preference',
    sourceKind: 'user',
    author: 'user',
    sourceRef: 'task-1',
    confidence: 0.9,
    importance: 3
  };
  return scope === 'agent' ? { ...base, scope, agentId: ref } : { ...base, scope, taskId: ref };
}

test('lesson inputs validate for both agent and task scope', () => {
  for (const [scope, ref] of [['agent', 'pam'], ['task', 'task-1']]) {
    const v = validateMemoryWrite(lessonInput(scope, ref));
    assert.equal(v.ok, true, `${scope}: ${v.ok ? '' : v.error}`);
    assert.equal(v.value.type, 'preference');
    assert.equal(v.value.confidence, 0.9);
  }
});

test('user-actor writes auto-approve (no approval-desk spam from lessons)', () => {
  const svc = read('src/main/memoryService.ts');
  assert.ok(svc.includes("approved: actor.kind === 'user'"), 'user auto-approve missing');
  const main = read('src/main/index.ts');
  const h = main.indexOf("ipcMain.handle('memory:write'");
  const slice = main.slice(h, h + 600);
  assert.ok(slice.includes('USER_ACTOR'), 'memory:write must run as the user actor');
});

test('AskMeTab records answers and dismissals as preference memories', () => {
  const tab = read('src/renderer/src/components/AskMeTab.tsx');
  assert.ok(tab.includes('recordLesson'), 'recordLesson helper missing');
  assert.ok(tab.includes("type: 'preference'"), 'lessons must be preference type');
  assert.ok(tab.includes("scope: 'agent'"), 'assignee lessons must be agent-scope');
  assert.ok(tab.includes("scope: 'task'"), 'unowned lessons must fall back to task scope');
  assert.ok(tab.includes('window.cth.memoryWrite(input)'), 'lessons must ride memoryWrite');
  assert.ok(tab.includes('.catch('), 'lesson writes must be fire-and-forget');
  // Answers AND dismissals both teach (a refusal is a lesson about what not to ask).
  const ans = tab.indexOf('recordLesson(task, `Operator answered');
  const dis = tab.indexOf('recordLesson(task, `Operator dismissed');
  assert.ok(ans > 0 && dis > 0, 'both answer and dismiss paths must record');
});

test('lesson content is bounded and never blocks the answer', () => {
  const tab = read('src/renderer/src/components/AskMeTab.tsx');
  assert.ok(tab.includes('1900'), 'lesson content must be capped under MEMORY_CONTENT_MAX');
  const v = validateMemoryWrite({ ...lessonInput('agent', 'pam'), content: 'x'.repeat(1900) });
  assert.equal(v.ok, true, 'capped lesson must validate');
});
