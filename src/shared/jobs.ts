/**
 * Durable background jobs — shared contract (main + preload + renderer).
 *
 * One ledger, three kinds (recurring mission fires, one-time submits, event
 * dispatches), a per-run record that survives restart. Desktop-LOCAL: rows live
 * in this machine's SQLite; there is no cloud sync and no offline-continuity
 * promise beyond what the local file gives (vision §5 — labeled in the UI).
 */

export type JobKind = 'recurring' | 'one-time' | 'event';

export const JOB_KINDS: JobKind[] = ['recurring', 'one-time', 'event'];

/**
 * Run lifecycle:
 *
 *   queued ──markRunning──▶ running ──succeed──▶ succeeded
 *      │                      │────fail(attempt<max, backoff)──▶ queued(nextAt)
 *      │                      │────fail(attempt=max|timeout)───▶ failed
 *      │                      └────boot orphan─────────────────▶ interrupted
 *      ├──cancel───────────────────────────────────────────────▶ cancelled
 *      └──daily cap exceeded at begin──────────────────────────▶ refused
 *
 * Transitions are guarded (only listed edges apply); a stale settle from a
 * timed-out attempt can never overwrite a newer state.
 */
export type JobRunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'refused';

export const JOB_RUN_STATES: JobRunState[] = [
  'queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'refused'
];

/** No further automatic activity will ever happen to these. */
export const TERMINAL_JOB_STATES: JobRunState[] = [
  'succeeded', 'failed', 'interrupted', 'cancelled', 'refused'
];

/** One durable run. `payload` is JSON — enough to rebuild the executor after a
 *  restart (the recovery resolver in index.ts maps it back to a closure). */
export interface JobRun {
  id: string;
  /** Mission id / webhook endpoint id / manual id — attribution across retries. */
  jobId: string;
  kind: JobKind;
  /** Snapshot at submit time — survives mission rename/delete. */
  label: string;
  payload: string;
  state: JobRunState;
  /** 0 until the first dispatch begins; then 1..maxAttempts. */
  attempt: number;
  maxAttempts: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Backoff target while re-queued after a failed attempt. */
  nextAt: number | null;
}

export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
/** Event dispatches (webhook HTTP exchange already consumed) never auto-retry. */
export const EVENT_JOB_MAX_ATTEMPTS = 1;
export const DEFAULT_JOB_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_BACKOFF_BASE_MS = 2_000;
export const DEFAULT_JOB_BACKOFF_MAX_MS = 60_000;
/** Absent/0 ⇒ unlimited (the shipped default for existing missions). */
export const DEFAULT_JOB_MAX_RUNS_PER_DAY = 0;

/** Exponential backoff for the attempt that just failed (1-based), capped. */
export function jobBackoffMs(
  attempt: number,
  base: number = DEFAULT_JOB_BACKOFF_BASE_MS,
  max: number = DEFAULT_JOB_BACKOFF_MAX_MS
): number {
  const exp = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exp, max);
}

/** Local start-of-day — the day boundary for `maxRunsPerDay` caps. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
