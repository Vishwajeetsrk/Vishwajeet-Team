/**
 * Job ledger persistence seam.
 *
 * `JobLedger` depends on this interface only. Production wiring passes
 * `SqliteJobRepo` (SQLite, migration 4 — src/main/db.ts), which structurally
 * implements `JobRepo`. Unit tests pass `MemoryJobRepo`, because
 * better-sqlite3 is built for the Electron ABI (upstream postinstall runs
 * `electron-rebuild -f`) and plain node cannot load it — the same reason no
 * upstream test imports db.ts.
 *
 * Restart modeling: `serialize()` / `MemoryJobRepo.from()` round-trips every
 * row so a test can stand up a fresh ledger "after a relaunch" over the same
 * durable state.
 */

import type { JobRun } from '../shared/jobs';

export interface JobListFilter {
  /** Only runs attributed to this job. */
  jobId?: string;
  /** Newest-first cap (default 100, clamped to 1000 by implementations). */
  limit?: number;
}

export interface JobRepo {
  insert(run: JobRun): void;
  get(id: string): JobRun | null;
  /** Shallow patch of the row with `id`; unknown id is a no-op. */
  update(id: string, patch: Partial<JobRun>): void;
  /** Newest-first. */
  list(filter?: JobListFilter): JobRun[];
  /** Rows for `jobId` created at/after `since` — the daily-cap counter. */
  countSince(jobId: string, since: number): number;
  /** Every row still `queued` or `running`, oldest first — the recovery set. */
  live(): JobRun[];
}

/**
 * In-memory repo for tests. Rows are deep-copied at the boundary so a test
 * holding a snapshot can't observe in-place mutation.
 */
export class MemoryJobRepo implements JobRepo {
  private rows = new Map<string, JobRun>();

  constructor(initial?: Iterable<JobRun>) {
    for (const run of initial ?? []) this.rows.set(run.id, { ...run });
  }

  insert(run: JobRun): void {
    this.rows.set(run.id, { ...run });
  }

  get(id: string): JobRun | null {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  update(id: string, patch: Partial<JobRun>): void {
    const r = this.rows.get(id);
    if (!r) return;
    Object.assign(r, patch);
  }

  list(filter?: JobListFilter): JobRun[] {
    let all = [...this.rows.values()];
    if (filter?.jobId) all = all.filter((r) => r.jobId === filter.jobId);
    all.sort((a, b) => b.createdAt - a.createdAt || (b.id > a.id ? 1 : -1));
    const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 1000);
    return all.slice(0, limit).map((r) => ({ ...r }));
  }

  countSince(jobId: string, since: number): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.jobId === jobId && r.createdAt >= since) n++;
    }
    return n;
  }

  live(): JobRun[] {
    return [...this.rows.values()]
      .filter((r) => r.state === 'queued' || r.state === 'running')
      .sort((a, b) => a.createdAt - b.createdAt || (a.id > b.id ? 1 : -1))
      .map((r) => ({ ...r }));
  }

  /** JSON snapshot of every row — the "disk" half of a modeled restart. */
  serialize(): string {
    return JSON.stringify([...this.rows.values()]);
  }

  static from(json: string): MemoryJobRepo {
    try {
      const rows = JSON.parse(json);
      return new MemoryJobRepo(Array.isArray(rows) ? rows : []);
    } catch {
      return new MemoryJobRepo();
    }
  }
}
