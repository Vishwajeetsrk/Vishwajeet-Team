'use strict';

/**
 * Renderer performance + skeleton contract (fast lane, pulled forward from
 * M11): every IPC-backed panel shows a loading skeleton instead of flashing
 * its empty state, hot lists memoize + cap their first paint, and the kanban
 * poll skips state updates when disk content is unchanged.
 *
 * Static source-text contract (no Electron): the patterns below are the
 * optimizations, so a future edit that silently drops one fails here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const skeleton = read('src/renderer/src/components/Skeleton.tsx');
const css = read('src/renderer/src/design/global.css');
const jobs = read('src/renderer/src/components/triggers/JobHistory.tsx');
const kanban = read('src/renderer/src/components/TasksKanban.tsx');
const history = read('src/renderer/src/components/triggers/TriggerHistoryTab.tsx');
const memory = read('src/renderer/src/components/MemoryPanel.tsx');
const shell = read('src/renderer/src/components/CommandCenterPanel.tsx');
const triggersTab = read('src/renderer/src/components/triggers/TriggersTab.tsx');

test('Skeleton component exists with card/row/line variants', () => {
  for (const name of ['Skeleton', 'SkeletonLines', 'SkeletonCard', 'SkeletonRows']) {
    assert.ok(skeleton.includes(`export function ${name}`), `Skeleton.tsx missing ${name}`);
  }
  assert.ok(skeleton.includes('aria-hidden'), 'skeletons must be hidden from AT');
  assert.ok(skeleton.includes('cth-skeleton'), 'skeleton must use the shared CSS class');
});

test('global.css carries shimmer + content-visibility helpers', () => {
  assert.ok(css.includes('.cth-skeleton'), 'cth-skeleton class missing');
  assert.ok(css.includes('@keyframes cth-shimmer'), 'cth-shimmer keyframes missing');
  assert.ok(css.includes('.cth-cv'), 'cth-cv helper missing');
  assert.ok(css.includes('content-visibility: auto'), 'cth-cv must defer off-screen layout');
  assert.ok(
    css.includes('@media (prefers-reduced-motion: reduce)'),
    'reduced-motion guard missing (shimmer must freeze)'
  );
});

test('JobHistory: loading state, memoized rows, capped first paint, ticking clock', () => {
  assert.ok(jobs.includes('SkeletonRows'), 'JobHistory has no skeleton');
  assert.ok(jobs.includes('aria-busy'), 'JobHistory must expose aria-busy while loading');
  assert.ok(jobs.includes('const [loaded, setLoaded]'), 'JobHistory missing loaded flag');
  assert.ok(jobs.includes('memo(function JobRow'), 'JobRow is not memoized');
  assert.ok(jobs.includes('INITIAL_ROWS'), 'row cap missing');
  assert.ok(jobs.includes("t('jobHistory.showMore'"), 'show-more control missing');
  assert.ok(jobs.includes("t('jobHistory.showLess'"), 'show-less control missing');
  assert.ok(jobs.includes('relTime(now,'), 'relTime must take the ticking clock, not Date.now() per render');
  assert.ok(jobs.includes('cth-cv'), 'job rows must opt into content-visibility');
  assert.ok(jobs.includes("from '@/components/Skeleton'"), 'Skeleton import missing');
});

test('TasksKanban: unchanged-poll skip, memoized cards, skeleton first paint', () => {
  assert.ok(kanban.includes('JSON.stringify(prev) === JSON.stringify(next)'), 'poll skip-unchanged guard missing');
  assert.ok(kanban.includes('const TaskCard = memo('), 'TaskCard is not memoized');
  assert.ok(kanban.includes('onOpen={openTaskDetail}'), 'card callbacks must be store-stable, not inline arrows');
  assert.ok(kanban.includes('onDismiss={dismissTask}'), 'dismiss callback must be stable, not an inline arrow');
  assert.ok(kanban.includes('SkeletonLines'), 'kanban has no first-load skeleton');
  assert.ok(kanban.includes('const [loaded, setLoaded]'), 'kanban missing loaded flag');
  assert.ok(kanban.includes('cth-cv'), 'kanban cards must opt into content-visibility');
});

test('TriggerHistory: loading state, memoized exchanges', () => {
  assert.ok(history.includes('SkeletonRows'), 'history has no skeleton');
  assert.ok(history.includes('const [loaded, setLoaded]'), 'history missing loaded flag');
  assert.ok(history.includes('const ExchangeCard = memo('), 'ExchangeCard is not memoized');
  assert.ok(history.includes('cth-cv'), 'exchanges must opt into content-visibility');
});

test('MemoryPanel: no not-installed flash while status loads', () => {
  assert.ok(memory.includes('SkeletonLines'), 'MemoryPanel has no skeleton');
  assert.ok(memory.includes('status && !status.available'), 'setup block must wait for real status');
  assert.ok(memory.includes("t('memoryPanel.loading')"), 'loading state label missing');
});

test('jobHistory showMore/showLess exist in all three locales', () => {
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    assert.ok(json.jobHistory?.showMore?.includes('{count}'), `${loc}: jobHistory.showMore`);
    assert.ok(json.jobHistory?.showLess, `${loc}: jobHistory.showLess`);
  }
});

test('perf work preserves the pinned wiring contracts', () => {
  assert.ok(triggersTab.includes("from './JobHistory'"), 'TriggersTab lost the JobHistory import (job-runner contract)');
  assert.ok(shell.includes("import { CeoPanel } from './CeoPanel';"), 'CeoPanel static import must stay (ceo contract)');
  assert.ok(shell.includes("import { ComputerPanel } from './ComputerPanel';"), 'ComputerPanel static import must stay (computer contract)');
  assert.ok(shell.includes("tab === 'ceo' && <CeoPanel />"), 'ceo tab render condition must stay');
  assert.ok(shell.includes("tab === 'computer' && <ComputerPanel />"), 'computer tab render condition must stay');
});
