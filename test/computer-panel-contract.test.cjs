'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (l) => JSON.parse(read(`src/renderer/src/i18n/locales/${l}.json`));
const LOCALES = ['en', 'ar', 'zh-CN'];

const panelShell = read('src/renderer/src/components/CommandCenterPanel.tsx');
const computerPanel = read('src/renderer/src/components/ComputerPanel.tsx');
const preload = read('src/preload/index.ts');
const main = read('src/main/index.ts');
const icon = read('src/renderer/src/components/Icon.tsx');

function flatten(obj, pre = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = pre ? `${pre}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const COMPUTER_CHANNELS = [
  'computer:create', 'computer:ensureForAgent', 'computer:get', 'computer:list',
  'computer:getForAgent', 'computer:start', 'computer:stop', 'computer:pause',
  'computer:resume', 'computer:restart', 'computer:watch', 'computer:takeControl',
  'computer:releaseControl', 'computer:openBrowser', 'computer:navigate',
  'computer:browserStatus', 'computer:captureScreen', 'computer:terminalInfo',
  'computer:workspaceInfo', 'computer:authorizePath', 'computer:permissions',
  'computer:dispose', 'computer:getStatus', 'computer:allows'
];

test('Command Center registers a computer tab that renders ComputerPanel', () => {
  assert.match(panelShell, /'computer'/, 'CCTab union/TABS lost the computer key');
  assert.match(panelShell, /labelKey:\s*'commandCenter\.tabs\.computer'/, 'TABS entry for computer is missing');
  assert.match(panelShell, /tab === 'computer' && <ComputerPanel \/>/, 'body does not render ComputerPanel');
  assert.match(panelShell, /import \{ ComputerPanel \} from '\.\/ComputerPanel';/, 'ComputerPanel import missing');
});

test('the computer tab icon exists in the Icon library', () => {
  const union = icon.slice(icon.indexOf('export type IconName'), icon.indexOf(';', icon.indexOf('export type IconName')));
  const entries = [...panelShell.matchAll(/icon:\s*'([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(entries.includes('code'), 'the computer tab does not use an icon');
  for (const name of entries) {
    assert.ok(union.includes(`'${name}'`), `icon '${name}' is not in IconName`);
    assert.ok(new RegExp(`^  ${name}:\\s*\\{`, 'm').test(icon), `paths['${name}'] missing in Icon.tsx`);
  }
});

test('preload exposes the full computer API with matching invoke channels', () => {
  for (const method of [
    'computerCreate', 'computerEnsureForAgent', 'computerGet', 'computerList',
    'computerGetForAgent', 'computerStart', 'computerStop', 'computerPause',
    'computerResume', 'computerRestart', 'computerWatch', 'computerTakeControl',
    'computerReleaseControl', 'computerOpenBrowser', 'computerNavigate',
    'computerBrowserStatus', 'computerCaptureScreen', 'computerTerminalInfo',
    'computerWorkspaceInfo', 'computerAuthorizePath', 'computerPermissions',
    'computerDispose', 'computerGetStatus', 'computerAllows'
  ]) {
    assert.match(preload, new RegExp(`${method}:`), `preload method ${method} missing`);
  }
  assert.match(preload, /onComputerUpdated:/, 'preload onComputerUpdated missing');
  assert.match(preload, /ipcRenderer\.on\('computer:updated'/, 'onComputerUpdated listens to the wrong channel');
  assert.match(preload, /ipcRenderer\.removeListener\('computer:updated'/, 'onComputerUpdated unsubscribe missing');
  assert.match(preload, /onComputerEvent:/, 'preload onComputerEvent missing');
  assert.match(preload, /ipcRenderer\.on\('computer:event'/, 'onComputerEvent listens to the wrong channel');
  const invoked = new Set([...preload.matchAll(/invoke\('(computer:[^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...invoked].sort(), [...COMPUTER_CHANNELS].sort(),
    'preload channel set drifted from the contract');
});

test('main registers every computer channel, and only those', () => {
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('(computer:[^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...handled].sort(), [...COMPUTER_CHANNELS].sort(),
    'main handler set drifted from the preload contract');
});

test('main wires construction, SQLite repo, reconcile, events, and the status tick', () => {
  // The `: ComputerManager` annotation is optional (added when browser-gate
  // closures made the initializer circular for TS inference) — construction is
  // what this contract asserts.
  assert.match(main, /const computers(?::\s*ComputerManager)? = new ComputerManager\(\{/, 'ComputerManager not constructed');
  assert.match(main, /new SqliteComputerRepo\(persist\)/, 'not wired to the authoritative SQLite store');
  assert.match(main, /computersRoot: \(\) => join\(readConfig\(\)\.harnessHome/, 'computersRoot is not a deferred config read');
  assert.match(main, /computers\.reconcile\(\);/, 'bootstrap never reconciles persisted computer state');
  assert.match(main, /hive\.appendLog\(evt\)/, 'computer events do not reach the durable Activity log');
  assert.match(main, /'computer:event', \{ ts: Date\.now\(\), \.\.\.evt \}/, 'live event push carries no timestamp');
  assert.match(main, /emit: \(channel, payload\) => \{[\s\S]{0,160}liveWebContents\(\)\?\.send\(channel, payload\)/,
    'the manager emit seam is not wired to the renderer (computer:updated push)');
  assert.match(main, /hasActiveTask:/, 'no task-engine signal for WORKING/WAITING derivation');
  assert.match(main, /computerTickTimer = setInterval\(\(\) => \{ try \{ computers\.statusTick\(\); \} catch \(e\) \{ console\.error\('\[computer tick\]', e\); \} \}, 5_000\)/,
    'the 5s statusTick timer is missing');
});

test('the pty:write gate and quit/reset cleanup are enforced in main', () => {
  assert.match(main, /const gatedAgent = ptyToAgent\.get\(id\);[\s\S]{0,260}computers\.checkTerminalAccess\(gatedAgent\)/,
    'pty:write no longer passes through the computer terminal gate');
  assert.match(main, /computers\.shutdown\(\)\.catch\(\(e\) => console\.error\('\[quit\] computers\.shutdown:'/,
    'quit path never closes computer windows');
  assert.match(main, /computers\.shutdown\(\)\.catch\(\(e\) => console\.error\('\[reset\] computers\.shutdown:'/,
    'reset path never closes computer windows');
  assert.match(main, /gatedAgent\) \{\s*const gate = computers\.checkTerminalAccess\(gatedAgent\);\s*if \(!gate\.ok\) return \{ ok: false, error: gate\.error \};/,
    'the terminal gate result is not enforced');
});

test('sensitive handlers pin USER_ACTOR; no renderer arg can name an actor', () => {
  for (const channel of ['computer:permissions', 'computer:dispose', 'computer:captureScreen',
    'computer:watch', 'computer:takeControl', 'computer:releaseControl', 'computer:authorizePath']) {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at >= 0, `${channel} handler missing`);
    const block = main.slice(at, main.indexOf('});', at));
    assert.match(block, /USER_ACTOR/, `${channel} does not pin the local-user actor`);
  }
});

test('ComputerPanel uses only real computer APIs and honest states', () => {
  assert.match(computerPanel, /loadError/, 'no error state');
  assert.match(computerPanel, /selectedAgent/, 'panel is not driven by the selected agent');
  assert.match(computerPanel, /data:image\/png;base64/, 'screenshot is not a real capture payload');
  assert.match(computerPanel, /window\.cth\.computerDispose\(rec\.id, true\)/, 'dispose does not send confirm:true');
  assert.match(computerPanel, /showDispose/, 'no destructive-action confirmation flow');
  assert.match(computerPanel, /res\.code/, 'permission-denied/unsupported codes are not surfaced');
  assert.doesNotMatch(computerPanel, /progress/, 'progress appears simulated rather than derived from real state');
  const methods = new Set([...computerPanel.matchAll(/window\.cth\.(computer\w+)/g)].map((m) => m[1]));
  assert.ok(methods.size >= 10, `panel touches too few runtime ops (${methods.size})`);
  for (const method of methods) {
    assert.ok(preload.includes(`${method}:`), `panel calls ${method} but preload does not expose it`);
  }
  for (const m of ['computerStart', 'computerStop', 'computerPause', 'computerResume', 'computerRestart',
    'computerOpenBrowser', 'computerNavigate', 'computerCaptureScreen', 'computerEnsureForAgent',
    'computerTakeControl', 'computerReleaseControl', 'computerWatch', 'computerPermissions']) {
    assert.ok(methods.has(m), `panel never calls ${m}`);
  }
});

test('all three locales carry the computer tab label and an identical computerTab key set', () => {
  const sets = {};
  for (const l of LOCALES) {
    const j = locale(l);
    assert.ok(j.commandCenter?.tabs?.computer, `${l}: commandCenter.tabs.computer missing`);
    assert.ok(j.computerTab, `${l}: computerTab block missing`);
    sets[l] = Object.keys(flatten(j.computerTab)).sort();
  }
  assert.deepEqual(sets.ar, sets.en, 'ar computerTab keys drifted from en');
  assert.deepEqual(sets['zh-CN'], sets.en, 'zh-CN computerTab keys drifted from en');
});

test('computerTab.states covers every ComputerStatus, with interpolation preserved', () => {
  const { COMPUTER_STATUSES } = loadTs('src/shared/computer.ts');
  for (const l of LOCALES) {
    const flat = flatten(locale(l).computerTab);
    for (const status of COMPUTER_STATUSES) {
      assert.ok(flat[`states.${status}`], `${l}: state label missing for ${status}`);
    }
    assert.match(flat['disposeConfirm'], /\{\{policy\}\}/,
      `${l}: disposeConfirm lost its {{policy}} interpolation`);
  }
});

test('every computerTab key the panel renders exists in en (and therefore in all locales)', () => {
  const used = new Set();
  for (const m of computerPanel.matchAll(/computerTab\.([\w.]+)/g)) used.add(m[1]);
  assert.ok(used.size >= 30, `panel renders suspiciously few i18n keys (${used.size})`);
  const flat = flatten(locale('en').computerTab);
  for (const key of used) {
    if (key.endsWith('.')) continue; // dynamic `states.${status}` covered above
    assert.ok(flat[key], `en.json is missing computerTab.${key} used by the panel`);
  }
});
