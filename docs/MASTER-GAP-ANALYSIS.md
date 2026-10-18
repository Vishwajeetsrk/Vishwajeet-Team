# MASTER GAP ANALYSIS — Orbit AI (post-Phase 5)

**Date:** 2026-10-10 · Re-score of `AI-COMPANY-OS-GAP-ANALYSIS.md` (68 requirements against the Requirements Pack) **after executed Phases 1–5**. Orbit-vision classification (13 areas) lives in `ORBIT-EXPANSION-PLAN.md` §1 — this file stays the 68-requirement pack view.
**Method (unchanged):** IMPLEMENTED = exists and verified in source/tests · PARTIAL = exists but does not fully meet the requirement · ABSENT = does not exist · INVESTIGATE = needs runtime verification. Evidence cites tests/reports in `munder-difflin/docs/` and `test/`.

## Summary delta

| Status | Original | Post-P4 | Now (post-P5) | Δ (P5) |
|---|---|---|---|---|
| IMPLEMENTED | 23 | 28 | **32** | +4 (memory rows) |
| PARTIAL | 29 | 30 | **26** | −4 |
| ABSENT | 15 | 9 | **9** | 0 (codebase-semantic memory stays open) |
| INVESTIGATE | 1 | 1 | **1** | 0 |
| **Total** | **68** | **68** | **68** | |

\* P4 delta annotated in prior revision. P5: scope layers, provenance, editing UI, cross-agent read ACL each PARTIAL→IMPLEMENTED (§5).

---

## Section-by-section re-score (only rows that changed are annotated; unchanged rows keep original status)

### §2 CEO / Orchestrator — *net: 1 implemented, 5 partial → now 3 implemented, 4 partial* (Phase 3)
| Requirement | Was | Now | Evidence |
|---|---|---|---|
| CEO conversational interface | PARTIAL | **IMPLEMENTED** | `CeoPanel.tsx` + 7 validated `ceo:*` channels; PHASE-3-REPORT |
| Goal creation | PARTIAL | **IMPLEMENTED** | `goals.ts`, `<hive>/goals.json`, 11-state machine; goal-store tests |
| Task graph w/ dependencies | PARTIAL | **IMPLEMENTED** | `dependencyGraph.ts` (cycles, ready/blocked, topo); 8 tests |
| Approval escalation | PARTIAL | PARTIAL | human `ceo:accept` gate exists; centralized approval desk still absent |
| Evidence-based reporting | PARTIAL | PARTIAL | replies + accept record exist; structured evidence object not built |
| Delegation / Progress tracking | IMPLEMENTED | IMPLEMENTED | — |

### §3 Agent Runtime — unchanged (3 I / 4 P)
Agent registry, lifecycle, messaging IMPLEMENTED (upstream). State machine, retry executor, cancellation propagation, per-agent permission matrix remain PARTIAL (note: computer-scoped permission matrix now exists — see §4; agent-wide "can deploy/email" matrix still absent).

### §4 Persistent Computer Runtime — *the Phase 4 delta*
| Requirement | Was | Now | Evidence |
|---|---|---|---|
| Per-agent computer identity | ABSENT | **IMPLEMENTED** | `ComputerManager` + migration-2 SQLite rows; 84/84 computer tests; ids stable across restart (electron phase 2) |
| Isolated filesystem | PARTIAL | PARTIAL | **Directory-level** workspace per computer + default-deny cross-agent authorization w/ traversal refusal (computer-workspace tests); **no OS/container sandbox** (pack `02 §6` wanted Docker for MVP — deviation) |
| Persistent browser profile | ABSENT | **IMPLEMENTED** | `persist:computer-<id>` partitions, distinct session storage, retain/dispose, wipe registry; electron phase 1+2 |
| Terminal / PTY | IMPLEMENTED | IMPLEMENTED | + new: association-only (`start` spawns nothing), `pty:write` gate (computer-terminal tests) |
| Screen capture / viewing | ABSENT | PARTIAL | **Real 7215 B PNG** from hidden window (electron); **no WebRTC/noVNC streaming** (pack `02 §9`) |
| Take control | ABSENT | **IMPLEMENTED** | `watch`/`takeControl`/`releaseControl`, `USER_CONTROL` state, `USER_ACTOR` pinned in main (panel-contract test) |
| Pause / resume | PARTIAL | **IMPLEMENTED** | computer `pause/resume` + PAUSED gates `pty:write`; independent per computer (acceptance step 7) |
| Computer persistence across restart | PARTIAL | **IMPLEMENTED** | SQLite rows + workspace files byte-identical, stale READY → OFFLINE via `reconcile()`, zero replay (electron phase 2 + acceptance steps 8–11) |
| Resource limits | PARTIAL | PARTIAL | op-level limits enforced (`startTimeoutMs`, `screenshotMaxBytes`, `maxBrowserWindows`, `sleepAfterIdleMs`, `maxStartAttempts`); **no CPU/memory/disk limits** |

