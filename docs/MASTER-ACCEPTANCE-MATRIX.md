# MASTER ACCEPTANCE MATRIX — Orbit AI (post-Phase 5)

**Date:** 2026-10-10 · Traceability: Requirements Pack → executed Phases 1–5 → evidence. Orbit vision mapping: `ORBIT-EXPANSION-PLAN.md` §1.
**Legend:** ✅ PASS (machine-verified, cited) · 🟡 PARTIAL (some evidence, gap named) · ❌ NOT MET · 👤 MANUAL (review-gate walkthrough, cannot be truthfully automated headlessly) · ⬜ not yet in scope

Evidence refs: `P1..P5` = phase reports in `docs/`; `T:*` = test file in `test/`; `E1/E2` = `computer-electron.electron.cjs` phases 1/2 (exit 0); `E3` = same harness section 7, migration-3 memory restart roundtrip (exit 0); `ACC` = `computer-acceptance-demo.cjs` (exit 0, 11 PASS + 2 LIMITATION).

---

## A. Phase gates — Requirements Pack `05-TASKS-ROADMAP.md` (Scheme C)

| Pack gate | Status | Evidence |
|---|---|---|
| Ph0: no unresolved P0 requirement | 🟡 | P0 pillars largely covered by upstream + P1–P4; P0s remaining: approval desk, audit, stop-all (see gap analysis) |
| Ph1: user can log in and see an empty company | 🟡 | App launches (P3 §7, 4 stable runs); upstream has no login (desktop app) — gate's intent (app usable) met |
| Ph2: CEO converts one NL request into a visible task plan | ✅ | P3: goal → dependency plan → dispatch → visible CEO panel (ceo-service 18/18, panel-contract 9/9) |
| Ph3: two agents perform a real concurrent task and communicate | ✅ | Upstream hive mailboxes + P3 dispatch/reply correlation (proven in ceo-live 5/5); concurrent pty proof in ACC |
| **Ph4: two agents have two isolated computers and can work simultaneously** | ✅ | ACC steps 1–7: two computers `READY` simultaneously, two real OS ptys concurrently (distinct pids), isolated workspaces + profiles, cross-agent deny. Caveat: directory-level isolation (container = pack `02 §6` deviation, named) |
| Ph5: a real terminal/browser event causes a matching office state change | 🟡 | `statusTick` maps real pty output → WORKING (T:computer-terminal); browser events → `computer:event` push exists; full office-animation linkage not yet demonstrated |
| Ph6: restart retains approved memory/workspace context | ✅ | Workspace ✅ (E2) + **memory ✅ (P5)**: scoped records roundtrip the real SQLite restart (E3), approved/active only in retrieval; unauthorized cross-agent reads denied (T:memory-access 6/6) |
| Ph7: task auto-loads only relevant skills/tools | ⬜ | Phase 7+ scope |
| Ph8: switch model providers without modifying agent code | ⬜ | Phase 9 scope (upstream provider config exists; free-first/fallback routing absent) |
| Ph9: security review passes all P0 cases | ❌ | approval desk/audit/stop-all/network enforcement still open |
| Ph10–12 (operate like a company / media artifact / hardening) | ⬜ | future |

