/**
 * PolicyService — runtime binding of the pure ActionPolicy evaluator
 * (src/shared/actionPolicy.ts) to: emergency flags (PersistStore KV), user
 * config overrides, the ApprovalDesk, and the AuditStore (Phase 6).
 *
 * Wiring points:
 *   - HookServer PreToolUse  → checkAgentTool (synchronous; deny fast, approval
 *     rides the desk + one-shot retry token — control.ts doctrine).
 *   - IntegrationBroker outbound → checkOutbound (async hold: desk item; the
 *     caller releases or cancels after the decision).
 *   - ComputerManager ops    → left on its own default-deny matrix (design §1:
 *     policy is the second, product-wide layer). The computer-op catalog rows
 *     exist for the evaluator/checkAsync surface, not a ComputerManager rewire.
 *   - MemoryService writes   → auditMemoryWrite (audit only; the service's own
 *     ACL from Phase 5 remains the enforcement).
 *
 * Invariants: emergency beats everything; overrides are read from config
 * (user-pinned IPC writes only); this service never mutates config; every
 * decision is audited.
 */
import {
  EMERGENCY_OFF, evaluatePolicy, isExternalRequest,
  type EmergencyFlags, type PolicyActor, type PolicyDecision, type PolicyDomain, type PolicyRequest
} from '../shared/actionPolicy';
import type { AuditStore } from './audit';
import type { ApprovalDesk } from './approvals';

export interface PolicyServiceDeps {
  /** User-owned overrides (from config.security.policyOverrides). */
  overrides: () => Record<string, PolicyDecision>;
  /** Emergency flags — stored/reloaded by the caller (PersistStore KV). */
  emergency: () => EmergencyFlags;
  /** Persist emergency flag changes (caller owns storage). */
  persistEmergency?: (flags: EmergencyFlags) => void;
  desk: ApprovalDesk;
  audit: AuditStore;
  now?: () => number;
  /** Phase 7 (M2) — the agent's COMPUTER capability record (injected: index.ts
   *  resolves via ComputerManager.getForAgent). null/undefined = the agent has
   *  no computer ⇒ nothing stored ⇒ the catalog alone decides. */
  agentComputerCaps?: (agentId: string) => { externalActions: boolean; network: boolean } | null | undefined;
}

export interface HookToolVerdict {
  deny: boolean;
  reason?: string;
  approvalId?: string;
}

export interface AsyncVerdict {
  decision: 'allow' | 'require-approval' | 'deny';
  reason: string;
  ruleId: string;
  /** Present when require-approval created/held a desk item. */
  approvalId?: string;
}

export class PolicyService {
  private readonly now: () => number;

