/**
 * JobRunner — executes durable runs: write-ahead dispatch, timeout race,
 * exponential-backoff retries, cancellation, boot recovery, failure toasts.
 *
 * Ordering guarantee (PHASE-8-DESIGN §4), enforced here:
 *
 *   ledger.begin → ledger.markRunning → spec.beforeExec() → spec.exec()
 *
 * `beforeExec` is the write-ahead hook — the schedule stamp (`lastFiredAt`)
 * rides it so a fire that crashes mid-exec is never re-armed on reboot (the
 * old duplicate-on-crash bug). `markRunning` is persisted BEFORE the external
 * action, so recovery can distinguish "exec may have happened" (running →
 * interrupted, never re-run) from "exec never started" (queued → resume).
 *
 * All execs shipped in M3 are synchronous; async execs are supported via a
 * promise + timeout race. Settles are guarded by (state === 'running' &&
 * attempt === this attempt), so a zombie from a timed-out attempt can never
 * overwrite a newer state.
 */

import type { JobKind, JobRun, JobRunState } from '../shared/jobs';
import { DEFAULT_JOB_TIMEOUT_MS, jobBackoffMs, DEFAULT_JOB_BACKOFF_BASE_MS, DEFAULT_JOB_BACKOFF_MAX_MS } from '../shared/jobs';
import type { JobBeginInput, JobLedger } from './jobLedger';

export type JobExec = () => void | Promise<void>;

export interface JobSubmitSpec {
  jobId: string;
  kind: JobKind;
  label: string;
  payload: unknown;
  /** The external action. Throwing ⇒ a failed attempt (retryable). */
  exec: JobExec;
  /** Durable side effects that MUST land before the external action
   *  (the schedule stamp). Throwing here fails the attempt WITHOUT exec. */
  beforeExec?: () => void;
  maxAttempts?: number;
  maxRunsPerDay?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface JobSubmitResult {
  /** dispatch began (or will retry): succeeded | running | queued. */
  ok: boolean;
  runId?: string;
  state: JobRunState | null;
  error?: string;
}

export interface JobRecoverySummary {
  resumed: number;
  interrupted: number;
}

export interface JobRunnerDeps {
  ledger: JobLedger;
  now?: () => number;
  /** Timer seam — tests inject a manual queue for deterministic backoff. */
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
  /** Failure toast seam (index passes the notifications-gated native toast). */
  notify?: (title: string, body: string) => void;
  /** Renderer push seam (`jobs:updated`). */
  onChange?: () => void;
  log?: (e: unknown) => void;
}

export class JobRunner {
  private readonly ledger: JobLedger;
  private readonly now: () => number;
  private readonly scheduleFn: (fn: () => void, ms: number) => unknown;
  private readonly unscheduleFn: (handle: unknown) => void;
  private readonly notifyFn?: (title: string, body: string) => void;
  private readonly onChangeFn?: () => void;
  private readonly logFn?: (e: unknown) => void;

  /** Armed dispatch/backoff timers, keyed by run id. */
  private readonly timers = new Map<string, unknown>();
  /** Timeout handles for async execs, keyed by run id. */
  private readonly timeouts = new Map<string, unknown>();
  /** Exec specs for in-process runs (rebuilt after restart by recover()). */
  private readonly specs = new Map<string, JobSubmitSpec>();
  private recoveredOnce = false;

  constructor(deps: JobRunnerDeps) {
    this.ledger = deps.ledger;
    this.now = deps.now ?? (() => Date.now());
    this.scheduleFn = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.unscheduleFn = deps.unschedule ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.notifyFn = deps.notify;
    this.onChangeFn = deps.onChange;
    this.logFn = deps.log;
  }

  /** Begin + dispatch synchronously (event/webhook contract: the caller needs
   *  the outcome before it answers HTTP). Backoff retries run on timers. */
  submit(spec: JobSubmitSpec): JobSubmitResult {
    let begun;
    try {
      begun = this.ledger.begin(spec);
    } catch (e) {
      this.logFn?.(e);
      this.notifyFn?.('Job not recorded', `${spec.label}: ${String(e)} — not dispatched.`);
      return { ok: false, state: null, error: String(e) };
    }
    this.changed();
    if (!begun.ok) {
      // Cap refusal: recorded, visible, NOT a failure (no toast — normal operation).
      return { ok: false, runId: begun.run.id, state: 'refused', error: begun.error };
    }
    this.specs.set(begun.run.id, spec);
    const state = this.dispatch(begun.run.id);
    const row = this.ledger.get(begun.run.id);
    return {
      ok: state !== null && state !== 'failed',
      runId: begun.run.id,
      state,
      error: row?.error ?? undefined
    };
  }

  /** Record a refused run without dispatching (e.g. emergency-STOP webhook). */
  recordRefused(spec: Omit<JobSubmitSpec, 'exec' | 'beforeExec'>, error: string): string | null {
    try {
      const input: JobBeginInput = {
        jobId: spec.jobId,
        kind: spec.kind,
        label: spec.label,
        payload: spec.payload,
        maxAttempts: spec.maxAttempts,
        maxRunsPerDay: spec.maxRunsPerDay
      };
      const begun = this.ledger.beginRefused(input, error);
      this.changed();
      return begun.id;
    } catch (e) {
      this.logFn?.(e);
      return null;
    }
  }

