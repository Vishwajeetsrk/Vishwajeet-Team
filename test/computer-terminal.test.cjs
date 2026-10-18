'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');
const { PtyManager } = loadTs('src/main/pty.ts'); // REAL PtyManager (node-pty is NAPI — loads under plain node)

/**
 * Increment C: terminal association with the REAL PtyManager.
 * The computer never spawns terminals itself; it ASSOCIATES with ptys the
 * agent flow already spawned (exactly how index.ts wires ptyToAgent) and
 * gates `pty:write` through checkTerminalAccess.
 */

// Own ptyManager per test → killAll in afterEach (no cross-test orphan procs).
let activeManagers = [];
afterEach(() => {
  for (const pm of activeManagers) {
    try { pm.killAll(); } catch { /* already dead */ }
  }
  activeManagers = [];
});

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-term-'));
  const events = [];
  const ptyManager = new PtyManager();
  activeManagers.push(ptyManager);
  // Mirror index.ts: pty id → agentId, populated at spawn, pruned at teardown.
  const ptyToAgent = new Map();

  const ptyAdapter = {
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
  let mintN = 0;
  const deps = {
    repo: new MemoryComputerRepo(),
    computersRoot: path.join(dir, 'computers'),
    pty: ptyAdapter,
    browser: {
      async open() { return { ok: false, error: 'unused' }; },
      async close() { return { ok: true }; },
      async navigate() { return { ok: false, error: 'unused' }; },
      status: () => ({ open: false }),
      async capture() { return { ok: false, error: 'unused' }; },
      setVisible() { return { ok: true }; },
      dispose() { return { ok: true }; },
      async shutdownAll() {},
    },
    emit: () => {},
    log: (e) => events.push(e),
    now: () => ++tick,
    mint: (prefix) => `${prefix}-${++mintN}`,
    hasActiveTask: () => false,
  };
  const manager = new ComputerManager(deps);
  return { dir, manager, events, ptyManager, ptyToAgent };
}

function spawnRealPty(h, id, agentId) {
  const res = h.ptyManager.spawn({
    id,
    cwd: h.dir,
    command: process.execPath, // absolute .exe → no PATH resolution needed
    cols: 80,
    rows: 24,
  });
  assert.equal(res.ok, true, `real pty spawn failed: ${res.error}`);
  h.ptyToAgent.set(id, agentId);
  return id;
}

// ─── association: computer never spawns, only observes ───────────────────────

test('start never spawns a terminal; association reports the real pty truthfully', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;

  await h.manager.start(rec.id);
  assert.equal(h.ptyManager.list().length, 0, 'computer start spawns NO pty');
  assert.deepEqual(h.manager.getTerminalInfo(rec.id).value, { ptyId: null, running: false });

  // The agent flow spawns a pty (as spawnAgentCore does) and the mapping lands.
  spawnRealPty(h, 'pty-alpha', 'alpha');
  assert.equal(h.ptyManager.list().length, 1, 'exactly one pty exists');

  const info = h.manager.getTerminalInfo(rec.id);
  assert.equal(info.value.ptyId, 'pty-alpha');
  assert.equal(info.value.running, true);
  const real = h.ptyManager.list()[0];
  assert.equal(info.value.pid, real.pid, 'pid matches the OS process');
  assert.equal(info.value.cwd, h.dir, 'cwd matches the spawn cwd');
  assert.ok(info.value.pid > 0);

  // Stale mapping after teardown: info reports running:false (truthfully).
  h.ptyManager.killAll();
  h.ptyToAgent.clear();
  assert.equal(h.manager.getTerminalInfo(rec.id).value.running, false);
});

test('PtyManager duplicate backstop: same id twice is refused by the runtime', async () => {
  const h = makeHarness();
  spawnRealPty(h, 'pty-alpha', 'alpha');
  const dup = h.ptyManager.spawn({ id: 'pty-alpha', cwd: h.dir, command: process.execPath });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);
  assert.equal(h.ptyManager.list().length, 1, 'still exactly one process');
});

// ─── pty:write gate against a live pty ───────────────────────────────────────

test('checkTerminalAccess gates a LIVE pty: READY passes, PAUSED/terminalExec deny', async (t) => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;

  // Documented compatibility rule: OFFLINE computer still allows input
  // (restored hive flow sends to a live pty before anyone starts the computer).
  spawnRealPty(h, 'pty-alpha', 'alpha');
  assert.equal(h.manager.checkTerminalAccess('alpha').ok, true, 'OFFLINE allows input');

  await h.manager.start(rec.id);
  const allowed = h.manager.checkTerminalAccess('alpha');
  assert.equal(allowed.ok, true);
  // The gate opens → real input flows to the real process.
  const w = h.ptyManager.write('pty-alpha', '\r');
  assert.equal(w.ok, true, 'write reaches the real pty');

  await h.manager.pause(rec.id);
  const paused = h.manager.checkTerminalAccess('alpha');
  assert.equal(paused.ok, false);
  assert.equal(paused.code, 'INVALID_STATE');
  assert.match(paused.error, /paused/i);

  await h.manager.resume(rec.id);
  assert.equal(h.manager.checkTerminalAccess('alpha').ok, true);

  await h.manager.configure(rec.id, { permissions: { agent: { terminalExec: false } } });
  const denied = h.manager.checkTerminalAccess('alpha');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  assert.equal(h.events.filter((e) => e.event === 'permission-denied').length, 1);

  // Agents without a computer are unaffected (backward compatible).
  assert.equal(h.manager.checkTerminalAccess('never-seen').ok, true);
});

// ─── statusTick with a REAL pty ──────────────────────────────────────────────

test('statusTick reads the real pty idle clock: fresh output ⇒ WORKING', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.start(rec.id);
  assert.equal(h.manager.statusOf(rec.id), 'READY');

  spawnRealPty(h, 'pty-alpha', 'alpha');
  const idle = h.ptyManager.idleFor('pty-alpha');
  assert.ok(typeof idle === 'number' && idle < 10_000, `fresh pty has a live clock (idle=${idle})`);

  h.manager.statusTick();
  assert.equal(h.manager.statusOf(rec.id), 'WORKING', 'real recent output marks the computer WORKING');

  // Kill the pty → association gone → falls back (WAITING: no task, no output).
  h.ptyManager.killAll();
  h.ptyToAgent.clear();
  h.manager.statusTick();
  assert.equal(h.manager.statusOf(rec.id), 'WAITING');
});
