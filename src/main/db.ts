/**
 * PersistStore — durable harness state in SQLite (better-sqlite3, synchronous).
 *
 * Phase A scope (the rest of the renderer state stays in localStorage for now):
 *   - kv:               scalar app state. Today: the main window's bounds.
 *   - command_history:  NET-NEW — every prompt the user submits to an agent.
 *   - computers:        Phase 4 — persistent computer-runtime registry (migration 2),
 *                       structurally implementing ComputerRepo for ComputerManager.
 *   - memories:         Phase 5 — scoped memory records (migration 3), structurally
 *                       implementing MemoryRepo for MemoryService.
 *   - job_runs:         Phase 8 / M3 — durable job-run ledger (migration 4),
 *                       structurally implementing JobRepo for JobLedger.
 *
 * Lives in the Electron MAIN process (better-sqlite3 is native + synchronous);
 * the renderer reaches it over IPC. The DB file sits next to config.json under
 * app.getPath('userData'). WAL mode so reads never block the single writer.
 *
 * Schema evolves via PRAGMA user_version migrations: an ordered array where
 * migration N runs when user_version < N+1, then bumps it. NEVER edit a shipped
 * migration — only append. Phases B/C (agents + message_queue mirror) and the
 * cross-lane cost_ledger are reserved as future additive migrations (see below);
 * they are deliberately NOT built in v1.
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';
import {
  DEFAULT_COMPUTER_PERMISSIONS,
  DEFAULT_RESOURCE_LIMITS,
  type ComputerRecord,
} from '../shared/computer';
import type { ComputerRepo } from './computerStore';
import type { MemoryFilter, MemoryRepo } from './memoryStore';
import type { MemoryRecord } from '../shared/memoryRecord';
import type { JobListFilter, JobRepo } from './jobStore';
import { JOB_KINDS, JOB_RUN_STATES, type JobKind, type JobRun, type JobRunState } from '../shared/jobs';

/** A captured user prompt, as returned to the renderer (camelCase columns). */
export interface CommandHistoryRow {
  id: number;
  agentId: string;
  cwd: string | null;
  text: string;
  ts: number;
}

/**
 * Ordered, append-only migrations. Index N takes the DB from user_version N to
 * N+1. To evolve the schema, APPEND a new function — never edit an existing one
 * (shipped DBs have already run it).
 *
 * FUTURE (do NOT build in v1 — reserved so the array isn't painted into a corner):
 *   - Phase B: `agents` + `message_queue` mirror of the renderer roster/queues
 *     (dual-write), enabling the eventual authority flip off localStorage.
 *   - Cross-lane (Lane A #6): migrate Jim's cost ledger onto this DB so his
 *     circuit-breaker can move off transcript-polling. Column names match his
 *     <harnessHome>/hive/cost-ledger.jsonl keys 1:1 for a straight INSERT…SELECT
 *     (coordinated w/ jim-mq290qkn 2026-06-06):
 *       cost_ledger(id, agent_id, session_id TEXT, ts, input, output,
 *                   cache_read, cache_creation, model TEXT, usd REAL)
 *     Rows are CUMULATIVE snapshots (one per agent per heartbeat beat) — diff
 *     consecutive rows for velocity; index (agent_id, session_id, ts). Additive;
 *     lands as a later migration.
 */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // → user_version 1 (Phase A): scalar kv + net-new command history.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,     -- JSON-encoded
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        cwd      TEXT,
        text     TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ch_agent_ts ON command_history(agent_id, ts DESC);
    `);
  },
  // → user_version 2 (Phase 4): persistent computer-runtime registry.
  // Config-only: status is last-known (reconciled at boot); live runtime state
  // stays in memory. Append-only — older app versions simply ignore the table.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS computers (
        id                 TEXT PRIMARY KEY,
        agent_id           TEXT NOT NULL,
        project_id         TEXT,
        status             TEXT NOT NULL,
        runtime_type       TEXT NOT NULL DEFAULT 'local',
        workspace_id       TEXT NOT NULL,
        workspace_root     TEXT NOT NULL,
        browser_profile_id TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        last_started_at    INTEGER,
        persistence_policy TEXT NOT NULL DEFAULT 'retain',
        resource_limits    TEXT NOT NULL DEFAULT '{}',
        permissions        TEXT NOT NULL DEFAULT '{}',
        config             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_computers_agent ON computers(agent_id);
    `);
  },
  // → user_version 3 (Phase 5): scoped memory records. Content is validated +
  // secret-scanned BEFORE it ever reaches this table (MemoryService); status
  // carries the lifecycle (active|proposed|superseded|expired|deleted) so
  // supersession history is preserved, never erased. Append-only.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        scope         TEXT NOT NULL,
        owner_id      TEXT NOT NULL,
        project_id    TEXT,
        agent_id      TEXT,
        task_id       TEXT,
        computer_id   TEXT,
        memory_type   TEXT NOT NULL,
        content       TEXT NOT NULL,
        source_kind   TEXT NOT NULL,
        source_ref    TEXT,
        author        TEXT NOT NULL,
        confidence    REAL NOT NULL,
        importance    INTEGER NOT NULL,
        approved      INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL,
        superseded_by TEXT,
        version       INTEGER NOT NULL DEFAULT 1,
        access_list   TEXT NOT NULL DEFAULT '[]',
        expires_at    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope_owner ON memories(scope, owner_id);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
      CREATE INDEX IF NOT EXISTS idx_memories_task ON memories(task_id);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    `);
  },
  // → user_version 4 (Phase 8 / M3): durable job-run ledger. One row per run
  // attempt-chain (recurring mission fires, one-time submits, event dispatches).
  // `state` carries the lifecycle (queued|running|succeeded|failed|interrupted|
  // cancelled|refused); `payload` is the JSON needed to rebuild the executor
  // after a restart. Append-only migration, like every shipped one.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_runs (
        id            TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL,
        kind          TEXT NOT NULL,
        label         TEXT NOT NULL,
        payload       TEXT NOT NULL DEFAULT 'null',
        state         TEXT NOT NULL,
        attempt       INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        started_at    INTEGER,
        finished_at   INTEGER,
        next_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_runs_state ON job_runs(state);
      CREATE INDEX IF NOT EXISTS idx_job_runs_created ON job_runs(created_at);
    `);
  },
];

