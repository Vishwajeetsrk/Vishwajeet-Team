# PHASE 6 DESIGN — Security Core & Safety Supervisor (Orbit M1)

**Status:** presented before coding (per process rule §12) · **Baseline:** Phase 5 final = 1178/1142/22/14
**Vision serving:** Orbit §8 (safety supervisor) + §2 (Dot authorization) · Closes pack gate Ph9 (only ❌) and top-10 gaps #1–#4, #8.

---

## 1. Existing capabilities (reused — nothing duplicated)

| Capability | Where | How Phase 6 uses it |
|---|---|---|
| Operator control (pause/gate/steer/halt) | `control.ts` `ControlRegistry` | Unchanged; emergency PAUSE-ALL drives it per-agent |
| PreToolUse deny path (race-free, no renderer round-trip) | `hooks.ts:506` `control.toolDecision` | **The policy hook point** — `ActionPolicy` is consulted at the same boundary, before control, returning structured deny |
| Breaker ladder + HITL | `breaker.ts` | Untouched (orthogonal: runtime health, not permission) |
| Computer default-deny matrix, user-only changes | `computer.ts` + `USER_ACTOR` | Untouched; policy is the **second, product-wide layer** (hive tools, integrations, external ops) |
| Webhook held-token approval (202 awaiting-approval) | `index.ts:2028+` | Left as-is operationally; held items **surface** in the new desk as read-only links (no flow rewrite) |
| `ceo:accept` human gate | `ceoService.ts` | Untouched; remains the task-verification gate |
| Encrypted secret store + per-call decrypt | `integrations.ts` `getSecret`/`setSecret` | New `revokeSecret()` — delete at rest; next call fails honestly |
| Append-only ledger pattern | `cost-ledger.jsonl`, `trigger-history.json` | Audit store = same JSONL temp discipline, secrets stripped via `redactSecrets` (hive.ts:275) |
| USER_ACTOR pinning (no renderer-named actor) | computer/`memory:*` handlers | Every new handler pins USER_ACTOR |
| autoMode spawn posture | `index.ts:3053/3209/3214` (`HIVE_AUTO_APPROVE`, `permission:allow`) | **Gated** on a new explicit config flag (see §5) |

## 2. Architecture — one policy, one desk, one audit trail

```
                 ┌────────────────────────────── main process ─────────────────────────────┐
 tool call ──▶ HookServer(PreToolUse) ──▶ ActionPolicy.evaluate ──▶ allow | deny(+audit)   │
 outbound  ──▶ IntegrationBroker        ──▶        ⍢            ──▶ hold → ApprovalDesk    │
 memory    ──▶ MemoryService (own ACL)  ──▶        ⍢ (audit only, internal)                │
                 └───────────────┬──────────────────────────────────────────────────────────┘
                                 ▼
              AuditStore (append-only JSONL, redacted)   ApprovalDesk (pending queue, user-only decisions)
                                 ▲
              EmergencyState { stopped, paused, externalDisabled } ── consulted FIRST by evaluate()
```

- **`src/shared/actionPolicy.ts`** (pure, renderer-safe, node-testable): types + the **default catalog** + `evaluatePolicy(request, ctx)`. Precedence: emergency stop > emergency externalDisabled > user override > catalog default > unknown-tool fallback. User actor → allow (audited). Agent actor → catalog. The function **grants nothing**: overrides come from user-owned config, never from the policy module, memory, prompts, or any agent-writable path.
- **`src/main/policyService.ts`**: binds config overrides + emergency state + audit + approvals; the single `check()` used by wiring points.
- **`src/main/audit.ts`**: `record(evt)` → `<harnessHome>/audit-log.jsonl` (temp+rename, capped ring, **every field through `redactSecrets`**), `query(filter)` returns newest-first. Events: `policy-decision`, `approval-decided`, `emergency-changed`, `secret-revoked`, `override-changed`.
- **`src/main/approvals.ts`**: durable pending queue (`<harnessHome>/approvals.json`, temp+rename). Item: `{id, kind:'policy', domain, action, actor, target?, detail, ruleId, createdAt, status:'pending'|'approved'|'denied', decidedAt?, decidedBy?}`. `approve/deny` are **user-only** (pinned in IPC). Approving a policy item clears one matching control-gate retry path: it sets a short-lived `policyRetryToken` the hook consults once (see §4).

## 3. Default catalog (the user-reviewable artifact)

Agent-actor defaults (all user-actor calls: allow + audit):

| Domain | Match | Decision | Rationale |
|---|---|---|---|
| hive-tool | `Read, Grep, Glob, TodoWrite, NotebookRead, Task` (exact) | allow | read-only / bookkeeping |
| hive-tool | `Edit, Write, NotebookEdit` | allow | workspace-contained (P4 traversal refusal) |
| hive-tool | `Bash` | **require-approval** | arbitrary exec is the #1 external-effect surface |
| hive-tool | name matches `/browser|web|http|fetch|slack|github|deploy|mail|crm|shopify/i` | **require-approval** | external-capable by name |
| hive-tool | anything else (unknown) | **require-approval** | fail-safe, never fail-open |
| computer-op | `get/list/status/watch/captureScreen/terminalInfo/workspaceInfo` | allow | inspection |
| computer-op | `start/stop/pause/resume/restart` | require-approval | lifecycle (user normally does this; agent-initiated flagged) |
| computer-op | `permissions/dispose/takeControl/openBrowser/navigate` | require-approval | sensitive |
| integration-outbound | any | **require-approval** | external by definition (unless emergency.externalDisabled → deny) |
| memory-write | any | allow + audit | internal; service ACL already enforced (P5) |
| system | any | deny for agents | emergency surface is user-only |

