/** Pure input validators for the `memory:*` IPC surface (Phase 5).
 *  House style: no schema library — explicit type/shape/range guards returning
 *  `{ ok:false, error }` instead of throwing (mirrors ceo/computerIpcValidation).
 *  Kept free of Electron so tests can exercise every branch directly.
 *
 *  Scope ownership (ownerId), author and sourceKind are DERIVED main-side from
 *  the pinned actor — a renderer payload can never name them. */

import {
  MEMORY_CONTENT_MAX, MEMORY_SCOPES, MEMORY_STATUSES, MEMORY_TYPES,
} from '../shared/memoryRecord';
import type { MemoryScope, MemoryStatus, MemoryType } from '../shared/memoryRecord';

export const MEMORY_LIMITS = {
  content: MEMORY_CONTENT_MAX,
  query: 200,
  id: 200,
  ref: 200,
  limit: 100,
  budgetChars: 100_000,
} as const;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function checkString(v: unknown, field: string, max: number, min = 1): string | null {
  if (typeof v !== 'string') return `${field} must be a string`;
  if (v.trim().length < min) return `${field} must be at least ${min} character(s)`;
  if (v.length > max) return `${field} exceeds ${max} characters`;
  return null;
}

function checkOptionalRef(v: unknown, field: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  const err = checkString(v, field, MEMORY_LIMITS.id);
  if (err) return fail(err);
  return { ok: true, value: v as string };
}

function isScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (MEMORY_SCOPES as readonly string[]).includes(v);
}

function isType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);
}

/** Primary reference required per scope (global has none — owner is 'system'). */
const SCOPE_REF: Record<MemoryScope, string | null> = {
  global: null,
  project: 'projectId',
  agent: 'agentId',
  task: 'taskId',
  computer: 'computerId',
};

export interface MemoryWriteInput {
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  projectId: string | null;
  agentId: string | null;
  taskId: string | null;
  computerId: string | null;
  importance: number | null;
  confidence: number | null;
  /** Epoch ms or null (explicit keep-forever). */
  expiresAt: number | null;
}

export function validateMemoryWrite(raw: unknown): ValidationResult<MemoryWriteInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('body must be an object');
  const o = raw as Record<string, unknown>;

  if (!isScope(o.scope)) return fail(`scope must be one of: ${MEMORY_SCOPES.join(', ')}`);
  if (!isType(o.type)) return fail(`type must be one of: ${MEMORY_TYPES.join(', ')}`);

  const contentErr = checkString(o.content, 'content', MEMORY_LIMITS.content);
  if (contentErr) return fail(contentErr);

  const projectId = checkOptionalRef(o.projectId, 'projectId');
  if (!projectId.ok) return projectId;
  const agentId = checkOptionalRef(o.agentId, 'agentId');
  if (!agentId.ok) return agentId;
  const taskId = checkOptionalRef(o.taskId, 'taskId');
  if (!taskId.ok) return taskId;
  const computerId = checkOptionalRef(o.computerId, 'computerId');
  if (!computerId.ok) return computerId;

  // The scope's primary reference is mandatory (it becomes the ownerId).
  const primary = SCOPE_REF[o.scope];
  if (primary && !(o[primary] !== undefined && o[primary] !== null && String(o[primary]).trim().length > 0)) {
    return fail(`${primary} is required for scope '${o.scope}'`);
  }

  let importance: number | null = null;
  if (o.importance !== undefined && o.importance !== null) {
    if (typeof o.importance !== 'number' || !Number.isFinite(o.importance)) return fail('importance must be a number');
    if (!Number.isInteger(o.importance) || o.importance < 0 || o.importance > 5) return fail('importance must be an integer 0..5');
    importance = o.importance;
  }

  let confidence: number | null = null;
  if (o.confidence !== undefined && o.confidence !== null) {
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence)) return fail('confidence must be a number');
    if (o.confidence < 0 || o.confidence > 1) return fail('confidence must be within 0..1');
    confidence = o.confidence;
  }

  let expiresAt: number | null = null;
  if (o.expiresAt !== undefined && o.expiresAt !== null) {
    if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return fail('expiresAt must be an epoch-ms number or null');
    if (o.expiresAt <= 0) return fail('expiresAt must be a positive epoch-ms number');
    expiresAt = o.expiresAt;
  }

  return {
    ok: true,
    value: {
      scope: o.scope,
      type: o.type,
      content: String(o.content),
      projectId: projectId.value,
      agentId: agentId.value,
      taskId: taskId.value,
      computerId: computerId.value,
      importance,
      confidence,
      expiresAt,
    },
  };
}

