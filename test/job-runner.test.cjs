'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { JobLedger } = loadTs('src/main/jobLedger.ts');
const { JobRunner } = loadTs('src/main/jobRunner.ts');
const { MemoryJobRepo } = loadTs('src/main/jobStore.ts');

/**
 * Deterministic environment: manual timer queue (no real sleeps), injectable
 * clock, captured notifications/changes. `disk` models the durable store —
 * serialize() → makeEnv(disk) models an app RESTART over the same rows.
 */
function makeEnv(disk) {
  let nowMs = 1_700_000_000_000;
  let seq = 0;
  const repo = disk ? MemoryJobRepo.from(disk) : new MemoryJobRepo();
  const ledger = new JobLedger({ repo, now: () => nowMs, mint: (p) => `${p}-${++seq}` });
  const queue = [];
  const notifies = [];
  let changes = 0;
  const runner = new JobRunner({
    ledger,
    now: () => nowMs,
    schedule: (fn, ms) => { const h = { fn, at: nowMs + ms }; queue.push(h); return h; },
    unschedule: (h) => { const i = queue.indexOf(h); if (i >= 0) queue.splice(i, 1); },
    notify: (title, body) => notifies.push({ title, body }),
    onChange: () => { changes++; }
  });

  const fireDue = () => {
    let guard = 0;
    for (;;) {
      const due = queue.filter((h) => h.at <= nowMs).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      queue.splice(queue.indexOf(due), 1);
      if (++guard > 200) throw new Error('timer fire loop');
      due.fn();
    }
  };
  const advance = (ms) => { nowMs += ms; fireDue(); };

  return {
    runner, ledger, repo, queue, notifies,
    changes: () => changes,
    advance, fireDue, now: () => nowMs
  };
}

const SPEC = {
  jobId: 'm1', kind: 'recurring', label: 'Hourly ops standup',
  payload: { action: 'dispatch', to: 'god', subject: 'standup', body: 'go' }
};

test('happy path: sync exec settles inside submit; stamp runs before the external action', () => {
  const env = makeEnv();
  const order = [];
  const res = env.runner.submit({
    ...SPEC,
    beforeExec: () => order.push('stamp'),
    exec: () => order.push('exec')
  });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'succeeded', 'sync exec returns its final state (HTTP contract)');
  assert.deepEqual(order, ['stamp', 'exec'], 'write-ahead order: stamp lands BEFORE exec');
  const row = env.ledger.get(res.runId);
  assert.equal(row.state, 'succeeded');
  assert.equal(row.attempt, 1);
  assert.ok(env.changes() > 0, 'renderer push fired');
});

test('stamp is not conditional on success — a failed attempt still consumed the slot', () => {
  const env = makeEnv();
  const order = [];
  const res = env.runner.submit({
    ...SPEC, maxAttempts: 1,
    beforeExec: () => order.push('stamp'),
    exec: () => { order.push('exec'); throw new Error('send failed'); }
  });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'failed');
  assert.deepEqual(order, ['stamp', 'exec'], 'stamp happened even though exec threw');
  assert.equal(env.ledger.get(res.runId).state, 'failed');
});

test('retry with backoff: failed attempt re-queues, fires after backoff, succeeds', () => {
  const env = makeEnv();
  let calls = 0;
  const res = env.runner.submit({
    ...SPEC, maxAttempts: 2, backoffBaseMs: 1_000,
    exec: () => { calls++; if (calls === 1) throw new Error('flaky'); }
  });
  assert.equal(res.state, 'queued', 'attempt 1 failed → re-queued for retry');
  const row = env.ledger.get(res.runId);
  assert.equal(row.attempt, 1);
  assert.match(row.error, /flaky/);
  assert.equal(row.nextAt, env.now() + 1_000, 'backoff base for attempt 1');
  assert.equal(env.queue.length, 1, 'one retry timer armed');
  assert.equal(calls, 1);

  env.advance(999);
  assert.equal(calls, 1, 'not before the backoff');
  env.advance(1);
  assert.equal(calls, 2, 'retried');
  assert.equal(env.ledger.get(res.runId).state, 'succeeded');
  assert.equal(env.notifies.length, 0, 'success never toasts');
});

test('exhausting attempts → failed, terminal, failure notification once', () => {
  const env = makeEnv();
  let calls = 0;
  const res = env.runner.submit({
    ...SPEC, maxAttempts: 2, backoffBaseMs: 100,
    exec: () => { calls++; throw new Error('always broken'); }
  });
  assert.equal(res.state, 'queued');
  env.advance(100); // attempt 2
  assert.equal(calls, 2);
  const row = env.ledger.get(res.runId);
  assert.equal(row.state, 'failed');
  assert.equal(row.attempt, 2);
  assert.equal(env.notifies.length, 1);
  assert.match(env.notifies[0].title, /Job failed: Hourly ops standup/);
  assert.match(env.notifies[0].body, /always broken/);
  assert.equal(env.queue.length, 0, 'no timers left');
});

