'use strict';

/**
 * LABELED OS-PROCESS TEST — not part of `npm run test:focused` (the glob is
 * test/*.test.cjs; this file is *.electron.cjs on purpose).
 *
 * Run (phase 1 — real runtime):
 *   npx electron test/computer-electron.electron.cjs
 * Run (phase 2 — next-launch wipe recovery, same profile, fresh process):
 *   npx electron test/computer-electron.electron.cjs --phase2
 * Exit: 0 = all assertions passed, 1 = failure (printed).
 *
 * Phase 1 proves the REAL Electron runtime that plain node cannot reach:
 *   1. ComputerBrowser opens a real hidden BrowserWindow on the computer
 *      partition, isolated per computer (distinct session storage paths).
 *   2. Navigation + page title are real (loadURL of a data: URL, no network).
 *   3. The browserDownloads gate on the REAL session: default-deny, a granted
 *      cap lets `will-download` through.
 *   4. captureScreen works from a HIDDEN window (the paint question the design
 *      doc flagged) and returns non-empty PNG bytes.
 *   5. dispose(policy=dispose) removes the real partition directory — either
 *      immediately, or recorded in the pending-wipe registry when Chromium
 *      still holds file locks (asserted, never silently skipped).
 *   6. REAL SQLite (migration 2): two computers created through the real
 *      SqliteComputerRepo, run to READY, workspace file written, DB closed
 *      ("app dies while READY").
 *   7. REAL SQLite (migration 3): the memories table exists after open,
 *      SqliteMemoryRepo + the real MemoryService write a record, the store is
 *      closed and re-opened, and the record roundtrips (restart survival).
 *
 * Phase 2 proves the registry guarantee: a FRESH process flushes whatever
 * phase 1 could not delete while its browser runtime was alive — plus the
 * restart contract: the SQLite rows and workspace files survive, and
 * reconcile() recovers stale READY statuses to OFFLINE with no replay.
 */

const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerBrowser } = loadTs('src/main/computerBrowser.ts');

// Fixed profile shared by both phases (phase 1 resets it, phase 2 reuses it),
// isolated from the real app profile BEFORE app ready.
const userData = path.join(os.tmpdir(), 'cmp-electron-e2e');
const PHASE2 = process.argv.includes('--phase2');
if (PHASE2) {
  assert.ok(fs.existsSync(userData), 'phase 2 requires phase 1 to have run');
} else {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
}
app.setPath('userData', userData);

