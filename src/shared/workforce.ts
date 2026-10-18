/**
 * Workforce catalog — specialist roles + capability-first selection (Orbit M4).
 *
 * Dependency-free, shared by main + renderer + tests. A *role* is a curated
 * capability template (responsibilities, skills, tools, default engine,
 * working scopes, permission set). A *profile* binds a role to a concrete
 * provider + model — ONLY a configured profile is a functioning agent.
 * Unconfigured profiles are visibly inert: listed with their missing piece,
 * never selected, never dispatched.
 *
 * Relationship to agentSelection.ts: that module matches live agents by
 * idle-status first (the legacy CEO path, untouched). This module matches by
 * CAPABILITY first — a capable busy specialist outranks an idle incapable one —
 * with availability as a tiebreak. Permission ids are M1 rule ids
 * (src/shared/actionPolicy.ts); unknown ids fail validation, never silently.
 */

import type { HireManifest, HireProvider } from './hire';
import type { AgentProvider } from './agentProvider';

export type SpecialistRoleId =
  | 'researcher'
  | 'engineer'
  | 'designer'
  | 'qa'
  | 'devops'
  | 'content-seo'
  | 'data-analyst'
  | 'ops';

export interface SpecialistRole {
  id: SpecialistRoleId;
  label: string;
  /** What this specialist owns, in plain operator language. */
  responsibilities: string[];
  /** Capability tags goals match against (normalized lowercase on compare). */
  skills: string[];
  /** CLI tool names this specialist is expected to wield. */
  tools: string[];
  /** Sane default engine; the profile may override. */
  defaultProvider: HireProvider;
  /** Working scopes, e.g. 'repo', 'web', 'docs', 'infra'. */
  scopes: string[];
  /** M1 rule ids this role may exercise (subset contract, enforced at match). */
  permissions: string[];
}

/** M1 rule ids a workforce role may reference. Unknown ids fail validation. */
export const WORKFORCE_PERMISSION_IDS: readonly string[] = [
  'catalog:hive-safe',
  'catalog:hive-mutating',
  'catalog:hive-bash',
  'catalog:hive-external',
  'catalog:integration',
  'catalog:memory',
  'computer:readonly',
  'computer:sensitive'
];

const HIRE_PROVIDERS: readonly HireProvider[] = ['claude', 'antigravity', 'codex', 'cursor'];