**Overrides** (`security.policyOverrides` config): user-only `policy:set` IPC; keys `"domain:action"`; values `allow|require-approval|deny`. Precedence over catalog, **never over emergency**. The supervisor cannot write overrides (no code path from policy/desk/approve into config policy keys).

## 4. Hook-boundary semantics (the honest constraint)

PreToolUse is **synchronous** with a shim timeout (per `control.ts` doctrine: fast deny, slow approval rides Claude's native prompt). Therefore:

- `require-approval` at the hook → **immediate structured deny** ("Held for operator approval — see the Approval Desk") **plus** a pending desk item. Operator approves → desk records it and arms a **one-shot retry token** (`agentId+tool`, 60 s TTL, single use): the next identical PreToolUse within the window **allows once** and consumes the token. Deny → no token; item recorded. This is race-free (no renderer round-trip in the hook), auditable, and bounded.
- Broker/webhook/integration paths are async → `require-approval` **holds** (202-style) with a desk item; approve releases the outbound call, deny cancels it.

## 5. autoMode gate (bypass removal)

Today: `cfg.autoMode` → `HIVE_AUTO_APPROVE=1` + `permission:{edit,bash,webfetch:allow}` on every spawn = silent approval bypass. Change: introduce **`security.autoApproveInternal` (default `false`)**. New posture:

```
HIVE_AUTO_APPROVE = (cfg.autoMode && cfg.security?.autoApproveInternal) ? '1' : '0'
permission allow-block likewise gated
```

**Behavior change (documented, intentional):** autoMode no longer auto-approves tools; the user must additionally opt into `autoApproveInternal`. Even then, emergency.externalDisabled and emergency.stop still override (policy consults before the shim's blanket allow — the hook path always runs policy first).

## 6. Emergency controls

`EmergencyState { stopped, paused, externalDisabled }` (in-memory + persisted KV via PersistStore):
- **stopped** → every agent PreToolUse denied; broker outbound refused; webhook inbound queues but does not process. User ops unaffected.
- **paused** → `ControlRegistry.pause(agentId, true)` for every registered agent (resume clears).
- **externalDisabled** → `integration-outbound` and external-capable hive tools deny regardless of override/autoApprove.
All three set/cleared **user-only** via `security:emergency`; every change audited. The supervisor cannot clear them (no agent-writable path).

## 7. Credential revocation

`revokeSecret(secretRef)` in `integrations.ts`: deletes the cipher blob entry, keeps the record, sets `revokedAt`; next `getSecret` → `undefined` → outbound fails honestly. User-only `integrations:revokeSecret` IPC (or extend existing remove path) + `secret-revoked` audit event.

## 8. IPC surface (all USER_ACTOR-pinned, validated)

| Channel | Purpose |
|---|---|
| `security:state` | emergency flags, autoApproveInternal, overrides, pending count |
| `security:emergency` | set/clear flags |
| `security:autoApproveInternal` | set flag |
| `policy:get` / `policy:set` | read/write overrides |
| `approvals:list` / `approvals:approve` / `approvals:deny` | desk |
| `audit:list` | query audit ring |
| `integrations:revokeSecret` | revoke at rest |

UI: one new **`SecurityPanel`** (Command Center tab): emergency buttons (two-step confirm), auto-approve toggle, override editor, Approval Desk list (approve/deny), audit tail, revoke actions. i18n ×3. Preload: 10 methods + `onApprovalUpdated` push.

## 9. Test strategy

- **Pure logic (node, no electron):** `action-policy` (precedence matrix, emergency beats override beats catalog, unknown-tool fail-safe, user-allow, agent-deny, override cannot defeat emergency, supervisor-grant impossibility = no override write path in module); `audit-store` (cap ring, redaction — a secret never lands on disk, newest-first query); `approvals-desk` (pending→decide, one-shot retry token TTL/single-use, persistence roundtrip via serialize/restore); `emergency` (flags, pauseAll→ControlRegistry propagation, stop beats allow).
- **Contract:** `security-panel-contract` — preload↔main channel parity, locale key parity ×3, USER_ACTOR pinning grep, no mock data.
- **Bypass:** pure `autoApproveEnv(cfg)` helper (extracted from index.ts posture logic) — autoMode alone does NOT arm; autoMode+flag does; flag alone does not.
- **Regression:** full suite vs 1178/1142/22/14; typecheck node 0 / web 33; build 0. Electron harness unchanged (no new SQLite — audit/desk are JSONL/JSON per house pattern).

## 10. Explicit non-goals

No OS sandbox; no network `webRequest` enforcement (that is M2 — policy records the decision, session enforcement follows); no rewrite of webhook/ceo approval flows (surface-only); no cloud/remote policy; no agent-facing policy introspection beyond the deny reason string; vault/KMS (encrypted blob store stays as-is).
