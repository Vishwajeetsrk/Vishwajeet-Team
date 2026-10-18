# Phase 8 Report — Durable Background Jobs (Orbit M3)

**Status: complete.** `npm run typecheck:node` 0 · `npm run typecheck:web` 0 new errors (pre-existing: `src/renderer/src/realtime/*.ts` only) · `npm run build` 0 · new M3 suites **22/22** (`job-ledger` + `job-runner`, gate tests inside) · focused lane **88/88** · full suite 1255 tests, 1219 pass, **22 fail — the exact pre-existing baseline set (same 8 environment-bound files)**. One pre-existing contract window widened (`emergency.test.cjs` dispatch slice 700 → 1300 chars: the STOP refusal now also records on the ledger before returning false; intent unchanged). Real-boot gate evidence via the labeled electron harness: **boot 1 GATE OK, boot 2 GATE OK (zero re-execution)**.

**M3 gate met:** kill the app mid-job → relaunch → the in-flight run is recorded `interrupted` and **never re-run** (no duplicate external effect); a failed run is visibly recorded; over-cap submits are recorded `refused`, not dispatched.

## What shipped

### 1. Shared contract — `src/shared/jobs.ts`
`JobRun` / `JobKind` (`recurring | one-time | event`) / `JobRunState` (`queued | running | succeeded | failed | interrupted | cancelled | refused`) + defaults (`DEFAULT_JOB_MAX_ATTEMPTS=3`, `EVENT_JOB_MAX_ATTEMPTS=1`, 30s timeout), backoff helper, `startOfLocalDay` for daily caps.

### 2. Ledger — `src/main/jobLedger.ts` over `src/main/jobStore.ts`
`JobRepo` interface + `MemoryJobRepo` (serialize/from — the test/restart seam; node tests never touch `db.ts` because better-sqlite3 is Electron-ABI). Write-ahead order enforced: `begin → markRunning → beforeExec(stamp) → exec`. `begin` checks the daily cap → `refused` row; `beginRefused` for policy refusals; `failAttempt` retries while attempts remain else `failed`; `cancel` queued-only; `recover()` maps `running → interrupted`, `queued → toResume`. All transitions guarded (stale settles can't overwrite newer state).

### 3. Runner — `src/main/jobRunner.ts`
Synchronous `submit` (the sync contract the webhook HTTP response needs), timeout race + stale-settle guards for async execs, backoff re-arm, `recordRefused`, `cancel`, once-guarded `recover(resolve)` (unresolvable payloads recorded `failed`, never silent), failure/interrupted native toasts, `shutdown()` ×3 teardowns.

### 4. Real SQLite — `src/main/db.ts` migration 4
`job_runs` + 3 indexes, `PersistStore` job methods, `SqliteJobRepo implements JobRepo`. Silent no-op guards when closed (`if (!this.db) return`) — see limitations.

### 5. Wiring — `src/main/index.ts`
`fire()` rewritten (submit + `beforeExec` lastFiredAt stamp + guarded exec); heartbeat beats stamp-before-dispatch; `dispatchWebhookWork` split into STOP-guarded wrapper (audit + `recordRefused` + `return false`) and byte-compatible `performWebhookWork`; 4 `jobs:*` IPC channels after `missions:save`; `maxRunsPerDay: m.dailyCap`; `ScheduledMission.dailyCap` in config. **Boot recovery sits ABOVE the hive gate** (index.ts:6140 < gate 6145 < `syncMissions` 6188): the ledger is desktop-local, webhook/one-time runs can exist with the hive disabled, and no hive filesystem work may starve the sweep. Contract-test pinned.

### 6. UI — `JobHistory.tsx` + Triggers 5th card + preload + locales
History panel (state chips, relative time, full errors, cancel-queued / retry-dead, local-only honesty footer), mounted as the 5th `TriggersTab` card, `jobs*` preload surface, en/ar/zh-CN keys (parity verified).

### 7. Real-boot gate harness — `test/jobs-electron.electron.cjs`
House `*.electron.cjs` pattern (`--plant` / `--boot`): plants running + unresolvable-queued + resolvable-queued rows on production SQLite, boots the real app. Boot 1: A→`interrupted` (+toast, never re-run), B→`failed` (`no executor for this run after restart`), C→resumed→`succeeded` attempt=1. Boot 2: every terminal state untouched (exactly-once holds across relaunches).

## Named deferrals (design §8 — gate allows deferrals, they must be NAMED)
| Gap | Deferral |
|---|---|
| Dollar-cost per-run caps | Needs the cost ledger + pricing surface → **M7 adopts** |
| One-time job creation form (UI) | Ledger + IPC ready; no form yet → **M7 or later** |
| Per-job concurrency cap | No primitive yet → **named, M11 or later** |
| Slack-origin runs on the ledger | Renderer flow untouched → **M8 integrations** |
| Per-mission `dailyCap` editing UI | Field wired, no editor → **M7** |

## Honest limitations (design §4/§7)
- True exactly-once across a crash is impossible; the shipped guarantee is **at-most-once automatic + visible interruption + operator-explicit retry** (documented, test-locked).
- All shipped execs are synchronous (async supported via promise + timeout race, unused by shipped kinds).
- `SqliteJobRepo` methods no-op when the store is closed — recovery is therefore ordered strictly after `persist.open()`.
- **This machine's real profile cannot complete a boot smoke** (pre-existing, unrelated to M3): `mkdirSync` under `OneDrive\Documents\Computer` hangs indefinitely at the node-FS level (1ms in %TEMP%, >40s hang on that path), so `bootstrapHiveServices()` blocks inside the untouched `ensureHive()` and missions never arm here. Recovery was verified instead via the isolated-profile electron harness above, where bootstrap completes.
