'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');
const { canTransition, COMPUTER_STATUSES, COMPUTER_TRANSITIONS, DEFAULT_COMPUTER_PERMISSIONS } = loadTs('src/shared/computer.ts');

/**
 * Test harness: real ComputerManager + MemoryComputerRepo + FAKE adapters
 * (pty/browser/control are fakes — clearly a mocked-runtime test; real pty
 * and Electron browser coverage lives in the integration batches).
 */
function makeHarness(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-mgr-'));
  const events = [];
  const updates = [];
  const controlCalls = [];
  const browserDisposed = [];
  const browserState = new Map(); // computerId -> {open, url, title, show}
  const ptyState = new Map();     // agentId -> {ptyId, idle, pid, cwd, lastOutputAt}
  let tick = 1_700_000_000_000;
  let mintN = 0;

  const browser = {
    async open(rec, url) {
      if (opts.failOpen) return { ok: false, error: 'open failed' };
      browserState.set(rec.id, { open: true, url, title: 'Test Page', show: false });
      return { ok: true };
    },
    async close(id) {
      const s = browserState.get(id);
      if (s) s.open = false;
      return { ok: true };
    },
    async navigate(id, url) {
      const s = browserState.get(id);
      if (!s || !s.open) return { ok: false, error: 'not open' };
      s.url = url;
      return { ok: true };
    },
    status(id) {
      const s = browserState.get(id);
      return s && s.open ? { open: true, url: s.url, title: s.title } : { open: false };
    },
    async capture() { return { ok: true, png: Buffer.from('png-bytes') }; },
    setVisible(id, show) {
      const s = browserState.get(id);
      if (s) s.show = show;
      return { ok: true };
    },
    dispose(id, wipeProfile) {
      browserDisposed.push({ id, wipeProfile });
      browserState.delete(id);
      return { ok: true };
    },
    async shutdownAll() {},
  };

  const pty = {
    ptyForAgent(agentId) { return ptyState.get(agentId)?.ptyId ?? null; },
    info(ptyId) {
      for (const s of ptyState.values()) {
        if (s.ptyId === ptyId) return { running: true, pid: s.pid ?? 4242, cwd: s.cwd ?? 'C:\\x', lastOutputAt: s.lastOutputAt };
      }
      return null;
    },
    idleFor(ptyId) {
      for (const s of ptyState.values()) if (s.ptyId === ptyId) return s.idle;
      return undefined;
    },
  };

  const deps = {
    repo: opts.repo ?? new MemoryComputerRepo(),
    computersRoot: path.join(dir, 'computers'),
    pty,
    browser,
    control: { pause: (id, on) => controlCalls.push({ id, on }) },
    emit: (channel, payload) => updates.push({ channel, payload }),
    log: (e) => events.push(e),
    now: () => ++tick,
    mint: (prefix) => `${prefix}-${String(++mintN).padStart(4, '0')}`,
  };
  if (opts.hasActiveTask) deps.hasActiveTask = opts.hasActiveTask;

  const manager = new ComputerManager(deps);
  return {
    dir, manager, repo: deps.repo, events, updates, controlCalls, browserState, browserDisposed, ptyState,
    computersRoot: deps.computersRoot,
    eventsOf(kind) { return events.filter((e) => e.event === kind); },
  };
}

// ─── identity ────────────────────────────────────────────────────────────────

test('create mints a stable identity, private workspace, and profile id', async () => {
  const h = makeHarness();
  const res = await h.manager.create({ agentId: 'alpha' });
  assert.equal(res.ok, true);
  const rec = res.value.record;
  assert.equal(res.value.created, true);
  assert.match(rec.id, /^cmp-/);
  assert.equal(rec.status, 'OFFLINE');
  assert.equal(rec.runtimeType, 'local');
  assert.equal(rec.browserProfileId, `persist:computer-${rec.id}`);
  assert.ok(rec.workspaceRoot.includes(rec.id), 'workspace is per-computer');
  assert.ok(fs.existsSync(rec.workspaceRoot), 'workspace directory exists on disk');
  assert.equal(h.eventsOf('created').length, 1);
  assert.equal(h.eventsOf('workspace-init').length, 1);
});

test('create is idempotent per agent — stable identity, no duplicates', async () => {
  const h = makeHarness();
  const first = await h.manager.create({ agentId: 'alpha' });
  const second = await h.manager.create({ agentId: 'alpha' });
  assert.equal(second.value.created, false, 'second create reports no new computer');
  assert.equal(second.value.record.id, first.value.record.id, 'same computer id returned');
  assert.equal(h.repo.list().length, 1, 'only one row');

  const ensure = await h.manager.ensureForAgent('alpha');
  assert.equal(ensure.value.record.id, first.value.record.id);
  assert.equal(ensure.value.created, false);
});

