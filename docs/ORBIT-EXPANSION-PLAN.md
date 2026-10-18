# ORBIT AI — PRODUCT EXPANSION PLAN

**Date:** 2026-10-10 · **Baseline:** executed Phase 5 complete (memory scopes) · Branch `feature/ai-company-os-foundation`, uncommitted (commit only on request)
**Sources:** Orbit vision (user, 2026-10-10) · `PHASE-1..5-REPORT.md` · MASTER docs · codebase evidence sweep (this document's §1 table cites the sweep).
**Rule (vision §12):** inspect → classify → do not rebuild what works → one milestone at a time → review gate. This plan is the classification + sequencing; **no feature work has started.**

---

## 1. Feature classification — Orbit §1–§11 vs the existing codebase

| # | Orbit area | Classification | Evidence (exists) | Honest gap |
|---|---|---|---|---|
| 1 | Brand & experience (Orbit AI / Dot / mascot / centralized tokens) | **PARTIAL** | Design tokens centralized (`src/renderer/src/design/tokens.ts` + css mirror); logo/favicon via `@brand` alias; window title + `package.json` + `index.html` hardcoded | Name "Vishwajeet Team" hardcoded in ~5 places bypassing i18n; no app-owned mark; **no Dot mascot**; leftover "Ada" copy in `en.json`; no brand config module |
| 2 | Conversational CEO (Dot) | **PARTIAL** | Real CEO: goal DAG, 11-state machine, live dispatch via hive, human accept gate, bounded redeliver, restart reconcile, scoped-memory recall (P3+P5); structured form UI | No conversation surface; no CEO-initiated clarifying questions; `accept()` checks non-empty result only (no evidence verification); no auto-retry/backoff; `AgentCandidate.permissions` always `[]` |
| 3 | Persistent AI workforce | **PARTIAL** | Role vocabulary (`agentRole.ts`), idle-only selection (`agentSelection.ts`), per-role model hints (`modelForRole`), roster durability | **No specialist catalog** (researcher/engineer/designer/QA/DevOps/SEO/data-analyst/ops); selection matches idle, not capability; unconfigured profiles not distinguished in UI |
| 4 | Persistent computers | **VERIFIED COMPLETE** (named limits) | P4: identity + SQLite rows, workspace default-deny, isolated browser partitions, terminal association, lifecycle, reconcile (electron-proven restart); P5 reconcile-timing bug fixed | Limits are documented, not hidden: directory-level (no OS sandbox), PNG capture (no stream), `network`/`externalActions` stored but unenforced (→ P7) |
| 5 | Background execution & scheduling | **PARTIAL** | Config-persisted `ScheduledMission`s + boot catch-up (`syncMissions`), webhook server (`awaiting-approval` mode), Slack server+tunnel, integration broker (loopback, caps), trigger-history ledger (append-only, capped) | Missions are **fire-and-forget**: no per-run history, retry/backoff, timeout, cost cap; failed fire doesn't affect next fire; duplicate prevention = weekly spin guard only; no durable job queue |
| 6 | Proactive monitoring | **MISSING** | GitHub `listIssues`/`listCIRuns` exist but on-demand only; Voice-Michael pollers only | **Zero autonomous watchers** (`fs.watch`: 0 matches); no deadline/SLA, competitor, availability, quota or notification-rule machinery |
| 7 | Integration platform | **PARTIAL** | Encrypted secret store (safeStorage, write-only refs), template registry, loopback broker with per-worker grants, MCP safety tiers, Slack fully two-way, generic webhooks | Only Slack + webhooks + MCP are real; **no email/calendar/CRM/deploy connectors**; outbound-approval exists only for webhooks, not per-integration |
| 8 | Safety supervisor | **PARTIAL** | Deny path in `HookServer` (PreToolUse), `ControlRegistry` (pause/gate/steer/halt), breaker ladder + HITL, computer default-deny matrix (user-only changes) | Enforcement **scattered** across hooks/control/breaker/computer; **no central policy module** validating proposed actions; `autoMode` bypasses hive approval via env var; injection defense is advisory prompt text only |
| 9 | Model & cost routing | **PARTIAL** | `modelForRole` role-regex routing, 6h-TTL model catalog, lifetime cost ledger, per-agent token caps, OSS model list | **No free-first flag anywhere**; no capability/cost-aware selection; no provider health checks or fallback chain; no per-goal/mission cost ceilings; paid-usage authorization path absent |
| 10 | Company memory | **VERIFIED COMPLETE** | P5: 5 scopes + ACL + provenance + corrections/supersede + retention/reconcile + secret rejection + panel + CEO recall/outcome pipeline; 54/54 tests; electron restart roundtrip | (Ingestion beyond accepted task-results has no live producer — by design, future agent hooks) |
| 11 | Real-time office | **PARTIAL** | Rich live scene (`OfficeFloor.tsx` 1.8k lines): agent store feed, real task polling + cork board, ASK ME board from blocked tasks, hive messages | Office **never consumes** `computer:event`/`computer:updated` — no avatar↔terminal/browser linkage; state is task-polled, not event-driven; screen streaming absent |

**Orbit §12/§13 (process):** followed — this plan is the deliverable; one milestone recommended in §4.

## 2. Prioritized milestone sequence

Ordered by vision §12 (security → persistence/recovery → E2E execution → scheduling → integrations/routing → office/branding), each one phase with tests + review gate (existing cross-cutting rules carry forward unchanged).

| M | Milestone (executed-series phase) | Serves | Depends on | Est. size | Security implication |
|---|---|---|---|---|---|
| **M1** | **Security Core & Safety Supervisor** (P6) | §8 + §2 authorization + top-10 #3/#4/#5/#10 | P3 accept-gate, P5 (done) | Large | **Creates** the permission-catalog + central policy seam; approval bypass & escalation tests mandatory |
| M2 | Computer Enforcement Completion (P7) | §4 limits + §8 scope enforcement | M1 policy seam, P4 | Medium | Closes "stored but unenforced" `network`/`externalActions`; default-deny webRequest |
| M3 | Durable Background Jobs (new P7.5) | §5 | M1 approvals (sensitive jobs), existing missions infra | Large | Retry must never duplicate external actions; execution history is audit-adjacent |
| M4 | Workforce Catalog & Capability Selection (new) | §3 + §2 delegation quality | M1 (permissions per role) | Medium | "Unconfigured ≠ functioning" honesty rule; least-privilege tool sets |
| M5 | Conversational Dot Surface (new) | §2 | M1 (clarify→plan authorization), M4 (real specialists) | Large | Chat must route through same validated `ceo:*` channels — no new unchecked paths |
| M6 | Provider Routing & Free-first (P9) | §9 | usage/cost ledger (done), M3 cost caps | Medium | "Never silently spend" — paid authorization is a security property |
| M7 | Monitoring & Triggers (new) | §6 | M3 job system, M2 network policy | Medium | Quotas/frequency caps prevent uncontrolled scraping; retention rules |
| M8 | Integrations Expansion (P11 remainder) | §7 | M1 outbound approvals, M3, M7 | Large | Least-privilege credentials; per-integration approval; no silent personal-account access |
| M9 | Office Linkage & Panels (P8) | §11 | P4 events (done), M2 | Medium | No simulated activity — event-driven only |
| M10 | Brand & Dot Identity (new) | §1 | none (parallelizable but sequenced last per §12) | Small | Keep brand config out of runtime contracts (vision §1) |
| M11 | Reliability & A11y (P10) | §11 quality | M9 | Small | — |
| M12 | E2E & Hardening (P12) | final demo | all | Medium | Final security review pass |

**Explicit non-rebuilds** (vision §12 "do not implement features that already work"): computer runtime (M-limits only), memory system (done — future work is ingestion producers, not storage), CEO task engine (M5 adds a surface, not a second orchestrator), office scene (M9 links it, doesn't replace it), Slack/webhook/MCP integrations (M8 adds connectors, doesn't rewrite the broker).

## 3. Cross-cutting constraints (unchanged + Orbit additions)

1. All 6 existing cross-cutting rules carry forward (upstream preservation, no fake progress, secrets discipline, Electron-ABI labeling, review gates, baseline test discipline).
2. **Orbit additions:** brand settings stay out of DB schemas and agent runtime contracts (§1); desktop-local vs cloud execution must be labeled honestly — no continuous-execution promises while machine offline (§5); memory never overrides security policy (§10); supervisor cannot grant permissions or self-approve (§8); free claims require current terms check (§9).

## 4. Recommended next milestone — and stop

**M1 / executed-P6: Security Core & Safety Supervisor.**

Why this one, alone:
- Vision §12 priority 1 is **security and correctness**, and it gates M2/M3/M5/M8 (every later milestone either enforces through or is approved by the policy seam).
- It closes four of the current Top-10 gaps at once (#3 approval desk, #4 audit log, #5 stop-all, #10 credential revocation) and is the prerequisite for pack gate Ph9 ("security review passes all P0 cases" — currently the only ❌ in the acceptance matrix).
- It converts today's scattered enforcement (hooks + control + breaker + computer) into the central supervisor the vision requires, **without** granting the supervisor any grant-power.

**M1 acceptance criteria (draft for the P6 design doc):**
1. Central `ActionPolicy` module: every proposed tool action (hive tool call, computer op, outbound integration, memory write) is validated against a permission catalog before execution; deny is structured + audited.
2. Approval Desk: flagged actions queue with approve/deny; `ceo:accept` and webhook `awaiting-approval` feed the same desk; UI panel + i18n ×3.
3. Append-only audit store: actor, action, target, decision, approval link, timestamp; secrets-free; queryable panel.
4. Emergency controls: STOP ALL / PAUSE ALL / DISABLE EXTERNAL ACTIONS, user-only; breaker + control registry wired to one surface.
5. Credential revocation: revoke stored integration secret → all agents lose access at next call.
6. Bypass resistance tests: prompt/memory injection cannot grant permissions; supervisor self-approval impossible; `autoMode` no longer bypasses hive approval without an explicit user setting.
7. Full gate suite: +node tests, electron harness only where ABI demands, typecheck/build baselines held, phase report + review gate.

**Cost estimate:** one phase comparable to executed-P4/P5 (design doc → implementation → 9-ish test suites → report), plus human review of the permission catalog (the one artifact that cannot be fully machine-decided).

Stop here per §13 — awaiting review before any P6 design or implementation begins.
