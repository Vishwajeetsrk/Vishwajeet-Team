# MASTER PROJECT STATUS — Orbit AI (formerly AI Company OS)

**Date:** 2026-10-10 · **Branch:** `feature/ai-company-os-foundation` (upstream `2c646127`, v0.4.6) · **Work tree:** uncommitted (commit only on request)
**Product identity (vision, 2026-10-10):** **Orbit AI** — conversational CEO **Dot**, tagline "One command. An entire AI workforce." Brand migration is planned work (ORBIT-EXPANSION-PLAN M10), not yet applied; runtime still ships as "Munder Difflin".
**Gate state:** Phase 5 (Persistent Scoped Memory) COMPLETE — **stopped at the Phase 5 review gate**. Orbit expansion planned (`docs/ORBIT-EXPANSION-PLAN.md`); **no Orbit milestone work has started.** Next: user review → approve M1 (Security Core & Safety Supervisor).

---

## 1. Three phase numbering schemes — reconciled

The project carries three phase schemes plus the new Orbit milestone map. This audit uses **Scheme A (executed)** as the canonical "what was built" and cross-references the others.

| Scheme A — EXECUTED (reports) | Scheme B — `IMPLEMENTATION-ROADMAP.md` | Scheme C — Requirements pack `05-TASKS-ROADMAP.md` | Orbit plan | Status |
|---|---|---|---|---|
| **P1 Baseline Verification** | Ph1 Baseline | Ph0/Ph1 (foundation) | — | ✅ Done (2 manual items later resolved by P3 launch verification) |
| **P2 CEO & Task Engine (logic)** | Ph3 Durable Task Tracking | Ph2 CEO + tasks | — | ✅ Done (28 tests) |
| **P3 Live CEO Integration + CEO Panel** | Ph2 CEO UI | Ph2 gate | — | ✅ Done (goal→dispatch→reply→accept, restart reconcile) |
| **P4 Persistent Computer Runtime** | Ph5+6+7 (computers/browser/permissions) | Ph4 gate | Orbit §4 | ✅ Done (84 tests + electron harness + acceptance demo) |
| **P5 Persistent Scoped Memory** | Ph4 Memory | Ph6 memory gate | Orbit §10 | ✅ Done (54 tests + electron migration-3 restart roundtrip) |
| — (next) | Ph8 Security | Ph9 Security | **Orbit §8 → M1** | ⬜ Recommended next milestone |
| — | Ph9 Provider Routing | Ph8 AI gateway | Orbit §9 → M6 | ⬜ Remaining |
| — | Ph10 Office UI | Ph5 real-time office | Orbit §11 → M9 | ⬜ Remaining (ComputerPanel shipped early in P4; office linkage unbuilt) |
| — | — | — | Orbit §5/§6 → M3/M7 | ⬜ Durable jobs + monitoring (new) |
| — | — | — | Orbit §1/§2/§3 → M10/M5/M4 | ⬜ Brand/Dot, conversational surface, workforce catalog (new) |
| — | Ph11 Reliability | — | M11 | ⬜ Remaining |
| — | Ph12 E2E | Ph12 Hardening | M12 | ⬜ Remaining |

**Key observation:** executed P4 delivered roadmap Ph5+6+7 in one phase; executed P5 delivered roadmap Ph4 (memory) two phases late but fully — memory is now a **closed** area. The Orbit plan (12 milestones M1–M12) replaces the old forward numbering for everything not yet executed.

## 2. What exists today (capability inventory)

**Foundation & evidence**
- Upstream preserved (MIT, Hive + PtyManager + office renderer untouched in behavior); all changes additive; 7 upstream files modified additively in P3, +8 more in P4, +4 more in P5 (preload, CommandCenterPanel, locales, icons).
- Foundation docs: `UPSTREAM-BASELINE.md`, `AI-COMPANY-OS-GAP-ANALYSIS.md` (68 requirements), `IMPLEMENTATION-ROADMAP.md` (12 phases); Orbit mapping in `ORBIT-EXPANSION-PLAN.md` §1.

**CEO / task engine**
- 11-state task machine (`src/shared/taskStateMachine.ts`), goal DAG, agent selection, `CEOOrchestrator` (`src/main/ceo.ts`).
- Live integration: `<hive>/goals.json` (`goalStore.ts`), dispatch via `hive.send`, correlation ids, reply dedupe, human `ceo:accept` gate, restart reconcile with bounded redelivery, 7 validated `ceo:*` channels (`ceoService.ts`).
- CEO panel: Command Center `ceo` tab (`CeoPanel.tsx`), i18n ×3, **+ Phase 5**: `memoryContext` block ("what the CEO knew before planning").

