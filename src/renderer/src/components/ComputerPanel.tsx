import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore, selectedAgent } from '@/store/store';
import { useRtl } from '@/i18n/useDirection';
import type { ComputerRecord, ComputerStatus, TerminalInfo, BrowserStatusInfo, WorkspaceInfo } from '@shared/computer';

/** AI Company OS (Phase 4) — the selected agent's Computer over the LIVE runtime.
 *  Every value shown is a main-process answer: record/status from the SQLite
 *  computers table, terminal facts from PtyManager, browser facts from the
 *  Electron window adapter, screenshot bytes from a real capturePage. Controls
 *  call `computer:*` IPC and render the returned error/code verbatim — nothing
 *  is simulated, invented, or decorative. */

type LiveInfo = {
  status: ComputerStatus;
  since: number;
  lastError: string | null;
  watching: boolean;
  controlActive: boolean;
};
type OpRes = { ok: boolean; error?: string; code?: string };
type FeedEntry = { ts: number; event?: string; reason?: string };

const POLL_MS = 4000;

const STATUS_COLOR: Record<string, string> = {
  OFFLINE: 'var(--cth-ink-300)',
  STARTING: 'var(--cth-peach)',
  READY: 'var(--cth-mint)',
  WORKING: 'var(--cth-sky)',
  WAITING: 'var(--cth-lemon)',
  PAUSED: 'var(--cth-coral)',
  USER_CONTROL: 'var(--cth-coral)',
  STOPPING: 'var(--cth-peach)',
  SLEEPING: 'var(--cth-cream-200)',
  ERROR: 'var(--cth-coral)'
};
const DARK_CHIP = new Set(['PAUSED', 'USER_CONTROL', 'ERROR']);

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};
const metaRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontFamily: 'var(--cth-font-mono)',
  fontSize: 11, color: 'var(--cth-ink-700)'
};
const mono: React.CSSProperties = { fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' };
const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
  background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  border: 'none', padding: '5px 7px', width: '100%'
};

function errText(res: OpRes): string {
  return res.error ? (res.code ? `${res.error} [${res.code}]` : res.error) : 'failed';
}

