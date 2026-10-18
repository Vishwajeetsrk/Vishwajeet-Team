/**
 * Temp allowances for any agent (PRD-6) — the per-agent side of temps.
 *
 * Today's temps are operator-spawned (WorkersTab) or god-requested through
 * HIVE_ROOT/spawn-requests with the `orchestratorMaySpawn` toggle. This module
 * opens the same queue to ANY registered agent: an agent writes the same
 * spawn-request JSON with a `from` field naming itself, and the pool watcher
 * admits it only while this agent's allowance — 0..MAX_TEMP_ALLOWANCE temps
 * live at once — has room. 0 (the default) means the agent cannot hire temps
 * at all, so nothing changes for existing offices until the operator hands
 * out an allowance per agent.
 *
 * Pure decision logic only; index.ts owns counting live workers and persisting
 * config. The OFFICE-WIDE cap (`maxConcurrentWorkers`) is enforced by the tick
 * loop before any request is processed — by design this module never widens
 * the floor's backstop.
 */
export const MAX_TEMP_ALLOWANCE = 4;

/** Keep only well-formed allowances: an integer in [0, MAX]. */
export function normalizeTempAllowance(raw: unknown): number | undefined {
  return (
    typeof raw === 'number'
    && Number.isInteger(raw)
    && raw >= 0
    && raw <= MAX_TEMP_ALLOWANCE
  ) ? raw : undefined;
}

export interface TempSpawnProbe {
  holder: string;
  allowance: number;
  agentLiveTemps: number;
}

export interface TempSpawnDecision {
  ok: boolean;
  reason: string;
}

/** May `holder` start one more temp? Counts only temps the agent itself
 *  owns — the office-wide backstop lives in the watcher. */
export function canAgentSpawnTemp(probe: TempSpawnProbe): TempSpawnDecision {
  if (!Number.isFinite(probe.allowance) || probe.allowance <= 0) {
    return { ok: false, reason: `${probe.holder} has no temp allowance granted (0) — ask the operator for one` };
  }
  if (probe.agentLiveTemps >= probe.allowance) {
    return { ok: false, reason: `${probe.holder} already owns ${probe.agentLiveTemps} of ${probe.allowance} allowed temps` };
  }
  return { ok: true, reason: '' };
}
