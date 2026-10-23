---
name: screenshot-to-code
description: >-
  Converts screenshots, mockups, wireframes, and UI design images into clean,
  functional, responsive frontend code (HTML/Tailwind, React, Vue, or pixel-perfect
  CSS) using multimodal vision AI. Based on abi/screenshot-to-code and integrated
  with the Replica workflow for clean-room visual reconstruction, layout hierarchy,
  color token mapping, and design system parity.
---

# screenshot-to-code

Convert any screenshot, mockup, wireframe, or reference UI image into clean, maintainable, production-ready frontend code.

Inspired by [abi/screenshot-to-code](https://github.com/abi/screenshot-to-code) and built to work seamlessly with the `replica` framework (`replica-recon`, `replica-design`, `replica-build`, `replica-diff`).

```
replica/screens/         Reference screenshots of target screens (never shipped)
src/components/          Reconstructed clean components
src/design/tokens.ts     Extracted design tokens (colors, typography, spacing, shadows)
```

---

## The Core Rules (Clean-Room UI Reproduction)

1. **Reconstruct Structure, Don't Copy Assets:**
   - Synthesize fresh, semantic HTML/React code from visual observation.
   - Never decompile, rip, or hotlink source assets. Use SVGs, clean CSS shapes, or open-licensed icon sets (Lucide, Heroicons, Phosphor).
2. **Layout & Hierarchy Over Raw Pixels:**
   - Prioritize responsive Flexbox and CSS Grid layout structures over brittle fixed coordinates.
   - Isolate sections into reusable, modular components.
3. **Exact Token Extraction:**
   - Extract exact hex/HSL colors for backgrounds, borders, active states, text tones, and gradients.
   - Map observed fonts to matching open-source typefaces (Inter, JetBrains Mono, Outfit, Silkscreen/Pixel fonts).
4. **Resilience & Safe Fallbacks:**
   - No broken image links or `<img>` placeholders without dimensions. Use SVG data-URIs or CSS aspect-ratio containers.

---

## 4-Step Screenshot-to-Code Pipeline

### Step 1: Deep Visual Scan & Layout Decomposition

Before writing a single line of code, analyze the input image across 5 visual layers:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Viewport & Shell: Window header, titlebar, canvas size   │
├─────────────────────────────────────────────────────────────┤
│ 2. Navigation & Toolbars: Tabs, breadcrumbs, search, actions│
├─────────────────────────────────────────────────────────────┤
│ 3. Main Workspace: Canvas / Data Grid / Panels / Splitters   │
├─────────────────────────────────────────────────────────────┤
│ 4. Sub-Panels / Drawers: Inspector, Terminal, Feed, Cards   │
├─────────────────────────────────────────────────────────────┤
│ 5. Micro-details: Pills, badges, status lights, tooltips   │
└─────────────────────────────────────────────────────────────┘
```

For each layer, record:
- **Box model**: Padding, margins, gap, border width, border radius, drop shadows.
- **Color roles**: Background, surface, border, primary text, muted text, accent/status colors (idle, working, error, success).
- **Typography**: Font family category (sans-serif, serif, monospace, pixel-art), font size (px/rem), font weight, line height.
- **States**: Default, hover, active, disabled, selected, focused.

---

### Step 2: Extract Design Tokens

Create or align with the project's design token system:

```typescript
// Extracted palette & typography tokens
export const tokens = {
  colors: {
    bg: '#141419',
    surface: '#1c1c24',
    surfaceElevated: '#242430',
    border: '#2c2c3a',
    textPrimary: '#f0f0f5',
    textMuted: '#8b8b9e',
    accent: '#4ecdc4',
    status: {
      idle: '#f1c40f',
      working: '#2ecc71',
      blocked: '#e74c3c',
      info: '#3498db'
    }
  },
  typography: {
    fontUi: 'Inter, system-ui, sans-serif',
    fontMono: '"JetBrains Mono", monospace',
    fontDisplay: '"Outfit", sans-serif'
  },
  radii: {
    sm: '4px',
    md: '8px',
    lg: '12px'
  }
};
```

---

### Step 3: Code Generation Archetypes

#### A. React + Tailwind CSS (Default Modern Web)

```tsx
import React, { useState } from 'react';

interface AgentCardProps {
  name: string;
  role: string;
  status: 'idle' | 'working' | 'blocked';
  progress: number;
}

export const AgentCard: React.FC<AgentCardProps> = ({ name, role, status, progress }) => {
  return (
    <div className="flex flex-col bg-[#1c1c24] border border-[#2c2c3a] rounded-lg p-3 shadow-sm hover:border-[#4ecdc4] transition-all">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded bg-[#242430] flex items-center justify-center font-mono font-bold text-xs text-[#f0f0f5]">
            {name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-[#f0f0f5] truncate">{name}</h4>
            <p className="text-xs text-[#8b8b9e] truncate">{role}</p>
          </div>
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium font-mono uppercase ${
          status === 'working' ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800' :
          status === 'blocked' ? 'bg-rose-950/60 text-rose-400 border border-rose-800' :
          'bg-amber-950/60 text-amber-400 border border-amber-800'
        }`}>
          {status}
        </span>
      </div>

      <div className="mt-3 w-full bg-[#141419] rounded-full h-1.5 overflow-hidden">
        <div
          className="bg-[#4ecdc4] h-full transition-all duration-300 rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
};
```

#### B. Vanilla CSS / Pixel Art UI (Munder Difflin / Retro Theme)

```tsx
export function PixelAgentBadge({ name, role, status }: { name: string; role: string; status: string }) {
  // Enforce strict truncation to protect the pixel grid
  const shortName = name.length > 10 ? name.slice(0, 9) + '…' : name;

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '2px 6px',
      background: 'var(--cth-paper-100, #f7f2ea)',
      border: '1px solid var(--cth-ink-900, #181411)',
      boxShadow: '1px 1px 0 var(--cth-ink-900, #181411)',
      fontFamily: 'monospace',
      fontSize: 11,
      lineHeight: '14px',
      color: 'var(--cth-ink-900, #181411)'
    }}>
      <span style={{ fontWeight: 700 }}>{shortName}</span>
      <span style={{ color: 'var(--cth-ink-500, #888)' }}>·</span>
      <span style={{
        padding: '0 4px',
        borderRadius: 2,
        background: status === 'working' ? '#d0f0e0' : '#f6e2b3',
        color: '#181411',
        fontSize: 10,
        fontWeight: 600
      }}>
        {status}
      </span>
    </div>
  );
}
```

---

### Step 4: Visual Diff & Parity Verification

Always compare the generated output against the original image using `replica-diff`:

```bash
# Compare generated screen with reference mockup
python3 .agents/skills/replica-diff/imgdiff.py replica/screens/reference.png replica/clone-screens/current.png --out replica/diffs/result.png
```

Check:
1. **No Text Overflow:** Strings must truncate gracefully (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`).
2. **No Misplaced Floating Elements:** Elements anchored at `(0, 0)` or outside boundaries indicate uninitialized coordinates or missing container layout.
3. **No Contrast Violations:** Verify foreground and background meet WCAG AA (minimum 4.5:1 for normal text).