  /** queued → cancelled (operator). Clears the armed timer; no exec runs. */
  cancel(runId: string): boolean {
    const run = this.ledger.get(runId);
    if (!run || run.state !== 'queued') return false;
    const ok = this.ledger.cancel(runId);
    if (ok) {
      this.unarm(runId);
      this.specs.delete(runId);
      this.changed();
    }
    return ok;
  }

  /** Boot sweep — call ONCE, before syncMissions() re-arms schedules.
   *  running → interrupted (+ toast, never re-run); queued → resume (immediate
   *  when attempt 0, remaining backoff otherwise). Unresolvable payloads are
   *  recorded as failed rather than left queued forever. */
  recover(resolve: (run: JobRun) => JobSubmitSpec | null): JobRecoverySummary {
    if (this.recoveredOnce) return { resumed: 0, interrupted: 0 };
    this.recoveredOnce = true;
    const { toResume, interrupted } = this.ledger.recover();
    if (interrupted.length > 0) {
      this.changed();
      for (const run of interrupted) {
        this.notifyFn?.(
          `Job interrupted: ${run.label}`,
          'The app restarted while this run was in flight — it was not re-run automatically.'
        );
      }
    }
    let resumed = 0;
    for (const run of toResume) {
      const spec = resolve(run);
      if (!spec) {
        // No executor for this payload after restart: record the truth.
        const started = this.ledger.markRunning(run.id);
        if (started) {
          this.ledger.failAttempt(run.id, 'no executor for this run after restart');
          this.changed();
        }
        continue;
      }
      this.specs.set(run.id, spec);
      const delay = run.attempt === 0 ? 0 : Math.max(0, (run.nextAt ?? 0) - this.now());
      this.arm(run.id, delay);
      resumed++;
    }
    if (resumed > 0) this.changed();
    return { resumed, interrupted: interrupted.length };
  }

  /** Clear every armed timer (quit/reset/changeHome). Rows stay queued — the
   *  next boot's recover() resumes them. Safe to call repeatedly. */
  shutdown(): void {
    for (const id of [...this.timers.keys()]) this.unarm(id);
    for (const [id, h] of [...this.timeouts]) {
      this.unscheduleFn(h);
      this.timeouts.delete(id);
    }
    this.specs.clear();
  }

  /** Armed timer count — test/observability seam. */
  get armed(): number {
    return this.timers.size;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /** queued → running → beforeExec → exec → settle. Returns the resulting
   *  state, or null if markRunning refused (cancelled meanwhile). */
  private dispatch(runId: string): JobRunState | null {
    const spec = this.specs.get(runId);
    if (!spec) return null;
    const started = this.ledger.markRunning(runId);
    this.unarm(runId); // a re-armed backoff timer has fired
    this.changed();
    if (!started) return null;
    const epoch = started.attempt;

    const current = (): boolean => {
      const cur = this.ledger.get(runId);
      return !!cur && cur.state === 'running' && cur.attempt === epoch;
    };

    const settleOk = (): void => {
      this.clearTimeout(runId);
      if (!current()) return;
      this.ledger.succeed(runId);
      this.forget(runId);
      this.changed();
    };

    const settleFail = (error: string): void => {
      this.clearTimeout(runId);
      if (!current()) return;
      if (epoch < (this.ledger.get(runId)?.maxAttempts ?? 1)) {
        const delay = jobBackoffMs(epoch, spec.backoffBaseMs, spec.backoffMaxMs);
        this.ledger.failAttempt(runId, error, { retryAt: this.now() + delay });
        this.arm(runId, delay);
        this.changed();
        return;
      }
      this.ledger.failAttempt(runId, error);
      this.forget(runId);
      this.changed();
      this.notifyFn?.(`Job failed: ${spec.label}`, truncate(error));
    };

    try {
      spec.beforeExec?.();
    } catch (e) {
      settleFail(`pre-dispatch hook failed: ${String(e)}`);
      return this.ledger.get(runId)?.state ?? null;
    }

    let result: void | Promise<void>;
    try {
      result = spec.exec();
    } catch (e) {
      settleFail(String(e instanceof Error ? e.message : e));
      return this.ledger.get(runId)?.state ?? null;
    }

    if (result && typeof (result as Promise<void>).then === 'function') {
      const h = this.scheduleFn(() => {
        this.timeouts.delete(runId);
        settleFail(`timed out after ${spec.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS}ms`);
      }, spec.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
      this.timeouts.set(runId, h);
      void (result as Promise<void>).then(settleOk, (e) =>
        settleFail(String(e instanceof Error ? e.message : e))
      );
      return this.ledger.get(runId)?.state ?? null;
    }

    settleOk();
    return this.ledger.get(runId)?.state ?? null;
  }

  private arm(runId: string, delayMs: number): void {
    this.unarm(runId);
    const h = this.scheduleFn(() => {
      this.timers.delete(runId);
      this.dispatch(runId);
    }, delayMs);
    this.timers.set(runId, h);
  }

  private unarm(runId: string): void {
    const h = this.timers.get(runId);
    if (h !== undefined) {
      this.unscheduleFn(h);
      this.timers.delete(runId);
    }
  }

  private clearTimeout(runId: string): void {
    const h = this.timeouts.get(runId);
    if (h !== undefined) {
      this.unscheduleFn(h);
      this.timeouts.delete(runId);
    }
  }

  private forget(runId: string): void {
    this.unarm(runId);
    this.clearTimeout(runId);
    this.specs.delete(runId);
  }

  private changed(): void {
    try {
      this.onChangeFn?.();
    } catch { /* renderer gone */ }
  }
}

function truncate(s: string, max = 240): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
