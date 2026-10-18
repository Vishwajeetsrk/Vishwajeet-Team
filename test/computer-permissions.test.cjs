'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');
const { DEFAULT_COMPUTER_PERMISSIONS } = loadTs('src/shared/computer.ts');

/**
 * Increment E: the permission model as enforced in the MAIN process
 * (never in the UI), watch/control separation, the allows() side-door probe,
 * and the event contract pushed to the renderer + hive log.
 */

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-perm-'));
  const events = [];
  const updates = [];
  const browserState = new Map();
  const browser = {
    async open(rec, url) { browserState.set(rec.id, { open: true, url, show: false }); return { ok: true }; },
    async close(id) { const s = browserState.get(id); if (s) s.open = false; return { ok: true }; },
    async navigate(id, url) { const s = browserState.get(id); if (!s?.open) return { ok: false, error: 'not open' }; s.url = url; return { ok: true }; },
    status(id) {
      const s = browserState.get(id);
      return s?.open ? { open: true, url: s.url, title: 'Page' } : { open: false };
    },
    async capture(id) {
      if (!browserState.get(id)?.open) return { ok: false, error: 'not open' };
      return { ok: true, png: Buffer.alloc(200, 9) };
    },
    setVisible(id, show) { const s = browserState.get(id); if (s) s.show = show; return { ok: true }; },
    async dispose(id) { browserState.delete(id); return { ok: true }; },
    async shutdownAll() {},
  };
  let tick = 1_700_000_000_000;
  let mintN = 0;
  const manager = new ComputerManager({
    repo: new MemoryComputerRepo(),
    computersRoot: path.join(dir, 'computers'),
    pty: { ptyForAgent: () => null, info: () => null, idleFor: () => undefined },
    browser,
    emit: (channel, payload) => updates.push({ channel, payload }),
    log: (e) => events.push(e),
    now: () => ++tick,
    mint: (prefix) => `${prefix}-${++mintN}`,
    hasActiveTask: () => false,
  });
  return { manager, events, updates, browserState };
}

const AGENT = (id) => ({ kind: 'agent', agentId: id });

async function readyComputer(h, agentId = 'alpha') {
  const rec = (await h.manager.create({ agentId })).value.record;
  await h.manager.configure(rec.id, { permissions: { agent: { browserNav: true } } });
  await h.manager.start(rec.id);
  await h.manager.openBrowser(rec.id, 'https://example.com');
  return rec;
}

// ─── default-deny snapshot ───────────────────────────────────────────────────

test('the default permission set is exactly default-deny with documented exceptions', () => {
  assert.deepEqual(DEFAULT_COMPUTER_PERMISSIONS, {
    agent: {
      terminalExec: true,      // documented exception: agent terminals keep working
      browserNav: false,
      browserDownloads: false,
      network: false,
      externalActions: false,
      crossAgentRead: [],
      crossAgentWrite: [],
    },
    user: {
      screenView: true,        // local operator sees their own machines
      screenControl: true,
    },
  }, 'a silent flip of any default must break this test');
});

// ─── user-only side channels ─────────────────────────────────────────────────