export const SPECIALIST_CATALOG: readonly SpecialistRole[] = [
  {
    id: 'researcher',
    label: 'Researcher',
    responsibilities: [
      'Answer open questions with sourced evidence, not vibes.',
      'Fact-check claims against primary sources before they ship.'
    ],
    skills: ['web-research', 'fact-check', 'summarize', 'compare-sources'],
    tools: ['WebFetch', 'WebSearch', 'Read', 'TodoWrite'],
    defaultProvider: 'claude',
    scopes: ['web', 'docs'],
    permissions: ['catalog:hive-safe', 'catalog:hive-external', 'catalog:memory']
  },
  {
    id: 'engineer',
    label: 'Engineer',
    responsibilities: [
      'Implement features and fix bugs in the repo.',
      'Debug failures to root cause, then patch with tests.'
    ],
    skills: ['code-write', 'debug', 'code-review', 'refactor', 'test-write'],
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite'],
    defaultProvider: 'claude',
    scopes: ['repo'],
    permissions: ['catalog:hive-mutating', 'catalog:hive-bash']
  },
  {
    id: 'designer',
    label: 'Designer',
    responsibilities: [
      'Own look, layout, and copy tone for surfaces.',
      'Produce assets and pixel-spec guidance engineers can build from.'
    ],
    skills: ['ui-design', 'copy-write', 'asset-make', 'layout'],
    tools: ['Read', 'Write', 'Edit', 'WebFetch'],
    defaultProvider: 'claude',
    scopes: ['repo', 'docs'],
    permissions: ['catalog:hive-safe', 'catalog:hive-mutating']
  },
  {
    id: 'qa',
    label: 'QA',
    responsibilities: [
      'Verify behavior against acceptance criteria before sign-off.',
      'Reproduce reported bugs minimally, then confirm the fix.'
    ],
    skills: ['test-plan', 'reproduce-bug', 'verify-fix', 'regression-check'],
    tools: ['Read', 'Bash', 'Grep', 'TodoWrite'],
    defaultProvider: 'codex',
    scopes: ['repo'],
    permissions: ['catalog:hive-safe', 'catalog:hive-bash', 'computer:readonly']
  },
  {
    id: 'devops',
    label: 'DevOps',
    responsibilities: [
      'Keep builds green and deploys boring.',
      'Own CI, environments, and release plumbing.'
    ],
    skills: ['ci-debug', 'deploy', 'env-manage', 'log-triage'],
    tools: ['Read', 'Bash', 'Edit', 'WebFetch', 'TodoWrite'],
    defaultProvider: 'codex',
    scopes: ['repo', 'infra'],
    permissions: ['catalog:hive-bash', 'catalog:hive-external', 'computer:sensitive']
  },
  {
    id: 'content-seo',
    label: 'Content & SEO',
    responsibilities: [
      'Write pages and posts that rank and read well.',
      'Keep metadata, slugs, and internal links coherent.'
    ],
    skills: ['seo-write', 'keyword-map', 'meta-write', 'content-edit'],
    tools: ['Read', 'Write', 'Edit', 'WebSearch', 'WebFetch'],
    defaultProvider: 'antigravity',
    scopes: ['docs', 'web'],
    permissions: ['catalog:hive-safe', 'catalog:hive-external', 'catalog:hive-mutating']
  },
  {
    id: 'data-analyst',
    label: 'Data Analyst',
    responsibilities: [
      'Turn raw exports into answered questions.',
      'Build repeatable summaries over local data, never exfiltrated.'
    ],
    skills: ['data-clean', 'summarize-data', 'chart-spec', 'sql-read'],
    tools: ['Read', 'Bash', 'Grep', 'TodoWrite'],
    defaultProvider: 'claude',
    scopes: ['repo'],
    permissions: ['catalog:hive-safe', 'catalog:hive-bash', 'catalog:memory']
  },
  {
    id: 'ops',
    label: 'Ops',
    responsibilities: [
      'Run the office: schedules, triggers, integrations, follow-through.',
      'Escalate to the human when authority, money, or secrets are involved.'
    ],
    skills: ['schedule-ops', 'integration-ops', 'follow-through', 'escalate'],
    tools: ['Read', 'Bash', 'WebFetch', 'TodoWrite', 'MCP'],
    defaultProvider: 'claude',
    scopes: ['repo', 'infra', 'docs'],
    permissions: ['catalog:hive-safe', 'catalog:hive-mutating', 'catalog:integration', 'catalog:memory']
  }
];

export function roleById(id: string): SpecialistRole | undefined {
  return SPECIALIST_CATALOG.find((r) => r.id === id);
}

/**
 * A role bound to a concrete engine. `configured` is DERIVED, never stored:
 * provider + model present ⇒ functioning agent; anything missing ⇒ visibly
 * inert (listed with its gap, never selected, never dispatched).
 */
export interface WorkforceProfile {
  id: string;
  name: string;
  roleId: SpecialistRoleId;
  /** Any of the 12 engines (roster agents) or the 4 hire providers. */
  provider?: HireProvider | AgentProvider;
  model?: string;
  tools?: string[];
  /** Extra capability tags beyond the role's own (rare; role carries the rest). */
  skills?: string[];
  scopes?: string[];
  /** Token budget ceiling for this profile (mirrors hire tokenCap). */
  tokenCap?: number;
}

export function isProfileConfigured(p: WorkforceProfile): boolean {
  return !!p.provider && !!p.model && !!roleById(p.roleId);
}

/** Why an unconfigured profile is inert — shown in the UI, never empty. */
export function inertReason(p: WorkforceProfile): string | null {
  if (isProfileConfigured(p)) return null;
  const missing: string[] = [];
  if (!roleById(p.roleId)) missing.push(`unknown role '${p.roleId}'`);
  if (!p.provider) missing.push('no provider');
  if (!p.model) missing.push('no model');
  return `inert: ${missing.join(', ')} — configure it before dispatch`;
}

