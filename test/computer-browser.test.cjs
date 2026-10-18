'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');
const { ComputerBrowser, createComputerBrowser } = loadTs('src/main/computerBrowser.ts');

/**
 * Increment D: browser profiles. Plain-node coverage of the REAL adapter
 * (ComputerBrowser) against an injected fake BrowserWindow — partition wiring,
 * navigation/status truth, capture fallback, visibility, profile wipe. The
 * real-Electron window is proven separately by test/computer-electron.electron.cjs
 * (run via `npx electron`, not part of the node suite).
 */

const TINY = Buffer.alloc(8, 0);   // <64B → treated as "nothing painted"
const FULL = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 7)]);

class FakeImage {
  constructor(buf) { this.buf = buf; }
  toPNG() { return this.buf; }
  isEmpty() { return this.buf.length < 64; }
}

class FakeBrowserWindow {
  static instances = [];
  static captureSeq = [FULL];
  static failLoad = false;
  static reset() {
    FakeBrowserWindow.instances = [];
    FakeBrowserWindow.captureSeq = [FULL];
    FakeBrowserWindow.failLoad = false;
  }
  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.url = '';
    this.title = 'Fake Page';
    this.visible = !!options.show;
    this.destroyed = false;
    this.menuVisible = undefined;
    this.showHideLog = [];
    const wcListeners = new Map();
    const sessionListeners = new Map();
    this.webContents = {
      capturePage: async () => {
        const next = FakeBrowserWindow.captureSeq.length > 1
          ? FakeBrowserWindow.captureSeq.shift()
          : FakeBrowserWindow.captureSeq[0];
        return new FakeImage(next ?? FULL);
      },
      on: (ev, cb) => { if (!wcListeners.has(ev)) wcListeners.set(ev, []); wcListeners.get(ev).push(cb); },
      session: {
        on: (ev, cb) => { if (!sessionListeners.has(ev)) sessionListeners.set(ev, []); sessionListeners.get(ev).push(cb); },
        removeListener: (ev, cb) => {
          const list = sessionListeners.get(ev) ?? [];
          const i = list.indexOf(cb);
          if (i >= 0) list.splice(i, 1);
        },
      },
      emitSession: (ev, ...args) => {
        for (const cb of [...(sessionListeners.get(ev) ?? [])]) cb(...args);
        return (sessionListeners.get(ev) ?? []).length;
      },
      sessionListenerCount: (ev) => (sessionListeners.get(ev) ?? []).length,
    };
    this._wcEmit = (ev, ...args) => { for (const cb of wcListeners.get(ev) ?? []) cb(...args); };
    FakeBrowserWindow.instances.push(this);
  }
  async loadURL(url) {
    if (FakeBrowserWindow.failLoad) throw new Error('boom: load failed');
    this.url = url;
    this._wcEmit('did-navigate', null, url);
  }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  show() { this.visible = true; this.showHideLog.push('show'); }
  hide() { this.visible = false; this.showHideLog.push('hide'); }
  isVisible() { return this.visible; }
  close() { if (!this.destroyed) { this.destroyed = true; this._emit('closed'); } }
  isDestroyed() { return this.destroyed; }
  setMenuBarVisibility(v) { this.menuVisible = v; }
  on(ev, cb) { if (!this.listeners.has(ev)) this.listeners.set(ev, []); this.listeners.get(ev).push(cb); }
  _emit(ev, ...args) { for (const cb of this.listeners.get(ev) ?? []) cb(...args); }
}

function makeAdapter(overrides = {}) {
  const wipes = [];
  const adapter = new ComputerBrowser({
    BrowserWindow: FakeBrowserWindow,
    profileDirFor: (partition) => path.join(overrides.profileRoot ?? path.join(os.tmpdir(), 'cmp-profiles'), partition.replace(/^persist:/, '')),
    remover: (dir) => { wipes.push(dir); fs.rmSync(dir, { recursive: true, force: true }); },
    ...overrides,
  });
  return { adapter, wipes };
}

const RECORD = (id = 'cmp-0001') => ({
  id,
  agentId: 'alpha',
  projectId: null,
  status: 'READY',
  runtimeType: 'local',
  workspaceId: 'ws-0001',
  workspaceRoot: path.join(os.tmpdir(), 'cmp-ws', id, 'workspace'),
  browserProfileId: `persist:computer-${id}`,
  createdAt: 1,
  updatedAt: 1,
  lastStartedAt: 1,
  persistencePolicy: 'retain',
  resourceLimits: { startTimeoutMs: 1000, screenshotMaxBytes: 10_000_000, maxBrowserWindows: 1, sleepAfterIdleMs: 0, maxStartAttempts: 1 },
  permissions: { agent: {}, user: {} },
  config: {},
});

