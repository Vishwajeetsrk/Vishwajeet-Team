import type { CSSProperties } from 'react';

/**
 * SKELETON — pixel-theme loading placeholders for every IPC-backed panel.
 *
 * Data panels used to render their *empty* state while the first IPC round-trip
 * was still in flight (JobHistory flashed "Nothing has run yet", the kanban
 * showed bare dashes, MemoryPanel flashed the not-installed setup). A skeleton
 * is honest where an empty state lies: it says "loading", never "nothing here".
 * The shimmer is pure CSS (`.cth-skeleton`, global.css) and the existing
 * `prefers-reduced-motion` guard freezes it to static blocks automatically.
 */

const block = (width: string | number, height: number): CSSProperties => ({
  width, height, flexShrink: 0,
  background: 'var(--cth-cream-200)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
});

/** One shimmering bar. Width as % / px, height in px. */
export function Skeleton({ width = '100%', height = 12 }: {
  width?: string | number; height?: number;
}) {
  return <span aria-hidden className="cth-skeleton" style={block(width, height)} />;
}

/** A stack of bars with a trailing short line — paragraph-shaped content. */
export function SkeletonLines({ lines = 3, gap = 6 }: { lines?: number; gap?: number }) {
  return (
    <span aria-hidden style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="cth-skeleton"
          style={block(i === lines - 1 ? '55%' : '100%', 12)}
        />
      ))}
    </span>
  );
}

/** A SubCard-shaped placeholder: title row + two meta lines. */
export function SkeletonCard() {
  return (
    <div
      aria-hidden
      style={{
        marginBottom: 6, padding: '8px 10px 10px', display: 'flex',
        flexDirection: 'column', gap: 6,
        background: 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="cth-skeleton" style={block(52, 14)} />
        <span className="cth-skeleton" style={{ ...block('100%', 12), flex: 1 }} />
      </span>
      <span className="cth-skeleton" style={block('70%', 11)} />
    </div>
  );
}

/** N card placeholders — the standard "list is loading" state. */
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </>
  );
}
