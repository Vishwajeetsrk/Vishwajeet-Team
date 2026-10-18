/**
 * PRD-8 — richer agent files (identity.md "Limits & allowances").
 *
 * Upstream's identity.md told an agent WHO it is (role, capabilities, cwd, dir
 * layout) but stayed silent about OUR lifetime guardrails — the token caps,
 * period budgets and temp allowances from PRD-5/6, and the durable files the
 * agent should treat as the board of record. We append ONE section to the same
 * file at spawn so the agent reads it once and understands both the limits and
 * the durable state, instead of learning every cap only when a cap trips.
 *
 * Pure builders, no imports — hive.ts (main) and the tests both use them.
 */

export interface AgentLimitsSnapshot {
  /** Session hard-stop (config.costCapTokens) — office-wide. */
  officeTokenCap?: number;
  /** Session hard-stop override for THIS agent (config.agentTokenCaps[id]). */
  tokenCap?: number;
  /** Period budget layer (config.tokenPeriodCaps): office + this agent. */
  officePeriodCaps?: { '5h'?: number; day?: number; week?: number; month?: number };
  periodCaps?: { '5h'?: number; day?: number; week?: number; month?: number };
  /** Live temps this agent may hold at once (config.tempAllowances[id]). */
  tempAllowance?: number;
  /** god-only: the office-wide worker ceilings. */
  maySpawnTemps?: boolean;
  maxWorkers?: number;
}

const n = (v: number | undefined): string =>
  typeof v === 'number' && v > 0 ? v.toLocaleString('en-US') : '—';

const periodRow = (caps: { '5h'?: number; day?: number; week?: number; month?: number } | undefined): string =>
  caps ? `5h ${n(caps['5h'])} / day ${n(caps.day)} / week ${n(caps.week)} / month ${n(caps.month)}` : '—';

/** The appended identity.md section. Always ends with the durable-state pointer,
 *  because an agent that reads no limits at all should still know where the
 *  board of record lives and that a work switch leaves it a handoff.md. */
export function limitsSection(l: AgentLimitsSnapshot | undefined, isGod?: boolean): string[] {
  const rows: string[] = [];
  if (l) {
    if (typeof l.tokenCap === 'number' && l.tokenCap > 0) {
      rows.push(`- Session token cap (yours): ${n(l.tokenCap)}`);
    } else if (typeof l.officeTokenCap === 'number' && l.officeTokenCap > 0) {
      rows.push(`- Session token cap (office default): ${n(l.officeTokenCap)}`);
    }
    if (l.periodCaps) rows.push(`- Period token caps (yours): ${periodRow(l.periodCaps)}`);
    else if (l.officePeriodCaps) rows.push(`- Period token caps (office default): ${periodRow(l.officePeriodCaps)}`);
    if (typeof l.tempAllowance === 'number' && l.tempAllowance > 0) {
      rows.push(`- Live temp allowance: up to ${l.tempAllowance} temps, spawned in your name`);
    }
    if (isGod && l.maxWorkers) rows.push(`- Office worker ceiling: at most ${n(l.maxWorkers)} live worker terminals`);
    if (isGod && !l.maySpawnTemps) rows.push('- Temporary worker spawning is currently disabled for you on the controls panel');
  }
  rows.push('- Durable state lives next to you: memory.md (append facts), ../tasks.json (the board of record), ../board.md, and — after a work switch — handoff.md in this folder');
  return rows;
}

/** Full markdown body for the appended block (headers included, trailing newline). */
export function identityLimitsBlock(l: AgentLimitsSnapshot | undefined, isGod?: boolean): string {
  const rows = limitsSection(l, isGod);
  return ['', '## Limits & durable state', '', ...rows, ''].join('\n');
}
