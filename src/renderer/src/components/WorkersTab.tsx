import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { SkeletonLines } from './Skeleton';
import { useStore } from '@/store/store';
import { AGENT_PROVIDER_PRESETS } from '@shared/agentProvider';
import { TEAM_FILE_SPEC, serializeTeamFile, type TeamMemberSpec } from '@shared/teamFile';

/**
 * WORKERS — live god-triggered ephemeral Slack workers (the Phase-1 spawn loop):
 * fresh isolated worktree → does a job → replies in-thread → safe teardown. This
 * tab reads main's `liveWorkers` map (via workers:list) so a human can SEE what's
 * running and stop one by hand; it also surfaces worktrees PRESERVED at teardown
 * (held until their work integrates, then auto-GC'd) so nothing silently piles up.
 *
 * Plus operator-spawned TEMPS (the free Temps equivalent): the form below queues
 * a spawn-request through `workers:spawnTemp`, and the SAME watcher, dispatch,
 * done-release, reaping and safety-gated teardown run as for god/Slack hires.
 * One job, then gone — unintegrated work is preserved, never deleted.
 */

// Types flow from main's `workers:list` handler via the typed `window.cth` global
// (declared in preload/index.d.ts) — derived here so there's no cross-package import.
type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;
type WorkerSnapshot = WorkersData['live'][number];
type PreservedWorktreeSnapshot = WorkersData['preserved'][number];

const POLL_MS = 2000;

function relAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const metaRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontFamily: 'var(--cth-font-mono)',
  fontSize: 11, color: 'var(--cth-ink-700)'
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};

