# PHASE-3-INTEGRATION-PLAN — Connect CEO Orchestrator to the Live Vishwajeet Team Hive

**Date:** 2026-10-09
**Branch:** `feature/ai-company-os-foundation`
**Status:** EXECUTED — all sections below implemented; deviations recorded in §11 and in `docs/PHASE-3-REPORT.md`

---

## 0. Verified baseline (measured, not assumed)

| Check | Command | Result |
|---|---|---|
| Full suite | `npm run test:focused` | **996 tests, 957 pass, 25 fail, 14 skipped** (2026-10-09) |
| Previous milestone | same | 990 tests, 951 pass, 25 fail, 14 skipped (end of Phase 2) |
| Baseline (Phase 1, upstream only) | same | 962 tests, 923 pass, 25 fail, 14 skipped |
| Typecheck | `npm run typecheck:node` | 3 errors, all pre-existing upstream (`analytics.ts`, `fs.ts`, `preload/index.ts`) |
| Lint | — | **No lint script or eslint/prettier config exists in this repo** (verified). Checks = typecheck + tests + build |
| **Final (end of Phase 3)** | `npm run test:focused` | **1040 tests, 1004 pass, 22 fail, 0 cancelled, 14 skipped**; typecheck:node **0 errors**; typecheck:web 33 (all pre-existing `realtime/*`); `npm run build` exit 0; `npm run dev` app launch verified (2026-10-09) |

**Failure accounting:** the "39 failing" figure from the previous report = **25 failed + 14 skipped** (990 − 951). The 25 failures are environmental and pre-date our work (Windows: `node-pty` native build missing VS C++ tools, symlink `EPERM`, path-containment). They are tracked as **baseline-B**, separate from any new regression, and listed by file in `docs/PHASE-1-REPORT.md` / `docs/PHASE-3-REPORT.md`.

---

## 1. Audit findings — exact integration points

### 1.1 Mailbox (verified signatures)

- `hive.send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage` — `src/main/hive.ts:1671`. Synchronously writes `<hive>/agents/<to>/inbox/<id>.json` (atomic temp+rename), appends `log.jsonl`, emits `hive:message` push, git-commits (`git add -A`, single-committer).
- **There is no inbox watcher and no per-agent daemon.** A live agent learns of mail only when the harness *types a wake* into its PTY:
  - renderer 4 s poll → one-pending nudge, idle-only (`src/renderer/src/hooks/useHive.ts:690-730`, `:782-929`);
  - main-process fallback watchdog 15 s (`runWorkerWakeBeat`, `src/main/index.ts:5204-5271`, guards in `src/main/workerWake.ts`).
  - Non-inbox providers bypass via `hive:terminalHandoff`.
  → **Conclusion: `hive.send()` + existing wake machinery IS the delivery path. Phase 3 must NOT build a second dispatch loop.**
- Reply path: agent writes `outbox/*.json` → main router (1.5 s, `startRouter` `src/main/hive.ts:1832`) → `routeMessage()` → recipient inbox. **Every routed message passes `routedObserver`** (`src/main/hive.ts:1778`, settable once via `setRoutedObserver` `:1784`). Today the single observer slot is used by closing time (`src/main/index.ts:3833`).
  → **Integration: fan out that one line to closingTime + CeoService.**
- Message protocol: `HiveMessage` (`src/main/hive.ts:69-82`), acts `'request'|'inform'|'propose'|'query'|'agree'|'refuse'|'done'`, correlation fields `conversation`, `in_reply_to`, `requires_reply`. CEO already uses `conversation: goalId`.

### 1.2 Agents and sessions

- Registry: `hive.registry()` → `{ godId, agents: Record<id, RegistryAgent> }`; `RegistryAgent.status: 'idle'|'working'|'blocked'|'gone'`, `archived`, `provider`, `role`, `capabilities`, `cwd` (`src/main/hive.ts:160-183`).
- Live sessions: `ptyToAgent` map in `src/main/index.ts:229`, reverse lookup `ptyForAgent(agentId)` (`index.ts:1107`). PTY exit → `setExitHandler` (`index.ts:595`) → `hive.recordAgentExit` + `teardownPty`.
- Spawn door: `spawnAgentCore(opts, owner)` (`index.ts:2627`) — module-local; the only exported-safe spawn is the renderer path (`pty:spawn` IPC `index.ts:2611`). Provider default command: `providerPreset(...).defaultCommand` (`src/shared/agentProvider.ts:66`), tokenized by `buildWorkerLaunch` (`src/main/workerLaunch.ts:24`).

### 1.3 Persistence

