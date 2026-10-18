/**
 * PRD-1 — own-PC control, main-process runtime.
 *
 * Gate order in exec (fail-closed, nothing runs out of it):
 *   1. validate (shared allowlists) → invalid
 *   2. emergency stop (agents) → denied
 *   3. armed session? (opt-in + TTL; the on-screen indicator IS the consent)
 *      → not-armed
 *   4. policy computer-op:${pcX} → allow | one-shot retry token | desk
 *      (awaiting-approval) | denied
 *   5. platform + execute (screenshot via desktopCapturer; input ops via
 *      argv-spawned PowerShell built from VALIDATED values only)
 *
 * No native modules (the installer builds without a C++ toolchain): mouse
 * injection is a per-call user32 Add-Type, typing is SendKeys with a
 * refuse-don't-escape policy for SendKeys metacharacters.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserWindow, desktopCapturer } from 'electron';
import {
  evaluatePolicy,
  type EmergencyFlags,
  type PolicyActor
} from '../shared/actionPolicy';
import {
  PC_CONTROL_ARM_TTL_MS,
  policyActionForOp,
  psClickScript,
  psKeyScript,
  psMoveScript,
  psOpenAppScript,
  psTypeScript,
  validatePcControlRequest,
  type PcControlOp
} from '../shared/pcControl';
import type { ApprovalDesk } from './approvals';

export interface PcControlDeps {
  isEnabled: () => boolean;
  emergency: () => EmergencyFlags;
  desk: () => ApprovalDesk;
}

export interface PcControlState {
  enabled: boolean;
  armed: boolean;
  remainingMs: number;
}

export type PcExecResult =
  | { ok: true; op: PcControlOp; detail?: string }
  | {
      ok: false;
      status: 'disabled' | 'not-armed' | 'expired' | 'invalid' | 'awaiting-approval'
        | 'denied' | 'unsupported' | 'failed';
      error?: string;
      errors?: string[];
      approvalId?: string;
    };

let armedUntil = 0;
let indicator: BrowserWindow | null = null;
let ttlTimer: NodeJS.Timeout | null = null;

const INDICATOR_HTML = encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#6E1423;color:#F4F1EA;font:600 12px/1.2 system-ui,sans-serif;
display:flex;align-items:center;gap:12px;padding:0 12px;height:56px;user-select:none}
button{background:#F4F1EA;color:#1A1320;border:none;padding:6px 12px;font:600 11px system-ui;cursor:pointer}
</style><div>PC CONTROL ARMED — agents can drive this machine</div>
<button onclick="window.close()">DISARM</button>`);

function showIndicator(): void {
  if (indicator && !indicator.isDestroyed()) { indicator.showInactive(); return; }
  indicator = new BrowserWindow({
    width: 420, height: 56, frame: false, resizable: false, minimizable: false,
    maximizable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: '#6E1423',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  indicator.setAlwaysOnTop(true, 'screen-saver');
  indicator.on('closed', () => { indicator = null; disarm(); });
  void indicator.loadURL(`data:text/html,${INDICATOR_HTML}`);
  indicator.showInactive();
}

function hideIndicator(): void {
  if (indicator && !indicator.isDestroyed()) {
    indicator.removeAllListeners('closed'); // closing on purpose must not re-enter
    indicator.close();
  }
  indicator = null;
}

/** Disarm the session and drop the indicator. Idempotent. */
export function disarm(): void {
  armedUntil = 0;
  if (ttlTimer) { clearTimeout(ttlTimer); ttlTimer = null; }
  hideIndicator();
}

export function pcControlState(deps: PcControlDeps): PcControlState {
  const now = Date.now();
  const armed = deps.isEnabled() && armedUntil > now;
  return {
    enabled: deps.isEnabled(),
    armed,
    remainingMs: armed ? armedUntil - now : 0
  };
}

