/**
 * Shared scoped-memory types for the AI Company OS Phase 5 memory system.
 *
 * Single definition shared by main (MemoryService, IPC), preload (typed api)
 * and renderer (MemoryScopePanel), mirroring `shared/computer.ts`. Pure types +
 * constants only — no node/electron imports (renderer-safe).
 *
 * Scope boundaries (enforced in main, never here):
 *   global   — owner 'system'; user-approved preferences/rules/conventions
 *   project  — owner = projectId; requirements, decisions, conventions
 *   agent    — owner = agentId; private specialist learnings
 *   task     — owner = planId; objective context, findings, evidence, handoffs
 *   computer — owner = computerId; workspace paths, safe env/recovery refs
 */

export const MEMORY_SCHEMA_VERSION = 1;

export type MemoryScope = 'global' | 'project' | 'agent' | 'task' | 'computer';

export const MEMORY_SCOPES: readonly MemoryScope[] = [
  'global', 'project', 'agent', 'task', 'computer',
];

export type MemoryType =
  | 'preference' // user-approved preference / working style
  | 'rule'       // company-wide rule or convention
  | 'decision'   // approved decision (supersession matters)
  | 'fact'       // stable factual context
  | 'context'    // situational / progress context
  | 'evidence'   // task evidence or artifact reference
  | 'reference'  // path / URL / resource pointer
  | 'handoff'    // handoff summary between agents/tasks
  | 'recovery';  // restart/recovery information

export const MEMORY_TYPES: readonly MemoryType[] = [
  'preference', 'rule', 'decision', 'fact', 'context', 'evidence', 'reference', 'handoff', 'recovery',
];

/**
 * Lifecycle. Only `active` records are ever returned by prompt-bound
 * retrieval; `proposed` awaits user approval; `superseded`/`expired`/`deleted`
 * keep history inspectable instead of being erased.
 */
export type MemoryStatus = 'active' | 'proposed' | 'superseded' | 'expired' | 'deleted';

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'active', 'proposed', 'superseded', 'expired', 'deleted',
];

export type MemorySourceKind = 'user' | 'agent' | 'task_result' | 'system';

export const MEMORY_SOURCE_KINDS: readonly MemorySourceKind[] = [
  'user', 'agent', 'task_result', 'system',
];

export interface MemoryRecord {
  /** 'mem-<rand>' — minted once, stable for life. */
  id: string;
  scope: MemoryScope;
  /** Who the record belongs to: 'system' (global), projectId, agentId, planId, computerId. */
  ownerId: string;
  projectId: string | null;
  agentId: string | null;
  taskId: string | null;
  computerId: string | null;
  type: MemoryType;
  /** Validated, secret-free content (see MEMORY_CONTENT_MAX). */
  content: string;
  sourceKind: MemorySourceKind;
  /** Provenance: goal/plan/message id, 'panel', or null. */
  sourceRef: string | null;
  /** Author: agentId | 'user' | 'system'. */
  author: string;
  /** 0..1 — retrieval ranks by it; conflicts respect it. */
  confidence: number;
  /** 0..5 — retrieval ranks by it; UI shows it. */
  importance: number;
  /** User-approved (required for agent→global/project proposals to activate). */
  approved: boolean;
  status: MemoryStatus;
  /** Successor id when superseded (chain root for history). */
  supersededBy: string | null;
  version: number;
  /** Extra agent ids explicitly authorized to READ this record. */
  accessList: string[];
  /** Epoch ms after which the record expires (null = retain indefinitely). */
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Who is acting on the memory surface. User actors come from pinned IPC
 *  (USER_ACTOR-compatible shape); agent actors only ever originate in main. */
export type MemoryActor = { kind: 'user' } | { kind: 'agent'; agentId: string };

/** Retrieval/query options. `status:'all'` is UI-only; prompt-bound retrieval
 *  always forces `active`. */
export interface MemoryQuery {
  query?: string;
  scope?: MemoryScope;
  status?: MemoryStatus | 'all';
  /** Hard filter: only records of this project. */
  projectId?: string;
  /** TRUSTED project of the retrieval caller (main-side derived) — enables
   *  reading that project's scope without filtering global/other records.
   *  Distinct from `projectId`, which is a plain filter. */
  readerProjectId?: string | null;
  agentId?: string;
  taskId?: string;
  type?: MemoryType;
  limit?: number;
  /** Char budget for prompt-bound recall (null/undefined = unbounded, UI list). */
  budgetChars?: number | null;
}

export interface MemoryRetrieveResult {
  records: MemoryRecord[];
  /** Sum of content lengths actually returned (post-budget). */
  usedChars: number;
  truncated: boolean;
  /** Total records matching scope+ACL before limit/budget. */
  total: number;
}

export const MEMORY_CONTENT_MAX = 2000;
export const DEFAULT_RECALL_BUDGET_CHARS = 1500;
export const DEFAULT_RECALL_LIMIT = 8;
export const DEFAULT_MEMORY_CONFIDENCE = 0.7;
export const DEFAULT_MEMORY_IMPORTANCE = 2;
export const MAX_MEMORY_IMPORTANCE = 5;

/** Structured result carried across the `memory:*` IPC surface. */
export type MemoryOp<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };
