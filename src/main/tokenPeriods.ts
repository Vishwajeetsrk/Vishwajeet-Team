/**
 * Token accounting per TIME PERIOD (PRD-5).
 *
 * The existing cost ledger (`<hive>/cost-ledger.jsonl`) stores CUMULATIVE
 * per-(agent, session) totals on every appended row. This module folds the same
 * file incrementally — the exact incremental pattern of costLifetime.ts — and
 * converts those cumulative rows into per-agent increments bucketed by HOUR, so
 * that any period window (rolling 5h, local day/week/month) can be summed in
 * constant-ish time without re-reading an unbounded ledger.
 *
 * Attribution rules (documented, conservative):
 *  - Δ is attributed to the timestamp of the row that PRODUCED it.
 *  - The first observation of a (agent, session) pair is a BASELINE, not gain:
 *    cumulative counters may already cover tokens spent before this app run.
 *  - A cumulative DECREASE is the process-restart signature (same shape
 *    costLifetime.ts folds for lifetime usd). The drop is attributed at the
 *    PREVIOUS row's ts — those tokens were burned before that instant — and the
 *    counter re-baselines at the new, lower value.
 *  - Buckets are hour-aligned, so a window's boundary hour is counted WHOLE.
 *    This can overcount by up to one hour of activity at the window edge —
 *    overcounting makes a cap trip EARLY, which is the safe direction for a
 *    budget guard.
 *  - An idle agent appends nothing (the #56 duplicate gate), so the bucket map
 *    only holds real activity.
 *
 * Buckets are pruned past a 35-day hold (a month window can never reach back
 * further), so memory stays bounded regardless of ledger size.
 */

import { createReadStream, statSync } from 'fs';
import {
  TOKEN_PERIODS, type TokenPeriod, periodWindowStartMs
} from '../shared/tokenPeriods';

/** Keep 35 days: a month window can never reach back further. */
const HOLD_MS = 35 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Cap per pass so a cold start cannot stall behind one enormous read. */
const MAX_BYTES_PER_PASS = 8 * 1024 * 1024;

interface CumRow {
  input: number;
  output: number;
  cache_creation: number;
}

export class TokenPeriodLedger {
  private offset = 0;
  private tail: Buffer = Buffer.alloc(0);
  /** `agent\tsession` → last cumulative work-relevant counters. */
  private lastCum = new Map<string, CumRow & { ts: number }>();
  /** agentId → (epoch-hour → work tokens burned in that hour). */
  private hours = new Map<string, Map<number, number>>();
  /** One pass at a time; never stack folds. */
  private folding = false;
  private warm = false;

  constructor(private ledgerPath: () => string | null) {}

  get ready(): boolean {
    return this.warm;
  }

  /** Fold whatever was appended since the last pass. Never throws. */
  refresh(): Promise<void> {
    if (this.folding) return Promise.resolve();
    const path = this.ledgerPath();
    if (!path) return Promise.resolve();
    this.folding = true;
    return new Promise<void>((resolve) => {
      try {
        void this.fold(path).finally(() => { this.folding = false; resolve(); });
      } catch {
        this.folding = false;
        resolve();
      }
    });
  }

  /** Kick a full catch-up (first load after boot). */
  async refreshFully(): Promise<void> {
    for (let i = 0; i < 4096; i++) {
      await this.refresh();
      if (this.warm) return;
    }
  }

