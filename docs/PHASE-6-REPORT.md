# Phase 6 Report — Security Core & Safety Supervisor

**Status: complete.** `npm run typecheck:node` 0 · `npm run typecheck:web` 0 new errors (pre-existing: `src/renderer/src/realtime/*.ts` only) · `npm run build` 0 · **45/45** Phase 6 tests across seven suites. Full suite: 1223 tests, 1187 pass, **22 fail — byte-identical to the design's baseline (22)**; the 22 failures live in the same 8 files reproduced on a clean HEAD stash baseline (fs-path-containment, worktree-deps symlink EPERM, hooks-socket EACCES, POSIX-path expectations) — all pre-existing/environmental, none caused by this phase. **Dev smoke boot** (`npm run dev`, ~70 s): main + preload bundles built, Electron up, hive bootstrapped, **zero error lines** in the log, clean teardown (no leftover processes/ports). IPC surface matches design §8 exactly; the preload push ships as `onSecurityUpdated` (design wrote `onApprovalUpdated` — same `security:updated` channel, name broadened because the panel refreshes on any desk event).

## What shipped

### Security Core (main)
- `src/shared/actionPolicy.ts` — **pure, electron/fs/config-free** evaluator: the catalog (hive safe/mutating/Bash/externalish/unknown; computer readonly/sensitive; integration-outbound; memory-write; system), precedence (`user > emergency:stopped > emergency:externalDisabled-for-externals > override > catalog`), `isExternalRequest`, and `autoApproveEnv(autoMode, securityFlag)` — autoMode alone never arms any approval shim.
- `src/main/audit.ts` — `AuditStore`: append-only JSONL at `<harnessHome>/audit-log.jsonl`; every line through the hive `redactSecrets` battery **before** disk (redaction that would break JSON ⇒ drop, fail-closed); 2 MB / 5000-event cap ring; newest-first query.
- `src/main/approvals.ts` — `ApprovalDesk`: durable pending queue (`approvals.json`, temp+rename); dedupe on agent+action+domain; approving an **agent** item arms a single-use 60 s retry token `agentId:action` (user items arm nothing); `consumeRetry` is synchronous (PreToolUse shim doctrine — no renderer round-trip).
- `src/main/policyService.ts` — the runtime binding: `checkAgentTool` (retry token → evaluator → deny + desk item + audit), `checkAsync` (forces `external: true` for integration-outbound), `setEmergency` (persists via injected KV), `auditMemoryWrite` (audit-only; Phase 5 ACL remains the enforcement). Every decision audited as `policy-decision` with `ruleId` verbatim.

### Wiring (index.ts / integrationBroker.ts / preload)
- Construction is early (before `HookServer`) so the PreToolUse boundary consults the catalog race-free; emergency flags ride PersistStore KV (`security.emergency`), captured lazily (boot-safe TDZ).
- **Broker gate**: `IntegrationBrokerDeps.authorizeOutbound` (optional — broker stays node-testable). Checked at step 4b — after capability, **before record/secret resolution** — so a denied call never decrypts anything. One-shot desk approvals (`workerId:integrationId`) release a single call; the next queues again (default-deny for externals).
- **autoMode bypass removed**: the three postures (`argsWithAutoModeFlag`, `HIVE_AUTO_APPROVE`, opencode `permission` allow-block) now require `autoApproveEnv(cfg.autoMode, cfg.security?.autoApproveInternal)`.
- **Memory-write audit**: `policyService.auditMemoryWrite` wired at both write paths — the agent task-result path (`onAccepted`) and the user `memory:write`/`memory:edit` IPC handlers (audit-only; the Phase 5 service ACL remains the enforcement, per design §2/§3). ComputerManager is deliberately untouched (design §1 non-goal).
- **Emergency webhook queueing (§6)**: on STOP, fresh inbound webhooks are forced through the existing held-pending path (202 + token, audited `emergency:stopped`) and `dispatchWebhookWork` refuses at the dispatch point — so a release pressed while STOP is armed stays pending, nothing is processed.
- **Held-message surfacing (§1)**: pending webhook/org held messages appear in the Approval Desk as **read-only** rows (`kind: webhook-held`, `readOnly: true`); deciding them stays on `triggerHistory:decide` (surface-only, no flow rewrite). The panel shows a "held — decide in Triggers → History" chip instead of approve/deny buttons.
- **IPC surface** (all user-pinned — the renderer can never name an actor, self-approve, or write policy from an agent-writable path): `security:state|emergency|autoApproveInternal`, `policy:get|set`, `approvals:list|approve|deny`, `audit:list`, `integrations:revokeSecret`; push channel `security:updated`. Emergency `paused=true` drives `control.pause(id, true)` across the roster; clearing does **not** mass-resume.
- Preload exposes the same eleven methods on `window.cth` with typed shapes.

### UI (renderer)
- `src/renderer/src/components/SecurityPanel.tsx` — emergency flags (two-step arm, honest per-flag hints), auto-approve opt-in toggle, policy override editor (domain/action/value + clear), approval desk with live `security:updated` refresh (debounced), audit tail with kind filter ("redacted at write time" caption), integration secret revocation (two-step confirm). Every byte from IPC — no mock/fake data.
- Mounted as a `security` tab in `CommandCenterPanel`; `securityTab` i18n block added to en/ar/zh-CN (52 keys, byte-identical key sets).

## Tests (45, seven suites)

| Suite | Covers |
| --- | --- |
| `action-policy.test.cjs` (9) | Precedence matrix, catalog cases, `isExternalRequest`, `autoApproveEnv` truth table |
| `audit-store.test.cjs` (6) | JSONL + newest-first, kind/limit, secret-never-on-disk, redaction-breaks-JSON fail-closed, mkdir, corrupt-line skip |
| `approvals-desk.test.cjs` (7) | Dedupe, one-shot TTL token, user-actor arms nothing, double-decide error, persistence roundtrip |
| `policy-service.test.cjs` (8) | REAL service+desk+audit: allow path, deny+desk+approvalId, approve→retry-token pass once→new desk item, `setEmergency` persist+audit, `auditMemoryWrite` rows (stored/rejected + code, no desk items) |
| `security-bypass.test.cjs` (3) | autoApproveEnv truth table; **source grep** that the three postures use `autoApproveEnv` and bare `cfg.autoMode` gates are gone; actionPolicy purity (no electron/fs/config/process) |
| `security-panel-contract.test.cjs` (6) | preload↔main channel parity (10 channels + `security:updated`), USER pinning (`decide(..., 'user')`), policy:set vocabulary, panel no-mock + `window.cth` only, locale key parity |
| `emergency.test.cjs` (6) | Design §9: STOP beats allow-override (every domain), user never bound, externalDisabled externals-vs-internals, webhook forced-hold + dispatch refusal wiring, pause-all→ControlRegistry (no mass-resume), KV persistence + broker→PolicyService |

## Security invariants enforced
1. The evaluator grants nothing by itself — overrides exist only via user-pinned IPC.
2. Emergency beats everything — a user `allow` override cannot defeat STOP or EXTERNAL-DISABLED.
3. Unknowns fail safe (`require-approval`), never open.
4. The operator is never bound — STOP/Pause stop agents, not the user.
5. Denied outbound calls never touch the secret store (gate before decrypt).
6. Audit is fail-closed: a line that redaction breaks is dropped, never written raw.
