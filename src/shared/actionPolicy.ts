/**
 * ActionPolicy — the central permission catalog & evaluator (Phase 6 / Orbit §8).
 *
 * Pure & renderer-safe (no electron, no fs): the default catalog, the
 * precedence rules, and `evaluatePolicy`. The runtime binding (config overrides,
 * emergency flags, approval-desk retry tokens, audit) lives in
 * `src/main/policyService.ts`.
 *
 * Security invariants this module encodes:
 *   - The evaluator GRANTS nothing by itself. User-owned overrides come from
 *     user config only (written via user-pinned IPC); no agent, prompt, memory,
 *     or the policy module itself can create one.
 *   - Emergency flags always beat overrides (a user override of `allow` cannot
 *     defeat STOP or EXTERNAL-DISABLED).
 *   - Unknown agent actions fail SAFE (require-approval), never fail open.
 *   - The user actor is always allowed (still audited upstream) — emergency
 *     STOP binds agents, never the operator.
 */

export type PolicyDomain =
  | 'hive-tool'
  | 'computer-op'
  | 'integration-outbound'
  | 'memory-write'
  | 'system';

export type PolicyDecision = 'allow' | 'require-approval' | 'deny';

export type PolicyActor = { kind: 'user' } | { kind: 'agent'; agentId: string };

export interface PolicyRequest {
  domain: PolicyDomain;
  /** Tool name / computer op / connector id / 'write'. */
  action: string;
  actor: PolicyActor;
  /** Computer id, integration id, channel — for audit + desk detail only. */
  target?: string;
  /** Caller-declared external effect (broker sets true for every outbound). */
  external?: boolean;
}

export interface EmergencyFlags {
  stopped: boolean;
  paused: boolean;
  externalDisabled: boolean;
}

export const EMERGENCY_OFF: EmergencyFlags = { stopped: false, paused: false, externalDisabled: false };

export interface PolicyContext {
  emergency: EmergencyFlags;
  /** User-owned overrides: keys `${domain}:${action}` or `${domain}:*`. */
  overrides?: Record<string, PolicyDecision>;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  /** Which layer decided — audited verbatim ('emergency:*' | 'override:*' | 'catalog:*' | 'actor:*'). */
  ruleId: string;
}

// ─── catalog tables ──────────────────────────────────────────────────────────

/** Read-only / bookkeeping hive tools — safe by construction. (WebSearch is
 *  NOT here: it is external by name and falls to require-approval.) */
const HIVE_SAFE = new Set(['Read', 'Grep', 'Glob', 'TodoWrite', 'NotebookRead', 'Task']);
/** Workspace-contained mutators — the P4 workspace boundary (traversal refused) applies. */
const HIVE_MUTATING = new Set(['Edit', 'Write', 'NotebookEdit']);
/** Name-based external-capable detection for hive tools (Bash handled explicitly). */
const EXTERNALISH = /browser|web|http|fetch|slack|github|deploy|mail|crm|shopify/i;
/** Computer ops: inspection is free; lifecycle + sensitive ops need a human. */
const COMPUTER_READONLY = new Set([
  'get', 'list', 'status', 'watch', 'captureScreen', 'terminalInfo', 'workspaceInfo',
  'browserStatus', 'getForAgent', 'ensureForAgent', 'getStatus', 'allows'
]);
const COMPUTER_SENSITIVE = new Set([
  'start', 'stop', 'pause', 'resume', 'restart',
  'permissions', 'dispose', 'takeControl', 'openBrowser', 'navigate'
]);

/** External-effect detection (used by emergency.externalDisabled and audit). */
export function isExternalRequest(req: PolicyRequest): boolean {
  if (req.external) return true;
  if (req.domain === 'integration-outbound') return true;
  if (req.domain === 'hive-tool' && EXTERNALISH.test(req.action)) return true;
  return false;
}

function allow(ruleId: string, reason: string): PolicyResult {
  return { decision: 'allow', ruleId, reason };
}
function reqApproval(ruleId: string, reason: string): PolicyResult {
  return { decision: 'require-approval', ruleId, reason };
}
function deny(ruleId: string, reason: string): PolicyResult {
  return { decision: 'deny', ruleId, reason };
}

function catalogDecision(req: PolicyRequest): PolicyResult {
  switch (req.domain) {
    case 'hive-tool': {
      const a = req.action;
      if (HIVE_SAFE.has(a)) return allow('catalog:hive-safe', 'read-only / bookkeeping tool');
      if (HIVE_MUTATING.has(a)) return allow('catalog:hive-mutating', 'workspace-contained editor (subject to workspace boundary)');
      if (a === 'Bash') return reqApproval('catalog:hive-bash', 'arbitrary shell execution requires operator approval');
      if (EXTERNALISH.test(a)) return reqApproval('catalog:hive-external', 'external-capable tool requires operator approval');
      return reqApproval('catalog:hive-unknown', 'unknown tool — fail-safe requires operator approval');
    }
    case 'computer-op': {
      if (COMPUTER_READONLY.has(req.action)) return allow('computer:readonly', 'inspection operation');
      if (COMPUTER_SENSITIVE.has(req.action)) return reqApproval('computer:sensitive', 'computer lifecycle / sensitive operation requires approval');
      return reqApproval('computer:unknown', 'unknown computer op — fail-safe requires approval');
    }
    case 'integration-outbound':
      return reqApproval('catalog:integration', 'outbound integration call requires operator approval');
    case 'memory-write':
      return allow('catalog:memory', 'internal memory write (service ACL already enforced)');
    case 'system':
      return deny('catalog:system-agent', 'system surface is user-only');
  }
}

// ─── evaluator ───────────────────────────────────────────────────────────────

/** Precedence: user actor > emergency stop > emergency externalDisabled >
 *  user override > catalog > (catalog already fails safe on unknowns). */
export function evaluatePolicy(req: PolicyRequest, ctx: PolicyContext): PolicyResult {
  if (req.actor.kind === 'user') {
    return allow('actor:user', 'operator action (audited)');
  }
  const agentId = req.actor.agentId;

  if (ctx.emergency.stopped) {
    return deny('emergency:stopped', 'Emergency STOP is active — every agent action is refused.');
  }
  const external = isExternalRequest(req);
  if (ctx.emergency.externalDisabled && external) {
    return deny('emergency:externalDisabled', 'External actions are disabled (emergency).');
  }

  const key = `${req.domain}:${req.action}`;
  const starKey = `${req.domain}:*`;
  const override = ctx.overrides?.[key] ?? ctx.overrides?.[starKey];
  if (override === 'allow') {
    return allow(`override:${key}`, `user override allows ${key}`);
  }
  if (override === 'deny') {
    return deny(`override:${key}`, `user override denies ${key}`);
  }
  if (override === 'require-approval') {
    return reqApproval(`override:${key}`, `user override requires approval for ${key}`);
  }

  const res = catalogDecision(req);
  // reason carries the agent for audit context without changing shape
  return { ...res, reason: `${res.reason} (agent ${agentId})` };
}

// ─── autoMode posture (bypass removal) ───────────────────────────────────────

/** autoMode alone must NEVER arm the hive auto-approve shim. The explicit
 *  `security.autoApproveInternal` opt-in is required (Phase 6 §5). */
export function autoApproveEnv(autoMode: boolean, securityAutoApproveInternal: boolean | undefined): boolean {
  return !!autoMode && securityAutoApproveInternal === true;
}