export class PersistStore {
  private db: Database.Database | null = null;

  /** @param dbPath  Override the DB location (tests). Defaults to userData/harness.db. */
  constructor(private dbPath?: string) {}

  /** Open (creating if needed) and migrate the DB. Idempotent — a second call is
   *  a no-op. Throws if the native module fails to load or the file is unusable;
   *  callers should guard so a DB failure can't crash app startup. */
  open(): void {
    if (this.db) return;
    const path = this.dbPath ?? join(app.getPath('userData'), 'harness.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    this.migrate(db);
    this.db = db;
  }

  private migrate(db: Database.Database): void {
    const version = db.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      // Each migration + its version bump run in one transaction so a crash
      // mid-migration never leaves a half-applied schema at the wrong version.
      const run = db.transaction(() => {
        MIGRATIONS[i](db);
        db.pragma(`user_version = ${i + 1}`);
      });
      run();
    }
  }

  /** Close the handle (checkpoints WAL). Safe to call when already closed. */
  close(): void {
    try { this.db?.close(); } catch { /* best-effort on shutdown */ }
    this.db = null;
  }

  get isOpen(): boolean { return this.db !== null; }

  // ─── kv (scalar app state) ─────────────────────────────────────────────────

  /** Read a JSON-decoded scalar, or undefined if absent/unparseable. */
  getKv<T = unknown>(key: string): T | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
  }

  /** Upsert a JSON-encoded scalar. */
  setKv(key: string, value: unknown): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value), Date.now());
  }

  // ─── command history (net-new) ─────────────────────────────────────────────

  /** Record one submitted prompt. Empty text or missing agent id are ignored. */
  addHistory(entry: { agentId: string; cwd?: string | null; text: string }): void {
    if (!this.db) return;
    const text = (entry.text ?? '').trim();
    if (!text || !entry.agentId) return;
    this.db.prepare('INSERT INTO command_history (agent_id, cwd, text, ts) VALUES (?, ?, ?, ?)')
      .run(entry.agentId, entry.cwd ?? null, text, Date.now());
  }

  /** Most-recent-first history, optionally scoped to one agent. */
  listHistory(agentId?: string, limit = 100): CommandHistoryRow[] {
    if (!this.db) return [];
    const lim = clampLimit(limit, 100);
    const rows = agentId
      ? this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(agentId, lim)
      : this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(lim);
    return rows as CommandHistoryRow[];
  }

  /** Substring search over prompt text, most-recent-first. */
  searchHistory(query: string, limit = 50): CommandHistoryRow[] {
    if (!this.db) return [];
    const q = (query ?? '').trim();
    if (!q) return [];
    const lim = clampLimit(limit, 50);
    // Escape LIKE wildcards so a literal % or _ in the query isn't a metachar.
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(
      "SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC LIMIT ?"
    ).all(needle, lim) as CommandHistoryRow[];
  }
  // ─── computers (Phase 4 registry — structurally implements ComputerRepo) ───

  /** All persisted computers (fresh copies). */
  listComputers(): ComputerRecord[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM computers ORDER BY created_at ASC').all() as ComputerRow[];
    return rows.map(rowToComputer);
  }

  getComputer(id: string): ComputerRecord | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM computers WHERE id = ?').get(id) as ComputerRow | undefined;
    return row ? rowToComputer(row) : null;
  }

  getByAgent(agentId: string): ComputerRecord | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM computers WHERE agent_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(agentId) as ComputerRow | undefined;
    return row ? rowToComputer(row) : null;
  }

  insertComputer(rec: ComputerRecord): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO computers (id, agent_id, project_id, status, runtime_type, workspace_id,
        workspace_root, browser_profile_id, created_at, updated_at, last_started_at,
        persistence_policy, resource_limits, permissions, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rec.id, rec.agentId, rec.projectId, rec.status, rec.runtimeType, rec.workspaceId,
      rec.workspaceRoot, rec.browserProfileId, rec.createdAt, rec.updatedAt, rec.lastStartedAt,
      rec.persistencePolicy, JSON.stringify(rec.resourceLimits), JSON.stringify(rec.permissions),
      JSON.stringify(rec.config)
    );
  }

  updateComputer(rec: ComputerRecord): void {
    if (!this.db) return;
    this.db.prepare(
      `UPDATE computers SET agent_id = ?, project_id = ?, status = ?, runtime_type = ?,
        workspace_id = ?, workspace_root = ?, browser_profile_id = ?, updated_at = ?,
        last_started_at = ?, persistence_policy = ?, resource_limits = ?, permissions = ?, config = ?
       WHERE id = ?`
    ).run(
      rec.agentId, rec.projectId, rec.status, rec.runtimeType, rec.workspaceId, rec.workspaceRoot,
      rec.browserProfileId, rec.updatedAt, rec.lastStartedAt, rec.persistencePolicy,
      JSON.stringify(rec.resourceLimits), JSON.stringify(rec.permissions), JSON.stringify(rec.config),
      rec.id
    );
  }

  deleteComputer(id: string): void {
    if (!this.db) return;
    this.db.prepare('DELETE FROM computers WHERE id = ?').run(id);
  }

  // ─── memories (Phase 5 scoped store — structurally implements MemoryRepo) ──

  listMemories(filter?: MemoryFilter): MemoryRecord[] {
    if (!this.db) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.scope !== undefined) { clauses.push('scope = ?'); params.push(filter.scope); }
    if (filter?.status !== undefined && filter.status !== 'all') { clauses.push('status = ?'); params.push(filter.status); }
    if (filter?.ownerId !== undefined) { clauses.push('owner_id = ?'); params.push(filter.ownerId); }
    if (filter?.projectId !== undefined) { clauses.push('project_id = ?'); params.push(filter.projectId); }
    if (filter?.agentId !== undefined) { clauses.push('agent_id = ?'); params.push(filter.agentId); }
    if (filter?.taskId !== undefined) { clauses.push('task_id = ?'); params.push(filter.taskId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at ASC`).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  getMemory(id: string): MemoryRecord | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  insertMemory(rec: MemoryRecord): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO memories (id, scope, owner_id, project_id, agent_id, task_id, computer_id,
        memory_type, content, source_kind, source_ref, author, confidence, importance, approved,
        status, superseded_by, version, access_list, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rec.id, rec.scope, rec.ownerId, rec.projectId, rec.agentId, rec.taskId, rec.computerId,
      rec.type, rec.content, rec.sourceKind, rec.sourceRef, rec.author, rec.confidence,
      rec.importance, rec.approved ? 1 : 0, rec.status, rec.supersededBy, rec.version,
      JSON.stringify(rec.accessList), rec.expiresAt, rec.createdAt, rec.updatedAt
    );
  }

  updateMemory(rec: MemoryRecord): void {
    if (!this.db) return;
    this.db.prepare(
      `UPDATE memories SET scope = ?, owner_id = ?, project_id = ?, agent_id = ?, task_id = ?,
        computer_id = ?, memory_type = ?, content = ?, source_kind = ?, source_ref = ?, author = ?,
        confidence = ?, importance = ?, approved = ?, status = ?, superseded_by = ?, version = ?,
        access_list = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      rec.scope, rec.ownerId, rec.projectId, rec.agentId, rec.taskId, rec.computerId,
      rec.type, rec.content, rec.sourceKind, rec.sourceRef, rec.author, rec.confidence,
      rec.importance, rec.approved ? 1 : 0, rec.status, rec.supersededBy, rec.version,
      JSON.stringify(rec.accessList), rec.expiresAt, rec.updatedAt, rec.id
    );
  }

  deleteMemory(id: string): void {
    if (!this.db) return;
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  // ─── job runs (Phase 8 / M3 ledger — structurally implements JobRepo) ──────

  listJobRuns(filter?: { jobId?: string; limit?: number }): JobRun[] {
    if (!this.db) return [];
    const lim = clampLimit(filter?.limit ?? 100, 100);
    const rows = filter?.jobId
      ? this.db.prepare(
          'SELECT * FROM job_runs WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
        ).all(filter.jobId, lim) as JobRow[]
      : this.db.prepare(
          'SELECT * FROM job_runs ORDER BY created_at DESC, id DESC LIMIT ?'
        ).all(lim) as JobRow[];
    return rows.map(rowToJob);
  }

  getJobRun(id: string): JobRun | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  insertJobRun(run: JobRun): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO job_runs (id, job_id, kind, label, payload, state, attempt, max_attempts,
        error, created_at, started_at, finished_at, next_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id, run.jobId, run.kind, run.label, run.payload, run.state, run.attempt,
      run.maxAttempts, run.error, run.createdAt, run.startedAt, run.finishedAt, run.nextAt
    );
  }

  /** Shallow patch — only the columns present in `patch` are written. */
  updateJobRun(id: string, patch: Partial<JobRun>): void {
    if (!this.db || Object.keys(patch).length === 0) return;
    const cols: Record<string, string> = {
      jobId: 'job_id', kind: 'kind', label: 'label', payload: 'payload', state: 'state',
      attempt: 'attempt', maxAttempts: 'max_attempts', error: 'error', createdAt: 'created_at',
      startedAt: 'started_at', finishedAt: 'finished_at', nextAt: 'next_at'
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of Object.entries(cols)) {
      if (!(key in patch)) continue;
      sets.push(`${col} = ?`);
      params.push((patch as Record<string, unknown>)[key]);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE job_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  countJobRunsSince(jobId: string, since: number): number {
    if (!this.db) return 0;
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ? AND created_at >= ?'
    ).get(jobId, since) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  liveJobRuns(): JobRun[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      "SELECT * FROM job_runs WHERE state IN ('queued', 'running') ORDER BY created_at ASC, id ASC"
    ).all() as JobRow[];
    return rows.map(rowToJob);
  }
}