test('two agents get distinct computers, workspaces and profiles', async () => {
  const h = makeHarness();
  const a = (await h.manager.create({ agentId: 'alpha' })).value.record;
  const b = (await h.manager.create({ agentId: 'beta' })).value.record;
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.workspaceRoot, b.workspaceRoot);
  assert.notEqual(a.browserProfileId, b.browserProfileId);
  assert.ok(fs.existsSync(a.workspaceRoot) && fs.existsSync(b.workspaceRoot));
  assert.equal(h.repo.list().length, 2);
});

// ─── lifecycle state machine ─────────────────────────────────────────────────

test('start walks OFFLINE → STARTING → READY and persists status', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  const res = await h.manager.start(rec.id);
  assert.deepEqual(res, { ok: true, value: { status: 'READY' } });
  assert.equal(h.repo.get(rec.id).status, 'READY');
  assert.ok(h.repo.get(rec.id).lastStartedAt, 'lastStartedAt recorded');
  const statuses = h.eventsOf('status').map((e) => `${e.from}->${e.to}`);
  assert.deepEqual(statuses, ['OFFLINE->STARTING', 'STARTING->READY']);
  const ready = h.eventsOf('status').at(-1);
  assert.equal(ready.reason, 'runtime ready', 'status event carries the truthful reason');
});

test('duplicate start is idempotent, never a second spawn', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.start(rec.id);
  const again = await h.manager.start(rec.id);
  assert.equal(again.ok, true);
  assert.equal(again.value.alreadyRunning, true);
  assert.equal(again.value.status, 'READY');
});

test('stop reaches OFFLINE and a second stop reports alreadyStopped', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.start(rec.id);
  const stop = await h.manager.stop(rec.id);
  assert.equal(stop.value.status, 'OFFLINE');
  const second = await h.manager.stop(rec.id);
  assert.equal(second.value.alreadyStopped, true);
  assert.equal(h.repo.get(rec.id).status, 'OFFLINE');
});

test('invalid transitions are rejected with INVALID_STATE and the reason', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;

  const pauseOffline = await h.manager.pause(rec.id);
  assert.equal(pauseOffline.ok, false);
  assert.equal(pauseOffline.code, 'INVALID_STATE');

  const resumeOffline = await h.manager.resume(rec.id);
  assert.equal(resumeOffline.ok, false);
  assert.equal(resumeOffline.code, 'INVALID_STATE');

  await h.manager.start(rec.id);
  const resumeReady = await h.manager.resume(rec.id);
  assert.equal(resumeReady.ok, false);
  assert.equal(resumeReady.code, 'INVALID_STATE');

  const releaseNoControl = await h.manager.releaseControl(rec.id);
  assert.equal(releaseNoControl.ok, false);
  assert.equal(releaseNoControl.code, 'INVALID_STATE');
});

test('transition table is closed: only listed edges are ever valid', () => {
  assert.equal(COMPUTER_STATUSES.length, 10);
  for (const from of COMPUTER_STATUSES) {
    assert.ok(Array.isArray(COMPUTER_TRANSITIONS[from]), `${from} has a transition list`);
    for (const to of COMPUTER_TRANSITIONS[from]) {
      assert.ok(COMPUTER_STATUSES.includes(to), `${from}→${to} targets a real status`);
      assert.equal(canTransition(from, to), true, `${from}→${to} allowed`);
    }
  }
  // A few explicit denials (representative sample of illegal edges).
  assert.equal(canTransition('OFFLINE', 'READY'), false, 'must pass through STARTING');
  assert.equal(canTransition('OFFLINE', 'WORKING'), false);
  assert.equal(canTransition('PAUSED', 'WORKING'), false, 'resume first');
  assert.equal(canTransition('ERROR', 'READY'), false, 'ERROR exits only via start/stop');
  assert.equal(canTransition('STOPPING', 'READY'), false);
});

// ─── pause / resume / control ────────────────────────────────────────────────

