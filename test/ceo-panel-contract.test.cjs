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

const panel = read('src/renderer/src/components/CommandCenterPanel.tsx');
const ceoPanel = read('src/renderer/src/components/CeoPanel.tsx');
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

const CEO_CHANNELS = [
  'ceo:state', 'ceo:createGoal', 'ceo:execute', 'ceo:accept',
  'ceo:cancel', 'ceo:redeliver', 'ceo:ensureSession'
];

test('Command Center registers a ceo tab that renders CeoPanel', () => {
  assert.match(panel, /'ceo'/, 'CCTab union/TABS lost the ceo key');
  assert.match(panel, /labelKey:\s*'commandCenter\.tabs\.ceo'/, 'TABS entry for ceo is missing');
  assert.match(panel, /tab === 'ceo' && <CeoPanel \/>/, 'body does not render CeoPanel');
  assert.match(panel, /import \{ CeoPanel \} from '\.\/CeoPanel';/, 'CeoPanel import missing');
});

test('every tab icon exists in the Icon library (crown included)', () => {
  const union = icon.slice(icon.indexOf('export type IconName'), icon.indexOf(';', icon.indexOf('export type IconName')));
  const entries = [...panel.matchAll(/icon:\s*'([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(entries.includes('crown'), 'crown icon not used by the ceo tab');
  for (const name of entries) {
    assert.ok(union.includes(`'${name}'`), `icon '${name}' is not in IconName`);
    assert.ok(new RegExp(`^  ${name}:\\s*\\{`, 'm').test(icon), `paths['${name}'] missing in Icon.tsx`);
  }
});

test('preload exposes the full ceo API with matching invoke channels', () => {
  for (const method of ['ceoState', 'ceoCreateGoal', 'ceoExecute', 'ceoAccept',
                        'ceoCancel', 'ceoRedeliver', 'ceoEnsureSession']) {
    assert.match(preload, new RegExp(`${method}:`), `preload method ${method} missing`);
  }
  assert.match(preload, /onCeoUpdated:/, 'preload push subscription missing');
  assert.match(preload, /ipcRenderer\.on\('ceo:updated'/, 'onCeoUpdated listens to the wrong channel');
  assert.match(preload, /ipcRenderer\.removeListener\('ceo:updated'/, 'onCeoUpdated unsubscribe missing');
  const invoked = new Set([...preload.matchAll(/invoke\('(ceo:[^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...invoked].sort(), [...CEO_CHANNELS].sort(),
    'preload channel set drifted from the contract');
});

test('main registers every ceo channel, and only those', () => {
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('(ceo:[^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...handled].sort(), [...CEO_CHANNELS].sort(),
    'main handler set drifted from the preload contract');
});

test('main fans routed replies into ceo, reconciles on bootstrap, hooks PTY exit', () => {
  assert.match(main, /closingTime\.onRouted\(msg, targets\);[\s\S]{0,200}ceo\.onRouted\(msg\)/,
    'routed observer no longer fans out to the CEO');
  assert.match(main, /ceo\.reconcile\(\)/, 'bootstrap never reconciles persisted goal state');
  assert.match(main, /ceo\.noteSessionExit\(deadAgent, exitCode\)/,
    'PTY exit handler does not surface lost sessions to the CEO');
  assert.match(main, /const goalStore = new GoalStore\(hive\)/, 'GoalStore not wired to the hive');
  assert.match(main, /spawnSession:/, 'CeoService has no spawn seam');
});

test('CeoPanel renders honest failure + offline + loading states, no fake progress', () => {
  assert.match(ceoPanel, /loadError/, 'no error state');
  assert.match(ceoPanel, /hiveEnabled/, 'no hive-offline state');
  assert.match(ceoPanel, /loading/, 'no loading state');
  assert.match(ceoPanel, /\{task\.error\}/, 'task failures are not shown');
  assert.match(ceoPanel, /task\.result/, 'agent results are not shown');
  // Progress must come from persisted records, not a client-side timer animation.
  assert.doesNotMatch(ceoPanel, /setInterval\((?:\(\) => \{[^}]*progress|[^,]*progress)/,
    'progress appears to be animated rather than persisted');
  for (const method of ['ceoState', 'ceoCreateGoal', 'ceoExecute', 'ceoAccept',
                        'ceoCancel', 'ceoRedeliver', 'ceoEnsureSession', 'onCeoUpdated']) {
    assert.ok(ceoPanel.includes(`window.cth.${method}`), `CeoPanel never calls ${method}`);
  }
});

test('all three locales carry the ceo tab label and an identical ceoTab key set', () => {
  const sets = {};
  for (const l of LOCALES) {
    const j = locale(l);
    assert.ok(j.commandCenter?.tabs?.ceo, `${l}: commandCenter.tabs.ceo missing`);
    assert.ok(j.ceoTab, `${l}: ceoTab block missing`);
    sets[l] = Object.keys(flatten(j.ceoTab)).sort();
  }
  assert.deepEqual(sets.ar, sets.en, 'ar ceoTab keys drifted from en');
  assert.deepEqual(sets['zh-CN'], sets.en, 'zh-CN ceoTab keys drifted from en');
});

test('ceoTab labels cover every TaskState and GoalStatus, plus session states', () => {
  const { TaskState } = loadTs('src/shared/taskStateMachine.ts');
  const { GoalStatus } = loadTs('src/shared/goals.ts');
  const en = flatten(locale('en').ceoTab);
  const ar = flatten(locale('ar').ceoTab);
  const zh = flatten(locale('zh-CN').ceoTab);
  const needed = [
    ...Object.values(TaskState),
    ...Object.values(GoalStatus),
    'live', 'starting', 'offline', 'unknown'
  ];
  for (const name of needed) {
    for (const [l, flat] of [['en', en], ['ar', ar], ['zh-CN', zh]]) {
      const key = name in { live: 1, starting: 1, offline: 1, unknown: 1 }
        ? `session.${name}`
        : `states.${name}`;
      assert.ok(key in flat, `${l}: ceoTab.${key} missing for value ${name}`);
    }
  }
});

test('create-goal placeholders stay in sync across locales', () => {
  const vars = (v) => [...new Set(String(v).match(/\{\{(\w+)\}\}/g) || [])].sort();
  const en = flatten(locale('en').ceoTab);
  const zh = flatten(locale('zh-CN').ceoTab);
  const ar = flatten(locale('ar').ceoTab);
  const drift = Object.keys(en)
    .filter((k) => JSON.stringify(vars(en[k])) !== JSON.stringify(vars(zh[k]))
      || JSON.stringify(vars(en[k])) !== JSON.stringify(vars(ar[k])))
    .map((k) => k);
  assert.deepEqual(drift, [], `placeholder drift: ${drift.join(', ')}`);
});
