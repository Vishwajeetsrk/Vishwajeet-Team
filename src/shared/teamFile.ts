/**
 * PRD-4 — portable team files ("one .md installs a team").
 *
 * Format: YAML-ish frontmatter (spec / name / members) fenced by `---`, then a
 * freeform Markdown playbook the importer ignores. A deliberate SUBSET of YAML
 * (scalars, one nested list-of-maps) parsed here with zero dependencies — a
 * full YAML engine is an attack surface this file does not need.
 *
 * Guarantees:
 *  - Export strips secrets by construction (members only carry name/role/
 *    provider/skills — never env, keys or tokens).
 *  - Import strips+REPORTS any secret-shaped field it finds; values never
 *    reach the returned team.
 *  - Nothing in a file spawns: members convert to hire manifests that go
 *    through the existing review-gated Add-Agent flow (validateHireManifest),
 *    one member at a time, and the importer never creates missions at all —
 *    scheduled work arrives paused by omission.
 */
import {
  BUNDLED_SKILL_IDS,
  HIRE_SPEC_V1,
  validateHireManifest,
  type HireManifest,
  type HireProvider
} from './hire';
import { roleById, type SpecialistRoleId } from './workforce';

export const TEAM_FILE_SPEC = 'vishwajeet-team/file@1';
export const TEAM_FILE_MAX_BYTES = 256 * 1024;
export const TEAM_MAX_MEMBERS = 25;

const SECRET_KEY_RE = /(secret|token|password|passwd|api[-_]?key|credential|authorization|bearer)/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}$/;
const PROVIDERS: readonly string[] = ['claude', 'antigravity', 'codex', 'cursor'];

export interface TeamMemberSpec {
  /** Display name (required). */
  name: string;
  /** One-line role, lands in the hire description. */
  description?: string;
  /** Standing goal text. */
  goal?: string;
  provider?: HireProvider;
  /** Workforce specialist role id (routing hint). */
  role?: SpecialistRoleId;
  /** Bundled skill ids only (same allowlist as hire manifests). */
  skills?: string[];
}

export interface TeamFileSpec {
  spec: typeof TEAM_FILE_SPEC;
  name: string;
  members: TeamMemberSpec[];
}

export interface TeamParseResult {
  ok: boolean;
  team?: TeamFileSpec;
  errors: string[];
  /** Secret-shaped KEY NAMES found and stripped (values are never returned). */
  strippedKeys: string[];
}

/** Deep-copy `value` without any secret-shaped keys; names of what was
 *  dropped come back in `strippedKeys` (names only — never the values). */
export function stripSecrets(value: unknown): { clean: unknown; strippedKeys: string[] } {
  const strippedKeys: string[] = [];
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k)) { strippedKeys.push(k); continue; }
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return { clean: walk(value), strippedKeys };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function scalar(raw: string): string | boolean | string[] {
  const v = unquote(raw);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.includes(',')) return v.split(',').map((x) => unquote(x)).filter(Boolean);
  return v;
}

/** Parse the frontmatter block (already stripped of the fences) into a raw
 *  object: top-level scalars + a `members` list-of-maps at 2-space indent. */
function parseFrontmatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let members: Array<Record<string, unknown>> | null = null;
  let current: Record<string, unknown> | null = null;
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const listMatch = /^ {2}-\s+(\w[\w-]*):\s*(.*)$/.exec(rawLine);
    if (listMatch) {
      if (!members) { members = []; out.members = members; }
      current = { [listMatch[1]]: scalar(listMatch[2]) };
      members.push(current);
      continue;
    }
    const nested = /^ {4}(\w[\w-]*):\s*(.*)$/.exec(rawLine);
    if (nested && current) {
      current[nested[1]] = scalar(nested[2]);
      continue;
    }
    const top = /^(\w[\w-]*):\s*(.*)$/.exec(rawLine);
    if (top) {
      current = null;
      if (top[1] === 'members') { members = members ?? []; out.members = members; continue; }
      out[top[1]] = scalar(top[2]);
    }
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Parse + validate a team file. Errors are human-readable and field-scoped;
 *  `ok` is false whenever `team` is absent. */
