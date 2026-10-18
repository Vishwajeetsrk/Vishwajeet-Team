import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { JobRun, JobRunState } from '@shared/jobs';
import { Chip, Hint, MiniButton, Muted, SubCard } from './ui';
import { SkeletonRows } from '@/components/Skeleton';

/**
 * JOB HISTORY — every durable run on the one M3 ledger: recurring mission
 * fires, one-time submits, event (webhook/org) dispatches. The operator's
 * question is "did it run, did it fail, is something stuck" — so state leads
 * the row, the error is never truncated away, and the only two actions are
 * the honest ones: cancel a QUEUED run, or retry a dead one as a fresh
 * operator-explicit run (the automatic path never duplicates an effect).
 *
 * HONESTY LABEL (vision §5): rows live in THIS machine's SQLite. No cloud
 * sync, no offline continuity promise beyond the local file — stated in the
 * panel footer, in every locale.
 */

/** States an operator may retry. `refused` is not retryable — a cap or policy
 *  said no; retrying without changing the cap would just refuse again. */
const RETRYABLE: JobRunState[] = ['failed', 'interrupted', 'cancelled'];

function toneFor(state: JobRunState): 'plain' | 'on' | 'off' {
  if (state === 'running' || state === 'queued') return 'on';
  if (state === 'succeeded') return 'plain';
  return 'off';
}

/** Relative-time label — same copy as the schedules row ("5m ago"/"in 2h"). */
function relTime(now: number, ts: number, t: TFunction): string {
  const diff = now - ts;
  const past = diff >= 0;
  const a = Math.abs(diff);
  if (a < 45_000) return t('schedulesSection.justNow');
  const mins = Math.round(a / 60_000);
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return past ? t('schedulesSection.ago', { unit }) : t('schedulesSection.in', { unit });
}

/** Ticking clock for relTime labels — one 60s timer per panel, not a Date.now()
 *  per row per render. Labels would otherwise go stale until something else
 *  re-rendered, and every render recomputed them all. */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}

/** Initial row cap — the ledger query returns up to 100, but the first paint
 *  only needs a screenful. The rest is one click away, not one long layout. */
const INITIAL_ROWS = 25;

export function JobHistory({ onSummary }: { onSummary?: (s: string) => void }) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const now = useNow();

  const load = useCallback(() => {
    window.cth.listJobs({ limit: 100 })
      .then(setRuns)
      .catch(() => { /* panel degrades to empty */ })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
    return window.cth.onJobsUpdated(load);
  }, [load]);

  useEffect(() => {
    const problems = runs.filter((r) => r.state === 'failed' || r.state === 'interrupted').length;
    onSummary?.(
      runs.length === 0
        ? t('jobHistory.summaryNone')
        : t('jobHistory.summary', { total: runs.length, problems })
    );
  }, [runs, onSummary, t]);

  const runAction = useCallback(async (
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string }>
  ): Promise<void> => {
    setBusy(id);
    setActionError(null);
    try {
      const res = await fn();
      if (!res.ok) setActionError(res.error ?? t('jobHistory.actionFailed'));
    } catch {
      setActionError(t('jobHistory.actionFailed'));
    } finally {
      setBusy(null);
      load();
    }
  }, [load, t]);

  const visible = expanded ? runs : runs.slice(0, INITIAL_ROWS);

  return (
    <div aria-busy={!loaded}>
      {actionError && <Hint>{actionError}</Hint>}
      {!loaded && <SkeletonRows count={3} />}
      {loaded && runs.length === 0 && <Muted>{t('jobHistory.empty')}</Muted>}

      {visible.map((run) => (
        <div key={run.id} className="cth-cv">
          <JobRow run={run} now={now} busy={busy === run.id} onAction={runAction} />
        </div>
      ))}

      {loaded && runs.length > INITIAL_ROWS && (
        <div style={{ marginTop: 4 }}>
          <MiniButton onClick={() => setExpanded((e) => !e)}>
            {expanded
              ? t('jobHistory.showLess')
              : t('jobHistory.showMore', { count: runs.length - INITIAL_ROWS })}
          </MiniButton>
        </div>
      )}

      {runs.length > 0 && <Hint>{t('jobHistory.localNote')}</Hint>}
    </div>
  );
}

/** One ledger row — memoized so a tick of the clock or a busy flag on a
 *  sibling does not re-render all 100 rows. Props are run-primitive stable:
 *  `busy` is a boolean, `onAction` is a single stable callback. */
const JobRow = memo(function JobRow({ run, now, busy, onAction }: {
  run: JobRun; now: number; busy: boolean;
  onAction: (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const { t } = useTranslation();
  return (
    <SubCard>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Chip tone={toneFor(run.state)}>{t(`jobHistory.state.${run.state}`)}</Chip>
        <span
          title={run.label}
          style={{
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)'
          }}
        >
          {run.label}
        </span>
        <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--cth-ink-500)' }}>
          {t(`jobHistory.kind.${run.kind}`)}
        </span>
      </div>

      <div style={{ marginTop: 2, display: 'flex', gap: 8, fontSize: 11, color: 'var(--cth-ink-500)' }}>
        <span>{relTime(now, run.createdAt, t)}</span>
        <span>
          {run.attempt > 0
            ? t('jobHistory.attempt', { n: run.attempt, max: run.maxAttempts })
            : t('jobHistory.pendingAttempt', { max: run.maxAttempts })}
        </span>
      </div>

      {run.error && (
        <div style={{ marginTop: 3, fontSize: 11, lineHeight: '15px', color: 'var(--cth-coral)' }}>
          {run.error}
        </div>
      )}

      {(run.state === 'queued' || RETRYABLE.includes(run.state)) && (
        <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
          {run.state === 'queued' && (
            <MiniButton
              tone="danger"
              disabled={busy}
              onClick={() => void onAction(run.id, () => window.cth.jobsCancel(run.id))}
            >
              {t('jobHistory.cancel')}
            </MiniButton>
          )}
          {RETRYABLE.includes(run.state) && (
            <MiniButton
              disabled={busy}
              onClick={() => void onAction(run.id, () => window.cth.jobsRetry(run.id))}
            >
              {t('jobHistory.retry')}
            </MiniButton>
          )}
        </div>
      )}
    </SubCard>
  );
});
