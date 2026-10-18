# IMPLEMENTATION ROADMAP — AI Company OS

**Date:** 2026-10-09
**Branch:** `feature/ai-company-os-foundation`
**Source:** Gap analysis from `docs/AI-COMPANY-OS-GAP-ANALYSIS.md`

**Execution status (2026-10-09):** foundation phases complete — baseline + gap analysis (`docs/UPSTREAM-BASELINE.md`, `docs/AI-COMPANY-OS-GAP-ANALYSIS.md`), CEO core (`docs/PHASE-2-REPORT.md`), live CEO integration (`docs/PHASE-3-REPORT.md`, plan in `docs/PHASE-3-INTEGRATION-PLAN.md`). Final verification: 1040 tests / 1004 pass / 22 baseline-B environmental failures / 14 skipped; typecheck:node 0 errors; `npm run build` exit 0; app launch verified. **Awaiting the Phase 3 review gate before starting the next phase.** The phase numbers below are the long-term plan; the executed foundation work is documented in the reports.

---

## Guiding Principles

1. **Preserve upstream functionality** — never break existing Vishwajeet Team features
2. **Extend, don't replace** — build on existing systems (hive, pty, hooks, breaker)
3. **Real events only** — office visualization reflects actual runtime state
4. **Small, testable phases** — each phase has a review gate
5. **Document deviations** — every architectural change from upstream is documented

---

## Phase 1: Baseline Verification (current)

**Goal:** Get the unmodified Vishwajeet Team running locally.

- [x] Clone repository
- [x] Create feature branch
- [x] Inspect architecture and source
- [x] Create baseline documentation
- [x] Install dependencies (`npm install`) — with recorded environment repairs (VS C++ Build Tools absent; prebuilds used)
- [x] Run tests (`npm run test:focused`) — 1040/1004/22/14; the 22 are upstream baseline-B environmental failures
- [x] Type check (`npm run typecheck`) — typecheck:node 0; typecheck:web 33 pre-existing in `realtime/*`
- [x] Launch app (`npm run dev`) — verified: main+preload+renderer, window "Vishwajeet Team"
- [ ] Verify one agent can start and show terminal output — manual gate item
- [ ] Verify office reflects real agent state — manual gate item

**Gate:** App launches, one agent works, tests pass.

---

## Phase 2: CEO Command Interface

**Gap:** No dedicated CEO chat UI; Michael is a terminal agent.

**Approach:** Add a CEO panel to the Command Center that sends messages to the GOD agent via the existing hive mailbox system.

**Files to modify:**
- `src/renderer/src/components/` — new `CEOPanel.tsx`
- `src/renderer/src/store/` — CEO message state
- `src/main/hive.ts` — reuse existing outbox delivery to GOD agent

**New files:**
- `src/renderer/src/components/CEOPanel.tsx`
- `test/ceo-panel.test.cjs`

**Deviation from upstream:** None — purely additive UI + reuse of existing hive routing.

---

## Phase 3: Durable Task Tracking & Event History

**Gap:** Tasks are flat; no enforced state machine; no structured event history.

**Approach:** Add a task state machine layer on top of the existing `tasks.json` ledger. Add an event log viewer to the Command Center.

**Files to modify:**
- `src/main/hive.ts` — add task state transition validation
- `src/renderer/src/components/TasksKanban/` — add state enforcement
- `src/renderer/src/components/` — new `EventLog.tsx`

**New files:**
- `src/shared/taskStateMachine.ts`
- `src/renderer/src/components/EventLog.tsx`
- `test/task-state-machine.test.cjs`

**Deviation from upstream:** Task state machine is new; upstream tasks are free-form JSON.

---

## Phase 4: Per-Agent Workspace & Memory Isolation

**Gap:** No project-scoped memory; no memory editing UI; no codebase memory.

**Approach:** Extend the hive memory model with project scope. Add memory inspector UI. Integrate codebase-memory-mcp.

**Files to modify:**
- `src/main/hive.ts` — add project-scoped memory directories
- `src/main/memory.ts` — add project scope to MemPalace config
- `src/renderer/src/components/MemoryPanel/` — add edit/delete/provenance UI

**New files:**
- `src/shared/memoryScopes.ts`
- `src/renderer/src/components/MemoryInspector.tsx`
- `test/memory-scope-isolation.test.cjs`

**Deviation from upstream:** Memory scopes are new; upstream has per-agent `memory.md` only.

---

## Phase 5: Persistent Computer Lifecycle

**Gap:** No explicit computer object; no container isolation; no screen capture.

**Approach:** Introduce a `ComputerManager` in the main process that wraps each agent's PTY + worktree + (future) browser profile into a computer lifecycle. Use Docker containers for isolation (Rakazo supervisor pattern).

**Files to modify:**
- `src/main/index.ts` — register ComputerManager IPC
- `src/main/pty.ts` — add computer lifecycle hooks

**New files:**
- `src/main/computer.ts` — ComputerManager (lifecycle, state, permissions)
- `src/shared/computer.ts` — Computer types
- `src/renderer/src/components/ComputerStatus.tsx`
- `test/computer-lifecycle.test.cjs`

**Deviation from upstream:** Computer abstraction is new; upstream has PTY sessions only.

---

## Phase 6: Browser Session Isolation & Inspection

**Gap:** No browser automation; no browser profiles; no screen viewing.

**Approach:** Add Playwright-based browser tool per agent. Each agent gets a persistent browser profile directory. Screen viewing via screenshot polling (VNC/WebRTC deferred).

