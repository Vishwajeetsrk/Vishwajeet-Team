import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { useRtl } from '@/i18n/useDirection';

/** AI Company OS (Phase 3) — the CEO's goal board over the LIVE hive.
 *  Reads `ceo:state` (persisted goals.json), pushes actions through the
 *  `ceo:*` IPC, and refreshes on every `ceo:updated` push + a slow poll so a
 *  reply that lands while the panel is open surfaces without a click.
 *  No fake progress: every row is a persisted record, every failure is shown. */

type CeoState = Awaited<ReturnType<typeof window.cth.ceoState>>;
type CeoGoal = CeoState['goals'][number];
type CeoTask = CeoGoal['tasks'][number];
type CeoResult = Awaited<ReturnType<typeof window.cth.ceoExecute>>;

const POLL_MS = 4000;

const STATE_COLOR: Record<string, string> = {
  CREATED: 'var(--cth-ink-300)',
  PLANNED: 'var(--cth-cream-200)',
  ASSIGNED: 'var(--cth-sky)',
  RUNNING: 'var(--cth-sky)',
  REVIEW: 'var(--cth-lemon)',
  APPROVAL: 'var(--cth-lemon)',
  BLOCKED: 'var(--cth-coral)',
  WAITING: 'var(--cth-peach)',
  FAILED: 'var(--cth-coral)',
  COMPLETED: 'var(--cth-mint)',
  CANCELLED: 'var(--cth-ink-300)'
};

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
const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
  background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  border: 'none', padding: '5px 7px', width: '100%'
};

function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function errText(res: { ok: boolean; error?: string; errors?: string[] }): string {
  return res.errors?.join(' · ') || res.error || 'failed';
}

