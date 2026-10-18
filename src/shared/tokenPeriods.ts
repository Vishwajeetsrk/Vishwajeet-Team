/**
 * Token limits per TIME PERIOD (PRD-5) — the replacement for one-off caps.
 *
 * Upstream removed plain token caps in favor of period buckets: every 5 hours,
 * daily, weekly, monthly — for the office and for each agent. The old caps in
 * this codebase (costCapTokens / agentTokenCaps) keep working; the period layer
 * sits ON TOP of them, so every existing contract test and config stays valid
 * and the periods are additive enforcement.
 *
 * All bounds are computed with the machine's LOCAL clock: a day is local
 * midnight to midnight, a week starts Monday 00:00 local (ISO convention), a
 * month starts the 1st at 00:00 local, and "every 5 hours" is a ROLLING window
 * (now−5h → now), not a clock-aligned one, because a rolling window cannot
 * reward running at 12:59 rather than 13:01.
 */

export type TokenPeriod = '5h' | 'day' | 'week' | 'month';

export const TOKEN_PERIODS: readonly TokenPeriod[] = ['5h', 'day', 'week', 'month'];

export const TOKEN_PERIOD_LABELS: Record<TokenPeriod, string> = {
  '5h': 'every 5 hours',
  day: 'daily',
  week: 'weekly',
  month: 'monthly'
};

/** Per-target period ceilings (positive integers, tokens per window). */
export interface PeriodCaps {
  '5h'?: number;
  day?: number;
  week?: number;
  month?: number;
}

/** Office-wide + per-agent period caps. Agents are keyed by agent id. */
export interface TokenPeriodCapsCfg {
  office?: PeriodCaps;
  agents?: Record<string, PeriodCaps>;
}

/** The epoch-ms instant the window covering `nowMs` began: local day/week/month
 *  boundaries, or a rolling 5h window, as described in the module header. */
export function periodWindowStartMs(period: TokenPeriod, nowMs: number): number {
  const d = new Date(nowMs);
  switch (period) {
    case '5h':
      return nowMs - 5 * 60 * 60 * 1000;
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case 'week': {
      // Monday-start local week: day 0 = Sunday, so (day+6)%7 gives days since Monday.
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      return monday.getTime();
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }
}

/** The only counting carried across the ledger: WORK tokens (see breaker.ts
 *  #189) — the header sent every request still burns money even when cache reads
 *  dominate, so it deliberately excludes cacheRead. */
export function workTokensOfRow(row: { input: number; output: number; cache_creation?: number | null }): number {
  return (row.input || 0) + (row.output || 0) + (row.cache_creation || 0);
}

export function isUnknownPeriod(p: unknown): p is TokenPeriod {
  return typeof p === 'string' && p in TOKEN_PERIOD_LABELS;
}

/** Validate one tokens value the same way setAgentTokenCap does: null/undefined
 *  clears the cap, otherwise a positive integer up to the global ceiling. */
export function validatePeriodTokens(tokens: unknown): tokens is number | null | undefined {
  if (tokens === undefined || tokens === null) return true;
  return (
    typeof tokens === 'number'
    && Number.isInteger(tokens)
    && tokens > 0
    && tokens <= 10_000_000_000
  );
}

/** Read-modify-write helper for JSON-merging one target's period caps: returns
 *  a NEW TokenPeriodCapsCfg with target's `period` set to tokens (or deleted
 *  when tokens is null/undefined). Pure — callers own the persistence. */
export function mergePeriodCap(
  caps: TokenPeriodCapsCfg,
  target: 'office' | string,
  period: TokenPeriod,
  tokens: number | null | undefined
): TokenPeriodCapsCfg {
  if (target === 'office') {
    const office = { ...(caps.office ?? {}) };
    if (tokens === null || tokens === undefined) delete office[period];
    else office[period] = tokens;
    return { ...caps, office };
  }
  const agents = { ...(caps.agents ?? {}) };
  const per = { ...(agents[target] ?? {}) };
  if (tokens === null || tokens === undefined) delete per[period];
  else per[period] = tokens;
  if (Object.keys(per).length === 0) delete agents[target];
  else agents[target] = per;
  return { ...caps, agents };
}