test('pause gates agent tools and refuses computer ops; resume restores', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.configure(rec.id, { permissions: { agent: { browserNav: true } } });
  await h.manager.start(rec.id);

  const paused = await h.manager.pause(rec.id);
  assert.equal(paused.value.status, 'PAUSED');
  assert.deepEqual(h.controlCalls.at(-1), { id: 'alpha', on: true });

  const browserWhilePaused = await h.manager.openBrowser(rec.id, 'https://example.com');
  assert.equal(browserWhilePaused.ok, false);
  assert.equal(browserWhilePaused.code, 'INVALID_STATE');

  const resumed = await h.manager.resume(rec.id);
  assert.equal(resumed.value.status, 'READY');
  assert.deepEqual(h.controlCalls.at(-1), { id: 'alpha', on: false });
  assert.equal(h.eventsOf('paused').length, 1);
  assert.equal(h.eventsOf('resumed').length, 1);
});

test('takeControl/releaseControl are truthful and restore the prior status', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.start(rec.id);

  const ctrl = await h.manager.takeControl(rec.id);
  assert.equal(ctrl.value.status, 'USER_CONTROL');
  assert.deepEqual(h.controlCalls.at(-1), { id: 'alpha', on: true }, 'agent tools gated while user drives');
  assert.equal(h.eventsOf('control-started').length, 1);

  const snap = h.manager.getStatus(rec.id);
  assert.equal(snap.value.live.controlActive, true);

  const rel = await h.manager.releaseControl(rec.id);
  assert.equal(rel.value.status, 'READY', 'restores the pre-control status');
  assert.deepEqual(h.controlCalls.at(-1), { id: 'alpha', on: false });
  assert.equal(h.eventsOf('control-ended').length, 1);
});

test('takeControl from PAUSED is rejected (release first)', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.start(rec.id);
  await h.manager.pause(rec.id);
  const res = await h.manager.takeControl(rec.id);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_STATE');
});

// ─── terminal association & input gate ───────────────────────────────────────

test('getTerminalInfo reports live truth; computer never spawns a terminal', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;

  const none = h.manager.getTerminalInfo(rec.id);
  assert.deepEqual(none.value, { ptyId: null, running: false });

  h.ptyState.set('alpha', { ptyId: 'pty-alpha', idle: 500, pid: 777, cwd: 'C:\\ws' });
  const live = h.manager.getTerminalInfo(rec.id);
  assert.equal(live.value.running, true);
  assert.equal(live.value.ptyId, 'pty-alpha');
  assert.equal(live.value.pid, 777);
});

test('checkTerminalAccess: no computer passes; PAUSED and terminalExec:false deny', async () => {
  const h = makeHarness();
  // Agent without a computer: backward compatible pass.
  assert.equal(h.manager.checkTerminalAccess('ghost').ok, true);

  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  assert.equal(h.manager.checkTerminalAccess('alpha').ok, true, 'no computer → pass');

  await h.manager.start(rec.id);
  assert.equal(h.manager.checkTerminalAccess('alpha').ok, true, 'started → pass');

  await h.manager.pause(rec.id);
  const paused = h.manager.checkTerminalAccess('alpha');
  assert.equal(paused.ok, false);
  assert.equal(paused.code, 'INVALID_STATE');
  assert.match(paused.error, /paused/i);

  await h.manager.resume(rec.id);
  await h.manager.configure(rec.id, { permissions: { agent: { terminalExec: false } } });
  const denied = h.manager.checkTerminalAccess('alpha');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  assert.equal(h.eventsOf('permission-denied').length, 1);
});

// ─── derived status (real signals only) ──────────────────────────────────────

test('statusTick derives WORKING/WAITING from terminal output and task state', async () => {
  let activeTask = false;
  const h = makeHarness({ hasActiveTask: () => activeTask });
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.start(rec.id);
  assert.equal(h.manager.statusOf(rec.id), 'READY');

  // No pty, no task → stays READY (idle-but-started, no work seen).
  assert.deepEqual(h.manager.statusTick(), []);
  assert.equal(h.manager.statusOf(rec.id), 'READY');

  // Terminal output arrives → WORKING.
  h.ptyState.set('alpha', { ptyId: 'pty-alpha', idle: 100 });
  h.manager.statusTick();
  assert.equal(h.manager.statusOf(rec.id), 'WORKING');

  // Output stops → WAITING.
  h.ptyState.get('alpha').idle = 60_000;
  h.manager.statusTick();
  assert.equal(h.manager.statusOf(rec.id), 'WAITING');

  // Task engine says the agent is working (incl. cancellation propagation:
  // flipping the task off must fall back to WAITING, never linger WORKING).
  activeTask = true;
  h.manager.statusTick();
  assert.equal(h.manager.statusOf(rec.id), 'WORKING');
  activeTask = false;
  h.ptyState.delete('alpha');
  h.manager.statusTick();
  assert.equal(h.manager.statusOf(rec.id), 'WAITING', 'cancelled/finished task falls back');
});

