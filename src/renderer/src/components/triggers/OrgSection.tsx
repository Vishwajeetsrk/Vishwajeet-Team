import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { CLONE_NODE_BLURB, type OrgTriggerConfig, type TriggerMode } from '@shared/triggers';
import type { OrgPeer } from '@shared/teamwire';
import {
  addOrgPeer,
  getOrgTrigger,
  listOrgPeers,
  removeOrgPeer,
  sendOrgChat,
  setOrgTrigger as persistOrgTrigger
} from './api';
import { Callout, Field, Hint, ModePicker, SecretField, Toggle, MiniButton, inputStyle } from './ui';

/**
 * ORGANISATION — peer messaging between teammates' offices (PRD-11, live).
 *
 * Inbound: our teamwire listener (below) verifies each envelope against the
 * shared org key and routes it through the same webhook pipeline (history +
 * approval + dispatch). Outbound: the peers list — each row is a stored URL +
 * that teammate's key; chat goes straight there, one attempt, result recorded.
 *
 * Renders off the store mirror and follows the same mirror-then-persist rule as
 * the other sections: typing updates the mirror, commits on blur; toggle and
 * trust mode persist on the spot.
 */
export function OrgSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const { t } = useTranslation();
  const cfg = useStore((s) => s.orgTrigger);
  const mirror = useStore((s) => s.setOrgTrigger);
  const [revealed, setRevealed] = useState(false);

  // Peers are component-local: the ledger lives in config, the view refreshes
  // on demand (after add/remove/send) instead of mirroring every keystroke.
  const [peers, setPeers] = useState<OrgPeer[]>([]);
  const [listener, setListener] = useState<{ port: number; host: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [addErr, setAddErr] = useState(false);
  const [chatPeer, setChatPeer] = useState('');
  const [chatText, setChatText] = useState('');
  const [chatResult, setChatResult] = useState<string | null>(null);

  const refreshPeers = useCallback(() => {
    void listOrgPeers().then((r) => {
      if (!r) return;
      setPeers(r.peers);
      setListener({ port: r.port, host: r.host });
      setChatPeer((p) => p || (r.peers[0]?.id ?? ''));
    });
  }, []);

  useEffect(() => {
    // Only when the mirror looks unseeded — adopting unconditionally could
    // clobber a key being typed in Settings this second.
    if (useStore.getState().orgTrigger.apiKey) return;
    void getOrgTrigger().then((c) => {
      if (c && !useStore.getState().orgTrigger.apiKey) mirror(c);
    });
  }, [mirror]);

  useEffect(() => {
    refreshPeers();
  }, [refreshPeers]);

  useEffect(() => {
    onSummary?.(!cfg.apiKey.trim() ? t('orgSection.noKey') : cfg.enabled ? t('common.on') : t('common.off'));
  }, [cfg, onSummary, t]);

  const apply = (next: OrgTriggerConfig, persist = true) => {
    mirror(next);
    if (persist) persistOrgTrigger(next);
  };

  const addPeer = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    const ok = await addOrgPeer({
      name: newName.trim(),
      url: newUrl.trim(),
      ...(newSecret.trim() ? { secret: newSecret.trim() } : {})
    });
    if (!ok) {
      setAddErr(true);
      return;
    }
    setAddErr(false);
    setNewName('');
    setNewUrl('');
    setNewSecret('');
    refreshPeers();
  };

  const send = async () => {
    if (!chatPeer || !chatText.trim()) return;
    const ok = await sendOrgChat(chatPeer, chatText.trim());
    setChatResult(ok ? t('orgSection.sent') : t('orgSection.sendFailed'));
    if (ok) {
      setChatText('');
      refreshPeers();
    }
  };

  const hasKey = cfg.apiKey.trim().length > 0;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)' }}>
          {t('orgSection.acceptMessages')}
        </span>
        <Toggle on={cfg.enabled} onClick={() => apply({ ...cfg, enabled: !cfg.enabled })} />
      </div>

      <Field label={t('orgSection.key')}>
        <SecretField
          value={cfg.apiKey}
          revealed={revealed}
          onReveal={() => setRevealed((r) => !r)}
          placeholder={t('orgSection.keyPlaceholder')}
          onChange={(apiKey) => apply({ ...cfg, apiKey }, false)}
          onBlur={() => apply(cfg)}
        />
        <Hint>{CLONE_NODE_BLURB}</Hint>
      </Field>

      <Field label={t('orgSection.trust')}>
        <ModePicker value={cfg.mode} onChange={(mode: TriggerMode) => apply({ ...cfg, mode })} />
      </Field>

      <Callout tone="note">
        {t('orgSection.transportLive', { host: listener?.host ?? '', port: listener?.port ?? '' })}
      </Callout>

      {cfg.enabled && !hasKey && (
        <Callout>{t('orgSection.noKeyWarning')}</Callout>
      )}

      {/* Peers — the outbound half of the wire. */}
      <Field label={t('orgSection.peers')}>
        {peers.length === 0 && <Hint>{t('orgSection.peersEmpty')}</Hint>}
        {peers.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
              {p.name}
              <span style={{ color: 'var(--cth-ink-500)', marginLeft: 6, fontSize: 11 }}>
                {p.url.replace(/^https?:\/\//, '')}
              </span>
              {p.lastOkAt && <span style={{ color: 'var(--cth-ink-500)', marginLeft: 6, fontSize: 10 }}>✓</span>}
              {p.lastErrAt && !p.lastOkAt && <span style={{ color: 'var(--cth-ink-500)', marginLeft: 6, fontSize: 10 }}>✗</span>}
            </span>
            <MiniButton tone="danger" onClick={() => { void removeOrgPeer(p.id).then(refreshPeers); }}>
              {t('orgSection.remove')}
            </MiniButton>
          </div>
        ))}
      </Field>

      <Field label={t('orgSection.addPeer')}>
        <input
          style={{ ...inputStyle, width: '100%' }}
          value={newName}
          placeholder={t('orgSection.peerName')}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          style={{ ...inputStyle, width: '100%', marginTop: 4 }}
          value={newUrl}
          placeholder={t('orgSection.peerUrl')}
          onChange={(e) => setNewUrl(e.target.value)}
        />
        <input
          style={{ ...inputStyle, width: '100%', marginTop: 4 }}
          value={newSecret}
          placeholder={t('orgSection.peerSecret')}
          onChange={(e) => setNewSecret(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <MiniButton tone="good" onClick={() => { void addPeer(); }}>
            {t('orgSection.add')}
          </MiniButton>
          <Hint>{addErr ? t('orgSection.addError') : t('orgSection.peerSecretHint')}</Hint>
        </div>
      </Field>

      <Field label={t('orgSection.chat')}>
        {peers.length > 0 && (
          <select style={{ ...inputStyle, width: '100%' }} value={chatPeer} onChange={(e) => setChatPeer(e.target.value)}>
            {peers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <textarea
          style={{ ...inputStyle, width: '100%', marginTop: 4, minHeight: 44 }}
          value={chatText}
          placeholder={t('orgSection.chatPlaceholder')}
          onChange={(e) => setChatText(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <MiniButton tone="good" disabled={!chatPeer || !chatText.trim()} onClick={() => { void send(); }}>
            {t('orgSection.send')}
          </MiniButton>
          {chatResult && <Hint>{chatResult}</Hint>}
        </div>
        <Hint>{t('orgSection.chatNote')}</Hint>
      </Field>
    </>
  );
}