interface MemoryRow {
  id: string;
  scope: string;
  owner_id: string;
  project_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  computer_id: string | null;
  memory_type: string;
  content: string;
  source_kind: string;
  source_ref: string | null;
  author: string;
  confidence: number;
  importance: number;
  approved: number;
  status: string;
  superseded_by: string | null;
  version: number;
  access_list: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Map a memory row to a record; a malformed JSON access_list degrades to []
 *  (a hand-edited row must never crash the app at boot). */
function rowToMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope as MemoryRecord['scope'],
    ownerId: row.owner_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    computerId: row.computer_id,
    type: row.memory_type as MemoryRecord['type'],
    content: row.content,
    sourceKind: row.source_kind as MemoryRecord['sourceKind'],
    sourceRef: row.source_ref,
    author: row.author,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0,
    importance: Number.isFinite(row.importance) ? row.importance : 0,
    approved: row.approved === 1,
    status: row.status as MemoryRecord['status'],
    supersededBy: row.superseded_by,
    version: Number.isFinite(row.version) ? row.version : 1,
    accessList: parseJson<string[]>(row.access_list, []),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ComputerRow {
  id: string;
  agent_id: string;
  project_id: string | null;
  status: string;
  runtime_type: string;
  workspace_id: string;
  workspace_root: string;
  browser_profile_id: string | null;
  created_at: number;
  updated_at: number;
  last_started_at: number | null;
  persistence_policy: string;
  resource_limits: string;
  permissions: string;
  config: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Map a row to a record; unknown/missing JSON blobs fall back to defaults
 *  (a hand-edited row must never crash the app at boot). */
function rowToComputer(row: ComputerRow): ComputerRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id,
    status: row.status as ComputerRecord['status'],
    runtimeType: 'local',
    workspaceId: row.workspace_id,
    workspaceRoot: row.workspace_root,
    browserProfileId: row.browser_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastStartedAt: row.last_started_at,
    persistencePolicy: row.persistence_policy === 'dispose' ? 'dispose' : 'retain',
    resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, ...parseJson(row.resource_limits, {}) },
    permissions: mergePermissions(parseJson(row.permissions, {})),
    config: parseJson(row.config, {}),
  };
}

