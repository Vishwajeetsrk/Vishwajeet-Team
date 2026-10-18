'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');

/**
 * Increment B: workspace identity, path containment (shared `safeResolve`
 * policy — one path-escape rule for the whole app), and cross-agent grants.
 */
function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-ws-'));
  const events = [];
  let tick = 1_700_000_000_000;
  let mintN = 0;
  const deps = {
    repo: new MemoryComputerRepo(),
    computersRoot: path.join(dir, 'computers'),
    pty: { ptyForAgent: () => null, info: () => null, idleFor: () => undefined },
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
  return { dir, manager, events, computersRoot: deps.computersRoot };
}

const OWNER = (agentId) => ({ kind: 'agent', agentId });
const USER = { kind: 'user' };

async function makeComputer(h, agentId = 'alpha') {
  const rec = (await h.manager.create({ agentId })).value.record;
  return rec;
}

// ─── identity ────────────────────────────────────────────────────────────────

test('workspace root is derived from the stable computer id and never shared', async () => {
  const h = makeHarness();
  const a = await makeComputer(h, 'alpha');
  const b = await makeComputer(h, 'beta');
  assert.ok(a.workspaceRoot.startsWith(h.computersRoot), 'all workspaces live under the computers root');
  assert.ok(a.workspaceRoot.includes(a.id));
  assert.ok(b.workspaceRoot.includes(b.id));
  assert.notEqual(a.workspaceRoot, b.workspaceRoot);
  assert.equal(path.basename(path.dirname(a.workspaceRoot)), a.id, 'id segment guards the workspace dir');
});

test('getWorkspaceInfo reports truthful existence and entry counts', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h);
  const info = h.manager.getWorkspaceInfo(rec.id);
  assert.equal(info.ok, true);
  assert.equal(info.value.exists, true);
  assert.equal(info.value.fileCount, 0);

  fs.writeFileSync(path.join(rec.workspaceRoot, 'one.txt'), '1');
  fs.mkdirSync(path.join(rec.workspaceRoot, 'sub'));
  fs.writeFileSync(path.join(rec.workspaceRoot, 'sub', 'two.txt'), '2');
  assert.equal(h.manager.getWorkspaceInfo(rec.id).value.fileCount, 3);

  fs.rmSync(rec.workspaceRoot, { recursive: true, force: true });
  const gone = h.manager.getWorkspaceInfo(rec.id);
  assert.equal(gone.value.exists, false, 'reports the truth after the directory disappears');
  assert.equal(gone.value.fileCount, undefined, 'no count for a missing directory');

  assert.equal(h.manager.getWorkspaceInfo('cmp-nope').code, 'NOT_FOUND');
});

// ─── containment ─────────────────────────────────────────────────────────────

test('owner agent resolves paths inside the workspace, including not-yet-created files', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h);

  const existing = await h.manager.authorizeWorkspacePath(rec.id, 'notes/plan.md', OWNER('alpha'));
  assert.equal(existing.ok, true);
  // Compare against the CANONICAL root via fs/promises.realpath: on Windows the
  // temp dir may be an 8.3 short path (C:\Users\VISWAW~1\...) and promises
  // realpath expands it to the long form — exactly what safeResolve returns.
  // (fs.realpathSync does NOT expand 8.3 — it would keep the short form.)
  const realRoot = await fsp.realpath(rec.workspaceRoot);
  assert.ok(existing.value.abs.startsWith(realRoot), 'canonical path stays under the root');
  assert.ok(existing.value.abs.endsWith(path.join('notes', 'plan.md')));

  const fresh = await h.manager.authorizeWorkspacePath(rec.id, 'brand-new.txt', OWNER('alpha'));
  assert.equal(fresh.ok, true, 'creating a new file inside the workspace is allowed');

  // Round trip: the authorized path really lands in the workspace on disk.
  fs.mkdirSync(path.dirname(existing.value.abs), { recursive: true });
  fs.writeFileSync(existing.value.abs, '# plan');
  assert.ok(fs.existsSync(path.join(rec.workspaceRoot, 'notes', 'plan.md')));
});

test('traversal, absolute and root-escape paths are refused (one policy, fail-closed)', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h);

  const escapes = [
    '../outside.txt',
    '../../etc/passwd',
    'nested/../../outside.txt',
    '..',
    './../',
    path.resolve(rec.workspaceRoot, '..', 'sibling-secret.txt'),
    path.resolve(path.dirname(h.computersRoot), 'escape-abs.txt'),
    'C:\\Windows\\System32\\config\\SAM',
    '/etc/shadow',
  ];
  for (const rel of escapes) {
    const res = await h.manager.authorizeWorkspacePath(rec.id, rel, OWNER('alpha'));
    assert.equal(res.ok, false, `must refuse: ${rel}`);
    assert.equal(res.code, 'PERMISSION_DENIED');
    assert.match(res.error, /escapes the workspace root/);
  }

  const miss = await h.manager.authorizeWorkspacePath('cmp-nope', 'x', OWNER('alpha'));
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'NOT_FOUND');
});

test('a symlink/junction leaving the workspace is refused; an in-workspace link is followed', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h);
  const outside = path.join(h.dir, 'outside-target');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not reach');

  // Directory junction (Windows, no admin needed) / symlink (POSIX).
  const linkName = path.join(rec.workspaceRoot, 'jump');
  try {
    fs.symlinkSync(outside, linkName, 'junction');
  } catch (e) {
    if (['EPERM', 'ENOSYS', 'EACCES', 'ENOENT'].includes(e.code)) {
      t_skip_all(`symlink creation unsupported here: ${e.code}`);
      return;
    }
    throw e;
  }

  const viaLink = await h.manager.authorizeWorkspacePath(rec.id, path.join('jump', 'secret.txt'), OWNER('alpha'));
  assert.equal(viaLink.ok, false, 'link leaving the workspace must never resolve');
  assert.equal(viaLink.code, 'PERMISSION_DENIED');

  // Dangling link: target does not exist yet → still refused (fail closed).
  const dangling = path.join(rec.workspaceRoot, 'dangle');
  try {
    fs.symlinkSync(path.join(outside, 'not-created-yet.txt'), dangling, 'file');
    const d = await h.manager.authorizeWorkspacePath(rec.id, 'dangle', OWNER('alpha'));
    assert.equal(d.ok, false, 'dangling link is refused before it can be created through');
  } catch (e) {
    if (!['EPERM', 'ENOSYS', 'EACCES'].includes(e.code)) throw e;
  }

  // In-workspace link to an existing in-workspace target: deliberate allowance.
  fs.mkdirSync(path.join(rec.workspaceRoot, 'real-dir'), { recursive: true });
  fs.writeFileSync(path.join(rec.workspaceRoot, 'real-dir', 'file.txt'), 'ok');
  try {
    fs.symlinkSync(path.join(rec.workspaceRoot, 'real-dir'), path.join(rec.workspaceRoot, 'alias'), 'junction');
    const ok = await h.manager.authorizeWorkspacePath(rec.id, path.join('alias', 'file.txt'), OWNER('alpha'));
    assert.equal(ok.ok, true, 'internal link to an internal target is allowed');
  } catch (e) {
    if (!['EPERM', 'ENOSYS', 'EACCES'].includes(e.code)) throw e;
  }
});

function t_skip_all(reason) {
  // Node test runner has no per-block skip inside an async test; emulate by
  // logging the environmental skip — the rest of the file still runs.
  console.log(`# SKIP (environmental): ${reason}`);
}

// ─── cross-agent access ──────────────────────────────────────────────────────

test('cross-agent workspace access is default-deny with a truthful event', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h, 'alpha');

  const own = await h.manager.authorizeWorkspacePath(rec.id, 'shared.txt', OWNER('alpha'));
  assert.equal(own.ok, true, 'owner always has access');

  const other = await h.manager.authorizeWorkspacePath(rec.id, 'shared.txt', OWNER('beta'));
  assert.equal(other.ok, false);
  assert.equal(other.code, 'PERMISSION_DENIED');
  assert.match(other.error, /has no access/);

  const denied = h.events.filter((e) => e.event === 'permission-denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].capability, 'crossAgentWorkspace');
  assert.equal(denied[0].actor, 'beta');
  assert.equal(denied[0].kind, 'computer');
});

test('an explicit read/write grant opens access; user authority is separate', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h, 'alpha');

  // User (local operator) is authoritative regardless of agent grants.
  const user = await h.manager.authorizeWorkspacePath(rec.id, 'anything.txt', USER);
  assert.equal(user.ok, true);

  // Grant via configure (user-only op), then re-authorize.
  const cfg = await h.manager.configure(rec.id, { permissions: { agent: { crossAgentRead: ['beta'] } } });
  assert.equal(cfg.ok, true);
  const granted = await h.manager.authorizeWorkspacePath(rec.id, 'shared.txt', OWNER('beta'));
  assert.equal(granted.ok, true, 'granted agent may read the workspace');

  // gamma has no grant → still denied; revoke beta → denied again.
  assert.equal((await h.manager.authorizeWorkspacePath(rec.id, 'x', OWNER('gamma'))).code, 'PERMISSION_DENIED');
  await h.manager.configure(rec.id, { permissions: { agent: { crossAgentRead: [] } } });
  const revoked = await h.manager.authorizeWorkspacePath(rec.id, 'x', OWNER('beta'));
  assert.equal(revoked.ok, false, 'revocation is immediate');
  assert.equal(revoked.code, 'PERMISSION_DENIED');
});

test('crossAgentWrite alone also opens workspace access', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h, 'alpha');
  await h.manager.configure(rec.id, { permissions: { agent: { crossAgentWrite: ['beta'] } } });
  const res = await h.manager.authorizeWorkspacePath(rec.id, 'write-here.txt', OWNER('beta'));
  assert.equal(res.ok, true);
});

// ─── configuration is user-only ──────────────────────────────────────────────

test('agents cannot reconfigure their own permissions (permission change = user-only)', async () => {
  const h = makeHarness();
  const rec = await makeComputer(h, 'alpha');

  const attack = await h.manager.configure(
    rec.id,
    { permissions: { agent: { browserNav: true, crossAgentRead: ['alpha', 'beta'] } } },
    OWNER('alpha')
  );
  assert.equal(attack.ok, false);
  assert.equal(attack.code, 'PERMISSION_DENIED');
  assert.match(attack.error, /local operator/);

  const after = h.manager.get(rec.id);
  assert.equal(after.value.permissions.agent.browserNav, false, 'default-deny untouched');
  assert.deepEqual(after.value.permissions.agent.crossAgentRead, [], 'no self-grant');
});