- `hive/tasks.json` = the task ledger; owned by `HiveManager` (`writeTasks` `:1924`, merge semantics `mergeTaskLedger` `src/shared/taskLedger.ts:53`). **Reuse it for kanban-visible cards; do not create a second card store.**
- Atomic write helper: `hive.atomicWriteJson` is **private** (`:2800`); public: `root()` `:446`, `enabled()` `:450`, `ensureHive()` `:619`, `appendLog()` `:2750`, `commit()` `:2893`.
- Versioned-JSON precedent: `RosterSnapshot { version: 1, savedAt }` + temp+rename (`src/main/roster.ts:37-45,158-166`); SQLite migrations pattern (`src/main/db.ts:12-16`). Goals are **not** persisted anywhere today (verified: 0 matches for goal persistence).

### 1.4 Renderer / IPC

- Command Center = `src/renderer/src/components/CommandCenterPanel.tsx`; tabs via `CCTab` union (`:49-50`), `TABS` array (`:68-80`), body block (`:294-338`). New tab = edit those three + i18n keys (`src/renderer/src/i18n/locales/{en,ar,zh-CN}.json`).
- Preload: `window.cth` via `contextBridge` (`src/preload/index.ts:567,1429`); invoke methods are camelCase; subscriptions are `on<Event>(cb): () => void` (returns unsubscribe, `:866-872` pattern).
- IPC conventions: `ipcMain.handle('<domain>:<verb>')`, args typed `unknown` + `typeof` guards, always returns `{ ok, error? }` (examples `index.ts:3480,3514,2611`). **No schema library exists — manual guards are the house style.**
- Panel state: poll pattern of `TasksKanban` (5 s, `TasksKanban.tsx:131-151`) + optional push; terminal jump idiom: `select(agentId); setFullscreen(agentId)` (`store.ts:698,1000`).

### 1.5 CEO code (ours, dormant)

- `src/main/ceo.ts` (CEOOrchestrator) and `src/main/ceoLive.ts` (CEOLiveIntegration) exist, tested (34 tests), **imported by nothing in the running app**. Phase 3 wires them in rather than rewriting them.

---

## 2. Architecture decisions

| Decision | Rationale |
|---|---|
| **One dispatch loop: none** — `hive.send()` + existing wake machinery | Agents already poll their own inboxes when nudged; a second loop would duplicate proven code |
| `GoalStore` at `<hive>/goals.json`, versioned `{version, savedAt, goals[]}` | Rides the existing single-committer git repo; follows `RosterSnapshot` versioning; tasks stay in `tasks.json` (no second card store) |
| Goals hold plans + per-task **runtime record** (state, dispatch id, attempts, result, errors) | Meets STEP 3 fields (correlation ids, retry info, artifact refs, cancellation) without touching the ledger schema |
| `CeoService` in main with injected deps (`hive`, `goalStore`, `ptyForAgent`, `spawnSession`, `emit`) | Testable without Electron; wiring mirrors `registerRealtimeActionIpc({ spawnAgent })` |
| Observer fan-out: change **one line** (`index.ts:3833`) to feed both closingTime and CeoService | Only sanctioned upstream edit; closing time keeps its observer; replies arrive with real evidence (delivery time, sender, `in_reply_to`) |
| Reply → state only via validated runtime events; **completion requires human acceptance** | Agent claim of "done" moves task to REVIEW with result recorded; COMPLETED only via explicit `ceo:accept`. No fake completion |
| Rich state ↔ ledger mapping is a thin, documented translation | Kanban keeps its 4 statuses; the 11-state machine stays authoritative in `goals.json` |
| Dispatch refused if agent archived/offline is *surfaced*, not hidden | "Never silently mark an unconfirmed delivery as successful" |
| Cancellation = goal-store CANCELLED + ledger card removed (upstream dismiss semantics) + optional cancel notice message to the agent | Reuses existing kanban delete semantics; never kills the agent process (breaker/pty:kill own that) |
| Restart = load + reconcile against mailbox facts, **no automatic redispatch** | Bounded manual redelivery only (`attempts`, cap 3) |

---

## 3. Data model — `<hive>/goals.json` v1