test('timeout fails the attempt; a late settle from the zombie is ignored', async () => {
  const env = makeEnv();
  let resolveExec;
  const res = env.runner.submit({
    ...SPEC, maxAttempts: 1, timeoutMs: 5_000,
    exec: () => new Promise((r) => { resolveExec = r; })
  });
  assert.equal(res.state, 'running');
  assert.equal(env.queue.length, 1, 'timeout timer armed');

  env.advance(5_000);
  const row = env.ledger.get(res.runId);
  assert.equal(row.state, 'failed');
  assert.match(row.error, /timed out after 5000ms/);
  assert.equal(env.notifies.length, 1, 'timeout is a terminal failure → toast');

  resolveExec(); // the zombie completes AFTER the record settled
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(env.ledger.get(res.runId).state, 'failed', 'stale settle cannot overwrite');
});

test('cancel: queued (backoff-waiting) runs cancel; the retry never fires', () => {
  const env = makeEnv();
  let calls = 0;
  const res = env.runner.submit({
    ...SPEC, maxAttempts: 3, backoffBaseMs: 1_000,
    exec: () => { calls++; throw new Error('boom'); }
  });
  assert.equal(res.state, 'queued');
  assert.equal(env.queue.length, 1);

  assert.equal(env.runner.cancel(res.runId), true);
  assert.equal(env.ledger.get(res.runId).state, 'cancelled');
  assert.equal(env.queue.length, 0, 'backoff timer cleared');
  assert.equal(env.runner.cancel(res.runId), false, 'terminal → not cancellable again');

  env.advance(60_000);
  assert.equal(calls, 1, 'no retry after cancel');
});

test('GATE — cap exceeded → job refuses: recorded, never dispatched', () => {
  const env = makeEnv();
  let calls = 0;
  const exec = () => { calls++; };

  const first = env.runner.submit({ ...SPEC, maxRunsPerDay: 1, exec });
  assert.equal(first.ok, true);
  assert.equal(calls, 1);

  const second = env.runner.submit({ ...SPEC, maxRunsPerDay: 1, exec });
  assert.equal(second.ok, false, 'refused');
  assert.equal(second.state, 'refused');
  assert.match(second.error, /daily cap exceeded/);
  assert.equal(calls, 1, 'exec never called for the refused run');
  const refused = env.ledger.get(second.runId);
  assert.equal(refused.state, 'refused');
  assert.ok(refused.finishedAt !== null, 'refusal is visible history');
});

test('recordRefused: terminal refusal row without exec (emergency STOP path)', () => {
  const env = makeEnv();
  const id = env.runner.recordRefused(
    { jobId: 'webhook-trigger', kind: 'event', label: 'Deploy', payload: { action: 'webhook-work' } },
    'Emergency STOP — work queued, not processed.'
  );
  const row = env.ledger.get(id);
  assert.equal(row.state, 'refused');
  assert.match(row.error, /Emergency STOP/);
  assert.equal(env.queue.length, 0, 'nothing armed');
});

test('GATE — kill mid-job → relaunch: interrupted, NEVER re-run (exactly-once)', () => {
  const env = makeEnv();
  let calls1 = 0;
  const res = env.runner.submit({
    ...SPEC, label: 'Deploy pipeline',
    exec: () => { calls1++; return new Promise(() => { /* hangs forever */ }); }
  });
  assert.equal(res.state, 'running', 'in flight');
  assert.equal(calls1, 1);

  // CRASH: the process dies here. Durable rows survive; timers and the in-flight
  // promise die with it. Relaunch over the same store:
  const env2 = makeEnv(env.repo.serialize());
  const execs2 = [];
  const summary = env2.runner.recover((run) => ({
    jobId: run.jobId, kind: run.kind, label: run.label,
    payload: JSON.parse(run.payload), maxAttempts: run.maxAttempts,
    exec: () => { execs2.push(run.id); }
  }));

  assert.deepEqual(summary, { resumed: 0, interrupted: 1 });
  const row = env2.ledger.get(res.runId);
  assert.equal(row.state, 'interrupted');
  assert.match(row.error, /restarted while this run was in flight/);
  assert.equal(execs2.length, 0, 'the interrupted run is never re-executed');
  assert.equal(calls1, 1, 'exactly-once: the effect ran at most once, ever');
  assert.equal(env2.notifies.length, 1);
  assert.match(env2.notifies[0].title, /Job interrupted: Deploy pipeline/);

  // Bootstrap may run twice (onboarding/changeHome/whenReady) — recovery is
  // guarded: a second pass must not touch anything.
  const again = env2.runner.recover(() => { throw new Error('must not resolve again'); });
  assert.deepEqual(again, { resumed: 0, interrupted: 0 });
});