// ─── adapter behavior ────────────────────────────────────────────────────────

test('open creates a hidden isolated window on the computer own partition', async () => {
  FakeBrowserWindow.reset();
  const { adapter } = makeAdapter();
  const rec = RECORD();

  const res = await adapter.open(rec, 'https://example.com');
  assert.equal(res.ok, true);
  assert.equal(FakeBrowserWindow.instances.length, 1);
  const opts = FakeBrowserWindow.instances[0].options;
  assert.equal(opts.show, false, 'agent browser starts hidden');
  assert.equal(opts.webPreferences.partition, 'persist:computer-cmp-0001');
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.nodeIntegration, false);
  assert.equal(opts.webPreferences.sandbox, true);
  assert.equal(FakeBrowserWindow.instances[0].menuVisible, false);

  const st = adapter.status(rec.id);
  assert.equal(st.open, true);
  assert.equal(st.url, 'https://example.com');
  assert.equal(st.title, 'Fake Page');
  await adapter.shutdownAll();
});

test('a failed load leaves no zombie window and no open status', async () => {
  FakeBrowserWindow.reset();
  FakeBrowserWindow.failLoad = true;
  const { adapter } = makeAdapter();
  const res = await adapter.open(RECORD(), 'https://example.com');
  assert.equal(res.ok, false);
  assert.match(res.error, /navigation failed/);
  assert.equal(adapter.status('cmp-0001').open, false, 'failed open is not reported as open');
  assert.equal(FakeBrowserWindow.instances[0].isDestroyed(), true, 'window cleaned up');
  FakeBrowserWindow.reset();
});

test('navigate updates the status URL and closed windows refuse', async () => {
  FakeBrowserWindow.reset();
  const { adapter } = makeAdapter();
  const rec = RECORD();
  await adapter.open(rec, 'https://example.com');

  const nav = await adapter.navigate(rec.id, 'https://example.org/page');
  assert.equal(nav.ok, true);
  assert.equal(adapter.status(rec.id).url, 'https://example.org/page');

  await adapter.close(rec.id);
  assert.equal(adapter.status(rec.id).open, false);
  const afterClose = await adapter.navigate(rec.id, 'https://example.net');
  assert.equal(afterClose.ok, false);
  assert.match(afterClose.error, /not open/);
});

test('capture: hidden unpainted window shows briefly, retries, and returns to hidden', async () => {
  FakeBrowserWindow.reset();
  FakeBrowserWindow.captureSeq = [TINY, FULL]; // first capture empty, after show → real
  const { adapter } = makeAdapter();
  const rec = RECORD();
  await adapter.open(rec, 'https://example.com');
  const win = FakeBrowserWindow.instances[0];
  assert.equal(win.visible, false, 'starts hidden');

  const cap = await adapter.capture(rec.id);
  assert.equal(cap.ok, true);
  assert.deepEqual(cap.png, FULL, 'retry produced the painted frame');
  assert.deepEqual(win.showHideLog, ['show', 'hide'], 'showed only for the retry, then restored');
  assert.equal(win.visible, false, 'returned to hidden');
});

test('capture of an already-visible window does not flip visibility', async () => {
  FakeBrowserWindow.reset();
  FakeBrowserWindow.captureSeq = [TINY, FULL];
  const { adapter } = makeAdapter();
  const rec = RECORD();
  await adapter.open(rec, 'https://example.com');
  const win = FakeBrowserWindow.instances[0];
  adapter.setVisible(rec.id, true);
  win.showHideLog.length = 0; // ignore the explicit setVisible we just made

  const cap = await adapter.capture(rec.id);
  assert.equal(cap.ok, true);
  assert.deepEqual(cap.png, TINY, 'visible window: whatever painted is the truth');
  assert.deepEqual(win.showHideLog, [], 'no visibility churn during capture');
  await adapter.shutdownAll();
});