```jsonc
{
  "version": 1,
  "savedAt": "ISO",
  "goals": [{
    "id": "uuid", "title": "...", "description": "...",
    "status": "DRAFT|ACTIVE|COMPLETED|CANCELLED",
    "createdBy": "human|<panel>", "createdAt": "ISO", "updatedAt": "ISO",
    "plans": [{
      "id": "uuid", "title": "...", "description": "...",
      "requirements": { "roles": [], "skills": [] },
      "dependencies": ["planId"], "acceptanceCriteria": ["..."],
      "requiresApproval": false
    }],
    "tasks": [{
      "planId": "uuid",              // == hive ledger card id
      "state": "PLANNED|ASSIGNED|RUNNING|REVIEW|COMPLETED|... (11 states)",
      "agentId": "agent-1 | null",
      "agentName": "...", "agentRole": "...",
      "dispatchMessageId": "hive msg id | null",
      "attempts": 0, "maxAttempts": 3,
      "sessionState": "live|starting|offline|unknown",
      "result": "agent reply body / artifact refs | null",
      "error": "last failure reason | null",
      "events": [{ "at": "ISO", "kind": "...", "detail": "...", "messageId": "..." }],  // capped
      "updatedAt": "ISO"
    }],
    "processedMessageIds": ["..."]    // dedupe ledger, capped FIFO
  }]
}
```