export interface SpecialistRequirements {
  roles?: SpecialistRoleId[];
  skills?: string[];
  tools?: string[];
  requiredPermissions?: string[];
}

export interface SpecialistCandidate {
  profile: WorkforceProfile;
  role: SpecialistRole;
  /** Idle right now. Capability decides; availability only tie-breaks. */
  available: boolean;
}

export interface SpecialistSelection {
  selected: SpecialistCandidate | null;
  reason: string;
  alternatives: SpecialistCandidate[];
}

const norm = (s: string): string => s.trim().toLowerCase();

function scoreCandidate(c: SpecialistCandidate, req: SpecialistRequirements): number {
  // PRD-3: cheapest disqualifier first — a permission mismatch exits before
  // any set-building or skill loops run.
  if (req.requiredPermissions) {
    const have = new Set(c.role.permissions);
    if (!req.requiredPermissions.every((p) => have.has(p))) {
      return -100; // cannot satisfy a required permission: out, loudly
    }
  }
  let score = req.requiredPermissions ? 5 : 0;
  if (req.roles?.some((r) => r === c.role.id)) score += 10;
  if (req.skills) {
    const have = new Set(c.role.skills.map(norm));
    const mine = new Set((c.profile.skills ?? []).map(norm));
    for (const s of req.skills) {
      if (have.has(norm(s)) || mine.has(norm(s))) score += 3;
    }
  }
  if (req.tools) {
    const have = new Set([...c.role.tools, ...(c.profile.tools ?? [])].map(norm));
    for (const t of req.tools) if (have.has(norm(t))) score += 2;
  }
  // Availability is a tiebreak, never a match: it only counts when some
  // capability already scored. Otherwise any idle profile would "match" a
  // requirement it cannot satisfy.
  if (c.available && score > 0) score += 1;
  return score;
}

/**
 * Capability-first selection. Unconfigured profiles and permission-mismatched
 * profiles are never selected; when nothing qualifies the reason names the
 * gap (no configured specialist vs no capability match) so the operator knows
 * whether to configure a profile or broaden the requirement.
 */
export function selectSpecialistForTask(
  candidates: SpecialistCandidate[],
  requirements: SpecialistRequirements
): SpecialistSelection {
  const configured = candidates.filter(
    (c) => isProfileConfigured(c.profile) && roleById(c.profile.roleId) !== undefined
  );
  if (configured.length === 0) {
    return {
      selected: null,
      reason: 'No configured specialist: every profile is inert (missing provider, model, or role)',
      alternatives: []
    };
  }
  const eligible = configured.filter((c) => scoreCandidate(c, requirements) > -100);
  if (eligible.length === 0) {
    return {
      selected: null,
      reason: 'No configured specialist holds the required permissions',
      alternatives: [...configured].slice(0, 4)
    };
  }
  const scored = eligible
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, requirements) }))
    .sort((a, b) => b.score - a.score || (a.candidate.profile.id < b.candidate.profile.id ? -1 : 1));
  const hasConstraints =
    (requirements.roles?.length ?? 0) > 0 ||
    (requirements.skills?.length ?? 0) > 0 ||
    (requirements.tools?.length ?? 0) > 0 ||
    (requirements.requiredPermissions?.length ?? 0) > 0;
  const best = scored[0];
  if (best.score <= 0 && hasConstraints) {
    return {
      selected: null,
      reason: `No specialist matches (closest: ${best.candidate.role.label} '${best.candidate.profile.name}')`,
      alternatives: scored.slice(0, 4).map((s) => s.candidate)
    };
  }
  return {
    selected: best.candidate,
    reason: `Best match: ${best.candidate.role.label} '${best.candidate.profile.name}' (score=${best.score})`,
    alternatives: scored.slice(1, 5).map((s) => s.candidate)
  };
}

/** Profiles that must render inert, each with its reason. */
export function inertProfiles(
  profiles: WorkforceProfile[]
): Array<{ profile: WorkforceProfile; reason: string }> {
  return profiles
    .filter((p) => !isProfileConfigured(p))
    .map((profile) => ({ profile, reason: inertReason(profile) ?? 'inert' }));
}

