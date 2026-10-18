/**
 * ComputerManager — Phase 4 persistent computer runtime.
 *
 * One explicitly identified computer per agent: stable identity (SQLite-backed
 * ComputerRepo), a private workspace root, an Electron persistent browser
 * profile, association with the agent's existing PtyManager session, a
 * validated lifecycle state machine, default-deny permissions enforced HERE
 * in the trusted main process, and truthful runtime events on the existing
 * hive log + `computer:updated` push.
 *
 * Everything with side effects arrives through injected adapters (repo, pty,
 * browser, control, emit, log) so unit tests run under plain node with fakes —
 * better-sqlite3/BrowserWindow are only wired in index.ts.
 *
 * Honesty rules encoded in this file:
 * - `start` never spawns a terminal (hive/CEO/renderer own agent spawning;
 *   PtyManager's id guard is the duplicate backstop) — the computer only
 *   ASSOCIATES with the agent's pty.
 * - `PAUSED` gates tools + computer ops + terminal input; it does NOT suspend
 *   the CLI process.
 * - Unsupported capabilities return UNSUPPORTED, never success.
 * - `reconcile()` never re-dispatches tasks or re-opens runtimes.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_COMPUTER_PERMISSIONS,
  DEFAULT_RESOURCE_LIMITS,
  USER_ACTOR,
  canTransition,
  isRunningStatus,
  opFail,
  opOk,
  type BrowserStatusInfo,
  type ComputerActor,
  type ComputerEventKind,
  type ComputerFailOp,
  type ComputerOp,
  type ComputerRecord,
  type ComputerStatus,
  type TerminalInfo,
  type WorkspaceInfo,
} from '../shared/computer';
import type { ComputerRepo } from './computerStore';
import { safeResolve } from './fs';
import { redactSecrets } from './hive';

/** ms of no real signal before a running computer counts as WORKING→idle. */
export const WORKING_OUTPUT_MS = 10_000;

/** Statuses whose processes are gone after an app restart (stale on disk). */
const NON_PERSISTENT_ACROSS_RESTART: readonly ComputerStatus[] = [
  'STARTING', 'READY', 'WORKING', 'WAITING', 'USER_CONTROL', 'STOPPING', 'SLEEPING',
];

export interface PtyRuntime {
  /** Live pty id for an agent (null when no session is running). */
  ptyForAgent(agentId: string): string | null;
  info(ptyId: string): { running: boolean; pid?: number; cwd?: string; lastOutputAt?: number } | null;
  /** ms since last pty output; undefined when unknown/not running. */
  idleFor(ptyId: string): number | undefined;
}

export interface BrowserRuntime {
  open(rec: ComputerRecord, url: string): Promise<{ ok: boolean; error?: string; unsupported?: boolean }>;
  close(computerId: string): Promise<{ ok: boolean; error?: string; unsupported?: boolean }>;
  navigate(computerId: string, url: string): Promise<{ ok: boolean; error?: string; unsupported?: boolean }>;
  status(computerId: string): BrowserStatusInfo;
  capture(computerId: string): Promise<{ ok: boolean; png?: Buffer; error?: string; unsupported?: boolean }>;
  setVisible(computerId: string, show: boolean): { ok: boolean; error?: string; unsupported?: boolean };
  /**
   * Close the window and, when wipeProfile, delete the persist: partition
   * dir. May resolve before Chromium releases file locks: the adapter
   * registers any still-locked partition for the next launch — never silent.
   */
  dispose(computerId: string, wipeProfile: boolean): Promise<{ ok: boolean; error?: string; unsupported?: boolean }>;
  shutdownAll(): Promise<void>;
}

/** ControlRegistry passthrough (hook-level tool gating — control.ts). */
export interface ComputerControl {
  pause(id: string, on: boolean): void;
}

export interface ComputerManagerDeps {
  repo: ComputerRepo;
  /** <harnessHome>/computers — parent of per-computer dirs. A getter in the
   *  main process (config can change after module load, matching how every
   *  other harnessHome consumer defers the read); plain string in tests. */
  computersRoot: string | (() => string);
  pty: PtyRuntime;
  browser: BrowserRuntime;
  control?: ComputerControl;
  emit?: (channel: string, payload: unknown) => void;
  /** hive appendLog sink (durable Activity feed). */
  log?: (evt: Record<string, unknown>) => void;
  /** Real task-engine signal for WORKING/WAITING derivation. */
  hasActiveTask?: (agentId: string) => boolean;
  now?: () => number;
  mint?: (prefix: string) => string;
}

interface LiveState {
  status: ComputerStatus;
  since: number;
  /** Status to restore on releaseControl. */
  preControl: ComputerStatus | null;
  lastError: string | null;
  watching: boolean;
  lastActivityAt: number;
  startAttempts: number;
}

