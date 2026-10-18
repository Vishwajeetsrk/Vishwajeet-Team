import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { useRtl } from '@/i18n/useDirection';

/** AI Company OS (Phase 6) — the Security tab: emergency flags, auto-approve
 *  posture, policy overrides, the approval desk, the audit tail, and per-
 *  integration secret revocation. Every value shown is a main-process answer
 *  over the `security:*`/`policy:*`/`approvals:*`/`audit:*` IPC surface —
 *  nothing here is simulated or held in local fake state. Decisions are
 *  user-pinned main-side: this component never names an actor, never approves
 *  its own request, and never writes policy from an agent-writable path. */

type Emergency = { stopped: boolean; paused: boolean; externalDisabled: boolean };
type SecurityState = {
  ok: boolean;
  emergency: Emergency;
  autoApproveInternal: boolean;
  overrides: Record<string, string>;
  pendingApprovals: number;
};
type ApprovalItemView = {
  id: string;
  kind: string;
  domain: string;
  action: string;
  actor: string;
  target?: string;
  detail: string;
  ruleId: string;
  createdAt: string;
  status: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Held webhook/org message — surfaced read-only (decided via Triggers). */
  readOnly?: boolean;
};
type AuditEventView = {
  at?: string;
  kind?: string;
  actor?: string;
  domain?: string;
  action?: string;
  decision?: string;
  ruleId?: string;
  approvalId?: string;
  detail?: string;
};
type IntegrationView = { id: string; name: string; kind?: string; enabled?: boolean; hasSecret: boolean };

const ERR_BG = 'var(--cth-coral)';
const OK_BG = 'var(--cth-mint)';
const WARN_BG = 'var(--cth-lemon)';

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};
const mono: React.CSSProperties = { fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' };
const caption: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', lineHeight: '15px'
};
const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
  background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  border: 'none', padding: '5px 7px'
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'
};