/** Full-catalog validation (contract tests + registration-time). */
export function validateWorkforceCatalog(
  roles: readonly SpecialistRole[] = SPECIALIST_CATALOG
): { ok: true } | { ok: false; error: string } {
  const ids = new Set<string>();
  for (const r of roles) {
    if (!r.id || ids.has(r.id)) return { ok: false, error: `duplicate or empty role id '${r.id}'` };
    ids.add(r.id);
    if (!r.label?.trim()) return { ok: false, error: `${r.id}: label required` };
    if (!r.responsibilities?.length) return { ok: false, error: `${r.id}: responsibilities required` };
    if (!r.skills?.length) return { ok: false, error: `${r.id}: skills required` };
    if (!HIRE_PROVIDERS.includes(r.defaultProvider)) {
      return { ok: false, error: `${r.id}: bad defaultProvider '${r.defaultProvider}'` };
    }
    for (const p of r.permissions ?? []) {
      if (!WORKFORCE_PERMISSION_IDS.includes(p)) return { ok: false, error: `${r.id}: unknown permission '${p}'` };
    }
  }
  return { ok: true };
}

// ─── Hire bridge: manifests become selectable profiles ──────────────────────
// A hire manifest already carries name + provider + model + goal: everything a
// profile needs except the role. inferRoleForHire scores the manifest's own
// words against role labels/skills/responsibilities — deterministic token
// overlap, ties and zeroes return null (no confident match beats a wrong
// role). A manifest without provider/model still converts: it lands INERT
// with its gap named, exactly like an unconfigured roster profile.

function roleTokens(r: SpecialistRole): Set<string> {
  const words = new Set<string>();
  // The role id itself is a signal ('qa', 'seo', 'ops' are real words people
  // type, so id tokens keep length-2 entries the generic filter would drop).
  const feed = [r.id.replace(/-/g, ' '), r.label, ...r.skills, ...r.responsibilities.join(' ')];
  for (const s of feed) {
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length > 2 || r.id.split('-').includes(w)) words.add(w);
    }
  }
  return words;
}

// PRD-3 fast match: role token sets are static, so build them once at module
// load instead of per inference (8 roles × tokenize, every call). The map is
// frozen — SPECIALIST_CATALOG never mutates at runtime.
const ROLE_TOKENS: ReadonlyMap<SpecialistRoleId, ReadonlySet<string>> = (() => {
  const m = new Map<SpecialistRoleId, ReadonlySet<string>>();
  for (const r of SPECIALIST_CATALOG) m.set(r.id, roleTokens(r));
  return m;
})();

// Inference cache: roster descriptions repeat verbatim across polls, tab
// renders, and match-tester keystrokes. Keyed on the exact input pair.
const inferCache = new Map<string, SpecialistRoleId | null>();
const inferStats = { hits: 0, misses: 0 };

/** Cache observability for perf debugging (hits/misses since load or clear). */
export function workforceMatchStats(): { hits: number; misses: number; size: number } {
  return { hits: inferStats.hits, misses: inferStats.misses, size: inferCache.size };
}

/** Reset the inference cache (tests; rare catalog-adjacent flows). */
export function clearWorkforceMatchCache(): void {
  inferCache.clear();
  inferStats.hits = 0;
  inferStats.misses = 0;
}

/** Best-guess role for a hire manifest, or null when nothing clearly matches. */
export function inferRoleForHire(description?: string, goal?: string): SpecialistRoleId | null {
  const key = `${description ?? ''}\n${goal ?? ''}`;
  const cached = inferCache.get(key);
  if (cached !== undefined) { inferStats.hits++; return cached; }
  inferStats.misses++;
  const result = inferRoleUncached(description, goal);
  inferCache.set(key, result);
  return result;
}

