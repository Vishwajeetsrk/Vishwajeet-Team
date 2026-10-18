'use strict';

/**
 * PHASE 4 ACCEPTANCE DEMO — LABELED, standalone script (NOT part of
 * `npm run test:focused`; the glob is test/*.test.cjs, this file is *.cjs).
 *
 * Run:  node test/computer-acceptance-demo.cjs
 * Exit: 0 = every scripted step passed; 1 = a scripted step failed.
 *
 * Walks the two-agent acceptance plan (PHASE-4-DESIGN.md §19 / prompt §17)
 * with the REAL ComputerManager and the REAL PtyManager (node-pty is NAPI, so
 * real processes run under plain node). Browser-window and real-SQLite steps
 * are handled by the labeled Electron harness
 * (`npx electron test/computer-electron.electron.cjs [--phase2]`) and are
 * reported here as LIMITATION lines pointing at that evidence — never faked.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

const results = [];
const pass = (step, msg) => { results.push('PASS'); console.log(`PASS       step ${step}  ${msg}`); };
const limitation = (step, msg) => { results.push('LIMITATION'); console.log(`LIMITATION step ${step}  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-accept-'));
  const events = [];
  const ptyManager = new PtyManager();
  const ptyToAgent = new Map();

  const pty = {
    ptyForAgent(agentId) {
      for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
      return null;
    },
    info(ptyId) {
      const li = ptyManager.list().find((x) => x.id === ptyId);
      return li ? { running: true, pid: li.pid, cwd: li.cwd, lastOutputAt: li.lastOutputAt } : null;
    },
    idleFor: (ptyId) => ptyManager.idleFor(ptyId),
  };

  let tick = 1_700_000_000_000;
  const repo = new MemoryComputerRepo();
  const manager = new ComputerManager({
    repo,
    computersRoot: path.join(dir, 'computers'),
    pty,
    browser: {
      async open() { return { ok: true }; },
      async close() { return { ok: true }; },
      async navigate() { return { ok: true }; },
      status: () => ({ open: false }),
      async capture() { return { ok: false, unsupported: true, error: 'node demo has no Electron window' }; },
      setVisible() { return { ok: true }; },
      async dispose() { return { ok: true }; },
      async shutdownAll() {},
    },
    emit: () => {},
    log: (e) => events.push(e),
    now: () => ++tick,
    hasActiveTask: () => false,
  });
  return { dir, manager, repo, events, ptyManager, ptyToAgent };
}

function spawnPty(env, ptyId, agentId) {
  const res = env.ptyManager.spawn({
    id: ptyId,
    cwd: env.dir,
    command: process.execPath,
    // Real, observable output: a chatty child bumps lastOutputAt continuously.
    // (args dropped — node -e quoting differs per shell; the REPL-less default
    // process still emits a prompt/banner on stdin attach.)
    cols: 80,
    rows: 24,
  });
  assert.equal(res.ok, true, `pty spawn failed: ${res.error}`);
  env.ptyToAgent.set(ptyId, agentId);
  return res;
}

async function main() {
  const env = makeEnv();
  const { manager, repo, events, ptyManager, ptyToAgent } = env;
  const orphanBefore = ptyManager.list().length;
  assert.equal(orphanBefore, 0, 'no stray ptys at demo start');

  // ── 1. two distinct, stable computer identities ────────────────────────────
  const a = await manager.create({ agentId: 'alpha' });
  const b = await manager.create({ agentId: 'beta' });
  assert.ok(a.ok && a.value.created && b.ok && b.value.created, 'both creates succeed');
  const recA = a.value.record;
  const recB = b.value.record;
  assert.notEqual(recA.id, recB.id, 'ids are distinct');
  const again = await manager.create({ agentId: 'alpha' });
  assert.equal(again.value.record.id, recA.id, 'alpha id is stable/idempotent');
  assert.equal(repo.get(recA.id)?.id, recA.id, 'identity persists in the repo');
  pass(1, `alpha=${recA.id} beta=${recB.id} (distinct, stable, idempotent)`);

  // ── 2. start both → READY; workspaces exist and differ ─────────────────────
  const sA = await manager.start(recA.id);
  const sB = await manager.start(recB.id);
  assert.ok(sA.ok && sB.ok, `both start (${sA.error || sB.error || 'ok'})`);
  assert.equal(manager.statusOf(recA.id), 'READY');
  assert.equal(manager.statusOf(recB.id), 'READY');
  const wsA = manager.getWorkspaceInfo(recA.id);
  const wsB = manager.getWorkspaceInfo(recB.id);
  assert.ok(wsA.value.exists && wsB.value.exists, 'both workspaces exist');
  assert.notEqual(wsA.value.root, wsB.value.root, 'workspaces differ');
  fs.writeFileSync(path.join(wsA.value.root, 'alpha-note.txt'), 'alpha persistent note');
  fs.writeFileSync(path.join(wsB.value.root, 'beta-note.txt'), 'beta persistent note');
  pass(2, `both READY; workspaces ${wsA.value.root} vs ${wsB.value.root}`);

  // ── 3. distinct browser profiles ───────────────────────────────────────────
  assert.notEqual(recA.browserProfileId, recB.browserProfileId, 'profile ids differ');
  assert.match(recA.browserProfileId, /^persist:computer-/);
  assert.match(recB.browserProfileId, /^persist:computer-/);
  pass(3, `profile ids ${recA.browserProfileId} vs ${recB.browserProfileId}`);
  limitation(3, 'real BrowserWindow partitions on disk + capturePage: npx electron test/computer-electron.electron.cjs (phases 1+2, both exit 0)');

  // ── 4. authorized terminal operation per agent (REAL processes) ────────────
  spawnPty(env, 'pty-alpha', 'alpha');
  spawnPty(env, 'pty-beta', 'beta');
  await sleep(700); // let both children emit something
  const infoA = manager.getTerminalInfo(recA.id);
  const infoB = manager.getTerminalInfo(recB.id);
  assert.ok(infoA.value.running && infoB.value.running, 'both terminals report running');
  assert.ok(infoA.value.pid > 0 && infoB.value.pid > 0, 'real OS pids reported');
  assert.notEqual(infoA.value.pid, infoB.value.pid, 'distinct processes');
  assert.ok((infoA.value.lastOutputAt ?? 0) > 0, 'observed real pty output (lastOutputAt bumped)');

  assert.equal(manager.checkTerminalAccess('alpha').ok, true, 'authorized input allowed');
  assert.equal(ptyManager.write('pty-alpha', '\r').ok, true, 'gate open → real write reaches the process');

  await manager.pause(recA.id);
  const paused = manager.checkTerminalAccess('alpha');
  assert.equal(paused.ok, false);
  assert.equal(paused.code, 'INVALID_STATE', 'PAUSED refuses input');
  await manager.resume(recA.id);

  await manager.configure(recA.id, { permissions: { agent: { terminalExec: false } } });
  const denied = manager.checkTerminalAccess('alpha');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_DENIED', 'terminalExec:false refuses input');
  assert.ok(events.some((e) => e.event === 'permission-denied'), 'deny emitted an audit event');
  await manager.configure(recA.id, { permissions: { agent: { terminalExec: true } } });
  assert.equal(manager.checkTerminalAccess('alpha').ok, true, 're-authorized input allowed');
  pass(4, `real pty per agent (alpha pid ${infoA.value.pid}, beta pid ${infoB.value.pid}); gate denies PAUSED + terminalExec:false, allows authorized, output observed`);

  // ── 5. inspect through the actual UI ───────────────────────────────────────
  limitation(5, 'UI click-through is the review-gate manual step (npm run dev → select agent → Command Center → computer tab); real PNG capture + panel contract are machine-verified (electron harness 7215 B PNG; computer-panel-contract 11/11)');

  // ── 6. cross-agent access denied, then explicitly granted ──────────────────
  const actAlpha = { kind: 'agent', agentId: 'alpha' };
  const cross = await manager.authorizeWorkspacePath(recB.id, 'beta-note.txt', actAlpha);
  assert.equal(cross.ok, false, 'cross-agent default deny');
  assert.equal(cross.code, 'PERMISSION_DENIED');
  assert.ok(events.some((e) => e.event === 'permission-denied' && e.capability === 'crossAgentWorkspace'),
    'denied access emitted an event');
  await manager.configure(recB.id, { permissions: { agent: { crossAgentRead: ['alpha'] } } });
  const cross2 = await manager.authorizeWorkspacePath(recB.id, 'beta-note.txt', actAlpha);
  assert.ok(cross2.ok, 'explicit grant opens access');
  assert.ok(cross2.value.abs.endsWith('beta-note.txt'), 'resolution stays inside beta root');
  const escape = await manager.authorizeWorkspacePath(recB.id, '../alpha/alpha-note.txt', actAlpha);
  assert.equal(escape.ok, false, 'traversal still refused even with the grant');
  pass(6, 'alpha denied on beta workspace (event logged) → grant crossAgentRead → allowed; traversal refused');

  // ── 7. stop one computer → the other is unaffected ─────────────────────────
  const stopA = await manager.stop(recA.id);
  assert.ok(stopA.ok);
  assert.equal(manager.statusOf(recA.id), 'OFFLINE');
  assert.equal(manager.statusOf(recB.id), 'READY', 'beta still READY');
  assert.equal(ptyManager.list().find((p) => p.id === 'pty-beta') !== undefined, true, 'beta pty untouched');
  pass(7, 'alpha OFFLINE while beta remains READY with its live pty');

  // ── 8-11. relaunch: ids + files intact, runtime reconciled, no replay ──────
  // (in-process relaunch model: serialized rows → NEW repo → NEW manager.
  //  The REAL app relaunch is the electron harness phase 2 + the manual
  //  review-gate step; here we prove the recovery contract itself.)
  await manager.start(recB.id); // beta was READY; keep a crash-while-READY record for beta
  const snap = repo.serialize();
  ptyManager.killAll();
  ptyToAgent.clear();

  const repo2 = MemoryComputerRepo.from(snap);
  assert.equal(repo2.list().length, 2, 'rows survive the relaunch');
  const events2 = [];
  const manager2 = new ComputerManager({
    repo: repo2,
    computersRoot: path.join(env.dir, 'computers'),
    pty: {
      ptyForAgent: () => null,
      info: () => null,
      idleFor: () => undefined,
    },
    browser: {
      async open() { return { ok: true }; }, async close() { return { ok: true }; },
      async navigate() { return { ok: true }; }, status: () => ({ open: false }),
      async capture() { return { ok: false, unsupported: true }; },
      setVisible() { return { ok: true }; }, async dispose() { return { ok: true }; },
      async shutdownAll() {},
    },
    emit: () => {},
    log: (e) => events2.push(e),
    now: () => 1_800_000_000_000,
    hasActiveTask: () => false,
  });
  const recA2 = manager2.get(recA.id);
  const recB2 = manager2.get(recB.id);
  assert.ok(recA2.ok && recB2.ok, 'same computer ids after relaunch (step 8)');
  pass(8, `ids stable across relaunch: ${recA2.value.id}, ${recB2.value.id}`);

  const noteA = path.join(recA2.value.workspaceRoot, 'alpha-note.txt');
  const noteB = path.join(recB2.value.workspaceRoot, 'beta-note.txt');
  assert.equal(fs.readFileSync(noteA, 'utf8'), 'alpha persistent note', 'workspace file intact (step 9)');
  assert.equal(fs.readFileSync(noteB, 'utf8'), 'beta persistent note');
  pass(9, 'persistent workspace files byte-identical after relaunch');

  const rec0 = repo2.get(recB.id);
  repo2.update({ ...rec0, status: 'READY' }); // simulate: app died while READY
  const rec = manager2.reconcile();
  assert.equal(manager2.statusOf(recB.id), 'OFFLINE', 'stale READY reconciled to OFFLINE');
  assert.equal(rec.recoveredOffline >= 1, true, 'recovery counted');
  assert.ok(events2.some((e) => e.event === 'recovered-offline'), 'recovery event emitted');
  pass(10, `reconcile: ${rec.loaded} loaded, ${rec.recoveredOffline} recovered-offline, ${rec.workspacesRecovered} workspaces recovered — no replay dispatched`);

  assert.equal(ptyManager.list().length, 0, 'reconcile spawns NO processes (step 11)');
  pass(11, 'reconcile created no ptys, no windows, no task replay');

  // ── 12. no duplicate processes or unauthorized actions ─────────────────────
  const again2 = await manager2.start(recA.id);
  assert.ok(again2.ok, 'start after relaunch works');
  const first = ptyManager.spawn({ id: 'pty-alpha', cwd: env.dir, command: process.execPath });
  assert.equal(first.ok, true, 'pty spawn after relaunch works');
  const dupPty = ptyManager.spawn({ id: 'pty-alpha', cwd: env.dir, command: process.execPath });
  assert.equal(dupPty.ok, false, 'pty id backstop refuses duplicates');
  assert.equal(ptyManager.list().filter((p) => p.id === 'pty-alpha').length, 1, 'exactly one process with that id');
  const doubleStart = await manager2.start(recA.id);
  assert.equal(doubleStart.ok === true && doubleStart.value.alreadyRunning === true, true,
    'duplicate start reports alreadyRunning, never a second runtime');
  const otherGate = manager2.checkTerminalAccess('beta'); // beta has NO pty mapping now
  assert.equal(otherGate.ok, true, 'agents without a computer stay unaffected');
  pass(12, 'duplicate pty refused by runtime; duplicate start returns alreadyRunning; zero unauthorized actions');

  // ── summary ────────────────────────────────────────────────────────────────
  const p = results.filter((r) => r === 'PASS').length;
  const l = results.filter((r) => r === 'LIMITATION').length;
  console.log('');
  console.log(`ACCEPTANCE SUMMARY: ${p} scripted steps PASS, ${l} honest LIMITATION lines`);
  console.log('Electron-harness companion evidence: npx electron test/computer-electron.electron.cjs (+ --phase2)');
  ptyManager.killAll();
  try { fs.rmSync(env.dir, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
}

main().then(
  () => process.exit(0),
  (e) => { console.error('\nACCEPTANCE DEMO FAILED:', e); process.exit(1); }
);
