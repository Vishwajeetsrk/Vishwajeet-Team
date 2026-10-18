/**
 * PRD-9 — capabilities browser data model (the "free marketplace").
 *
 * Our take on the capabilities pattern: ONE list, no paywall, no wave tiers —
 * everything an agent could use is either 'bundled' (ships with the app,
 * reviewed by us) or 'office' (a hand-maintained catalog file this workspace
 * contributes, listed by us but reviewable on arrival). Both rows install
 * freely; the difference is only a badge and a slightly louder footer for the
 * office rows.
 *
 * Pure data: no imports. Main + renderer + tests all load this file.
 */

export type CapKind = 'mcp-server' | 'skill' | 'tool';

export interface CapEntry {
  id: string;
  name: string;
  kind: CapKind;
  what: string;
  maker?: string;
  can: { reads: boolean; writes: boolean; sends: boolean; spends: boolean; deletes: boolean };
  /** 'toggle' = one switch flips it into every next agent spawn (MCP);
   *  'manual' = shows the steps instead of pretending to press a button. */
  install: 'toggle' | 'manual';
  /** The steps for a 'manual' row — plain, honest, agent-friend safe. */
  manual?: string[];
  source: 'bundled' | 'office';
}

/** The id charset the local catalog allows (path-safety: ids end up as
 *  `mcpDefaults` keys and file-ish names nothing else). */
const ID_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const CAN_OFF = { reads: false, writes: false, sends: false, spends: false, deletes: false };

const cap = (
  id: string,
  name: string,
  kind: CapKind,
  what: string,
  can: Partial<CapEntry['can']>,
  install: CapEntry['install'],
  manual?: string[]
): CapEntry => ({
  id, name, kind, what, install, manual,
  can: { ...CAN_OFF, ...can },
  source: 'bundled'
});

/** The bundled marketplace — derived from the real MCP catalog + the skills
 *  and helper CLIs the app actually ships. Nothing here is decorative: every
 *  row names a real file/flag this build carries. */
export function bundledCapabilities(): CapEntry[] {
  return [
    cap('mcp-sequential-thinking', 'Sequential Thinking', 'mcp-server',
      'Structured step-by-step reasoning scratchpad. No I/O, no secrets.',
      {}, 'toggle'),
    cap('mcp-time', 'Time', 'mcp-server', 'Current time and timezone conversions.', {}, 'toggle'),
    cap('mcp-fetch', 'Fetch', 'mcp-server',
      'Fetch a URL and return its content as markdown (read-only HTTP GET).',
      { reads: true }, 'toggle'),
    cap('mcp-context7', 'Context7 Docs', 'mcp-server',
      'Up-to-date library/framework documentation lookups.', { reads: true }, 'toggle'),
    cap('mcp-filesystem', 'Filesystem (cwd)', 'mcp-server',
      'Read/edit files within the agent workspace only.',
      { reads: true, writes: true }, 'toggle'),
    cap('mcp-git', 'Git (cwd)', 'mcp-server',
      'Inspect git status/log/diff for the workspace repo.',
      { reads: true }, 'toggle'),
    cap('mcp-github-token', 'GitHub', 'mcp-server',
      'Read/write GitHub issues, PRs, and repos. Needs a personal access token.',
      { reads: true, writes: true, deletes: true, sends: false }, 'toggle'),
    cap('mcp-db', 'Database', 'mcp-server',
      'Query a SQL database. Needs a connection string.',
      { reads: true, deletes: true }, 'toggle'),
    cap('mcp-email-calendar', 'Email & Calendar', 'mcp-server',
      'Read/send mail and read/write calendar events. Needs credentials.',
      { reads: true, writes: true, sends: true }, 'toggle'),
    cap('mcp-search-with-key', 'Web Search', 'mcp-server',
      'Keyed web search. Needs a search-provider API key.', { reads: true, spends: true }, 'toggle'),
    cap('skill-md-hive-sync', 'Hive sync skill', 'skill',
      'Agent-side skill: sync memory, tasks and pointers with the hive board.',
      {}, 'manual'),
    cap('skill-md-fetch-summarize', 'Fetch & summarize skill', 'skill',
      'Agent-side skill: pull a page and return a tight, cited summary.',
      { reads: true }, 'manual'),
    cap('skill-md-audit', 'Workspace audit skill', 'skill',
      'Agent-side skill: audit a repo and report health in one pass.',
      { reads: true }, 'manual'),
    cap('skill-temporal', 'Temporal reasoning skill', 'skill',
      'Agent-side skill: interpret natural dates relative to today (when.mjs).',
      {}, 'manual'),
    cap('tool-kg', 'Knowledge graph CLI', 'tool',
      'Local document knowledge-graph CLI the app bundles (kg.cjs).',
      { reads: true }, 'manual'),
    cap('tool-md-slack-reply', 'Slack reply helper', 'tool',
      'Post a reply into a Slack thread as an agent, without handling the bot token.',
      { sends: true }, 'manual')
  ];
}

const MAX_OFFICE_ENTRIES = 500;
const MAX_MANUAL_LINES = 12;

export interface OfficeCatalogEntry {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  what?: unknown;
  maker?: unknown;
  reads?: unknown;
  writes?: unknown;
  sends?: unknown;
  spends?: unknown;
  deletes?: unknown;
  install?: unknown;
  manual?: unknown;
}

/** Parse + sanitize the office's own catalog file. Invalid entries are DROPPED
 *  (never partially repaired): a typo mid-list can't weaken what an agent is
 *  told. Returns the valid entries in file order. */
export function parseOfficeCatalog(raw: unknown): { entries: CapEntry[]; dropped: number } {
  if (!Array.isArray(raw)) return { entries: [], dropped: 0 };
  const out: CapEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw.slice(0, MAX_OFFICE_ENTRIES)) {
    const e = item as OfficeCatalogEntry;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!ID_OK.test(id)) { dropped++; continue; }
    if (seen.has(id.toLowerCase())) { dropped++; continue; }
    if (e.kind !== 'mcp-server' && e.kind !== 'skill' && e.kind !== 'tool') { dropped++; continue; }
    if (typeof e.what !== 'string' || e.what.trim().length < 4 || e.what.length > 600) { dropped++; continue; }
    const install = e.install === 'toggle' ? 'toggle' : 'manual';
    if (install === 'manual' && typeof e.manual !== 'string') { dropped++; continue; }
    const manual = install === 'manual' ? String(e.manual).split('\n').slice(0, MAX_MANUAL_LINES) : undefined;
    seen.add(id.toLowerCase());
    out.push({
      id,
      name: typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 80) : id,
      kind: e.kind,
      what: e.what.trim(),
      maker: typeof e.maker === 'string' && e.maker.trim() ? e.maker.trim().slice(0, 80) : undefined,
      can: {
        reads: e.reads === true, writes: e.writes === true, sends: e.sends === true,
        spends: e.spends === true, deletes: e.deletes === true
      },
      install,
      manual,
      source: 'office'
    });
  }
  if (raw.length > MAX_OFFICE_ENTRIES) dropped += raw.length - MAX_OFFICE_ENTRIES;
  return { entries: out, dropped };
}

/** Bundled + office, office losing id conflicts (bundled ids win so the app's
 *  own entries can never be shadowed). */
export function mergeCatalogs(bundled: CapEntry[], office: CapEntry[]): { items: CapEntry[]; extraCount: number } {
  const bundledIds = new Set(bundled.map((e) => e.id.toLowerCase()));
  const alive = office.filter((e) => !bundledIds.has(e.id.toLowerCase()));
  return { items: [...bundled, ...alive], extraCount: alive.length };
}
