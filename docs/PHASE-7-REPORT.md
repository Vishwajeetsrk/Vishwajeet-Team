# Phase 7 Report — Computer Enforcement Completion (Orbit M2)

**Status: complete.** `npm run typecheck:node` 0 · `npm run build` 0 · new M2 suite **10/10** · focused security+computer suites **94/94** · full suite 1233 tests, 1197 pass, **22 fail — the exact pre-existing baseline set (same 8 environment-bound files)**. One contract regex updated to accept the explicit `: ComputerManager` annotation (`computer-panel-contract` 11/11 after; intent unchanged).

**M2 gate met:** every capability in the design §1 table now has an enforcement point **or** a named §5 deferral (CPU / memory / disk — named, never silent).

## What shipped

### 1. `browserDownloads` — always-deny bug fixed
`createComputerBrowser()` never passed a `downloadGate`, so `will-download` denied **even when the cap was `true`** (stored but unenforced, inverted). The factory now accepts `gates` and index.ts wires `downloadGate: (id) => computers.allows(id, 'browserDownloads')` — lazy, TDZ-safe closures. Absent gate still default-denies (unchanged).

### 2. `network` — default-deny webRequest on every computer session
- `ComputerBrowserDeps.networkGate?: (computerId, url) => boolean`; on `open()` the session gets `webRequest.onBeforeRequest({urls:['<all_urls>']})`.
- **Fail-closed ladder:** gate decides → gate absent ⇒ built-in `loopbackOnlyAllowed()` → gate throws ⇒ deny. `loopbackOnlyAllowed` allows exact loopback (`127/8` as full IPv4 only, `localhost`, `[::1]`) + local schemes (`about:`, `data:`, `blob:`, `file:`); `127.0.0.1.evil.test`-style suffix tricks are denied (test-locked).
- index.ts maps the stored cap: `network=true` ⇒ allow-all, `false` ⇒ loopback-only (local harness stays reachable, no egress). Blocked requests log through the browser sink (first + every 50th — no audit-ring noise).

### 3. `externalActions` — enforced at the tool-call boundary through M1
- New optional `PolicyService` dep `agentComputerCaps(agentId)` (index resolves via `ComputerManager.getForAgent`).
- `checkAgentTool` layer with precedence **user > emergency > user override > COMPUTER CAPABILITY > catalog**: a `catalog:*` result for an external-capable tool (`isExternalRequest`) with `externalActions=false` ⇒ **deny**, `ruleId: computer:externalActions`, audited, **no desk item** (capability refusal ≠ approval queue).
- Agents **without** a computer: dep returns null ⇒ catalog behavior byte-identical to M1 (regression-locked).
- A user override still beats the capability layer (same operator's explicit intent).

### 4. `browserNav` — verified end-to-end (no behavior change)
Real `ComputerManager` test: fresh computer denies `openBrowser`/`navigate` (`PERMISSION_DENIED`, evented) even while OFFLINE (perm check precedes state guard) → grant `agent.browserNav` + `start` → both allowed → revoke → denied again. Live in both directions.

## Files
- `src/main/computerBrowser.ts` — `networkGate` dep, `loopbackOnlyAllowed` export, `onBeforeRequest` wiring, `createComputerBrowser(log, gates)`.
- `src/main/policyService.ts` — `agentComputerCaps` dep + capability layer in `checkAgentTool`.
- `src/main/index.ts` — browser gates + caps seam wired; `const computers: ComputerManager` annotation (TS circular-inference fix).
- `docs/PHASE-7-DESIGN.md` — design (§1 evidence table, §2 architecture, §5 named deferrals, §7 honest limitations).
- `test/computer-enforcement.test.cjs` — 10 tests: allowlist truth table, network/download gates on the fake session, capability layer (deny/no-desk/audit, override-beats-cap, no-computer ≡ catalog, emergency-first), browserNav e2e, §1 contract greps (enforced-or-named-deferred).

## Named deferrals (design §5 — gate allows deferrals, they must be NAMED)
| Gap | Deferral |
|---|---|
| CPU limit per computer | No cross-platform primitive in Electron/node-pty (Job Objects/rlimits outside current process model) → **M11 reliability pass adopts OS-level job control** |
| Memory limit per computer | Same primitive gap; `--max-old-space-size` would be theater for arbitrary native CLIs → **defer with CPU** |
| Disk quota per workspace | Feasible but is a whole-FS-boundary change owned by P4 containment → **sequenced after M2** |

## Honest limitations (design §7)
- `network`/`externalActions` bind agents **via their computer**; a hive agent with no computer is governed by the M1 catalog alone (nothing stored ⇒ nothing to enforce).
- Per-request network denials log to the browser session, not the audit ring (the audit records permission *changes* and policy *decisions*).
- Bash-side egress (curl in a PTY) is not session-filtered — OS-level network policy remains out of scope (M1 non-goal carries forward).
