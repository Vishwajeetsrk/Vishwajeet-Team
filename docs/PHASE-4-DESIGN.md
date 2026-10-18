# PHASE-4-DESIGN — Persistent Computer Runtime for Munder Difflin / AI Company OS

**Date:** 2026-10-09
**Branch:** `feature/ai-company-os-foundation`
**Status:** DESIGN — implementation follows this document; deviations recorded in `docs/PHASE-4-REPORT.md`

---

## 1. Current implementation (verified, with file:line evidence)

### 1.1 Identity and registry

- Hive agents: `<hiveRoot>/registry.json` written by `HiveManager.ensureAgent` (`src/main/hive.ts:794-1217`), holds `id`, absolute `cwd`, `provider`, `sessionId`, `archived`, `status`. UI mirror: `<harnessHome>/roster.json` (`src/main/roster.ts:54-56`), renderer-authoritative writes with main-process atomicity/backups.
- **There is no "computer" entity today.** `docs/AI-COMPANY-OS-GAP-ANALYSIS.md:59` confirms: computer persistence is "PARTIAL — No explicit 'computer' state that survives restart".

### 1.2 Persistence

- `PersistStore` (SQLite, better-sqlite3) at `<userData>/harness.db` — `src/main/db.ts:79`, opened before the first window (`src/main/index.ts:5511`). WAL, `PRAGMA user_version` migrations, append-only `MIGRATIONS` array (`db.ts:12-13, 91-102`): "NEVER edit a shipped migration — only append". Current schema: `kv`, `command_history` (migration 0 → version 1). The header (`db.ts:36-47`) explicitly reserves the DB for future entity registries.
- JSON stores (main-owned, temp+rename): `config.json`, `goals.json` (version + quarantine), hive `tasks.json`/`registry.json`.
- **Upstream `postinstall` = `electron-rebuild -f`** (`package.json`): better-sqlite3 is built for the **Electron** ABI by design; zero upstream tests load it under plain node. Our machine lacks VS C++ tools, so we keep the Electron prebuild (app works) and follow the same rule: node-side unit tests never import `db.ts`.

### 1.3 Terminal lifecycle

- `PtyManager` (`src/main/pty.ts`): `spawn` with a hard duplicate guard per id (`pty.ts:553` — `already exists`), owner-routed output (`pty:data:<id>`/`pty:exit:<id>`), `setExitHandler` chain (`index.ts:636-683`: hive crash record → CEO exit hook → teardown), `kill` + explicit `teardownPty` (`index.ts:484-544`).
- Agent mapping: in-memory `ptyToAgent` (`index.ts:232`), reverse lookup `ptyForAgent` (`index.ts:1158`). pty id convention `pty-<agentId>` is a **renderer convention, not a main-side invariant**; no main-side "one live PTY per agent" rule exists.
- cwd: `expandTilde` → optional git worktree when `isolate:true` (`index.ts:2781-2810`) → `existsSync` check in `PtyManager.spawn`.
- **`pty:write` has NO permission check** (`index.ts:3086`) — any renderer input reaches any pty id. Output is owner-routed; input is not owner-checked. This is the gap §8 of this design closes for computer-registered agents.
- PTYs do not survive restart (killed on quit, `pty.ts:811-824`); agents are restored by renderer `restoreTeam` with the same ids (`useRestoreTeam.ts:112-151`).

### 1.4 Browser / screen

- **No browser automation exists**: no playwright/puppeteer (direct or transitive), no per-agent profile, no `capturePage`/`desktopCapturer`, no screenshot IPC (`docs/AI-COMPANY-OS-GAP-ANALYSIS.md:54-57,150`). Electron 32.3.3 (Chromium 128) renders the app itself only.
- Image handling exists for **displaying** agent-authored PNGs (`fs:readBinary`, `useWorkspaceImage`) — nothing captures.
- `ControlRegistry` (`src/main/control.ts:43`) has **real hook-level enforcement** (halt/tool-deny/steer consulted by `HookServer`, `hooks.ts:424,507,527`) but does not gate PTY keystrokes.

### 1.5 Events and redaction