  constructor(private readonly deps: PolicyServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private ctx() {
    return { emergency: this.deps.emergency(), overrides: this.deps.overrides() };
  }

  private auditDecision(req: PolicyRequest, res: { decision: string; ruleId: string; reason: string }, approvalId?: string): void {
    this.deps.audit.record({
      kind: 'policy-decision',
      actor: req.actor.kind === 'user' ? 'user' : req.actor.agentId,
      domain: req.domain,
      action: req.action,
      ...(req.target !== undefined ? { target: req.target } : {}),
      decision: res.decision,
      ruleId: res.ruleId,
      ...(approvalId !== undefined ? { approvalId } : {}),
      detail: res.reason
    });
  }

  // ─── hook path (synchronous) ───────────────────────────────────────────────

  /** PreToolUse boundary. One-shot retry tokens (desk approvals) are checked
   *  first; then the pure evaluator; require-approval → immediate deny + desk
   *  item (shim timeout — no renderer round-trip here). */
  checkAgentTool(agentId: string, tool: string): HookToolVerdict {
    if (this.deps.desk.consumeRetry(agentId, tool, this.now())) {
      this.auditDecision(
        { domain: 'hive-tool', action: tool, actor: { kind: 'agent', agentId } },
        { decision: 'allow', ruleId: 'retry-token', reason: 'covered by a fresh operator approval (one-shot)' }
      );
      return { deny: false };
    }
    const req: PolicyRequest = { domain: 'hive-tool', action: tool, actor: { kind: 'agent', agentId } };
    const res = evaluatePolicy(req, this.ctx());
    // Phase 7 (M2) layer: precedence is user > emergency > override >
    // COMPUTER CAPABILITY > catalog. The evaluator's ruleId names which of the
    // first three decided — only a `catalog:*` result is still up for this layer.
    const highLayer = res.ruleId.startsWith('actor:')
      || res.ruleId.startsWith('emergency:')
      || res.ruleId.startsWith('override:');
    if (!highLayer) {
      const caps = this.deps.agentComputerCaps?.(agentId);
      if (caps && caps.externalActions === false && isExternalRequest(req)) {
        this.auditDecision(req, {
          decision: 'deny',
          ruleId: 'computer:externalActions',
          reason: `computer capability externalActions is off (agent ${agentId})`
        });
        return {
          deny: true,
          reason: `Denied at the computer capability layer: this agent's computer has externalActions disabled.`
        };
      }
    }
    if (res.decision === 'allow') {
      this.auditDecision(req, res);
      return { deny: false };
    }
    const item = this.deps.desk.req({
      domain: 'hive-tool',
      action: tool,
      actor: agentId,
      detail: `${res.reason} — operator approval requested.`,
      ruleId: res.ruleId
    });
    this.auditDecision(req, res, item.id);
    const reason = res.decision === 'deny'
      ? res.reason
      : `Held for operator approval — see the Approval Desk (ref ${item.id}). ${res.reason}`;
    return { deny: true, reason, approvalId: item.id };
  }

  // ─── async paths (broker / computer / integrations) ────────────────────────

  /** Full verdict for async callers. require-approval creates/holds a desk
   *  item and returns its id; the caller waits for a human decision. */
  checkAsync(actor: PolicyActor, domain: PolicyDomain, action: string, target?: string): AsyncVerdict {
    const req: PolicyRequest = {
      domain, action, actor,
      ...(target !== undefined ? { target } : {}),
      ...(domain === 'integration-outbound' ? { external: true } : {})
    };
    const res = evaluatePolicy(req, this.ctx());
    if (res.decision === 'allow') {
      this.auditDecision(req, res);
      return { decision: 'allow', reason: res.reason, ruleId: res.ruleId };
    }
    const item = this.deps.desk.req({
      domain,
      action,
      actor: actor.kind === 'user' ? 'user' : actor.agentId,
      ...(target !== undefined ? { target } : {}),
      detail: `${res.reason}${isExternalRequest(req) ? ' (external effect)' : ''}`,
      ruleId: res.ruleId
    });
    this.auditDecision(req, res, item.id);
    return { decision: res.decision, reason: res.reason, ruleId: res.ruleId, approvalId: item.id };
  }

  /** Audit-only wrapper for memory writes (Phase 5 ACL is the enforcement). */
  auditMemoryWrite(actor: PolicyActor, ok: boolean, code?: string): void {
    this.deps.audit.record({
      kind: 'memory-write',
      actor: actor.kind === 'user' ? 'user' : actor.agentId,
      domain: 'memory-write',
      action: 'write',
      decision: ok ? 'stored' : 'rejected',
      ...(code !== undefined ? { ruleId: code } : {})
    });
  }

  // ─── emergency (user-only at the IPC layer) ────────────────────────────────

  emergency(): EmergencyFlags {
    return this.deps.emergency();
  }

  setEmergency(patch: Partial<EmergencyFlags>, actorId = 'user'): EmergencyFlags {
    const next: EmergencyFlags = { ...this.deps.emergency(), ...patch };
    const prev = this.deps.emergency();
    this.deps.persistEmergency?.(next);
    this.deps.audit.record({
      kind: 'emergency-changed',
      actor: actorId,
      decision: JSON.stringify(next),
      detail: `from ${JSON.stringify(prev)}`
    });
    return next;
  }

  // ─── overrides (user-only at the IPC layer; never written here) ────────────

  setOverrideAudit(key: string, decision: PolicyDecision | null, actorId = 'user'): void {
    this.deps.audit.record({
      kind: 'override-changed',
      actor: actorId,
      action: key,
      decision: decision ?? 'cleared'
    });
  }
}
