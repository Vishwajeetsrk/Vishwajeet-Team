# PHASE-7 DESIGN — Computer Enforcement Completion (Orbit M2)

**Goal:** close every "stored but unenforced" capability so the permission
matrix is *the* truth, not a settings screen. **Gate (from M2):** no capability
remains "stored but unenforced" without a named deferral.

**Depends on:** M1 policy seam (`PolicyService`, audit, approvals — shipped as
Phase 6) and P4 computer runtime (shipped).

## 1. Current state (investigated, 2026-10-13)

| Capability | Stored | Enforced? | Evidence |
|---|---|---|---|
| `browserNav` | P4 | **yes** | `computer.ts` `openBrowser`/`navigate` → `requirePermission` (user IPC only; hardcoded USER_ACTOR). Verified end-to-end (§6 tests). |
| `browserDownloads` | P4 | **BROKEN — always-deny** | `computerBrowser.ts` `will-download` honors `downloadGate`, but `createComputerBrowser()` (index.ts:532) never passes one ⇒ gate absent ⇒ deny even when the cap is `true`. |
| `network` | P4 | **NO** | `allows(id,'network')` is called only by the renderer query channel (index.ts:4547). No `webRequest` hook exists anywhere. |
| `externalActions` | P4 | **NO** | same — query-only. The hook/tool boundary (`PolicyService.checkAgentTool`) never consults computer records. |
| `terminalExec`, screens, crossAgent, workspace | P4 | **yes** | `computer.ts` gates (P4 tests). |
| CPU / memory / disk limits | P4 `resourceLimits` = start-attempts, start-timeout, screenshot-bytes, idle-sleep only | **no** | **Named deferral — §5.** |

## 2. Architecture

```
tool call (hive agent)  → HookServer PreToolUse → PolicyService.checkAgentTool
                            │  M1: emergency → override → catalog
                            │  NEW layer (before catalog): agent's computer caps
                            │    externalActions=false → deny external-capable actions
                            ▼
browser session (per computer partition) → session.webRequest.onBeforeRequest
                            NEW: network=false → default-deny (loopback-only allowlist)
                          → session will-download → downloadGate (FIXED: actually wired)
```

### 2a. Hook-boundary enforcement of `externalActions` (through M1)

- New optional dep on `PolicyService`: `agentComputerCaps?: (agentId) => { externalActions: boolean; network: boolean } | null` (index.ts wires `computers.getForAgent`).
- In `checkAgentTool`, AFTER emergency + user-override, BEFORE catalog:
  `caps = agentComputerCaps(agentId)`; if caps exist and `externalActions === false`
  and `isExternalRequest({domain:'hive-tool', action: tool})` → **deny**,
  `ruleId: 'computer:externalActions'`, audited as a `policy-decision` (no desk item —
  it is a capability refusal; a user override `hive-tool:<tool>: allow` still wins,
  because the override is the same operator's explicit intent and M1 precedence says
  override > capability catalog alike).
- Agents with **no computer** fall through to the M1 catalog unchanged (nothing
  stored ⇒ nothing to enforce — the gate is about stored caps, not inventing new ones).
- Precedence (full): `user actor > emergency > user override > computer capability > catalog`.
- `network` is enforced at the session (§2b), NOT at the tool boundary — a Bash curl
  is governed by catalog/override as today (honest limitation, recorded in §7).

### 2b. Session network policy (`network` cap)

- `ComputerBrowserDeps` gains `networkGate?: (computerId: string, url: string) => boolean`
  (same injectable pattern as `downloadGate`).
- On window open, if `session.webRequest` exists:
  `session.webRequest.onBeforeRequest({ urls: ['<all>'] }, (details, cb) => cb({ cancel: !gate(id, details.url) }))`.
