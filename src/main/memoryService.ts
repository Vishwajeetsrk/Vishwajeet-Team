/**
 * MemoryService — Phase 5 scoped, persistent, permission-checked memory.
 *
 * Extends (never duplicates) the existing memory stack:
 *  - `memory.md` + MemPalace remain the agent's private scratch/semantic layer;
 *  - this service owns STRUCTURED records with scope, provenance, ACL,
 *    supersession and retention, persisted through MemoryRepo (SQLite in prod).
 *
 * Trust boundaries (enforced here, in main — never in the UI):
 *  - Agent actors only ever originate from main-side callers (CEO pipeline);
 *    renderer IPC is pinned to USER_ACTOR before reaching `write/edit/approve/
 *    remove`. Agents have no IPC surface of their own.
 *  - Secret-like content is REJECTED at write (redactSecrets battery as the
 *    detector) — nothing secret-adjacent is ever stored or echoed.
 *  - Retrieval filters by status + expiry + scope + ACL BEFORE ranking; a
 *    shared index can never widen permissions. Logs carry counts, never
 *    content.
 */

import { randomUUID } from 'node:crypto';
import { redactSecrets } from './hive';
import type { MemoryFilter, MemoryRepo } from './memoryStore';
import {
  DEFAULT_MEMORY_CONFIDENCE, DEFAULT_MEMORY_IMPORTANCE, DEFAULT_RECALL_BUDGET_CHARS,
  DEFAULT_RECALL_LIMIT, MEMORY_CONTENT_MAX, MEMORY_SCOPES,
} from '../shared/memoryRecord';
import type {
  MemoryActor, MemoryOp, MemoryQuery, MemoryRecord, MemoryRetrieveResult,
  MemoryScope, MemorySourceKind, MemoryStatus, MemoryType,
} from '../shared/memoryRecord';
import type { MemoryEditInput, MemoryWriteInput } from './memoryIpcValidation';

export interface MemoryServiceDeps {
  repo: MemoryRepo;
  /** Durable event sink (hive.appendLog) — receives redacted metadata only. */
  log?: (evt: Record<string, unknown>) => void;
  /** Renderer push (`liveWebContents().send`). */
  emit?: (channel: string, payload: unknown) => void;
  now?: () => number;
  /** Resolves the agent assigned to a task/plan id (null = unknown). Wired to
   *  the goal store in index.ts — lets agent→task writes verify ownership. */
  taskAgent?: (taskId: string) => string | null;
}

export interface MemoryWriteCtx {
  sourceRef?: string | null;
  sourceKind?: MemorySourceKind;
}

/** Types where a scope+owner holds exactly ONE current answer — a new write
 *  supersedes the active record even when the content barely resembles it. */
const SINGLETON_TYPES: ReadonlySet<MemoryType> = new Set(['preference', 'rule', 'decision']);
/** Near-duplicate threshold for non-singleton types (conflicting claims). */
const CONFLICT_SIMILARITY = 0.5;

/** Types an agent may write straight to `active` (own scopes). Everything an
 *  agent writes to project/global lands in `proposed` for user approval. */
const ACTIVE_AGENT_SCOPES: ReadonlySet<MemoryScope> = new Set(['agent', 'task']);

export type MemoryReader = MemoryActor;

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2) out.add(raw);
  }
  return out;
}

function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}

function err(error: string, code: string): { ok: false; error: string; code: string } {
  return { ok: false, error, code };
}

export class MemoryService {
  private readonly repo: MemoryRepo;
  private readonly now: () => number;
  private readonly log?: (evt: Record<string, unknown>) => void;
  private readonly emit?: (channel: string, payload: unknown) => void;
  private readonly taskAgent?: (taskId: string) => string | null;

  constructor(deps: MemoryServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? Date.now;
    this.log = deps.log;
    this.emit = deps.emit;
    this.taskAgent = deps.taskAgent;
  }

  // ─── events (metadata only — never content) ────────────────────────────────

  private event(name: string, extra: Record<string, unknown> = {}): void {
    try {
      this.log?.({ kind: 'memory', event: name, ...extra });
    } catch { /* audit must never break the operation */ }
    try {
      this.emit?.('memory:updated', { reason: name, ...(typeof extra.id === 'string' ? { id: extra.id } : {}) });
    } catch { /* renderer may be gone */ }
  }

