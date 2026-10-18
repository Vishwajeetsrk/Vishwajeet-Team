/**
 * ApprovalDesk — the central queue for operator-approved actions (Phase 6 /
 * Orbit §8). Durable at `<harnessHome>/approvals.json` (temp+rename).
 *
 * Items are created by the policy layer when a request needs a human
 * (require-approval). Decisions are USER-ONLY in practice — the IPC handlers
 * pin USER_ACTOR; this module takes a `decidedBy` string for the audit trail.
 *
 * One-shot retry tokens: approving a policy item for an agent arms a token
 * (`agentId:action` → expiry). The hook path (`consumeRetry`) checks+consumes
 * it synchronously (PreToolUse has a shim timeout — no renderer round-trip,
 * per control.ts doctrine). Tokens are single-use and short-TTL.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface ApprovalItem {
  id: string;
  kind: 'policy';
  domain: string;
  action: string;
  /** agentId for agent-originated requests (tokens arm only for agents). */
  actor: string;
  target?: string;
  detail: string;
  ruleId: string;
  createdAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  decidedBy?: string;
}

export interface ApprovalRequest {
  domain: string;
  action: string;
  actor: string;
  target?: string;
  detail: string;
  ruleId: string;
}

const RETRY_TTL_MS = 60_000;
const MAX_PENDING = 200;
const MAX_DECIDED_KEPT = 500;

export class ApprovalDesk {
  private items: ApprovalItem[] = [];
  /** `${agentId}:${action}` → epoch-ms expiry. Single-use (deleted on consume). */
  private retry = new Map<string, number>();

  constructor(
    private readonly filePath: () => string,
    private readonly onChange?: (event: string, item: ApprovalItem) => void
  ) {
    this.load();
  }

  /** New pending item (deduped: same agent+action+domain pending → existing). */
  req(r: ApprovalRequest): ApprovalItem {
    const existing = this.items.find(
      (i) => i.status === 'pending' && i.actor === r.actor && i.action === r.action && i.domain === r.domain
    );
    if (existing) return existing;
    const item: ApprovalItem = {
      id: `apr-${randomUUID()}`,
      kind: 'policy',
      domain: r.domain,
      action: r.action,
      actor: r.actor,
      ...(r.target !== undefined ? { target: r.target } : {}),
      detail: r.detail,
      ruleId: r.ruleId,
      createdAt: new Date().toISOString(),
      status: 'pending'
    };
    this.items.push(item);
    this.trim();
    this.save();
    try { this.onChange?.('requested', item); } catch { /* listener must never break the desk */ }
    return item;
  }

  list(filter: { status?: ApprovalStatus } = {}): ApprovalItem[] {
    return filter.status ? this.items.filter((i) => i.status === filter.status) : [...this.items];
  }

  get(id: string): ApprovalItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  pendingCount(): number {
    return this.items.filter((i) => i.status === 'pending').length;
  }

  /** User decision. Approving an agent-originated item arms a one-shot retry
   *  token so the agent's next identical call passes once. */
  decide(id: string, approve: boolean, decidedBy = 'user'): { ok: boolean; item?: ApprovalItem; error?: string } {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: `approval ${id} not found` };
    if (item.status !== 'pending') return { ok: false, error: `approval ${id} already ${item.status}` };
    item.status = approve ? 'approved' : 'denied';
    item.decidedAt = new Date().toISOString();
    item.decidedBy = decidedBy;
    if (approve && item.actor && item.actor !== 'user') {
      this.retry.set(`${item.actor}:${item.action}`, Date.now() + RETRY_TTL_MS);
    }
    this.save();
    try { this.onChange?.(approve ? 'approved' : 'denied', item); } catch { /* never break */ }
    return { ok: true, item };
  }

  /** Hook-path check+consume (synchronous, race-free). True = this call is
   *  covered by a fresh approval; the token is spent either way. */
  consumeRetry(agentId: string, action: string, now = Date.now()): boolean {
    const key = `${agentId}:${action}`;
    const expiry = this.retry.get(key);
    if (expiry === undefined) return false;
    this.retry.delete(key);
    return expiry >= now;
  }

  // ─── durability ────────────────────────────────────────────────────────────

  private trim(): void {
    const decided = this.items.filter((i) => i.status !== 'pending');
    if (decided.length > MAX_DECIDED_KEPT) {
      const keepDecided = decided.slice(-MAX_DECIDED_KEPT);
      const keepIds = new Set(keepDecided.map((i) => i.id));
      this.items = this.items.filter((i) => i.status === 'pending' || keepIds.has(i.id));
    }
    const pending = this.items.filter((i) => i.status === 'pending');
    if (pending.length > MAX_PENDING) {
      const drop = new Set(pending.slice(0, pending.length - MAX_PENDING).map((i) => i.id));
      this.items = this.items.filter((i) => !drop.has(i.id));
    }
  }

  private save(): void {
    try {
      const f = this.filePath();
      const dir = join(f, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8');
      renameSync(tmp, f);
    } catch (e) {
      console.error('[approvals] save failed:', e);
    }
  }

  private load(): void {
    try {
      const f = this.filePath();
      if (!existsSync(f)) return;
      const doc = JSON.parse(readFileSync(f, 'utf8')) as { items?: ApprovalItem[] };
      if (Array.isArray(doc.items)) this.items = doc.items;
    } catch (e) {
      console.error('[approvals] load failed:', e);
      this.items = [];
    }
  }
}
