'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');

/**
 * Restart persistence + recovery. Storage is the MemoryComputerRepo
 * serialized to a JSON string and reloaded into a FRESH manager — modeling an
 * app restart over persistent storage (real SQLite coverage lives in the
 * labeled `npx electron` OS test; better-sqlite3 cannot load under plain node
 * because upstream builds it for the Electron ABI).
 */
function makeDeps(repo, dir, capture) {
  let tick = 1_700_000_000_000;
  let mintN = 0;
  const browserState = new Map();
  const browser = {
    async open(rec, url) { browserState.set(rec.id, { open: true, url }); return { ok: true }; },
    async close(id) { const s = browserState.get(id); if (s) s.open = false; return { ok: true }; },
    async navigate() { return { ok: true }; },
    status(id) { const s = browserState.get(id); return s && s.open ? { open: true, url: s.url } : { open: false }; },
    async capture() { return { ok: false, error: 'unused' }; },
    setVisible() { return { ok: true }; },
    dispose() { browserState.delete(id => id); return { ok: true }; },
    async shutdownAll() {},
  };
  const deps = {
    repo,
    computersRoot: path.join(dir, 'computers'),
    pty: { ptyForAgent: () => null, info: () => null, idleFor: () => undefined },
    browser,
    emit: (channel, payload) => capture.updates.push({ channel, payload }),
    log: (e) => capture.events.push(e),
    now: () => ++tick,
    mint: (prefix) => `${prefix}-${++mintN}`,
    hasActiveTask: () => false,
  };
  return { deps, browserState };
}

test('identities, statuses and workspace files survive a restart; stale runtime marked OFFLINE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-persist-'));
  const cap1 = { events: [], updates: [] };
  const repo1 = new MemoryComputerRepo();
  const m1 = new ComputerManager(makeDeps(repo1, dir, cap1).deps);

  const a = (await m1.create({ agentId: 'alpha' })).value.record;
  const b = (await m1.create({ agentId: 'beta' })).value.record;
  await m1.start(a.id);
  await m1.start(b.id);
  // Persist a runtime artifact in the workspace.
  fs.writeFileSync(path.join(a.workspaceRoot, 'notes.md'), '# durable');

  // ── restart ──
  const snapshot = repo1.serialize();
  const repo2 = MemoryComputerRepo.from(snapshot);
  const cap2 = { events: [], updates: [] };
  const m2 = new ComputerManager(makeDeps(repo2, dir, cap2).deps);
  const summary = m2.reconcile();

  assert.equal(summary.loaded, 2);
  assert.equal(summary.recoveredOffline, 2, 'both previously-running computers marked stale');

  const a2 = m2.get(a.id);
  assert.equal(a2.ok, true, 'same stable id after restart');
  assert.equal(a2.value.id, a.id);
  assert.equal(a2.value.agentId, 'alpha');
  assert.equal(a2.value.browserProfileId, `persist:computer-${a.id}`);
  assert.equal(a2.value.status, 'OFFLINE', 'stale READY reconciled to OFFLINE');
  assert.ok(fs.existsSync(path.join(a.workspaceRoot, 'notes.md')), 'workspace files intact');

  const recovered = cap2.events.filter((e) => e.event === 'recovered-offline');
  assert.equal(recovered.length, 2);
  assert.deepEqual(
    recovered.map((e) => e.previousStatus).sort(),
    ['READY', 'READY'],
    'records exactly what the stale status was'
  );
  assert.equal(cap2.events.filter((e) => e.event === 'reconciled').length, 1);
});

