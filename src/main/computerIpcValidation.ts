/**
 * Pure input validators for the `computer:*` IPC surface.
 *
 * House style (mirrors ceoIpcValidation.ts): everything arriving from the
 * renderer is `unknown`; these return a discriminated result — never throw.
 * Unit-tested under plain node with no Electron imports.
 */

import { COMPUTER_STATUSES, DEFAULT_COMPUTER_PERMISSIONS } from '../shared/computer';

export const COMPUTER_LIMITS = {
  /** Longest accepted url. */
  url: 2048,
  /** Longest accepted free-text id fields. */
  id: 128,
  /** Cap on cross-agent grant lists. */
  crossAgentGrants: 32,
  /** Longest homeUrl. */
  homeUrl: 2048,
} as const;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function checkId(raw: unknown, field: string): ValidationResult<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return fail(`${field} must be a non-empty string`);
  if (raw.length > COMPUTER_LIMITS.id) return fail(`${field} exceeds ${COMPUTER_LIMITS.id} characters`);
  return { ok: true, value: raw.trim() };
}

/** `{agentId, projectId?}` → create input. */
export function validateCreateComputer(raw: unknown): ValidationResult<{ agentId: string; projectId?: string }> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('body must be an object');
  const obj = raw as Record<string, unknown>;
  const agent = checkId(obj.agentId, 'agentId');
  if (!agent.ok) return agent;
  const out: { agentId: string; projectId?: string } = { agentId: agent.value };
  if (obj.projectId !== undefined && obj.projectId !== null) {
    const p = checkId(obj.projectId, 'projectId');
    if (!p.ok) return p;
    out.projectId = p.value;
  }
  return { ok: true, value: out };
}

/** `{id}` → computer id. */
export function validateComputerRef(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('body must be an object');
  return checkId((raw as Record<string, unknown>).id, 'id');
}

/** `{id, url?}` → open-browser input; URL scheme allow-listed (no file:, no javascript:). */
export function validateOpenBrowser(raw: unknown): ValidationResult<{ id: string; url?: string }> {
  const ref = validateComputerRef(raw);
  if (!ref.ok) return ref;
  const obj = raw as Record<string, unknown>;
  const out: { id: string; url?: string } = { id: ref.value };
  if (obj.url !== undefined && obj.url !== null) {
    const url = validateUrl(obj.url);
    if (!url.ok) return url;
    out.url = url.value;
  }
  return { ok: true, value: out };
}

/** `{id, url}` → navigate input. */
export function validateNavigate(raw: unknown): ValidationResult<{ id: string; url: string }> {
  const open = validateOpenBrowser(raw);
  if (!open.ok) return open;
  if (open.value.url === undefined) return fail('url is required');
  return { ok: true, value: { id: open.value.id, url: open.value.url } };
}

/** Free-form URL for browser ops: http(s)/about only, bounded length. */
export function validateUrl(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return fail('url must be a non-empty string');
  const url = raw.trim();
  if (url.length > COMPUTER_LIMITS.url) return fail(`url exceeds ${COMPUTER_LIMITS.url} characters`);
  if (!/^(https?:\/\/|about:)/i.test(url)) return fail('url scheme must be http(s) or about');
  return { ok: true, value: url };
}

/** `{id, on}` → watch input. */
export function validateWatch(raw: unknown): ValidationResult<{ id: string; on: boolean }> {
  const ref = validateComputerRef(raw);
  if (!ref.ok) return ref;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.on !== 'boolean') return fail('on must be a boolean');
  return { ok: true, value: { id: ref.value, on: obj.on } };
}

/** `{id, confirm?}` → dispose input. */
export function validateDispose(raw: unknown): ValidationResult<{ id: string; confirm: boolean }> {
  const ref = validateComputerRef(raw);
  if (!ref.ok) return ref;
  const obj = raw as Record<string, unknown>;
  return { ok: true, value: { id: ref.value, confirm: obj.confirm === true } };
}