export function validateMemoryQuery(raw: unknown): ValidationResult<Record<string, unknown>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('query must be an object');
  const o = raw as Record<string, unknown>;

  if (o.query !== undefined && o.query !== null) {
    const err = checkString(o.query, 'query', MEMORY_LIMITS.query, 0);
    if (err) return fail(err);
  }
  if (o.scope !== undefined && o.scope !== null && !isScope(o.scope)) return fail(`scope must be one of: ${MEMORY_SCOPES.join(', ')}`);
  if (o.status !== undefined && o.status !== null) {
    if (o.status !== 'all' && !(typeof o.status === 'string' && (MEMORY_STATUSES as readonly string[]).includes(o.status))) {
      return fail(`status must be one of: ${MEMORY_STATUSES.join(', ')} or 'all'`);
    }
  }
  if (o.type !== undefined && o.type !== null && !isType(o.type)) return fail(`type must be one of: ${MEMORY_TYPES.join(', ')}`);
  for (const field of ['projectId', 'agentId', 'taskId'] as const) {
    const r = checkOptionalRef(o[field], field);
    if (!r.ok) return r;
  }
  if (o.limit !== undefined && o.limit !== null) {
    if (typeof o.limit !== 'number' || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > MEMORY_LIMITS.limit) {
      return fail(`limit must be an integer 1..${MEMORY_LIMITS.limit}`);
    }
  }
  if (o.budgetChars !== undefined && o.budgetChars !== null) {
    if (typeof o.budgetChars !== 'number' || !Number.isInteger(o.budgetChars) || o.budgetChars < 1 || o.budgetChars > MEMORY_LIMITS.budgetChars) {
      return fail(`budgetChars must be an integer 1..${MEMORY_LIMITS.budgetChars}`);
    }
  }
  return { ok: true, value: o };
}

export function validateMemoryRef(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fail('id must be a non-empty string');
  if (raw.length > MEMORY_LIMITS.id) return fail('id too long');
  return { ok: true, value: raw };
}

export interface MemoryEditInput {
  id: string;
  content: string | null;
  importance: number | null;
  confidence: number | null;
  /** number = new expiry, null = clear expiry, undefined = unchanged. */
  expiresAt: number | null | undefined;
}

/** Correction = a superseding write (content) and/or field updates. At least
 *  one field must be present. */
export function validateMemoryEdit(raw: unknown): ValidationResult<MemoryEditInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('body must be an object');
  const o = raw as Record<string, unknown>;
  const id = validateMemoryRef(o.id);
  if (!id.ok) return id;

  let content: string | null = null;
  if (o.content !== undefined && o.content !== null) {
    const err = checkString(o.content, 'content', MEMORY_LIMITS.content);
    if (err) return fail(err);
    content = String(o.content);
  }

  let importance: number | null = null;
  if (o.importance !== undefined && o.importance !== null) {
    if (typeof o.importance !== 'number' || !Number.isInteger(o.importance) || o.importance < 0 || o.importance > 5) {
      return fail('importance must be an integer 0..5');
    }
    importance = o.importance;
  }

  let confidence: number | null = null;
  if (o.confidence !== undefined && o.confidence !== null) {
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
      return fail('confidence must be within 0..1');
    }
    confidence = o.confidence;
  }

  let expiresAt: number | null | undefined;
  if (o.expiresAt === undefined) expiresAt = undefined;
  else if (o.expiresAt === null) expiresAt = null;
  else if (typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) && o.expiresAt > 0) expiresAt = o.expiresAt;
  else return fail('expiresAt must be an epoch-ms number or null');

  if (content === null && importance === null && confidence === null && expiresAt === undefined) {
    return fail('edit requires at least one of: content, importance, confidence, expiresAt');
  }
  return { ok: true, value: { id: id.value, content, importance, confidence, expiresAt } };
}