  // ─── access control (read) ─────────────────────────────────────────────────

  /** ctx.projectId is the TRUSTED project of the retrieval call — main-side
   *  callers derive it (task → computer → projectId), agents cannot forge it. */
  canRead(rec: MemoryRecord, reader: MemoryReader, ctx?: { projectId?: string | null }): boolean {
    if (rec.status === 'deleted') return reader.kind === 'user';
    if (reader.kind === 'user') return true;
    const agentId = reader.agentId;
    if (rec.accessList.includes(agentId)) return true;
    if (rec.agentId === agentId && rec.scope !== 'global') return true;
    switch (rec.scope) {
      case 'global': return true;
      case 'project':
        return rec.projectId !== null && ctx?.projectId != null && rec.projectId === ctx.projectId;
      case 'agent': return rec.ownerId === agentId;
      case 'task': return rec.ownerId === agentId || rec.agentId === agentId;
      case 'computer': return rec.agentId === agentId;
      default: return false;
    }
  }

  private canWriteScope(input: MemoryWriteInput, actor: MemoryActor): { ok: true } | { ok: false; error: string; code: string } {
    if (actor.kind === 'user') return { ok: true };
    switch (input.scope) {
      case 'global':
      case 'project':
        return { ok: true }; // agent → proposed (approval gate below), not active
      case 'agent':
        if (input.agentId !== actor.agentId) {
          return err(`agent '${actor.agentId}' cannot write memory for agent '${input.agentId}'`, 'PERMISSION_DENIED');
        }
        return { ok: true };
      case 'task': {
        const owner = this.taskAgent?.(input.taskId ?? '') ?? null;
        if (!owner || owner !== actor.agentId) {
          return err(`agent '${actor.agentId}' is not the assigned agent for task '${input.taskId}'`, 'PERMISSION_DENIED');
        }
        return { ok: true };
      }
      case 'computer':
        return err('agents may not write computer-scope memory (user only)', 'PERMISSION_DENIED');
      default:
        return err('unknown scope', 'PERMISSION_DENIED');
    }
  }

  // ─── write pipeline ────────────────────────────────────────────────────────

  private ownerIdFor(input: MemoryWriteInput): string {
    switch (input.scope) {
      case 'global': return 'system';
      case 'project': return input.projectId ?? '';
      case 'agent': return input.agentId ?? '';
      case 'task': return input.taskId ?? '';
      case 'computer': return input.computerId ?? '';
      default: return '';
    }
  }

  private activeSiblings(input: MemoryWriteInput, ownerId: string): MemoryRecord[] {
    const filter: MemoryFilter = { scope: input.scope, ownerId };
    return this.repo.list(filter).filter((r) =>
      r.type === input.type && (r.status === 'active' || r.status === 'proposed'));
  }