test('setVisible flips the real window and refuses when closed', async () => {
  FakeBrowserWindow.reset();
  const { adapter } = makeAdapter();
  const rec = RECORD();
  assert.equal(adapter.setVisible(rec.id, true).ok, false, 'nothing open yet');
  await adapter.open(rec, 'https://example.com');
  assert.equal(adapter.setVisible(rec.id, true).ok, true);
  assert.equal(FakeBrowserWindow.instances[0].visible, true);
  assert.equal(adapter.setVisible(rec.id, false).ok, true);
  assert.equal(FakeBrowserWindow.instances[0].visible, false);
  await adapter.shutdownAll();
});

test('dispose wipes the profile only under the destructive policy', async () => {
  FakeBrowserWindow.reset();
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-prof-'));
  const { adapter, wipes } = makeAdapter({ profileRoot });
  const rec = RECORD();
  await adapter.open(rec, 'https://example.com');

  const retain = await adapter.dispose(rec.id, false);
  assert.equal(retain.ok, true);
  assert.equal(wipes.length, 0, 'retain policy never touches the profile');
  assert.equal(FakeBrowserWindow.instances[0].isDestroyed(), true, 'window closed on dispose');
  assert.equal(adapter.status(rec.id).open, false);

  // Recreate + wipe path: partition dir on disk must disappear.
  await adapter.open(rec, 'https://example.com');
  const partitionDir = path.join(profileRoot, 'computer-cmp-0001');
  fs.mkdirSync(partitionDir, { recursive: true });
  fs.writeFileSync(path.join(partitionDir, 'Cookies'), 'x');
  const wipe = await adapter.dispose(rec.id, true);
  assert.equal(wipe.ok, true);
  assert.equal(wipes.length, 1);
  assert.equal(fs.existsSync(partitionDir), false, 'profile dir removed');
  await adapter.shutdownAll();
});

test('shutdownAll closes every open computer window', async () => {
  FakeBrowserWindow.reset();
  const { adapter } = makeAdapter();
  await adapter.open(RECORD('cmp-a'), 'https://a.example');
  await adapter.open(RECORD('cmp-b'), 'https://b.example');
  assert.equal(adapter.status('cmp-a').open, true);
  assert.equal(adapter.status('cmp-b').open, true);
  await adapter.shutdownAll();
  assert.equal(adapter.status('cmp-a').open, false);
  assert.equal(adapter.status('cmp-b').open, false);
  assert.ok(FakeBrowserWindow.instances.every((w) => w.isDestroyed()));
});

test('createComputerBrowser honestly reports no runtime under plain node', () => {
  assert.equal(createComputerBrowser(), null, 'electron is absent here — no fake adapter is substituted');
});

// ─── browserDownloads gate (session will-download) ───────────────────────────

function makeDownloadEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

test('downloads are default-deny: only a truthfully granted gate lets them through', async () => {
  FakeBrowserWindow.reset();
  let allowed = false;
  const adapter = new ComputerBrowser({
    BrowserWindow: FakeBrowserWindow,
    profileDirFor: (p) => path.join(os.tmpdir(), 'cmp-dl', p.replace(/^persist:/, '')),
    downloadGate: (computerId) => {
      assert.equal(computerId, 'cmp-0001', 'gate receives the computer id');
      return allowed;
    },
  });
  const rec = RECORD();
  await adapter.open(rec, 'https://example.com');
  const win = FakeBrowserWindow.instances[0];
  const fire = () => {
    const ev = makeDownloadEvent();
    win.webContents.emitSession('will-download', ev, {}, win.webContents);
    return ev.prevented;
  };

  assert.equal(fire(), true, 'denied while the cap is false');
  allowed = true;
  assert.equal(fire(), false, 'granted cap passes the download');
  assert.equal(win.webContents.sessionListenerCount('will-download'), 1, 'exactly one handler');

  await adapter.close(rec.id);
  assert.equal(win.webContents.sessionListenerCount('will-download'), 0, 'handler removed with the window');
  const ev2 = makeDownloadEvent();
  win.webContents.emitSession('will-download', ev2, {}, win.webContents);
  assert.equal(ev2.prevented, false, 'no orphaned listener keeps denying after close');
  await adapter.shutdownAll();
});