- **Write:** temp sibling + `renameSync` (copy of `persistConfig` discipline), then `hive.commit('hive: goals …')`. Read-modify-write per mutation (main process is single-threaded).
- **Validation on read:** `version` must be `1` (unknown → quarantine file to `goals.json.corrupt-<ts>`, start fresh, log `appendLog({kind:'goals-corrupt'})`); entries failing shape checks are dropped individually, not fatally.
- **Ledger card:** created via `hive.addTask` (idempotent by id — duplicate-dispatch guard #1) with the documented mapping:
  `PLANNED/ASSIGNED → todo`, `RUNNING/REVIEW → doing`, `BLOCKED/WAITING/FAILED → blocked`, `COMPLETED → done`, `CANCELLED → card removed`.

---

## 4. Flows

### 4.1 Execute (STEP 4)

```
ceo:execute {goalId}
 → validate goal + plans (existing validatePlan: deps exist, no cycles)
 → delegate (existing: ready tasks only, selectAgentForTask, archived excluded)
 → for each ready plan:
     registry check: agent exists && !archived  → else record error, state BLOCKED, no send
     hive.addTask(card)                          → idempotent (ledger)
     hive.send({ from: godId, to: agentId, act: 'request',
                 subject: `Task: ${title}`, conversation: goalId,
                 in_reply_to: null, requires_reply: true, body: brief })
     brief = objective, output, acceptance criteria, scope (cwd), deps,
             permitted tools (roles/caps), required response format
             ("reply with act done + result"), escalation (requires_approval),
             correlation block: GOAL=… TASK=… (plan id) MSG=<msg.id>
     record { dispatchMessageId: msg.id, attempts++, state: ASSIGNED,
              sessionState: live ? 'live' : 'offline' }
 → errors returned to panel honestly (partial success allowed, reported per task)
```

- **Delivery confirmation = the file write + returned msg id** (hive.send is synchronous). If the agent has no live PTY we record `sessionState: 'offline'` and say "filed, awaiting session" — never "delivered to running agent". Existing wake machinery picks the mail up when a session exists.

### 4.2 Responses (STEP 6)

```
routedObserver fan-out → ceoService.onRouted(msg, targets)
 filter (all must pass):
   1. msg.conversation === goalId (known goal)
   2. msg.from === task.agentId       (origin validation — god/human/system ignored)
   3. msg.id not in processedMessageIds (dedupe)
   4. msg.in_reply_to === dispatchMessageId OR act ∈ {agree, done, refuse, inform}
 map:
   agree  → ASSIGNED→RUNNING (ledger 'doing')
   done   → → REVIEW, result = body  (ledger 'doing'; REVIEW = awaiting acceptance)
   refuse/inform(blocked language) → BLOCKED (ledger 'blocked', error=body)
   progress-ish inform → event logged, state unchanged unless RUNNING
 invalid/malformed/unrelated/delayed → ignored safely (tests cover each)
persist processedMessageIds (capped 500) + emit ceo:updated
```

- **Never** `REVIEW → COMPLETED` automatically; acceptance criteria shown in the panel, human clicks Accept → `ceo:accept` validates state === REVIEW → COMPLETED, ledger `done`.
- Agent session exit while tasks active (`teardownPty` hook): affected ASSIGNED/RUNNING tasks → event `session-exit`, `sessionState:'offline'`, state → BLOCKED with reason (visible, not fatal).

### 4.3 Restart reconciliation (STEP 3/8)

On `bootstrapHiveServices`:
1. Load `goals.json` (validated/quarantined as in §3).
2. For each non-terminal task: read real facts — ledger card present? dispatch message still in `inbox/` (unread) vs moved to `inbox/.done/`? reply seen? PTY live?
3. Outcomes: ASSIGNED + message still in inbox + no session → keep ASSIGNED, `sessionState:'offline'`, event `reconciled:awaiting-session`. ASSIGNED + message gone + no reply → keep ASSIGNED, event `reconciled:mailbox-consumed`, **do not resend**. RUNNING + no live PTY + no reply → BLOCKED `agent session lost`. Terminal states untouched.
4. **No dispatch is issued during reconciliation.** Manual `ceo:redeliver` (attempts < 3) is the only resend path.

### 4.4 Failure matrix (STEP 8)

| Failure | Behavior |
|---|---|
| Agent archived/unknown | no send; task BLOCKED + error surfaced in panel |
| Offline (no PTY) | send files mail; `sessionState:'offline'`; panel shows "awaiting session"; `ceo:ensureSession` (optional, injected spawn) starts it via `spawnAgentCore` |
| Spawn failure | error recorded, `sessionState:'offline'`, state unchanged; panel shows error |
| PTY exit mid-task | BLOCKED + event (§4.2) |
| Duplicate execute | `addTask` idempotent + dispatch only from PLANNED/FAILED-eligible states + attempts cap → no duplicate send |
| Duplicate/late reply | processedMessageIds dedupe; delayed replies still valid (state machine guards) |
| Persistence failure | write throws → `{ok:false,error}` to panel; in-memory state left consistent; next mutation retries write |
| Cancel | CANCELLED (terminal), ledger card removed, best-effort `inform` cancel message to agent; never kills PTY |
| Persistence crash mid-write | temp+rename ⇒ old file intact |

---

## 5. Files

**New (all additive):**

| File | Purpose |
|---|---|
| `src/main/goalStore.ts` | versioned, validated, atomic `<hive>/goals.json` store |
| `src/main/ceoService.ts` | execute / onRouted / accept / cancel / redeliver / ensureSession / reconcile |
| `src/main/ceoIpcValidation.ts` | pure input validators for IPC (unit-testable without Electron) |
| `src/renderer/src/components/CeoPanel.tsx` | Command Center tab: command input, goal/task list, states, controls |
| `test/goal-store.test.cjs` | STEP 9.1-3 |
| `test/ceo-service.test.cjs` | STEP 9.4-14 (real `HiveManager` in temp dir = genuine mailbox routing; spawn/pty faked — clearly labeled) |
| `test/ceo-ipc-validation.test.cjs` | STEP 9.15 (input validation) |
| `test/ceo-panel-contract.test.cjs` | static source-contract test: tab registered, unsubscribe pattern present (labeled static, not behavioral) |
| `docs/PHASE-3-INTEGRATION-PLAN.md` | this file |

**Modified (minimal, additive):**

| File | Change |
|---|---|
| `src/main/index.ts` | observer fan-out (line ~3833); `// ─── IPC: ceo ───` block; bootstrap `ceoService.reconcile()`; exit-handler hook call; `spawnSession` injection |
| `src/preload/index.ts` | `ceoState/ceoCreateGoal/ceoExecute/ceoCancel/ceoAccept/ceoRedeliver/ceoEnsureSession` + `onCeoUpdated` (returns unsubscribe) |
| `src/renderer/src/components/CommandCenterPanel.tsx` | `'ceo'` in `CCTab`, one `TABS` row, one body line |
| `src/renderer/src/i18n/locales/{en,ar,zh-CN}.json` | `commandCenter.tabs.ceo` + CeoPanel strings |
| `docs/IMPLEMENTATION-ROADMAP.md`, `docs/PHASE-3-REPORT.md` | final status |

---

## 6. IPC contract (validated, `{ok,error?}` responses)

`ceo:state` → snapshot `{goals, reconciledAt}` · `ceo:createGoal {title, description, tasks[]}` · `ceo:execute {goalId}` · `ceo:accept {goalId, planId}` · `ceo:cancel {goalId, planId?}` · `ceo:redeliver {goalId, planId}` · `ceo:ensureSession {agentId}` (injected `spawnSession`, provider preset command, registry cwd). Push: `ceo:updated` (payload: goalId). All args `unknown` + type guards; no generic message-send or shell channel — **no raw Node, no arbitrary command IPC**.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Observer fan-out breaks closing time | fan-out wraps existing callback first, try/catch each (matches `:1778` style); closing-time tests must stay green |
| `hive.commit()` cost per goal write | batch: one commit per mutation (same as tasks), no commits during reconcile |
| Renderer test gap (no renderer harness) | source-contract test + i18n tests; behavioral coverage lives in main-process tests |
| node-pty native build blocks live acceptance (STEP 10) | attempt; if blocked, record exact blocker — **no fake demonstration** (§STEP 10 rule) |
| Scope: god agent also reads its inbox and may react to task mail | replies are addressed `to: godId`; messages carry `GOAL/TASK` correlation; god reacting is upstream-acceptable behavior (same as today's dispatch) |

---

## 8. Test plan (STEP 9 → files)

| # | Concern | File / locus |
|---|---|---|
| 1 | Goal persistence + restoration | `test/goal-store.test.cjs` |
| 2 | Schema validation / invalid stored data (quarantine) | `test/goal-store.test.cjs` |
| 3 | Atomic write (temp cleanup, old-file survival) | `test/goal-store.test.cjs` |
| 4 | Dispatch through real mailbox router | `test/ceo-service.test.cjs` (real HiveManager, temp home) |
| 5 | Message schema + correlation ids | `test/ceo-service.test.cjs` (assert inbox file JSON) |
| 6 | Agent selection + unavailable agent | `test/ceo-service.test.cjs` (+ existing `agent-selection` tests) |
| 7 | Dependency enforcement pre-dispatch | `test/ceo-service.test.cjs` |
| 8 | Duplicate-dispatch prevention | `test/ceo-service.test.cjs` (file count + attempts) |
| 9 | Ack/progress updates | `test/ceo-service.test.cjs` (feed `onRouted`) |
| 10 | Partial results + completion verification (acceptance gate) | `test/ceo-service.test.cjs` |
| 11 | Invalid/duplicated/delayed/unrelated responses | `test/ceo-service.test.cjs` |
| 12 | PTY startup failure + unexpected exit | `test/ceo-service.test.cjs` (fake spawn deps; labeled mocked) |
| 13 | Cancellation + bounded retries | `test/ceo-service.test.cjs` |
| 14 | Restart reconciliation, no blind redispatch | `test/ceo-service.test.cjs` (reload store from disk) |
| 15 | IPC validation + listener cleanup contract | `test/ceo-ipc-validation.test.cjs`, `test/ceo-panel-contract.test.cjs` |
| 16 | Regression (CEO/task-engine/hive/terminal) | full `npm run test:focused` vs baseline-B |

---

## 9. Acceptance plan (STEP 10) and known blockers

Planned demo: launch app → Command Center → CEO tab → submit small goal → watch goal persist → task card + inbox file → agent nudge/wake → reply → REVIEW → Accept → COMPLETED → restart → state restored, no duplicate dispatch.

**Known blocker (carried from Phase 1):** `node-pty` native module never compiled (no VS C++ Build Tools; `npm install` runs with `--ignore-scripts`). Without it the Electron main process cannot start terminals. STEP 10 will attempt: `npm rebuild node-pty` → `npm run dev`; if it fails, the exact command + error is recorded in the report and **no simulated demo is substituted**.

---

## 10. Out of scope (later phases)

CEO conversational planning by the god LLM (task graph authored deterministically in the panel this phase), auto-verification of acceptance criteria, PTY kill on cancel, memory/computer runtime (Phase 4+ per roadmap).

---

## 11. Execution deviations (recorded during implementation)

| Plan said | Executed instead | Why |
|---|---|---|
| §3: root-level store factory over `root()`/`commit()` | `GoalStore` constructor takes `HiveManager` (`new GoalStore(hive)`) | Tighter coupling to the hive lifecycle; store rides `hive.root()`/`hive.commit()` directly |
| Plan covered main-process types only | Record types extracted to `src/shared/goalRecord.ts`; `goalStore.ts` / `ceo.ts` re-export | Preload (`CthApi = typeof api`) and renderer (`ReturnType<typeof cth.ceoState>`) need one shared definition |
| Plan listed `CEOPanel.tsx` naming | Shipped as `CeoPanel.tsx` + `crown` icon in the existing icon library | Matches repo component naming (`TasksKanban`, `CommandCenterPanel`) |
| §9: node-pty likely blocks STEP 10 | Environment repaired (`npm rebuild node-pty`, Electron binary, `better-sqlite3` electron prebuild, missing `openai` package) — app launches and is verified | Repairs were node_modules-only; `package.json`/`package-lock.json` untouched (verified via `git status`) |
| Full interactive demo at STEP 10 | Automated verification: build exit 0 + 4 stable app launches (window "Vishwajeet Team"); click-through demo deferred to the review gate | GUI/agent-CLI interaction cannot be scripted honestly here; **no simulated demo substituted** |