**Persistent computer runtime (Phase 4)**
- `ComputerManager` (`src/main/computer.ts`): 10-status machine, SQLite migration 2, workspace default-deny, terminal association + `pty:write` gate, lifecycle, `statusTick`, startup `reconcile()` — **wiring bug found in P5 and fixed**: reconcile ran before `persist.open()` (silent no-op at boot); now runs in `whenReady` after the DB opens, alongside memory reconcile.
- `ComputerBrowser`: hidden real windows, per-computer partitions, download gate, PNG capture, retain/dispose.
- Permission model: default-deny agent caps, user-only changes; 24 validated `computer:*` channels; `ComputerPanel.tsx`.

**Company memory (Phase 5)**
- `MemoryService` (`src/main/memoryService.ts`): write pipeline (validation → secret scan via hive `redactSecrets` → writer permission → dedupe → conflict/supersede → approval rule → redacted events + `memory:updated` push), retrieval (prefilter → **ACL before ranking** → overlap×confidence×importance+recency → `budgetChars` cap), `reconcile()` expiry, soft delete + history.
- SQLite migration 3 (`memories`, `SqliteMemoryRepo`); `MemoryMemoryRepo` test double with serialize/restore.
- Scopes global/project/agent/task/computer; 8 validated `memory:*` channels; USER_ACTOR pinned; preload 9 methods + `onMemoryUpdated`.
- CEO integration: dispatch recall into brief (`RELEVANT MEMORY` advisory section, trusted project from the agent's computer record), `memoryContext` on createGoal, human-accept → task-result write (evidence, confidence 0.9) through the same pipeline.
- UI: `MemoryScopePanel` inside MemoryTab (list/approve/edit/history/write, honest states, zero mock persistence); locales ×3 (82 new keys, parity asserted).

**Environment reality (constraints honored)**
- better-sqlite3 is Electron-ABI → real-SQLite tests run only in the labeled Electron harness (`npx electron test/computer-electron.electron.cjs`, 12 steps exit 0 incl. migration-3 restart roundtrip); node tests use in-memory repos.
- No VS Build Tools → `electron-rebuild` blocked; natives load via prebuilds.

## 3. Test & verification evidence

| Milestone | tests | pass | fail | skipped | Source |
|---|---|---|---|---|---|
| P1 baseline (node-pty broken) | 962 | 923 | 25 | 14 | PHASE-1-REPORT |
| P2 end | 990 | 951 | 25 | 14 | PHASE-2-REPORT |
| P3 final | 1040 | 1004 | 22 | 14 | PHASE-3-REPORT |
| P4 final | 1124 | 1088 | 22 | 14 | PHASE-4-REPORT |
| **P5 final (current)** | **1178** | **1142** | **22** | **14** | PHASE-5-REPORT |

- **+54 new tests in P5, all passing, zero regressions**; the same 22 failures are upstream baseline-B environmental (fs-path-containment 10, worktree-deps 5, telemetry 2, agent-token-cap/arabic-terminal/hire-import/hooks-socket/release-notes 1 each) — never claimed as pass.
- Phase 5 suites: store(5) · ipc-validation(9) · scopes(7) · access(6) · pipeline(8) · retrieval(6) · retention(4) · ceo-integration(5, REAL service pair, MOCK PTY only) · panel-contract(4).
- `typecheck:node` = **0**; `typecheck:web` = **33 pre-existing** (`realtime/*` only, = baseline); `build` = **exit 0**.
- Labeled OS evidence: electron harness 12/12 incl. **SQLite migration-3 write→close→reopen roundtrip** of a memory record.

## 4. Repository state

- Uncommitted working tree: modified tracked files (db, index, preload, CommandCenterPanel, locales, icons) + untracked P2–P5 sources, tests, and docs (`PHASE-1..5-REPORT.md`, designs, MASTER docs, `ORBIT-EXPANSION-PLAN.md`). No commits this session; no `package.json` behavior changes since baseline.
- Master docs updated to post-P5 + Orbit classification (this file, GAP-ANALYSIS, ACCEPTANCE-MATRIX, IMPLEMENTATION-ROADMAP).

## 5. Current gate

Phase 5 is **complete and verified**; manual UI walkthrough (`npm run dev` → Command Center → memory tab: list/approve/write, CEO tab: memoryContext block) is the review-gate step. The Orbit vision has been classified against the codebase and sequenced in `ORBIT-EXPANSION-PLAN.md` §2–§4. **Recommended single next milestone: M1 / executed-P6 — Security Core & Safety Supervisor** (closes approval desk, audit log, stop-all, credential revocation; creates the central policy seam that M2/M3/M5/M8 all depend on). Awaiting user review — nothing from M1+ has been started.
