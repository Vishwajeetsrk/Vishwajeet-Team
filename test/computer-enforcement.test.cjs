'use strict';

/**
 * Phase 7 (Orbit M2) — Computer Enforcement Completion (design §1 table, §2
 * wiring, §5 deferrals, §6 test strategy).
 *
 * REAL vs MOCK:
 * - REAL: `loopbackOnlyAllowed` + `ComputerBrowser` (the shipped adapter) with
 *   an injected fake BrowserWindow (house style — the session/webRequest
 *   recorder is the seam, like `downloadGate` already was); REAL
 *   `PolicyService`+`ApprovalDesk`+`AuditStore`; REAL `ComputerManager` +
 *   `MemoryComputerRepo` with the faked browser/pty harness.
 * - MOCK: browser/pty runtimes (electron/node-pty unavailable here — the
 *   real-window proof lives in computer-electron.electron.cjs).
 *
 * Covers design §6: network truth table, gate wiring (incl. the always-deny
 * downloadGate fix), capability layer in the hook boundary, browserNav
 * end-to-end, and the contract greps that no §1 capability is left unenforced
 * (CPU/memory/disk are the NAMED deferrals of §5, not silent holes).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { loopbackOnlyAllowed, ComputerBrowser } = loadTs('src/main/computerBrowser.ts');
const { PolicyService } = loadTs('src/main/policyService.ts');
const { ApprovalDesk } = loadTs('src/main/approvals.ts');
const { AuditStore } = loadTs('src/main/audit.ts');
const { ComputerManager } = loadTs('src/main/computer.ts');
const { MemoryComputerRepo } = loadTs('src/main/computerStore.ts');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
const BROWSER_SRC = fs.readFileSync(path.join(ROOT, 'src/main/computerBrowser.ts'), 'utf8');

// ─── 1. loopback-only allowlist (pure) ───────────────────────────────────────

test('loopbackOnlyAllowed: network=false sessions stay on loopback + local schemes', () => {
  const allow = [
    'http://127.0.0.1:5173/', 'http://127.0.0.1', 'https://127.0.0.1:8443/x',
    'http://localhost:3000', 'http://[::1]:8080', 'http://[::1]/',
    'about:blank', 'data:text/html,<b>x</b>', 'blob:http://127.0.0.1/uuid', 'file:///tmp/a.html'
  ];
  const deny = [
    'https://example.com', 'http://evil.test/p', 'https://127.0.0.1.evil.test/',
    'ftp://127.0.0.1/file', 'not a url', 'ws://remotehost:1234'
  ];
  for (const u of allow) assert.equal(loopbackOnlyAllowed(u), true, `must allow ${u}`);
  for (const u of deny) assert.equal(loopbackOnlyAllowed(u), false, `must deny ${u}`);
  // 128.x is NOT loopback.
  assert.equal(loopbackOnlyAllowed('http://128.0.0.1/'), false);
});

// ─── 2. ComputerBrowser: network + download gates on the session ─────────────

class FakeWin {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.url = '';
    this.destroyed = false;
    this.blockedPrevented = false;
    const sessionListeners = new Map();
    this.webContents = {
      capturePage: async () => ({ toPNG: () => Buffer.alloc(200, 1), isEmpty: () => false }),
      on: () => {},
      session: {
        on: (ev, cb) => { if (!sessionListeners.has(ev)) sessionListeners.set(ev, []); sessionListeners.get(ev).push(cb); },
        removeListener: (ev, cb) => {
          const list = sessionListeners.get(ev) ?? [];
          const i = list.indexOf(cb);
          if (i >= 0) list.splice(i, 1);
        },
        webRequest: {
          onBeforeRequest: (filter, listener) => {
            this.beforeRequest = { filter, listener };
          }
        }
      },
      emitSession: (ev, ...args) => {
        for (const cb of [...(sessionListeners.get(ev) ?? [])]) cb(...args);
      }
    };
    FakeWin.instances.push(this);
  }
  async loadURL(u) { this.url = u; }
  getURL() { return this.url; }
  getTitle() { return 't'; }
  show() {}
  hide() {}
  isVisible() { return false; }
  close() { if (!this.destroyed) { this.destroyed = true; for (const cb of this.listeners.get('closed') ?? []) cb(); } }
  isDestroyed() { return this.destroyed; }
  setMenuBarVisibility() {}
  on(ev, cb) { if (!this.listeners.has(ev)) this.listeners.set(ev, []); this.listeners.get(ev).push(cb); }
  static last() { return FakeWin.instances[FakeWin.instances.length - 1]; }
  static reset() { FakeWin.instances = []; }
}

function makeAdapter(deps = {}) {
  return new ComputerBrowser({
    BrowserWindow: FakeWin,
    profileDirFor: (p) => path.join(os.tmpdir(), 'm2-profiles', p.replace(/^persist:/, '')),
    remover: () => {},
    wipeRegistryFile: null,
    ...deps
  });
}

function request(win, url) {
  let response = null;
  win.beforeRequest.listener({ url }, (r) => { response = r; });
  return response;
}

test('session network gate: injected gate decides; absent gate ⇒ loopback-only; throwing ⇒ deny', async () => {
  FakeWin.reset();
  const seen = [];
  const adapter = makeAdapter({ networkGate: (id, url) => { seen.push([id, url]); return url.startsWith('https://allowed.test'); } });
  const rec = { id: 'c1' };
  assert.ok((await adapter.open(rec, 'https://allowed.test/')).ok);
  const win = FakeWin.last();
  assert.ok(win.beforeRequest, 'open() must register onBeforeRequest on the session');
  assert.deepEqual(win.beforeRequest.filter, { urls: ['<all_urls>'] });
  assert.deepEqual(request(win, 'https://allowed.test/x'), { cancel: false });
  assert.deepEqual(request(win, 'https://other.test/x'), { cancel: true });
  assert.deepEqual(seen[0], ['c1', 'https://allowed.test/x'], 'the gate receives computerId + url');

  // Throwing gate → fail closed.
  FakeWin.reset();
  const throwing = makeAdapter({ networkGate: () => { throw new Error('boom'); } });
  assert.ok((await throwing.open({ id: 'c2' }, 'https://x.test')).ok);
  assert.deepEqual(request(FakeWin.last(), 'https://x.test'), { cancel: true });

  // Absent gate → built-in loopback-only.
  FakeWin.reset();
  const bare = makeAdapter({});
  assert.ok((await bare.open({ id: 'c3' }, 'https://x.test')).ok);
  const w = FakeWin.last();
  assert.deepEqual(request(w, 'http://127.0.0.1:5173/'), { cancel: false });
  assert.deepEqual(request(w, 'https://example.com/'), { cancel: true });
  assert.deepEqual(request(w, 'about:blank'), { cancel: false });
});

test('downloadGate fix: a granted gate now actually allows downloads (always-deny bug closed)', async () => {
  FakeWin.reset();
  const adapter = makeAdapter({ downloadGate: (id) => id === 'allowed' });
  assert.ok((await adapter.open({ id: 'allowed' }, 'https://x.test')).ok);
  let prevented = false;
  FakeWin.last().webContents.emitSession('will-download', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'a truthfully granted browserDownloads cap must let the download start');

  FakeWin.reset();
  const denying = makeAdapter({ downloadGate: () => false });
  assert.ok((await denying.open({ id: 'no' }, 'https://x.test')).ok);
  prevented = false;
  FakeWin.last().webContents.emitSession('will-download', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'revoked cap denies again');
});

// ─── 3. PolicyService: computer capability layer (through the M1 seam) ───────

const OFF = { stopped: false, paused: false, externalDisabled: false };
const AGENT = { kind: 'agent', agentId: 'agent-1' };

function makeStack(t, caps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-m2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = new AuditStore(() => dir);
  const desk = new ApprovalDesk(() => path.join(dir, 'approvals.json'));
  let overrides = {};
  let emergency = { ...OFF };
  const svc = new PolicyService({
    overrides: () => overrides,
    emergency: () => ({ ...emergency }),
    persistEmergency: (flags) => { emergency = { ...flags }; },
    desk,
    audit,
    ...(caps !== undefined ? { agentComputerCaps: () => caps } : {})
  });
  return { audit, desk, svc, setOverrides: (o) => { overrides = o; }, setEmergency: (e) => { emergency = { ...e }; } };
}

const decisions = (audit) => audit.query({ kind: 'policy-decision' });

test('externalActions=false denies external-capable tools at the hook boundary (audited, no desk)', (t) => {
  const { audit, desk, svc } = makeStack(t, { externalActions: false, network: true });

  const web = svc.checkAgentTool('agent-1', 'WebFetch');
  assert.equal(web.deny, true, 'external-capable tool must be denied');
  assert.match(web.reason, /computer capability layer/i);
  assert.equal(web.approvalId, undefined, 'a capability refusal is not a desk hold');
  assert.equal(desk.pendingCount(), 0, 'no desk item');
  const row = decisions(audit).find((r) => r.ruleId === 'computer:externalActions');
  assert.ok(row, 'the refusal is audited with ruleId computer:externalActions');
  assert.equal(row.decision, 'deny');

  // Safe tools are unaffected.
  assert.equal(svc.checkAgentTool('agent-1', 'Read').deny, false);

  // Bash is NOT name-external (design §7: cheap name-based detection) — it
  // still goes through the catalog require-approval path, not a silent pass.
  const bash = svc.checkAgentTool('agent-1', 'Bash');
  assert.equal(bash.deny, true);
  assert.match(bash.reason, /Approval Desk/);

  // Emergency still beats the capability layer.
  svc.setEmergency({ stopped: true });
  const stopped = svc.checkAgentTool('agent-1', 'WebFetch');
  assert.equal(stopped.deny, true);
  assert.match(stopped.reason, /STOP/);
});

test('user override beats the computer capability layer (same operator intent)', (t) => {
  const { svc, setOverrides } = makeStack(t, { externalActions: false, network: false });
  setOverrides({ 'hive-tool:WebFetch': 'allow' });
  assert.equal(svc.checkAgentTool('agent-1', 'WebFetch').deny, false, 'override wins over capability');
  setOverrides({ 'hive-tool:WebFetch': 'require-approval' });
  const held = svc.checkAgentTool('agent-1', 'WebFetch');
  assert.equal(held.deny, true, 'override require-approval still holds at the desk');
  assert.ok(held.approvalId, 'desk item created by the M1 path');
});

test('no computer ⇒ catalog behavior is byte-identical (M1 regression)', (t) => {
  const { desk, svc } = makeStack(t, null); // agent has no computer
  assert.equal(svc.checkAgentTool('agent-1', 'Read').deny, false);
  const web = svc.checkAgentTool('agent-1', 'WebFetch');
  assert.equal(web.deny, true, 'catalog require-approval still holds');
  assert.match(web.reason, /Approval Desk/, 'identical to the M1 hold text');
  assert.equal(desk.pendingCount(), 1);

  // …and with the dep ABSENT entirely (M1 wiring untouched), same result.
  const bare = makeStack(t, undefined);
  assert.equal(bare.svc.checkAgentTool('agent-1', 'Read').deny, false);
  assert.equal(bare.svc.checkAgentTool('agent-1', 'WebFetch').deny, true);
});

test('externalActions=true ⇒ capability layer does not interfere', (t) => {
  const { desk, svc } = makeStack(t, { externalActions: true, network: true });
  const web = svc.checkAgentTool('agent-1', 'WebFetch');
  assert.equal(web.deny, true, 'catalog still requires approval — the layer only ever DENIES');
  assert.match(web.reason, /Approval Desk/);
  assert.equal(desk.pendingCount(), 1);
});

// ─── 4. browserNav end-to-end through the real ComputerManager ───────────────

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-mgr-'));
  const events = [];
  const browserState = new Map();
  const browser = {
    async open(rec, url) { browserState.set(rec.id, { open: true, url }); return { ok: true }; },
    async close(id) { const s = browserState.get(id); if (s) s.open = false; return { ok: true }; },
    async navigate(id, url) {
      const s = browserState.get(id);
      if (!s || !s.open) return { ok: false, error: 'not open' };
      s.url = url;
      return { ok: true };
    },
    status(id) { const s = browserState.get(id); return s && s.open ? { open: true, url: s.url } : { open: false }; },
    async capture() { return { ok: true, png: Buffer.from('png') }; },
    setVisible() { return { ok: true }; },
    dispose() { return { ok: true }; },
    async shutdownAll() {}
  };
  const manager = new ComputerManager({
    repo: new MemoryComputerRepo(),
    computersRoot: path.join(dir, 'computers'),
    pty: { ptyForAgent: () => null, info: () => null, idleFor: () => undefined },
    browser,
    control: { pause: () => {} },
    emit: () => {},
    log: (e) => events.push(e),
    now: () => Date.now(),
    mint: (p) => `${p}-0001`
  });
  return { manager, events, browserState, eventsOf: (k) => events.filter((e) => e.event === k) };
}

test('browserNav gate end-to-end: fresh computer denies, granted computer allows', async () => {
  const h = makeHarness();
  const created = await h.manager.create({ agentId: 'alpha' });
  assert.ok(created.ok, created.error);
  const id = created.value.record.id;

  // Fresh default (agent.browserNav=false) → both entry points denied (the
  // permission check runs BEFORE the state guard, so even OFFLINE denies).
  const deniedNav = await h.manager.openBrowser(id, 'https://example.com');
  assert.equal(deniedNav.ok, false);
  assert.equal(deniedNav.code, 'PERMISSION_DENIED');
  assert.equal(h.eventsOf('permission-denied').length >= 1, true, 'denial is evented');

  // Grant the stored capability (user-owned configure) → allowed (needs READY).
  const cfg = await h.manager.configure(id, { permissions: { agent: { browserNav: true } } });
  assert.ok(cfg.ok, cfg.error);
  const started = await h.manager.start(id);
  assert.ok(started.ok, started.error);
  const opened = await h.manager.openBrowser(id, 'https://example.com');
  assert.ok(opened.ok, opened.error);
  const nav = await h.manager.navigate(id, 'https://example.org');
  assert.ok(nav.ok, nav.error);
  assert.equal(h.browserState.get(id).url, 'https://example.org');

  // Revoke again → denied (the gate is live in both directions).
  await h.manager.configure(id, { permissions: { agent: { browserNav: false } } });
  const back = await h.manager.navigate(id, 'https://x.test');
  assert.equal(back.ok, false);
  assert.equal(back.code, 'PERMISSION_DENIED');
});

// ─── 5. Contract greps: nothing in §1 is left silently unenforced ────────────

test('contract: index.ts wires BOTH browser gates and the caps seam into the M1 service', () => {
  assert.match(MAIN, /downloadGate:\s*\(id\) => \{[\s\S]{0,200}?computers\.allows\(id, 'browserDownloads'\)/,
    'downloadGate must consult the stored capability (fixes always-deny)');
  assert.match(MAIN, /networkGate:\s*\(id, url\) => \{[\s\S]{0,300}?computers\.allows\(id, 'network'\)[\s\S]{0,80}?loopbackOnlyAllowed\(url\)/,
    'networkGate must map stored network cap → allow-all / loopback-only');
  assert.match(MAIN, /agentComputerCaps:\s*\(agentId\) => \{/,
    'PolicyService must receive the computer capability seam');
  assert.match(BROWSER_SRC, /onBeforeRequest\(/, 'the session must install the network hook');
  assert.match(BROWSER_SRC, /export function loopbackOnlyAllowed/, 'the built-in allowlist must exist');
});

test('contract: every §1 capability is enforced in code or NAMED as deferred (§5)', () => {
  const computerSrc = fs.readFileSync(path.join(ROOT, 'src/main/computer.ts'), 'utf8');
  // Enforced capabilities have a gate site:
  for (const cap of ['browserNav', 'terminalExec', 'crossAgentWorkspace', 'screenView']) {
    assert.ok(computerSrc.includes(cap), `${cap} must appear in computer.ts enforcement`);
  }
  assert.match(BROWSER_SRC, /downloadGate/, 'browserDownloads gate site exists');
  assert.match(MAIN, /'browserDownloads'|browserDownloads/, 'downloadGate is wired in index');
  assert.match(MAIN, /agentComputerCaps/, 'externalActions gate site exists in the hook boundary');
  // CPU/memory/disk: the design §5 deferral must be RECORDED, not silent.
  const design = fs.readFileSync(path.join(ROOT, 'docs/PHASE-7-DESIGN.md'), 'utf8');
  assert.match(design, /CPU limit per computer/, 'CPU deferral is named in the design');
  assert.match(design, /Memory limit per computer/, 'memory deferral is named in the design');
  assert.match(design, /Disk quota per workspace/, 'disk deferral is named in the design');
});
