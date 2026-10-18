/**
 * handoff.md — the bridge across a work-switch (PRD-7 piece 2).
 *
 * When an agent moves from one piece of work to another (a new conversation
 * carrying a request) while its context window is meaningfully full, the
 * operator-visible behavior should match what measured best upstream: instead
 * of silently replaying an entire old mega-conversation into the new task,
 * the terminal's context is cleared and ONE summary file carries
 * the distilled state across the switch.
 *
 * The app cannot summarize the session itself (the transcript belongs to the
 * CLI), and it does not have to: everything durable about the previous work —
 * its subject, its requester, the task board (tasks.json), the agent's own
 * memory (memory.md), the branch and worktree — already lives in durable
 * files on disk. The handoff file therefore POINTS at them rather than
 * re-copying them, written at the moment of the switch so the next session
 * knows exactly where it left off and which parts of context were dropped.
 *
 * Pure text/decision builders only: main writes the file, the renderer makes
 * the decision and orders the clear. Everything here is dependency-free so
 * both sides + tests can load it.
 */

export interface HandoffInfo {
  agentId: string;
  agentName?: string;
  role?: string;
  cwd?: string;
  /** The work being switched FROM (the previous conversation). */
  prevConversation?: string;
  prevSubject?: string;
  prevFrom?: string;
  /** The work being switched TO. */
  conversation?: string;
  subject?: string;
  from?: string;
  /** Measured context fill at the moment of the switch (0-100), when known. */
  contextPct?: number;
  /** The verb actually used to clear the CLI, or null when its provider has
   *  no safe clear (the handoff still records what the old thread held). */
  clearVerb?: string | null;
  at?: number;
}

/** Render the handoff document. Deterministic, markdown, no timestamps in the
 *  prose body (they are in the YAML-ish header instead) so fixtures stay
 *  stable across timezones. */
export function handoffDoc(info: HandoffInfo): string {
  const name = info.agentName ?? info.agentId;
  const at = info.at ?? Date.now();
  const lines: string[] = [];
  lines.push(`# Handoff for ${name} (${info.agentId})`);
  lines.push('');
  lines.push(`- Time: ${new Date(at).toISOString()}`);
  if (info.contextPct !== undefined && Number.isFinite(info.contextPct)) {
    lines.push(`- Context fill at the switch: ${Math.round(info.contextPct)}%`);
  }
  if (info.role) lines.push(`- Role: ${info.role}`);
  if (info.cwd) lines.push(`- Workspace: ${info.cwd}`);
  lines.push(`- Cleared with: ${info.clearVerb ?? 'nothing (provider has no safe clear verb)'}`);
  lines.push('');
  lines.push('## Previous work');
  if (info.prevSubject || info.prevConversation) {
    lines.push(`- Task: ${info.prevSubject ?? '(unlabeled)'}`);
    if (info.prevConversation) lines.push(`- Conversation: ${info.prevConversation}`);
    if (info.prevFrom) lines.push(`- Dispatched by: ${info.prevFrom}`);
  } else {
    lines.push('- No prior dispatched task recorded for this session.');
  }
  lines.push('');
  lines.push('## New work');
  if (info.conversation) lines.push(`- New conversation: ${info.conversation}`);
  if (info.subject) lines.push(`- New task: ${info.subject}`);
  if (info.from) lines.push(`- Dispatched by: ${info.from}`);
  lines.push('');
  lines.push('## Carried state (durable, not lost with the terminal)');
  lines.push('- Task board: tasks.json in the hive root (look for ' + `${name} as assignee).`);
  lines.push('- Your own notes: memory.md in your agent folder');
  lines.push('- The previous conversation remains readable in the CLI\'s own session history; this file does not replace it, it just marks where the switch happened.');
  lines.push('');
  lines.push('Treat anything above the switch point as context you chose to drop. If the new task depends on conclusions from the previous work, they live in tasks.json, memory.md, or committed files — not in your head.');
  return lines.join('\n') + '\n';
}

export interface SwitchProbe {
  /** The saved clear rule (its `enabled` + pressure bars are consulted). */
  rule: { enabled?: boolean; minContextPct?: number; minContextPctLargeWindow?: number };
  /** Exact context readings when available; otherwise agent store values. */
  tokens?: number;
  limit?: number;
  /** Last conversation this agent was dispatched into (undefined = nothing yet). */
  prevConversation?: string;
  /** The conversation the arriving work belongs to. */
  nextConversation?: string;
}

export interface SwitchDecision {
  /** A switch happened (new work in a different conversation). */
  handoff: boolean;
  /** ALSO clear the terminal's context (needs the CLI to have a clear verb). */
  clear: boolean;
  reason: string;
}

/** Decide whether arriving terminal work constitutes a switch that warrants a
 *  handoff (and, when possible, a clear). A switch needs BOTH a previous
 *  conversation on record AND a different incoming one — the first dispatch of
 *  a fresh session is arrival, not switching. Everything else fails safe to
 *  plain delivery. */
export function workSwitchDecision(probe: SwitchProbe): SwitchDecision {
  const same = probe.nextConversation !== undefined && probe.nextConversation === probe.prevConversation;
  if (!probe.prevConversation || same) {
    return { handoff: false, clear: false, reason: 'no prior conversation on this terminal (or the same one is continuing)' };
  }
  if (probe.rule?.enabled !== true) {
    return { handoff: true, clear: false, reason: 'clear rule disabled — handoff file only' };
  }
  const limit = probe.limit ?? 0;
  const large = limit >= 500_000;
  const bar = large ? (probe.rule.minContextPctLargeWindow ?? 0) : (probe.rule.minContextPct ?? 0);
  const pct = (probe.tokens !== undefined && Number.isFinite(probe.tokens) && limit > 0)
    ? (probe.tokens / limit) * 100
    : null;
  if (pct === null) {
    // No reading: clearing would drop state nobody can measure. Handoff still
    // documents the switch; the old context stays until something measurable
    // says it is worth dropping.
    return { handoff: true, clear: false, reason: 'no context reading — handoff file only' };
  }
  if (!(bar > 0) || pct < bar) {
    return { handoff: true, clear: false, reason: `context at ${Math.round(pct)}% is under the clear bar (${bar}%)` };
  }
  return { handoff: true, clear: true, reason: `context at ${Math.round(pct)}% crossed the ${bar}% clear bar on a conversation switch` };
}