- Durable feed: `hive.appendLog({kind, ...})` → `<hiveRoot>/log.jsonl` (`hive.ts:2750`) — consumed by the Activity tab poll (`CommandCenterPanel.tsx:1255`), memory graph, and floor-quiet mtime detection. Existing kinds: `spawn`, `session`, `agent-exit`, `tasks`, `goals-corrupt`, …
- Live push: injected `emit(channel, payload)` → `liveWebContents()?.send()` (HiveManager/CeoService/Telemetry pattern).
- `redactSecrets()` (`hive.ts:275`) — main-side scrub of keys/JWTs/Bearer tokens, applied to every message body today.
- IDs: `` `${stamp()}-${shortRand()}` `` (`hive.ts:213-219`).

### 1.6 Path containment

- **One path-escape policy in the app**: `safeResolve(root, rel)` (`fs.ts:100`) — lexical check + `realpath` canonicalization (deepest-existing-ancestor for create) + symlink-component walk, fail-closed. Exported precisely so other main modules reuse it ("there is exactly one path-escape policy", `fs.ts:86-88`).
- Existing `fs:*` IPC (`index.ts:3379-3424`) takes `(root, rel)` with the **renderer supplying the root** — containment relative to a root, but no authorization of which root. Phase 4 adds main-side authorization of computer workspace roots (§5) without rewriting the IDE's existing fs handlers.

### 1.7 Renderer / Command Center

- Tabs: `CCTab` union + `TABS` + body block in `CommandCenterPanel.tsx`; `useStore(s => s.selectedId)` + `selectedAgent(s)` (`store.ts:1038`) give the selected agent. Phase 3 established the panel pattern (CeoPanel: state + 4s poll + push unsubscribe + honest empty/offline/error states).

---

## 2. Confirmed gaps (vs Phase 4 mission)

| # | Gap | Evidence |
|---|---|---|
| 1 | No computer entity, identity, or persistence | gap analysis :59; no `computer` in code |
| 2 | No per-agent workspace root distinct from agent `cwd` | cwd = user-picked dir or worktree only |
| 3 | No browser profile / lifecycle / automation | gap analysis :54, :150 |
| 4 | No screen inspection pathway (browser or desktop) | gap analysis :56; zero capture APIs |
| 5 | No computer state machine / lifecycle controls | nothing to run them on |
| 6 | No permission model enforced in main for terminal/browser/screen | `pty:write` ungated (`index.ts:3086`) |
| 7 | No computer events in the activity feed | log.jsonl kinds list has no computer events |
| 8 | No cross-agent access authorization for file operations | `fs:*` roots are renderer-supplied |

---

## 3. Technology choices

### 3.1 Browser runtime — **Electron-native `BrowserWindow` with `persist:` partitions** (chosen), Playwright evaluated and deferred

| Option | Pros | Cons |
|---|---|---|
| **Electron `BrowserWindow` + `partition: 'persist:computer-<id>'`** | Zero new dependencies; bundled Chromium 128; real on-disk profile per partition under `<userData>/Partitions/`; `webContents.capturePage()` for screenshots; `getURL()/getTitle()` for state; `loadURL` navigation; shows a REAL window for watch/control (no input synthesis needed — the user drives the actual OS window); same lifecycle/event loop as the app | Automation depth limited to navigation + `executeJavaScript` + CDP via `webContents.debugger` (later); screenshot of hidden windows must be proven on Windows (tested in Increment D) |
| Playwright (`launchPersistentContext(userDataDir)`) | Rich automation API | New ~100 MB dependency + separate browser download on a machine where `--ignore-scripts` installs already broke natives; second browser runtime beside Electron (patching, updates, sandbox quirks); not present anywhere in the repo (verified) |

**Decision:** Electron-native adapter behind an injected `BrowserAdapter` interface. If a future phase needs deep automation (menus, multi-tab orchestration), Playwright can be evaluated again **with the adapter already in place** — the interface is the seam.

### 3.2 Isolation strategy — **honest layering, no overclaim**