function inferRoleUncached(description?: string, goal?: string): SpecialistRoleId | null {
  const hay = `${description ?? ''} ${goal ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (hay.length === 0) return null;
  let best: SpecialistRoleId | null = null;
  let bestScore = 0;
  let tied = false;
  for (const r of SPECIALIST_CATALOG) {
    const toks = ROLE_TOKENS.get(r.id) ?? roleTokens(r);
    let score = 0;
    for (const w of hay) {
      if (toks.has(w)) { score++; continue; }
      // Light stemming both directions ('writer'↔'write',
      // 'reproduces'↔'reproduce'), min 4 chars so 'qa'/'seo' style shorts
      // only ever match exactly. One point per hay word, never more.
      if (w.length >= 4) {
        for (const t of toks) {
          if (t.length >= 4 && (t.startsWith(w) || w.startsWith(t))) { score++; break; }
        }
      }
    }
    if (score > bestScore) { bestScore = score; best = r.id; tied = false; }
    else if (score === bestScore && score > 0) tied = true;
  }
  if (!best || bestScore <= 0 || tied) return null;
  return best;
}

function slugifyName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'hire';
}

/** A validated hire manifest as a workforce profile. Never throws: without a
 *  confident role the profile is inert (reason names it), without
 *  provider/model it is inert (reason names the gap) — both visible, neither
 *  selectable, until the operator completes them. */
export function workforceProfileFromHire(manifest: HireManifest): {
  profile: WorkforceProfile | null;
  inferredRole: SpecialistRoleId | null;
  reason: string;
} {  const inferredRole = inferRoleForHire(manifest.description, manifest.goal);
  if (!inferredRole) {
    return { profile: null, inferredRole, reason: 'inert: no confident role match for this hire' };
  }
  const profile: WorkforceProfile = {
    id: `hire-${slugifyName(manifest.name)}`,
    name: manifest.name,
    roleId: inferredRole,
    ...(manifest.provider ? { provider: manifest.provider } : {}),
    ...(manifest.model ? { model: manifest.model } : {}),
    ...(manifest.tokenCap ? { tokenCap: manifest.tokenCap } : {})
  };
  if (!isProfileConfigured(profile)) {
    return { profile, inferredRole, reason: inertReason(profile) ?? 'inert' };
  }
  const role = roleById(inferredRole);
  return { profile, inferredRole, reason: `ready: ${role?.label ?? inferredRole} '${profile.name}'` };
}

// ─── Creation staffing: everything a new agent needs ────────────────────────
// Called on EVERY spawn (UI hires, CEO dispatches, voice spawns) before the
// registry write, so no agent enters the floor without a role verdict and a
// capability set. Explicit capabilities always win; otherwise the inferred
// role's skills land on the record (registry + prompt). Never blocks the
// spawn — an unknown role spawns anyway with its capabilities empty and the
// reason logged, because staffing must advise creation, never veto it.

export interface StaffingInput {
  /** The role/description text the hire came with (may be undefined). */
  role?: string;
  /** Resolved engine (already defaulted by the spawn path — any of the 12). */
  provider?: HireProvider | AgentProvider;
  /** Explicit capability tags, when the caller set any. */
  capabilities?: string[];
}

export interface StaffingResult {
  inferredRole: SpecialistRoleId | null;
  /** What lands on the agent record. */
  capabilities: string[];
  /** Role known AND engine present: the agent has everything it needs. */
  staffed: boolean;
  reason: string;
}

export function staffNewAgent(input: StaffingInput): StaffingResult {
  const inferredRole = inferRoleForHire(input.role);
  const explicit = (input.capabilities ?? []).map((s) => s.trim()).filter(Boolean);
  if (explicit.length > 0) {
    const staffed = inferredRole !== null && !!input.provider;
    return {
      inferredRole,
      capabilities: [...new Set(explicit)],
      staffed,
      reason: staffed
        ? `staffed: explicit capabilities kept${inferredRole ? ` (${roleById(inferredRole)?.label})` : ''}`
        : `unstaffed: ${!inferredRole ? 'unknown role' : 'no provider'} (explicit capabilities kept anyway)`
    };
  }
  if (!inferredRole) {
    return { inferredRole, capabilities: [], staffed: false, reason: 'unstaffed: unknown role — no capability set inferred' };
  }
  const role = roleById(inferredRole);
  const capabilities = [...(role?.skills ?? [])];
  const staffed = !!input.provider;
  return {
    inferredRole,
    capabilities,
    staffed,
    reason: staffed
      ? `staffed: ${role?.label} with ${capabilities.length} role skills`
      : 'unstaffed: no provider — role inferred, engine missing'
  };
}
