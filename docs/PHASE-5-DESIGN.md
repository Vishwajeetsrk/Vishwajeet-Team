# PHASE 5 DESIGN — Persistent, Scoped Memory System

**Status:** presented before coding (per process rule §12) · **Baseline:** Phase 4 final = 1124/1088/22/14

---

## 1. Existing capabilities (reused — nothing duplicated)

| Capability | Where | How Phase 5 uses it |
|---|---|---|
| Per-agent markdown memory (`memory.md`, append protocol) | `hive.ts` `ensureAgent`/`memory(id)`, prompt protocol | Left untouched — still the agent's private scratchpad + MemPalace mine source |
| Semantic search (MemPalace CLI, wing=agentId) | `memory.ts` MemoryManager + `hive:searchMemory` IPC | Left untouched; existing MemoryTab semantic section preserved verbatim |
| Hive full-text search | `hive:textSearch` over board/tasks/memory.md | Preserved in existing MemoryTab |
| Redaction battery | `redactSecrets` (`hive.ts:275`) | Reused **as the secret detector** (write rejects when redaction would alter content) and on every IPC/log boundary |
| SQLite migration conventions | `db.ts` append-only `MIGRATIONS`, `ComputerRepo` seam pattern | New migration **#3** + `SqliteMemoryRepo` mirroring `SqliteComputerRepo` exactly |
| Validation house style | `ceoIpcValidation.ts` / `computerIpcValidation.ts` | New `memoryIpcValidation.ts` (pure, no Electron) |
| Live push + hive log pattern | `liveWebContents()?.send` + `hive.appendLog` deps | `memory:updated` push + `kind:'memory'` durable events, redacted in the service |
| CEO dispatch flow | `ceoService.buildBrief` (call site `execute()`), `accept()` | Recall injected into brief; outcome write after human accept |
| Existing `memory` Command Center tab | `MemoryTab` in `CommandCenterPanel.tsx` (text search, semantic search, memory.md file view) | **Preserved**; new scoped-memory section renders inside the same tab |
| USER_ACTOR pinning | `shared/computer.ts` | User-only memory ops pin `USER_ACTOR` in `index.ts` handlers |

## 2. Confirmed gaps (what Phase 5 adds)

1. No structured, scoped record store — memory is free markdown + a semantic index (no scope/owner/status/version).
2. No access control — any agent can read any sibling's `memory.md`; wings are a filter, not a permission.
3. No write pipeline — no validation, duplicate/conflict handling, approval rules, or secret detection at write time.
4. No programmatic retrieval into execution — agents self-serve via prompt; `buildBrief` never injects scoped recall.
5. No task-outcome memory write — accepted results vanish.
6. No provenance/confidence/retention/supersession model, no inspect/correct/delete UI for structured memory.

## 3. Scopes and data model

**Scopes** (`MemoryScope`): `global` | `project` | `agent` | `task` | `computer`.
- `global` owner = `'system'` (user-approved preferences/rules only)
- `project` owner = projectId · `agent` owner = agentId · `task` owner = planId · `computer` owner = computerId

**Migration 3 — `memories` table** (append-only; never edit migrations 1–2):

```sql
CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,          -- 'mem-<rand>'
  scope        TEXT NOT NULL,             -- global|project|agent|task|computer
  owner_id     TEXT NOT NULL,
  project_id   TEXT, agent_id TEXT, task_id TEXT, computer_id TEXT,   -- denormalized refs
  memory_type  TEXT NOT NULL,             -- preference|rule|decision|fact|context|evidence|reference|handoff|recovery
  content      TEXT NOT NULL,             -- validated, secret-free, <= 2000 chars
  source_kind  TEXT NOT NULL,             -- user|agent|task_result|system
  source_ref   TEXT,                      -- goal/plan/message id or 'panel'
  author       TEXT NOT NULL,             -- agentId | 'user' | 'system'
  confidence   REAL NOT NULL,             -- 0..1
  importance   INTEGER NOT NULL,          -- 0..5
  approved     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,             -- active|proposed|superseded|expired|deleted
  superseded_by TEXT, version INTEGER NOT NULL DEFAULT 1,
  access_list  TEXT NOT NULL DEFAULT '[]',-- extra agent ids explicitly authorized to read
  expires_at   INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- indexes: (scope, owner_id), (project_id), (agent_id), (status), (task_id)
```

