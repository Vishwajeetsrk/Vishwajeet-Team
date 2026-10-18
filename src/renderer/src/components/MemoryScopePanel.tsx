import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useRtl } from '@/i18n/useDirection';
import {
  MEMORY_CONTENT_MAX, MEMORY_SCOPES, MEMORY_STATUSES, MEMORY_TYPES,
} from '@shared/memoryRecord';
import type {
  MemoryOp, MemoryQuery, MemoryRecord, MemoryScope, MemoryStatus, MemoryType,
} from '@shared/memoryRecord';

/** AI Company OS (Phase 5) — the scoped-memory section of the Memory tab.
 *  Every value shown is a main-process answer over the `memory:*` IPC surface:
 *  list/search/history come from MemoryService, mutations ride the full write
 *  pipeline (validation, secret scan, dedupe, ACL). Nothing here is simulated,
 *  invented, or held in fake local persistence — the panel only mirrors what
 *  main returns. The actor is pinned USER_ACTOR main-side; this component never
 *  names an actor (godId is displayed as the default agent reference only). */

type ListState = { records: MemoryRecord[]; total: number } | null;
type ErrState = { error: string; code?: string } | null;

const STATUS_BG: Record<MemoryStatus, string> = {
  active: 'var(--cth-mint)',
  proposed: 'var(--cth-lemon)',
  superseded: 'var(--cth-ink-300)',
  expired: 'var(--cth-cream-200)',
  deleted: 'var(--cth-coral)'
};
const DARK_CHIP = new Set(['superseded', 'deleted']);

const SCOPE_BG: Record<MemoryScope, string> = {
  global: 'var(--cth-cream-200)',
  project: 'var(--cth-sky)',
  agent: 'var(--cth-lilac)',
  task: 'var(--cth-peach)',
  computer: 'var(--cth-mint)'
};

/** Codes that get a short human hint under the verbatim service error. */
const HINT_CODES = new Set([
  'SECRET_DETECTED', 'PERMISSION_DENIED', 'CONFLICT', 'NOT_FOUND',
  'UNAVAILABLE', 'ACCESS_DENIED', 'VALIDATION'
]);

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
  border: 'none', padding: '5px 7px', width: '100%', boxSizing: 'border-box'
};
const textareaStyle: React.CSSProperties = {
  width: '100%', resize: 'vertical', padding: '6px 8px', boxSizing: 'border-box',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none'
};