test('an unwired or throwing download gate fails closed', async () => {
  FakeBrowserWindow.reset();
  const { adapter } = makeAdapter(); // no downloadGate at all
  const rec = RECORD();
  await adapter.open(rec, 'https://example.com');
  const win = FakeBrowserWindow.instances[0];
  const ev = makeDownloadEvent();
  win.webContents.emitSession('will-download', ev, {}, win.webContents);
  assert.equal(ev.prevented, true, 'unwired gate denies');
  await adapter.shutdownAll();

  FakeBrowserWindow.reset();
  const throwing = new ComputerBrowser({
    BrowserWindow: FakeBrowserWindow,
    profileDirFor: (p) => path.join(os.tmpdir(), 'cmp-dl2', p.replace(/^persist:/, '')),
    downloadGate: () => { throw new Error('gate exploded'); },
  });
  const rec2 = RECORD('cmp-throw');
  await throwing.open(rec2, 'https://example.com');
  const win2 = FakeBrowserWindow.instances[0];
  const ev2 = makeDownloadEvent();
  win2.webContents.emitSession('will-download', ev2, {}, win2.webContents);
  assert.equal(ev2.prevented, true, 'a crashing gate denies, never allows');
  await throwing.shutdownAll();
});

// ─── deferred wipe (Chromium file locks on Windows) ──────────────────────────

test('a locked profile is never silently dropped: deferred wipe persists until flush', async () => {
  FakeBrowserWindow.reset();
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-locked-'));
  const registryFile = path.join(profileRoot, 'computer-wipes.json');
  const locked = new Set(['computer-cmp-defer']);
  let removeCalls = 0;
  const adapter = new ComputerBrowser({
    BrowserWindow: FakeBrowserWindow,
    profileDirFor: (partition) => path.join(profileRoot, partition.replace(/^persist:/, '')),
    remover: (dir) => {
      removeCalls++;
      if (locked.has(path.basename(dir))) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
    wipeRegistryFile: registryFile,
    wipeRetryDelayMs: 1,
  });

  const rec = RECORD('cmp-defer');
  await adapter.open(rec, 'https://example.com');
  const partDir = path.join(profileRoot, 'computer-cmp-defer');
  fs.mkdirSync(partDir, { recursive: true });
  fs.writeFileSync(path.join(partDir, 'Cookies'), 'x');

  const res = await adapter.dispose(rec.id, true);
  assert.equal(res.ok, true, 'dispose itself succeeds — the wipe is recorded, not lost');
  assert.ok(fs.existsSync(partDir), 'simulated lock still holds the dir');
  assert.ok(removeCalls >= 4, `retried against the lock (${removeCalls} calls)`);
  assert.deepEqual(adapter.listPendingWipes(), ['persist:computer-cmp-defer']);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryFile, 'utf8')), ['persist:computer-cmp-defer'],
    'registry file records the pending wipe for the next launch');

  // Lock releases → flush completes the wipe and clears the registry.
  locked.delete('computer-cmp-defer');
  await adapter.flushPendingWipes();
  assert.equal(fs.existsSync(partDir), false, 'deferred wipe actually removed the dir');
  assert.deepEqual(adapter.listPendingWipes(), []);
  assert.equal(fs.existsSync(registryFile), false, 'registry cleaned up');
  await adapter.shutdownAll();
});

test('a fresh adapter (next launch) flushes a wipe recorded by the previous process', () => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-next-'));
  const registryFile = path.join(profileRoot, 'computer-wipes.json');
  const dir = path.join(profileRoot, 'computer-cmp-crash');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cookies'), 'x');
  fs.writeFileSync(registryFile, JSON.stringify(['persist:computer-cmp-crash']));

  const adapter = new ComputerBrowser({
    BrowserWindow: FakeBrowserWindow,
    profileDirFor: (partition) => path.join(profileRoot, partition.replace(/^persist:/, '')),
    wipeRegistryFile: registryFile,
  });
  assert.equal(fs.existsSync(dir), false, 'ctor recovered the recorded wipe');
  assert.equal(fs.existsSync(registryFile), false, 'registry cleared after recovery');
  assert.deepEqual(adapter.listPendingWipes(), []);
});

// ─── manager ↔ adapter integration (real files on disk) ──────────────────────

function makeManager(browser) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-brw-'));
  const events = [];
  let tick = 1_700_000_000_000;
  let mintN = 0;
  const manager = new ComputerManager({
    repo: new MemoryComputerRepo(),
    computersRoot: path.join(dir, 'computers'),
    pty: { ptyForAgent: () => null, info: () => null, idleFor: () => undefined },
    browser,
    emit: () => {},
    log: (e) => events.push(e),
    now: () => ++tick,
    mint: (prefix) => `${prefix}-${++mintN}`,
    hasActiveTask: () => false,
  });
  return { manager, events, dir };
}