function StateChip({ state }: { state: string }) {
  const { t } = useTranslation();
  const color = STATE_COLOR[state] ?? 'var(--cth-cream-200)';
  const dark = state === 'FAILED' || state === 'CANCELLED' || state === 'COMPLETED';
  return (
    <span style={{
      fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0,
      color: dark ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
      background: color, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {t(`ceoTab.states.${state}`, state)}
    </span>
  );
}

interface FormTask {
  title: string;
  roles: string;
  deps: string;
  approval: boolean;
}

export function CeoPanel() {
  const { t } = useTranslation();
  const rtl = useRtl();
  const select = useStore((s) => s.select);
  const setFullscreen = useStore((s) => s.setFullscreen);

  const [data, setData] = useState<CeoState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [rows, setRows] = useState<FormTask[]>([{ title: '', roles: '', deps: '', approval: false }]);
  const [showForm, setShowForm] = useState(false);
  // Phase 5 — advisory scoped-memory recall carried on the createGoal result.
  // Kept only for the last create; absent/empty results change nothing.
  const [memoryCtx, setMemoryCtx] = useState<string | null>(null);
  const [showMemCtx, setShowMemCtx] = useState(false);

  const refresh = useCallback(() => {
    window.cth.ceoState()
      .then((s) => { setData(s); setLoadError(null); })
      .catch(() => { setLoadError('ceo state unavailable (main not ready)'); });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const off = window.cth.onCeoUpdated(() => refresh());
    return () => { clearInterval(timer); off(); };
  }, [refresh]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 6000);
  }, []);

  const run = useCallback(async (key: string, action: () => Promise<CeoResult>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await action();
      flash(res.ok ? t('ceoTab.ok') : errText(res));
      refresh();
      return res;
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
      return { ok: false } as CeoResult;
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }, [flash, refresh, t]);

  const createGoal = async () => {
    const tasks = rows
      .filter((r) => r.title.trim())
      .map((r) => ({
        title: r.title.trim(),
        description: '',
        roles: splitList(r.roles),
        skills: [],
        dependencies: splitList(r.deps).map((d) => Number.parseInt(d, 10)).filter((n) => Number.isInteger(n)),
        acceptanceCriteria: [],
        requiresApproval: r.approval
      }));
    const res = await run('create', () =>
      window.cth.ceoCreateGoal({ title: title.trim(), description: desc.trim(), tasks }));
    if (res.ok) {
      setTitle(''); setDesc(''); setRows([{ title: '', roles: '', deps: '', approval: false }]);
      setShowForm(false);
      setMemoryCtx(res.memoryContext && res.memoryContext.trim() ? res.memoryContext : null);
      setShowMemCtx(false);
    }
  };

  if (loadError && !data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px' }}>
        <div style={{ ...card, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
          {loadError}
        </div>
        <PixelButton onClick={refresh}>{t('ceoTab.retry')}</PixelButton>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)'
      }}>
        {t('ceoTab.loading')}
      </div>
    );
  }

  const goals = data.goals;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px 16px', overflow: 'auto' }}>
      {!data.hiveEnabled && (
        <div style={{ ...card, background: 'var(--cth-coral-light)', color: 'var(--cth-ink-900)' }}>
          <span style={sectionHead}>{t('ceoTab.offline')}</span>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>{t('ceoTab.offlineHint')}</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={sectionHead}>{t('ceoTab.title')}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
            {goals.length}
          </span>
          <PixelButton size="sm" variant={showForm ? 'secondary' : 'primary'} onClick={() => setShowForm((v) => !v)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name={showForm ? 'x' : 'plus'} /> {t('ceoTab.newGoal')}
            </span>
          </PixelButton>
        </div>
      </div>
      <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 0' }}>
        {t('ceoTab.intro')}
      </p>
      {notice && (
        <div style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
          padding: '5px 8px', background: 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}>{notice}</div>
      )}

      {/* Phase 5 — what the CEO recalled from scoped memory before planning.
           Advisory only: rendered exactly as main returned it, collapsible. */}
      {memoryCtx && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={sectionHead}>{t('ceoPanel.memoryContext.title')}</span>
            <PixelButton size="sm" variant="secondary" onClick={() => setShowMemCtx((v) => !v)}>
              {showMemCtx ? t('ceoPanel.memoryContext.hide') : t('ceoPanel.memoryContext.show')}
            </PixelButton>
          </div>
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
            {t('ceoPanel.memoryContext.disclaimer')}
          </span>
          {showMemCtx && (
            <pre style={{
              margin: 0, padding: 8, maxHeight: 200, overflow: 'auto',
              background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '16px',
              color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }} dir={rtl ? 'auto' : undefined}>{memoryCtx}</pre>
          )}
        </div>
      )}

      {showForm && (
        <div style={card}>
          <span style={sectionHead}>{t('ceoTab.newGoal')}</span>
          <input
            dir={rtl ? 'auto' : undefined}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('ceoTab.goalTitle')}
            style={inputStyle}
          />
          <textarea
            dir={rtl ? 'auto' : undefined}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={2}
            placeholder={t('ceoTab.goalDescription')}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
          {rows.map((row, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                  #{i + 1}
                </span>
                <input
                  dir={rtl ? 'auto' : undefined}
                  value={row.title}
                  onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  placeholder={t('ceoTab.taskTitle')}
                  style={{ ...inputStyle, flex: 1 }}
                />
                {rows.length > 1 && (
                  <button
                    onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                    title={t('ceoTab.remove')}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)' }}
                  ><Icon name="x" /></button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input
                  dir={rtl ? 'auto' : undefined}
                  value={row.roles}
                  onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, roles: e.target.value } : x)))}
                  placeholder={t('ceoTab.roles')}
                  style={{ ...inputStyle, flex: 1, minWidth: 120 }}
                />
                <input
                  dir={rtl ? 'auto' : undefined}
                  value={row.deps}
                  onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, deps: e.target.value } : x)))}
                  placeholder={t('ceoTab.deps')}
                  style={{ ...inputStyle, flex: 1, minWidth: 100 }}
                />
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', whiteSpace: 'nowrap'
                }}>
                  <input
                    type="checkbox"
                    checked={row.approval}
                    onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, approval: e.target.checked } : x)))}
                  />
                  {t('ceoTab.requiresApproval')}
                </label>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <PixelButton size="sm" variant="secondary" onClick={() => setRows((r) => [...r, { title: '', roles: '', deps: '', approval: false }])}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="plus" /> {t('ceoTab.addTask')}
              </span>
            </PixelButton>
            <PixelButton
              size="sm"
              disabled={!title.trim() || !rows.some((r) => r.title.trim()) || !!busy.create}
              onClick={() => void createGoal()}
            >
              {busy.create ? t('ceoTab.creating') : t('ceoTab.create')}
            </PixelButton>
            <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
              {t('ceoTab.createHint')}
            </span>
          </div>
        </div>
      )}

      {goals.length === 0 && !showForm && (
        <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
          {t('ceoTab.empty')}
        </div>
      )}

      {goals.map((goal) => {
        const goalTerminal = goal.status === 'COMPLETED' || goal.status === 'CANCELLED';
        return (
          <div key={goal.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StateChip state={goal.status} />
              <span style={{
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)',
                flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>{goal.title}</span>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {(goal.status === 'DRAFT' || goal.status === 'PLANNED' || goal.status === 'ACTIVE') && (
                  <PixelButton
                    size="sm"
                    disabled={!data.hiveEnabled || !!busy[`exec:${goal.id}`]}
                    onClick={() => void run(`exec:${goal.id}`, () => window.cth.ceoExecute(goal.id))}
                  >
                    {busy[`exec:${goal.id}`] ? t('ceoTab.working') : t('ceoTab.execute')}
                  </PixelButton>
                )}
                {!goalTerminal && (
                  <PixelButton
                    size="sm"
                    variant="secondary"
                    disabled={!data.hiveEnabled || !!busy[`cancelg:${goal.id}`]}
                    onClick={() => void run(`cancelg:${goal.id}`, () => window.cth.ceoCancel(goal.id))}
                  >
                    {t('ceoTab.cancelGoal')}
                  </PixelButton>
                )}
              </div>
            </div>
            {goal.description && (
              <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                {goal.description}
              </div>
            )}
            <div style={metaRow}>
              <span>{goal.id.slice(0, 8)}</span>
              <span>{t('ceoTab.createdBy', { who: goal.createdBy })}</span>
              <span>{goal.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>

            {goal.tasks.length === 0 && (
              <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {t('ceoTab.noTasks')}
              </div>
            )}
            {goal.tasks.map((task) => (
              <TaskRow
                key={task.planId}
                goal={goal}
                task={task}
                busy={busy}
                disabled={!data.hiveEnabled}
                run={run}
                onJump={(agentId) => { select(agentId); setFullscreen(agentId); }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function TaskRow({
  goal, task, busy, disabled, run, onJump
}: {
  goal: CeoGoal;
  task: CeoTask;
  busy: Record<string, boolean>;
  disabled: boolean;
  run: (key: string, action: () => Promise<CeoResult>) => Promise<CeoResult>;
  onJump: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const plan = goal.plans.find((p) => p.id === task.planId);
  const canAccept = task.state === 'REVIEW' || task.state === 'APPROVAL';
  const terminal = task.state === 'COMPLETED' || task.state === 'CANCELLED';
  const canRedeliver = !terminal
    && !!task.dispatchMessageId
    && task.attempts < task.maxAttempts
    && (task.state === 'FAILED' || task.state === 'BLOCKED');
  const canCancel = !terminal && goal.status !== 'COMPLETED' && goal.status !== 'CANCELLED';
  const canSession = !!task.agentId && task.sessionState !== 'live' && !terminal;
  const lastEvent = task.events.length > 0 ? task.events[task.events.length - 1] : null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '7px 9px', background: 'var(--cth-cream-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <StateChip state={task.state} />
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
          flex: 1, minWidth: 120
        }}>{plan?.title ?? task.planId}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {canAccept && (
            <PixelButton
              size="sm"
              disabled={disabled || !!busy[`accept:${task.planId}`]}
              onClick={() => void run(`accept:${task.planId}`, () => window.cth.ceoAccept(goal.id, task.planId))}
            >
              {t('ceoTab.accept')}
            </PixelButton>
          )}
          {canRedeliver && (
            <PixelButton
              size="sm"
              variant="secondary"
              disabled={disabled || !!busy[`redis:${task.planId}`]}
              onClick={() => void run(`redis:${task.planId}`, () => window.cth.ceoRedeliver(goal.id, task.planId))}
            >
              {t('ceoTab.redeliver')}
            </PixelButton>
          )}
          {canSession && task.agentId && (
            <PixelButton
              size="sm"
              variant="secondary"
              disabled={disabled || !!busy[`sess:${task.planId}`]}
              onClick={() => void run(`sess:${task.planId}`, () => window.cth.ceoEnsureSession(task.agentId!))}
            >
              {busy[`sess:${task.planId}`] ? t('ceoTab.starting') : t('ceoTab.startSession')}
            </PixelButton>
          )}
          {canCancel && (
            <PixelButton
              size="sm"
              variant="secondary"
              disabled={disabled || !!busy[`cancelt:${task.planId}`]}
              onClick={() => void run(`cancelt:${task.planId}`, () => window.cth.ceoCancel(goal.id, task.planId))}
            >
              {t('ceoTab.cancelTask')}
            </PixelButton>
          )}
        </div>
      </div>

      <div style={metaRow}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {task.agentId ? (
            <>
              <button
                onClick={() => onJump(task.agentId!)}
                title={t('ceoTab.jumpToTerminal')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
                  display: 'inline-flex', alignItems: 'center', gap: 3
                }}
              >
                <Icon name="terminal" />
                {task.agentName ?? task.agentId}
              </button>
              <span style={{ color: 'var(--cth-ink-300)' }}>
                · {t(`ceoTab.session.${task.sessionState}`, task.sessionState)}
              </span>
            </>
          ) : (
            <span style={{ color: 'var(--cth-ink-300)' }}>{t('ceoTab.noAgent')}</span>
          )}
        </span>
        <span>{t('ceoTab.attempts', { used: task.attempts, max: task.maxAttempts })}</span>
        {plan?.requirements.roles?.length ? <span>{plan.requirements.roles.join(', ')}</span> : null}
      </div>

      {task.result && (
        <div style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
          padding: '5px 7px', background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          maxHeight: 96, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
        }}>
          {task.result}
        </div>
      )}
      {task.error && (
        <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-coral)' }}>
          {task.error}
        </div>
      )}
      {lastEvent && !task.error && (
        <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)' }}>
          {lastEvent.at.slice(11, 19)} · {lastEvent.kind} · {lastEvent.detail}
        </div>
      )}
    </div>
  );
}
