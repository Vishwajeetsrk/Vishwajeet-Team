/**
 * PRD-1 — own-PC control.
 * Gate: OFF by default; a session must be armed (opt-in + TTL + indicator
 * with a kill-switch) before ANY op runs; validation is allowlist-only and
 * SendKeys-hostile characters are refused; agent ops fall through the
 * computer-op fail-safe to require-approval (one-shot retry token); the
 * renderer channel is user-pinned. Input scripts are built only from
 * validated values and PowerShell is argv-spawned, never shell-interpolated.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const pc = loadTs('src/shared/pcControl.ts');
const policy = loadTs('src/shared/actionPolicy.ts');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('validation is allowlist-only: ops, coords, text, keys, apps', () => {
  assert.equal(pc.validatePcControlRequest({ op: 'explode' }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'click', x: -1, y: 0 }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'click', x: 1.5, y: 0 }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'move', x: 10, y: 99999 }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'click', x: 10, y: 20 }).ok, true);
  assert.equal(pc.validatePcControlRequest({ op: 'click', x: 10, y: 20, button: 'middle' }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'key', key: 'window' }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'key', key: 'enter' }).ok, true);
  assert.equal(pc.validatePcControlRequest({ op: 'openApp', app: 'powershell' }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'openApp', app: 'notepad' }).ok, true);
});

test('type refuses every SendKeys metacharacter and multiline text', () => {
  for (const evil of ['{ENTER}', 'a^b', '50%off', 'a+b', 'x~y', 'f(x)', 'a{b', 'two\nlines']) {
    const r = pc.validatePcControlRequest({ op: 'type', text: evil });
    assert.equal(r.ok, false, `must refuse ${JSON.stringify(evil)}`);
  }
  assert.equal(pc.validatePcControlRequest({ op: 'type', text: 'Hello, world 123.' }).ok, true);
  assert.equal(pc.validatePcControlRequest({ op: 'type', text: '' }).ok, false);
  assert.equal(pc.validatePcControlRequest({ op: 'type', text: 'x'.repeat(501) }).ok, false);
});

test('script builders embed only validated values; quoting escapes quotes', () => {
  assert.ok(pc.psMoveScript(10, 20).includes('SetCursorPos(10, 20)'));
  assert.ok(pc.psClickScript(5, 6, 'right').includes('::RIGHTDOWN'));
  assert.ok(!pc.psClickScript(5, 6, 'left').includes('::RIGHTDOWN'),
    'left click never invokes the right-button constants');
  assert.ok(pc.psClickScript(5, 6, 'left').includes('::LEFTDOWN'));
  assert.equal(pc.psQuote("it's"), "'it''s'");
  const typed = pc.psTypeScript('hello');
  assert.ok(typed.includes("SendWait('hello')"));
  assert.ok(!/powershell|cmd/i.test(pc.psOpenAppScript('notepad')), 'no shell binary beyond Start-Process target');
  assert.ok(pc.psOpenAppScript('notepad').includes("notepad.exe"), 'binary from the fixed map');
});

test('agent ops fail safe to require-approval; user ops are allowed', () => {
  const agentActor = { kind: 'agent', agentId: 'pam' };
  const ctx = { emergency: policy.EMERGENCY_OFF, overrides: {} };
  for (const op of pc.PC_CONTROL_OPS) {
    const action = pc.policyActionForOp(op);
    const d = policy.evaluatePolicy({ domain: 'computer-op', action, actor: agentActor }, ctx);
    assert.equal(d.decision, 'require-approval', `${op} must require approval for agents`);
  }
  const user = policy.evaluatePolicy(
    { domain: 'computer-op', action: 'pcClick', actor: { kind: 'user' } }, ctx);
  assert.equal(user.decision, 'allow');
  const stopped = policy.evaluatePolicy(
    { domain: 'computer-op', action: 'pcClick', actor: agentActor },
    { emergency: { ...policy.EMERGENCY_OFF, stopped: true }, overrides: {} });
  assert.equal(stopped.decision, 'deny', 'Emergency STOP beats everything');
});

test('runtime gate is fail-closed: disabled → not-armed → policy → execute', () => {
  const main = read('src/main/pcControl.ts');
  const gate = main.slice(main.indexOf('export async function exec'));
  const iVal = gate.indexOf("status: 'invalid'");
  const iArmed = gate.indexOf("status: 'not-armed'");
  const iPolicy = gate.indexOf('evaluatePolicy');
  const iExec = gate.indexOf('return execute');
  assert.ok(iVal > -1 && iArmed > iVal, 'validation before armed check');
  assert.ok(iPolicy > iArmed, 'armed check before policy');
  assert.ok(iExec > iPolicy, 'policy before execute');
  assert.ok(gate.includes("consumeRetry(actor.agentId, action)"), 'one-shot retry token');
  assert.ok(gate.includes("status: 'awaiting-approval'"), 'desk handoff for agents');
  // Emergency-stop check for agents sits above the armed check.
  assert.ok(gate.indexOf("emergency().stopped") < iArmed, 'emergency before arming');
});

test('arm needs the opt-in, arms a TTL session, and the indicator kills it', () => {
  const main = read('src/main/pcControl.ts');
  assert.ok(main.includes("error: 'own-PC control is disabled in Settings'"), 'arm refuses when disabled');
  assert.ok(main.includes('PC_CONTROL_ARM_TTL_MS'), 'TTL from the shared constant');
  assert.ok(main.includes('showIndicator()'), 'indicator on arm');
  assert.ok(main.includes('DISARM'), 'kill-switch button on the indicator');
  assert.ok(main.includes("window.close()"), 'kill-switch closes the indicator window');
  assert.ok(main.includes("indicator.on('closed', () => { indicator = null; disarm(); })"),
    'closing the indicator disarms');
  assert.ok(main.includes('setTimeout(() => disarm(), PC_CONTROL_ARM_TTL_MS'), 'auto-disarm timer');
});

test('input runs argv-spawned powershell; no shell interpolation', () => {
  const main = read('src/main/pcControl.ts');
  assert.ok(main.includes("spawn('powershell.exe'"), 'argv spawn');
  assert.ok(main.includes('windowsHide: true'));
  assert.ok(main.includes("import { spawn } from 'node:child_process'"), 'spawn-only child import');
  assert.ok(!main.includes('execSync') && !/\.exec\(/.test(main),
    'no exec/execSync anywhere in the runtime');
  assert.ok(main.includes('desktopCapturer'), 'screenshot via Electron, not a PS screen-grab');
});

test('config default is OFF; disabling disarms; renderer channel is user-pinned', () => {
  const cfg = read('src/main/config.ts');
  assert.ok(cfg.includes('pcControlEnabled: false'), 'default off');
  const main = read('src/main/index.ts');
  assert.ok(main.includes("ipcMain.handle('pcControl:state'"));
  assert.ok(main.includes("ipcMain.handle('pcControl:arm'"));
  assert.ok(main.includes("ipcMain.handle('pcControl:disarm'"));
  assert.ok(main.includes("ipcMain.handle('pcControl:exec'"));
  assert.ok(main.includes("if (!on) pcControlRuntime.disarm()"), 'disable drops any live session');
  assert.ok(main.includes("auditStore.record({ kind: 'override-changed', actor: 'user', action: 'security.pcControlEnabled'"),
    'toggle is audited');
  const handler = main.slice(main.indexOf("ipcMain.handle('pcControl:exec'"), main.indexOf("ipcMain.handle('policy:get'"));
  assert.ok(handler.includes("{ kind: 'user' }"), 'actor is pinned user-side, never from the request');
  assert.ok(!handler.includes('agentId:'), 'the channel can never claim an agent actor');
});

test('preload + Security panel expose the surface; locales carry the keys', () => {
  const pre = read('src/preload/index.ts');
  for (const m of ['pcControlState', 'pcControlSetEnabled', 'pcControlArm', 'pcControlDisarm', 'pcControlExec']) {
    assert.ok(pre.includes(`${m}:`), `preload ${m}`);
  }
  const panel = read('src/renderer/src/components/SecurityPanel.tsx');
  assert.ok(panel.includes('pcControlState()'), 'panel reads live state');
  assert.ok(panel.includes('pcControlArm()'), 'arm button');
  assert.ok(panel.includes('pcControlDisarm()'), 'disarm button');
  assert.ok(panel.includes('pcControlSetEnabled'), 'opt-in toggle');
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    for (const k of ['pcTitle', 'pcLabel', 'pcHint', 'pcEnable', 'pcArm', 'pcDisarm', 'pcArmed', 'pcRemaining']) {
      assert.ok(json.securityTab?.[k], `${loc}: securityTab.${k}`);
    }
  }
});
