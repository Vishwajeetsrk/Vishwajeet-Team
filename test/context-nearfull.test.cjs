/**
 * PRD-7 piece 1 — event-driven compact when the context is nearly full.
 * Gates: the near-full bar applies with the same large-window cut as the
 * cadence gate (>=500k tokens = large); a rule saved before the field existed
 * falls back to the shipped bar instead of silently switching the event path
 * off; out-of-range values collapse to OFF (fail toward not interrupting an
 * agent); the renderer event path fires the SAME per-agent routine as the
 * cadence tick (gate parity by construction).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const tr = loadTs('src/shared/triggers.ts');
const root = path.join(__dirname, '..');
const read = (p) => require('node:fs').readFileSync(path.join(root, p), 'utf8');

test('DEFAULT_CONTEXT_TRIGGER ships the event bars on compact, not clear', () => {
  assert.equal(tr.DEFAULT_CONTEXT_TRIGGER.compact.nearFullPct, 88);
  assert.equal(tr.DEFAULT_CONTEXT_TRIGGER.compact.nearFullPctLargeWindow, 44);
  assert.equal(tr.DEFAULT_CONTEXT_TRIGGER.clear.nearFullPct, undefined);
});

test('nearFullPctOf follows the large-window cut and fails toward OFF', () => {
  // Normal windows (~200k): 88.
  assert.equal(tr.nearFullPctOf(tr.DEFAULT_CONTEXT_TRIGGER.compact, 200_000), 88);
  assert.equal(tr.nearFullPctOf(tr.DEFAULT_CONTEXT_TRIGGER.compact, 499_999), 88);
  // Large windows: exactly at the 500k cut the large bar applies.
  assert.equal(tr.nearFullPctOf(tr.DEFAULT_CONTEXT_TRIGGER.compact, 500_000), 44);
  assert.equal(tr.nearFullPctOf(tr.DEFAULT_CONTEXT_TRIGGER.compact, 1_000_000), 44);
  // No window reading yet behaves as a normal window (fail-open, same as the
  // cadence gate).
  assert.equal(tr.nearFullPctOf(tr.DEFAULT_CONTEXT_TRIGGER.compact, undefined), 88);
  // 0 = explicitly off, out-of-range collapses to off.
  assert.equal(tr.nearFullPctOf({ ...tr.DEFAULT_CONTEXT_TRIGGER.compact, nearFullPct: 0 }, 200_000), 0);
  assert.equal(tr.nearFullPctOf({ ...tr.DEFAULT_CONTEXT_TRIGGER.compact, nearFullPct: 150 }, 200_000), 0);
  // A pre-PRD-7 saved rule (no fields) still gets the shipped bars.
  const legacy = { enabled: true, everyMs: 7_200_000, minContextPct: 60, minContextPctLargeWindow: 40, message: '' };
  assert.equal(tr.nearFullPctOf(legacy, 200_000), 88);
  assert.equal(tr.nearFullPctOf(legacy, 1_000_000), 44);
});

test('LARGE_CONTEXT_WINDOW is shared, so the event path and the cadence gate never split', () => {
  assert.equal(tr.LARGE_CONTEXT_WINDOW, 500_000);
  const hive = read('src/renderer/src/hooks/useHive.ts');
  assert.ok(hive.includes("LARGE_CONTEXT_WINDOW, nearFullPctOf"));
  // The local duplicate is gone.
  assert.ok(!/const LARGE_CONTEXT_WINDOW = 500_000/.test(hive));
});

test('wiring: renderer event path, main sanitize clamp, Triggers UI, locales', () => {
  // Renderer: near-full event fires through the shared per-agent routine.
  const hive = read('src/renderer/src/hooks/useHive.ts');
  assert.ok(hive.includes('fireOne(a, \'compact\', rule, { tokens: p.tokens, limit: p.limit })'));
  assert.ok(hive.includes('nearFullPctOf(rule, p.limit)'));
  assert.ok(hive.includes('passesContextPressure(a, rule, fresh)'));
  // Main: the sanitizer clamps the new bars so they survive IPC + persist.
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes('nearFullPct: num('));
  assert.ok(idx.includes('nearFullPctLargeWindow: num('));
  // Triggers tab exposes the two new bars for compact only.
  const ui = read('src/renderer/src/components/triggers/ContextSection.tsx');
  assert.ok(ui.includes('showNearFull'));
  assert.ok(ui.includes('rule.nearFullPct ?? 0'));
  assert.ok(ui.includes('rule.nearFullPctLargeWindow ?? 0'));
  // Locales ×3: keys exist, non-empty, and the contextSection key sets match.
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const j = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    for (const k of ['nearFullBar', 'nearFullBarHint', 'nearFullBig', 'nearFullBigHint']) {
      assert.ok(typeof j.contextSection[k] === 'string' && j.contextSection[k].length > 0, `${loc} missing ${k}`);
    }
  }
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  const ar = JSON.parse(read('src/renderer/src/i18n/locales/ar.json'));
  const zh = JSON.parse(read('src/renderer/src/i18n/locales/zh-CN.json'));
  const keys = (j) => Object.keys(j.contextSection).sort().join('|');
  assert.equal(keys(en), keys(ar));
  assert.equal(keys(en), keys(zh));
});