function Chip({ label, bg, dark }: { label: string; bg: string; dark?: boolean }) {
  return (
    <span style={{
      fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0,
      color: dark ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
      background: bg, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>{label}</span>
  );
}

function errBox(error: string | null): React.ReactNode {
  if (!error) return null;
  return <div style={{ ...card, background: ERR_BG, gap: 2 }}>{error}</div>;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function SecurityPanel() {
  const { t } = useTranslation();
  const isRtl = useRtl();

  const [state, setState] = useState<SecurityState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [pending, setPending] = useState<ApprovalItemView[]>([]);
  const [decided, setDecided] = useState<ApprovalItemView[]>([]);
  const [showDecided, setShowDecided] = useState(false);
  const [audit, setAudit] = useState<AuditEventView[]>([]);
  const [auditKind, setAuditKind] = useState<string>('');
  const [integrations, setIntegrations] = useState<IntegrationView[]>([]);
  const [confirmFlag, setConfirmFlag] = useState<string | null>(null);
  const [pc, setPc] = useState<{ enabled: boolean; armed: boolean; remainingMs: number } | null>(null);
  const [adding, setAdding] = useState<{ domain: string; action: string; value: string }>({
    domain: 'hive-tool', action: '', value: 'require-approval'
  });

  const refreshTimer = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    try {
      const s = await window.cth.securityState();
      if (s.ok) {
        setState(s);
        setError(null);
      } else setError(t('securityTab.stateFailed'));
      const p = await window.cth.approvalsList('pending');
      if (p.ok && p.items) setPending(p.items);
      if (showDecided) {
        const [a, d] = await Promise.all([
          window.cth.approvalsList('approved'),
          window.cth.approvalsList('denied')
        ]);
        setDecided([...(a.items ?? []), ...(d.items ?? [])].slice(-20).reverse());
      }
      const au = await window.cth.auditList({ kind: auditKind || undefined, limit: 50 });
      if (au.ok && au.events) setAudit(au.events as AuditEventView[]);
      const ints = await window.cth.integrationsList();
      setIntegrations(ints.map((r) => ({
        id: r.id, name: r.label, hasSecret: r.hasSecret,
        ...(typeof r.enabled === 'boolean' ? { enabled: r.enabled } : {})
      })));
      const pcState = await window.cth.pcControlState();
      if (pcState.ok) setPc({ enabled: pcState.enabled, armed: pcState.armed, remainingMs: pcState.remainingMs });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [auditKind, showDecided, t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    // Guard: scripted test bridges and older preloads may not expose this.
    if (typeof window.cth.onSecurityUpdated !== 'function') return;
    const off = window.cth.onSecurityUpdated(() => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => { void refresh(); }, 300);
    });
    return () => {
      off();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  const toggleFlag = async (flag: 'stopped' | 'paused' | 'externalDisabled', on: boolean) => {
    setFlash(null);
    const r = await window.cth.securityEmergency({ [flag]: on });
    if (r.ok && r.emergency) {
      setState((s) => (s ? { ...s, emergency: r.emergency! } : s));
      setFlash(t(on ? 'securityTab.flagOn' : 'securityTab.flagOff', { flag: t(`securityTab.flag.${flag}`) }));
      setConfirmFlag(null);
    } else setError(r.error ?? t('securityTab.stateFailed'));
    void refresh();
  };

  const toggleAutoApprove = async (on: boolean) => {
    const r = await window.cth.securityAutoApproveInternal(on);
    if (r.ok) setFlash(t(on ? 'securityTab.autoOn' : 'securityTab.autoOff'));
    else setError(r.error ?? t('securityTab.stateFailed'));
    void refresh();
  };

  // PRD-1 — own-PC control: enable/arm/disarm all round-trip through the
  // user-pinned main handlers; arming also pops the on-screen indicator
  // (kill-switch lives on it), and disabling disarms any live session.
  const setPcEnabled = async (on: boolean) => {
    const r = await window.cth.pcControlSetEnabled(on);
    if (!r.ok) setError(r.error ?? t('securityTab.stateFailed'));
    else setFlash(t(on ? 'securityTab.pcEnabled' : 'securityTab.pcDisabled'));
    void refresh();
  };
  const armPc = async () => {
    const r = await window.cth.pcControlArm();
    if (!r.ok) setError(r.error ?? t('securityTab.stateFailed'));
    void refresh();
  };
  const disarmPc = async () => {
    await window.cth.pcControlDisarm();
    void refresh();
  };

  const decideApproval = async (id: string, approve: boolean) => {
    const r = approve ? await window.cth.approvalsApprove(id) : await window.cth.approvalsDeny(id);
    if (!r.ok) setError((r as { error?: string }).error ?? t('securityTab.stateFailed'));
    else setFlash(t(approve ? 'securityTab.approvedFlash' : 'securityTab.deniedFlash'));
    void refresh();
  };

  const setOverride = async (key: string, value: 'allow' | 'require-approval' | 'deny' | null) => {
    const r = await window.cth.policySet(key, value);
    if (!r.ok) setError(r.error ?? t('securityTab.stateFailed'));
    else setFlash(t(value === null ? 'securityTab.overrideCleared' : 'securityTab.overrideSet', { key }));
    void refresh();
  };

  const addOverride = async () => {
    const action = adding.action.trim();
    if (!action) { setError(t('securityTab.actionRequired')); return; }
    await setOverride(`${adding.domain}:${action}`, adding.value as 'allow' | 'require-approval' | 'deny');
    setAdding({ ...adding, action: '' });
  };

  const revokeSecret = async (id: string) => {
    const r = await window.cth.integrationsRevokeSecret(id);
    if (!r.ok) setError(r.error ?? t('securityTab.stateFailed'));
    else setFlash(t('securityTab.secretRevoked', { id }));
    setConfirmFlag(null);
    void refresh();
  };

  if (loading) return <div style={{ ...card }}><span style={mono}>{t('securityTab.loading')}</span></div>;

  const e = state?.emergency ?? { stopped: false, paused: false, externalDisabled: false };

  const flagRow = (flag: 'stopped' | 'paused' | 'externalDisabled') => {
    const on = e[flag];
    const confirming = confirmFlag === flag;
    return (
      <div key={flag} style={rowStyle}>
        <Chip label={on ? t('securityTab.on') : t('securityTab.off')} bg={on ? ERR_BG : OK_BG} dark={on} />
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', flex: 1 }}>
          {t(`securityTab.flag.${flag}`)}
        </span>
        {on ? (
          <PixelButton size="sm" variant="secondary" onClick={() => void toggleFlag(flag, false)}>
            {t('securityTab.clear')}
          </PixelButton>
        ) : confirming ? (
          <>
            <PixelButton size="sm" variant="destructive" onClick={() => void toggleFlag(flag, true)}>
              {t('securityTab.confirmOn')}
            </PixelButton>
            <PixelButton size="sm" variant="ghost" onClick={() => setConfirmFlag(null)}>{t('securityTab.cancel')}</PixelButton>
          </>
        ) : (
          <PixelButton size="sm" variant="destructive" onClick={() => setConfirmFlag(flag)}>
            {t('securityTab.arm')}
          </PixelButton>
        )}
        <span style={caption}>{t(`securityTab.flagHint.${flag}`)}</span>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, direction: isRtl ? 'rtl' : 'ltr' }}>
      {errBox(error)}
      {flash && <div style={{ ...card, background: OK_BG, gap: 2 }}><span style={caption}>{flash}</span></div>}

      {/* ─── Emergency ─── */}
      <section style={card}>
        <div style={sectionHead}>{t('securityTab.emergencyTitle')}</div>
        {flagRow('stopped')}
        {flagRow('paused')}
        {flagRow('externalDisabled')}
        <span style={caption}>{t('securityTab.emergencyFootnote')}</span>
      </section>

      {/* ─── Auto-approve posture ─── */}
      <section style={card}>
        <div style={sectionHead}>{t('securityTab.autoTitle')}</div>
        <div style={rowStyle}>
          <Chip label={state?.autoApproveInternal ? t('securityTab.on') : t('securityTab.off')}
            bg={state?.autoApproveInternal ? WARN_BG : OK_BG} dark={false} />
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', flex: 1 }}>
            {t('securityTab.autoLabel')}
          </span>
          <PixelButton size="sm" variant={state?.autoApproveInternal ? 'secondary' : 'primary'}
            onClick={() => void toggleAutoApprove(!state?.autoApproveInternal)}>
            {state?.autoApproveInternal ? t('securityTab.disable') : t('securityTab.enable')}
          </PixelButton>
        </div>
        <span style={caption}>{t('securityTab.autoHint')}</span>
      </section>

      {/* ─── PRD-1: own-PC control ─── */}
      <section style={card}>
        <div style={sectionHead}>{t('securityTab.pcTitle')}</div>
        <div style={rowStyle}>
          <Chip label={pc?.enabled ? t('securityTab.on') : t('securityTab.off')}
            bg={pc?.enabled ? WARN_BG : OK_BG} dark={false} />
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', flex: 1 }}>
            {t('securityTab.pcLabel')}
          </span>
          {pc?.armed ? (
            <>
              <Chip label={t('securityTab.pcArmed')} bg={ERR_BG} dark />
              <PixelButton size="sm" variant="destructive" onClick={() => void disarmPc()}>
                {t('securityTab.pcDisarm')}
              </PixelButton>
            </>
          ) : (
            <PixelButton size="sm" variant={pc?.enabled ? 'primary' : 'secondary'}
              disabled={!pc?.enabled}
              onClick={() => void (pc?.enabled ? armPc() : setPcEnabled(true))}>
              {pc?.enabled ? t('securityTab.pcArm') : t('securityTab.pcEnable')}
            </PixelButton>
          )}
        </div>
        {pc?.armed && (
          <span style={caption}>
            {t('securityTab.pcRemaining', { seconds: Math.ceil(pc.remainingMs / 1000) })}
          </span>
        )}
        <span style={caption}>{t('securityTab.pcHint')}</span>
      </section>

      {/* ─── Policy overrides ─── */}
      <section style={card}>
        <div style={sectionHead}>{t('securityTab.overridesTitle')}</div>
        {Object.keys(state?.overrides ?? {}).length === 0 ? (
          <span style={mono}>{t('securityTab.overridesEmpty')}</span>
        ) : (
          Object.entries(state?.overrides ?? {}).map(([key, value]) => (
            <div key={key} style={rowStyle}>
              <Chip label={value} bg={value === 'deny' ? ERR_BG : value === 'allow' ? OK_BG : WARN_BG} />
              <span style={mono}>{key}</span>
              <PixelButton size="sm" variant="ghost" onClick={() => void setOverride(key, null)}>
                {t('securityTab.clear')}
              </PixelButton>
            </div>
          ))
        )}
        <div style={rowStyle}>
          <select style={inputStyle} value={adding.domain}
            onChange={(ev) => setAdding({ ...adding, domain: ev.target.value })}>
            <option value="hive-tool">hive-tool</option>
            <option value="computer-op">computer-op</option>
            <option value="integration-outbound">integration-outbound</option>
            <option value="memory-write">memory-write</option>
            <option value="system">system</option>
          </select>
          <input style={{ ...inputStyle, flex: 1, minWidth: 90 }} placeholder={t('securityTab.actionPh')}
            value={adding.action} onChange={(ev) => setAdding({ ...adding, action: ev.target.value })} />
          <select style={inputStyle} value={adding.value}
            onChange={(ev) => setAdding({ ...adding, value: ev.target.value })}>
            <option value="allow">allow</option>
            <option value="require-approval">require-approval</option>
            <option value="deny">deny</option>
          </select>
          <PixelButton size="sm" onClick={() => void addOverride()}>{t('securityTab.add')}</PixelButton>
        </div>
        <span style={caption}>{t('securityTab.overridesHint')}</span>
      </section>

      {/* ─── Approval desk ─── */}
      <section style={card}>
        <div style={sectionHead}>
          {t('securityTab.deskTitle')} ({pending.length})
        </div>
        {pending.length === 0 ? (
          <span style={mono}>{t('securityTab.deskEmpty')}</span>
        ) : (
          pending.map((item) => (
            <div key={item.id} style={{ ...card, background: 'var(--cth-cream-100)', gap: 4 }}>
              <div style={rowStyle}>
                <Chip label={item.domain} bg="var(--cth-sky)" />
                <span style={mono}>{item.action}</span>
                <span style={mono}>{t('securityTab.by', { actor: item.actor })}</span>
                <span style={mono}>{fmtAge(item.createdAt)}</span>
              </div>
              <span style={caption}>{item.detail}</span>
              <div style={rowStyle}>
                {item.readOnly ? (
                  <>
                    <Chip label={t('securityTab.heldChip')} bg="var(--cth-lilac)" />
                    <span style={caption}>{t('securityTab.heldNote')}</span>
                  </>
                ) : (
                  <>
                    <PixelButton size="sm" onClick={() => void decideApproval(item.id, true)}>{t('securityTab.approve')}</PixelButton>
                    <PixelButton size="sm" variant="destructive" onClick={() => void decideApproval(item.id, false)}>{t('securityTab.deny')}</PixelButton>
                    <span style={mono}>{item.id}</span>
                  </>
                )}
              </div>
            </div>
          ))
        )}
        <div style={rowStyle}>
          <PixelButton size="sm" variant="ghost" onClick={() => setShowDecided((v) => !v)}>
            {showDecided ? t('securityTab.hideDecided') : t('securityTab.showDecided')}
          </PixelButton>
        </div>
        {showDecided && decided.map((item) => (
          <div key={item.id} style={rowStyle}>
            <Chip label={item.status} bg={item.status === 'approved' ? OK_BG : ERR_BG} dark={item.status === 'denied'} />
            <span style={mono}>{item.domain}:{item.action}</span>
            <span style={mono}>{item.decidedBy ?? ''}</span>
          </div>
        ))}
        <span style={caption}>{t('securityTab.deskHint')}</span>
      </section>

      {/* ─── Audit tail ─── */}
      <section style={card}>
        <div style={sectionHead}>{t('securityTab.auditTitle')}</div>
        <div style={rowStyle}>
          <select style={inputStyle} value={auditKind} onChange={(ev) => setAuditKind(ev.target.value)}>
            <option value="">{t('securityTab.allKinds')}</option>
            <option value="policy-decision">policy-decision</option>
            <option value="approval-decided">approval-decided</option>
            <option value="emergency-changed">emergency-changed</option>
            <option value="override-changed">override-changed</option>
            <option value="secret-revoked">secret-revoked</option>
            <option value="memory-write">memory-write</option>
          </select>
          <PixelButton size="sm" variant="ghost" onClick={() => void refresh()}>{t('securityTab.refresh')}</PixelButton>
        </div>
        {audit.length === 0 ? (
          <span style={mono}>{t('securityTab.auditEmpty')}</span>
        ) : (
          audit.map((evt, i) => (
            <div key={`${evt.at ?? ''}-${i}`} style={rowStyle}>
              <span style={mono}>{evt.at ? new Date(evt.at).toLocaleTimeString() : ''}</span>
              <Chip label={evt.kind ?? ''} bg="var(--cth-lilac)" />
              <span style={mono}>{evt.actor ?? ''}</span>
              <span style={mono}>{evt.domain ?? ''}{evt.action ? `:${evt.action}` : ''}</span>
              <Chip label={evt.decision ?? ''} bg={evt.decision === 'deny' || evt.decision === 'denied' ? ERR_BG : evt.decision === 'allow' || evt.decision === 'approved' ? OK_BG : WARN_BG} />
              {evt.ruleId && <span style={mono}>{evt.ruleId}</span>}
              {evt.approvalId && <span style={mono}>{evt.approvalId}</span>}
            </div>
          ))
        )}
        <span style={caption}>{t('securityTab.auditHint')}</span>
      </section>

      {/* ─── Integration secrets ─── */}
      <section style={card}>
        <div style={sectionHead}>{t('securityTab.secretsTitle')}</div>
        {integrations.filter((r) => r.hasSecret).length === 0 ? (
          <span style={mono}>{t('securityTab.secretsEmpty')}</span>
        ) : (
          integrations.filter((r) => r.hasSecret).map((r) => (
            <div key={r.id} style={rowStyle}>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', flex: 1 }}>{r.name || r.id}</span>
              <Chip label={r.enabled === false ? t('securityTab.disabled') : t('securityTab.enabled')}
                bg={r.enabled === false ? 'var(--cth-ink-300)' : OK_BG} />
              {confirmFlag === `revoke:${r.id}` ? (
                <>
                  <PixelButton size="sm" variant="destructive" onClick={() => void revokeSecret(r.id)}>{t('securityTab.confirmRevoke')}</PixelButton>
                  <PixelButton size="sm" variant="ghost" onClick={() => setConfirmFlag(null)}>{t('securityTab.cancel')}</PixelButton>
                </>
              ) : (
                <PixelButton size="sm" variant="secondary" onClick={() => setConfirmFlag(`revoke:${r.id}`)}>
                  {t('securityTab.revoke')}
                </PixelButton>
              )}
            </div>
          ))
        )}
        <span style={caption}>{t('securityTab.secretsHint')}</span>
      </section>
    </div>
  );
}
