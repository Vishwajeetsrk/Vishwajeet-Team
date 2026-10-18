'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { JobLedger } = loadTs('src/main/jobLedger.ts');
const { MemoryJobRepo } = loadTs('src/main/jobStore.ts');

/** Deterministic clock + mint so every timestamp/id in the suite is exact. */
function makeLedger(repo, start = 1_700_000_000_000) {
  let tick = start;
  let n = 0;
  const ledger = new JobLedger({
    repo,
    now: () => tick,
    mint: (prefix) => `${prefix}-${++n}`
  });
  return { ledger, advance: (ms) => { tick += ms; }, now: () => tick };
}

const BASE = {
  jobId: 'm1', kind: 'recurring', label: 'Hourly ops standup',
  payload: { action: 'dispatch', to: 'god', subject: 'Hourly ops standup', body: 'go' }
};

test('begin writes a queued run; markRunning is the durable write-ahead line', () => {
  const { ledger } = makeLedger(new MemoryJobRepo());
  const b = ledger.begin(BASE);
  assert.equal(b.ok, true);
  assert.equal(b.run.state, 'queued');
  assert.equal(b.run.attempt, 0);
  assert.equal(b.run.maxAttempts, 3, 'default retry limit is 3');
  assert.equal(b.run.finishedAt, null);
  assert.deepEqual(JSON.parse(b.run.payload), BASE.payload, 'payload round-trips as JSON');

  const running = ledger.markRunning(b.run.id);
  assert.equal(running.state, 'running');
  assert.equal(running.attempt, 1);
  assert.ok(running.startedAt !== null);

  // Not queued anymore — a second markRunning must refuse (stale timer guard).
  assert.equal(ledger.markRunning(b.run.id), null);
  assert.equal(ledger.get(b.run.id).attempt, 1, 'attempt not double-counted');
});

test('guarded transitions: succeed only from running; cancel only queued', () => {
  const { ledger } = makeLedger(new MemoryJobRepo());
  const b = ledger.begin(BASE);

  assert.equal(ledger.succeed(b.run.id), false, 'queued cannot succeed');
  assert.equal(ledger.cancel(b.run.id), true);
  assert.equal(ledger.cancel(b.run.id), false, 'cancel is not idempotent-over-terminal');
  // The cancelled row is dead: no transition can resurrect it.
  assert.equal(ledger.markRunning(b.run.id), null);
  assert.equal(ledger.get(b.run.id).state, 'cancelled');

  const c = ledger.begin({ ...BASE, jobId: 'm2' });
  ledger.markRunning(c.run.id);
  assert.equal(ledger.cancel(c.run.id), false, 'running runs are not cancellable');
  assert.equal(ledger.succeed(c.run.id), true);
  assert.equal(ledger.get(c.run.id).state, 'succeeded');
});

test('failAttempt: retry while attempts remain, failed at the limit, stale settle ignored', () => {
  const { ledger, now } = makeLedger(new MemoryJobRepo());
  const b = ledger.begin({ ...BASE, maxAttempts: 2 });
  ledger.markRunning(b.run.id);

  const retry = ledger.failAttempt(b.run.id, 'boom', { retryAt: now() + 5_000 });
  assert.equal(retry, 'queued');
  const row = ledger.get(b.run.id);
  assert.equal(row.state, 'queued');
  assert.equal(row.error, 'boom', 'last error visible while waiting to retry');
  assert.equal(row.nextAt, now() + 5_000);

  ledger.markRunning(b.run.id); // attempt 2
  const done = ledger.failAttempt(b.run.id, 'boom again', { retryAt: now() + 5_000 });
  assert.equal(done, 'failed', 'no retry past maxAttempts');
  const fin = ledger.get(b.run.id);
  assert.equal(fin.state, 'failed');
  assert.equal(fin.attempt, 2);
  assert.ok(fin.finishedAt !== null);

  // A zombie settle from an older attempt must not resurrect a terminal row.
  assert.equal(ledger.succeed(b.run.id), false);
  assert.equal(ledger.failAttempt(b.run.id, 'late'), null);
  assert.equal(ledger.get(b.run.id).state, 'failed');
});

test('daily cap: over cap begin refuses WITH a recorded refused row', () => {
  const { ledger } = makeLedger(new MemoryJobRepo());
  const spec = { ...BASE, maxRunsPerDay: 2 };

  assert.equal(ledger.begin(spec).ok, true);
  assert.equal(ledger.begin(spec).ok, true);

  const third = ledger.begin(spec);
  assert.equal(third.ok, false, 'cap exceeded → refuses');
  assert.equal(third.run.state, 'refused');
  assert.match(third.error, /daily cap exceeded \(2\/2 runs today\)/);

  const rows = ledger.list({ jobId: 'm1' });
  assert.equal(rows.filter((r) => r.state === 'refused').length, 1, 'refusal is visible history');
  assert.equal(rows.filter((r) => r.state === 'queued').length, 2);

  // Unlimited (0/absent) never refuses.
  for (let i = 0; i < 5; i++) assert.equal(ledger.begin({ ...BASE, maxRunsPerDay: 0 }).ok, true);
  assert.equal(ledger.begin({ jobId: 'other', kind: 'one-time', label: 'x', payload: {} }).ok, true);
});

