# PHASE-8 DESIGN — M3 Durable Background Jobs

**Gate:** kill the app mid-job → relaunch → exactly-once external effect; failed run visibly recorded; cap exceeded → job refuses.
**Roadmap scope:** per-run history, retry limits + backoff, timeouts, cancellation, cost/resource caps, boot recovery without duplicate external actions, failure notifications, one-time + recurring + event-triggered types on ONE ledger, desktop-local vs cloud labeled honestly.

## §1 — Why the current scheduler is not durable

`syncMissions()` (`src/main/index.ts:1009`) arms in-memory timers. A fire() does:
`hive.send(...)` → **stamp lastFiredAt** → writeConfig. Three defects:

1. **Duplicate on crash:** crash after `hive.send` but before the stamp → boot recomputes `remaining = 0` → the mission fires again → the external action (message to an agent) happens **twice**.
2. **Silent loss:** crash between timer expiry and fire() → no record anywhere that a run was attempted, failed, or skipped (`hive.enabled()===false` skips silently).
3. **No history/retry/timeout/cancel/caps** — nothing about a run is inspectable after the fact; a throwing fire is logged to console and forgotten.

## §2 — Architecture (4 new seams + wiring)

```
src/shared/jobs.ts        JobRun types, states, kinds, defaults (renderer+main contract)
src/main/jobStore.ts      JobRepo interface + MemoryJobRepo (serialize/from — restart tests,
                          same pattern as computerStore.ts; no electron/better-sqlite3 import)
src/main/jobLedger.ts     JobLedger: state machine + caps over JobRepo (pure, sync)
src/main/jobRunner.ts     JobRunner: exec dispatch, timeout race, backoff timers,
                          cancellation, boot recovery, failure notifications
src/main/db.ts            migration 4 (job_runs) + PersistStore job methods +
                          SqliteJobRepo implements JobRepo (production wiring)
src/main/index.ts         wiring: mission fire → runner, dispatchWebhookWork choke point,
                          boot recovery, IPC channels, renderer push
src/preload/index.ts      jobs:list / jobs:cancel / jobs:retry / jobs:submit + onJobsUpdated
renderer …/triggers/      JobHistory section (5th card in TriggersTab)
```

Layering rule (house pattern): `JobLedger`/`JobRunner`/`jobStore` are plain-TS (node-testable); only `db.ts` touches better-sqlite3/electron.

## §3 — Run record + state machine

```ts
type JobKind = 'recurring' | 'one-time' | 'event';
type JobRunState = 'queued' | 'running' | 'succeeded' | 'failed'
                 | 'interrupted' | 'cancelled' | 'refused';

interface JobRun {
  id: string;            // run_<mint>
  jobId: string;         // mission id / webhook endpoint id / 'manual:<uuid>'
  kind: JobKind;
  label: string;         // snapshot — survives mission rename/delete
  payload: string;       // JSON — enough to reconstruct exec after restart
  state: JobRunState;
  attempt: number;       // 0 until first dispatch begins; then 1..maxAttempts
  maxAttempts: number;   // per-run retry limit (default 3, event: 1)
  error: string | null;
  createdAt: number; startedAt: number | null;
  finishedAt: number | null; nextAt: number | null; // backoff target
}
```

Transitions (validated in JobLedger, all sync ⇒ check-then-update is atomic on the single thread):

```
queued ──markRunning──▶ running ──succeed──▶ succeeded
   │                       │────fail(attempt<max, backoff)──▶ queued(nextAt)
   │                       │────fail(attempt=max)───────────▶ failed
   │                       └────boot orphan────────────────▶ interrupted
   ├──cancel───────────────────────────────────────────────▶ cancelled
   └──cap exceeded at begin────────────────────────────────▶ refused
```

## §4 — Exactly-once semantics (the gate)

The external action is `exec()` (mission `hive.send` / webhook card creation). Ordering, write-ahead:

1. `begin()` — insert `queued` row (**cap checked here**).
2. `markRunning()` — durable `running` + `attempt++` **BEFORE exec**.
3. stamp `lastFiredAt` (recurring only) — durable **BEFORE exec** (inverts today's order; kills the duplicate-on-crash bug of §1.1).
4. `exec()`.
5. `succeed` / `fail` (guarded: only `running → *`).

Crash matrix (relaunch = `runner.recover()` at top of `bootstrapHiveServices()`, **before** `syncMissions()`; runner guards re-entry with a `recovered` flag because bootstrap can run twice):

| Crash between | Row at boot | Recovery action | External effect |
|---|---|---|---|
| before begin | no row | none — schedule catch-up fires when due | 0 (timer died) |
| begin → markRunning | queued, attempt 0 | **resume**: dispatch now | exactly 1 |
| markRunning → exec return | running | **interrupted** (no auto-rerun), failure notification | 0 or 1 — never 2 |
| exec return → succeed | running | **interrupted**, notification | 1 (shown as interrupted — operator may explicitly Retry, accepting the duplicate risk) |
| fail → backoff wait | queued, attempt>0 | **resume** backoff timer (elapsed ⇒ dispatch) | retries continue, ≤ maxAttempts |

Automatic path never duplicates; ambiguity is always *visible* (`interrupted`) and re-dispatch is *operator-only* (`jobs:retry` creates a fresh run — explicit, not silent). Manual retry is the honest two-generals answer: true exactly-once across a crash is impossible; at-most-once-with-visible-interruption + explicit retry is the guarantee we ship.

`syncMissions` lastFiredAt stamping moves into the runner's success path... **no** — see §4 step 3: stamp is pre-exec and stays (weekly spin-guard `rearm(justFired)` depends on the stamp landing with the fire). Stale-stamp risk: exec then fails ⇒ stamp says fired, run says failed — correct: the *attempt* consumed the slot, retries are the runner's business.

**Zombie honesty (§7 note):** an *async* exec that times out but later completes can still produce its effect — exactly-once cannot bind a zombie. All M3 execs are synchronous (the settle lands inside submit), so the zombie window does not exist in shipped code; the guard only prevents state corruption, not a theoretical duplicate from a future async executor.

## §5 — Caps (gate: "cap exceeded → job refuses")

- **`maxRunsPerDay`** (per job; 0/absent ⇒ unlimited): checked in `begin()`; over cap ⇒ insert `refused` row, exec never called, notification suppressed (refusal is normal operation, not failure).
- **`maxAttempts`** — retry limit per run (resource: no infinite retry loops).
- **`timeoutMs`** (per run, default 30 000) — exec raced against a timer; timeout ⇒ attempt fails with `timed out after Nms`. Late settlement of a timed-out/cancelled exec cannot corrupt the record (guarded transitions + runner ignores stale settles).
- **Cost (dollar) caps: NAMED DEFERRAL → M7.** A job's effect accrues cost on the *receiving agent's* cost ledger; attributing `$` to a run requires message→run→agent-turn correlation the monitoring pass (M7, "runs on jobs") owns. Resource caps (rate/attempts/time) ship now.

## §6 — One ledger, three kinds

| kind | submit path | retry | notes |
|---|---|---|---|
| `recurring` | mission timers (`fire()`, heartbeat `beat()`, compact) | yes (backoff) | payload = {to,subject,body,autoCompact,missionKind} |
| `one-time` | `jobs:submit` IPC + Retry button in JobHistory | yes | payload = {action:'dispatch', …}; unknown action ⇒ `failed: unknown action` |
| `event` | `dispatchWebhookWork` choke point (webhook HTTP + org release) | no (maxAttempts 1) | HTTP already consumed the exchange; Emergency-STOP refusal ⇒ `refused` row (visible in history) |

Every kind stores payload JSON sufficient to rebuild exec after restart (recovery resolver in index.ts maps payload → exec closure).

## §7 — Failure notifications + honesty labels

- Terminal `failed` and boot `interrupted` ⇒ native toast via the `breakerToast` pattern (gated on `readConfig().notifications`).
- JobHistory footer copy (all 3 locales): **runs are recorded locally in this machine's SQLite — no cloud sync, no offline continuity promises** (vision §5).
- `jobs:updated` push on every state change (same seam as `missions:updated`).

## §8 — Named deferrals (gate allows; must be NAMED)

| Deferred | Where named | Why |
|---|---|---|
| Dollar-cost per-run caps | this §5 + report | needs M7 message→cost correlation |
| One-time job creation form in UI | §6 | `jobs:submit` IPC + the Retry button cover the surface; a create-form is UI without a user need yet |
| Queueing/overlap control (concurrent run limit per job) | §5 | fires are synchronous local dispatches (sub-ms); a concurrency cap would guard a race the single-threaded main process cannot produce |
| Slack-origin runs as `event` kind | this row | Slack ingestion lands as `slack:incomingMessage` IPC — the RENDERER turns it into card+dispatch (index.ts:2011). Ledgering it means reworking that renderer flow through `jobs:submit`; webhook/org (the main-process dispatchers) ARE ledgered via the `dispatchWebhookWork` choke point. Sequence with M7's monitoring surface. |
| Per-mission `dailyCap` editing in the Schedules panel | §5 | enforcement + `maxRunsPerDay` are shipped, tested and wired (`m.dailyCap`); the number input in SchedulesSection is UI polish queued with the M7 job-monitoring pass. The field is optional — absent ⇒ unlimited, so no dead default is presented as a feature. |

## §9 — Test strategy (node --test, MemoryJobRepo — better-sqlite3 is Electron-ABI only)

1. **`test/job-ledger.test.cjs`** — state machine legal/illegal transitions; daily-cap refusal (cap=2: 2 begin ok, 3rd refused, exec never called); attempt accounting; guarded transitions (succeed on cancelled is a no-op); list/cancel/retry surfaces; recover classification (queued→resume set, running→interrupted, persisted).
2. **`test/job-runner.test.cjs`** — the GATE:
   - *kill mid-job:* exec hangs → "crash" (drop runner) → fresh runner.recover() → exec **not called again**, row `interrupted`, notify called once.
   - *crash before markRunning:* queued attempt-0 → recover → exec called exactly once.
   - normal path exactly-once; failure → backoff → retry → `failed` after maxAttempts with notify; timeout ⇒ attempt fails, late settle ignored; cancel queued ⇒ timer cleared, no exec; cap ⇒ refused, no exec; event kind maxAttempts=1.
   - fake clock (`now`/`setTimeout` injected) — no real sleeps.
3. **Wiring contract greps** (inside runner test, M2 style): index.ts has `jobs:list/cancel/retry/submit`, recovery call precedes `syncMissions()`, `dispatchWebhookWork` records runs, stamp-before-exec ordering present.
4. **Regression:** existing mission suites + full suite must hold the 22-failure pre-existing baseline.

## §10 — UI contract (JobHistory)

Fifth section card in `TriggersTab`: header + summary (like SchedulesSection), run rows (state chip, kind, label, `attempt/max`, relTime, error line), actions: Cancel (queued only), Retry (failed/interrupted/cancelled → `jobs:submit` with original payload), live refresh via `onJobsUpdated`, footer honesty label. No caps editing in v1 (deferred §8 — enforcement is programmatic + tested).