**Files to modify:**
- `src/main/index.ts` — register browser IPC
- `src/main/integrations.ts` — add browser connector

**New files:**
- `src/main/browser.ts` — BrowserManager (Playwright, per-agent profiles)
- `src/shared/browser.ts` — Browser types
- `src/renderer/src/components/BrowserPanel.tsx`
- `test/browser-profile-isolation.test.cjs`

**Deviation from upstream:** Browser automation is entirely new.

---

## Phase 7: Terminal, Screen, File & User-Control Permissions

**Gap:** No fine-grained per-agent permission matrix; no take-control mode.

**Approach:** Add a permission matrix to agent config. Implement take-control as a flag that pauses agent input and routes terminal to user.

**Files to modify:**
- `src/main/config.ts` — add permission matrix to agent config
- `src/main/control.ts` — add take-control mode
- `src/main/pty.ts` — gate input when take-control is active

**New files:**
- `src/shared/permissions.ts` — Permission matrix types
- `test/permission-matrix.test.cjs`

**Deviation from upstream:** Permission matrix is new; upstream uses provider-level permission modes only.

---

## Phase 8: Security, Approvals & Emergency Controls

**Gap:** No centralized approval desk; no audit log; no stop-all; no credential revocation.

**Approach:** Add an approval queue that intercepts HITL prompts. Add audit log writer. Add global stop-all. Add credential revocation.

**Files to modify:**
- `src/main/control.ts` — add approval queue
- `src/main/breaker.ts` — add global stop-all
- `src/main/integrationBroker.ts` — add credential revocation

**New files:**
- `src/main/audit.ts` — Audit log writer
- `src/main/approvals.ts` — Approval queue manager
- `src/renderer/src/components/ApprovalDesk.tsx`
- `src/renderer/src/components/AuditLog.tsx`
- `test/approval-gate.test.cjs`
- `test/audit-log.test.cjs`

**Deviation from upstream:** Approval queue and audit log are new; upstream HITL is native to agent sessions.

---

## Phase 9: Provider Routing & Spending Policies

**Gap:** No free-first mode; no configurable fallback chain.

**Approach:** Add a provider routing layer that respects free-first policy. Add spending caps and alerts.

**Files to modify:**
- `src/main/modelCatalog.ts` — add free-first routing
- `src/main/usage.ts` — add spending policy enforcement

**New files:**
- `src/shared/providerPolicy.ts` — Free-first routing types
- `test/provider-routing.test.cjs`

**Deviation from upstream:** Provider routing policy is new; upstream selects provider per agent config.

---

## Phase 10: Office & Command Center Improvements

**Gap:** No computer viewer; no memory inspector; no approval desk in UI.

**Approach:** Add computer viewer panel. Add memory inspector. Add approval desk. All driven by real events.

**Files to modify:**
- `src/renderer/src/App.tsx` — add new panels to layout
- `src/renderer/src/components/CommandCenterPanel/` — add tabs

**New files:**
- `src/renderer/src/components/ComputerViewer.tsx`
- `src/renderer/src/components/MemoryInspector.tsx`
- `src/renderer/src/components/ApprovalDesk.tsx`

**Deviation from upstream:** New UI panels; existing office floor and layout preserved.

---

## Phase 11: Reliability, Recovery, Accessibility & Performance

**Gap:** No keyboard navigation audit; no screen reader labels; no load testing.

**Approach:** Add accessibility audit. Add keyboard navigation. Add error boundary. Add performance monitoring.

**Files to modify:**
- `src/renderer/src/components/` — add ARIA labels, keyboard handlers
- `src/renderer/src/App.tsx` — add error boundary

**New files:**
- `test/accessibility.test.cjs`
- `test/error-boundary.test.cjs`

---

## Phase 12: End-to-End Testing & Documentation

**Goal:** Full E2E test of the AI Company OS workflow.

- [ ] CEO receives command
- [ ] CEO creates goal and task graph
- [ ] CEO delegates to specialist
- [ ] Specialist computer starts
- [ ] Specialist uses terminal/browser/files
- [ ] User watches computer
- [ ] User pauses/stops agent
- [ ] Artifact is produced
- [ ] Memory survives restart
- [ ] Office reflects real events throughout

---

## Dependency Graph

```
Phase 1 (Baseline)
    │
    ▼
Phase 2 (CEO UI) ─── Phase 3 (Task Tracking)
    │                    │
    ▼                    ▼
Phase 4 (Memory) ─── Phase 5 (Computers)
    │                    │
    ▼                    ▼
Phase 6 (Browser) ── Phase 7 (Permissions)
    │                    │
    ▼                    ▼
Phase 8 (Security/Approvals) ── Phase 9 (Provider Routing)
    │
    ▼
Phase 10 (Office UI)
    │
    ▼
Phase 11 (Reliability)
    │
    ▼
Phase 12 (E2E)
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| node-pty native build fails on Windows | Medium | High | Document VS C++ workload requirement; provide fallback |
| Electron app cannot connect to agent CLIs | Medium | High | Verify CLI availability in Phase 1; document prerequisites |
| Hive git repo corruption | Low | High | Single-committer pattern already in place; backup before changes |
| Scope creep | High | Medium | Strict phase gates; no skipping |
| Upstream license conflict | Low | Medium | MIT source code only; original assets only |

---

**Roadmap updated at execution start. Phase 1 verification complete except the two manual gate items above; CEO foundation phases 2–3 executed per the reports. Awaiting Phase 3 review gate.**
