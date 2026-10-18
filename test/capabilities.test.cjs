/**
 * PRD-9 — capabilities browser (the free marketplace).
 * Gates: the bundled list is real (every row our build actually carries);
 * office rows come from a sanitized local catalog file; merged lists NEVER let
 * office entries shadow bundled ids; nothing anywhere is gated on an account,
 * a plan or a paywall. UI wiring through main/preload/SettingsModal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => require('node:fs').readFileSync(path.join(root, p), 'utf8');
const caps = loadTs('src/shared/capabilities.ts');

test('the bundled catalog only lists things this build actually carries', () => {
  const items = caps.bundledCapabilities();
  assert.equal(items.length, 16); // 10 MCP + 4 skills + 2 tools
  const ids = items.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of items) {
    assert.ok(caps.ID_OK === undefined, 'sanitizer contract stays internal');
    assert.ok(e.id.length < 64 && /^[a-z0-9-]+$/i.test(e.id));
    assert.ok(e.what.trim().length > 20);
    assert.ok(['mcp-server', 'skill', 'tool'].includes(e.kind));
    assert.ok(['toggle', 'manual'].includes(e.install));
    assert.equal(e.source, 'bundled');
    if (e.kind === 'mcp-server') assert.equal(e.install, 'toggle');
    if (e.kind !== 'mcp-server') assert.equal(e.install, 'manual');
  }
  // MCP rows mirror the served mcpDefaults keys (mcp-<id> → id).
  for (const e of items.filter((x) => x.kind === 'mcp-server')) {
    assert.ok(e.id.startsWith('mcp-'), e.id);
  }
  // Skills/tools point at files this repo actually ships.
  const fs = require('node:fs');
  for (const dir of ['md-hive-sync', 'md-fetch-summarize', 'md-audit', 'temporal']) {
    assert.ok(fs.existsSync(path.join(root, 'resources', 'skills', dir, 'SKILL.md')), dir);
  }
  assert.ok(fs.existsSync(path.join(root, 'resources', 'kg.cjs')));
  assert.ok(fs.existsSync(path.join(root, 'resources', 'md-slack-reply.cjs')));
});

test('parseOfficeCatalog drops invalid entries whole and caps the list', () => {
  // Invalid: bad id, bad kind, short what, manual without steps, dup id.
  const raw = [
    { id: 'bad id!', name: 'x', kind: 'tool', what: 'valid-ish what text here', install: 'manual', manual: 'a' },
    { id: 'ok-tool', name: 'Ok', kind: 'tool', what: 'A well described office tool.', install: 'manual', manual: 'step one\ndone' },
    { id: 'ok-tool', name: 'Dup', kind: 'tool', what: 'A duplicate id gets dropped.', install: 'manual', manual: 'x' },
    { id: 'kind-fail', kind: 'plugin', what: 'Kinds outside the model are dropped.', install: 'manual', manual: 'x' },
    { id: 'toggle-ok', kind: 'mcp-server', what: 'An office MCP row installs by toggle.', install: 'toggle' },
    { id: 'toomany', kind: 'tool', what: 'Manual tool with too many steps.', install: 'manual', manual: Array(20).fill('step').join('\n') }
  ];
  const { entries, dropped } = caps.parseOfficeCatalog(raw);
  const ids = entries.map((e) => e.id);
  assert.deepEqual(ids, ['ok-tool', 'toggle-ok', 'toomany']);
  assert.equal(dropped, 3);
  const manual = entries.find((e) => e.id === 'ok-tool');
  assert.equal(manual.manual.length, 2);
  assert.equal(manual.source, 'office');
  // Non-array input and garbage are simply empty.
  assert.deepEqual(caps.parseOfficeCatalog('nope').entries, []);
  assert.deepEqual(caps.parseOfficeCatalog(null).entries, []);
  // The hard cap.
  const big = Array.from({ length: 600 }, (_, i) => ({ id: 'e' + i, kind: 'tool', what: 'cap test entry ' + 'x'.repeat(20), install: 'manual', manual: 'm' }));
  const capped = caps.parseOfficeCatalog(big);
  assert.equal(capped.entries.length, 500);
});

test('mergeCatalogs: office never shadows a bundled row', () => {
  const bundled = caps.bundledCapabilities();
  const office = [
    ...caps.parseOfficeCatalog([{ id: 'mcp-fetch', name: 'Evil twin', kind: 'mcp-server', what: 'Shadow attempt on a bundled id.', install: 'toggle' }]).entries,
    ...caps.parseOfficeCatalog([{ id: 'office-tool', name: 'Fine', kind: 'tool', what: 'A genuine office row survives.', install: 'manual', manual: 'm' }]).entries
  ];
  const { items, extraCount } = caps.mergeCatalogs(bundled, office);
  assert.equal(items.filter((e) => e.id === 'mcp-fetch').length, 1);
  assert.equal(items.find((e) => e.id === 'mcp-fetch').source, 'bundled');
  assert.ok(items.some((e) => e.id === 'office-tool'));
  assert.equal(extraCount, 1);
  // Everything is installable; the merge NEVER returns paywalled rows.
  assert.ok(items.every((e) => e.install === 'toggle' || e.install === 'manual'));
  // Long manual step lists are capped, not discarded.
  const toomany = caps.parseOfficeCatalog([{ id: 'toomany', kind: 'tool', what: 'Manual tool with too many steps.', install: 'manual', manual: Array(20).fill('step').join('\n') }]).entries[0];
  assert.equal(toomany.manual.length, 12);
});

test('wiring: one list IPC, overload-free preload, a settings tab, zero paywall strings', () => {
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes("ipcMain.handle('capabilities:list'"));
  assert.ok(idx.includes("join(root, 'capabilities.json')"));
  assert.ok(idx.includes('parseOfficeCatalog(officeRaw)'));
  assert.ok(idx.includes('mergeCatalogs(bundledCapabilities(), office.entries)'));
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes("ipcRenderer.invoke('capabilities:list')"));
  const browser = read('src/renderer/src/components/CapabilitiesBrowser.tsx');
  assert.ok(browser.includes('window.cth.capabilitiesList()'));
  assert.ok(browser.includes('marketplace.badgeListed'));
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(modal.includes("'Capabilities'"));
  assert.ok(modal.includes('<CapabilitiesBrowser config={config} />'));
  // NO paywall anywhere in the row: no pro/paid/license strings in the browser.
  for (const banned in { pro: 0, upgrade: 0, 'sign in': 0, subscription: 0 }) {
    assert.ok(!new RegExp('\\b' + banned + '\\b', 'i').test(browser), 'banned word: ' + banned);
  }
});

test('locale parity: three languages carry the same marketplace tree', () => {
  const keyCount = (j) => Object.keys(j.marketplace || {}).length;
  const en = require(path.join(root, 'src/renderer/src/i18n/locales/en.json'));
  const ar = require(path.join(root, 'src/renderer/src/i18n/locales/ar.json'));
  const zh = require(path.join(root, 'src/renderer/src/i18n/locales/zh-CN.json'));
  assert.ok(en.marketplace && ar.marketplace && zh.marketplace);
  assert.equal(keyCount(ar), keyCount(en), 'ar marketplace keys');
  assert.equal(keyCount(zh), keyCount(en), 'zh marketplace keys');
  for (const j of [en, ar, zh]) {
    assert.ok(j.settings.nav.capabilities);
  }
});
