import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { CapEntry, CapKind } from '@shared/capabilities';

/** PRD-9 — the capabilities browser: one free list, nothing gated. Bundled
 *  rows ship with the app; 'office' rows come from capabilities.json in the
 *  hive root, which anyone on this team can extend. MCP rows install with a
 *  toggle; everything else shows honest manual steps. */
export function CapabilitiesBrowser({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    loading: boolean;
    items: CapEntry[];
    officeCount: number;
    officeDropped: number;
    error: string;
  }>({ loading: true, items: [], officeCount: 0, officeDropped: 0, error: '' });
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<CapKind | 'all'>('all');
  const [savedId, setSavedId] = useState<string | null>(null);

  const load = () => {
    void window.cth.capabilitiesList().then((r) => {
      if (r.ok && r.items) {
        setState({ loading: false, items: r.items, officeCount: r.officeCount ?? 0, officeDropped: r.officeDropped ?? 0, error: '' });
      } else {
        setState({ loading: false, items: [], officeCount: 0, officeDropped: 0, error: r.error ?? 'load failed' });
      }
    });
  };

  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.items.filter((e) =>
      (kind === 'all' || e.kind === kind) &&
      (!q || e.name.toLowerCase().includes(q) || e.what.toLowerCase().includes(q))
    );
  }, [state.items, query, kind]);

  const enabledMcp = (id: string): boolean => {
    const key = id.replace(/^mcp-/, '');
    return config.mcpDefaults?.[key]?.enabled ?? false;
  };

  const toggleMcp = async (e: CapEntry) => {
    const key = e.id.replace(/^mcp-/, '');
    const next = !enabledMcp(e.id);
    await window.cth.updateConfig({ mcpDefaults: { ...(config.mcpDefaults ?? {}), [key]: { enabled: next } } });
    setSavedId(e.id);
    setTimeout(() => setSavedId(null), 1800);
  };

  const KINDS: { id: CapKind | 'all'; labelKey: string }[] = [
    { id: 'all', labelKey: 'marketplace.kindAll' },
    { id: 'mcp-server', labelKey: 'marketplace.kindMcp' },
    { id: 'skill', labelKey: 'marketplace.kindSkill' },
    { id: 'tool', labelKey: 'marketplace.kindTool' }
  ];

  const badgeStyle: React.CSSProperties = {
    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '14px',
    textTransform: 'uppercase', padding: '0 6px',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
          color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 6
        }}>{t('marketplace.title')}</div>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          {t('marketplace.desc')}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('marketplace.search')}
          aria-label={t('marketplace.search')}
          style={{ flex: 1, minWidth: 200, padding: '4px 8px', fontFamily: 'var(--cth-font-ui)', fontSize: 12, background: 'var(--cth-cream-100)', color: 'var(--cth-ink-900)' }}
        />
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => setKind(k.id)}
            style={{
              padding: '3px 8px 1px', cursor: 'pointer', border: 'none',
              background: kind === k.id ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
              boxShadow: `inset 0 0 0 1px ${kind === k.id ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
              fontFamily: 'var(--cth-font-display)', fontSize: 8,
              textTransform: 'uppercase', color: 'var(--cth-ink-900)'
            }}
          >
            {t(k.labelKey)}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filtered.map((e) => {
          const on = e.install === 'toggle' && enabledMcp(e.id);
          return (
            <div
              key={e.id}
              style={{
                display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px',
                background: 'var(--cth-paper-100)',
                boxShadow: `inset 0 0 0 1px ${e.source === 'office' ? 'var(--cth-mint)' : 'var(--cth-ink-300)'}`
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 12, lineHeight: '18px', fontWeight: 600, color: 'var(--cth-ink-900)' }}>{e.name}</span>
                  <span style={{ ...badgeStyle, color: 'var(--cth-ink-500)' }}>{t(`marketplace.kind.${e.kind.replace('-', '_')}`)}</span>
                  <span style={{
                    ...badgeStyle,
                    color: e.source === 'office' ? 'var(--cth-ink-700)' : 'var(--cth-ink-500)',
                    background: e.source === 'office' ? 'var(--cth-mint-soft, var(--cth-paper-100))' : 'transparent'
                  }}>
                    {e.source === 'office' ? t('marketplace.badgeListed') : t('marketplace.badgeBundled')}
                  </span>
                  {(e.can.reads || e.can.writes || e.can.sends || e.can.spends || e.can.deletes) && (
                    <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
                      {[
                        e.can.reads && t('marketplace.canReads'),
                        e.can.writes && t('marketplace.canWrites'),
                        e.can.sends && t('marketplace.canSends'),
                        e.can.spends && t('marketplace.canSpends'),
                        e.can.deletes && t('marketplace.canDeletes')
                      ].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
                {e.install === 'toggle' ? (
                  <button
                    type="button"
                    onClick={() => { void toggleMcp(e); }}
                    style={{
                      flexShrink: 0, padding: '3px 10px 1px', cursor: 'pointer', border: 'none',
                      background: on ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
                      boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
                      fontFamily: 'var(--cth-font-display)', fontSize: 8,
                      textTransform: 'uppercase', color: 'var(--cth-ink-900)'
                    }}
                  >
                    {savedId === e.id
                      ? t('marketplace.saved')
                      : on ? t('marketplace.installed') : t('marketplace.install')}
                  </button>
                ) : (
                  <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', textTransform: 'uppercase' }}>
                    {t('marketplace.manualDoor')}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', wordBreak: 'break-word' }}>
                {e.what}{e.maker ? ` — ${e.maker}` : ''}
              </div>
              {e.manual && (
                <code style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)', whiteSpace: 'pre-wrap' }}>
                  {e.manual.join('\n')}
                </code>
              )}
            </div>
          );
        })}
        {!filtered.length && !state.loading && (
          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('marketplace.empty')}</span>
        )}
      </div>

      {state.officeCount > 0 && (
        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
          {t('marketplace.officeNote', { count: state.officeCount })}
        </span>
      )}
      {state.officeDropped > 0 && (
        <span style={{ fontSize: 12, color: '#6E1423' }}>
          {t('marketplace.officeDropped', { count: state.officeDropped })}
        </span>
      )}
      {state.error && (
        <span style={{ fontSize: 12, color: '#6E1423' }}>{t('marketplace.loadFailed')}</span>
      )}
    </div>
  );
}
