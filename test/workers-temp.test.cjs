'use strict';

/**
 * Free Temps: the operator spawns a one-job worker from the Workers tab.
 * The request reuses the EXISTING spawn-request pipeline (watcher, dispatch,
 * done-release, reaping, safety-gated teardown) — no new spawn path. Static
 * source-text contract (no Electron): validation rules, threat-model
 * exclusions, preload channel parity, locale keys.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const tab = read('src/renderer/src/components/WorkersTab.tsx');

function handlerSlice() {
  const start = main.indexOf("ipcMain.handle('workers:spawnTemp'");
  assert.ok(start > 0, 'workers:spawnTemp handler missing');
  const end = main.indexOf('\n});', start);
  assert.ok(end > start, 'handler close not found');
  return main.slice(start, end);
}

test('spawnTemp validates like the queue path and writes a spawn-request', () => {
  const h = handlerSlice();
  assert.ok(h.includes('hive not configured'), 'hive-null guard missing');
  assert.ok(h.includes('objective is required'), 'objective required missing');
  assert.ok(h.includes('max 2000 chars'), 'objective bound missing');
  assert.ok(h.includes('registeredRepos'), 'cwd must default to the first registered repo');
  assert.ok(h.includes('pick an existing folder'), 'cwd existence check missing');
  assert.ok(h.includes('normalizeAgentProvider'), 'provider must go through the preset allowlist');
  assert.ok(h.includes('isolate: true'), 'temps must always be isolated');
  assert.ok(h.includes('spawnRequestsDir()'), 'must write into the watched queue dir');
  assert.ok(h.includes('reqId'), 'must return the queue id');
});

test('threat model: no arbitrary binary, no slack, no appearance spoofing from UI', () => {
  const h = handlerSlice();
  assert.ok(!h.includes('p.command') && !h.includes('raw.command'), 'UI must never supply `command`');
  assert.ok(!h.includes('p.slack') && !h.includes('raw.slack'), 'slack routing stays god/Slack-only');
  assert.ok(!h.includes('p.character') && !h.includes('p.accent'), 'appearance fields stay out of UI input');
});

test('preload exposes spawnTempWorker on the workers:spawnTemp channel', () => {
  assert.ok(preload.includes('spawnTempWorker:'), 'preload method missing');
  assert.ok(preload.includes("invoke('workers:spawnTemp'"), 'preload channel mismatch');
  assert.ok(preload.includes('TempWorkerInput'), 'input type missing');
  const tStart = preload.indexOf('interface TempWorkerInput');
  const tEnd = preload.indexOf('}', tStart);
  const t = preload.slice(tStart, tEnd);
  assert.ok(!t.includes('command'), 'TempWorkerInput must not carry `command`');
});

test('WorkersTab mounts the temp form on the same pipeline', () => {
  assert.ok(tab.includes('spawnTempWorker'), 'tab does not call spawnTempWorker');
  assert.ok(tab.includes("t('workersTab.spawnTitle')"), 'spawn title missing');
  assert.ok(tab.includes("t('workersTab.objectiveLabel')"), 'objective field missing');
  assert.ok(tab.includes("t('workersTab.cwdLabel')"), 'folder field missing');
  assert.ok(tab.includes('AGENT_PROVIDER_PRESETS'), 'engine picker must use presets, not free text');
  assert.ok(tab.includes('aria-busy'), 'form must expose busy state');
});

test('workersTab spawn keys exist in all three locales', () => {
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    for (const k of ['spawnTitle', 'spawnIntro', 'objectiveLabel', 'objectivePlaceholder',
      'cwdLabel', 'cwdHint', 'nameLabel', 'providerLabel', 'providerDefault',
      'start', 'starting', 'spawnedOk', 'spawnFailed']) {
      assert.ok(json.workersTab?.[k], `${loc}: workersTab.${k} missing`);
    }
    assert.ok(json.workersTab.spawnedOk.includes('{id}'), `${loc}: spawnedOk must carry the queue id`);
  }
});