1. **Directory separation (implemented):** each computer gets its own workspace root and browser profile; app-mediated file ops are authorized in main (`safeResolve` + permission checks).
2. **App-layer authorization (implemented):** every computer operation passes a default-deny permission check in the trusted main process; the renderer never decides.
3. **Process isolation (NOT claimed):** an agent's terminal process is a normal OS process with its own cwd. Directories do **not** stop a determined process from reading the host filesystem. Documented as organizational separation.
4. **Container/VM sandbox (evaluated, deferred):** would require Docker (Docker Desktop is present on this machine) or Windows job-object/silo sandboxing; conflicts with the current node-pty → CLI-on-host architecture (agent CLIs must share the app's git config, PATH, provider credentials), and per §6 of the prompt must be compatibility-tested before selection. **Phase 4 ships boundaries 1-3 and records 4 as Phase 5+ work with a test-first requirement.** The success criterion ("not exposing one agent's private resources to another") is met at the app layer, with the process-level limitation stated in the report.

### 3.3 Storage — **SQLite (`PersistStore`), migration 2**

`computers` is app-global, main-owned, queryable entity state — exactly the lane `db.ts:36-39` reserves. No new JSON database (the prompt forbids competing stores). Persistent config (identity, workspace, permissions, limits) lives in the table; **ephemeral runtime state (live status, pids, window handles) lives in memory**; the persisted `status` column is a *last-known* value used only to detect stale state at boot.

---

## 4. Computer runtime contract

### 4.1 Identity (persisted row)

```ts
interface ComputerRecord {
  id: string;                 // 'cmp-<shortRand>' stable for life
  agentId: string;            // owning hive agent
  projectId: string | null;   // optional project binding
  status: ComputerStatus;     // last-known (reconciled at boot)
  runtimeType: 'local';       // reserved: 'container' later — never faked
  workspaceId: string;        // 'ws-<id>'
  workspaceRoot: string;      // absolute; <harnessHome>/computers/<id>/workspace
  browserProfileId: string | null; // 'persist:computer-<id>' (Electron partition)
  createdAt: number; updatedAt: number; lastStartedAt: number | null;
  persistencePolicy: 'retain' | 'dispose';   // dispose wipes on delete
  resourceLimits: ComputerResourceLimits;
  permissions: ComputerPermissions;
  config: ComputerConfig;     // e.g. homeUrl, openBrowserOnStart:false
}
```

- One computer per agent by default via `ensureForAgent(agentId)` (idempotent — returns the existing record; duplicate-create test).
- `id` is minted once and never regenerated; recreating a runtime (`stop`→`start`, even after crash) reuses the same id, workspace and profile. `dispose` is the only destructive op (§6.5).

### 4.2 Operations (adapted contract)

`create · get · list · start · stop · pause · resume · restart · getStatus · getWorkspaceInfo · openBrowser · getBrowserStatus · captureScreen · getTerminalInfo · dispose` **plus three documented adaptations:** `watch {on}` (truthful "user is watching" indicator), `takeControl` / `releaseControl` (reach `USER_CONTROL`; control = gate agent automation + raise the real browser window — never synthesized input).

Every op returns `{ok:true, ...} | {ok:false, error, code}` where `code ∈ {NOT_FOUND, INVALID_STATE, PERMISSION_DENIED, UNSUPPORTED, TIMEOUT, INTERNAL}`. Operations not provided by the current backend (e.g. container runtime, full-desktop capture) return `UNSUPPORTED` — never success.

### 4.3 Dependency injection

```ts
new ComputerManager({
  repo,            // ComputerRepo — SQLite impl in db.ts; Memory impl in tests
  pty,             // PtyAdapter — real PtyManager-backed in app; fake in tests
  browser,         // BrowserAdapter — Electron BrowserWindow impl; fake in tests
  control?,        // ControlRegistry passthrough (tool gating)
  emit, log,       // computer:updated push + hive appendLog
  now?, mint?,     // deterministic time/ids for tests
  hasActiveTask?,  // (agentId) => boolean  — WORKING/WAITING derivation from real task state
})
```

`electron` is imported only by the wiring module (`index.ts` / `computerBrowser.ts` constructed there), so all unit tests run under plain node.

---

## 5. Filesystem and workspace isolation

- Root: `<harnessHome>/computers/<computerId>/workspace` (private) + `<harnessHome>/computers/<computerId>/screenshots/` + `browserProfile` under `<userData>/Partitions/persist:computer-<id>/`.
- Shared area: `<harnessHome>/computers/shared/` — declared, permission-checked (`sharedRead`/`sharedWrite`), used by nothing in Phase 4 beyond existence + tests (no fake features).
- **All computer file operations** resolve through `safeResolve(workspaceRoot, rel)` (`fs.ts:100` — canonicalization + symlink boundary, fail-closed) **after** an authorization check: actor must be the owning agent (own workspace) or hold an explicit `crossAgentRead`/`crossAgentWrite` grant on that computer. Violations return `PERMISSION_DENIED` and emit a `permission-denied` event.
- Renderer never receives arbitrary host-fs capabilities from the computer API — computer ops take `(computerId, rel)` only; roots are resolved main-side from the registry.
- Significant file ops (create/write/dispose of workspace roots, screenshot writes) are recorded via `appendLog({kind:'computer', event:'workspace-init'…})`.
- Existing `fs:*` IDE handlers remain unchanged (user-authority browsing); the report documents that they are renderer-rooted and out of Phase 4's authorization scope.

---

## 6. Persistence, restart and recovery

1. **Boot:** `PersistStore.open()` (existing) runs migration 2 → `ComputerManager.loadAll()` → rows into memory.
2. **`reconcile()`** (called from `bootstrapHiveServices`, beside `ceo.reconcile()`):
   - verify `workspaceRoot` exists → if missing: re-create the empty directory + emit `workspace-recovered` (mkdir only — never deletes);
   - verify profile dir expectations (absence is normal pre-first-launch; recorded only when a profile existed and vanished);
   - any persisted status ≠ OFFLINE/PAUSED → set OFFLINE, emit `recovered-offline` (stale sessions marked accurately; app restart killed all windows and PTYs);
   - **never** re-dispatches tasks, re-opens browsers, or re-spawns terminals (no blind replay);
   - live truth thereafter derived from `ptyForAgent()` + adapter liveness on each `getStatus`.
3. **Config vs ephemeral:** row = config; memory map = `{status, since, lastError, windowHandle, watching, control}`.
4. **Deletion:** `dispose({confirm:true})` — with `persistencePolicy:'retain'` (default) the row is removed but workspace/profile files stay on disk (recorded as retained); with `'dispose'` the workspace and profile directories are removed. Destructive cleanup requires the explicit `confirm` flag (IPC + UI confirmation) and emits a `computer-disposed` audit event. Nothing else ever deletes persistent files ("Do not silently delete persistent workspaces").

---

## 7. Browser profiles (Electron-native)

- `openBrowser({id, url?})` → `BrowserWindow({ show:false, webPreferences:{ partition, contextIsolation:true, nodeIntegration:false, sandbox:true } })`, one window per computer (duplicate → `already open`, not an error). `show:false` by default; `watch`/`takeControl` → `show:true` + `focus` (the real window — genuine inspection/control, no synthetic input).
- Navigation: allow-listed by `permissions.agent.browserNav`; failure (`did-fail-load`) → structured error + `browser-error` event; `render-process-gone` → `ERROR` state + recovery on next `openBrowser`.
- Status: `{open, url, title, loading}` — URLs passed to events/logs run through `redactSecrets` (tokens in query strings).
- Screenshots: `webContents.capturePage()` → PNG buffer → `<computerDir>/screenshots/<ts>.png` + return capped base64 (`screenshotMaxBytes` from limits, default 4 MB). Capture requires `permissions.user.screenView`.
- Cookies/session/downloads: live only inside the partition; downloads directory redirected into the computer's `downloads/` dir (`session.on('will-download')`); no personal-browser import ever; secrets never logged (metadata only, redacted).

---

## 8. Terminal and process lifecycle

- `getTerminalInfo(id)` → live truth from `ptyForAgent(agentId)`: `{ptyId, pid?, running, cwd, lastOutputAt}` or `{running:false}`. A terminal being open ≠ WORKING (§9).
- **Duplicate prevention:** the computer never spawns a second terminal for an agent — association only (the hive/CEO/renderer restore paths own spawning; `PtyManager`'s id guard remains the hard backstop). `start` does not spawn terminals.
- **`pty:write` gate (new, main-side):** resolve pty → agent → computer; if found, deny when `terminalExec` is false or the computer is `PAUSED`/`STOPPING`, returning `{ok:false, code:'PERMISSION_DENIED'|'INVALID_STATE'}` + `permission-denied` event. Agents without computers keep today's behavior (backward compatible).
- Stop/pause never kill the agent's PTY (breaker/`pty:kill` own process lifecycle, same rule as Phase 3 cancellation). Graceful stop = close browser + release control + state transition; bounded stop timeout → `TIMEOUT` + `ERROR`.
- Unexpected PTY exit already flows through `setExitHandler` → the computer's `WORKING` derivation simply goes false; we additionally emit `terminal-exit` from `getTerminalInfo` transitions? No — events must be truthful and non-duplicative: the hive already logs `agent-exit`; the computer feed records computer-level events only.

---

## 9. State machine

```
OFFLINE ──start──▶ STARTING ──ok──▶ READY ⇄ WORKING   (WORKING ⇄ WAITING by real signals)
  ▲                  │timeout/fail                     │
  │                  ▼                                 ├──pause──▶ PAUSED ──resume──▶ READY
  stop◀── STOPPING ◀─┴── any fatal ──▶ ERROR ──start──▶ STARTING
  │                                         
  └── (pause/resume, takeControl/releaseControl only from READY/WORKING/WAITING)
WORKING/WAITING ──idlePolicy(≥ sleepAfterIdleMs, default off)──▶ SLEEPING ──start/resume──▶ STARTING
any ──takeControl──▶ USER_CONTROL ──releaseControl──▶ previous
```

- **Derived, not faked:** `WORKING` = `hasActiveTask(agentId)` OR terminal output within `WORKING_OUTPUT_MS` (10 s); `WAITING` = READY with neither signal; recomputed on events + a 5 s tick only while running. Terminal open with no output ⇒ WAITING ("a terminal being open does not mean an agent is working").
- Invalid transitions are rejected with `INVALID_STATE` + reason (table-tested).
- **`PAUSED` semantics (honest):** agent tool use gated (via `ControlRegistry.pause`), computer ops refused, terminal input gated at `pty:write`. The underlying CLI process is **not suspended** — documented, no overclaim.
- **`USER_CONTROL`:** additionally raises the browser window, tells the renderer to halt automation (event consumed by the panel), and keeps user typing available; `releaseControl` restores gating state. Watch/indicator events emitted both ways.
- Bounded retries: `start` retry cap 3 with backoff for transient failures; timeouts per op from `resourceLimits.startTimeoutMs`.

---

## 10. Permission model (default-deny)

```ts
interface ComputerPermissions {
  agent: {                     // the OWNING agent — checked in main, not UI
    terminalExec: boolean;     // default true  (own terminal; product is unusable otherwise)
    browserNav: boolean;       // default false (default-deny)
    browserDownloads: boolean; // default false
    network: boolean;          // default false — gate for future connector use
    crossAgentRead: string[];  // default []    (other agent ids allowed into THIS workspace)
    crossAgentWrite: string[]; // default []
    externalActions: boolean;  // default false (connectors)
  };
  user: {                      // local operator (renderer is the trusted UI process)
    screenView: boolean;       // default true
    screenControl: boolean;    // default true
  };
}
```

- Sensitive capabilities are default-deny; owner-allow applies only to `terminalExec` (documented deviation from blanket default-deny with rationale — the prompt allows adaptation when explained).
- Checks live in `ComputerManager.check(perm, actor)` — one choke point used by every op (terminal gate, browser ops, capture, workspace access). UI hiding is never the enforcement.
- **The CEO cannot grant itself permissions:** permission changes arrive only via the `computer:permissions` IPC (renderer = local user) and are validated as user operations; no hive message, hook payload, or agent-authored file can reach that path. Permission changes emit an audit event.
- Destructive ops (`dispose`) require `confirm:true` from the user; UI shows a confirmation dialog. Credentials never enter prompts/events — `redactSecrets` on all free text; browser secrets never read.

---

## 11. Real runtime events

- Durable: `hive.appendLog({kind:'computer', event, computerId, agentId, correlationId, ...safeMeta})` — rides the existing Activity tab, memory graph, and floor-quiet mtime signal. Events: `created, starting, ready, stopped, failed, workspace-init, workspace-recovered, browser-opened, browser-closed, browser-navigated, browser-error, screen-captured, paused, resumed, control-started, control-ended, permission-denied, recovered-offline, disposed, sleeping`.
- Live: `emit('computer:updated', {computerId, status, ...})` → preload `onComputerUpdated` → panel (CeoPanel pattern) + a `computer:event` entry for the Activity feed where useful.
- Every event carries `ts`, `computerId`, `agentId`, and `correlationId` for task-linked ops (goal/task ids when the op originates from CEO flow). All free text through `redactSecrets`. Screenshots/URLs: metadata only, URL redacted.
- **Office:** avatars stay driven exclusively by real agent tool events (`hive:hookEvent`) — computer events surface in the Activity feed and Computer panel. No manufactured office activity.

---

## 12. Command Center integration

New tab `computer` in `CommandCenterPanel` (same registration points as Phase 3's `ceo` tab + i18n keys ×3 locales). For the **selected agent** (`selectedAgent(store)`):

- computer id/status (+ derived WORKING/WAITING reasons), workspace path (copyable), browser status + redacted URL/title + **real screenshot** (base64 from `captureScreen`), terminal session status (real pty info), last start time, last error + recovery history (from events), controls: Start/Stop/Pause/Resume/Restart, Open browser, Watch, Take control/Release, Dispose (confirmation dialog → `confirm:true`).
- Permission-denied and unsupported results render as explicit states with the returned `error`/`code` — controls never pretend.
- No computer yet for this agent → `Create computer` (calls `computer:create`). Empty/offline/loading/error states as in CeoPanel.

---

## 13. Files to change

**New:**

| File | Purpose |
|---|---|
| `src/shared/computer.ts` | types: record, statuses, permissions, limits, results, transition table, defaults |
| `src/main/computer.ts` | `ComputerManager` — state machine, ops, permissions, workspace/browsers/terminal association, reconcile, events (DI) |
| `src/main/computerBrowser.ts` | Electron `BrowserWindow` adapter implementing `BrowserAdapter` |
| `src/main/computerIpcValidation.ts` | pure IPC input validators (house style, node-testable) |
| `src/renderer/src/components/ComputerPanel.tsx` | Command Center panel |
| `test/computer-manager.test.cjs` | state machine, identity, lifecycle, permissions (fake adapters) |
| `test/computer-workspace.test.cjs` | path validation, traversal, symlink boundary, cross-agent |
| `test/computer-persistence.test.cjs` | restart recovery, stale marking, no-replay |
| `test/computer-ipc-validation.test.cjs` | IPC input validation |
| `test/computer-panel-contract.test.cjs` | tab/API/channel/wiring contract |
| `test/computer-electron.electron.cjs` (optional, run via `npx electron`) | REAL SQLite migration+CRUD, REAL BrowserWindow partition+capturePage — clearly labeled OS-process tests |

**Modified (additive):** `src/main/db.ts` (migration 2 + computer CRUD), `src/main/index.ts` (construction, reconcile, `computer:*` IPC, `pty:write` gate, quit cleanup), `src/preload/index.ts` (API + `onComputerUpdated`), `CommandCenterPanel.tsx` (tab), locales ×3, docs.

---

## 14. Migration & compatibility risks

- Migration 2 is append-only; older app versions ignore the table (safe rollback). No existing rows touched.
- `pty:write` gate applies **only** to agents that have a computer — zero behavior change otherwise (regression suite proves it).
- Browser windows created lazily (never at startup) — no startup cost, no window-count explosion; quit path closes all computer windows.
- Better-sqlite3 ABI: app uses the Electron prebuild (upstream postinstall convention); node tests never import `db.ts` (upstream never does either).

## 15. OS-specific dependencies

- Target OS for this phase: **Windows x64 (this machine)**. Known items: symlink/junction creation may EPERM (tests fall back to junction + document skip); hidden-window `capturePage` verified on Windows in Increment D; ConPTY quirks already handled upstream (`tools/patch-node-pty-conpty.cjs`); container sandbox deferred (§3.2).

## 16. Operations requiring approval

- `dispose` (destructive) → `confirm:true` + UI confirmation dialog + audit event.
- `takeControl` → explicit user action (panel button), visible indicator, immediate release path.
- Permission changes → user-only IPC + audit event.
- Everything else (start/stop/pause/resume/capture/watch) is a normal user operation on their own machine.

## 17. Testing plan (mapped to the 20 required concerns)

| # | Concern | Where |
|---|---|---|
| 1 | Stable computer identity | computer-manager (id stability, ensureForAgent idempotence) |
| 2 | Persistence + restart recovery | computer-persistence (MemoryRepo serialized across manager instances) + real SQLite in computer-electron |
| 3-4 | Path validation / traversal | computer-workspace (`safeResolve` + auth) |
| 5 | Symlink boundary | computer-workspace (junction; documented skip if EPERM) |
| 6 | Cross-agent access | computer-workspace (default deny + explicit grant) |
| 7 | Browser profile separation | manager (distinct partition ids) + electron (real dirs/windows) |
| 8 | Browser lifecycle errors | fake adapter (load fail → ERROR, unsupported → UNSUPPORTED) |
| 9-10 | PtyManager integration / duplicate prevention | real PtyManager in node (works — verified) + id guard |
| 11 | Graceful stop + unexpected exit | real pty kill + exit handler; adapter close |
| 12 | Invalid transitions | table-driven |
| 13 | Pause/resume semantics | ops refused while paused; process-alive truth asserted |
| 14 | Permission checks | terminal gate + browserNav deny |
| 15 | Screen-inspection authorization | screenView false → denied |
| 16 | IPC validation | computer-ipc-validation |
| 17 | Secret redaction | URL token → `[redacted]` in events |
| 18 | Missing workspace/profile recovery | computer-persistence reconcile |
| 19 | Task cancellation propagation | `hasActiveTask` derivation flips to WAITING on cancel; no lingering WORKING |
| 20 | Regression | full `npm run test:focused` vs Phase 3 baseline **1040/1004/22/14** |

**Honesty rules:** unit tests with fakes are labeled mocked; tests touching real ptys/windows are labeled; acceptance demo runs real processes; full-suite failures compared against the exact Phase 3 baseline (22 known upstream environmental failures); no claim of OS-level isolation.

---

## 18. Increment plan (sequential, tests after each)

- **A** — types + migration 2 + `ComputerManager` identity/list/create/get/dispose(pending) + reconcile skeleton → `computer-manager` + `computer-ipc-validation` first batch.
- **B** — workspace creation/authorization → `computer-workspace`.
- **C** — terminal association + `pty:write` gate + stop/pause effects → extend `computer-manager` (real PtyManager).
- **D** — `BrowserAdapter` (Electron impl + fake) → openBrowser/status/captureScreen + lifecycle.
- **E** — permissions finalized + watch/takeControl + events/redaction → extend tests (14, 15, 17).
- **F** — IPC + preload + ComputerPanel + i18n + wiring + recovery integration → `computer-panel-contract` + full suite + optional `npx electron` OS tests.
- **Acceptance** — two-agent demo (§19) → `PHASE-4-REPORT.md` → STOP at gate.

## 19. Acceptance demonstration plan (two agents)

Scripted where honest, manual where not:

1. Two computers (agents `alpha`, `beta` style ids) created → distinct stable ids.
2. Start both → READY, workspaces exist and differ.
3. Distinct browser profiles → real Electron windows with different `persist:` partitions (electron harness, real dirs on disk).
4. Authorized terminal operation per agent → real PtyManager pty per agent, gated `pty:write` verified (deny when `terminalExec:false`/PAUSED, allow when authorized) + output observed.
5. Inspect through the actual UI → launch `npm run dev`, verify Computer panel renders for the selected agent (real screenshot capture returns real PNG); full click-through documented as the review-gate manual step if headless verification is insufficient.
6. Cross-agent access → denied with `PERMISSION_DENIED`, event logged; granted only after explicit permission set.
7. Stop one computer → other unaffected (independent state).
8-11. Restart (electron harness relaunch / app relaunch) → ids, rows, workspace files intact; statuses reconciled to OFFLINE; events emitted.
12. No duplicates → single pty per agent, single browser window per computer, asserted.

Unavailable capabilities (full desktop streaming, container sandbox, multi-tab automation) are reported as `UNSUPPORTED` with the supported inspection method demonstrated instead.
