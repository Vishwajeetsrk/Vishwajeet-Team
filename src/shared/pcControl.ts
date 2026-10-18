/**
 * PRD-1 — own-PC control (the "agent drives YOUR machine" surface).
 *
 * Zero-dependency Windows input via generated PowerShell (spawned as argv —
 * never through a shell). Every request is VALIDATED here (allowlists only:
 * ops, integer coordinates, SendKeys-hostile characters refused, fixed key
 * names, fixed app names) so the main process never string-concats an
 * unvalidated value into a script. Policy lives in the existing computer-op
 * domain: these action names are deliberately NOT in the readonly set, so an
 * agent-originated op falls through to require-approval (fail-safe); a user
 * actor is allowed and audited. Arming is opt-in + TTL + kill-switch.
 */

export const PC_CONTROL_ARM_TTL_MS = 10 * 60_000;
export const PC_CONTROL_MAX_TEXT = 500;
export const PC_COORD_MAX = 32_767;

export const PC_CONTROL_OPS = ['screenshot', 'move', 'click', 'type', 'key', 'openApp'] as const;
export type PcControlOp = (typeof PC_CONTROL_OPS)[number];

export const PC_KEYS = [
  'enter', 'tab', 'esc', 'backspace', 'delete',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'space', 'win', 'alt', 'ctrl', 'shift',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'
] as const;
export type PcKey = (typeof PC_KEYS)[number];

/** Fixed app allowlist — exact names mapped to known system binaries. An
 *  arbitrary path or switch-bearing string can NEVER reach Start-Process. */
export const PC_APPS: Readonly<Record<string, string>> = {
  notepad: 'notepad.exe',
  calc: 'calc.exe',
  mspaint: 'mspaint.exe',
  explorer: 'explorer.exe',
  taskmgr: 'taskmgr.exe',
  control: 'control.exe'
};
export type PcApp = keyof typeof PC_APPS;

export interface PcControlRequest {
  op: PcControlOp;
  x?: number;
  y?: number;
  button?: 'left' | 'right';
  text?: string;
  key?: PcKey;
  app?: PcApp;
}

export interface PcControlValidation {
  ok: boolean;
  request?: PcControlRequest;
  errors: string[];
}

/** SendKeys treats {}^%+~() as syntax with no escape hatch we trust — the
 *  validator REFUSES any text containing them (fail-closed; the operator can
 *  still type freely in the UI). Newlines are refused too (one SendKeys call
 *  is one line). */
const TYPE_RE = /^[^\r\n{}^%+~()]{1,500}$/;

function intCoord(v: unknown, label: string, errors: string[]): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > PC_COORD_MAX) {
    errors.push(`${label} must be an integer 0-${PC_COORD_MAX}`);
    return undefined;
  }
  return v;
}

/** Validate an untrusted request. Only a `ok:true` result may reach a script
 *  builder — builders re-check nothing, they trust this gate. */
export function validatePcControlRequest(raw: unknown): PcControlValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['request must be an object'] };
  const r = raw as Record<string, unknown>;
  const op = r.op;
  if (typeof op !== 'string' || !(PC_CONTROL_OPS as readonly string[]).includes(op)) {
    return { ok: false, errors: [`op must be one of ${PC_CONTROL_OPS.join('/')}`] };
  }
  const out: PcControlRequest = { op: op as PcControlOp };

  if (op === 'move' || op === 'click') {
    const x = intCoord(r.x, 'x', errors);
    const y = intCoord(r.y, 'y', errors);
    if (x !== undefined) out.x = x;
    if (y !== undefined) out.y = y;
  }
  if (op === 'click') {
    const b = r.button ?? 'left';
    if (b !== 'left' && b !== 'right') errors.push('button must be left or right');
    else out.button = b;
  }
  if (op === 'type') {
    const text = r.text;
    if (typeof text !== 'string' || !TYPE_RE.test(text)) {
      errors.push(`text must be 1-${PC_CONTROL_MAX_TEXT} chars, no newline and none of {}^%+~()`);
    } else out.text = text;
  }
  if (op === 'key') {
    if (typeof r.key !== 'string' || !(PC_KEYS as readonly string[]).includes(r.key)) {
      errors.push(`key must be one of ${PC_KEYS.join('/')}`);
    } else out.key = r.key as PcKey;
  }
  if (op === 'openApp') {
    if (typeof r.app !== 'string' || !Object.hasOwn(PC_APPS, r.app)) {
      errors.push(`app must be one of ${Object.keys(PC_APPS).join('/')}`);
    } else out.app = r.app as PcApp;
  }
  return errors.length ? { ok: false, errors } : { ok: true, request: out, errors };
}

/** Policy action name under the existing `computer-op` domain. None of these
 *  are in COMPUTER_READONLY, so an agent-originated op is require-approval by
 *  the catalog's own fail-safe rule. */
export function policyActionForOp(op: PcControlOp): string {
  return `pc${op[0].toUpperCase()}${op.slice(1)}`;
}

/** Single-quoted PowerShell string literal: `'` doubles, everything else is
 *  literal (no `$` interpolation, no backtick escapes). Only ever called with
 *  TYPE_RE-validated text. */
export function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

const PS_HEADER = "Add-Type -AssemblyName System.Windows.Forms; ";

/** user32 mouse injection, compiled once per call (no persisted native code). */
const PS_MOUSE = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class PcMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
}
'@`;

export function psMoveScript(x: number, y: number): string {
  return `${PS_MOUSE}\n[PcMouse]::SetCursorPos(${x}, ${y}) | Out-Null`;
}

export function psClickScript(x: number, y: number, button: 'left' | 'right'): string {
  const down = button === 'right' ? 'RIGHTDOWN' : 'LEFTDOWN';
  const up = button === 'right' ? 'RIGHTUP' : 'LEFTUP';
  return `${PS_MOUSE}\n[PcMouse]::SetCursorPos(${x}, ${y}) | Out-Null\n`
    + `[PcMouse]::mouse_event([PcMouse]::${down}, 0, 0, 0, [UIntPtr]::Zero)\n`
    + `Start-Sleep -Milliseconds 30\n`
    + `[PcMouse]::mouse_event([PcMouse]::${up}, 0, 0, 0, [UIntPtr]::Zero)`;
}

export function psTypeScript(text: string): string {
  return `${PS_HEADER}[System.Windows.Forms.SendKeys]::SendWait(${psQuote(text)})`;
}

const KEY_SENDS: Readonly<Record<PcKey, string>> = {
  enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', backspace: '{BS}', delete: '{DEL}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  space: '{SPACE}', win: '{LWIN}', alt: '%', ctrl: '^', shift: '+',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}'
};

export function psKeyScript(key: PcKey): string {
  return `${PS_HEADER}[System.Windows.Forms.SendKeys]::SendWait('${KEY_SENDS[key]}')`;
}

export function psOpenAppScript(app: PcApp): string {
  // Binary comes from the fixed map — never from the request string.
  return `Start-Process -FilePath '${PC_APPS[app]}'`;
}