export interface ComputerStatusSnapshot {
  record: ComputerRecord;
  live: {
    status: ComputerStatus;
    since: number;
    lastError: string | null;
    watching: boolean;
    controlActive: boolean;
  };
}

function defaultMint(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(onTimeout()); }
    }, ms);
    p.then((v) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
    }, () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(onTimeout()); }
    });
  });
}

export class ComputerManager {
  private readonly live = new Map<string, LiveState>();
  private reconciledAt: number | null = null;

  constructor(private readonly deps: ComputerManagerDeps) {}

  /** Resolved per-op so a config change (hive picker) applies to the next op. */
  private get rootDir(): string {
    const r = this.deps.computersRoot;
    return typeof r === 'string' ? r : r();
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private mint(prefix: string): string {
    return this.deps.mint ? this.deps.mint(prefix) : defaultMint(prefix);
  }

  // ─── events ────────────────────────────────────────────────────────────────

  private emitUpdate(rec: ComputerRecord, reason?: string): void {
    this.deps.emit?.('computer:updated', {
      computerId: rec.id,
      agentId: rec.agentId,
      status: this.statusOf(rec.id),
      ...(reason ? { reason: redactSecrets(reason) } : {}),
    });
  }

  private event(evt: ComputerEventKind, rec: ComputerRecord, extra: Record<string, unknown> = {}): void {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra)) {
      safe[k] = typeof v === 'string' ? redactSecrets(v) : v;
    }
    this.deps.log?.({
      kind: 'computer',
      event: evt,
      computerId: rec.id,
      agentId: rec.agentId,
      ...safe,
    });
    this.emitUpdate(rec, evt);
  }

  // ─── identity & registry ───────────────────────────────────────────────────

  /**
   * Create the computer for an agent. Idempotent: an agent that already has a
   * computer gets the SAME record back (stable identity — no duplicates).
   */
  async create(input: { agentId: string; projectId?: string | null }): Promise<ComputerOp<{ record: ComputerRecord; created: boolean }>> {
    const agentId = typeof input?.agentId === 'string' ? input.agentId.trim() : '';
    if (!agentId) return opFail('INTERNAL', 'agentId is required');
    const existing = this.deps.repo.getByAgent(agentId);
    if (existing) return opOk({ record: existing, created: false });

    const id = this.mint('cmp');
    const workspaceId = this.mint('ws');
    const workspaceRoot = join(this.rootDir, id, 'workspace');
    const now = this.now();
    const rec: ComputerRecord = {
      id,
      agentId,
      projectId: input.projectId ?? null,
      status: 'OFFLINE',
      runtimeType: 'local',
      workspaceId,
      workspaceRoot,
      browserProfileId: `persist:computer-${id}`,
      createdAt: now,
      updatedAt: now,
      lastStartedAt: null,
      persistencePolicy: 'retain',
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS },
      permissions: {
        agent: { ...DEFAULT_COMPUTER_PERMISSIONS.agent },
        user: { ...DEFAULT_COMPUTER_PERMISSIONS.user },
      },
      config: {},
    };

    try {
      mkdirSync(workspaceRoot, { recursive: true });
    } catch (e) {
      return opFail('INTERNAL', `workspace creation failed: ${(e as Error).message}`);
    }
    try {
      this.deps.repo.insert(rec);
    } catch (e) {
      return opFail('INTERNAL', `persist failed: ${(e as Error).message}`);
    }
    this.live.set(id, this.freshLive('OFFLINE'));
    this.event('created', rec, { workspaceRoot });
    this.event('workspace-init', rec, { workspaceRoot });
    return opOk({ record: rec, created: true });
  }

  /** get-or-create by agent (panel default path). */
  async ensureForAgent(agentId: string): Promise<ComputerOp<{ record: ComputerRecord; created: boolean }>> {
    const existing = this.deps.repo.getByAgent(agentId);
    if (existing) return opOk({ record: existing, created: false });
    return this.create({ agentId });
  }

  get(id: string): ComputerOp<ComputerRecord> {
    const rec = this.deps.repo.get(id);
    if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    return opOk(rec);
  }

  list(): ComputerOp<ComputerRecord[]> {
    return opOk(this.deps.repo.list());
  }

  getForAgent(agentId: string): ComputerOp<ComputerRecord> {
    const rec = this.deps.repo.getByAgent(agentId);
    if (!rec) return opFail('NOT_FOUND', `no computer for agent: ${agentId}`);
    return opOk(rec);
  }

  private freshLive(status: ComputerStatus): LiveState {
    return {
      status,
      since: this.now(),
      preControl: null,
      lastError: null,
      watching: false,
      lastActivityAt: this.now(),
      startAttempts: 0,
    };
  }

  private liveOf(id: string, rec: ComputerRecord): LiveState {
    let s = this.live.get(id);
    if (!s) { s = this.freshLive(rec.status); this.live.set(id, s); }
    return s;
  }

  /**
   * Validated state transition. Returns null on success, or the failure op.
   * Persists the new status (last-known) and emits truthful events.
   */
  private transition(rec: ComputerRecord, to: ComputerStatus, reason: string): ComputerFailOp | null {
    const s = this.liveOf(rec.id, rec);
    if (s.status === to) return null;
    if (!canTransition(s.status, to)) {
      return opFail('INVALID_STATE', `invalid transition ${s.status} → ${to} (${reason})`);
    }
    const from = s.status;
    s.status = to;
    s.since = this.now();
    rec.status = to;
    rec.updatedAt = this.now();
    if (to === 'READY') rec.lastStartedAt = this.now();
    try { this.deps.repo.update(rec); } catch (e) {
      // Roll memory back so UI truth matches storage truth.
      s.status = from; rec.status = from;
      return opFail('INTERNAL', `persist failed: ${(e as Error).message}`);
    }
    this.event('status', rec, { from, to, reason });
    return null;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  async start(id: string): Promise<ComputerOp<{ status: ComputerStatus; alreadyRunning?: boolean }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const s = this.liveOf(id, rec);

    if (s.status === 'STARTING') return opFail('INVALID_STATE', 'start already in progress');
    if (s.status === 'STOPPING') return opFail('INVALID_STATE', 'stop in progress');
    if (isRunningStatus(s.status)) {
      return opOk({ status: s.status, alreadyRunning: true });
    }
    // OFFLINE / SLEEPING / ERROR → STARTING
    const t = this.transition(rec, 'STARTING', 'start requested');
    if (t) return t;

    const limits = rec.resourceLimits;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= Math.max(1, limits.maxStartAttempts); attempt++) {
      s.startAttempts = attempt;
      try {
        const prep = this.prepareRuntime(rec);
        const ok = await withTimeout(
          prep,
          limits.startTimeoutMs,
          () => ({ ok: false, error: `start timed out after ${limits.startTimeoutMs}ms` } as { ok: boolean; error?: string })
        );
        if (!ok.ok) { lastError = ok.error ?? 'start failed'; continue; }
        s.lastError = null;
        s.lastActivityAt = this.now();
        const rt = this.transition(rec, 'READY', 'runtime ready');
        if (rt) return rt;
        return opOk({ status: 'READY' });
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    s.lastError = lastError;
    this.transition(rec, 'ERROR', `start failed: ${lastError ?? 'unknown'}`);
    this.event('failed', rec, { op: 'start', error: lastError ?? 'unknown' });
    return opFail('INTERNAL', `computer start failed: ${lastError ?? 'unknown'}`);
  }

  /** Local runtime prep: the workspace must exist (recreated if missing). */
  private async prepareRuntime(rec: ComputerRecord): Promise<{ ok: boolean; error?: string }> {
    if (!existsSync(rec.workspaceRoot)) {
      mkdirSync(rec.workspaceRoot, { recursive: true });
      this.event('workspace-recovered', rec, { workspaceRoot: rec.workspaceRoot });
    }
    const st = statSync(rec.workspaceRoot);
    if (!st.isDirectory()) return { ok: false, error: `workspace root is not a directory: ${rec.workspaceRoot}` };
    return { ok: true };
  }

  async stop(id: string): Promise<ComputerOp<{ status: ComputerStatus; alreadyStopped?: boolean }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const s = this.liveOf(id, rec);

    if (s.status === 'STOPPING') return opFail('INVALID_STATE', 'stop already in progress');
    if (s.status === 'OFFLINE') return opOk({ status: 'OFFLINE', alreadyStopped: true });
    const wasPaused = s.status === 'PAUSED';

    const t = this.transition(rec, 'STOPPING', 'stop requested');
    if (t) return t;

    // Tear down runtime side effects; failures never leave a zombie STOPPING.
    if (s.preControl) { s.preControl = null; this.setToolGate(rec, false); }
    if (wasPaused) this.setToolGate(rec, false);
    s.watching = false;
    try {
      await withTimeout(
        this.deps.browser.close(id),
        rec.resourceLimits.startTimeoutMs,
        () => ({ ok: false, error: 'browser close timed out' })
      );
    } catch { /* adapter.close is best-effort */ }

    const rt = this.transition(rec, 'OFFLINE', 'stopped');
    if (rt) return rt;
    this.event('stopped', rec, {});
    return opOk({ status: 'OFFLINE' });
  }

  async pause(id: string): Promise<ComputerOp<{ status: ComputerStatus }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const t = this.transition(rec, 'PAUSED', 'pause requested');
    if (t) return t;
    this.setToolGate(rec, true);
    this.event('paused', rec, { note: 'agent tools and terminal input gated; CLI process not suspended' });
    return opOk({ status: 'PAUSED' });
  }

  async resume(id: string): Promise<ComputerOp<{ status: ComputerStatus }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const s = this.liveOf(id, rec);
    if (s.status !== 'PAUSED') return opFail('INVALID_STATE', `resume requires PAUSED (current: ${s.status})`);
    this.setToolGate(rec, false);
    const t = this.transition(rec, 'READY', 'resume requested');
    if (t) return t;
    s.lastActivityAt = this.now();
    this.event('resumed', rec, {});
    return opOk({ status: 'READY' });
  }

  async restart(id: string): Promise<ComputerOp<{ status: ComputerStatus }>> {
    const got = this.get(id); if (!got.ok) return got;
    const s = this.liveOf(id, got.value);
    if (isRunningStatus(s.status)) {
      const stopped = await this.stop(id);
      if (!stopped.ok) return stopped;
    }
    const started = await this.start(id);
    if (!started.ok) return started;
    return opOk({ status: 'READY' });
  }

  // ─── watch / control (user-only, separated from inspection) ────────────────

  async watch(id: string, on: boolean, actor: ComputerActor = USER_ACTOR): Promise<ComputerOp<{ watching: boolean }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const gate = this.requireUserOn(rec, actor); if (gate) return gate;
    const perm = this.requirePermission(id, 'screenView', actor); if (perm) return perm;
    const s = this.liveOf(id, rec);
    s.watching = on;
    if (on && this.deps.browser.status(id).open) this.deps.browser.setVisible(id, true);
    this.event('watching', rec, { watching: on });
    return opOk({ watching: on });
  }

  async takeControl(id: string, actor: ComputerActor = USER_ACTOR): Promise<ComputerOp<{ status: ComputerStatus }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const gate = this.requireUserOn(rec, actor); if (gate) return gate;
    const perm = this.requirePermission(id, 'screenControl', actor); if (perm) return perm;
    const s = this.liveOf(id, rec);
    if (s.status === 'USER_CONTROL') return opOk({ status: 'USER_CONTROL' });
    const from = s.status;
    const t = this.transition(rec, 'USER_CONTROL', 'take control');
    if (t) return t;
    s.preControl = from;
    this.setToolGate(rec, true);            // agent tools gated while user drives
    if (this.deps.browser.status(id).open) this.deps.browser.setVisible(id, true);
    this.event('control-started', rec, { from });
    return opOk({ status: 'USER_CONTROL' });
  }

  async releaseControl(id: string, actor: ComputerActor = USER_ACTOR): Promise<ComputerOp<{ status: ComputerStatus }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const gate = this.requireUserOn(rec, actor); if (gate) return gate;
    const s = this.liveOf(id, rec);
    if (s.status !== 'USER_CONTROL') return opFail('INVALID_STATE', `not in USER_CONTROL (current: ${s.status})`);
    const back = s.preControl && canTransition('USER_CONTROL', s.preControl) ? s.preControl : 'READY';
    s.preControl = null;
    const t = this.transition(rec, back, 'release control');
    if (t) return t;
    this.releaseControlGates(rec, s);
    this.event('control-ended', rec, { restored: back });
    return opOk({ status: back });
  }

  /** Pause/resume and control both gate the agent's tools via ControlRegistry. */
  private setToolGate(rec: ComputerRecord, on: boolean): void {
    try { this.deps.control?.pause(rec.agentId, on); } catch { /* control is best-effort */ }
  }

  private releaseControlGates(rec: ComputerRecord, s: LiveState): void {
    // Un-gate only if the computer itself is not PAUSED (pause keeps its gate).
    if (s.status !== 'PAUSED') this.setToolGate(rec, false);
    if (this.deps.browser.status(rec.id).open) this.deps.browser.setVisible(rec.id, s.watching);
  }

  // ─── browser ───────────────────────────────────────────────────────────────

  async openBrowser(id: string, url?: string): Promise<ComputerOp<{ open: boolean; alreadyOpen?: boolean; url: string }>> {
    const perm = this.requirePermission(id, 'browserNav', USER_ACTOR); if (perm) return perm;
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const st = this.opStateGuard(id, ['READY', 'WORKING', 'WAITING', 'USER_CONTROL']); if (st) return st;
    const s = this.liveOf(id, rec);
    const target = (url ?? rec.config.homeUrl ?? 'about:blank').trim();

    const current = this.deps.browser.status(id);
    if (current.open && !url) return opOk({ open: true, alreadyOpen: true, url: current.url ?? target });
    if (current.open && url) {
      const nav = await this.deps.browser.navigate(id, target);
      if (!nav.ok) return opFail('INTERNAL', nav.error ?? 'navigation failed');
      this.event('browser-navigated', rec, { url: target });
      return opOk({ open: true, url: target });
    }
    const res = await this.deps.browser.open(rec, target);
    if (!res.ok) {
      s.lastError = res.error ?? 'browser open failed';
      this.event('browser-error', rec, { error: s.lastError, url: target });
      return adapterFail(res, 'browser open failed');
    }
    s.lastActivityAt = this.now();
    this.event('browser-opened', rec, { url: target });
    return opOk({ open: true, url: target });
  }

  async navigate(id: string, url: string): Promise<ComputerOp<{ url: string }>> {
    const perm = this.requirePermission(id, 'browserNav', USER_ACTOR); if (perm) return perm;
    const rec = this.deps.repo.get(id); if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    const target = typeof url === 'string' ? url.trim() : '';
    if (!target) return opFail('INTERNAL', 'url is required');
    if (!this.deps.browser.status(id).open) return opFail('INVALID_STATE', 'browser is not open');
    const res = await this.deps.browser.navigate(id, target);
    if (!res.ok) {
      this.event('browser-error', rec, { error: res.error ?? 'navigation failed', url: target });
      return adapterFail(res, 'navigation failed');
    }
    this.liveOf(id, rec).lastActivityAt = this.now();
    this.event('browser-navigated', rec, { url: target });
    return opOk({ url: target });
  }

  getBrowserStatus(id: string): ComputerOp<BrowserStatusInfo> {
    const rec = this.deps.repo.get(id); if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    return opOk({ ...this.deps.browser.status(id), profileId: rec.browserProfileId });
  }

  async captureScreen(id: string, actor: ComputerActor = USER_ACTOR): Promise<ComputerOp<{ pngBase64: string; bytes: number; path: string; url?: string; title?: string; capturedAt: number }>> {
    const got = this.get(id); if (!got.ok) return got;
    const rec = got.value;
    const gate = this.requireUserOn(rec, actor); if (gate) return gate;
    const perm = this.requirePermission(id, 'screenView', actor); if (perm) return perm;
    const status = this.deps.browser.status(id);
    if (!status.open) return opFail('INVALID_STATE', 'browser is not open');

    const res = await this.deps.browser.capture(id);
    if (!res.ok || !res.png) return adapterFail(res, 'capture failed');
    const cap = rec.resourceLimits;
    if (res.png.length > cap.screenshotMaxBytes) {
      return opFail('INTERNAL', `screenshot exceeds limit (${res.png.length} > ${cap.screenshotMaxBytes} bytes)`);
    }
    const dir = join(this.rootDir, rec.id, 'screenshots');
    const capturedAt = this.now();
    const file = join(dir, `${capturedAt}.png`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, res.png);
    } catch (e) {
      return opFail('INTERNAL', `screenshot save failed: ${(e as Error).message}`);
    }
    this.liveOf(id, rec).lastActivityAt = capturedAt;
    this.event('screen-captured', rec, { path: file, bytes: res.png.length, url: status.url ?? '' });
    return opOk({
      pngBase64: res.png.toString('base64'),
      bytes: res.png.length,
      path: file,
      url: status.url,
      title: status.title,
      capturedAt,
    });
  }

  // ─── terminal association (never spawns) ───────────────────────────────────

  /**
   * Truthful capability probe for side doors that bypass the manager's own ops
   * (currently the browser session's `will-download` handler). Not an IPC
   * surface: every manager op still applies its own checks. Returns false for
   * unknown computers — fail closed.
   */
  allows(id: string, capability: 'browserDownloads' | 'network' | 'externalActions'): boolean {
    const rec = this.deps.repo.get(id);
    if (!rec) return false;
    return rec.permissions.agent[capability] === true;
  }

  getTerminalInfo(id: string): ComputerOp<TerminalInfo> {
    const rec = this.deps.repo.get(id); if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    const ptyId = this.deps.pty.ptyForAgent(rec.agentId);
    if (!ptyId) return opOk({ ptyId: null, running: false });
    const info = this.deps.pty.info(ptyId);
    return opOk({
      ptyId,
      running: !!info?.running,
      pid: info?.pid,
      cwd: info?.cwd,
      lastOutputAt: info?.lastOutputAt,
    });
  }

  /**
   * Input gate for `pty:write` (wired in index.ts). Agents WITHOUT a computer
   * always pass (backward compatible). A PAUSED/STOPPING computer refuses
   * input; `terminalExec:false` always refuses. OFFLINE allows input so the
   * restored hive flow keeps working until the computer is started.
   */
  checkTerminalAccess(agentId: string): ComputerOp {
    const rec = this.deps.repo.getByAgent(agentId);
    if (!rec) return opOk();
    const s = this.liveOf(rec.id, rec);
    if (!rec.permissions.agent.terminalExec) {
      this.event('permission-denied', rec, { capability: 'terminalExec', agentId });
      return opFail('PERMISSION_DENIED', `terminal execution is not permitted for this computer`);
    }
    if (s.status === 'PAUSED') return opFail('INVALID_STATE', 'computer is paused — resume to send input');
    if (s.status === 'STOPPING') return opFail('INVALID_STATE', 'computer is stopping');
    if (s.status === 'STARTING') return opFail('INVALID_STATE', 'computer is still starting');
    return opOk();
  }

  // ─── workspace ─────────────────────────────────────────────────────────────

  getWorkspaceInfo(id: string): ComputerOp<WorkspaceInfo> {
    const rec = this.deps.repo.get(id); if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    const exists = existsSync(rec.workspaceRoot);
    return opOk({
      workspaceId: rec.workspaceId,
      root: rec.workspaceRoot,
      exists,
      ...(exists ? { fileCount: countEntries(rec.workspaceRoot, 1000) } : {}),
    });
  }

  /**
   * Authorize an actor's access to a path INSIDE a computer's workspace.
   * Returns the canonical path (via the shared `safeResolve` policy) or a
   * structured failure. `rel` never leaves the workspace root.
   */
  async authorizeWorkspacePath(
    id: string,
    rel: string,
    actor: ComputerActor
  ): Promise<ComputerOp<{ abs: string }>> {
    const rec = this.deps.repo.get(id);
    if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);

    if (actor.kind === 'user') {
      // Local operator: user authority (same trust level as the IDE fs:* lane).
    } else if (actor.agentId === rec.agentId) {
      // Owning agent: own workspace.
    } else {
      const granted = rec.permissions.agent.crossAgentRead.includes(actor.agentId)
        || rec.permissions.agent.crossAgentWrite.includes(actor.agentId);
      if (!granted) {
        this.event('permission-denied', rec, { capability: 'crossAgentWorkspace', actor: actor.agentId });
        return opFail('PERMISSION_DENIED', `agent ${actor.agentId} has no access to workspace of computer ${id}`);
      }
    }
    const abs = await safeResolve(rec.workspaceRoot, rel);
    if (!abs) {
      return opFail('PERMISSION_DENIED', `path escapes the workspace root: ${rel}`);
    }
    return opOk({ abs });
  }

  // ─── configuration (user-only) ─────────────────────────────────────────────

  async configure(
    id: string,
    patch: {
      permissions?: {
        agent?: Partial<ComputerRecord['permissions']['agent']>;
        user?: Partial<ComputerRecord['permissions']['user']>;
      };
      persistencePolicy?: 'retain' | 'dispose';
    },
    actor: ComputerActor = USER_ACTOR
  ): Promise<ComputerOp<ComputerRecord>> {
    const rec = this.deps.repo.get(id); if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    const gate = this.requireUserOn(rec, actor); if (gate) return gate;
    if (patch?.permissions) {
      const p = patch.permissions;
      if (p.agent) rec.permissions.agent = { ...rec.permissions.agent, ...sanitizeAgentPerms(p.agent) };
      if (p.user) rec.permissions.user = { ...rec.permissions.user, ...sanitizeUserPerms(p.user) };
    }
    if (patch?.persistencePolicy === 'retain' || patch?.persistencePolicy === 'dispose') {
      rec.persistencePolicy = patch.persistencePolicy;
    }
    rec.updatedAt = this.now();
    try { this.deps.repo.update(rec); } catch (e) {
      return opFail('INTERNAL', `persist failed: ${(e as Error).message}`);
    }
    this.event('status', rec, { configured: true });
    return opOk(rec);
  }

  // ─── dispose (destructive — user-only + confirm) ───────────────────────────

  async dispose(
    id: string,
    opts: { confirm?: boolean },
    actor: ComputerActor = USER_ACTOR
  ): Promise<ComputerOp<{ removedFiles: boolean }>> {
    const rec = this.deps.repo.get(id); if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    const gate = this.requireUserOn(rec, actor); if (gate) return gate;
    if (opts?.confirm !== true) {
      return opFail('PERMISSION_DENIED', 'dispose requires explicit confirmation');
    }
    if (isRunningStatus(this.liveOf(id, rec).status)) {
      const stopped = await this.stop(id);
      if (!stopped.ok) return stopped;
    }
    const wipe = rec.persistencePolicy === 'dispose';
    try { await this.deps.browser.dispose(id, wipe); } catch { /* best-effort */ }
    if (wipe) {
      try { rmSync(join(this.rootDir, id), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    this.deps.repo.delete(id);
    this.live.delete(id);
    this.event('disposed', rec, { removedFiles: wipe });
    return opOk({ removedFiles: wipe });
  }

  // ─── reconciliation (boot) ─────────────────────────────────────────────────

  /**
   * Load-time recovery: verify workspaces, mark stale runtime state OFFLINE,
   * emit recovery events. NEVER spawns, re-opens or re-dispatches anything.
   */
  reconcile(): { loaded: number; recoveredOffline: number; workspacesRecovered: number } {
    let recoveredOffline = 0;
    let workspacesRecovered = 0;
    const rows = this.deps.repo.list();
    for (const rec of rows) {
      const s = this.freshLive(rec.status);
      this.live.set(rec.id, s);
      if (!existsSync(rec.workspaceRoot)) {
        try {
          mkdirSync(rec.workspaceRoot, { recursive: true });
          workspacesRecovered++;
          this.event('workspace-recovered', rec, { workspaceRoot: rec.workspaceRoot });
        } catch { /* reported via getWorkspaceInfo */ }
      }
      if (NON_PERSISTENT_ACROSS_RESTART.includes(rec.status)) {
        const previousStatus = rec.status;
        s.status = 'OFFLINE';
        rec.status = 'OFFLINE';
        rec.updatedAt = this.now();
        try { this.deps.repo.update(rec); } catch { /* storage best-effort */ }
        recoveredOffline++;
        this.event('recovered-offline', rec, { previousStatus });
      }
      s.lastActivityAt = this.now();
    }
    this.reconciledAt = this.now();
    this.deps.log?.({
      kind: 'computer',
      event: 'reconciled',
      loaded: rows.length,
      recoveredOffline,
      workspacesRecovered,
      ts: this.reconciledAt,
    });
    return { loaded: rows.length, recoveredOffline, workspacesRecovered };
  }

  getReconciledAt(): number | null { return this.reconciledAt; }

  // ─── derived status (real signals only) ────────────────────────────────────

  statusOf(id: string): ComputerStatus {
    const rec = this.deps.repo.get(id);
    if (!rec) return 'OFFLINE';
    return this.liveOf(id, rec).status;
  }

  getStatus(id: string): ComputerOp<ComputerStatusSnapshot> {
    const rec = this.deps.repo.get(id); if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    const s = this.liveOf(id, rec);
    return opOk({
      record: { ...rec },
      live: {
        status: s.status,
        since: s.since,
        lastError: s.lastError,
        watching: s.watching,
        controlActive: s.preControl !== null,
      },
    });
  }

  /**
   * Recompute WORKING/WAITING from real signals and apply the idle policy.
   * Called on the app's 5s tick (only while something is running) and
   * directly by tests. Returns the ids whose status changed.
   */
  statusTick(): string[] {
    const changed: string[] = [];
    const now = this.now();
    for (const rec of this.deps.repo.list()) {
      const s = this.liveOf(rec.id, rec);
      if (!['READY', 'WORKING', 'WAITING'].includes(s.status)) continue;

      const ptyId = this.deps.pty.ptyForAgent(rec.agentId);
      const idle = ptyId ? this.deps.pty.idleFor(ptyId) : undefined;
      const outputActive = idle !== undefined && idle < WORKING_OUTPUT_MS;
      const taskActive = this.deps.hasActiveTask ? this.deps.hasActiveTask(rec.agentId) : false;
      const active = outputActive || taskActive;
      if (active) s.lastActivityAt = now;

      // Real signals only: READY (freshly started, no work yet) becomes WORKING
      // on first activity; WORKING decays to WAITING when signals stop. READY
      // never degrades to WAITING on its own — an idle-but-started computer
      // stays READY ("a terminal open is not work", but no work was seen yet).
      let target: ComputerStatus | null = null;
      if (active && s.status !== 'WORKING') target = 'WORKING';
      else if (!active && s.status === 'WORKING') target = 'WAITING';

      if (!target) {
        const policy = rec.resourceLimits.sleepAfterIdleMs;
        if (policy > 0 && (s.status === 'READY' || s.status === 'WAITING') && now - s.lastActivityAt >= policy) {
          target = 'SLEEPING';
        }
      }
      if (target && canTransition(s.status, target)) {
        const t = this.transition(rec, target, target === 'SLEEPING' ? 'idle policy' : 'derived from real signals');
        if (!t) {
          changed.push(rec.id);
          if (target === 'SLEEPING') {
            void this.deps.browser.close(rec.id);
            this.event('sleeping', rec, { idleMs: now - s.lastActivityAt });
          }
        }
      }
    }
    return changed;
  }

  /** Quit-time cleanup: close every computer window (never deletes files). */
  async shutdown(): Promise<void> {
    await this.deps.browser.shutdownAll();
  }

  // ─── guards ────────────────────────────────────────────────────────────────

  /**
   * User-only op guard. Denies non-user actors WITH a truthful audit event —
   * an agent probing a side channel it must never reach is exactly the attempt
   * worth recording.
   */
  private requireUserOn(rec: ComputerRecord, actor: ComputerActor): ComputerFailOp | null {
    if (actor && actor.kind === 'user') return null;
    this.event('permission-denied', rec, { capability: 'userOnly', actor: actor?.agentId ?? 'unknown' });
    return opFail('PERMISSION_DENIED', 'this operation is restricted to the local operator');
  }

  /** Default-deny capability check (enforced here, never in the UI). */
  private requirePermission(
    id: string,
    capability: 'browserNav' | 'screenView' | 'screenControl',
    actor: ComputerActor
  ): ComputerFailOp | null {
    const rec = this.deps.repo.get(id);
    if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    if (capability === 'screenView' || capability === 'screenControl') {
      // Screen inspection/control is a USER capability; agents never get it.
      if (actor.kind !== 'user' || !rec.permissions.user[capability]) {
        this.event('permission-denied', rec, { capability, actor: actor.kind === 'agent' ? actor.agentId : 'user' });
        return opFail('PERMISSION_DENIED', `${capability} is not permitted for this computer`);
      }
      return null;
    }
    if (rec.permissions.agent[capability] !== true) {
      this.event('permission-denied', rec, { capability });
      return opFail('PERMISSION_DENIED', `permission denied: ${capability}`);
    }
    return null;
  }

  /** State guard for browser ops: computer must be running (not paused/offline). */
  private opStateGuard(id: string, allowed: ComputerStatus[]): ComputerFailOp | null {
    const rec = this.deps.repo.get(id);
    if (!rec) return opFail('NOT_FOUND', `computer not found: ${id}`);
    const s = this.liveOf(id, rec);
    if (!allowed.includes(s.status)) {
      return opFail('INVALID_STATE', `operation requires one of [${allowed.join(', ')}] (current: ${s.status})`);
    }
    return null;
  }
}

// ─── module helpers ──────────────────────────────────────────────────────────

/** Map an adapter failure to a structured op (UNSUPPORTED stays UNSUPPORTED). */
function adapterFail(res: { ok: boolean; error?: string; unsupported?: boolean }, fallback: string): ComputerOp<never> {
  if (res.unsupported) return opFail('UNSUPPORTED', res.error ?? 'operation is not supported by this runtime');
  return opFail('INTERNAL', res.error ?? fallback);
}

function countEntries(root: string, cap: number): number {
  let n = 0;
  const walk = (dir: string): void => {
    if (n >= cap) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (n >= cap) return;
      n++;
      try {
        if (statSync(join(dir, e)).isDirectory()) walk(join(dir, e));
      } catch { /* unreadable entry: counted, not recursed */ }
    }
  };
  walk(root);
  return n;
}

function sanitizeAgentPerms(p: Partial<ComputerRecord['permissions']['agent']>): Partial<ComputerRecord['permissions']['agent']> {
  const out: Partial<ComputerRecord['permissions']['agent']> = {};
  if (typeof p.terminalExec === 'boolean') out.terminalExec = p.terminalExec;
  if (typeof p.browserNav === 'boolean') out.browserNav = p.browserNav;
  if (typeof p.browserDownloads === 'boolean') out.browserDownloads = p.browserDownloads;
  if (typeof p.network === 'boolean') out.network = p.network;
  if (typeof p.externalActions === 'boolean') out.externalActions = p.externalActions;
  if (Array.isArray(p.crossAgentRead)) out.crossAgentRead = p.crossAgentRead.filter((x) => typeof x === 'string');
  if (Array.isArray(p.crossAgentWrite)) out.crossAgentWrite = p.crossAgentWrite.filter((x) => typeof x === 'string');
  return out;
}

function sanitizeUserPerms(p: Partial<ComputerRecord['permissions']['user']>): Partial<ComputerRecord['permissions']['user']> {
  const out: Partial<ComputerRecord['permissions']['user']> = {};
  if (typeof p.screenView === 'boolean') out.screenView = p.screenView;
  if (typeof p.screenControl === 'boolean') out.screenControl = p.screenControl;
  return out;
}
