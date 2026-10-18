# MASTER IMPLEMENTATION ROADMAP — Orbit AI (forward)

**Date:** 2026-10-10 · Continues the **executed** numbering (P1 baseline → P2 task engine → P3 live CEO → P4 computer runtime → P5 memory scopes). The forward sequence is now the **Orbit milestone map M1–M12** (`ORBIT-EXPANSION-PLAN.md`), which supersedes the old P6–P12 numbering while serving the same pack gates.
**Status:** P5 complete, at review gate. **Nothing below has been started.** Each milestone ends with an acceptance test and a review gate (rule: no skipping). Vision §12 order: security → persistence/recovery → E2E execution → scheduling → integrations/routing → office/branding.

## Remaining-work map (old plan → Orbit milestone)

| Orbit | Old roadmap | Pack phase | Top-10 gap / Orbit § served |
|---|---|---|---|
| **M1 Security Core & Safety Supervisor** | Ph8 Security (P6) | Ph9 | #1 approval desk, #2 audit, #3 stop-all, #8 revocation, #4 central policy; Orbit §8 |
| M2 Computer Enforcement | P4 debt (old P7) | Ph4+/09 | #5 network policies; Orbit §4 limits |
| M3 Durable Background Jobs | — (new) | — | Orbit §5 (missions durability) |
| M4 Workforce Catalog | — (new) | — | Orbit §3 (+ #10 codebase-semantic memory adjacent) |
| M5 Conversational Dot Surface | — (new, absorbs old "CEO chat UI") | Ph2+ | Orbit §2 |
| M6 Provider Routing & Free-first | Ph9 (old P9) | Ph8 | #7 free-first; Orbit §9 |
| M7 Monitoring & Triggers | — (new) | — | Orbit §6 |
| M8 Integrations Expansion | Ph6 remainder + Ph7 (old P11, + new connectors) | Ph7 | #9 browser automation + Orbit §7 |
| M9 Office Linkage & Panels | Ph10 (old P8, + Ph3 EventLog leftover) | Ph5 | office↔real-event gate; Orbit §11 |
| M10 Brand & Dot Identity | — (new) | — | Orbit §1 |
| M11 Reliability & A11y | Ph11 (old P10) | — | INVESTIGATE reduced-motion |
| M12 E2E & Hardening | Ph12 (old P12) | Ph11/12 | final demo |

---

## Phase 5 — Persistent Scoped Memory — ✅ DONE (executed)
Delivered per design §1–§9: `MemoryService` + 5 scopes + ACL/provenance/retention pipeline, SQLite migration 3, 8 `memory:*` channels, CEO recall/outcome integration, `MemoryScopePanel`, 54/54 tests, electron restart roundtrip. **Report: `PHASE-5-REPORT.md`.** Fixed in passing: Phase 4's computer-reconcile-before-open wiring bug. Gate state: stopped at review gate (manual walkthrough pending).

## M1 / executed-P6 — Security Core & Safety Supervisor *(RECOMMENDED NEXT)*
- **Scope:** (1) **Central `ActionPolicy` module** — one permission catalog + pre-execution check for hive tool calls, computer ops, outbound integrations, memory writes; deny = structured + audited. (2) **Approval Desk** — flagged actions queue wired to existing `ceo:accept` + webhook `awaiting-approval` + new policy denials; UI panel + i18n ×3. (3) **Append-only audit store** — actor/action/target/decision/approval-link/timestamp, secrets-free, queryable. (4) **Emergency controls** — STOP ALL / PAUSE ALL / DISABLE EXTERNAL ACTIONS (user-only), breaker + ControlRegistry on one surface. (5) **Credential revocation** — stored integration secret revoked → agents lose access at next call. (6) **Bypass resistance** — prompt/memory injection cannot grant permissions; supervisor cannot grant or self-approve; `autoMode` env bypass replaced by explicit user setting.
- **Files (planned):** `src/main/actionPolicy.ts`, `src/main/approvals.ts`, `src/main/audit.ts`, `ApprovalDesk.tsx`, `AuditLog.tsx`, control/breaker/hook wiring, tests (`memory-pipeline`-style node suites + panel-contract parity).
- **Gate (pack Ph9 + Orbit §8):** security review passes all P0 cases — approval bypass, privilege escalation, audit completeness.
- **Depends on:** P3 (accept pattern), P4/P5 (op surfaces to police), upstream HITL hooks. **Blocks:** M2 (enforcement point), M3 (sensitive jobs), M5 (plan authorization), M8 (outbound approvals).
- **Security implication:** the catalog itself is the crown jewels — defaults default-deny, changes user-only, reviewed with the user before implementation (the one non-machine-decidable artifact).

## M2 — Computer Enforcement Completion
- **Scope:** enforce `agent.network` (session `webRequest` allowlist, default-deny) and `agent.externalActions` at the tool-call boundary **through the M1 policy module**; decide+implement or formally defer CPU/memory/disk limits; verify `browserNav`/`browserDownloads` gates end-to-end.
- **Gate:** no capability remains "stored but unenforced" without a named deferral. **Depends on:** M1, P4 (done).

## M3 — Durable Background Jobs
- **Scope:** promote fire-and-forget missions to a durable job ledger: per-run execution history, retry limits + backoff, timeouts, cancellation, cost/resource caps, boot recovery **without duplicate external actions**, failure notifications; one-time + recurring + event-triggered (webhook/Slack) job types on the same ledger; desktop-local vs cloud labeled honestly (vision §5 — no offline continuity promises).
- **Files (planned):** `src/main/jobLedger.ts`, scheduler rework, `JobHistory.tsx`, tests (restart-recovery, no-duplicate-external-action).
- **Gate:** kill the app mid-job → relaunch → exactly-once external effect; failed run visibly recorded; cap exceeded → job refuses.
- **Depends on:** M1 (sensitive jobs ride the approval desk). **Blocks:** M7 (monitoring runs on jobs).

## M4 — Workforce Catalog & Capability Selection
- **Scope:** specialist role catalog (researcher/fact-checker, engineer/debugger, designer, QA, DevOps, content/SEO, data-analyst, ops) with configurable responsibilities, skills, model provider, tool sets, working scopes, budgets, permissions; selection matches capability (not idle-only); **unconfigured profiles never presented as functioning agents** (vision §3).
- **Gate:** a goal requiring a skill selects a matching configured specialist; unconfigured role is visibly inert. **Depends on:** M1 (per-role permission sets).

## M5 — Conversational Dot Surface
- **Scope:** chat surface over the **existing** `ceo:*` channels (no competing orchestrator): natural-language goals → clarifying questions when inputs are insufficient → dependency-aware plan preview → dispatch; auto-retry/backoff for failed tasks; evidence-verified `accept` (acceptance-criteria check + artifact references in the summary). Dot's identity here is display-level only (visual mascot = M10).
- **Gate (Orbit §2):** one typed goal → Dot asks a real clarifying question when needed → plan → dispatch → verified summary with evidence. **Depends on:** M1 (plan authorization), M4 (real specialists to select).

## M6 — Provider Routing & Free-first
- **Scope:** free-first policy (local → free → paid-only-with-explicit-authorization, "never silently spend", terms checked at config time), capability+cost-aware model selection over the existing catalog, provider health checks, fallback chain, per-goal/mission cost ceilings, spending alerts.
- **Gate (pack Ph8 + Orbit §9):** switch providers without touching agent code; free mode never invokes paid silently. **Depends on:** usage/cost ledger (done), M3 (mission caps).

## M7 — Monitoring & Triggers
- **Scope:** user-configured monitors (repo changes, build/deploy failures, approved project updates, competitor pages, deadlines, service availability) with explicit scope, frequency, quotas, retention, and notification rules; runs on the M3 job ledger; reuse GitHub `listIssues`/`listCIRuns` as first sources. **No uncontrolled scraping/polling** (vision §6).
- **Gate:** one configured monitor fires one notification within quota; over-quota is refused. **Depends on:** M3, M2 (network policy).

## M8 — Integrations Expansion
- **Scope:** approved connector set (GitHub workflows, email/calendar, files/docs, messaging, CRM/PM, deploy tools, MCP services) on the existing broker + encrypted secret store; **per-integration outbound approval** (not just webhooks); least-privilege scoped credentials; agent-facing Playwright tool over the existing `BrowserRuntime` seam (old P11 remainder).
- **Gate:** one new connector two-way with approval-gated outbound + revocation test. **Depends on:** M1, M3, M7. **Non-goal:** silently accessing personal accounts or exfiltrating private files (vision §7).

## M9 — Office Linkage & Control Panels
- **Scope:** office consumes `computer:event`/`computer:updated` so avatars reflect real terminal/browser activity; event-driven (not polled) state where possible; `EventLog.tsx` viewer (Ph3 leftover); Approval Desk + Audit + Job History panels integrated; screen **streaming** decision (WebRTC/noVNC vs document capture-only).
- **Gate (pack Ph5):** real terminal/browser event → matching office state change, observed live. **Depends on:** M1/M3 panels, P4 events (done).

## M10 — Brand & Dot Identity
- **Scope:** centralized brand config (Orbit AI name, Dot CEO identity, app-owned mascot assets, icon/favicon, color/typography tokens already in `design/tokens.ts`), replace hardcoded "Munder Difflin" strings (package.json, index.html, window title) via config + i18n, retire leftover "Ada" copy, onboarding/tagline. **Brand stays out of DB schemas and runtime contracts** (vision §1). Actual exported assets wired to the UI — no generated mockups as production.
- **Gate:** one config change rebrands the app; no hardcoded product-name literals remain outside the brand module. **Depends on:** none (sequenced last per §12 priority 6).

## M11 — Reliability, Accessibility & Performance
- **Scope:** reduced-motion INVESTIGATE closure, keyboard/SR audit, error boundary, load/failure/recovery tests. **Depends on:** M9.

## M12 — End-to-End & Hardening
- **Scope:** Orbit final demo (Dot goal → specialists → computers → office → approvals → artifacts), re-score every ✅/🟡 in the acceptance matrix, remaining ❌ explicitly accepted or scheduled. **Depends on:** all.

---

## Cross-cutting rules (carry forward)

1. **Preserve upstream; additive only** — no behavior regressions; baseline discipline: suite compared against the known 22 upstream failures, never claimed green.
2. **No fake progress** — no mock agents/screenshots/UI-invented state ("the office is a visualization of a real runtime").
3. **Secrets never in logs/messages/prompts**; permissions enforced in main, never in the UI.
4. **Never PowerShell file cmdlets on UTF-8 source** (edit tool only).
5. **Electron-ABI natives** → real-SQLite evidence lives in labeled `*.electron.cjs` harnesses; `npx electron <script>` only.
6. Every milestone ends with: full node suite + `typecheck:node` + `typecheck:web` (baseline 33) + `build` + phase report + **review gate**.
7. **Orbit additions:** brand config out of runtime contracts (§1); no continuous-execution promises while machine offline (§5); memory never overrides security policy (§10); supervisor grants nothing and self-approves nothing (§8); free claims need current terms (§9).

## Key risks (updated)

| Risk | Status |
|---|---|
| node-pty/ConPTY stderr noise at killAll | documented, non-fatal |
| No VS Build Tools → future native deps blocked | open environmental risk |
| Container isolation never added | open deviation — M2 formal defer-or-spike |
| Scope creep across 12 Orbit milestones | mitigate: strict gates, one milestone at a time |
| Permission catalog design errors (M1) | mitigate: user-reviewed defaults, default-deny, bypass test suite |
| "Munder Difflin" → Orbit AI rename touches runtime strings | mitigate: M10 isolated; runtime IDs/schemas untouched |

**Immediate next step:** user review of the four MASTER documents + `ORBIT-EXPANSION-PLAN.md` + Phase 5 manual walkthrough → approve **M1 (Security Core & Safety Supervisor)** scope and its permission-catalog draft.