- Default-deny semantics when `networkGate` is absent/throws ⇒ **loopback-only**:
  `http(s)://127.0.0.1*`, `localhost`, `::1`, plus non-network schemes the session
  needs (`about:blank`, `data:`, `blob:`, `file:` is NOT exempt — file stays denied
  unless network=true? No: file:// is local, allow it under loopback-only? **Decision:
  allow `file:` only for `file://` URLs inside the computer's own profile/workspace —
  simplest safe default: allow `file:` (no egress), deny everything non-loopback
  when network=false; allow all when network=true.**
- Loopback exemption exists so the computer can reach the local harness (hooks,
  dev server) without granting the internet.
- Every denied request is best-effort logged through the browser `log` sink
  (rate-limited: first + count per session) — audit lives at the boundary that
  already produces `permission-denied` events (kept in-session, not per-request
  audit rows — audit noise would drown the trail; the *state change* to `network`
  is already audited by P4's permission events).

### 2c. `downloadGate` fix (wiring, not redesign)

- `createComputerBrowser(log, gates?)` accepts `gates: { downloadGate?, networkGate? }`.
- index.ts passes closures resolving **lazily** through `computers` (TDZ-safe:
  gates only run at download/request time): `downloadGate: (id) => computers.allows(id, 'browserDownloads')`, `networkGate: (id, url) => networkAllowed(computers.allows(id,'network'), url)`.
- Keep default-deny when absent (unchanged).

### 2d. `browserNav` end-to-end verification

- Test the real `ComputerManager` (fake repo/browser, house style): fresh computer →
  `openBrowser`/`navigate` denied with `PERMISSION_DENIED`; after granting
  `agent.browserNav` → allowed; user IPC path actor remains USER_ACTOR-pinned.
- No behavior change (P4 semantics kept; M2's gate says *verify*).

## 3. IPC surface

No new channels. `computer:allows` (index.ts:4547) keeps answering renderer
queries — now backed by gates that actually consult it. Emergency/autoApprove
IPC from M1 untouched.

## 4. Files (planned)

| File | Change |
|---|---|
| `src/main/policyService.ts` | optional `agentComputerCaps` dep; capability layer in `checkAgentTool`; header doc |
| `src/main/index.ts` | wire `agentComputerCaps` + browser `gates` into `createComputerBrowser` |
| `src/main/computerBrowser.ts` | `networkGate` dep + `onBeforeRequest` wiring; `createComputerBrowser(log, gates)` |
| `src/main/computer.ts` | none (already correct); events reused |
| tests | `computer-enforcement.test.cjs` (new), extend `policy-service.test.cjs` |

## 5. Named deferrals (the gate allows deferrals — they must be NAMED)

- **CPU limit per computer:** no cross-platform primitive in Electron/node-pty
  (Windows Job Objects / POSIX rlimits are outside the current process model;
  agent CLIs are arbitrary native binaries). **Defer to an M11 reliability pass
  that adopts OS-level job control.**
- **Memory limit per computer:** same primitive gap; `--max-old-space-size`
  only covers node-based CLIs (not universal, would be theater). **Defer with CPU.**
- **Disk quota per workspace:** feasible (size preflight at the workspace write
  gate) but it is a whole-FS-boundary change touching P4's containment module;
  not required to close `network`/`externalActions`. **Defer, named: "workspace
  disk quota — needs the P4 fs-boundary owner, sequenced after M2."**

Every deferral above is listed in the M2 acceptance report as `stored-but-deferred:
CPU/memory/disk` — never `stored-but-unenforced`.

## 6. Test strategy (design §9 style)

- **Pure/unit (node):** `networkAllowed(cap, url)` truth table — network=false
  blocks `https://example.com`, allows `http://127.0.0.1:5173`, `localhost`, `::1`,
  `about:blank`, `data:`, `blob:`, `file:`; network=true allows all; gate missing ⇒
  loopback-only (fail-closed). `networkGate` absent ⇒ deny non-loopback.
- **ComputerBrowser (fake window, house style):** open() wires
  `onBeforeRequest`; requests cancelled per gate; `will-download` gate now
  receives the REAL gate (granted cap ⇒ allowed, revoked ⇒ denied).
- **PolicyService:** agent with computer `externalActions=false` → WebFetch/Bash
  denied `ruleId computer:externalActions` + audit row; Read unaffected; user
  override allows it back; agent WITHOUT computer → catalog behavior identical
  (regression: existing M1 suites still green); emergency still first.
- **browserNav e2e (ComputerManager, fake repo):** fresh deny → granted allow.
- **Contract greps:** index.ts passes gates into `createComputerBrowser`;
  `webRequest` present in computerBrowser.ts; no capability in §1 table lacks an
  enforcement point or a §5 deferral.
- **Regression:** full suite vs baseline 1223/1187/22, typecheck node 0 / web
  pre-existing-only, build 0.

## 7. Honest limitations (recorded, not hidden)

- `network`/`externalActions` bind **agents via their computer**. A hive agent
  without a computer is governed by the M1 catalog alone (default-deny unknowns,
  require-approval for externalish) — there is no stored cap to enforce.
- Per-request network denials are logged to the browser session log, not the
  audit ring (audit records permission *changes* and policy *decisions*).
- Bash-side egress (curl in a PTY) is not session-filtered — OS-level network
  policy is out of scope (no sandbox; M1 non-goal carries forward).