function errText(op: { error?: string; code?: string }): string {
  return op.error ? (op.code ? `${op.error} [${op.code}]` : op.error) : 'failed';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Epoch ms → value for <input type="datetime-local"> (local time). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

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

export function MemoryScopePanel({ godId }: { godId: string }) {
  const { t } = useTranslation();
  const rtl = useRtl();

  // ── filters ────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<MemoryScope | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<MemoryStatus | 'all'>('all');

  // ── list state (mirrors main — never fabricated) ──────────────────────────
  const [records, setRecords] = useState<ListState>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<ErrState>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [dedup, setDedup] = useState<MemoryRecord | null>(null);
  const [formError, setFormError] = useState<ErrState>(null);

  // ── row expansion: one editor or history panel at a time ──────────────────
  const [openRow, setOpenRow] = useState<{ id: string; mode: 'edit' | 'history' } | null>(null);
  const [edit, setEdit] = useState<{ content: string; importance: string; confidence: string; expires: string; clearExpiry: boolean }>({
    content: '', importance: '2', confidence: '', expires: '', clearExpiry: false
  });
  const [editError, setEditError] = useState<ErrState>(null);
  const [history, setHistory] = useState<MemoryRecord[] | null>(null);
  const [historyError, setHistoryError] = useState<ErrState>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  // ── write form ────────────────────────────────────────────────────────────
  const [writeOpen, setWriteOpen] = useState(false);
  const [wScope, setWScope] = useState<MemoryScope>('project');
  const [wRef, setWRef] = useState('');
  const [wType, setWType] = useState<MemoryType>('fact');
  const [wContent, setWContent] = useState('');
  const [wImportance, setWImportance] = useState('2');
  const [wConfidence, setWConfidence] = useState('');
  const [wExpiry, setWExpiry] = useState('');

  // The query rides a ref: typing never triggers IPC — the search button,
  // Enter, the refresh button, and the live-update refetch read the latest text.
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    const text = queryRef.current.trim();
    const base: MemoryQuery = { limit: 100, status: statusFilter };
    if (scopeFilter !== 'all') base.scope = scopeFilter;
    try {
      // A non-empty query rides memorySearch (ranked recall); an empty one is a
      // browse via memoryList. Both return the same MemoryRetrieveResult shape.
      const res = text
        ? await window.cth.memorySearch({ ...base, query: text })
        : await window.cth.memoryList(base);
      if (!res.ok) {
        setRecords(null);
        setListError({ error: res.error, code: res.code });
        return;
      }
      setRecords({ records: res.value.records, total: res.value.total });
    } catch (e) {
      setRecords(null);
      setListError({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [scopeFilter, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  // Live ring from main (`memory:updated`, metadata only) → debounced refetch.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.cth.onMemoryUpdated(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void loadRef.current(); }, 300);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, []);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 6000);
  }, []);

  const run = useCallback(async (key: string, action: () => Promise<MemoryOp<unknown>>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await action();
      if (res.ok) { flash(t('memoryTab.ok')); setFormError(null); setEditError(null); }
      else flash(errText(res));
      await load();
      return res;
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }, [flash, load, t]);

  // ── row actions ───────────────────────────────────────────────────────────
  const approve = (id: string) => () => void run(`approve:${id}`, () => window.cth.memoryApprove(id));
  const remove = async (id: string) => {
    setConfirmDel(null);
    const res = await run(`del:${id}`, () => window.cth.memoryDelete(id));
    if (res.ok) setOpenRow((o) => (o?.id === id ? null : o));
  };

  const openEdit = (rec: MemoryRecord) => {
    setEditError(null);
    setEdit({
      content: rec.content,
      importance: String(rec.importance),
      confidence: typeof rec.confidence === 'number' && Number.isFinite(rec.confidence) ? String(rec.confidence) : '',
      expires: rec.expiresAt != null ? toLocalInput(rec.expiresAt) : '',
      clearExpiry: false
    });
    setOpenRow({ id: rec.id, mode: 'edit' });
  };

  const saveEdit = async (rec: MemoryRecord) => {
    setEditError(null);
    const res = await run(`edit:${rec.id}`, () => window.cth.memoryEdit({
      id: rec.id,
      content: edit.content,
      importance: Number(edit.importance),
      confidence: edit.confidence.trim() === '' ? null : Number(edit.confidence),
      expiresAt: edit.clearExpiry ? null : fromLocalInput(edit.expires)
    }));
    if (res.ok) setOpenRow(null);
    else setEditError({ error: res.error, code: res.code });
  };

  const openHistory = async (rec: MemoryRecord) => {
    setHistory(null);
    setHistoryError(null);
    setOpenRow({ id: rec.id, mode: 'history' });
    try {
      const res = await window.cth.memoryHistory(rec.id);
      if (res.ok) setHistory(res.value);
      else setHistoryError({ error: res.error, code: res.code });
    } catch (e) {
      setHistoryError({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  // ── write ─────────────────────────────────────────────────────────────────
  const submitWrite = async () => {
    setFormError(null);
    setDedup(null);
    const payload: Record<string, unknown> = {
      scope: wScope,
      type: wType,
      content: wContent,
      importance: Number(wImportance),
      confidence: wConfidence.trim() === '' ? null : Number(wConfidence),
      expiresAt: wExpiry ? fromLocalInput(wExpiry) : null
    };
    if (wScope === 'project') payload.projectId = wRef.trim();
    else if (wScope === 'agent') payload.agentId = wRef.trim();
    else if (wScope === 'task') payload.taskId = wRef.trim();
    else if (wScope === 'computer') payload.computerId = wRef.trim();
    setBusy((b) => ({ ...b, write: true }));
    try {
      const res = await window.cth.memoryWrite(payload);
      if (!res.ok) {
        setFormError({ error: res.error, code: res.code });
        return;
      }
      flash(t('memoryTab.ok'));
      if (res.value.dedup) setDedup(res.value.record);
      setWContent('');
      await load();
    } catch (e) {
      setFormError({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy((b) => ({ ...b, write: false }));
    }
  };

  const refLabel = wScope === 'project' ? t('memoryTab.refLabels.project')
    : wScope === 'agent' ? t('memoryTab.refLabels.agent')
    : wScope === 'task' ? t('memoryTab.refLabels.task')
    : t('memoryTab.refLabels.computer');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── toolbar ─────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={sectionHead}>{t('memoryTab.title')}</span>
          <PixelButton size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
            {t('memoryTab.refresh')}
          </PixelButton>
        </div>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
          {t('memoryTab.intro')}
        </span>
        <span style={mono}>{t('memoryTab.userAuthority', { id: godId })}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            dir={rtl ? 'auto' : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
            placeholder={t('memoryTab.searchPlaceholder')}
            style={{ ...inputStyle, flex: 1, minWidth: 140 }}
          />
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value as MemoryScope | 'all')}
            style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}
          >
            <option value="all">{t('memoryTab.scopeAll')}</option>
            {MEMORY_SCOPES.map((s) => (
              <option key={s} value={s}>{t(`memoryTab.scopes.${s}`, s)}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as MemoryStatus | 'all')}
            style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}
          >
            <option value="all">{t('memoryTab.statusAll')}</option>
            {MEMORY_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`memoryTab.statuses.${s}`, s)}</option>
            ))}
          </select>
        </div>
      </div>

      {notice && (
        <div style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
          padding: '5px 8px', background: 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}>{notice}</div>
      )}

      {/* ── dedup info note (honest: no second row was written) ────────────── */}
      {dedup && (
        <div style={{ ...card, background: 'var(--cth-sky)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...mono, color: 'var(--cth-ink-900)' }}>
            <Icon name="info" /> {t('memoryTab.dedupNote')}
          </span>
          <span style={{ ...mono, color: 'var(--cth-ink-900)' }}>
            {t('memoryTab.dedupExistingId', { id: dedup.id })}
          </span>
          <span style={{ ...mono, color: 'var(--cth-ink-700)' }}>{truncate(dedup.content, 160)}</span>
        </div>
      )}

      {/* ── list: loading / error / empty / records (all from main) ─────────── */}
      {loading && records === null && (
        <div style={card}>
          <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{t('memoryTab.loading')}</span>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ height: 10, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }} />
          ))}
        </div>
      )}
      {listError && (
        <div style={{ ...card, color: 'var(--cth-coral)' }}>
          <span style={mono}>{errText(listError)}</span>
          <div>
            <PixelButton size="sm" onClick={() => void load()}>{t('memoryTab.retry')}</PixelButton>
          </div>
        </div>
      )}
      {!loading && !listError && records && records.records.length === 0 && (
        <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
          {t('memoryTab.empty')}
        </div>
      )}
      {loading && records && (
        <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{t('memoryTab.loading')}</span>
      )}
      {records && records.records.map((rec) => {
        const proposed = rec.status === 'proposed';
        const conf = typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
          ? `${Math.round(rec.confidence * 100)}%` : '—';
        const open = openRow?.id === rec.id;
        return (
          <div key={rec.id} style={{ ...card, ...(proposed ? { background: 'var(--cth-lemon)' } : {}) }}>
            <div title={rec.content} style={{
              fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              {truncate(rec.content, 140)}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip label={t(`memoryTab.scopes.${rec.scope}`, rec.scope)} bg={SCOPE_BG[rec.scope]} />
              <span style={mono}>{t('memoryTab.owner')}: {rec.ownerId}</span>
              <Chip label={t(`memoryTab.types.${rec.type}`, rec.type)} bg="var(--cth-cream-200)" />
              <Chip
                label={t(`memoryTab.statuses.${rec.status}`, rec.status)}
                bg={STATUS_BG[rec.status]}
                dark={DARK_CHIP.has(rec.status)}
              />
            </div>
            <div style={metaRow}>
              <span>{t('memoryTab.importance')}: {rec.importance}</span>
              <span>{t('memoryTab.confidence')}: {conf}</span>
              <span>{t('memoryTab.version', { n: rec.version })}</span>
              <span>{t('memoryTab.updated')}: {new Date(rec.updatedAt).toLocaleString()}</span>
              {rec.expiresAt != null && (
                <span>{t('memoryTab.expires')}: {new Date(rec.expiresAt).toLocaleString()}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {proposed && (
                <PixelButton size="sm" disabled={!!busy[`approve:${rec.id}`]} onClick={approve(rec.id)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="check" /> {t('memoryTab.approve')}
                  </span>
                </PixelButton>
              )}
              <PixelButton
                size="sm" variant="secondary"
                onClick={() => open ? setOpenRow(null) : openEdit(rec)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name={open && openRow?.mode === 'edit' ? 'x' : 'edit'} />
                  {open && openRow?.mode === 'edit' ? t('memoryTab.cancel') : t('memoryTab.edit')}
                </span>
              </PixelButton>
              <PixelButton
                size="sm" variant="secondary"
                onClick={() => open && openRow?.mode === 'history' ? setOpenRow(null) : void openHistory(rec)}
              >
                {t('memoryTab.history')}
              </PixelButton>
              {confirmDel === rec.id ? (
                <>
                  <PixelButton size="sm" variant="destructive" disabled={!!busy[`del:${rec.id}`]} onClick={() => void remove(rec.id)}>
                    {t('memoryTab.confirm')}
                  </PixelButton>
                  <PixelButton size="sm" variant="secondary" onClick={() => setConfirmDel(null)}>
                    {t('memoryTab.cancel')}
                  </PixelButton>
                </>
              ) : (
                <PixelButton size="sm" variant="destructive" onClick={() => setConfirmDel(rec.id)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="x" /> {t('memoryTab.delete')}
                  </span>
                </PixelButton>
              )}
            </div>
            {confirmDel === rec.id && (
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)' }}>
                {t('memoryTab.confirmDelete')}
              </span>
            )}

            {/* ── inline editor ───────────────────────────────────────────── */}
            {open && openRow?.mode === 'edit' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
                <span style={sectionHead}>{t('memoryTab.editTitle')}</span>
                <textarea
                  dir={rtl ? 'auto' : undefined}
                  value={edit.content}
                  maxLength={MEMORY_CONTENT_MAX}
                  onChange={(e) => setEdit((s) => ({ ...s, content: e.target.value }))}
                  rows={3}
                  style={textareaStyle}
                />
                <span style={mono}>{t('memoryTab.charsUsed', { n: edit.content.length, max: MEMORY_CONTENT_MAX })}</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                    {t('memoryTab.importanceLabel')}
                    <select
                      value={edit.importance}
                      onChange={(e) => setEdit((s) => ({ ...s, importance: e.target.value }))}
                      style={{ ...inputStyle, width: 'auto', marginLeft: 4, cursor: 'pointer' }}
                    >
                      {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                    {t('memoryTab.confidenceLabel')}
                    <input
                      type="number" min="0" max="1" step="0.1"
                      value={edit.confidence}
                      onChange={(e) => setEdit((s) => ({ ...s, confidence: e.target.value }))}
                      style={{ ...inputStyle, width: 72, marginLeft: 4 }}
                    />
                  </label>
                  <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                    {t('memoryTab.expiryLabel')}
                    <input
                      type="datetime-local"
                      value={edit.expires}
                      disabled={edit.clearExpiry}
                      onChange={(e) => setEdit((s) => ({ ...s, expires: e.target.value }))}
                      style={{ ...inputStyle, width: 'auto', marginLeft: 4 }}
                    />
                  </label>
                  <PixelButton size="sm" variant="secondary" onClick={() => setEdit((s) => ({ ...s, clearExpiry: !s.clearExpiry, expires: '' }))}>
                    {t('memoryTab.expiryClear')}
                  </PixelButton>
                </div>
                {editError && (
                  <div style={{
                    fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
                    padding: '5px 8px', background: 'var(--cth-coral-light)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                  }}>
                    {errText(editError)}
                    {editError.code && HINT_CODES.has(editError.code) && (
                      <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11 }}>
                        {t(`memoryTab.errorHints.${editError.code}`)}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <PixelButton size="sm" disabled={!!busy[`edit:${rec.id}`]} onClick={() => void saveEdit(rec)}>
                    {busy[`edit:${rec.id}`] ? t('memoryTab.saving') : t('memoryTab.save')}
                  </PixelButton>
                  <PixelButton size="sm" variant="secondary" onClick={() => setOpenRow(null)}>
                    {t('memoryTab.cancel')}
                  </PixelButton>
                </div>
              </div>
            )}

            {/* ── supersession history ────────────────────────────────────── */}
            {open && openRow?.mode === 'history' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
                <span style={sectionHead}>{t('memoryTab.historyTitle')}</span>
                {historyError && <span style={{ ...mono, color: 'var(--cth-coral)' }}>{errText(historyError)}</span>}
                {!history && !historyError && (
                  <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{t('memoryTab.loading')}</span>
                )}
                {history && history.length <= 1 && (
                  <span style={mono}>{t('memoryTab.historyEmpty')}</span>
                )}
                {history && history.map((h) => (
                  <div key={h.id} style={{
                    padding: '5px 7px', background: 'var(--cth-cream-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', display: 'flex', flexDirection: 'column', gap: 3
                  }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Chip label={t('memoryTab.version', { n: h.version })} bg="var(--cth-cream-200)" />
                      <Chip
                        label={t(`memoryTab.statuses.${h.status}`, h.status)}
                        bg={STATUS_BG[h.status]}
                        dark={DARK_CHIP.has(h.status)}
                      />
                      <span style={mono}>{h.id}</span>
                      <span style={mono}>{new Date(h.updatedAt).toLocaleString()}</span>
                    </div>
                    <span style={{ ...mono, color: 'var(--cth-ink-900)' }}>{truncate(h.content, 160)}</span>
                    {h.supersededBy && (
                      <span style={mono}>{t('memoryTab.supersededBy', { id: h.supersededBy })}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* ── write form ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={sectionHead}>{t('memoryTab.addMemory')}</span>
          <PixelButton size="sm" variant={writeOpen ? 'secondary' : 'primary'} onClick={() => { setWriteOpen((v) => !v); setFormError(null); setDedup(null); }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name={writeOpen ? 'x' : 'plus'} /> {writeOpen ? t('memoryTab.hideForm') : t('memoryTab.addMemory')}
            </span>
          </PixelButton>
        </div>
        {writeOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                {t('memoryTab.scopeLabel')}
                <select
                  value={wScope}
                  onChange={(e) => setWScope(e.target.value as MemoryScope)}
                  style={{ ...inputStyle, width: 'auto', marginLeft: 4, cursor: 'pointer' }}
                >
                  {MEMORY_SCOPES.map((s) => (
                    <option key={s} value={s}>{t(`memoryTab.scopes.${s}`, s)}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                {t('memoryTab.typeLabel')}
                <select
                  value={wType}
                  onChange={(e) => setWType(e.target.value as MemoryType)}
                  style={{ ...inputStyle, width: 'auto', marginLeft: 4, cursor: 'pointer' }}
                >
                  {MEMORY_TYPES.map((ty) => (
                    <option key={ty} value={ty}>{t(`memoryTab.types.${ty}`, ty)}</option>
                  ))}
                </select>
              </label>
            </div>
            {wScope === 'global' ? (
              <span style={mono}>{t('memoryTab.globalRefNote')}</span>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', minWidth: 90 }}>
                  {refLabel}
                  <input
                    dir={rtl ? 'auto' : undefined}
                    value={wRef}
                    onChange={(e) => setWRef(e.target.value)}
                    placeholder={t('memoryTab.refPlaceholder')}
                    style={{ ...inputStyle, marginLeft: 4, width: 180 }}
                  />
                </label>
                {wScope === 'agent' && (
                  <>
                    <span style={mono}>{t('memoryTab.agentRefHint', { id: godId })}</span>
                    <PixelButton size="sm" variant="secondary" onClick={() => setWRef(godId)}>
                      {t('memoryTab.useAgentRef')}
                    </PixelButton>
                  </>
                )}
              </div>
            )}
            <textarea
              dir={rtl ? 'auto' : undefined}
              value={wContent}
              onChange={(e) => setWContent(e.target.value)}
              maxLength={MEMORY_CONTENT_MAX}
              rows={3}
              placeholder={t('memoryTab.contentLabel')}
              style={textareaStyle}
            />
            <span style={mono}>{t('memoryTab.charsUsed', { n: wContent.length, max: MEMORY_CONTENT_MAX })}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                {t('memoryTab.importanceLabel')}
                <select
                  value={wImportance}
                  onChange={(e) => setWImportance(e.target.value)}
                  style={{ ...inputStyle, width: 'auto', marginLeft: 4, cursor: 'pointer' }}
                >
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                {t('memoryTab.confidenceLabel')}
                <input
                  type="number" min="0" max="1" step="0.1"
                  value={wConfidence}
                  onChange={(e) => setWConfidence(e.target.value)}
                  style={{ ...inputStyle, width: 72, marginLeft: 4 }}
                />
              </label>
              <label style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
                {t('memoryTab.expiryLabel')}
                <input
                  type="datetime-local"
                  value={wExpiry}
                  onChange={(e) => setWExpiry(e.target.value)}
                  style={{ ...inputStyle, width: 'auto', marginLeft: 4 }}
                />
              </label>
            </div>
            {formError && (
              <div style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
                padding: '5px 8px', background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
              }}>
                {errText(formError)}
                {formError.code && HINT_CODES.has(formError.code) && (
                  <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11 }}>
                    {t(`memoryTab.errorHints.${formError.code}`)}
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <PixelButton
                size="sm"
                disabled={!!busy.write || !wContent.trim() || (wScope !== 'global' && !wRef.trim())}
                onClick={() => void submitWrite()}
              >
                {busy.write ? t('memoryTab.writing') : t('memoryTab.write')}
              </PixelButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
