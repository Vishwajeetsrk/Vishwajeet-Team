'use strict';

/**
 * Phase 6 — Security surface contract (design §8 "IPC surface", §10 "user
 * pinning").
 *
 * REAL vs MOCK:
 * - REAL: shipped text of src/preload/index.ts, src/main/index.ts, and (when
 *   present) SecurityPanel.tsx + the three locale JSON files.
 * - MOCK: none.
 *
 * Renderer checks soft-skip when the UI agent's files are not yet on disk
 * (the panel/locale work is a separate chunk); the preload↔main parity and
 * user-pinning assertions are ALWAYS strict — those shipped with the
 * main-process wiring.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const PRELOAD = read('src/preload/index.ts');
const MAIN = read('src/main/index.ts');

const SECURITY_FAMILIES = ['security:', 'policy:', 'approvals:', 'audit:'];
const EXPECTED_CHANNELS = new Set([
  'security:state',
  'security:emergency',
  'security:autoApproveInternal',
  'policy:get',
  'policy:set',
  'approvals:list',
  'approvals:approve',
  'approvals:deny',
  'audit:list',
  'integrations:revokeSecret'
]);

function channels(text, re) {
  const out = new Set();
  for (const m of text.matchAll(re)) out.add(m[1]);
  return out;
}

function isSecurityChannel(name) {
  return EXPECTED_CHANNELS.has(name) || SECURITY_FAMILIES.some((f) => name.startsWith(f));
}

test('preload↔main parity: every Phase 6 channel exists on both sides, sets equal', () => {
  const preloadCh = channels(PRELOAD, /ipcRenderer\.invoke\('([^']+)'/g);
  const mainCh = channels(MAIN, /ipcMain\.handle\('([^']+)'/g);

  const preloadSec = new Set([...preloadCh].filter(isSecurityChannel));
  const mainSec = new Set([...mainCh].filter(isSecurityChannel));

  for (const ch of EXPECTED_CHANNELS) {
    assert.ok(preloadSec.has(ch), `preload must expose ${ch}`);
    assert.ok(mainSec.has(ch), `main must register ${ch}`);
  }
  assert.deepEqual(
    [...preloadSec].sort(),
    [...mainSec].sort(),
    'preload and main must expose the identical Phase 6 channel set'
  );
});

test('security:updated push channel: main sends what preload listens to', () => {
  assert.match(MAIN, /\.send\('security:updated'/, 'main pushes security:updated');
  assert.match(PRELOAD, /ipcRenderer\.on\('security:updated'/, 'preload listens on security:updated');
});

test('USER pinning: desk decisions and audit actors are pinned to the operator', () => {
  // The IPC region for Phase 6 (between its comment banner and the computers
  // banner) must never thread a renderer-supplied actor into decide().
  const start = MAIN.indexOf("IPC: security (AI Company OS Phase 6)");
  const end = MAIN.indexOf('IPC: computers (AI Company OS Phase 4)');
  assert.ok(start > 0 && end > start, 'the Phase 6 IPC region must exist');
  const region = MAIN.slice(start, end);

  for (const decideCall of region.matchAll(/approvalDesk\.decide\([^)]*\)/g)) {
    assert.match(
      decideCall[0],
      /'user'/,
      `decide() must pin decidedBy 'user', never a renderer arg: ${decideCall[0]}`
    );
  }
  // No handler may accept an `actor`/`decidedBy` field from the renderer.
  assert.doesNotMatch(
    region,
    /decidedBy:\s*(?:raw|o\.|v\.|patch\.|payload\.|actor)/,
    'decidedBy must not come from renderer input'
  );
  assert.doesNotMatch(
    region,
    /actor:\s*(?:raw|o\.actor|v\.actor|patch\.actor|payload\.actor)(?![a-zA-Z])/,
    'the actor of a security action is never a renderer-supplied value'
  );
  // Emergency propagation is user-side only: pause-all drives control.pause.
  assert.match(region, /control\.pause\(/, 'emergency paused=true must drive the control registry');
});

test('policy:set values are constrained to the decision vocabulary', () => {
  const start = MAIN.indexOf("ipcMain.handle('policy:set'");
  const end = MAIN.indexOf("ipcMain.handle('approvals:list'");
  assert.ok(start > 0 && end > start);
  const region = MAIN.slice(start, end);
  assert.match(region, /'allow'/);
  assert.match(region, /'require-approval'/);
  assert.match(region, /'deny'/);
  assert.match(region, /null/, 'clearing an override is value: null');
  assert.match(region, /\[a-z-\]\+:\[\^:\\s\]\+/, 'key must be domain:action shaped');
});

test('renderer SecurityPanel contract (soft-skip while the UI chunk is pending)', (t) => {
  const panelPath = 'src/renderer/src/components/SecurityPanel.tsx';
  if (!exists(panelPath)) {
    t.diagnostic('skipped: SecurityPanel.tsx not on disk yet');
    return;
  }
  const panel = read(panelPath);
  // Strip block + line comments so prose about "no fake data" can't trip the check.
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /mock|\bfake\b|dummy data/i, 'no mock/fake data outside comments');
  // Every Phase 6 surface the panel touches must be on window.cth (not api).
  assert.doesNotMatch(panel, /window\.api\b/, 'the project surface is window.cth');
  assert.match(panel, /securityEmergency/);
  assert.match(panel, /approvalsList|approvalsApprove|approvalsDeny/);
  assert.match(panel, /auditList/);
});

test('securityTab locale parity across en / ar / zh-CN (soft-skip while pending)', (t) => {
  const locales = ['en', 'ar', 'zh-CN'].map((l) => `src/renderer/src/i18n/locales/${l}.json`);
  if (!locales.every(exists)) {
    t.diagnostic('skipped: locale files not on disk yet');
    return;
  }
  const docs = Object.fromEntries(locales.map((p) => [p, JSON.parse(read(p))]));
  const enKeys = Object.keys(docs['src/renderer/src/i18n/locales/en.json'].securityTab ?? {});
  if (enKeys.length === 0) {
    t.diagnostic('skipped: securityTab block not in en.json yet');
    return;
  }
  assert.ok(enKeys.length >= 10, `securityTab should be a full block, found ${enKeys.length} keys`);
  for (const p of locales.slice(1)) {
    const keys = Object.keys(docs[p].securityTab ?? {});
    assert.deepEqual(
      [...keys].sort(),
      [...enKeys].sort(),
      `${p} securityTab keys must match en exactly`
    );
  }
});