  private async fold(path: string): Promise<void> {
    let size: number;
    try { size = statSync(path).size; } catch { return; }
    if (size < this.offset) { this.reset(); }
    if (size === this.offset) { this.warm = true; return; }
    const end = Math.min(size, this.offset + MAX_BYTES_PER_PASS) - 1;
    const from = this.offset;
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path, { start: from, end });
      stream.on('data', (chunk: string | Buffer) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        this.consume(buf);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });
    this.offset = end + 1;
    this.pruneBuckets();
    if (this.offset >= size) this.warm = true;
  }

  private consume(chunk: Buffer): void {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const cut = buf.lastIndexOf(0x0a);
    if (cut === -1) { this.tail = buf; return; }
    this.tail = buf.subarray(cut + 1);
    for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
      if (line) this.foldLine(line);
    }
  }

  private foldLine(line: string): void {
    let row: {
      agent_id?: string; session_id?: string; ts?: number;
      input?: number; output?: number; cache_creation?: number; usd?: number;
    };
    try { row = JSON.parse(line); } catch { return; }
    if (!row || typeof row.agent_id !== 'string') return;
    if (!(typeof row.ts === 'number') || !Number.isFinite(row.ts)) return;
    const work = TokenPeriodLedger.cumWork(row);
    const key = `${row.agent_id}\t${row.session_id ?? ''}`;
    const prev = this.lastCum.get(key);
    const laid = {
      input: row.input ?? 0, output: row.output ?? 0,
      cache_creation: row.cache_creation ?? 0, ts: row.ts
    };
    if (!prev) {
      // Baseline: the cumulative counter may cover tokens burned before this
      // app run started folding; those are not new work. No gain is produced —
      // only what later rows ADD on top of the baseline is.
      this.lastCum.set(key, laid);
      return;
    }
    if (work < TokenPeriodLedger.cumWork(prev) - 1e-9) {
      // Cumulative went DOWN: the app-restart/rebase signature. Everything the
      // pre-reset counter held was already credited by earlier Δ rows, so a
      // drop credits nothing — re-baseline at the lower number or future rows
      // would credit the tail twice.
      this.lastCum.set(key, laid);
      return;
    }
    const gain = work - TokenPeriodLedger.cumWork(prev);
    if (gain > 0) this.bump(row.agent_id!, row.ts, gain);
    this.lastCum.set(key, laid);
  }

  /** Cumulative work tokens (input+output+cache_creation) of a ledger row. */
  private static cumWork(row: { input?: number; output?: number; cache_creation?: number }): number {
    return (row.input ?? 0) + (row.output ?? 0) + (row.cache_creation ?? 0);
  }

  private bump(agentId: string, ts: number, work: number): void {
    if (!(work > 0)) return;
    let per = this.hours.get(agentId);
    if (!per) { per = new Map(); this.hours.set(agentId, per); }
    const bucket = Math.floor(ts / HOUR_MS);
    per.set(bucket, (per.get(bucket) ?? 0) + work);
  }

  private pruneBuckets(): void {
    // Only prune when the map gets big; the check itself is cheap and the
    // steady-state map is either small or pruned by this.
    for (const [, per] of this.hours) {
      if (per.size <= 900) continue;
      const floor = Math.floor((Date.now() - HOLD_MS) / HOUR_MS);
      for (const b of per.keys()) {
        if (b < floor) per.delete(b);
      }
    }
  }

  /** Work tokens burned by one agent (agentId) or the whole office (null)
   *  inside the named period's window. Falls back to null while the ledger
   *  has never been folded — callers must not treat "no data" as zero. */
  usageIn(period: TokenPeriod, agentId: string | null, nowMs: number): number | null {
    if (!this.warm) return null;
    const start = periodWindowStartMs(period, nowMs);
    const floorBucket = Math.floor(start / HOUR_MS);
    let total = 0;
    const agents = agentId === null ? [...this.hours.keys()] : [agentId];
    for (const a of agents) {
      const per = this.hours.get(a);
      if (!per) continue;
      for (const [bucket, work] of per) {
        if (bucket >= floorBucket) total += work;
      }
    }
    return total;
  }

  /** Snapshot for the UI: every period's used figure for office + each agent. */
  snapshot(nowMs: number): {
    ready: boolean;
    office: Record<TokenPeriod, number>;
    agents: Record<string, Record<TokenPeriod, number>>;
  } {
    const office = {} as Record<TokenPeriod, number>;
    const agents: Record<string, Record<TokenPeriod, number>> = {};
    for (const p of TOKEN_PERIODS) office[p] = this.usageIn(p, null, nowMs) ?? 0;
    for (const a of this.hours.keys()) {
      agents[a] = {} as Record<TokenPeriod, number>;
      for (const p of TOKEN_PERIODS) agents[a][p] = this.usageIn(p, a, nowMs) ?? 0;
    }
    return { ready: this.ready, office, agents };
  }

  /** One-shot fold for tests: fold the full text and return the instance. */
  static fromText(text: string): TokenPeriodLedger {
    const t = new TokenPeriodLedger(() => null);
    const body = text.endsWith('\n') ? text : `${text}\n`;
    t.consume(Buffer.from(body));
    t.warm = true;
    return t;
  }

  private reset(): void {
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.lastCum.clear();
    this.hours.clear();
    this.warm = false;
  }
}