function mergePermissions(raw: Partial<ComputerRecord['permissions']>): ComputerRecord['permissions'] {
  return {
    agent: { ...DEFAULT_COMPUTER_PERMISSIONS.agent, ...(raw.agent ?? {}) },
    user: { ...DEFAULT_COMPUTER_PERMISSIONS.user, ...(raw.user ?? {}) },
  };
}

interface JobRow {
  id: string;
  job_id: string;
  kind: string;
  label: string;
  payload: string;
  state: string;
  attempt: number;
  max_attempts: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  next_at: number | null;
}

/** Map a row to a JobRun; unknown kind/state (hand-edited row) degrades to the
 *  safest terminal reading rather than crashing the boot recovery. */
function rowToJob(row: JobRow): JobRun {
  const kind = (JOB_KINDS as string[]).includes(row.kind) ? (row.kind as JobKind) : 'one-time';
  const state = (JOB_RUN_STATES as string[]).includes(row.state)
    ? (row.state as JobRunState)
    : 'failed';
  return {
    id: row.id,
    jobId: row.job_id,
    kind,
    label: row.label,
    payload: row.payload,
    state,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nextAt: row.next_at
  };
}

/** Coerce an untrusted limit into [1, 1000] with a sane fallback. */
function clampLimit(n: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1000, v);
}