test('idle policy sleeps a running computer (disabled by default)', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  assert.equal(rec.resourceLimits.sleepAfterIdleMs, 0, 'policy off by default');
  await h.manager.start(rec.id);

  // Enable policy with a tiny window, then advance far beyond it.
  const raw = h.repo.get(rec.id);
  raw.resourceLimits.sleepAfterIdleMs = 50;
  h.repo.update(raw);

  // Force an activity baseline then jump ahead via many now() ticks.
  for (let i = 0; i < 100; i++) h.manager.statusTick();
  const status = h.manager.statusOf(rec.id);
  // 100 ticks × 1ms+ now() increments clears the 50ms window.
  assert.ok(['WAITING', 'SLEEPING', 'READY'].includes(status));
  if (status !== 'SLEEPING') {
    h.manager.statusTick();
    h.manager.statusTick();
    h.manager.statusTick();
  }
  assert.equal(h.manager.statusOf(rec.id), 'SLEEPING', 'idle policy reached SLEEPING');
  assert.equal(h.eventsOf('sleeping').length, 1);
  assert.equal(h.browserState.get(rec.id)?.open ?? false, false, 'sleep closes the browser');

  const wake = await h.manager.start(rec.id);
  assert.equal(wake.value.status, 'READY', 'start wakes a sleeping computer');
});

// ─── dispose (destructive, confirmed) ────────────────────────────────────────

test('dispose requires confirmation and retains files unless policy says dispose', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;

  const noConfirm = await h.manager.dispose(rec.id, {});
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.code, 'PERMISSION_DENIED');
  assert.ok(h.repo.get(rec.id), 'row survives a refused dispose');

  const ok = await h.manager.dispose(rec.id, { confirm: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.removedFiles, false, 'retain policy keeps files');
  assert.equal(h.repo.get(rec.id), null);
  assert.ok(fs.existsSync(rec.workspaceRoot), 'workspace files not silently deleted');

  // Explicit destructive policy wipes on dispose.
  const b = (await h.manager.create({ agentId: 'beta' })).value.record;
  await h.manager.configure(b.id, { persistencePolicy: 'dispose' });
  const wiped = await h.manager.dispose(b.id, { confirm: true });
  assert.equal(wiped.value.removedFiles, true);
  assert.equal(fs.existsSync(path.dirname(b.workspaceRoot)), false, 'computer dir removed');
  assert.equal(h.browserDisposed.at(-1)?.wipeProfile, true, 'profile wiped too');
});

test('running computer is stopped before dispose', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.configure(rec.id, { permissions: { agent: { browserNav: true } } });
  await h.manager.start(rec.id);
  await h.manager.openBrowser(rec.id, 'https://example.com');
  assert.equal(h.browserState.get(rec.id).open, true);

  const res = await h.manager.dispose(rec.id, { confirm: true });
  assert.equal(res.ok, true);
  assert.equal(h.browserState.has(rec.id), false, 'browser closed on dispose');
  assert.equal(h.eventsOf('stopped').length, 1);
});

// ─── events ──────────────────────────────────────────────────────────────────

test('events are kind=computer with ids, and free text is redacted', async () => {
  const h = makeHarness({ failOpen: true });
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;
  await h.manager.configure(rec.id, { permissions: { agent: { browserNav: true } } });
  await h.manager.start(rec.id);

  const res = await h.manager.openBrowser(rec.id, 'https://example.com/?token=supersecret123');
  assert.equal(res.ok, false);

  const errEvent = h.eventsOf('browser-error').at(-1);
  assert.equal(errEvent.kind, 'computer');
  assert.equal(errEvent.computerId, rec.id);
  assert.equal(errEvent.agentId, 'alpha');
  assert.ok(!JSON.stringify(errEvent).includes('supersecret123'), 'secret never reaches the event log');
  assert.match(JSON.stringify(errEvent), /redacted/);

  // Every event carries the computer/agent correlation.
  for (const e of h.events.filter((x) => x.kind === 'computer')) {
    assert.ok(e.event, 'has event name');
    if (e.computerId) assert.equal(e.computerId, rec.id);
  }
  // Live push channel fired.
  assert.ok(h.updates.every((u) => u.channel === 'computer:updated'));
  assert.ok(h.updates.length > 0);
});
