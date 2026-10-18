# Vishwajeet Team v0.6.0 [AI Company]

**A local hive of Claude Code, Antigravity, Codex, Gemini, Cursor, Grok & Copilot agents that run themselves.**
Messaging, routing, and remembering, coordinated by your orchestrator, who you talk to. Local-first and 100% free open source.

### → [**Vishwajeet Team on GitHub**](https://github.com/Vishwajeetsrk/Team)

---

## What's new in 0.6.0

**Owner approvals, and a clearer free story.** This release lands one-click approvals for the owner's own words, hardens how a model chosen in Settings reaches OpenCode's session, and removes the last stale "pre-release / Pro · Team" wording so the app reads as what it is: one product, 100% free, no tiers.

- **Approve and deliver, from the card.** An orchestrator can attach a frozen sentence — one target agent, one line, an expiry — to an ASK ME card. You see the exact text, the target, whether Enter is pressed, and when it expires, then click once to have the app type it straight into that agent's own session. No orchestrator relay, no copy-paste. Delivered once, stamped on the card, and a failure stays visible instead of silently retrying. (#713)
- **OpenCode models stop crashing on spawn.** Settings-delivered models are plumbed through every spawn path the same way Claude's are — god, revive, new agent, command center, and team restore — instead of only some of them. A model that OpenCode reads from config is no longer also forced onto a flag that doesn't exist for it. (#703)
- **Windows: installing Grok hooks no longer mangles the command.** On Windows the hook installer now invokes through the shell correctly, so `grok` resolves instead of failing to launch. (#749)
- **No more stale "pre-release" or "Pro · Team" tier wording.** The README badge, the hero copy, and the landing page now say **Pricing: 100% Free** and **Status: stable**, matching what actually ships — one free product, no plans.

### 100% Free

**Vishwajeet Team** is completely free, local-first, and open-source under the MIT License. Every capability is unlocked on your local machine with no paywalls, subscriptions, or license keys required.

---

## ⤓ Downloads

Latest builds for every platform from [Releases](https://github.com/Vishwajeetsrk/Team/releases):

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Vishwajeet-Team-0.6.0-mac-universal.dmg`](https://github.com/Vishwajeetsrk/Team/releases/latest/download/Vishwajeet-Team-0.6.0-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64), *recommended* | [`Vishwajeet-Team-0.6.0-win-x64-setup.exe`](https://github.com/Vishwajeetsrk/Team/releases/latest/download/Vishwajeet-Team-0.6.0-win-x64-setup.exe) |
| Portable (x64, no install) | [`Vishwajeet-Team-0.6.0-win-x64-portable.exe`](https://github.com/Vishwajeetsrk/Team/releases/latest/download/Vishwajeet-Team-0.6.0-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Vishwajeet-Team-0.6.0-linux-x86_64.AppImage`](https://github.com/Vishwajeetsrk/Team/releases/latest/download/Vishwajeet-Team-0.6.0-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/Vishwajeetsrk/Team/archive/refs/tags/v0.6.0.zip) · [Source code (tar.gz)](https://github.com/Vishwajeetsrk/Team/archive/refs/tags/v0.6.0.tar.gz)

---

## License & Credits

- Source code licensed under the **MIT License**. Copyright (c) 2026 Vishwajeet.
- Bundled pixel-art tilesets: **Modern Interiors - RPG Tileset [16X16]** by [LimeZu](https://limezu.itch.io/moderninteriors), used under the Complete Version licence. Credit to LimeZu is preserved in `LICENSE-ASSETS` and `ATTRIBUTION.md`.