function record(id) {
  return {
    id,
    agentId: `agent-${id}`,
    projectId: null,
    status: 'READY',
    runtimeType: 'local',
    workspaceId: `ws-${id}`,
    workspaceRoot: path.join(userData, 'computers', id, 'workspace'),
    browserProfileId: `persist:computer-${id}`,
    createdAt: 1,
    updatedAt: 1,
    lastStartedAt: 1,
    persistencePolicy: 'retain',
    resourceLimits: {
      startTimeoutMs: 5000,
      screenshotMaxBytes: 10_000_000,
      maxBrowserWindows: 1,
      sleepAfterIdleMs: 0,
      maxStartAttempts: 1,
    },
    permissions: { agent: {}, user: {} },
    config: {},
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readRegistry() {
  const file = path.join(userData, 'Partitions', 'computer-wipes.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const step = (name) => console.log(`  ok - ${name}`);

async function phase1() {
  let downloadsAllowed = false;
  const browser = new ComputerBrowser({ downloadGate: () => downloadsAllowed });

  // 1+2: real window, real partition, real navigation.
  const recA = record('cmp-e2e-a');
  const open = await browser.open(recA, 'data:text/html,<title>Computer A</title><h1>alpha</h1>');
  assert.equal(open.ok, true, `open failed: ${open.error}`);
  const st = browser.status(recA.id);
  assert.equal(st.open, true);
  assert.ok(st.url && st.url.startsWith('data:text/html'), `unexpected url ${st.url}`);
  assert.equal(st.title, 'Computer A', 'real page title');
  step('real hidden BrowserWindow opened, data: URL loaded, title read');

  // Session storage path must sit on the computer partition.
  const winA = browser['windows'].get(recA.id).win;
  const storagePathA = winA.webContents.session.getStoragePath();
  assert.ok(
    storagePathA.includes(path.join('Partitions', 'computer-cmp-e2e-a')),
    `partition storage not isolated: ${storagePathA}`
  );
  step(`session storage on computer partition: ${storagePathA}`);

  // browserDownloads gate on the REAL session (default-deny until granted).
  const fireWillDownload = () => {
    const ev = { prevented: false, preventDefault() { this.prevented = true; } };
    winA.webContents.session.emit('will-download', ev, {}, winA.webContents);
    return ev.prevented;
  };
  assert.equal(fireWillDownload(), true, 'real session denies downloads while the cap is false');
  downloadsAllowed = true;
  assert.equal(fireWillDownload(), false, 'real session lets a granted download through');
  downloadsAllowed = false;
  step('real session will-download gate: default-deny, grant flips it');

  // 3: hidden-window capture produces real PNG bytes (the open design question).
  let cap = await browser.capture(recA.id);
  if (!cap.ok || !cap.png || cap.png.length < 64) {
    await delay(300);
    cap = await browser.capture(recA.id);
  }
  assert.equal(cap.ok, true, `capture failed: ${cap.error}`);
  assert.ok(cap.png.length > 64, `PNG too small: ${cap.png.length} bytes`);
  assert.equal(cap.png[0], 0x89, 'PNG magic first byte');
  assert.equal(String.fromCharCode(cap.png[1], cap.png[2], cap.png[3]), 'PNG');
  assert.equal(winA.isVisible(), false, 'window returned to hidden after capture');
  step(`hidden capture produced ${cap.png.length} byte PNG, window still hidden`);

  // Isolation: a second computer gets its own session storage.
  const recB = record('cmp-e2e-b');
  const openB = await browser.open(recB, 'data:text/html,<title>Computer B</title><h1>beta</h1>');
  assert.equal(openB.ok, true, `open B failed: ${openB.error}`);
  const winB = browser['windows'].get(recB.id).win;
  const storagePathB = winB.webContents.session.getStoragePath();
  assert.notEqual(storagePathA, storagePathB, 'two computers must not share storage');
  assert.ok(storagePathB.includes(path.join('Partitions', 'computer-cmp-e2e-b')));
  assert.equal(winA.webContents.session === winB.webContents.session, false, 'distinct sessions');
  step('second computer has an independent partition/session');

  // Navigate for real.
  const nav = await browser.navigate(recA.id, 'data:text/html,<title>Navigated</title><p>moved</p>');
  assert.equal(nav.ok, true, `navigate failed: ${nav.error}`);
  assert.equal(browser.status(recA.id).title, 'Navigated');
  step('real navigation changed the page');

  // 4: destructive dispose — immediate wipe or recorded defer (never silent).
  const partitionDirA = path.join(userData, 'Partitions', 'computer-cmp-e2e-a');
  // Electron creates the dir lazily; seed a marker so the wipe proof does not
  // depend on that timing.
  if (!fs.existsSync(partitionDirA)) fs.mkdirSync(partitionDirA, { recursive: true });
  fs.writeFileSync(path.join(partitionDirA, 'marker.txt'), 'profile-data');
  const dispose = await browser.dispose(recA.id, true);
  assert.equal(dispose.ok, true, `dispose failed: ${dispose.error}`);
  assert.equal(browser.status(recA.id).open, false, 'window gone');
  if (fs.existsSync(partitionDirA)) {
    // Chromium still holds locks → the wipe MUST be recorded, not dropped.
    const pending = browser.listPendingWipes();
    assert.deepEqual(pending, ['persist:computer-cmp-e2e-a'], 'pending wipe registered in memory');
    assert.deepEqual(readRegistry(), ['persist:computer-cmp-e2e-a'], 'pending wipe persisted to disk');
    step(`partition still locked by Chromium → wipe deferred + recorded (${pending.join(',')})`);
  } else {
    assert.deepEqual(browser.listPendingWipes(), [], 'nothing pending after an immediate wipe');
    assert.equal(readRegistry(), null, 'no registry entry for an immediate wipe');
    step('partition directory wiped immediately');
  }

  // Retain path: B's profile must survive a retain dispose.
  const partitionDirB = path.join(userData, 'Partitions', 'computer-cmp-e2e-b');
  if (!fs.existsSync(partitionDirB)) fs.mkdirSync(partitionDirB, { recursive: true });
  fs.writeFileSync(path.join(partitionDirB, 'marker.txt'), 'profile-data');
  const disposeB = await browser.dispose(recB.id, false);
  assert.equal(disposeB.ok, true);
  assert.ok(fs.existsSync(partitionDirB), 'retain policy keeps the profile');
  step('retain dispose keeps the profile on disk');

  // 6: REAL SQLite (migration 2) — two computers, run to READY, then the
  // "app dies" moment: close the DB with READY rows + a workspace file left.
  const { PersistStore, SqliteComputerRepo } = loadTs('src/main/db.ts');
  const { ComputerManager } = loadTs('src/main/computer.ts');
  const store = new PersistStore();
  store.open();
  const repo = new SqliteComputerRepo(store);
  const manager = new ComputerManager({
    repo,
    computersRoot: path.join(userData, 'computers'),
    pty: { ptyForAgent: () => null, info: () => null, idleFor: () => undefined },
    browser: {
      async open() { return { ok: true }; },
      async close() { return { ok: true }; },
      async navigate() { return { ok: true }; },
      status: () => ({ open: false }),
      async capture() { return { ok: false, error: 'unused' }; },
      setVisible() { return { ok: true }; },
      async dispose() { return { ok: true }; },
      async shutdownAll() {},
    },
    emit: () => {},
    log: () => {},
    now: () => Date.now(),
    hasActiveTask: () => false,
  });
  const made1 = await manager.create({ agentId: 'alpha' });
  const made2 = await manager.create({ agentId: 'beta' });
  assert.ok(made1.ok && made2.ok, `sqlite create failed: ${made1.error || made2.error || ''}`);
  const sqliteA = made1.value.record;
  const sqliteB = made2.value.record;
  assert.notEqual(sqliteA.id, sqliteB.id, 'distinct ids in SQLite');
  const started1 = await manager.start(sqliteA.id);
  const started2 = await manager.start(sqliteB.id);
  assert.ok(started1.ok && started2.ok, `sqlite start failed: ${started1.error || started2.error || ''}`);
  assert.equal(manager.statusOf(sqliteA.id), 'READY');
  assert.equal(manager.statusOf(sqliteB.id), 'READY');
  assert.equal(repo.list().length, 2, 'two rows persisted');
  fs.writeFileSync(path.join(sqliteA.workspaceRoot, 'keep.txt'), 'workspace-file');
  store.close();
  step(`real SQLite: 2 computers (${sqliteA.id}, ${sqliteB.id}) reached READY, rows + workspace written, db closed`);

  // 7: REAL SQLite (migration 3) — memories roundtrip across a store restart.
  // Same guard style as section 6: db.ts + the service are loaded inside this
  // electron-only function, so the file still parses under plain node and the
  // better-sqlite3 (Electron ABI) calls never run outside the harness.
  const { PersistStore: MemPersist, SqliteMemoryRepo } = loadTs('src/main/db.ts');
  const { MemoryService } = loadTs('src/main/memoryService.ts');
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mem-e2e-'));
  const memDb = path.join(memDir, 'memories.db');
  try {
    const storeA = new MemPersist(memDb);
    storeA.open();
    // Migration 3 applied: a missing `memories` table makes better-sqlite3's
    // prepare() throw — a silent [] would not prove the schema landed.
    let memRows = null;
    assert.doesNotThrow(() => { memRows = storeA.listMemories(); },
      'memories table exists after open (migration 3)');
    assert.ok(Array.isArray(memRows), 'migration 3 produced the memories table');
    assert.deepEqual(memRows, [], 'fresh temp DB starts with no memory rows');
    step('migration 3 applied — memories table present in a fresh temp DB');

    const repoA = new SqliteMemoryRepo(storeA);
    const svcA = new MemoryService({ repo: repoA, now: () => Date.now() });
    const written = svcA.write(
      {
        scope: 'project', type: 'fact', content: 'electron roundtrip probe',
        projectId: 'proj-e2e', agentId: null, taskId: null, computerId: null,
        importance: 3, confidence: 0.9, expiresAt: null,
      },
      { kind: 'user' },
      { sourceKind: 'user', sourceRef: 'electron' },
    );
    assert.equal(written.ok, true, written.ok ? '' : `sqlite memory write failed: ${written.error}`);
    const memId = written.value.record.id;
    assert.equal(written.value.record.ownerId, 'proj-e2e', 'ownerId denormalized through SQLite');
    assert.equal(storeA.listMemories().length, 1, 'row persisted before the close');
    storeA.close();
    step(`memory ${memId} written through SqliteMemoryRepo, db closed ("app dies")`);

    // Restart: brand-new handle on the same file.
    const storeB = new MemPersist(memDb);
    storeB.open();
    const svcB = new MemoryService({ repo: new SqliteMemoryRepo(storeB), now: () => Date.now() });
    const reread = svcB.get(memId, { kind: 'user' });
    assert.equal(reread.ok, true, 'record survives the store restart');
    assert.equal(reread.value.content, 'electron roundtrip probe');
    assert.equal(reread.value.scope, 'project');
    assert.equal(reread.value.ownerId, 'proj-e2e');
    assert.equal(reread.value.status, 'active');
    const recall = svcB.retrieve({ kind: 'user' }, { query: 'roundtrip probe', projectId: 'proj-e2e' });
    assert.equal(recall.ok, true, recall.ok ? '' : recall.error);
    assert.deepEqual(recall.value.records.map((r) => r.id), [memId],
      'SQLite-backed retrieval returns the re-opened row');
    storeB.close();
    step(`restart contract: memory ${memId} roundtripped (content, scope, owner, status) after close/re-open`);
  } finally {
    fs.rmSync(memDir, { recursive: true, force: true });
  }

  await browser.shutdownAll();
  console.log('ELECTRON-OK-PHASE1: all real-window assertions passed');
  app.exit(0);
}

async function phase2() {
  // Fresh process, same profile, no windows: the browser runtime's file locks
  // are gone, so construction must flush whatever phase 1 recorded.
  const browser = new ComputerBrowser();
  const partitionDirA = path.join(userData, 'Partitions', 'computer-cmp-e2e-a');
  assert.equal(fs.existsSync(partitionDirA), false, 'deferred wipe completed at next launch');
  assert.equal(readRegistry(), null, 'registry cleared after recovery');
  assert.deepEqual(browser.listPendingWipes(), [], 'nothing left pending');
  step('next-launch recovery completed the deferred profile wipe');

  const partitionDirB = path.join(userData, 'Partitions', 'computer-cmp-e2e-b');
  assert.ok(fs.existsSync(partitionDirB), 'retain policy profile untouched by recovery');
  step('retain-policy profile untouched');

  // Restart contract with the REAL SQLite rows phase 1 left behind:
  // same ids, READY rows recovered to OFFLINE, workspace file byte-identical,
  // and reconcile dispatches no replay (pty/browser stubs would be observed).
  const { PersistStore, SqliteComputerRepo } = loadTs('src/main/db.ts');
  const { ComputerManager } = loadTs('src/main/computer.ts');
  const store = new PersistStore();
  store.open();
  const repo = new SqliteComputerRepo(store);
  const rows = repo.list();
  assert.equal(rows.length, 2, 'both rows survived the process restart');
  const events2 = [];
  let spawnedAny = 0;
  const manager2 = new ComputerManager({
    repo,
    computersRoot: path.join(userData, 'computers'),
    pty: {
      ptyForAgent: () => null,
      info: () => null,
      idleFor: () => undefined,
    },
    browser: {
      async open() { spawnedAny += 1; return { ok: true }; },
      async close() { return { ok: true }; },
      async navigate() { return { ok: true }; },
      status: () => ({ open: false }),
      async capture() { return { ok: false, error: 'unused' }; },
      setVisible() { return { ok: true }; },
      async dispose() { return { ok: true }; },
      async shutdownAll() {},
    },
    emit: () => {},
    log: (e) => events2.push(e),
    now: () => Date.now(),
    hasActiveTask: () => false,
  });
  const staleReady = rows.filter((r) => r.status === 'READY');
  assert.equal(staleReady.length, 2, 'rows were persisted as READY (crash state)');
  assert.ok(rows.every((r) => r.agentId === 'alpha' || r.agentId === 'beta'), 'agent identities intact');
  const keepFile = path.join(staleReady[0].workspaceRoot, 'keep.txt');
  assert.equal(fs.readFileSync(keepFile, 'utf8'), 'workspace-file', 'workspace file byte-identical');
  const rec = manager2.reconcile();
  assert.equal(rec.recoveredOffline, 2, 'both stale READY rows recovered');
  assert.ok(events2.some((e) => e.event === 'recovered-offline'), 'recovery event emitted');
  assert.ok(repo.list().every((r) => r.status === 'OFFLINE'), 'all rows reconciled to OFFLINE');
  assert.equal(spawnedAny, 0, 'reconcile never opens a browser');
  store.close();
  step(`restart contract: 2 rows intact (${rows.map((r) => r.id).join(', ')}), file intact, recoveredOffline=2, no replay`);

  await browser.shutdownAll();
  console.log('ELECTRON-OK-PHASE2: next-launch wipe recovery + SQLite restart contract passed');
  app.exit(0);
}

async function main() {
  await app.whenReady();
  try {
    if (PHASE2) await phase2();
    else await phase1();
  } catch (e) {
    console.error('ELECTRON-FAIL:', e && e.stack ? e.stack : e);
    app.exit(1);
  }
}

app.on('window-all-closed', () => { /* keep alive until we exit explicitly */ });
void main();
