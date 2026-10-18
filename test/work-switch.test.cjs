/**
 * PRD-7b — clear-on-work-switch with handoff.md.
 * Gates: a switch is a NEW conversation arriving for a terminal agent that was
 * already dispatched into a DIFFERENT one (first delivery = arrival, not a
 * switch); the handoff file is written whenever a switch fires, but the
 * CONTEXT CLEAR only happens when the clear rule is armed, a context reading
 * exists, it is over the rule's bar (same 500k large-window cut), and the
 * provider has a safe clear verb; with no reading nothing is ever cleared.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ho = loadTs('src/shared/handoff.ts');
const root = path.join(__dirname, '..');
const read = (p) => require('node:fs').readFileSync(path.join(root, p), 'utf8');

const rule = (enabled = true, min = 90, large = 80) => ({
  enabled, minContextPct: min, minContextPctLargeWindow: large
});

test('handoffDoc renders the switch summary deterministically', () => {
  const doc = ho.handoffDoc({
    agentId: 'wp', agentName: 'Work_pal', role: 'worker', cwd: 'C:/repo',
    prevConversation: 'task-a', prevSubject: 'Fix imports', prevFrom: 'god',
    conversation: 'task-b', subject: 'New plan', from: 'god',
    contextPct: 93.4, clearVerb: '/clear', at: 1_700_000_000_000
  });
  assert.ok(doc.startsWith('# Handoff for Work_pal (wp)'));
  assert.ok(doc.includes('- Time: 2023-11-14T22:13:20.000Z'));
  assert.ok(doc.includes('Context fill at the switch: 93%'));
  assert.ok(doc.includes('Task: Fix imports'));
  assert.ok(doc.includes('Conversation: task-a'));
  assert.ok(doc.includes('New conversation: task-b'));
  assert.ok(doc.includes('Cleared with: /clear'));
  assert.ok(doc.includes('memory.md'));
  assert.ok(doc.includes('tasks.json'));
  // Deterministic: same input → same bytes.
  assert.equal(doc, ho.handoffDoc({
    agentId: 'wp', agentName: 'Work_pal', role: 'worker', cwd: 'C:/repo',
    prevConversation: 'task-a', prevSubject: 'Fix imports', prevFrom: 'god',
    conversation: 'task-b', subject: 'New plan', from: 'god',
    contextPct: 93.4, clearVerb: '/clear', at: 1_700_000_000_000
  }));
  // A provider without a safe clear still documents the switch honestly.
  const soft = ho.handoffDoc({ agentId: 'wp', clearVerb: null, at: 1_700_000_000_000 });
  assert.ok(soft.includes('Cleared with: nothing'));
});

test('workSwitchDecision: arrival is not a switch; the same conversation continues', () => {
  // No prior conversation on record → plain delivery.
  const first = ho.workSwitchDecision({ rule: rule(), nextConversation: 'task-a' });
  assert.deepEqual(first, { handoff: false, clear: false, reason: first.reason });
  // Same conversation → no switch even at 100% full.
  const same = ho.workSwitchDecision({ rule: rule(), tokens: 200_000, limit: 200_000, prevConversation: 'task-a', nextConversation: 'task-a' });
  assert.equal(same.handoff, false);
  assert.equal(same.clear, false);
});

test('workSwitchDecision: clear needs rule ON, a reading, and pressure over the bar', () => {
  const base = { prevConversation: 'task-a', nextConversation: 'task-b' };
  // Rule disabled → handoff only.
  assert.equal(ho.workSwitchDecision({ rule: rule(false), ...base, tokens: 200_000, limit: 200_000 }).clear, false);
  assert.equal(ho.workSwitchDecision({ rule: rule(false), ...base }).handoff, true);
  // No reading → never clear (nothing measurable is being dropped).
  assert.equal(ho.workSwitchDecision({ rule: rule(), ...base }).clear, false);
  // Under the bar → handoff only.
  assert.equal(ho.workSwitchDecision({ rule: rule(), tokens: 50, limit: 200_000, ...base }).clear, false);
  // Over the bar → clear.
  const over = ho.workSwitchDecision({ rule: rule(), tokens: 199_000, limit: 200_000, ...base });
  assert.deepEqual(over, { handoff: true, clear: true, reason: over.reason });
  assert.ok(over.reason.includes('crossed the 90% clear bar'));
  // Large windows (>=500k) consult the larger-window bar.
  const big = ho.workSwitchDecision({ rule: rule(), tokens: 60_000, limit: 1_000_000, ...base });
  assert.equal(big.clear, false); // 6% < 80%
  const bigOver = ho.workSwitchDecision({ rule: rule(), tokens: 900_000, limit: 1_000_000, ...base });
  assert.equal(bigOver.clear, true);
});

test('wiring: main writes the file, preload exposes it, the renderer decides', () => {
  // shared module: dependency-free by design.
  const src = read('src/shared/handoff.ts');
  assert.ok(!src.includes('import '));
  // MAIN: the writer validates id + size, lands in the agent folder.
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes("ipcMain.handle('hive:writeHandoff'"));
  assert.ok(idx.includes("agents', agentId"));
  assert.ok(idx.includes("join(dir, 'handoff.md')"));
  // PRELOAD: one consumer, typed, defensive.
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes("ipcRenderer.invoke('hive:writeHandoff'"));
  assert.ok(pre.includes('writeHandoff: ('));
  // RENDERER: the switch tracker + decision + note ride the terminal path.
  const hive = read('src/renderer/src/hooks/useHive.ts');
  assert.ok(hive.includes("from '../../../shared/handoff'"));
  assert.ok(hive.includes('lastWorkConversation = useRef'));
  assert.ok(hive.includes('workSwitchDecision({'));
  assert.ok(hive.includes('window.cth.writeHandoff?.(target.id, handoffDoc('));
  assert.ok(hive.includes('[CONTEXT SWITCHED]'));
  assert.ok(hive.includes('terminalWorkOrderPrompt(msg, handoffNote)'));
  // The clear FIRST ordering: the clear command is enqueued before the work order.
  const clearIdx = hive.indexOf('if (clearCmd) enqueueMessage(target.id, clearCmd);');
  const workIdx = hive.indexOf('enqueueMessage(target.id, terminalWorkOrderPrompt(msg, handoffNote));');
  assert.ok(clearIdx > 0 && workIdx > clearIdx, 'clear is queued before the new work order');
});
