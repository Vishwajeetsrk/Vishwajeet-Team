'use strict';

/**
 * LABELED OS-PROCESS TEST — not part of `npm run test:focused` (the glob is
 * test/*.test.cjs; this file is *.electron.cjs on purpose), mirroring
 * computer-electron.electron.cjs. better-sqlite3 only loads under Electron's
 * ABI, and the Phase 8 / M3 gate is about the REAL boot path, so this harness
 * boots the real app main (out/main/index.js) in an isolated profile.
 *
 * Run AFTER `npm run build`:
 *   npx electron test/jobs-electron.electron.cjs --plant
 *   npx electron test/jobs-electron.electron.cjs --boot      (first boot)
 *   npx electron test/jobs-electron.electron.cjs --boot      (second boot)
 * Exit: 0 = all assertions passed, 1 = failure (printed).
 *
 * What each phase proves (PHASE-8-DESIGN §4 crash matrix, real SQLite):
 *
 * --plant  fresh isolated profile → migration 4 creates job_runs → three
 *          crash-matrix rows are written directly through the production
 *          SqliteJobRepo:
 *            A  state=running     — killed mid-job (exec may have happened)
 *            B  state=queued,     — unresolvable payload (unknown action)
 *               maxAttempts=1
 *            C  state=queued      — exec never started (safe to resume)
 *
 * --boot   boots the REAL app; bootstrapHiveServices() recovery must record:
 *            A → interrupted (+toast), NEVER re-run (the no-duplicate-
 *               external-action guarantee; effect unknown, so no auto-retry)
 *            B → failed with 'no executor for this run after restart'
 *               (never silent, never stuck queued)
 *            C → resumed → executed exactly once → succeeded (attempt=1)
 *          A second --boot run must leave every terminal state untouched:
 *          no re-execution (C stays attempt=1, A stays interrupted).
 */

const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = path.join(os.tmpdir(), 'jobs-electron-e2e');
const phase = process.argv.includes('--plant') ? 'plant'
  : process.argv.includes('--boot') ? 'boot'
  : null;
assert.ok(phase, 'usage: npx electron test/jobs-electron.electron.cjs --plant | --boot');

// Isolated profile, set BEFORE app ready (and before out/main reads paths).
if (phase === 'plant') {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
}
app.setPath('userData', userData);

const { PersistStore } = loadTs('src/main/db.ts');

const T0 = Date.now();

function plant() {
  const persist = new PersistStore();
  persist.open();
  const dispatchPayload = JSON.stringify({ action: 'dispatch', to: 'god', subject: 'gate', body: 'gate' });
  persist.insertJobRun({
    id: 'gate-a-running', jobId: 'gate-demo', kind: 'recurring',
    label: 'Gate A — killed mid-job', payload: dispatchPayload,
    state: 'running', attempt: 1, maxAttempts: 3, error: null,
    createdAt: T0, startedAt: T0, finishedAt: null, nextAt: null
  });
  persist.insertJobRun({
    id: 'gate-b-queued-bad', jobId: 'gate-demo', kind: 'event',
    label: 'Gate B — unresolvable payload', payload: JSON.stringify({ action: 'warp-speed' }),
    state: 'queued', attempt: 0, maxAttempts: 1, error: null,
    createdAt: T0, startedAt: null, finishedAt: null, nextAt: null
  });
  persist.insertJobRun({
    id: 'gate-c-queued-ok', jobId: 'gate-demo', kind: 'recurring',
    label: 'Gate C — safe to resume', payload: dispatchPayload,
    state: 'queued', attempt: 0, maxAttempts: 3, error: null,
    createdAt: T0, startedAt: null, finishedAt: null, nextAt: null
  });
  const rows = persist.listJobRuns({ limit: 10 });
  assert.equal(rows.length, 3, 'planted 3 rows');
  assert.equal(rows.filter((r) => r.state === 'queued' || r.state === 'running').length, 3);
  persist.close();
  console.log('PLANT OK — 3 rows (running / queued-bad / queued-ok) in', userData);
  app.exit(0);
}

function verify() {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'}`);
  };
  const persist = new PersistStore();
  persist.open();
  const rows = Object.fromEntries(persist.listJobRuns({ limit: 10 }).map((r) => [r.id, r]));
  try {
    assert.ok(rows['gate-a-running'], 'row A exists');
    assert.ok(rows['gate-b-queued-bad'], 'row B exists');
    assert.ok(rows['gate-c-queued-ok'], 'row C exists');

    // A: effect unknown → interrupted, never re-run.
    check('A running → interrupted', rows['gate-a-running'].state, 'interrupted');
    check('A interrupted error', rows['gate-a-running'].error,
      'app restarted while this run was in flight — not re-run automatically');
    check('A startedAt preserved', rows['gate-a-running'].startedAt !== null, true);

    // B: unresolvable after restart → recorded failed (never silent).
    check('B queued-bad → failed', rows['gate-b-queued-bad'].state, 'failed');
    check('B failure reason', rows['gate-b-queued-bad'].error, 'no executor for this run after restart');

    // C: exec never started → resumed and executed exactly once.
    check('C queued → succeeded', rows['gate-c-queued-ok'].state, 'succeeded');
    check('C attempt (exactly-once)', rows['gate-c-queued-ok'].attempt, 1);
    check('C finishedAt set', rows['gate-c-queued-ok'].finishedAt !== null, true);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + (e && e.message));
  }
  persist.close();
  if (failures > 0) {
    console.log(`GATE FAIL — ${failures} assertion(s) failed`);
    app.exit(1);
    return;
  }
  console.log('GATE OK — recovery matrix held in the real boot');
  app.exit(0);
}

if (phase === 'plant') {
  plant();
} else {
  // Real boot: index.js registers everything; whenReady opens the store and
  // bootstrapHiveServices() runs recovery (hive gate is false in this fresh
  // profile, and recovery now sits ABOVE that gate — that ordering is part of
  // what this test proves). Give the app time to finish boot, then assert.
  require(path.join(__dirname, '..', 'out', 'main', 'index.js'));
  setTimeout(verify, 6000);
}
