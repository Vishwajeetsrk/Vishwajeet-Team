import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useRtl } from '@/i18n/useDirection';

/** PRD-2 — inline approval cards. The desk used to be a separate tab only, so
 *  an agent's require-approval request sat invisible while the operator typed
 *  in the composer. These cards surface THIS agent's pending requests where the
 *  operator already is, deciding through the same `approvals:*` IPC the desk
 *  uses — same main-side user-pinned actor, same audit trail, no new surface.
 *  Read-only items (held webhook/org messages decided via Triggers) never get
 *  buttons here: they render in the desk's held state only. */
type ApprovalItemView = {
  id: string;
  domain: string;
  action: string;
  actor: string;
  detail: string;
  createdAt: string;
  status: string;
  readOnly?: boolean;
};

const MAX_INLINE = 3;

export function ApprovalCards({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [pending, setPending] = useState<ApprovalItemView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await window.cth.approvalsList('pending');
      if (r.ok && r.items) setPending(r.items as ApprovalItemView[]);
    } catch { /* main not ready — show nothing, never a false card */ }
  }, []);

  useEffect(() => {
    void refresh();
    // Guard: scripted test bridges and older preloads may not expose this —
    // a missing listener must never crash the always-mounted composer tree.
    if (typeof window.cth.onSecurityUpdated !== 'function') return;
    const off = window.cth.onSecurityUpdated(() => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { void refresh(); }, 300);
    });
    return () => {
      off();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [refresh]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    setError(null);
    try {
      const r = approve ? await window.cth.approvalsApprove(id) : await window.cth.approvalsDeny(id);
      if (!r.ok) setError((r as { error?: string }).error ?? t('approvalCards.failed'));
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const mine = pending.filter((i) => i.actor === agentId && !i.readOnly);
  const otherCount = pending.filter((i) => i.actor !== agentId && !i.readOnly).length;
  const shown = mine.slice(0, MAX_INLINE);

  // Nothing decidable here and nothing to link to → render nothing at all
  // (held read-only items live in Triggers, not this strip).
  if (mine.length === 0 && otherCount === 0) return null;

  return (
    <div
      dir={rtl ? 'auto' : undefined}
      style={{
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: '6px 8px',
        background: 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-lemon)'
      }}
      data-testid="approval-cards"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
          letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--cth-ink-700)'
        }}>{t('approvalCards.waiting')}</span>
        {otherCount > 0 && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('cth:cc-tab', { detail: { tab: 'security' } }))}
            title={t('approvalCards.openDeskTitle')}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
              color: 'var(--cth-ink-900)', textDecoration: 'underline'
            }}
          >{t('approvalCards.others', { count: otherCount })}</button>
        )}
      </div>

      {shown.map((item) => (
        <div
          key={item.id}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '5px 6px',
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}
        >
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{
              fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '15px',
              color: 'var(--cth-ink-900)',
              overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
            }}>{`${item.domain}:${item.action}`}</span>
            <span style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
              color: 'var(--cth-ink-700)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }}>{item.detail}</span>
          </div>
          <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0 }}>
            <PixelButton size="sm" onClick={() => void decide(item.id, true)} disabled={busy === item.id}>
              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <Icon name="check" /> {t('approvalCards.approve')}
              </span>
            </PixelButton>
            <PixelButton size="sm" variant="destructive" onClick={() => void decide(item.id, false)} disabled={busy === item.id}>
              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <Icon name="x" /> {t('approvalCards.deny')}
              </span>
            </PixelButton>
          </span>
        </div>
      ))}

      {mine.length > MAX_INLINE && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('cth:cc-tab', { detail: { tab: 'security' } }))}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
            alignSelf: 'flex-start',
            fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '15px',
            color: 'var(--cth-ink-900)', textDecoration: 'underline'
          }}
        >{t('approvalCards.more', { count: mine.length - MAX_INLINE })}</button>
      )}

      {error && (
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-coral)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