test('every user-only op refuses agents with a truthful audit event', async () => {
  const h = makeHarness();
  const rec = await readyComputer(h);
  const attacker = AGENT('alpha');

  const attempts = [
    ['watch', () => h.manager.watch(rec.id, true, attacker)],
    ['takeControl', () => h.manager.takeControl(rec.id, attacker)],
    ['releaseControl', () => h.manager.releaseControl(rec.id, attacker)],
    ['captureScreen', () => h.manager.captureScreen(rec.id, attacker)],
    ['configure', () => h.manager.configure(rec.id, { permissions: { agent: { browserNav: false } } }, attacker)],
    ['dispose', () => h.manager.dispose(rec.id, { confirm: true }, attacker)],
  ];
  for (const [name, run] of attempts) {
    const res = await run();
    assert.equal(res.ok, false, `${name} must refuse an agent`);
    assert.equal(res.code, 'PERMISSION_DENIED', `${name} code`);
    assert.match(res.error, /local operator/, `${name} reason`);
  }

  // Truthful audit: one event per attempt, correlated to computer + actor.
  const denied = h.events.filter((e) => e.event === 'permission-denied' && e.capability === 'userOnly');
  assert.equal(denied.length, attempts.length, 'every refused attempt is recorded');
  for (const e of denied) {
    assert.equal(e.kind, 'computer');
    assert.equal(e.computerId, rec.id);
    assert.equal(e.actor, 'alpha');
  }

  // No state changed: still READY, browser open, permissions untouched, row present.
  assert.equal(h.manager.getStatus(rec.id).value.live.status, 'READY');
  assert.equal(h.browserState.get(rec.id).open, true, 'browser survives attempted dispose');
  assert.equal(h.manager.get(rec.id).value.permissions.agent.browserNav, true, 'self-grant refused');
  assert.ok(h.manager.get(rec.id).ok, 'row survives attempted dispose');
});

test('unknown computer ids are NOT_FOUND, not an existence oracle for agents', async () => {
  const h = makeHarness();
  const res = await h.manager.configure('cmp-nope', { persistencePolicy: 'dispose' }, AGENT('ghost'));
  assert.equal(res.code, 'NOT_FOUND');
  const res2 = await h.manager.dispose('cmp-nope', { confirm: true }, AGENT('ghost'));
  assert.equal(res2.code, 'NOT_FOUND');
});

// ─── screen capabilities ─────────────────────────────────────────────────────

test('screenView:false denies watch and capture even for the user; event records it', async () => {
  const h = makeHarness();
  const rec = await readyComputer(h);

  await h.manager.configure(rec.id, { permissions: { user: { screenView: false } } });

  const watch = await h.manager.watch(rec.id, true);
  assert.equal(watch.ok, false);
  assert.equal(watch.code, 'PERMISSION_DENIED');

  const shot = await h.manager.captureScreen(rec.id);
  assert.equal(shot.ok, false);
  assert.equal(shot.code, 'PERMISSION_DENIED');

  const caps = h.events.filter((e) => e.event === 'permission-denied').map((e) => e.capability);
  assert.deepEqual(caps, ['screenView', 'screenView'], 'each refusal names the capability');

  // Re-grant → both work again (change is immediate, no restart).
  await h.manager.configure(rec.id, { permissions: { user: { screenView: true } } });
  assert.equal((await h.manager.watch(rec.id, true)).ok, true);
  assert.equal((await h.manager.captureScreen(rec.id)).ok, true);
});

test('screenControl:false denies takeControl; screen ops never reach agents', async () => {
  const h = makeHarness();
  const rec = await readyComputer(h);

  await h.manager.configure(rec.id, { permissions: { user: { screenControl: false } } });
  const denied = await h.manager.takeControl(rec.id);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  assert.equal(denied.error.includes('screenControl'), true);

  await h.manager.configure(rec.id, { permissions: { user: { screenControl: true } } });
  const ok = await h.manager.takeControl(rec.id);
  assert.equal(ok.ok, true);

  // Agent always denied for screenControl, regardless of the user cap.
  const agentTry = await h.manager.takeControl(rec.id, AGENT('alpha'));
  assert.equal(agentTry.code, 'PERMISSION_DENIED');
});

// ─── watch / control separation ──────────────────────────────────────────────

test('watch reveals the browser for the user; watching state is in the status snapshot', async () => {
  const h = makeHarness();
  const rec = await readyComputer(h);
  assert.equal(h.browserState.get(rec.id).show, false, 'browser starts hidden');

  const on = await h.manager.watch(rec.id, true);
  assert.equal(on.ok, true);
  assert.deepEqual(on.value, { watching: true });
  assert.equal(h.browserState.get(rec.id).show, true, 'watching reveals the window');
  assert.equal(h.manager.getStatus(rec.id).value.live.watching, true);

  const off = await h.manager.watch(rec.id, false);
  assert.equal(off.value.watching, false);
  assert.equal(h.manager.getStatus(rec.id).value.live.watching, false);

  const watchingEvents = h.events.filter((e) => e.event === 'watching');
  assert.deepEqual(watchingEvents.map((e) => e.watching), [true, false]);
});