/**
 * ComputerRepo adapter over PersistStore — the production wiring handed to
 * ComputerManager (index.ts). Lives here so computerStore.ts (loaded by node
 * tests) never transitively imports better-sqlite3/electron.
 */
export class SqliteComputerRepo implements ComputerRepo {
  constructor(private store: PersistStore) {}

  list(): ComputerRecord[] { return this.store.listComputers(); }
  get(id: string): ComputerRecord | null { return this.store.getComputer(id); }
  getByAgent(agentId: string): ComputerRecord | null { return this.store.getByAgent(agentId); }
  insert(rec: ComputerRecord): void { this.store.insertComputer(rec); }
  update(rec: ComputerRecord): void { this.store.updateComputer(rec); }
  delete(id: string): void { this.store.deleteComputer(id); }
}

/**
 * MemoryRepo adapter over PersistStore — the production wiring handed to
 * MemoryService (index.ts). Lives here so memoryStore.ts (loaded by node
 * tests) never transitively imports better-sqlite3/electron.
 */
export class SqliteMemoryRepo implements MemoryRepo {
  constructor(private store: PersistStore) {}

  list(filter?: MemoryFilter): MemoryRecord[] { return this.store.listMemories(filter); }
  get(id: string): MemoryRecord | null { return this.store.getMemory(id); }
  insert(rec: MemoryRecord): void { this.store.insertMemory(rec); }
  update(rec: MemoryRecord): void { this.store.updateMemory(rec); }
  delete(id: string): void { this.store.deleteMemory(id); }
}

/**
 * JobRepo adapter over PersistStore — the production wiring handed to
 * JobLedger (index.ts). Lives here so jobStore.ts (loaded by node tests) never
 * transitively imports better-sqlite3/electron.
 */
export class SqliteJobRepo implements JobRepo {
  constructor(private store: PersistStore) {}

  insert(run: JobRun): void { this.store.insertJobRun(run); }
  get(id: string): JobRun | null { return this.store.getJobRun(id); }
  update(id: string, patch: Partial<JobRun>): void { this.store.updateJobRun(id, patch); }
  list(filter?: JobListFilter): JobRun[] { return this.store.listJobRuns(filter); }
  countSince(jobId: string, since: number): number { return this.store.countJobRunsSince(jobId, since); }
  live(): JobRun[] { return this.store.liveJobRuns(); }
}
