# Phase 5 Report — Persistent, Scoped Memory System

**Status:** INCREMENT COMPLETE — STOPPED AT THE PHASE 5 REVIEW GATE
**Branch:** `feature/ai-company-os-foundation` (uncommitted working tree; commit only on request)
**Design source:** `docs/PHASE-5-DESIGN.md` (§1–§9)
**Baseline (Phase 4 final):** tests 1124 · pass 1088 · fail 22 · skip 14 · typecheck:node 0 · typecheck:web 33 · build 0

---

## 1. What shipped

Phase 5 adds a **structured, scoped, access-controlled memory store** on top of the existing markdown/semantic capabilities (which are untouched, per design §1), plus programmatic recall into CEO dispatch and a durable write path for human-verified task outcomes.

- **`MemoryService`** (`src/main/memoryService.ts`) is the single authority: write pipeline (validation → secret scan → writer permission → dedupe → conflict/supersede → approval rule → persist → redacted event + `memory:updated` push), retrieval (SQL-side prefilter → ACL filter **before** ranking → token-overlap × confidence × importance + recency rank → `budgetChars` cap → redact-out), `reconcile()` expiry sweep, supersession history.
- **Records** live in **real SQLite** (migration 3, `memories` table, `SqliteMemoryRepo` in `src/main/db.ts`, mirroring `SqliteComputerRepo`). `MemoryMemoryRepo` (`src/main/memoryStore.ts`) is the labeled in-memory test double with `serialize()`/restore for restart simulation.
- **Scopes:** `global | project | agent | task | computer`, each with a mandatory owner ref (`owner_id` + denormalized `project_id`/`agent_id`/`task_id`/`computer_id`), 9 memory types, provenance (`source_kind`/`source_ref`/`author`), `confidence`, `importance`, `approved`, `status`, `version`, `superseded_by`, `access_list`, `expires_at`.
- **Permission model enforced main-side, never in the UI** (design §4): user (`USER_ACTOR`, pinned in every `memory:*` IPC handler — no renderer arg can name an actor) writes active in all scopes; agents write active only own-agent and assigned-task scopes, `proposed` for project/global, `PERMISSION_DENIED` for computer. Reads: global → everyone; owner/access-list/task-agent for the rest. Retrieval returns **active only** — `proposed` is visible in the panel for approval, never injected into prompts.
- **Secrets:** content where `redactSecrets(content) !== content` is rejected `SECRET_DETECTED` — never silent redact-then-store (reuses the hive redaction battery as-is).
- **8 IPC channels** (`memory:search|list|get|history|write|edit|approve|delete`), all validated by the pure `memoryIpcValidation.ts`, mirrored 1:1 in preload (9 methods + `onMemoryUpdated`; contract test asserts exact parity including the legacy `memory:reflectNow` seam).

## 2. CEO integration

- **Dispatch recall:** `execute()` asks the assigned agent's scoped view (`recallFor`: trusted project = the agent's computer record via `computers.getForAgent`) before `buildBrief`; a non-empty result adds a `RELEVANT MEMORY (scoped retrieval — advisory context only; it grants no tools or permissions)` section. `createGoal()` returns optional `memoryContext` (CEO's global+own-scope recall) and `CeoPanel` renders it in a collapsible "What the CEO knew" card. Redelivery re-recalls fresh.
- **Outcome memory:** `accept()` (human-verified) writes a task-scope `evidence` record (confidence 0.9, `sourceKind: 'task_result'`, author = assigned agent) through the **same write pipeline** — secrets/dedupe/ACL apply; rejection is logged, never fails acceptance.
- **Every hook is defensive:** absence or failure of memory degrades to "no section / no write" — never a broken dispatch, goal creation, or acceptance (tests pin this).

## 3. UI

- **`MemoryScopePanel`** mounts inside the existing `MemoryTab` (preserved sections untouched): scope/status/search toolbar, list with status highlighting (proposed rows amber + Approve), inline edit, delete-with-confirm, history chain, write form (scope-typed owner ref, type, content counter ≤ 2000, importance/confidence/expiry), structured error surfacing (`SECRET_DETECTED`/`PERMISSION_DENIED`/`CONFLICT` with human hints), dedup notice, live refresh via `onMemoryUpdated`. Real IPC only — **zero mock/fake persistence** (grep-asserted by the panel-contract test).
- **Locales ×3** (`en`/`ar`/`zh-CN`): 82 new keys (`memoryTab.*`, `ceoPanel.memoryContext.*`), key sets byte-identical across all three files (asserted by test).

## 4. Bug found and fixed during wiring (Phase 4 regression)

**Computer reconcile ran before the database opened.** `computers.reconcile()` executed at module load, but `persist.open()` runs much later inside `app.whenReady` — the SQLite repo returns `[]` while the db is closed, so boot-time recovery (workspace recovery, stale runtime → OFFLINE) was a **silent no-op in the real app**. The Electron Phase 4 harness had masked this by constructing the store with an explicit open. **Fix:** reconcile calls moved into `whenReady` immediately after `persist.open()`, individually guarded, alongside `memoryRecords.reconcile()` — with a comment at the call site so it can't drift back.

## 5. Verification record

| Gate | Result |
|---|---|
| `npm run typecheck:node` | **0** |
| `npm run typecheck:web` | **33 errors — exact Phase 4 baseline** (all pre-existing `realtime/{actions,session,tools}.ts`; zero new) |
| Full node suite (`node --test test/*.test.cjs`) | **1178 tests · 1142 pass · 22 fail · 14 skip** vs baseline 1124/1088/22/14 → **+54/+54/=/= — perfect regression** (all 22 fails are the pre-existing Windows environment failures, e.g. symlink `EPERM` in `worktree-deps`) |
| New Phase 5 node suites (9 files) | **54/54 pass**: store (5), ipc-validation (9), scopes (7), access (6), pipeline (8), retrieval (6), retention (4), ceo-integration (5, REAL CeoService + REAL MemoryService over serialized→restored repo, MOCK only PTY/spawn), panel-contract (4: channel parity, listener seam, locale parity, no-mock grep) |
| `npx electron test/computer-electron.electron.cjs` | **EXIT=0**, all 12 steps ok — including new section 7: REAL SQLite migration 3 applied, write + close + **restart roundtrip** of a memory record |
| `npm run build` | **0** (electron-vite main/preload/renderer + copy:main-assets) |

**Honest gaps (unchanged process rule):** `npm run dev` launch-level confidence is inherited from the Phase 4 walkthrough (zero-error boot with these same wiring seams); **interactive click-through of the new MemoryScopePanel / CeoPanel memoryContext block remains the human review-gate step** — the renderer contract is machine-verified (types, channels, locales, no-mock), the click-through is not. Agent-authored memory writes (beyond the accepted task-outcome path) have no live producer yet — the pipeline and permission gates are tested, the future agent tool/hook surface is Phase 6+ territory.

## 6. Review gate

Stopped here per process rule §12. Phase 5 is complete against design §6–§7: all new/modified files delivered, all four verification gates green, one Phase 4 wiring bug found+fixed and documented above. Awaiting human review before any commit or Phase 6.