test('GATE — crash between begin and markRunning: resume dispatches exactly once', () => {
  const env = makeEnv();
  // Write-ahead intent only: queued row exists, exec never started.
  const begun = env.ledger.begin({ ...SPEC, jobId: 'm1' });
  assert.equal(begun.run.state, 'queued');
  assert.equal(begun.run.attempt, 0);

  const env2 = makeEnv(env.repo.serialize());
  let calls = 0;
  const summary = env2.runner.recover((run) => ({
    jobId: run.jobId, kind: run.kind, label: run.label,
    payload: JSON.parse(run.payload), maxAttempts: run.maxAttempts,
    exec: () => { calls++; }
  }));
  assert.equal(summary.resumed, 1);
  assert.equal(summary.interrupted, 0);

  env2.fireDue(); // attempt-0 resume is armed with delay 0
  assert.equal(calls, 1, 'exec ran exactly once after relaunch');
  assert.equal(env2.ledger.get(begun.run.id).state, 'succeeded');
});

test('recovery resumes a backoff-waiting run where it left off', () => {
  const env = makeEnv();
  const b = env.ledger.begin({ ...SPEC, maxAttempts: 3 });
  env.ledger.markRunning(b.run.id);
  env.ledger.failAttempt(b.run.id, 'flaky', { retryAt: env.now() + 60_000 });
  assert.equal(env.ledger.get(b.run.id).state, 'queued');

  const env2 = makeEnv(env.repo.serialize());
  let calls = 0;
  const summary = env2.runner.recover((run) => ({
    jobId: run.jobId, kind: run.kind, label: run.label,
    payload: JSON.parse(run.payload), maxAttempts: run.maxAttempts,
    exec: () => { calls++; }
  }));
  assert.equal(summary.resumed, 1);
  env2.advance(60_000); // backoff target reached
  assert.equal(calls, 1, 'attempt 2 after the persisted backoff');
  assert.equal(env2.ledger.get(b.run.id).state, 'succeeded');
});

test('recovery: unresolvable payload is recorded as failed, never left queued', () => {
  const env = makeEnv();
  env.ledger.begin({ jobId: 'ghost', kind: 'one-time', label: 'Ghost', payload: '???broken' });
  // Force the payload to non-JSON so the resolver cannot rebuild it.
  env.repo.update(env.repo.list()[0].id, { payload: '{{{' });

  const env2 = makeEnv(env.repo.serialize());
  const summary = env2.runner.recover(() => null);
  assert.equal(summary.resumed, 0);
  assert.equal(summary.interrupted, 0);
  const row = env2.ledger.list()[0];
  assert.equal(row.state, 'failed');
  assert.match(row.error, /no executor for this run after restart/);
});

test('shutdown clears armed timers but leaves rows queued (resume next boot)', () => {
  const env = makeEnv();
  let calls = 0;
  const res = env.runner.submit({
    ...SPEC, maxAttempts: 3, backoffBaseMs: 1_000,
    exec: () => { calls++; throw new Error('x'); }
  });
  assert.equal(env.queue.length, 1);
  env.runner.shutdown();
  assert.equal(env.queue.length, 0, 'timers gone (quit/reset/changeHome teardown)');
  assert.equal(env.ledger.get(res.runId).state, 'queued', 'row stays durable for next boot');

  const env2 = makeEnv(env.repo.serialize());
  let calls2 = 0;
  const s = env2.runner.recover((run) => ({
    jobId: run.jobId, kind: run.kind, label: run.label,
    payload: JSON.parse(run.payload), maxAttempts: run.maxAttempts,
    exec: () => { calls2++; }
  }));
  assert.equal(s.resumed, 1, 'queued row resumes on the new boot');
  env2.advance(1_000); // persisted backoff target
  assert.equal(calls2, 1, 'the resumed retry ran in the new process');
  assert.equal(calls, 1, 'old process never ran the retry');
  assert.equal(env2.ledger.get(res.runId).state, 'succeeded');
});

// ─── wiring contract (index.ts + shared) ────────────────────────────────────