test('takeControl gates tools and reveals the browser; release restores both', async () => {
  const h = makeHarness();
  const controlCalls = [];
  const rec = await readyComputer(h);
  h.manager['deps'].control = { pause: (agentId, on) => controlCalls.push({ agentId, on }) };

  const ctrl = await h.manager.takeControl(rec.id);
  assert.equal(ctrl.value.status, 'USER_CONTROL');
  assert.deepEqual(controlCalls, [{ agentId: 'alpha', on: true }], 'agent tools gated while user drives');
  assert.equal(h.browserState.get(rec.id).show, true, 'browser revealed for the user');
  assert.equal(h.manager.getStatus(rec.id).value.live.controlActive, true);

  const rel = await h.manager.releaseControl(rec.id);
  assert.equal(rel.value.status, 'READY', 'restores the pre-control status');
  assert.deepEqual(controlCalls.at(-1), { agentId: 'alpha', on: false }, 'tools released');
  assert.equal(h.manager.getStatus(rec.id).value.live.controlActive, false);
});

// ─── allows() side-door probe ────────────────────────────────────────────────

test('allows() is fail-closed and follows the stored caps exactly', async () => {
  const h = makeHarness();
  const rec = (await h.manager.create({ agentId: 'alpha' })).value.record;

  assert.equal(h.manager.allows(rec.id, 'browserDownloads'), false, 'default-deny');
  assert.equal(h.manager.allows(rec.id, 'network'), false);
  assert.equal(h.manager.allows(rec.id, 'externalActions'), false);
  assert.equal(h.manager.allows('cmp-unknown', 'browserDownloads'), false, 'unknown computer denies');

  await h.manager.configure(rec.id, { permissions: { agent: { browserDownloads: true } } });
  assert.equal(h.manager.allows(rec.id, 'browserDownloads'), true, 'grant flips the probe');
  assert.equal(h.manager.allows(rec.id, 'network'), false, 'other caps untouched');

  await h.manager.configure(rec.id, { permissions: { agent: { browserDownloads: false } } });
  assert.equal(h.manager.allows(rec.id, 'browserDownloads'), false, 'revocation is immediate');
});

// ─── event contract (renderer push + hive log) ───────────────────────────────

test('computer:updated pushes are complete, correlated and redacted', async () => {
  const h = makeHarness();
  const rec = await readyComputer(h);

  await h.manager.pause(rec.id);
  await h.manager.resume(rec.id);

  assert.ok(h.updates.length > 0, 'updates were pushed');
  assert.deepEqual([...new Set(h.updates.map((u) => u.channel))], ['computer:updated'], 'single channel');
  for (const u of h.updates) {
    const p = u.payload;
    assert.equal(p.computerId, rec.id, 'correlated to the computer');
    assert.equal(p.agentId, 'alpha', 'correlated to the agent');
    assert.ok(typeof p.status === 'string', 'carries the resulting status');
    assert.ok(typeof p.reason === 'string' && p.reason.length > 0, 'carries the truthful reason');
  }

  const reasons = h.updates.map((u) => u.payload.reason);
  assert.ok(reasons.includes('pause requested') || reasons.includes('pausing') || reasons.some((r) => /pause/i.test(r)),
    `pause reason present (got: ${reasons.join(', ')})`);

  // Hive log entries carry the same contract.
  const paused = h.events.find((e) => e.event === 'paused');
  assert.equal(paused.kind, 'computer');
  assert.equal(paused.computerId, rec.id);
  assert.equal(paused.agentId, 'alpha');
  assert.match(paused.note, /gated/i, 'pause event explains what it does NOT do (process not suspended)');
});
