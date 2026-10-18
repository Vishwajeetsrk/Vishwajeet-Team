/**
 * JobLedger — the durable state machine over a JobRepo.
 *
 * Everything here is synchronous: better-sqlite3 is synchronous and node is
 * single-threaded, so every check-then-update below is atomic with respect to
 * other ledger calls (no await can interleave). That is what lets the
 * write-ahead order of §4 in PHASE-8-DESIGN.md hold without transactions:
 *
 *   begin() → markRunning() → [beforeExec hook] → exec() → succeed/fail
 *
 * with `markRunning` persisted BEFORE the external action and the schedule
 * stamp riding the `beforeExec` hook — a crash anywhere leaves a row whose
 * recovery action (resume vs interrupted) never duplicates the effect.
 */

import type { JobKind, JobRun, JobRunState } from '../shared/jobs';
import {
  DEFAULT_JOB_MAX_ATTEMPTS,
  DEFAULT_JOB_MAX_RUNS_PER_DAY,
  startOfLocalDay
} from '../shared/jobs';
import type { JobListFilter, JobRepo } from './jobStore';

export interface JobLedgerDeps {
  repo: JobRepo;
  now?: () => number;
  /** Id mint for run ids — injectable for tests. */
  mint?: (prefix: string) => string;
}

export interface JobBeginInput {
  jobId: string;
  kind: JobKind;
  label: string;
  /** Structured exec arguments — JSON-serialized into the run row. */
  payload: unknown;
  maxAttempts?: number;
  /** 0/absent ⇒ unlimited (default). */
  maxRunsPerDay?: number;
}

export type JobBeginResult =
  | { ok: true; run: JobRun }
  /** Cap exceeded (or other refusal): the run IS recorded, exec must not run. */
  | { ok: false; run: JobRun; error: string };

export interface JobRecoveryResult {
  /** Queued rows whose exec never started (or whose backoff elapsed) — safe to
   *  dispatch: exactly-once is preserved because exec only ever ran 0 times. */
  toResume: JobRun[];
  /** Running rows from the previous process — effect unknown, NEVER re-run. */
  interrupted: JobRun[];
}

export class JobLedger {
  private readonly repo: JobRepo;
  private readonly now: () => number;
  private readonly mint: (prefix: string) => string;
  private mintN = 0;

  constructor(deps: JobLedgerDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => Date.now());
    this.mint =
      deps.mint ?? ((prefix) => `${prefix}-${Date.now().toString(36)}-${(++this.mintN).toString(36)}`);
  }

  /** Write-ahead intent. Caps are checked here — over cap ⇒ a `refused` row is
   *  recorded (visible history) and the caller must NOT dispatch. */
  begin(input: JobBeginInput): JobBeginResult {
    const now = this.now();
    const maxPerDay = input.maxRunsPerDay ?? DEFAULT_JOB_MAX_RUNS_PER_DAY;
    if (maxPerDay > 0) {
      const used = this.repo.countSince(input.jobId, startOfLocalDay(now));
      if (used >= maxPerDay) {
        const error = `daily cap exceeded (${used}/${maxPerDay} runs today)`;
        const run = this.mkRun(input, now, { state: 'refused', error });
        this.repo.insert(run);
        return { ok: false, run, error };
      }
    }
    const run = this.mkRun(input, now, { state: 'queued' });
    this.repo.insert(run);
    return { ok: true, run };
  }

  /** Record a terminal refusal without dispatching (emergency STOP, operator
   *  policy). Same durable row as a cap refusal — visible history, no exec. */
  beginRefused(input: JobBeginInput, error: string): JobRun {
    const run = this.mkRun(input, this.now(), { state: 'refused', error });
    this.repo.insert(run);
    return run;
  }

  /** queued → running (attempt++). The durable line before any external effect. */
  markRunning(id: string): JobRun | null {
    const r = this.repo.get(id);
    if (!r || r.state !== 'queued') return null;
    this.repo.update(id, {
      state: 'running',
      attempt: r.attempt + 1,
      startedAt: this.now(),
      nextAt: null,
      error: null
    });
    return this.repo.get(id);
  }

  /** running → succeeded. No-op on any other state (stale settle guard). */
  succeed(id: string): boolean {
    const r = this.repo.get(id);
    if (!r || r.state !== 'running') return false;
    this.repo.update(id, { state: 'succeeded', finishedAt: this.now(), nextAt: null, error: null });
    return true;
  }

  /** running → queued(nextAt) when attempts remain, else → failed.
   *  No-op on any other state (a cancelled/timed-out-overridden run is never
   *  resurrected by a late settle). */
  failAttempt(id: string, error: string, opts?: { retryAt?: number }): JobRunState | null {
    const r = this.repo.get(id);
    if (!r || r.state !== 'running') return null;
    const retry = opts?.retryAt !== undefined && r.attempt < r.maxAttempts;
    if (retry) {
      this.repo.update(id, { state: 'queued', error, nextAt: opts?.retryAt ?? null });
      return 'queued';
    }
    this.repo.update(id, { state: 'failed', error, finishedAt: this.now(), nextAt: null });
    return 'failed';
  }

  /** queued → cancelled (operator). Running runs are not cancellable — their
   *  dispatch is a synchronous local action that has already begun. */
  cancel(id: string): boolean {
    const r = this.repo.get(id);
    if (!r || r.state !== 'queued') return false;
    this.repo.update(id, { state: 'cancelled', finishedAt: this.now(), nextAt: null, error: r.error });
    return true;
  }

  /** Boot sweep. running → interrupted (effect unknown — the no-duplicate
   *  guarantee lives here); queued rows are returned untouched for the runner
   *  to re-dispatch or re-arm. */
  recover(): JobRecoveryResult {
    const toResume: JobRun[] = [];
    const interrupted: JobRun[] = [];
    const now = this.now();
    for (const run of this.repo.live()) {
      if (run.state === 'running') {
        this.repo.update(run.id, {
          state: 'interrupted',
          error: run.error ?? 'app restarted while this run was in flight — not re-run automatically',
          finishedAt: now,
          nextAt: null
        });
        interrupted.push({ ...run, state: 'interrupted' });
      } else {
        toResume.push(run);
      }
    }
    return { toResume, interrupted };
  }

  get(id: string): JobRun | null {
    return this.repo.get(id);
  }

  list(filter?: JobListFilter): JobRun[] {
    return this.repo.list(filter);
  }

  private mkRun(
    input: JobBeginInput,
    now: number,
    init: { state: JobRunState; error?: string }
  ): JobRun {
    let payload: string;
    try {
      payload = JSON.stringify(input.payload ?? null);
    } catch {
      payload = JSON.stringify({ unserializable: true });
    }
    return {
      id: this.mint('run'),
      jobId: input.jobId,
      kind: input.kind,
      label: input.label,
      payload,
      state: init.state,
      attempt: 0,
      maxAttempts: Math.max(1, input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS),
      error: init.error ?? null,
      createdAt: now,
      startedAt: null,
      finishedAt: init.state === 'refused' ? now : null,
      nextAt: null
    };
  }
}
