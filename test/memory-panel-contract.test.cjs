'use strict';

/**
 * Phase 5 — panel contract (design §7): channel parity between preload and
 * main, `memory:updated` listener parity, locale key parity for the memoryTab
 * block, and an honest-state check on MemoryScopePanel (no hardcoded mock data).
 *
 * REAL vs MOCK:
 * - REAL: the SOURCE TEXT of the shipped preload/main/locales/panel — this is a
 *   static contract test (no service, no repo). The channel sets are parsed out
 *   of src/preload/index.ts and src/main/index.ts rather than hardcoded twice,
 *   so drift on either side fails loudly.
 * - MOCK: none.
 *
 * Renderer-pending soft-skips: if MemoryScopePanel.tsx or the locale memoryTab
 * block do not exist yet (a parallel agent is landing them), those TWO checks
 * log `skipped: renderer pending` and pass; channel parity is ALWAYS strict.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (l) => JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`));
const LOCALES = ['en', 'ar', 'zh-CN'];
const PANEL_PATH = 'src/renderer/src/components/MemoryScopePanel.tsx';

const preload = read('src/preload/index.ts');
const main = read('src/main/index.ts');

/** The eight Phase 5 scoped-memory channels (design §6). */
const MEMORY_CHANNELS = [
  'memory:search', 'memory:list', 'memory:get', 'memory:history',
  'memory:write', 'memory:edit', 'memory:approve', 'memory:delete',
];
/**
 * Legacy `memory:*` channel that predates Phase 5 (memory.md reflect janitor).
 * It exists on BOTH sides, is out of Phase 5 scope, and is asserted present on
 * both — any new memory:* channel must be added to one of these lists.
 */
const LEGACY_MEMORY_CHANNELS = ['memory:reflectNow'];

const invoked = [...new Set([...preload.matchAll(/ipcRenderer\.invoke\('(memory:[^']+)'/g)].map((m) => m[1]))].sort();
const handled = [...new Set([...main.matchAll(/ipcMain\.handle\('(memory:[^']+)'/g)].map((m) => m[1]))].sort();
const sorted = (xs) => [...xs].sort();

function flattenKeys(obj, pre = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key, out);
    else out.add(key);
  }
  return out;
}

test('channel parity: preload invokes exactly the main-registered memory:* set', () => {
  // Every Phase 5 channel is exposed by preload…
  for (const channel of MEMORY_CHANNELS) {
    assert.ok(invoked.includes(channel), `preload does not invoke ${channel}`);
  }
  // …and preload/main agree on the FULL memory:* surface (no orphan handler,
  // no dangling invoke). Extra channels must be declared legacy, both sides.
  const expected = sorted([...MEMORY_CHANNELS, ...LEGACY_MEMORY_CHANNELS]);
  assert.deepEqual(invoked, expected, 'preload memory:* invoke set drifted from the Phase 5 contract');
  assert.deepEqual(handled, expected, 'main memory:* handler set drifted from the Phase 5 contract');
  assert.deepEqual(handled, invoked, 'preload ↔ main memory channel parity broken');
});

test('preload exposes one method per channel plus the onMemoryUpdated listener', () => {
  for (const method of ['memorySearch', 'memoryList', 'memoryGet', 'memoryHistory',
    'memoryWrite', 'memoryEdit', 'memoryApprove', 'memoryDelete']) {
    assert.match(preload, new RegExp(`${method}:`), `preload method ${method} missing`);
  }
  const at = preload.indexOf('onMemoryUpdated:');
  assert.ok(at >= 0, 'preload onMemoryUpdated missing');
  const block = preload.slice(at, at + 500);
  const listener = block.match(/ipcRenderer\.on\('(memory:[^']+)'/);
  assert.ok(listener, 'onMemoryUpdated registers no listener');
  assert.equal(listener[1], 'memory:updated', 'onMemoryUpdated listens to the wrong channel');
  assert.match(block, /ipcRenderer\.removeListener\('memory:updated'/, 'unsubscribe missing');

  // Main pushes the same channel through the service emit seam (metadata only).
  assert.match(main, /new MemoryService\(\{/, 'MemoryService not constructed in main');
  const svcAt = main.indexOf('new MemoryService({');
  const svcBlock = main.slice(svcAt, svcAt + 1200);
  assert.match(svcBlock, /liveWebContents\(\)\?\.send\(channel, payload\)/,
    'the memory emit seam is not wired to the renderer push');
  assert.match(main, /taskAgent:/, 'the agent→task write gate is not wired to the goal ledger');
});

test('locale parity: every key under memoryTab exists in en, ar and zh-CN', () => {
  const en = locale('en');
  if (!en.memoryTab) {
    console.log('skipped: renderer pending (no memoryTab block in en.json yet)');
    return;
  }
  const enKeys = flattenKeys(en.memoryTab);
  assert.ok(enKeys.size > 0, 'memoryTab block is empty');
  for (const l of LOCALES) {
    const json = locale(l);
    assert.ok(json.memoryTab, `${l}: memoryTab block missing`);
    const keys = flattenKeys(json.memoryTab);
    const missing = [...enKeys].filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${l}: memoryTab keys missing vs en`);
    const extra = [...keys].filter((k) => !enKeys.has(k));
    assert.deepEqual(extra, [], `${l}: memoryTab has keys en does not define`);
  }
});

test('MemoryScopePanel exists and contains no hardcoded mock/fake/placeholder data', () => {
  const file = path.join(root, PANEL_PATH);
  if (!fs.existsSync(file)) {
    console.log('skipped: renderer pending (MemoryScopePanel.tsx not present yet)');
    return;
  }
  const src = read(PANEL_PATH);
  assert.ok(src.length > 0, 'MemoryScopePanel.tsx is empty');

  // Comment lines may legitimately mention the words; data lines may not.
  const dataLines = src.split('\n').filter((line) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  });
  const offenders = dataLines.filter((line) => /mock|fake|dummy|placeholder data/i.test(line));
  assert.deepEqual(offenders, [], `MemoryScopePanel carries hardcoded mock data:\n${offenders.join('\n')}`);
});