function StatusBadge({ w }: { w: WorkerSnapshot }) {
  const { t } = useTranslation();
  const releasing = w.status === 'releasing';
  return (
    <span style={{
      fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5,
      color: releasing ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
      background: releasing ? 'var(--cth-ink-700)' : 'var(--cth-green, #2f8f4e)',
      boxShadow: releasing ? 'none' : 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {releasing ? t('workersTab.stopping') : t('workersTab.working')}
    </span>
  );
}

export function WorkersTab() {
  const { t } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [data, setData] = useState<WorkersData | null>(null);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});

  // Temp-worker form: one job, then gone. Engine defaults to the first preset;
  // folder defaults server-side to the first registered repo.
  const [objective, setObjective] = useState('');
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [starting, setStarting] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [spawnedId, setSpawnedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.cth.listWorkers().then(setData).catch(() => { /* main not ready */ });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stop = useCallback((workerId: string) => {
    setStopping((s) => ({ ...s, [workerId]: true }));
    window.cth.stopWorker(workerId)
      .catch(() => { /* surfaced by the row vanishing or not */ })
      .finally(() => { refresh(); });
  }, [refresh]);

  const startTemp = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setSpawnError(null);
    setSpawnedId(null);
    try {
      const res = await window.cth.spawnTempWorker({
        objective: objective.trim(),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(provider ? { provider } : {})
      });
      if (res.ok) {
        setObjective(''); setName('');
        setSpawnedId(res.reqId ?? 'queued');
      } else {
        setSpawnError(res.error ?? t('workersTab.spawnFailed'));
      }
    } catch {
      setSpawnError(t('workersTab.spawnFailed'));
    } finally {
      setStarting(false);
      refresh();
    }
  }, [starting, objective, cwd, name, provider, refresh, t]);

  const live = data?.live ?? [];
  const preserved = data?.preserved ?? [];
  const max = data?.maxWorkers ?? 4;

  // ─── PRD-4: portable team files ───
  const agents = useStore((s) => s.agents);
  const [teamPreview, setTeamPreview] = useState<Awaited<ReturnType<typeof window.cth.teamPick>> | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [teamMsg, setTeamMsg] = useState<string | null>(null);
  const [staging, setStaging] = useState<string | null>(null);

  const exportTeam = useCallback(async () => {
    setTeamError(null); setTeamMsg(null);
    const hireProviders = new Set(['claude', 'antigravity', 'codex', 'cursor']);
    const members = agents.filter((a) => !a.isGod).map((a) => ({
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      ...(a.provider && hireProviders.has(a.provider)
        ? { provider: a.provider as TeamMemberSpec['provider'] } : {})
    }));
    if (!members.length) { setTeamError(t('workersTab.teamEmptyRoster')); return; }
    const content = serializeTeamFile({ spec: TEAM_FILE_SPEC, name: 'My Team', members });
    const res = await window.cth.teamSave({ defaultName: 'team.md', content });
    if (res.ok) setTeamMsg(t('workersTab.teamExported', { path: res.path ?? '' }));
    else if (res.error !== 'cancelled') setTeamError(res.error ?? t('workersTab.teamFailed'));
  }, [agents, t]);

  const importTeam = useCallback(async () => {
    setTeamError(null); setTeamMsg(null); setTeamPreview(null);
    const res = await window.cth.teamPick();
    if (res.error === 'cancelled') return;
    if (!res.ok) { setTeamError(res.errors?.join('; ') || res.error || t('workersTab.teamFailed')); return; }
    setTeamPreview(res);
  }, [t]);

  const stageMember = useCallback(async (member: TeamMemberSpec) => {
    setStaging(member.name); setTeamError(null);
    const r = await window.cth.teamStageMember(member);
    if (!r.ok) setTeamError(r.errors.join('; '));
    setStaging(null);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px 16px', overflow: 'auto' }}>
      <div>
        <span style={sectionHead}>{t('workersTab.spawnTitle')}</span>
        <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
          {t('workersTab.spawnIntro')}
        </p>
        <div style={{ ...card, gap: 8 }} aria-busy={starting}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{t('workersTab.objectiveLabel')}</span>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder={t('workersTab.objectivePlaceholder')}
              rows={2}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                background: 'var(--cth-paper-100)', border: 'none',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                resize: 'vertical'
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ flex: '2 1 160px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{t('workersTab.cwdLabel')}</span>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={t('workersTab.cwdHint')}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              />
            </label>
            <label style={{ flex: '1 1 110px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{t('workersTab.nameLabel')}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              />
            </label>
            <label style={{ flex: '1 1 110px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{t('workersTab.providerLabel')}</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              >
                <option value="">{t('workersTab.providerDefault')}</option>
                {AGENT_PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>
          </div>
          {starting && <SkeletonLines lines={2} />}
          {spawnError && (
            <div style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{spawnError}</div>
          )}
          {spawnedId && (
            <div style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
              {t('workersTab.spawnedOk', { id: spawnedId })}
            </div>
          )}
          <div>
            <PixelButton onClick={() => void startTemp()} disabled={starting || !objective.trim()}>
              {starting ? t('workersTab.starting') : t('workersTab.start')}
            </PixelButton>
          </div>
        </div>
      </div>

      {/* ─── PRD-4: portable team files — export the roster, import one .md ─── */}
      <div>
        <span style={sectionHead}>{t('workersTab.teamTitle')}</span>
        <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
          {t('workersTab.teamIntro')}
        </p>
        <div style={{ ...card, gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PixelButton size="sm" onClick={() => void exportTeam()}>{t('workersTab.teamExport')}</PixelButton>
            <PixelButton size="sm" variant="secondary" onClick={() => void importTeam()}>{t('workersTab.teamImport')}</PixelButton>
          </div>
          {teamError && <div style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{teamError}</div>}
          {teamMsg && <div style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{teamMsg}</div>}
          {teamPreview?.ok && teamPreview.team && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                {teamPreview.team.name}
              </div>
              {(teamPreview.strippedKeys?.length ?? 0) > 0 && (
                <div style={{ fontSize: 11, color: 'var(--cth-coral)' }}>
                  {t('workersTab.teamStripped', { keys: teamPreview.strippedKeys.join(', ') })}
                </div>
              )}
              <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: 0 }}>
                {t('workersTab.teamPausedNote')}
              </p>
              {teamPreview.team.members.map((m) => (
                <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                    {m.name}
                  </span>
                  {m.role && (
                    <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', color: 'var(--cth-ink-700)' }}>
                      {m.role}
                    </span>
                  )}
                  {m.provider && (
                    <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', color: 'var(--cth-ink-700)' }}>
                      {m.provider}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <PixelButton size="sm" disabled={staging !== null} onClick={() => void stageMember(m)}>
                    {staging === m.name ? t('workersTab.teamStaging') : t('workersTab.teamHire')}
                  </PixelButton>
                </div>
              ))}
              <div>
                <PixelButton size="sm" variant="ghost" onClick={() => setTeamPreview(null)}>
                  {t('workersTab.teamDismiss')}
                </PixelButton>
              </div>
            </div>
          )}
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={sectionHead}>{t('workersTab.liveWorkers')}</span>
          <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
            {live.length} / {max}
          </span>
        </div>
        <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
          {t('workersTab.liveIntro', { godName })}
        </p>

        {live.length === 0 ? (
          <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
            {t('workersTab.noneRunning')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {live.map((w) => (
              <div key={w.workerId} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <StatusBadge w={w} />
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>{w.name}</span>
                    {w.hasSlack && (
                      <span title={t('workersTab.repliesToSlack')} style={{
                        fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-700)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', padding: '0 5px'
                      }}>slack</span>
                    )}
                  </div>
                  <PixelButton
                    onClick={() => stop(w.workerId)}
                    disabled={w.releasing || !!stopping[w.workerId]}
                  >
                    {w.releasing || stopping[w.workerId] ? t('workersTab.stoppingEllipsis') : t('workersTab.stop')}
                  </PixelButton>
                </div>
                <div style={metaRow}>
                  <span title={t('workersTab.workerIdTitle')}>{w.workerId}</span>
                  <span title={t('workersTab.baseBranchTitle')}>{t('workersTab.base', { branch: w.baseBranch })}</span>
                  <span title={t('workersTab.upSinceTitle')}>{t('workersTab.up', { age: relAge(w.ageMs) })}</span>
                  <span title={t('workersTab.idleTitle')}>
                    {w.idleMs === null ? t('workersTab.ptyGone') : t('workersTab.idle', { age: relAge(w.idleMs) })}
                  </span>
                  <span title={t('workersTab.tokensTitle')}>
                    {t('workersTab.tokens', { value: fmtTokens(w.tokensUsed) })}{w.tokenCap !== null ? ` / ${fmtTokens(w.tokenCap)}` : ` · ${t('workersTab.uncapped')}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preserved.length > 0 && (
        <div>
          <span style={sectionHead}>{t('workersTab.preserved', { count: preserved.length })}</span>
          <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
            {t('workersTab.preservedIntro')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preserved.map((p) => (
              <div key={p.wtPath} style={card}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                  {p.workerId}
                </div>
                <div style={metaRow}>
                  <span style={{ wordBreak: 'break-all' }}>{p.wtPath}</span>
                  <span>{t('workersTab.base', { branch: p.baseBranch })}</span>
                  <span>{t('workersTab.keptAgo', { age: relAge(Math.max(0, Date.now() - p.preservedAt)) })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