test('cap counting is per-job and per local day', () => {
  const { ledger, advance } = makeLedger(new MemoryJobRepo());
  const spec = { ...BASE, maxRunsPerDay: 1 };
  assert.equal(ledger.begin(spec).ok, true);
  assert.equal(ledger.begin(spec).ok, false, 'same day → still capped');

  advance(24 * 60 * 60 * 1000 + 1_000);
  assert.equal(ledger.begin(spec).ok, true, 'next local day → cap resets');

  // Another job's runs never count against this one.
  assert.equal(
    ledger.begin({ ...spec, jobId: 'm2', maxRunsPerDay: 1 }).ok,
    true
  );
});

test('beginRefused records a terminal refusal without touching caps or exec', () => {
  const { ledger } = makeLedger(new MemoryJobRepo());
  const run = ledger.beginRefused(
    { jobId: 'webhook-trigger', kind: 'event', label: 'Deploy now', payload: { action: 'webhook-work' } },
    'Emergency STOP — work queued, not processed.'
  );
  assert.equal(run.state, 'refused');
  assert.match(run.error, /Emergency STOP/);
  assert.equal(ledger.get(run.id).state, 'refused');
  assert.equal(ledger.markRunning(run.id), null, 'refused never dispatches');
});

test('recover: running → interrupted (persisted, never re-runs); queued → resume set untouched', () => {
  const { ledger } = makeLedger(new MemoryJobRepo());
  const a = ledger.begin({ ...BASE, jobId: 'm1' });          // queued, attempt 0
  const b = ledger.begin({ ...BASE, jobId: 'm2' });
  ledger.markRunning(b.run.id);                              // running, attempt 1
  const c = ledger.begin({ ...BASE, jobId: 'm3' });
  ledger.markRunning(c.run.id);
  ledger.failAttempt(c.run.id, 'flaky', { retryAt: 1_700_000_600_000 }); // queued retry

  const res = ledger.recover();
  assert.equal(res.interrupted.length, 1);
  assert.equal(res.interrupted[0].id, b.run.id);
  assert.equal(res.toResume.length, 2, 'both queued rows (fresh + backoff) resume');
  assert.deepEqual(res.toResume.map((r) => r.id).sort(), [a.run.id, c.run.id].sort());

  const persisted = ledger.get(b.run.id);
  assert.equal(persisted.state, 'interrupted');
  assert.match(persisted.error, /restarted while this run was in flight/);
  assert.ok(persisted.finishedAt !== null, 'interrupted is terminal');
  assert.equal(ledger.get(a.run.id).state, 'queued', 'resume set not mutated by recover');
  assert.equal(ledger.get(c.run.id).nextAt, 1_700_000_600_000, 'backoff target survives');

  // Classification-only for queued rows: a second recover() still SEES them
  // (the runner's recoveredOnce guard is what prevents double-dispatch).
  const again = ledger.recover();
  assert.equal(again.interrupted.length, 0, 'nothing new to interrupt');
  assert.equal(again.toResume.length, 2, 'same queued rows, untouched');
  assert.equal(ledger.get(a.run.id).state, 'queued');
});

test('list: newest-first, jobId filter, limit; repo serialize/from models restart', () => {
  const repo = new MemoryJobRepo();
  const { ledger, advance } = makeLedger(repo);
  const first = ledger.begin({ ...BASE, jobId: 'm1' });
  advance(1_000);
  const second = ledger.begin({ ...BASE, jobId: 'm1' });
  advance(1_000);
  ledger.begin({ ...BASE, jobId: 'm2' });

  const all = ledger.list();
  assert.equal(all.length, 3);
  assert.ok(all[0].createdAt >= all[1].createdAt, 'newest first');
  assert.equal(all[1].id, second.run.id, 'second m1 run precedes the older one');
  assert.ok(all[2].id === first.run.id);
  assert.equal(ledger.list({ jobId: 'm1' }).length, 2);
  assert.equal(ledger.list({ limit: 1 }).length, 1);
  assert.ok(ledger.get(first.run.id), 'filter does not delete');

  const reloaded = MemoryJobRepo.from(repo.serialize());
  assert.equal(reloaded.list().length, 3, 'restart round-trip loses nothing');
  assert.equal(MemoryJobRepo.from('not json').list().length, 0, 'corrupt snapshot degrades to empty');
});