function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  const color = STATUS_COLOR[status] ?? 'var(--cth-cream-200)';
  return (
    <span style={{
      fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0,
      color: DARK_CHIP.has(status) ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
      background: color, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {t(`computerTab.states.${status}`, status)}
    </span>
  );
}

function Toggle({
  label, value, busy, onToggle
}: { label: string; value: boolean; busy?: boolean; onToggle: () => void }) {
  return (
    <PixelButton size="sm" variant={value ? 'primary' : 'secondary'} disabled={busy} onClick={onToggle}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name={value ? 'check' : 'x'} /> {label}
      </span>
    </PixelButton>
  );
}

export function ComputerPanel() {
  const { t } = useTranslation();
  const rtl = useRtl();
  const agent = useStore((s) => selectedAgent(s));
  const agentId = agent?.id ?? null;

  const [rec, setRec] = useState<ComputerRecord | null | undefined>(undefined);
  const [live, setLive] = useState<LiveInfo | null>(null);
  const [term, setTerm] = useState<TerminalInfo | null>(null);
  const [bstat, setBstat] = useState<BrowserStatusInfo | null>(null);
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [statusReason, setStatusReason] = useState<string | null>(null);
  const [shot, setShot] = useState<{ pngBase64: string; bytes: number; capturedAt: number; url?: string; title?: string } | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [showDispose, setShowDispose] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!agentId) { setRec(undefined); setLive(null); setTerm(null); setBstat(null); setWs(null); return; }
    try {
      const got = await window.cth.computerGetForAgent(agentId);
      if (!got.ok) {
        if (got.code === 'NOT_FOUND') { setRec(null); setLoadError(null); }
        else setLoadError(errText(got));
        return;
      }
      setRec(got.value);
      setLoadError(null);
      const id = got.value.id;
      const [s, tm, b, w] = await Promise.all([
        window.cth.computerGetStatus(id),
        window.cth.computerTerminalInfo(id),
        window.cth.computerBrowserStatus(id),
        window.cth.computerWorkspaceInfo(id)
      ]);
      if (s.ok) { setLive(s.value.live); setStatusReason(null); }
      else setLive(null);
      setTerm(tm.ok ? tm.value : null);
      setBstat(b.ok ? b.value : null);
      setWs(w.ok ? w.value : null);
    } catch {
      setLoadError('computer state unavailable (main not ready)');
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const offUpdated = window.cth.onComputerUpdated((e) => {
      setStatusReason(e.reason ?? null);
      if (!agentId || e.agentId === agentId) void refresh();
    });
    const offEvents = window.cth.onComputerEvent((e) => {
      if (!agentId || e.agentId !== agentId) return;
      setFeed((f) => [{ ts: e.ts ?? Date.now(), event: e.event, reason: undefined }, ...f].slice(0, 12));
    });
    return () => { clearInterval(timer); offUpdated(); offEvents(); };
  }, [refresh, agentId]);

  useEffect(() => { setShowDispose(false); setShot(null); setFeed([]); setStatusReason(null); }, [agentId]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 6000);
  }, []);

  const run = useCallback(async (key: string, action: () => Promise<OpRes>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await action();
      flash(res.ok ? t('computerTab.ok') : errText(res));
      await refresh();
      return res;
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
      return { ok: false };
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }, [flash, refresh, t]);

  if (!agentId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px' }}>
        <div style={{ ...card, fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
          {t('computerTab.noAgent')}
        </div>
      </div>
    );
  }

  if (loadError && rec === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px' }}>
        <div style={{ ...card, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
          {loadError}
        </div>
        <PixelButton onClick={() => void refresh()}>{t('computerTab.retry')}</PixelButton>
      </div>
    );
  }

  if (rec === undefined) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)'
      }}>
        {t('computerTab.loading')}
      </div>
    );
  }

  if (rec === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px' }}>
        <div style={card}>
          <span style={sectionHead}>{t('computerTab.title')}</span>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
            {t('computerTab.none')}
          </span>
          <PixelButton
            disabled={!!busy.create}
            onClick={() => {
              setBusy((b) => ({ ...b, create: true }));
              void window.cth.computerEnsureForAgent(agentId)
                .then((res) => { flash(res.ok ? t('computerTab.ok') : errText(res)); return refresh(); })
                .catch((e) => flash(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy((b) => ({ ...b, create: false })));
            }}
          >
            {busy.create ? t('computerTab.creating') : t('computerTab.create')}
          </PixelButton>
        </div>
        {notice && <div style={{ ...card, fontFamily: 'var(--cth-font-mono)', fontSize: 11 }}>{notice}</div>}
      </div>
    );
  }

  const status = live?.status ?? rec.status;
  const running = ['STARTING', 'READY', 'WORKING', 'WAITING', 'PAUSED', 'USER_CONTROL'].includes(status);
  const canStart = ['OFFLINE', 'ERROR', 'SLEEPING'].includes(status);
  const canStop = status !== 'OFFLINE' && status !== 'STOPPING';
  const canPause = ['READY', 'WORKING', 'WAITING'].includes(status);
  const canResume = status === 'PAUSED';
  const lastStart = rec.lastStartedAt ? new Date(rec.lastStartedAt).toLocaleString() : '—';

  const act = (key: string, fn: () => Promise<OpRes>) => () => void run(key, fn);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px 16px', overflow: 'auto' }}>
      {loadError && (
        <div style={{ ...card, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
          {loadError}
        </div>
      )}
      {notice && (
        <div style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
          padding: '5px 8px', background: 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}>{notice}</div>
      )}

      {/* ── identity + live status ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={sectionHead}>{t('computerTab.title')}</span>
          <StatusChip status={status} />
        </div>
        <div style={metaRow}>
          <span>id: {rec.id}</span>
          <span>{t('computerTab.agent')}: {rec.agentId}</span>
          <span>{t('computerTab.since')}: {live ? new Date(live.since).toLocaleTimeString() : '—'}</span>
          <span>{t('computerTab.lastStarted')}: {lastStart}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {live?.watching && (
            <span style={{ ...mono, background: 'var(--cth-sky)', padding: '1px 6px', color: 'var(--cth-ink-900)' }}>
              {t('computerTab.watching')}
            </span>
          )}
          {live?.controlActive && (
            <span style={{ ...mono, background: 'var(--cth-coral)', padding: '1px 6px', color: 'var(--cth-paper-100)' }}>
              {t('computerTab.controlActive')}
            </span>
          )}
          <span style={mono}>{t('computerTab.runtime')}: {rec.runtimeType}</span>
        </div>
        {(live?.lastError || statusReason) && (
          <div style={{ ...mono, color: 'var(--cth-coral)' }}>
            {live?.lastError ?? statusReason}
          </div>
        )}
      </div>

      {/* ── workspace ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <span style={sectionHead}>{t('computerTab.workspace')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ ...mono, flex: 1, wordBreak: 'break-all' }}>{rec.workspaceRoot}</span>
          <PixelButton
            size="sm" variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(rec.workspaceRoot).then(() => {
                setCopied(true); setTimeout(() => setCopied(false), 1500);
              }).catch(() => { /* clipboard denied — path stays visible */ });
            }}
          >
            {copied ? t('computerTab.copied') : t('computerTab.copy')}
          </PixelButton>
        </div>
        <div style={metaRow}>
          <span>workspaceId: {rec.workspaceId}</span>
          {ws && <span>{t('computerTab.exists')}: {ws.exists ? '✓' : '✗'}</span>}
          {ws?.fileCount !== undefined && <span>{t('computerTab.files')}: {ws.fileCount}</span>}
        </div>
      </div>

      {/* ── terminal (real pty facts) ──────────────────────────────────────── */}
      <div style={card}>
        <span style={sectionHead}>{t('computerTab.terminal')}</span>
        {!term || !term.ptyId ? (
          <span style={mono}>{t('computerTab.noPty')}</span>
        ) : (
          <div style={metaRow}>
            <span>pty: {term.ptyId}</span>
            <span>{t('computerTab.running')}: {term.running ? '✓' : '✗'}</span>
            {term.pid !== undefined && <span>pid: {term.pid}</span>}
            {term.cwd && <span style={{ wordBreak: 'break-all' }}>cwd: {term.cwd}</span>}
            {term.lastOutputAt !== undefined && (
              <span>{t('computerTab.lastOutput')}: {new Date(term.lastOutputAt).toLocaleTimeString()}</span>
            )}
          </div>
        )}
      </div>

      {/* ── browser (real window facts + real capture) ─────────────────────── */}
      <div style={card}>
        <span style={sectionHead}>{t('computerTab.browser')}</span>
        <div style={metaRow}>
          <span>{t('computerTab.state')}: {bstat?.open ? t('computerTab.browserOpen') : t('computerTab.browserClosed')}</span>
          {bstat?.url && <span style={{ wordBreak: 'break-all' }}>{bstat.url}</span>}
          {bstat?.title && <span>{bstat.title}</span>}
          {bstat?.profileId && <span>profile: {bstat.profileId}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <PixelButton size="sm" disabled={!!busy.open} onClick={act('open', () => window.cth.computerOpenBrowser(rec.id))}>
            {t('computerTab.openBrowser')}
          </PixelButton>
          <input
            dir={rtl ? 'auto' : undefined}
            style={{ ...inputStyle, width: 220, flex: 1, minWidth: 160 }}
            placeholder={t('computerTab.urlPlaceholder')}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
          />
          <PixelButton
            size="sm" variant="secondary" disabled={!!busy.nav || !urlInput.trim()}
            onClick={act('nav', () => window.cth.computerNavigate(rec.id, urlInput.trim()))}
          >
            {t('computerTab.navigate')}
          </PixelButton>
          <PixelButton size="sm" variant="secondary" disabled={!!busy.cap} onClick={() => {
            setBusy((b) => ({ ...b, cap: true }));
            void window.cth.computerCaptureScreen(rec.id)
              .then((res) => {
                if (res.ok) { setShot(res.value); flash(t('computerTab.ok')); }
                else { setShot(null); flash(errText(res)); }
              })
              .catch((e) => flash(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy((b) => ({ ...b, cap: false })));
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="image" /> {t('computerTab.capture')}
            </span>
          </PixelButton>
        </div>
        {shot && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <img
              src={`data:image/png;base64,${shot.pngBase64}`}
              alt={t('computerTab.shotAlt')}
              style={{ maxWidth: '100%', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}
            />
            <span style={mono}>
              {shot.bytes} B · {new Date(shot.capturedAt).toLocaleTimeString()}
              {shot.url ? ` · ${shot.url}` : ''} {shot.title ? `· ${shot.title}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* ── permissions (real persisted values; changed only through main) ─── */}
      <div style={card}>
        <span style={sectionHead}>{t('computerTab.permissions')}</span>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
          {t('computerTab.permissionsHint')}
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['terminalExec', 'browserNav', 'browserDownloads'] as const).map((k) => (
            <Toggle
              key={k} label={k} value={!!rec.permissions.agent[k]} busy={!!busy[`p:${k}`]}
              onToggle={() => void run(`p:${k}`, () =>
                window.cth.computerPermissions({ id: rec.id, permissions: { agent: { [k]: !rec.permissions.agent[k] } } }))}
            />
          ))}
          {(['screenView', 'screenControl'] as const).map((k) => (
            <Toggle
              key={k} label={k} value={!!rec.permissions.user[k]} busy={!!busy[`p:${k}`]}
              onToggle={() => void run(`p:${k}`, () =>
                window.cth.computerPermissions({ id: rec.id, permissions: { user: { [k]: !rec.permissions.user[k] } } }))}
            />
          ))}
        </div>
        <div style={metaRow}>
          <span>crossAgentRead: [{rec.permissions.agent.crossAgentRead.join(', ') || '—'}]</span>
          <span>crossAgentWrite: [{rec.permissions.agent.crossAgentWrite.join(', ') || '—'}]</span>
          <span>persistence: {rec.persistencePolicy}</span>
        </div>
      </div>

      {/* ── lifecycle controls (every click = a real main op) ──────────────── */}
      <div style={card}>
        <span style={sectionHead}>{t('computerTab.controls')}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <PixelButton size="sm" disabled={!canStart || !!busy.start} onClick={act('start', () => window.cth.computerStart(rec.id))}>
            {t('computerTab.start')}
          </PixelButton>
          <PixelButton size="sm" variant="secondary" disabled={!canStop || !!busy.stop} onClick={act('stop', () => window.cth.computerStop(rec.id))}>
            {t('computerTab.stop')}
          </PixelButton>
          <PixelButton size="sm" variant="secondary" disabled={!canPause || !!busy.pause} onClick={act('pause', () => window.cth.computerPause(rec.id))}>
            {t('computerTab.pause')}
          </PixelButton>
          <PixelButton size="sm" variant="secondary" disabled={!canResume || !!busy.resume} onClick={act('resume', () => window.cth.computerResume(rec.id))}>
            {t('computerTab.resume')}
          </PixelButton>
          <PixelButton size="sm" variant="secondary" disabled={!running || !!busy.restart} onClick={act('restart', () => window.cth.computerRestart(rec.id))}>
            {t('computerTab.restart')}
          </PixelButton>
          <PixelButton
            size="sm" variant={live?.watching ? 'primary' : 'secondary'} disabled={!!busy.watch}
            onClick={act('watch', () => window.cth.computerWatch(rec.id, !live?.watching))}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name={live?.watching ? 'check' : 'info'} /> {live?.watching ? t('computerTab.unwatch') : t('computerTab.watch')}
            </span>
          </PixelButton>
          <PixelButton
            size="sm" variant={live?.controlActive ? 'destructive' : 'secondary'} disabled={!!busy.control}
            onClick={act('control', () => live?.controlActive
              ? window.cth.computerReleaseControl(rec.id)
              : window.cth.computerTakeControl(rec.id))}
          >
            {live?.controlActive ? t('computerTab.releaseControl') : t('computerTab.takeControl')}
          </PixelButton>
        </div>
      </div>

      {/* ── dispose (destructive: explicit confirm, main requires it too) ──── */}
      <div style={card}>
        <span style={sectionHead}>{t('computerTab.disposeTitle')}</span>
        {!showDispose ? (
          <div>
            <PixelButton size="sm" variant="destructive" onClick={() => setShowDispose(true)}>
              {t('computerTab.dispose')}
            </PixelButton>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)' }}>
              {t('computerTab.disposeConfirm', { policy: rec.persistencePolicy })}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <PixelButton size="sm" variant="destructive" disabled={!!busy.dispose} onClick={act('dispose', () => window.cth.computerDispose(rec.id, true))}>
                {t('computerTab.confirm')}
              </PixelButton>
              <PixelButton size="sm" variant="secondary" onClick={() => setShowDispose(false)}>
                {t('computerTab.cancel')}
              </PixelButton>
            </div>
          </div>
        )}
      </div>

      {/* ── recent real events for this computer (push-fed ring) ───────────── */}
      {feed.length > 0 && (
        <div style={card}>
          <span style={sectionHead}>{t('computerTab.feed')}</span>
          {feed.map((e, i) => (
            <span key={`${e.ts}-${i}`} style={mono}>
              {new Date(e.ts).toLocaleTimeString()} · {e.event ?? '—'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