### §5 Memory — *the Phase 5 delta* (was 2 I / 5 P / 1 A → now 6 I / 1 P / 1 A)
| Requirement | Was | Now | Evidence |
|---|---|---|---|
| Memory.md + semantic search (upstream) | IMPLEMENTED | IMPLEMENTED | preserved verbatim (P5 design §1) |
| Global/project/task scope layers | PARTIAL | **IMPLEMENTED** | 5 scopes incl. agent/computer; migration 3 + `SqliteMemoryRepo`; 7 scope tests + electron restart roundtrip |
| Provenance metadata (who/when/confidence) | PARTIAL | **IMPLEMENTED** | author/sourceKind/sourceRef/confidence/importance/version on every record; pipeline tests |
| Editing UI (browse/search/edit/delete) | PARTIAL | **IMPLEMENTED** | `MemoryScopePanel` (approve/edit/history/delete, honest states); panel-contract 4/4 |
| Cross-agent read ACL | PARTIAL | **IMPLEMENTED** | `canRead` per scope + access_list grant/revoke; ACL-before-ranking (access 6/6, retrieval 6/6) |
| Retention / corrections / conflicts | PARTIAL | **IMPLEMENTED** | expiry + `reconcile()`, soft delete + history, supersede chains, dedupe, SECRET_DETECTED; retention 4/4, pipeline 8/8 |
| Codebase memory (repo-semantic understanding) | ABSENT | ABSENT | structured scoped records ≠ codebase comprehension — still open (Orbit M4-adjacent) |

### §6 Security & Governance — *one row strengthened*
| Requirement | Was | Now | Evidence |
|---|---|---|---|
| Default-deny permissions | PARTIAL | PARTIAL | **Computer capability matrix is default-deny + user-only changes** (`DEFAULT_COMPUTER_PERMISSIONS`, panel-contract test); whole-product action matrix still absent |
| Everything else (vault, approval desk, audit log, stop-all, external-actions toggle, credential revocation, network policy, sandbox, injection defense) | as-was | unchanged | **No work in P1–P4.** Note: upstream has a circuit-breaker ladder + HITL prompts, but no centralized controls |

### §7 AI Gateway — unchanged (4 I / 2 P / 1 A)
Free-first mode still ABSENT; health endpoint + fallback chain still PARTIAL.

### §8 Office Visualization — unchanged (6 I / 1 INVESTIGATE)
Reduced-motion still INVESTIGATE. (Computer events now push `computer:event`/`computer:updated` into the renderer — feeds future office linkage.)

### §9 UI / UX — *one row changed*
| Requirement | Was | Now | Evidence |
|---|---|---|---|
| Computer viewer | ABSENT | PARTIAL | `ComputerPanel.tsx`: status/workspace/terminal facts/browser card/PNG capture/lifecycle/watch/two-step dispose; **no live screen stream**; manual walkthrough pending at gate |
| Agent chat / approval desk / memory inspector | as-was | unchanged | still open |

### §10 Integrations — *one row changed*
| Requirement | Was | Now | Evidence |
|---|---|---|---|
| Browser automation | ABSENT | PARTIAL | Real hidden windows + navigate + capture + download gate exist **for the runtime**; **no Playwright agent-facing browser tool** (deferred by design, interface injected) |
| MCP / GitHub / Slack / Webhooks | IMPLEMENTED | IMPLEMENTED | upstream |
| Vercel/Cloudflare, Gmail/Calendar | ABSENT | ABSENT | — |

---

## Updated Top-10 gaps (priority order) — post-P5

| # | Gap | Was | Now |
|---|---|---|---|
| 1 | Centralized approval desk | #3 | **OPEN — recommended as Orbit M1 core deliverable** |
| 2 | Security audit log (dedicated) | #4 | **OPEN — M1** |
| 3 | Stop-all / emergency controls | #5 | **OPEN — M1** |
| 4 | Central action-policy supervisor (Orbit §8) | — (new from Orbit vision) | **OPEN — M1** (scattered enforcement: hooks/control/breaker/computer, no central catalog; `autoMode` env bypass) |
| 5 | Network/externalActions enforcement | #6 | **OPEN — M2** (P7) |
| 6 | Durable background jobs (Orbit §5) | — (new) | **OPEN — M3** (missions fire-and-forget) |
| 7 | Free-first AI routing | #7 | **OPEN — M6** (P9) |
| 8 | Credential revocation | #10 | **OPEN — M1** |
| 9 | Browser automation (agent-facing Playwright tool) | #2 | **PARTIAL** — M8-adjacent (P11) |
| 10 | Codebase-semantic memory | #8 | **OPEN** (scoped structured memory CLOSED in P5) |

**Closed since P4:** memory scopes + inspector + ACL (P5); CEO chat-UI framing replaced by "conversational Dot surface" as M5 (form-based CEO panel exists — gap is conversation, not existence).

## New gaps surfaced *by* Phase 5 (forward debt)

**Carry-forward from P4 (still open):** screen streaming absent (PNG capture only); `runtimeType: 'local'` only (no container); `SqliteComputerRepo` node-untested (electron harness only); `EventLog.tsx` viewer never built. Phase 5 fixed P4's reconcile-timing wiring bug (computer recovery ran before `persist.open()` — moved into `whenReady`).

1. **Memory ingestion has one live producer** — accepted task-results write; agents have no memory tool/hook surface yet (by design; future agent-hook work, M4/M5-adjacent).
2. **`SqliteMemoryRepo` untested under plain node** (Electron-ABI) — covered by labeled electron harness section 7 (restart roundtrip), same constraint as computers.
3. **Manual UI walkthrough outstanding** — the Phase 5 review-gate step (memory tab + CEO memoryContext).
4. **Orbit classification debt (vision §1–§11):** brand/Dot missing, conversational CEO partial, workforce catalog missing, durable jobs partial, monitoring absent, integrations partial (Slack/webhook/MCP only), supervisor scattered, free-first absent, office↔computer linkage absent — all sequenced in `ORBIT-EXPANSION-PLAN.md` §2 (M1–M12), none started.

**Biggest remaining gaps:** approval desk + central policy supervisor (M1), audit + emergency controls (M1), network enforcement (M2), durable jobs (M3), free-first routing (M6).