`MemoryRecord` mirrors this (camelCase) in **`src/shared/memoryRecord.ts`** (renderer-safe, like `shared/computer.ts`), plus `MEMORY_SCOPES`, `MEMORY_TYPES`, `MEMORY_STATUSES`, `DEFAULT_RECALL_BUDGET_CHARS = 1500`, `DEFAULT_RECALL_LIMIT = 8`, `type MemoryActor = {kind:'user'} | {kind:'agent'; agentId:string}`.

## 4. Permission model (enforced in the service — main process, never the UI)

**Read (canRead):** `global` → everyone. `project`/`task`/`computer` → user always; agent if it is the owner OR listed in `access_list` OR (task scope) the task's assigned agent. `agent` scope → user always; owner agent; or explicit `access_list` entry. Retrieval filters **before ranking**; a shared search index can never widen scope. Revocation = removing an `access_list` entry → next retrieval excludes it.

**Write (canWrite):**

| Writer | global | project | agent | task | computer |
|---|---|---|---|---|---|
| user (`USER_ACTOR`, renderer IPC) | ✅ active | ✅ active | ✅ active (owner override) | ✅ active | ✅ active |
| agent (pipeline) | ⚠️ `proposed` (needs approval) | ⚠️ `proposed` | ✅ active **only own id** | ✅ active **only assigned plan** | ❌ `PERMISSION_DENIED` |

- Any scope mismatch (agent writing another agent's/task's record) → `PERMISSION_DENIED` structured error + audit event.
- Content where `redactSecrets(content) !== content` → **`SECRET_DETECTED`** — never stored (no silent redact-then-store).
- **Retrieval returns only `active`** records; `proposed` are visible in the UI for approval, never injected into prompts.

**Conflicts/retention rules (deterministic, tested):**
1. Duplicate (same scope+owner+type, normalized content equal) → return existing, `dedup:true`, no second row.
2. User write conflicting with an active record → old row `superseded` (`superseded_by`=new id, `version+1`), new row active. History preserved, never erased.
3. Agent write conflicting with an **approved** active record → `CONFLICT` rejected (approved decisions outrank agents).
4. Agent write conflicting with an unapproved active record → supersede (latest within same class wins).
5. `expires_at <= now` → excluded from retrieval; `reconcile()` (boot) marks them `expired`.
6. Delete = soft (`status='deleted'`), user-only; supersession chains remain inspectable via `memory:history`.
7. Nothing in memory may grant tools/permissions — retrieval output is advisory text only (brief section explicitly says so).

## 5. Pipelines

**Write** (`MemoryService.write(input, actor)`): validate structure (lengths/enums/refs) → resolve scope+owner → secret scan → writer permission → duplicate check → conflict/supersede → apply approval rule (`proposed` for agent→project/global) → persist via repo → durable `log` event (`memory-written` etc., redacted) + `emit('memory:updated')` → return `{ok, record | dedup}` or structured `{ok:false, error, code}`.

**Retrieval** (`MemoryService.retrieve(reader, opts)`): resolve reader + trust scope set (task/project context comes from **main-side callers only** — agents have no IPC) → SQL-side prefilter (status active, not expired, scope/project/agent/task filters, optional LIKE on content/type) → ACL filter (`canRead`) → rank = text-token overlap (0..1) × confidence × importance + recency decay → take top-K within `budgetChars` (default 1500) → redact on the way out → log metadata only (`{event:'memory-retrieved', count, chars}` — **never content**) → return `{records, usedChars, truncated}`.

