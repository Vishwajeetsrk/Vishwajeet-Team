# UPSTREAM BASELINE — Vishwajeet Team

**Date:** 2026-10-09
**Branch:** `feature/ai-company-os-foundation`
**Upstream commit:** 2c646127 (main)
**Package version:** 0.4.6 (package.json) / 0.5.3 (README marketing)
**Status:** Cloned, inspected, not yet modified

---

## 1. What This Is

Vishwajeet Team is an Electron desktop agent harness that turns terminal coding CLIs (Claude Code, Codex, Grok, Antigravity, Gemini CLI, Kimi, Qwen, OpenCode, Crush, pi, Copilot CLI, Cursor) into a self-coordinating multi-agent office. Each agent is a real PTY process with its own working directory, memory, and mailbox. A GOD agent ("Michael") orchestrates. Avatars on a Pixi.js floor reflect real hook events.

**Repository:** https://github.com/Vishwajeetsrk/Vishwajeet-Team
**License:** MIT (source code). Pixel-art assets: LimeZu Complete Version licence (requires attribution). See LICENSE and LICENSE-ASSETS.

---

## 2. Tech Stack (Verified)

| Layer | Technology |
|---|---|
| Shell | Electron 32.x |
| Build | electron-vite 2.x |
| UI | React 18 + TypeScript |
| Canvas | Pixi.js 8.x |
| Terminal | xterm.js 5.x + node-pty 1.x |
| State | Zustand 4.x |
| Persistence | better-sqlite3 11.x |
| Editor | Monaco + CodeMirror |
| i18n | i18next 26.x |
| Testing | node:test (128 test files) |
| Packaging | electron-builder 25.x |

---

## 3. Architecture (Verified from Source)

### Two Data Planes

```
Electron Renderer (React)
├── Pixi.js Office Floor (avatars, stations)
├── xterm.js Terminal View
└── Command Center (kanban, memory, tasks)
        │
    IPC (contextBridge: window.cth)
        │
┌───────┴────────────────┐
│ Event Plane            │ Terminal Plane
│ hooks.ts (UDS server)  │ pty.ts (node-pty manager)
│ hive.ts (git-based     │ fs.ts / git.ts (sandboxed
│  multi-agent layer)    │  filesystem + git bridges)
│ router + GOD agent     │
└────────────────────────┘
```

### Key Source Files

| File | Lines | Responsibility |
|---|---|---|
| `src/main/index.ts` | 5511 | Main process entry, window management, IPC handlers, lifecycle |
| `src/main/pty.ts` | 844 | PTY spawn/write/resize/kill/stream, session management |
| `src/main/hive.ts` | 3669 | Multi-agent coordination: memory, mailboxes, router, task ledger |
| `src/main/hooks.ts` | — | Hook server (UDS), provider hook shims (cth-hook, agy-hook) |
| `src/main/breaker.ts` | — | Circuit breaker (steer → constrain → stop) |
| `src/main/control.ts` |  | Control registry (HITL gates) |
| `src/main/db.ts` | — | SQLite durable store (windows, history, cost ledger) |
| `src/main/config.ts` | — | Harness config persistence |
| `src/main/memory.ts` | — | Semantic memory CLI wrapper (MemPalace) |
| `src/main/knowledge.ts` | — | Enterprise knowledge graph |
| `src/main/integrations.ts` | — | Integrations registry + secret broker |
| `src/main/skills.ts` | — | Skills browser (227+ skills) |
| `src/main/github.ts` | — | GitHub issue + CI ingestion |
| `src/main/slack.ts` | — | Slack webhook server |
| `src/main/webhook.ts` | — | Inbound webhook server |
| `src/main/telemetry.ts` | — | OTel collector |
| `src/main/usage.ts` | — | Usage/cost tracking |
| `src/main/roster.ts` | — | UI floor roster (separate from hive registry) |

### Test Coverage

128 test files in `test/`, run via `node --test test/*.test.cjs`. Tests cover: agent lifecycle, provider config, hive messaging, hooks, circuit breaker, memory, PTY, filesystem containment, i18n, webhooks, skills, and more.