async function startedComputer(manager, opts = {}) {
  const rec = (await manager.create({ agentId: 'alpha' })).value.record;
  if (opts.browserNav !== false) {
    await manager.configure(rec.id, { permissions: { agent: { browserNav: true } } });
  }
  await manager.start(rec.id);
  return rec;
}

test('manager open/navigate/status through the real adapter, default-deny first', async () => {
  FakeBrowserWindow.reset();
  const { adapter } = makeAdapter();
  const { manager, events } = makeManager(adapter);

  // default-deny: no browserNav yet → never even constructs a window.
  const deniedRec = (await manager.create({ agentId: 'denied' })).value.record;
  await manager.start(deniedRec.id);
  const denied = await manager.openBrowser(deniedRec.id, 'https://example.com');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_DENIED');
  assert.equal(FakeBrowserWindow.instances.length, 0, 'denied navigation creates no window');
  assert.equal(events.filter((e) => e.event === 'permission-denied').length, 1);

  const rec = await startedComputer(manager);
  const opened = await manager.openBrowser(rec.id, 'https://example.com');
  assert.equal(opened.ok, true);
  const st = manager.getBrowserStatus(rec.id);
  assert.equal(st.value.open, true);
  assert.equal(st.value.profileId, rec.browserProfileId, 'status reports the partition profile id');

  const dup = await manager.openBrowser(rec.id); // no url, already open
  assert.equal(dup.value.alreadyOpen, true);

  const nav = await manager.navigate(rec.id, 'https://example.org');
  assert.equal(nav.ok, true);
  assert.equal(manager.getBrowserStatus(rec.id).value.url, 'https://example.org');
  await adapter.shutdownAll();
});

test('captureScreen writes a real PNG under the computer directory and honors the byte cap', async () => {
  FakeBrowserWindow.reset();
  const { adapter } = makeAdapter();
  const { manager, events } = makeManager(adapter);
  const rec = await startedComputer(manager, { browserNav: true });
  await manager.openBrowser(rec.id, 'https://example.com');

  // Screen ops are USER-only: an agent actor is refused before any capture.
  const agentShot = await manager.captureScreen(rec.id, { kind: 'agent', agentId: 'alpha' });
  assert.equal(agentShot.ok, false);
  assert.equal(agentShot.code, 'PERMISSION_DENIED');
  assert.match(agentShot.error, /local operator/);

  const shot = await manager.captureScreen(rec.id);
  assert.equal(shot.ok, true, JSON.stringify(shot));
  assert.equal(shot.value.bytes, FULL.length);
  assert.ok(fs.existsSync(shot.value.path), 'screenshot saved for real');
  assert.ok(shot.value.path.includes(path.join(rec.id, 'screenshots')), 'saved under the computer dir');
  assert.deepEqual(Buffer.from(shot.value.pngBase64, 'base64'), FULL, 'base64 round-trips');
  assert.equal(events.filter((e) => e.event === 'screen-captured').length, 1);

  // Enforce the persisted byte cap on the next capture (patch the stored row,
  // not the possibly-stale create-time object).
  const fresh = manager['deps'].repo.get(rec.id);
  fresh.resourceLimits = { ...fresh.resourceLimits, screenshotMaxBytes: 16 };
  manager['deps'].repo.update(fresh);
  const tooBig = await manager.captureScreen(rec.id);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /exceeds limit/);
  await adapter.shutdownAll();
});

test('dispose through the manager closes the window and wipes the profile on policy', async () => {
  FakeBrowserWindow.reset();
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-prof2-'));
  const { adapter, wipes } = makeAdapter({ profileRoot });
  const { manager } = makeManager(adapter);
  const rec = await startedComputer(manager, { browserNav: true });
  await manager.openBrowser(rec.id, 'https://example.com');
  assert.equal(adapter.status(rec.id).open, true);

  await manager.configure(rec.id, { persistencePolicy: 'dispose' });
  const partitionDir = path.join(profileRoot, `computer-${rec.id}`);
  fs.mkdirSync(partitionDir, { recursive: true });

  const res = await manager.dispose(rec.id, { confirm: true });
  assert.equal(res.ok, true);
  assert.equal(res.value.removedFiles, true);
  assert.equal(adapter.status(rec.id).open, false, 'window closed');
  assert.equal(wipes.length, 1, 'profile wipe invoked');
  assert.equal(fs.existsSync(partitionDir), false, 'profile gone from disk');
});
