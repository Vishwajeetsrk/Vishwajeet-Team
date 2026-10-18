# Phase 4 Report — Persistent Computer Runtime

**Status:** INCREMENT COMPLETE — STOPPED AT THE PHASE 4 REVIEW GATE
**Branch:** `feature/ai-company-os-foundation` (uncommitted working tree; commit only on request)
**Design source:** `docs/PHASE-4-DESIGN.md` (§1–§19)

---

## 1. Architecture and runtime choices

Phase 4 gives every agent a **persistent, registered computer identity** — a durable row, a real workspace directory, an isolated browser profile, and an associated terminal — managed by a state machine that never lies about what is running.

- **`ComputerManager`** (`src/main/computer.ts`) is the single authority: identity, status transitions, permissions, workspace authorization, terminal gating, lifecycle (start/stop/pause/resume/restart/watch/takeControl), `statusTick`, and startup `reconcile()`.
- **`ComputerRecord`** rows live in **real SQLite** (migration 2, `computers` table, `SqliteComputerRepo` in `src/main/db.ts`). `MemoryComputerRepo` (`src/main/computerStore.ts`) is the test double with `serialize()`/`static from()` for relaunch simulation.
- **State machine** (`src/shared/computer.ts`): 10 statuses (`OFFLINE, STARTING, READY, WORKING, WAITING, PAUSED, USER_CONTROL, STOPPING, SLEEPING, ERROR`) with a complete `COMPUTER_TRANSITIONS` table; out-of-table moves are rejected `INVALID_STATE`, never forced.
- **Browser** is behind an injected `BrowserRuntime`; the real implementation is `ComputerBrowser` (`src/main/computerBrowser.ts`) wrapping hidden Electron `BrowserWindow`s. **Playwright is deferred**, not faked; under plain node `createComputerBrowser()` returns `null` and `index.ts` installs an `unsupportedBrowserRuntime` stub that fails honestly (`{ok:false, unsupported:true}`).
- **Terminals are never spawned by `start`.** The computer *associates* with ptys the agent flow already spawned (`ptyForAgent`/`info`/`idleFor` adapter mirroring `index.ts`'s `ptyToAgent` map).
- **Isolation is directory separation, not an OS sandbox** (stated explicitly; see §3).

## 2. Identity and persistence

- `id` = `cmp-<rand>`, minted once, stable for life; `create({agentId})` is idempotent (same agent → same id).
- SQLite migration 2:

```sql
CREATE TABLE IF NOT EXISTS computers (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT,
  status TEXT NOT NULL, runtime_type TEXT NOT NULL DEFAULT 'local',
  workspace_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
  browser_profile_id TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, last_started_at INTEGER,
  persistence_policy TEXT NOT NULL DEFAULT 'retain',
  resource_limits TEXT NOT NULL DEFAULT '{}',
  permissions TEXT NOT NULL DEFAULT '{}',
  config TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_computers_agent ON computers(agent_id);
```

- `computersRoot` is a **lazy getter** (`() => join(readConfig().harnessHome || cwd, 'computers')`) so a config change after module load is honored.
- Persisted fields carry last-known status; live status is in-memory and reconciled at startup (§7).

## 3. Isolation guarantees — and limits (honest)

**Guaranteed and machine-verified:**
- One workspace directory per computer; workspace authorization resolves paths under the root only — traversal (`../`) is refused even with grants (acceptance step 6).
- One Electron session partition per computer: `persist:computer-<id>`; two computers never share storage or session objects (electron phase 1: distinct `getStoragePath()`, distinct `session` objects).
- Cross-agent workspace access is **default-deny** with a truthful `permission-denied` audit event; opens only via explicit `crossAgentRead`/`crossAgentWrite` grants.
- No shared mutable state between computers in the manager; stopping one does not touch another (acceptance step 7).

**Limits (not faked):**
- This is **directory + profile isolation, not OS sandboxing** — no container, no per-computer uid, no syscall mediation. `runtimeType` is `'local'` only; container runtime is reserved, never faked.
- `network` and `externalActions` permissions are stored, validated, and surfaced in the UI, but have **no enforcement point yet** (network would be enforced by session `webRequest`; external actions by tool call sites — Phase 5).

## 4. Browser profiles

- `browserProfileId = persist:computer-<id>` is computed once and shared between `webPreferences.partition` and persisted state (`computerBrowser.ts`).
- Real windows are hidden (`show:false`), lazily opened (never by `start`), capped by `maxBrowserWindows: 1`.
- **`browserDownloads` default-deny on the real session**: `will-download` is prevented until the cap is granted (electron phase 1 flips the gate and observes both outcomes).
- **Hidden capture works**: `capturePage` on a hidden window returned a **7215-byte PNG** (magic `0x89504E47`, window still hidden afterwards). This answered the open design question — no visible window needed.
- **Dispose**: `policy=dispose` deletes the profile immediately when file locks allow; when Chromium still holds locks (the observed case), the wipe is **recorded in `computer-wipes.json`** and flushed by the next launch (phase 1 asserts the registry entry, phase 2 asserts the directory is gone and the registry cleared). Never silent, never dropped. `policy=retain` keeps the profile (asserted).

## 5. Terminal lifecycle

- `start` never spawns terminals (asserted: `start` → `ptyManager.list().length === 0`).
- Association reports real pty truthfully: `pid`, `cwd`, `running`, `lastOutputAt` match the OS process; a killed pty reports `running:false`.
- **`pty:write` gate** wired in `index.ts`: `checkTerminalAccess(gatedAgent)` runs on every `pty:write` IPC; returns `INVALID_STATE` when PAUSED, `PERMISSION_DENIED` when `agent.terminalExec:false` (audit event emitted), allows when authorized. Documented compatibility rule: an **OFFLINE** computer still allows input (restored hive flows send to a live pty before anyone starts the computer).
- `statusTick` (armed every 5 s in `armAlwaysOnBeats`) reads the real pty idle clock: recent output ⇒ `WORKING`; no task + no output ⇒ `WAITING`; agent has an assigned/running task (via `ceo.snapshot()` goal scan) ⇒ `WORKING`.

## 6. Screen inspection and control

- `captureScreen` returns real PNG bytes (§4) or a typed failure; payload capped by `screenshotMaxBytes` (default 4 MiB).
- `watch`/`takeControl`/`releaseControl` move through `USER_CONTROL`, which **pins `USER_ACTOR`** — these handlers plus permission changes and dispose are user-only; an agent (including the CEO) cannot invoke them (contract test asserts the pin).
- Full desktop *streaming* is not implemented; the supported inspection method (capture-to-PNG + xterm terminal view) is what the UI exposes. Recorded as a limitation, not faked.

## 7. Permission model

Default-deny for everything sensitive (`DEFAULT_COMPUTER_PERMISSIONS`):

| Capability | Default | Enforced at |
|---|---|---|
| `agent.terminalExec` | **true** (owner's own terminal = product core) | `checkTerminalAccess` on every `pty:write` |
| `agent.browserNav` | false | `navigate` handler (validated + gated) |
| `agent.browserDownloads` | false | real session `will-download` (electron-proven) |
| `agent.network` | false | **stored/validated only — no enforcement point yet** |
| `agent.crossAgentRead/Write` | `[]` | workspace authorization (electron/node-proven) |
| `agent.externalActions` | false | **stored/validated only — no enforcement point yet** |
| `user.screenView` / `user.screenControl` | true | user-actor handlers (UI-only path) |

Permission **changes are user-only** (`configure` pinned to `USER_ACTOR` in `index.ts`); the CEO cannot grant itself permissions because agent influence reaches main only via hive/hooks, which cannot call computer IPC. Every denial emits an audit event through the `log` dep (hive `appendLog`).

## 8. Recovery

- **`reconcile()` at startup (module load in `index.ts`)**: loads all rows, creates missing workspaces, and converts stale running statuses to `OFFLINE` with a `recovered-offline` event. It **never spawns** — no pty, no window, no task replay (asserted in acceptance step 11 and electron phase 2: `spawnedAny === 0`).
- **Lifecycle cleanup:** `computers.shutdownAll()` runs in `teardownAndQuit` (`[quit]`) and the reset block (`[reset]`).
- **Live pushes:** hive `appendLog` stamps `ts`; `liveWebContents()` pushes `computer:event` with its own `ts`; `computer:updated` pushes status snapshots. Renderer subscribes via preload `onComputerEvent`/`onComputerUpdated`.

## 9. UI

- New **Command Center tab `computer`** (`ComputerPanel.tsx`, ~460 lines): state chip (10 statuses), workspace card with copyable path, terminal card (real `PtyManager` facts), browser card (open/closed, URL + navigate, open browser, real base64 PNG screenshot), 5 permission toggles, lifecycle controls derived from `COMPUTER_TRANSITIONS` (no dead buttons), watch/take-control, **two-step dispose confirm** (explicit `confirm:true`), push-fed event ring, load-error + retry, no-computer → Create.
- Honest display only: real data URLs, no `/progress/` fakes, errors surfaced with `[code]`.
- i18n ×3 (`en`, `ar`, `zh-CN`): `commandCenter.tabs.computer` + full `computerTab` block (60+ keys incl. 10 state labels); key sets identical across locales; `{{policy}}` interpolation preserved in all three.

## 10. Files changed (Phase 4)

**New:**
- `src/shared/computer.ts` — shared types, `COMPUTER_TRANSITIONS`, `ComputerOp`, default permissions
- `src/main/computer.ts` — `ComputerManager` (state machine, gating, reconcile)
- `src/main/computerStore.ts` — `ComputerRepo` interface + `MemoryComputerRepo`
- `src/main/computerBrowser.ts` — `ComputerBrowser` (hidden windows, partitions, capture, wipes)
- `src/main/computerIpcValidation.ts` — per-channel validators (24 channels)
- `src/renderer/src/components/ComputerPanel.tsx`
- `test/computer-{manager,persistence,ipc-validation,workspace,terminal,browser,permissions,panel-contract}.test.cjs`
- `test/computer-electron.electron.cjs` — labeled OS-process harness (windows + **real SQLite restart contract**)
- `test/computer-acceptance-demo.cjs` — labeled two-agent acceptance walk
- `docs/PHASE-4-DESIGN.md`, `docs/PHASE-4-REPORT.md` (this file)

**Modified:**
- `src/main/db.ts` — migration 2 + `SqliteComputerRepo`
- `src/main/index.ts` — construction + reconcile, 24 `computer:*` IPC handlers, `pty:write` gate, 5 s `statusTick`, quit/reset shutdown
- `src/preload/index.ts` — 24 typed methods + `onComputerUpdated`/`onComputerEvent` + type exports
- `src/renderer/src/components/CommandCenterPanel.tsx` — `computer` tab registration
- `src/renderer/src/i18n/locales/{en,ar,zh-CN}.json` — tab + `computerTab` block

## 11. Test commands and exact results

| Command | Result |
|---|---|
| `npm run test:focused` (`node --test test/*.test.cjs`) | **1124 tests, 1088 pass, 22 fail, 0 cancelled, 14 skipped** (~106 s) |
| ↳ Phase 3 baseline | 1040 / 1004 / 22 / 14 → **+84 new tests, all passing, zero regressions** |
| ↳ same 22 upstream failures | agent-token-cap (1), arabic-terminal (1), fs-path-containment (10), hire-import (1), hooks-socket (1), release-notes (1), telemetry-message-count (2), worktree-deps (5) — pre-existing, untouched |
| 8 computer test files only | **84/84 pass**, exit 0 (7.9 s) |
| `npm run typecheck:node` | **0 errors** |
| `npm run typecheck:web` | **33 errors — all pre-existing** in `src/renderer/src/realtime/*`; ComputerPanel adds zero |
| `npm run build` | **exit 0** |
| `npx electron test/computer-electron.electron.cjs` | **exit 0** — 9 assertions: hidden window, partition isolation, download gate, 7215 B PNG, independent sessions, navigation, deferred wipe + registry, retain dispose, **real SQLite: 2 computers → READY, rows+file written, db closed** |
| `npx electron test/computer-electron.electron.cjs --phase2` | **exit 0** — next-launch wipe recovery, retain untouched, **restart contract: same ids, file byte-identical, recoveredOffline=2, no replay** |
| `node test/computer-acceptance-demo.cjs` | **exit 0 — 11 scripted PASS, 2 honest LIMITATION lines** |

## 12. Acceptance results (two-agent demo, design §19)

`node test/computer-acceptance-demo.cjs` — real `ComputerManager` + real `PtyManager` (node-pty NAPI under plain node):

1. **PASS** — two identities created: distinct, stable, idempotent (`cmp-*`).
2. **PASS** — both `READY`; workspaces exist and differ; files written into each.
3. **PASS** — distinct `persist:computer-<id>` profile ids. **LIMITATION:** real windows/partitions on disk are proven by the electron harness (phases 1+2), not this node script.
4. **PASS** — real pty per agent (distinct OS pids), output observed (`lastOutputAt` bumped); gate allows authorized input, denies `PAUSED` (`INVALID_STATE`) and `terminalExec:false` (`PERMISSION_DENIED` + audit event), re-allows after grant.
5. **LIMITATION (honest)** — UI click-through is the review-gate manual step (`npm run dev` → agent select → Command Center → `computer` tab). Machine-verified substitutes: 7215 B PNG capture (electron) + 11/11 panel contract.
6. **PASS** — alpha denied on beta's workspace (event logged) → explicit `crossAgentRead` grant opens it → traversal `../` still refused.
7. **PASS** — alpha `OFFLINE` while beta stays `READY` with its live pty untouched.
8. **PASS** — ids identical across relaunch (serialized rows → new repo → new manager).
9. **PASS** — workspace files byte-identical after relaunch.
10. **PASS** — `reconcile()`: 2 loaded, 1 recovered-offline (crash-while-READY row), `recovered-offline` event emitted, zero replay.
11. **PASS** — reconcile created no ptys, no windows, no task replay.
12. **PASS** — duplicate pty refused by the runtime backstop; duplicate start returns `alreadyRunning`; agents without a computer unaffected.

**Electron companion evidence** (steps 3, 5, and the *real* app relaunch): phases 1+2 above, both exit 0 — real `BrowserWindow`s, isolated partitions, real `will-download`, hidden capture PNG, deferred wipe recovery, **real SQLite rows + workspace files surviving a process restart**.

## 13. Known bugs / platform limitations (no fakes)

1. **ConPTY stderr noise**: node-pty's `conpty_console_list_agent` prints `Error: AttachConsole failed` to stderr when `killAll()` runs — cosmetic, non-fatal, no orphan processes (observed in both terminal tests and the acceptance demo; `2>$null` hides it but the report states it).
2. **Chromium locks partition files after `close()`** → wipe is deferred to a registry flushed at next launch (asserted both directions, never silent).
3. **Directory-level isolation only** — no OS sandbox/container (§3).
4. **`network` / `externalActions` stored + validated but not yet enforced** (§3, §7).
5. **No desktop streaming** — supported inspection is PNG capture + in-panel xterm (§6).
6. **`SqliteComputerRepo` under plain node is untestable** (better-sqlite3 is Electron-ABI) — real-SQLite coverage runs only in the labeled Electron harness; node tests use `MemoryComputerRepo`.
7. **`electron-rebuild` blocked in this environment** (no VS Build Tools) — all native-module evidence is via `npx electron <script>`.
8. **UI click-through not machine-captured** — left as the review-gate manual step (acceptance limitation line).

## 14. Phase 5 remaining work (from this phase's edges)

- Enforce `network` (session `webRequest` rules) and `externalActions` (tool-call gate).
- Container/remote `runtimeType` behind the same interface (reserved, currently `'local'` only).
- Playwright-backed automation once the environment allows installing it (interface already injected).
- Computer-attached agents end-to-end in the hive flow (assign → WORKING decay, `hasActiveTask` already wired to the goal graph).
- Screen streaming (beyond single-frame capture) if the product needs it.

---

*Phase 4 stops here. Phase 5 begins only after explicit approval.*