---

## 4. What Already Works

| Capability | Evidence | Status |
|---|---|---|
| Agent spawning (PTY) | `src/main/pty.ts` — full PtyManager with spawn/write/resize/kill/stream | WORKING |
| Terminal I/O | xterm.js renderer + node-pty bridge | WORKING |
| Multi-agent coordination | `src/main/hive.ts` — outbox/inbox mailboxes, router, hop limits | WORKING |
| GOD orchestrator | Michael agent auto-spawns, adjudicates routing, escalates to human | WORKING |
| Per-agent memory | `memory.md` per agent + MemPalace semantic index | WORKING |
| Persistent tasks | `tasks.json` ledger with dependencies, retry, checkpoint | WORKING |
| Office visualization | Pixi.js floor, avatars walk to stations based on real hook events | WORKING |
| Circuit breaker | Steer → constrain → stop ladder for runaway agents | WORKING |
| Cost tracking | Token budgets, cost ledger, per-agent usage | WORKING |
| Approvals (HITL) | Permission prompts in agent sessions, remote-control via phone | WORKING |
| Skills | Skills browser, per-agent skill toggles, 227+ catalog | WORKING |
| Integrations | Registry + secret broker, MCP support | WORKING |
| Git worktrees | Per-agent isolation so parallel agents never collide | WORKING |
| Session resume | Crashed agents keep uncommitted work | WORKING |
| Webhooks | Inbound webhooks for GitHub, Linear, Telegram | WORKING |
| Slack | Slack channel → agent queue → reply in-thread | WORKING |
| Auto-updates | Title-bar badge, download + restart | WORKING |

---

## 5. Baseline Commands

```bash
# Install dependencies (requires C/C++ toolchain for node-pty)
npm install

# Run tests
npm run test:focused

# Type check
npm run typecheck

# Dev (launches Electron)
npm run dev

# Build
npm run build
```

**Note:** `npm install` runs `electron-rebuild` (postinstall) which requires native build tools. On Windows: Visual Studio C++ workload. On macOS: Xcode CLT. On Linux: build-essential + libpty-dev.

---

## 6. On-Disk Layout

```
~/.munderdifflin/           (or $HARNESS_HOME)
├── hive/                   # Git repo — multi-agent coordination
│   ├── PROTOCOL.md         # Agent-facing contract
│   ├── registry.json       # Roster (id, role, capabilities, status)
│   ├── board.md            # Shared blackboard
│   ├── tasks.json          # Task ledger
│   ├── log.jsonl           # Append-only event feed
│   └── agents/<id>/
│       ├── identity.md
│       ├── memory.md
│       ├── inbox/
│       ├── outbox/
│       └── cursor.json
├── roster.json             # UI floor roster
├── db.sqlite               # Windows, history, cost ledger
└── palace/                 # Semantic memory index
```

---

## 7. License & Attribution

- **Source code:** MIT License (`LICENSE`)
- **Pixel-art assets:** LimeZu "Modern Interiors" tileset, Complete Version licence (`LICENSE-ASSETS`). Credit required: "Modern Interiors - RPG Tileset [16X16] by LimeZu"
- **Office cast:** Procedurally drawn in `portraitArt.ts` (not LimeZu art)
- **Attribution file:** `src/renderer/src/assets/ATTRIBUTION.md`

---

## 8. Baseline Verification Status

| Check | Result |
|---|---|
| Git clone | PASS — 2782 files |
| Feature branch created | PASS — `feature/ai-company-os-foundation` |
| package.json inspected | PASS — v0.4.6 |
| Architecture docs read | PASS — README, ARCHITECTURE.md, HIVE.md, SPEC.md |
| Source files inspected | PASS — index.ts, pty.ts, hive.ts, test/ |
| Dependencies installed | NOT YET — pending Phase 1 |
| Tests run | NOT YET — pending Phase 1 |
| App launched | NOT YET — pending Phase 1 |

**Baseline established. Ready for Phase 1 verification.**