test('reconcile recreates a missing workspace and reports it (mkdir only, no deletes)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-persist-'));
  const cap1 = { events: [], updates: [] };
  const repo1 = new MemoryComputerRepo();
  const m1 = new ComputerManager(makeDeps(repo1, dir, cap1).deps);
  const a = (await m1.create({ agentId: 'alpha' })).value.record;
  fs.writeFileSync(path.join(a.workspaceRoot, 'keep.txt'), 'data');
  fs.rmSync(a.workspaceRoot, { recursive: true, force: true });

  const cap2 = { events: [], updates: [] };
  const m2 = new ComputerManager(makeDeps(MemoryComputerRepo.from(repo1.serialize()), dir, cap2).deps);
  const summary = m2.reconcile();

  assert.equal(summary.workspacesRecovered, 1);
  assert.ok(fs.existsSync(a.workspaceRoot), 'workspace re-created');
  assert.equal(cap2.events.filter((e) => e.event === 'workspace-recovered').length, 1);
});

test('reconcile never spawns, opens or replays anything (no blind replay)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-persist-'));
  const cap1 = { events: [], updates: [] };
  const repo1 = new MemoryComputerRepo();
  const first = makeDeps(repo1, dir, cap1);
  const m1 = new ComputerManager(first.deps);
  const a = (await m1.create({ agentId: 'alpha' })).value.record;
  await m1.start(a.id);
  await m1.openBrowser(a.id, 'https://example.com').catch(() => {});
  // browserNav is default-deny, so openBrowser fails — close it via stop anyway.
  await m1.stop(a.id);

  const cap2 = { events: [], updates: [] };
  const second = makeDeps(MemoryComputerRepo.from(repo1.serialize()), dir, cap2);
  const m2 = new ComputerManager(second.deps);
  m2.reconcile();

  assert.equal(second.browserState.size, 0, 'no browser re-opened');
  assert.equal(cap2.updates.filter((u) => u.payload.status === 'READY').length, 0, 'no silent start');
  // Only reconcile/recovery events — no created/starting/ready replays.
  const kinds = new Set(cap2.events.map((e) => e.event));
  for (const k of kinds) {
    assert.ok(['reconciled', 'recovered-offline', 'workspace-recovered'].includes(k), `unexpected replayed event: ${k}`);
  }
});

test('PAUSED persists across restart; reconcile is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-persist-'));
  const cap1 = { events: [], updates: [] };
  const repo1 = new MemoryComputerRepo();
  const m1 = new ComputerManager(makeDeps(repo1, dir, cap1).deps);
  const a = (await m1.create({ agentId: 'alpha' })).value.record;
  await m1.start(a.id);
  await m1.pause(a.id);

  const cap2 = { events: [], updates: [] };
  const m2 = new ComputerManager(makeDeps(MemoryComputerRepo.from(repo1.serialize()), dir, cap2).deps);
  const s1 = m2.reconcile();
  assert.equal(s1.recoveredOffline, 0, 'PAUSED is a persisted intent, not stale runtime');
  assert.equal(m2.statusOf(a.id), 'PAUSED');

  const s2 = m2.reconcile();
  assert.deepEqual(s2, { loaded: 1, recoveredOffline: 0, workspacesRecovered: 0 }, 'second reconcile is a no-op');
});

test('corrupt storage data never crashes the manager (unknown status falls back)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-persist-'));
  const repo = new MemoryComputerRepo([{
    id: 'cmp-bad', agentId: 'ghost', projectId: null,
    status: 'TEAPOT', runtimeType: 'local', workspaceId: 'ws-bad',
    workspaceRoot: path.join(dir, 'computers', 'cmp-bad', 'workspace'),
    browserProfileId: 'persist:computer-cmp-bad',
    createdAt: 1, updatedAt: 1, lastStartedAt: null,
    persistencePolicy: 'retain',
    resourceLimits: { startTimeoutMs: 1, screenshotMaxBytes: 1, maxBrowserWindows: 1, sleepAfterIdleMs: 0, maxStartAttempts: 1 },
    permissions: { agent: {}, user: {} },
    config: {},
  }]);
  const cap = { events: [], updates: [] };
  const m = new ComputerManager(makeDeps(repo, dir, cap).deps);
  // No throw: reconcile treats an unknown status as non-runtime (not in the
  // stale list) and the record is simply loadable.
  const summary = m.reconcile();
  assert.equal(summary.loaded, 1);
  assert.equal(m.get('cmp-bad').ok, true);
});