**CEO/agent integration (`ceoService.ts`):**
- New optional dep `memory?: { recallFor(ctx), onAccepted(ctx) }`.
- `execute()`: after `buildBrief(...)`, `recallFor({agentId, goalId, planId, title+description query, projectId via computers.getForAgent})` → brief gains a `RELEVANT MEMORY (scoped, advisory):` section (budgeted; omitted when empty).
- `createGoal()`: returns optional `memoryContext` (global+project recall for the goal text) so the CEO view shows what it knew before planning; CeoPanel renders it.
- `accept()` (human-verified): `onAccepted(...)` writes a `task`-scope `evidence`/`handoff` record (source `task_result`, author = assigned agent, confidence 0.9) through the **same write pipeline** (secrets/dupes/ACL apply) — a proposal for `global`/`project` scope instead of a direct write.

## 6. Modules/files

**New:** `src/shared/memoryRecord.ts` · `src/main/memoryStore.ts` (repo interface + `MemoryMemoryRepo` test double, serialize/from) · `src/main/memoryService.ts` · `src/main/memoryIpcValidation.ts` · `src/renderer/src/components/MemoryScopePanel.tsx` · tests: `memory-store`, `memory-ipc-validation`, `memory-scopes`, `memory-access`, `memory-pipeline`, `memory-retrieval`, `memory-retention`, `memory-ceo-integration`, `memory-panel-contract` (.test.cjs) · `docs/PHASE-5-DESIGN.md`, `docs/PHASE-5-REPORT.md`.

**Modified:** `src/main/db.ts` (migration 3 + 5 repo methods + `SqliteMemoryRepo`) · `src/main/index.ts` (service construction + reconcile + 8 `memory:*` handlers + CEO dep wiring) · `src/main/ceoService.ts` (2 optional hooks + brief section + `memoryContext`) · `src/preload/index.ts` (9 methods + `onMemoryUpdated`) · `src/renderer/src/components/CommandCenterPanel.tsx` (render new section inside `MemoryTab`) · `src/renderer/src/components/CeoPanel.tsx` (show `memoryContext`) · locales ×3 (`memoryTab` block) · `test/computer-electron.electron.cjs` (SQLite migration-3 roundtrip in the labeled harness).

**IPC channels (8):** `memory:search`, `memory:list`, `memory:get`, `memory:history`, `memory:write`, `memory:edit` (correct→supersede), `memory:approve`, `memory:delete` — all validated; write/edit/approve/delete pin `USER_ACTOR`.

## 7. Test strategy (maps to §11's 17 areas)

- **Mock vs real, labeled:** all node tests use `MemoryMemoryRepo` (in-memory mock repo, explicitly named in test headers) + real `MemoryService` logic; the **integration test** (`memory-ceo-integration`) wires a **real `CeoService` dispatch** to a real service over a serialized→restored repo (restart proven) — closest honest "real task" under node; **real SQLite** (migration 3 + `SqliteMemoryRepo` roundtrip) runs in the labeled electron harness (better-sqlite3 is Electron-ABI).
- Scope coverage: one test per scope (global/project/agent/task/computer) + retrieval targeting.
- Access matrix: authorized/unauthorized read+write, cross-agent, cross-project, revocation on next retrieval.
- Pipeline: secret reject, dedupe, conflict supersede, approval-required paths, events emitted, no-content-in-log.
- Retrieval: ranking order, budget cap, ACL before ranking.
- Retention: expiry exclude + reconcile, soft delete, history chain.
- CEO: brief contains scoped recall; agent can't recall another's private memory; outcome written on accept; survives restart.
- Regression: full suite vs baseline 1124/1088/22/14; typecheck:node 0; typecheck:web 33; build 0.
- Panel contract: channel parity (preload↔main), locale key parity, honest states, no mock/fake persistence.

## 8. Walkthrough verification record (done before UI changes)

`npm run dev` bounded launch 2026-10-09: main+preload built, dev server up, window **"Vishwajeet Team"**, 7 stable processes, **zero errors in log**; process tree killed after. Both previously-outstanding walkthroughs (P3 CEO panel, P4 computer tab): launch-level verified; **interactive click-through remains the human review-gate step** — reported here honestly, no failures found to block Phase 5.

## 9. Explicit non-goals

No paid embedding service/external API; no FTS5/sqlite-vec (LIKE + JS ranking first; semantic stays opt-in via existing MemPalace); no replacement of `memory.md`/reflect/knowledge-graph; no office/task-engine redesign; no project registry invention (project ids stay free-form strings as everywhere else).