test('index.ts wiring: channels, recovery-before-schedule, write-ahead order, event choke point', () => {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');

  for (const ch of ['jobs:list', 'jobs:cancel', 'jobs:retry', 'jobs:submit']) {
    assert.ok(src.includes(`ipcMain.handle('${ch}'`), `missing IPC channel ${ch}`);
  }
  assert.ok(src.includes("liveWebContents()?.send('jobs:updated')"), 'renderer push missing');

  const recIdx = src.indexOf('jobRunner.recover(jobSpecFromRun)');
  const syncIdx = src.indexOf('syncMissions(); // arm recurring');
  assert.ok(recIdx > 0, 'boot recovery call missing');
  assert.ok(recIdx < syncIdx, 'recovery must run BEFORE schedules re-arm');
  // Recovery sits ABOVE the hive gate: the ledger is desktop-local, webhook /
  // one-time runs can exist with the hive disabled, and no hive filesystem work
  // may ever starve the sweep (PHASE-8-DESIGN §4).
  const bootIdx = src.indexOf('function bootstrapHiveServices');
  const gateIdx = src.indexOf('if (!hive.enabled()) return;', bootIdx);
  assert.ok(bootIdx > 0 && gateIdx > 0, 'bootstrap gate not found');
  assert.ok(recIdx > bootIdx && recIdx < gateIdx,
    'recovery must sit inside bootstrap but ABOVE the hive.enabled() gate');

  assert.ok(src.includes('jobRunner.recordRefused'), 'emergency STOP refusal not recorded');
  assert.ok(src.includes("kind: 'event'"), 'webhook dispatch is not a ledger run');
  assert.ok(src.includes('function performWebhookWork'), 'webhook exec split missing');
  assert.ok(src.includes('maxRunsPerDay: m.dailyCap'), 'mission daily cap not wired');

  // Write-ahead order inside fire(): the stamp hook is declared before exec.
  const fireStart = src.indexOf('const fire = ()');
  const fireEnd = src.indexOf('const entry: MissionTimer', fireStart);
  assert.ok(fireStart > 0 && fireEnd > fireStart, 'fire() slice not found');
  const fireSlice = src.slice(fireStart, fireEnd);
  const stampIdx = fireSlice.indexOf('beforeExec:');
  const execIdx = fireSlice.indexOf('exec: ()');
  assert.ok(stampIdx >= 0 && execIdx > stampIdx, 'stamp (beforeExec) must precede exec');

  // Teardown: timers die with the process on quit/reset/changeHome.
  assert.equal(src.split('jobRunner.shutdown()').length - 1, 3, 'quit/reset/changeHome teardowns');

  // Shared contract: state machine + honest local label source.
  const shared = fs.readFileSync(path.join(root, 'src/shared/jobs.ts'), 'utf8');
  for (const s of ['queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'refused']) {
    assert.ok(shared.includes(`'${s}'`), `state ${s} missing from shared contract`);
  }

  // The design names its deferrals (gate rule carried from M2).
  const design = fs.readFileSync(path.join(root, 'docs/PHASE-8-DESIGN.md'), 'utf8');
  assert.match(design, /Named deferrals/);
  assert.match(design, /Dollar-cost per-run caps/);

  // Real-boot gate harness (house pattern: *.electron.cjs, run via `npx
  // electron` after a build) — the kill-mid-job → interrupted matrix runs on
  // production SQLite in a real app boot, not only on the MemoryJobRepo.
  const harness = fs.readFileSync(path.join(root, 'test/jobs-electron.electron.cjs'), 'utf8');
  assert.ok(harness.includes('--plant'), 'electron gate harness missing plant phase');
  assert.ok(harness.includes('GATE OK'), 'electron gate harness missing its pass marker');

  // Panel wiring: the fifth Triggers card + preload surface + locale keys.
  const tab = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/triggers/TriggersTab.tsx'), 'utf8'
  );
  assert.ok(tab.includes("from './JobHistory'"), 'TriggersTab does not mount JobHistory');
  assert.ok(tab.includes("t('triggersTab.jobs')"), 'jobs card title missing');
  const panel = fs.readFileSync(
    path.join(root, 'src/renderer/src/components/triggers/JobHistory.tsx'), 'utf8'
  );
  assert.ok(panel.includes('window.cth.listJobs'), 'panel not wired to preload');
  assert.ok(panel.includes('jobsCancel') && panel.includes('jobsRetry'), 'actions missing');
  assert.ok(panel.includes('jobHistory.localNote'), 'honesty label missing');

  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(
      fs.readFileSync(path.join(root, `src/renderer/src/i18n/locales/${loc}.json`), 'utf8')
    );
    assert.ok(json.triggersTab?.jobs && json.triggersTab?.jobsBlurb, `${loc}: triggersTab.jobs`);
    assert.ok(json.jobHistory?.summaryNone && json.jobHistory?.localNote, `${loc}: jobHistory core keys`);
    assert.deepEqual(
      Object.keys(json.jobHistory.state).sort(),
      ['cancelled', 'failed', 'interrupted', 'queued', 'refused', 'running', 'succeeded'],
      `${loc}: state labels incomplete`
    );
  }
});