/**
 * `{id, permissions?, persistencePolicy?}` → configure input.
 * Only known boolean caps and string grant lists survive (shape-checked,
 * no prototype pollution, bounded lists).
 */
export function validateConfigure(raw: unknown): ValidationResult<{
  id: string;
  permissions?: {
    agent?: Partial<typeof DEFAULT_COMPUTER_PERMISSIONS.agent>;
    user?: Partial<typeof DEFAULT_COMPUTER_PERMISSIONS.user>;
  };
  persistencePolicy?: 'retain' | 'dispose';
}> {
  const ref = validateComputerRef(raw);
  if (!ref.ok) return ref;
  const obj = raw as Record<string, unknown>;
  const out: {
    id: string;
    permissions?: {
      agent?: Partial<typeof DEFAULT_COMPUTER_PERMISSIONS.agent>;
      user?: Partial<typeof DEFAULT_COMPUTER_PERMISSIONS.user>;
    };
    persistencePolicy?: 'retain' | 'dispose';
  } = { id: ref.value };

  if (obj.persistencePolicy !== undefined) {
    if (obj.persistencePolicy !== 'retain' && obj.persistencePolicy !== 'dispose') {
      return fail('persistencePolicy must be retain or dispose');
    }
    out.persistencePolicy = obj.persistencePolicy;
  }

  if (obj.permissions !== undefined) {
    if (typeof obj.permissions !== 'object' || obj.permissions === null || Array.isArray(obj.permissions)) {
      return fail('permissions must be an object');
    }
    const p = obj.permissions as Record<string, unknown>;
    const perms: NonNullable<typeof out.permissions> = {};
    if (p.agent !== undefined) {
      if (typeof p.agent !== 'object' || p.agent === null || Array.isArray(p.agent)) return fail('permissions.agent must be an object');
      const a: Record<string, unknown> = {};
      const src = p.agent as Record<string, unknown>;
      for (const key of ['terminalExec', 'browserNav', 'browserDownloads', 'network', 'externalActions'] as const) {
        if (src[key] !== undefined) {
          if (typeof src[key] !== 'boolean') return fail(`permissions.agent.${key} must be a boolean`);
          a[key] = src[key];
        }
      }
      for (const key of ['crossAgentRead', 'crossAgentWrite'] as const) {
        if (src[key] !== undefined) {
          const list = src[key];
          if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
            return fail(`permissions.agent.${key} must be an array of strings`);
          }
          if (list.length > COMPUTER_LIMITS.crossAgentGrants) {
            return fail(`permissions.agent.${key} exceeds ${COMPUTER_LIMITS.crossAgentGrants} entries`);
          }
          if ((list as string[]).some((x) => x.length > COMPUTER_LIMITS.id)) {
            return fail(`permissions.agent.${key} contains an over-long id`);
          }
          a[key] = list;
        }
      }
      perms.agent = a as Partial<typeof DEFAULT_COMPUTER_PERMISSIONS.agent>;
    }
    if (p.user !== undefined) {
      if (typeof p.user !== 'object' || p.user === null || Array.isArray(p.user)) return fail('permissions.user must be an object');
      const u: Record<string, unknown> = {};
      const src = p.user as Record<string, unknown>;
      for (const key of ['screenView', 'screenControl'] as const) {
        if (src[key] !== undefined) {
          if (typeof src[key] !== 'boolean') return fail(`permissions.user.${key} must be a boolean`);
          u[key] = src[key];
        }
      }
      perms.user = u as Partial<typeof DEFAULT_COMPUTER_PERMISSIONS.user>;
    }
    if (perms.agent || perms.user) out.permissions = perms;
  }
  return { ok: true, value: out };
}

/** Status guard used by tests and the renderer contract. */
export function isComputerStatus(v: unknown): boolean {
  return typeof v === 'string' && (COMPUTER_STATUSES as readonly string[]).includes(v);
}
