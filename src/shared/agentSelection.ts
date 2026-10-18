export interface AgentCandidate {
  id: string;
  name: string;
  role: string;
  skills: string[];
  tools: string[];
  status: string;
  currentTaskId: string | null;
  permissions: string[];
}

export interface TaskRequirements {
  roles?: string[];
  skills?: string[];
  tools?: string[];
  requiredPermissions?: string[];
}

export interface AgentSelectionResult {
  selected: AgentCandidate | null;
  reason: string;
  alternatives: AgentCandidate[];
}

export function selectAgentForTask(
  agents: AgentCandidate[],
  requirements: TaskRequirements
): AgentSelectionResult {
  const available = agents.filter((a) => a.status === "idle" && !a.currentTaskId);

  if (available.length === 0) {
    return { selected: null, reason: "No available agents", alternatives: [] };
  }

  const scored = available.map((agent) => ({
    agent,
    score: scoreAgent(agent, requirements),
  }));

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const alternatives = scored.slice(1, 5).map((s) => s.agent);

  const hasConstraints =
    (requirements.roles?.length ?? 0) > 0 ||
    (requirements.skills?.length ?? 0) > 0 ||
    (requirements.tools?.length ?? 0) > 0 ||
    (requirements.requiredPermissions?.length ?? 0) > 0;

  if (best.score === 0 && hasConstraints) {
    return {
      selected: null,
      reason: "No agent matches requirements",
      alternatives,
    };
  }

  return {
    selected: best.agent,
    reason: `Best match: role=${best.agent.role}, score=${best.score}`,
    alternatives,
  };
}

function scoreAgent(agent: AgentCandidate, req: TaskRequirements): number {
  let score = 0;

  if (req.roles?.includes(agent.role)) score += 10;

  if (req.skills) {
    const matching = req.skills.filter((s) => agent.skills.includes(s));
    score += matching.length * 3;
  }

  if (req.tools) {
    const matching = req.tools.filter((t) => agent.tools.includes(t));
    score += matching.length * 2;
  }

  if (req.requiredPermissions) {
    const hasAll = req.requiredPermissions.every((p) => agent.permissions.includes(p));
    if (hasAll) score += 5;
    else score -= 10;
  }

  return score;
}
