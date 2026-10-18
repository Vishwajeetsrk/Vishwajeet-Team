import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import {
  inferRoleForHire,
  isProfileConfigured,
  inertReason,
  roleById,
  selectSpecialistForTask,
  type SpecialistCandidate,
  type WorkforceProfile
} from '@shared/workforce';
import { Chip, Muted, Scroll, SubCard } from './triggers/ui';

/**
 * WORKFORCE — the M4 catalog made visible. Every roster agent is read as a
 * workforce profile: role inferred from its description, configured iff
 * provider + model are set. Configured profiles show their role, skills and
 * engine; anything else renders INERT with the gap named (missing role,
 * provider, or model) — listed, never selectable, never dispatched.
 *
 * The skill matcher below is the gate made clickable: type the capability a
 * goal needs and the same capability-first selection the dispatch path uses
 * names its pick (or explains why nothing qualifies).
 */

interface Row {
  key: string;
  name: string;
  roleLabel: string | null;
  skills: string[];
  engine: string;
  configured: boolean;
  reason: string;
}

export function WorkforceTab() {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [query, setQuery] = useState('');

  const rows: Row[] = useMemo(() => agents.map((a) => {
    const roleId = inferRoleForHire(a.description);
    if (!roleId) {
      return {
        key: a.id, name: a.name, roleLabel: null, skills: [],
        engine: a.provider ?? a.model ?? '—',
        configured: false, reason: t('workforce.noRole')
      };
    }
    const profile: WorkforceProfile = {
      id: a.id,
      name: a.name,
      roleId,
      ...(a.provider ? { provider: a.provider } : {}),
      ...(a.model ? { model: a.model } : {})
    };
    const role = roleById(roleId);
    if (!isProfileConfigured(profile)) {
      return {
        key: a.id, name: a.name, roleLabel: role?.label ?? roleId,
        skills: role?.skills ?? [],
        engine: [a.provider, a.model].filter(Boolean).join(' · ') || '—',
        configured: false, reason: inertReason(profile) ?? t('workforce.inert')
      };
    }
    return {
      key: a.id, name: a.name, roleLabel: role?.label ?? roleId,
      skills: role?.skills ?? [],
      engine: [a.provider, a.model].filter(Boolean).join(' · '),
      configured: true, reason: t('workforce.configured')
    };
  }), [agents, t]);

  const match = useMemo(() => {
    const skills = query.split(',').map((s) => s.trim()).filter(Boolean);
    if (skills.length === 0) return null;
    const candidates: SpecialistCandidate[] = agents.flatMap((a) => {
      const roleId = inferRoleForHire(a.description);
      if (!roleId) return [];
      const role = roleById(roleId);
      if (!role) return [];
      const profile: WorkforceProfile = {
        id: a.id,
        name: a.name,
        roleId,
        ...(a.provider ? { provider: a.provider } : {}),
        ...(a.model ? { model: a.model } : {})
      };
      if (!isProfileConfigured(profile)) return [];
      return [{ profile, role, available: a.status === 'idle' }];
    });
    return selectSpecialistForTask(candidates, { skills });
  }, [agents, query]);

  const configured = rows.filter((r) => r.configured).length;

  return (
    <Scroll>
      <Muted>{t('workforce.intro', { configured, total: rows.length })}</Muted>
      <div style={{ height: 8 }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('workforce.matchPlaceholder')}
          aria-label={t('workforce.matchPlaceholder')}
          style={{
            flex: 1, minWidth: 0, padding: '6px 8px',
            background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
          }}
        />
      </div>
      {match && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}>
          {match.selected
            ? t('workforce.bestMatch', { name: match.selected.profile.name, role: match.selected.role.label })
            : t('workforce.noMatch', { reason: match.reason })}
        </div>
      )}
      <div style={{ height: 8 }} />
      {rows.length === 0 && <Muted>{t('workforce.empty')}</Muted>}
      {rows.map((r) => (
        <div key={r.key} className="cth-cv">
          <SubCard>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Chip tone={r.configured ? 'plain' : 'off'}>
                {r.configured ? t('workforce.configured') : t('workforce.inert')}
              </Chip>
              <span style={{
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}>{r.name}</span>
              {r.roleLabel && (
                <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--cth-ink-500)' }}>{r.roleLabel}</span>
              )}
            </div>
            <div style={{ marginTop: 2, fontSize: 11, color: 'var(--cth-ink-500)' }}>
              {r.configured ? r.engine : r.reason}
            </div>
            {r.configured && r.skills.length > 0 && (
              <div style={{ marginTop: 2, fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {t('workforce.skills', { list: r.skills.join(', ') })}
              </div>
            )}
          </SubCard>
        </div>
      ))}
    </Scroll>
  );
}