  write(
    input: MemoryWriteInput,
    actor: MemoryActor,
    ctx?: MemoryWriteCtx,
  ): MemoryOp<{ record: MemoryRecord; dedup?: boolean }> {
    // 1-2. structure validated upstream (validators) — re-guard the essentials
    // so non-IPC callers can't bypass: content bounds + scope membership.
    if (typeof input.content !== 'string' || input.content.trim().length === 0) {
      return err('content must be a non-empty string', 'VALIDATION');
    }
    if (input.content.length > MEMORY_CONTENT_MAX) {
      return err(`content exceeds ${MEMORY_CONTENT_MAX} characters`, 'VALIDATION');
    }
    if (!MEMORY_SCOPES.includes(input.scope)) {
      return err(`unknown scope: ${String(input.scope)}`, 'VALIDATION');
    }

    const ownerId = this.ownerIdFor(input);
    if (!ownerId) return err(`scope '${input.scope}' requires its primary reference`, 'VALIDATION');

    // 4. secret scan — reject, never store (battery reused as detector).
    if (redactSecrets(input.content) !== input.content) {
      this.event('memory-rejected', { scope: input.scope, ownerId, reason: 'secret_detected', actor: actor.kind });
      return err('content looks like it contains a secret or credential — refusing to store it', 'SECRET_DETECTED');
    }

    // 5. writer permission.
    const perm = this.canWriteScope(input, actor);
    if (!perm.ok) {
      this.event('memory-rejected', { scope: input.scope, ownerId, reason: 'permission', actor: actor.kind });
      return perm;
    }

    const siblings = this.activeSiblings(input, ownerId);

    // 6a. duplicate detection (normalized content equal).
    const norm = normalize(input.content);
    const dup = siblings.find((r) => normalize(r.content) === norm);
    if (dup) {
      this.event('memory-deduplicated', { id: dup.id, scope: input.scope, ownerId });
      return { ok: true, value: { record: dup, dedup: true } };
    }

    // 6b. conflict detection: singleton types always converge to one answer;
    //     other types conflict when the claims are near-duplicates.
    const conflicting = siblings.find((r) =>
      SINGLETON_TYPES.has(input.type)
        ? r.status === 'active'
        : (r.status === 'active' && similarity(r.content, input.content) >= CONFLICT_SIMILARITY));

    if (conflicting && actor.kind === 'agent' && conflicting.approved) {
      this.event('memory-rejected', { id: conflicting.id, scope: input.scope, reason: 'conflict_approved', actor: actor.kind });
      return err('an approved record already answers this — ask the user to revise it', 'CONFLICT');
    }

    const now = this.now();
    const isAgentProposal = actor.kind === 'agent' && !ACTIVE_AGENT_SCOPES.has(input.scope);

    const record: MemoryRecord = {
      id: `mem-${randomUUID().slice(0, 12)}`,
      scope: input.scope,
      ownerId,
      projectId: input.projectId,
      agentId: input.agentId ?? (actor.kind === 'agent' ? actor.agentId : null),
      taskId: input.taskId,
      computerId: input.computerId,
      type: input.type,
      content: input.content,
      sourceKind: ctx?.sourceKind ?? (actor.kind === 'user' ? 'user' : 'agent'),
      sourceRef: ctx?.sourceRef ?? null,
      author: actor.kind === 'user' ? 'user' : actor.agentId,
      confidence: input.confidence ?? (actor.kind === 'user' ? Math.max(DEFAULT_MEMORY_CONFIDENCE, 0.9) : DEFAULT_MEMORY_CONFIDENCE),
      importance: input.importance ?? DEFAULT_MEMORY_IMPORTANCE,
      approved: actor.kind === 'user',
      status: isAgentProposal ? 'proposed' : 'active',
      supersededBy: null,
      version: 1,
      accessList: [],
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    // 7. apply supersession before insert (old row keeps history).
    if (conflicting) {
      conflicting.status = 'superseded';
      conflicting.supersededBy = record.id;
      conflicting.updatedAt = now;
      record.version = conflicting.version + 1;
      this.repo.update(conflicting);
      this.event('memory-superseded', { id: conflicting.id, supersededBy: record.id, scope: conflicting.scope });
    }

    // 8. persist.
    try {
      this.repo.insert(record);
    } catch (e) {
      return err(`persist failed: ${e instanceof Error ? e.message : String(e)}`, 'PERSIST');
    }

    // 9. real event (metadata only).
    this.event('memory-written', { id: record.id, scope: record.scope, ownerId, status: record.status, actor: actor.kind });
    // 10. structured success.
    return { ok: true, value: { record } };
  }

  // ─── retrieval pipeline ────────────────────────────────────────────────────

  retrieve(reader: MemoryReader, query: MemoryQuery = {}): MemoryOp<MemoryRetrieveResult> {
    const now = this.now();
    const status: MemoryStatus | 'all' = query.status ?? 'active';
    const ctx = { projectId: query.readerProjectId ?? null };

    // Prefilter (scope/status/expiry/lazy-expire), then ACL, then rank.
    let candidates = this.repo.list().filter((rec) => {
      if (status !== 'all' && rec.status !== status) return false;
      if (rec.status === 'active' && rec.expiresAt !== null && rec.expiresAt <= now) {
        rec.status = 'expired';
        rec.updatedAt = now;
        try { this.repo.update(rec); } catch { /* best-effort lazy expiry */ }
        return false;
      }
      if (rec.status === 'expired' && status !== 'all') return false;
      if (query.scope && rec.scope !== query.scope) return false;
      if (query.type && rec.type !== query.type) return false;
      if (query.projectId !== undefined && rec.projectId !== query.projectId) return false;
      if (query.agentId !== undefined && rec.agentId !== query.agentId) return false;
      if (query.taskId !== undefined && rec.taskId !== query.taskId) return false;
      return true;
    });

    const qTokens = query.query ? tokens(query.query) : null;
    if (qTokens && qTokens.size > 0) {
      candidates = candidates.filter((rec) => {
        const hay = tokens(rec.content);
        for (const t of qTokens) if (hay.has(t)) return true;
        return false;
      });
    }

    // ACL BEFORE ranking (a shared index must never widen scope).
    candidates = candidates.filter((rec) => this.canRead(rec, reader, ctx));
    const total = candidates.length;

    const scored = candidates.map((rec) => {
      let textScore = 1;
      if (qTokens && qTokens.size > 0) {
        const hay = tokens(rec.content);
        let hits = 0;
        for (const t of qTokens) if (hay.has(t)) hits += 1;
        textScore = hits / qTokens.size;
      }
      const ageDays = Math.max(0, (now - rec.updatedAt) / 86_400_000);
      const recency = Math.exp(-ageDays / 30);
      const score = 0.5 * textScore
        + 0.25 * rec.confidence
        + 0.15 * (rec.importance / 5)
        + 0.10 * recency;
      return { rec, score };
    });

    scored.sort((a, b) => b.score - a.score || b.rec.updatedAt - a.rec.updatedAt);

    const budget = query.budgetChars ?? null;
    const limit = query.limit ?? (budget ? DEFAULT_RECALL_LIMIT : 50);

    const picked: MemoryRecord[] = [];
    let usedChars = 0;
    let truncated = false;
    for (const { rec } of scored) {
      if (picked.length >= limit) { truncated = true; break; }
      const len = rec.content.length;
      if (budget !== null) {
        if (len > budget) { truncated = true; continue; }        // can never fit — skip
        if (usedChars + len > budget) { truncated = true; break; } // doesn't fit now — stop
      }
      picked.push(rec);
      usedChars += len;
    }

    // Defense-in-depth redaction on the way out (records were validated clean).
    const records = picked.map((r) => ({ ...r, content: redactSecrets(r.content) }));

    // Retrieval metadata — counts and sizes only, NEVER content or query text.
    this.event('memory-retrieved', { reader: reader.kind, count: records.length, chars: usedChars, status });

    return { ok: true, value: { records, usedChars, truncated, total } };
  }

  // ─── inspect / history ─────────────────────────────────────────────────────

  get(id: string, reader: MemoryReader): MemoryOp<MemoryRecord> {
    const rec = this.repo.get(id);
    if (!rec) return err('memory not found', 'NOT_FOUND');
    if (!this.canRead(rec, reader)) return err('access denied', 'ACCESS_DENIED');
    return { ok: true, value: rec };
  }

  /** Supersession chain (oldest → newest) for the record, ACL-filtered. */
  history(id: string, reader: MemoryReader): MemoryOp<MemoryRecord[]> {
    const start = this.repo.get(id);
    if (!start) return err('memory not found', 'NOT_FOUND');
    if (!this.canRead(start, reader)) return err('access denied', 'ACCESS_DENIED');

    const all = this.repo.list();
    // Walk backwards to the root.
    const backwards: MemoryRecord[] = [start];
    let guard = 0;
    while (guard < 100) {
      guard += 1;
      const parent = all.find((r) => r.supersededBy === backwards[0].id);
      if (!parent || parent.id === start.id) break;
      backwards.unshift(parent);
    }
    // Walk forwards from start.
    const forwards: MemoryRecord[] = [];
    let cursor = start.supersededBy;
    guard = 0;
    while (cursor && guard < 100) {
      guard += 1;
      const next = this.repo.get(cursor);
      if (!next) break;
      forwards.push(next);
      cursor = next.supersededBy;
    }
    const chain = [...backwards, ...forwards].filter((r) => this.canRead(r, reader));
    return { ok: true, value: chain };
  }

  // ─── correction / approval / retention (user-only via pinned IPC) ──────────

  edit(id: string, input: MemoryEditInput, actor: MemoryActor): MemoryOp<MemoryRecord> {
    if (actor.kind !== 'user') return err('only the user may edit memory', 'PERMISSION_DENIED');
    const old = this.repo.get(id);
    if (!old) return err('memory not found', 'NOT_FOUND');
    if (old.status === 'deleted') return err('memory was deleted', 'NOT_FOUND');
    const now = this.now();

    if (input.content !== null && normalize(input.content) !== normalize(old.content)) {
      // Authoritative correction = a superseding version; history preserved.
      const next: MemoryRecord = {
        ...old,
        id: `mem-${randomUUID().slice(0, 12)}`,
        content: input.content,
        sourceKind: 'user',
        sourceRef: `edit:${old.id}`,
        author: 'user',
        approved: true,
        status: 'active',
        supersededBy: null,
        version: old.version + 1,
        accessList: [...old.accessList],
        createdAt: now,
        updatedAt: now,
        ...(input.importance !== null ? { importance: input.importance } : {}),
        ...(input.confidence !== null ? { confidence: input.confidence } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      };
      old.status = 'superseded';
      old.supersededBy = next.id;
      old.updatedAt = now;
      this.repo.update(old);
      this.repo.insert(next);
      this.event('memory-superseded', { id: old.id, supersededBy: next.id, scope: old.scope, via: 'edit' });
      this.event('memory-written', { id: next.id, scope: next.scope, status: next.status, actor: 'user' });
      return { ok: true, value: next };
    }

    // Field-only correction: in-place update (content unchanged → no new version).
    if (input.importance !== null) old.importance = input.importance;
    if (input.confidence !== null) old.confidence = input.confidence;
    if (input.expiresAt !== undefined) old.expiresAt = input.expiresAt;
    old.updatedAt = now;
    this.repo.update(old);
    this.event('memory-updated', { id: old.id, scope: old.scope, actor: 'user' });
    return { ok: true, value: old };
  }

  approve(id: string, actor: MemoryActor): MemoryOp<MemoryRecord> {
    if (actor.kind !== 'user') return err('only the user may approve memory', 'PERMISSION_DENIED');
    const rec = this.repo.get(id);
    if (!rec) return err('memory not found', 'NOT_FOUND');
    if (rec.status !== 'proposed') return err(`only proposed memory can be approved (status is '${rec.status}')`, 'INVALID_STATE');
    rec.status = 'active';
    rec.approved = true;
    rec.updatedAt = this.now();
    this.repo.update(rec);
    this.event('memory-approved', { id: rec.id, scope: rec.scope, actor: 'user' });
    return { ok: true, value: rec };
  }

  remove(id: string, actor: MemoryActor): MemoryOp<{ id: string }> {
    if (actor.kind !== 'user') return err('only the user may delete memory', 'PERMISSION_DENIED');
    const rec = this.repo.get(id);
    if (!rec) return err('memory not found', 'NOT_FOUND');
    if (rec.status === 'deleted') return { ok: true, value: { id } };
    rec.status = 'deleted';
    rec.updatedAt = this.now();
    this.repo.update(rec);
    this.event('memory-deleted', { id: rec.id, scope: rec.scope, actor: 'user' });
    return { ok: true, value: { id } };
  }

  /** Boot reconcile: mark due records expired (no replay, no deletes). */
  reconcile(): { loaded: number; expired: number } {
    const now = this.now();
    const all = this.repo.list();
    let expired = 0;
    for (const rec of all) {
      if (rec.status === 'active' && rec.expiresAt !== null && rec.expiresAt <= now) {
        rec.status = 'expired';
        rec.updatedAt = now;
        try { this.repo.update(rec); expired += 1; } catch { /* best-effort */ }
      }
    }
    if (expired > 0) this.event('memory-expired', { count: expired });
    return { loaded: all.length, expired };
  }
}

/** Format retrieved records as a prompt section (budgeted, advisory).
 *  Returns null when nothing was retrieved — callers omit the section. */
export function formatRecall(records: MemoryRecord[]): string | null {
  if (records.length === 0) return null;
  const lines = records.map((r) => {
    const bits = [r.scope, r.type, `conf=${r.confidence.toFixed(2)}`, `imp=${r.importance}`];
    if (r.projectId) bits.push(`project=${r.projectId}`);
    return `- [${bits.join(' ')}] ${r.content}`;
  });
  return lines.join('\n');
}

export const RECALL_DEFAULT_BUDGET = DEFAULT_RECALL_BUDGET_CHARS;