/** Arm a TTL session. Refuses when the opt-in flag is off (nothing to arm). */
export function arm(deps: PcControlDeps): { ok: boolean; error?: string } {
  if (!deps.isEnabled()) return { ok: false, error: 'own-PC control is disabled in Settings' };
  armedUntil = Date.now() + PC_CONTROL_ARM_TTL_MS;
  if (ttlTimer) clearTimeout(ttlTimer);
  ttlTimer = setTimeout(() => disarm(), PC_CONTROL_ARM_TTL_MS + 250);
  ttlTimer.unref?.();
  showIndicator();
  return { ok: true };
}

function isArmed(): boolean { return armedUntil > Date.now(); }

/** Run a validated op through PowerShell as ARGV (no shell). */
function runPS(script: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    const kill = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 8_000);
    child.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, error: String(e) }); });
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim() || `exit ${code}` });
    });
  });
}

async function captureScreenshot(): Promise<{ ok: boolean; detail?: string; error?: string }> {
  try {
    const source = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    const primary = source[0];
    if (!primary || primary.thumbnail.isEmpty()) return { ok: false, error: 'no screen frame captured' };
    const buf = primary.thumbnail.toPNG();
    const file = join(tmpdir(), `pc-control-${Date.now()}.png`);
    writeFileSync(file, buf);
    return { ok: true, detail: file };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Execute an op that has already passed validation AND the policy gate. */
async function execute(request: NonNullable<ReturnType<typeof validatePcControlRequest>['request']>)
  : Promise<PcExecResult> {
  if (process.platform !== 'win32') {
    return { ok: false, status: 'unsupported', error: `own-PC input is Windows-only (this is ${process.platform})` };
  }
  if (request.op === 'screenshot') {
    const cap = await captureScreenshot();
    return cap.ok
      ? { ok: true, op: 'screenshot', detail: cap.detail }
      : { ok: false, status: 'failed', error: cap.error };
  }
  const script =
    request.op === 'move' ? psMoveScript(request.x!, request.y!)
    : request.op === 'click' ? psClickScript(request.x!, request.y!, request.button ?? 'left')
    : request.op === 'type' ? psTypeScript(request.text!)
    : request.op === 'key' ? psKeyScript(request.key!)
    : psOpenAppScript(request.app!);
  const r = await runPS(script);
  return r.ok ? { ok: true, op: request.op } : { ok: false, status: 'failed', error: r.error };
}

/**
 * The gate. `actor` is user-pinned main-side (renderer never names one);
 * agent-originated calls additionally consume the desk's one-shot retry
 * token when the operator approved that exact action.
 */
export async function exec(deps: PcControlDeps, raw: unknown, actor: PolicyActor): Promise<PcExecResult> {
  const v = validatePcControlRequest(raw);
  if (!v.ok || !v.request) return { ok: false, status: 'invalid', errors: v.errors };

  if (actor.kind === 'agent' && deps.emergency().stopped) {
    return { ok: false, status: 'denied', error: 'Emergency STOP is active' };
  }
  if (!deps.isEnabled()) return { ok: false, status: 'disabled', error: 'own-PC control is disabled' };
  if (!isArmed()) return { ok: false, status: 'not-armed', error: 'arm a PC-control session first' };

  const action = policyActionForOp(v.request.op);
  const decision = evaluatePolicy(
    { domain: 'computer-op', action, actor },
    { emergency: deps.emergency() }
  );
  if (decision.decision === 'deny') {
    return { ok: false, status: 'denied', error: decision.reason };
  }
  if (decision.decision === 'require-approval') {
    if (actor.kind === 'agent' && deps.desk().consumeRetry(actor.agentId, action)) {
      return execute(v.request); // one-shot token from a fresh approval
    }
    const item = deps.desk().req({
      domain: 'computer-op', action, actor: actor.kind === 'agent' ? actor.agentId : 'user',
      detail: `${v.request.op} on this PC`,
      ruleId: decision.ruleId
    });
    return { ok: false, status: 'awaiting-approval', approvalId: item.id };
  }
  return execute(v.request);
}