export function parseTeamFile(md: string): TeamParseResult {
  const errors: string[] = [];
  if (Buffer.byteLength(md, 'utf8') > TEAM_FILE_MAX_BYTES) {
    return { ok: false, errors: ['team file too large'], strippedKeys: [] };
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return { ok: false, errors: ['missing --- frontmatter block'], strippedKeys: [] };

  const { clean, strippedKeys } = stripSecrets(parseFrontmatter(m[1]));
  const raw = clean as Record<string, unknown>;

  if (raw.spec !== TEAM_FILE_SPEC) errors.push(`spec must be ${TEAM_FILE_SPEC}`);
  const name = asString(raw.name);
  if (!name || name.length > 80) errors.push('name is required (1-80 chars)');

  const membersRaw = Array.isArray(raw.members) ? raw.members : [];
  if (membersRaw.length === 0) errors.push('at least one member is required');
  if (membersRaw.length > TEAM_MAX_MEMBERS) errors.push(`at most ${TEAM_MAX_MEMBERS} members`);

  const members: TeamMemberSpec[] = [];
  membersRaw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') { errors.push(`members[${i}]: not a map`); return; }
    const e = entry as Record<string, unknown>;
    const memberName = asString(e.name);
    if (!memberName || !NAME_RE.test(memberName)) {
      errors.push(`members[${i}]: name required (letters/digits/space/_-., max 40)`);
      return;
    }
    const provider = asString(e.provider);
    if (provider && !PROVIDERS.includes(provider)) {
      errors.push(`members[${i}]: provider must be one of ${PROVIDERS.join('/')}`);
      return;
    }
    const role = asString(e.role);
    if (role && !roleById(role)) {
      errors.push(`members[${i}]: unknown role '${role}'`);
      return;
    }
    const skillsIn = Array.isArray(e.skills) ? e.skills.map(String) : typeof e.skills === 'string' ? [e.skills] : [];
    const skills = skillsIn.filter((s) => {
      if (BUNDLED_SKILL_IDS.has(s)) return true;
      errors.push(`members[${i}]: skill '${s}' is not bundled`);
      return false;
    });
    const description = asString(e.description);
    const goal = asString(e.goal);
    if (description && description.length > 200) errors.push(`members[${i}]: description too long`);
    if (goal && goal.length > 2000) errors.push(`members[${i}]: goal too long`);
    members.push({
      name: memberName,
      ...(description ? { description } : {}),
      ...(goal ? { goal } : {}),
      ...(provider ? { provider: provider as HireProvider } : {}),
      ...(role ? { role: role as SpecialistRoleId } : {}),
      ...(skills.length ? { skills } : {})
    });
  });

  if (errors.length) return { ok: false, errors, strippedKeys };
  return { ok: true, team: { spec: TEAM_FILE_SPEC, name: name!, members }, errors, strippedKeys };
}

/** Serialize a team to the portable .md. Members carry no secrets by shape;
 *  stripSecrets runs anyway so the guarantee is structural, not hopeless.
 *  Free-text fields are collapsed to one line each — the frontmatter subset
 *  is line-based and a embedded newline would silently truncate the value. */
export function serializeTeamFile(team: TeamFileSpec): string {
  const { clean } = stripSecrets(team);
  const t = clean as TeamFileSpec;
  const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim();
  const lines: string[] = ['---', `spec: ${t.spec}`, `name: ${oneLine(t.name)}`, 'members:'];
  for (const m of t.members) {
    lines.push(`  - name: ${oneLine(m.name)}`);
    if (m.description) lines.push(`    description: ${oneLine(m.description)}`);
    if (m.goal) lines.push(`    goal: ${oneLine(m.goal)}`);
    if (m.provider) lines.push(`    provider: ${m.provider}`);
    if (m.role) lines.push(`    role: ${m.role}`);
    if (m.skills?.length) lines.push(`    skills: ${m.skills.join(', ')}`);
  }
  lines.push('---', '');
  lines.push(`# ${t.name}`, '');
  lines.push('Imported members arrive idle and paused: each one opens in the');
  lines.push('Add-Agent review screen, and no schedule or mission is created');
  lines.push('from this file until you create it yourself.', '');
  return lines.join('\n');
}

/** Convert a member to a hire manifest and run it through the SAME
 *  validator the deep-link/file import path uses. Returns the validated
 *  manifest (or the errors) — the caller never spawns from this. */
export function teamMemberToHireManifest(
  member: TeamMemberSpec
): { ok: boolean; manifest?: HireManifest; errors: string[] } {
  const caps = member.role ? [member.role] : [];
  const raw = {
    spec: HIRE_SPEC_V1,
    name: member.name,
    ...(member.description ? { description: member.description } : {}),
    ...(member.goal ? { goal: member.goal } : {}),
    ...(member.provider ? { provider: member.provider } : {}),
    ...(member.skills?.length ? { skills: member.skills } : {}),
    ...(caps.length ? { capabilities: caps } : {})
  };
  const v = validateHireManifest(raw);
  return { ok: v.ok, ...(v.manifest ? { manifest: v.manifest } : {}), errors: v.errors };
}