## B. Pack MVP acceptance — `01-PRD.md` §9 ("The MVP is complete only when…")

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | CEO receives a command | ✅ | P3 IPC `ceo:*` + panel |
| 2 | CEO delegates | ✅ | P3 dispatch via `hive.send` + correlation ids |
| 3 | Two agents can work concurrently | ✅ | ACC step 4 (two live ptys) + upstream hive |
| 4 | Each agent has an isolated computer | ✅ | ACC 1–2 (per-agent id, workspace, profile) |
| 5 | Each computer has a browser, terminal and filesystem | ✅ | browser profile/window (E1), associated real pty (ACC 4), workspace dir (ACC 2) |
| 6 | Agent actions create events | ✅ | hive appendLog + `computer:event`/`computer:updated` pushes |
| 7 | Office reflects those events | 🟡 | upstream office is event-driven; computer→office linkage not yet demonstrated (gap #A Ph5) |
| 8 | Agents communicate | ✅ | upstream mailboxes + P3 reply channel |
| 9 | User can watch a computer | 🟡 | `watch` + PNG capture (E1); no live stream |
| 10 | User can pause/stop/take control | ✅ | ACC 7 + panel lifecycle + `takeControl` (user-only, panel-contract) |
| 11 | Completed work creates an artifact | 🟡 | upstream artifacts/exports exist; CEO evidence object not built |
| 12 | Memory survives restart | ✅ | P5: scoped/provenance memory in SQLite migration 3, restart roundtrip (E3); upstream `memory.md` also persists |

## C. Pack `11-ACCEPTANCE-CRITERIA.md` — key checkboxes by area

| Area | Checkbox (abridged) | Status |
|---|---|---|
| Agent | create agent / role / skills / memory / **persistent computer** | ✅ all (computer = P4) |
| Computer | **agent computer is isolated** | ✅ directory+profile isolation (container caveat) |
| Computer | **browser available** | ✅ E1 real window + navigation |
| Computer | **terminal available** | ✅ ACC 4 real pty + gate |
| Computer | filesystem available | ✅ workspace per computer, traversal refused (T:computer-workspace) |
| Computer | **browser profile unique** | ✅ E1 distinct partitions |
| Computer | **computer survives restart** | ✅ E2 real SQLite + reconcile |
| Computer | screen can be viewed | 🟡 PNG capture only |
| Computer | user can take control | ✅ `USER_CONTROL`, user-only |
| Computer | user can pause/stop | ✅ ACC 7 |
| Computer | terminal/browser commands logged | ✅ hive appendLog (`permission-denied` events proven) |
| Runtime | messages/retry/loop limits | ✅ upstream hop limits (retry executor remains partial) |
| CEO | goals / task graphs / delegate / monitor / status / escalate / stop-pause | ✅ P2+P3 (escalate = human accept gate; "stop agents" = task cancel, partial upstream) |
| Memory | persistent memory / search | ✅ upstream; **scoped editing UI ✅ (P5)** — `MemoryScopePanel` + 8 `memory:*` channels, ACL, provenance, retention |
| UI | command center / task board / activity stream | ✅ upstream + `ceo`/`computer` tabs |
| UI | computer viewer | 🟡 ComputerPanel, no live stream |
| Security | default-deny permissions | 🟡 computer matrix ✅ (P4); product-wide ❌ |
| Security | browser session isolation | ✅ E1 |
| Security | filesystem isolation | ✅ workspace dirs + deny (OS sandbox ❌) |
| Security | secret vault / approval gates / audit logs / stop-all / connector revocation | ❌ open (Phase 6 scope) |
| Free-first | local/free/BYOK providers | ✅ upstream; free-only mode + paid-disable ❌ (Phase 9) |

## D. Executed-phase report checklists — outstanding items

| Report | Unchecked item | Disposition |
|---|---|---|
| P1 | app launch / agent runtime verify (blocked) | 👤 resolved by P3 launch verification; manual agent-terminal walkthrough still recommended at gate |
| P2 | CEO UI, live integration, persistence | ✅ all delivered in P3 (closed) |
| P3 | manual interactive demo (goal→reply→accept→restart) | 👤 review-gate walkthrough — **still open** |
| P4 | acceptance step 5 (UI click-through) | 👤 review-gate walkthrough — **still open** (all other 11 steps ✅ per ACC) |
| P5 | manual walkthrough (memory tab + CEO memoryContext) | 👤 review-gate walkthrough — **still open** (all machine gates ✅ per P5 report) |

## E. Machine-verified evidence roll-up (current, exact)

- Full node suite → **1178 / 1142 pass / 22 fail (upstream baseline-B) / 14 skipped** — +54 vs Phase 4, zero regressions.
- Computer suite → **84/84** (8 files). **Memory suite → 54/54** (9 files: store, ipc-validation, scopes, access, pipeline, retrieval, retention, ceo-integration, panel-contract).
- `typecheck:node` 0 · `typecheck:web` 33 pre-existing (`realtime/*`) · `build` exit 0.
- Electron harness → phases 1+2 exit 0 (computer identity/partitions/restart contract) + **section 7 exit 0** (migration 3 applied, memory write→close→reopen roundtrip) — 12/12 steps.
- Acceptance demo → exit 0 (11 PASS, 2 LIMITATION).

**Gate blockers to clear before M1 (executed-P6):** (1) manual UI walkthroughs of the computer tab and the new memory tab / CEO memoryContext, (2) user review of the four MASTER documents + `ORBIT-EXPANSION-PLAN.md`, (3) approve M1 scope (Security Core & Safety Supervisor).
