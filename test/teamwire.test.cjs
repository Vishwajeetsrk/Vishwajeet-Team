/**
 * PRD-11 — teamwire: the free cross-office transport.
 * Gates: the signing/verify math is exact (Slack's scheme over our headers);
 * a wrong key, replayed or drifted ts, and any oversized junk earn the same
 * "no"; envelopes validate whole-or-not-at-all; peers sanitize wholesale; the
 * ledger accepts a 'teams' source; the org surface routes inbound through the
 * EXISTING webhook pipeline (history + approval), never a new one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => require('node:fs').readFileSync(path.join(root, p), 'utf8');
const tw = require('./load-ts.cjs')('src/shared/teamwire.ts');

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-10-18T12:00:00.000Z').getTime();

test('sign/verify: exact happy path, and every cheat earns the same no', () => {
  const body = JSON.stringify({ v: 1, text: 'hi' });
  const ts = String(NOW);
  const sig = tw.signTeamwire(SECRET, NOW, body);
  assert.equal(sig.length, 64);
  assert.ok(tw.verifyTeamwire(SECRET, ts, sig, body, NOW));
  // Wrong secret.
  assert.ok(!tw.verifyTeamwire('b'.repeat(32), ts, sig, body, NOW));
  // Tampered body.
  assert.ok(!tw.verifyTeamwire(SECRET, ts, sig, body + ' ', NOW));
  // Replay beyond the window (6 minutes old).
  assert.ok(!tw.verifyTeamwire(SECRET, String(NOW - 6 * 60_000), tw.signTeamwire(SECRET, NOW - 6 * 60_000, body), body, NOW));
  // Far-future ts (drift probe) — just as dead as a stale one.
  assert.ok(!tw.verifyTeamwire(SECRET, String(NOW + 6 * 60_000), sig, body, NOW));
  // Junk shapes: not-13-digit ts, non-hex sig, short sig, missing headers.
  assert.ok(!tw.verifyTeamwire(SECRET, '1234', sig, body, NOW));
  assert.ok(!tw.verifyTeamwire(SECRET, ts, 'zz' + sig.slice(2), body, NOW));
  assert.ok(!tw.verifyTeamwire(SECRET, ts, 'abc', body, NOW));
  assert.ok(!tw.verifyTeamwire(SECRET, undefined, sig, body, NOW));
  // The signing input is deterministic — same ts + body, same bytes.
  assert.equal(tw.teamwireSigningInput(NOW, body), `${NOW}.${body}`);
});

test('envelope validation: whole-or-nothing, no partial adoption', () => {
  const mk = (over = {}) => ({ v: 1, from: { id: 'p1', name: 'Ada' }, kind: 'chat', text: 'hello', sentAt: NOW, ...(typeof over === 'object' ? over : {}) });
  const good = tw.validateTeamwireEnvelope(mk(), NOW);
  assert.ok(good.ok);
  assert.equal(good.ok ? good.envelope.text : '', 'hello');
  const fail = (over, reason) => {
    const r = tw.validateTeamwireEnvelope(mk(over), NOW);
    assert.ok(!r.ok, 'expected reject: ' + reason);
    assert.equal(r.reason, reason);
  };
  fail({ v: 2 }, 'version');
  fail({ from: undefined }, 'from');
  fail({ from: { id: 'x'.repeat(33), name: 'Ada' } }, 'from.id');
  fail({ from: { id: 'p1', name: 'x'.repeat(61) } }, 'from.name');
  fail({ kind: 'deploy' }, 'kind');
  fail({ text: '' }, 'text');
  fail({ text: 'x'.repeat(4001) }, 'text');
  fail({ sentAt: NOW - 6 * 60_000 }, 'sentAt');
  assert.ok(!tw.validateTeamwireEnvelope('nope', NOW).ok);
  assert.ok(!tw.validateTeamwireEnvelope(undefined, NOW).ok);
  // Name trims, text caps survive at 4000.
  const trim = tw.validateTeamwireEnvelope(mk({ text: 'x'.repeat(4000) }), NOW);
  assert.ok(trim.ok);
});

test('peer hygiene: unusable rows cannot reach the transport', () => {
  const good = tw.sanitizeOrgPeer({ id: 'peer-1', name: '  Ada  ', url: 'http://office-b:3846/teamwire/x', secret: 's'.repeat(24), junk: 'drop-me', lastOkAt: 5 }, 'peer-1');
  assert.ok(good);
  assert.equal(good.name, 'Ada');
  assert.equal(good.url, 'http://office-b:3846/teamwire/x');
  assert.equal(good.secret, 's'.repeat(24));
  assert.ok(!('junk' in good));
  // Bad rows die whole: no url, non-http scheme, junk row.
  assert.ok(!tw.sanitizeOrgPeer({ id: 'p', name: 'x', url: 'ftp://nope' }, 'p'));
  assert.ok(!tw.sanitizeOrgPeer({ id: 'p', name: 'x', url: 'javascript:alert(1)' }, 'p'));
  assert.ok(!tw.sanitizeOrgPeer({ id: 'p', name: 'x', url: 'not a url' }, 'p'));
  assert.ok(!tw.sanitizeOrgPeer('nope', 'p'));
  // URL normalizes scheme/host case; no phantom trailing slash is invented.
  const norm = tw.sanitizeOrgPeer({ id: 'p2', name: 'x', url: 'hTtPs://host/path', secret: 'short' }, 'p2');
  assert.equal(norm && norm.url, 'https://host/path');
  assert.ok(norm && !norm.secret);
  // Minted secrets are hex 48 chars.
  assert.match(tw.mintPeerSecret(), /^[0-9a-f]{48}$/);
});

test('the ledger accepts a teamwire source; clear knows it too', () => {
  assert.match(read('src/shared/triggers.ts'), /source: 'webhook' \| 'org' \| 'teams'/);
  assert.match(read('src/main/triggerHistory.ts'), /e\.source === 'webhook' \|\| e\.source === 'org' \|\| e\.source === 'teams'/);
  assert.match(read('src/main/triggerHistory.ts'), /clearTriggerHistory\(source\?: 'webhook' \| 'org' \| 'teams'\)/);
});

test('teamwire wiring: shared-key listener, webhook-pipeline reuse, live reconcile', () => {
  const main = read('src/main/teamwire.ts');
  assert.ok(main.includes('class TeamwireHub'));
  assert.ok(main.includes("verifyTeamwire(secret, tsHeader, sigHeader, body"));
  assert.ok(main.includes('getSecret: () =>'));
  assert.ok(main.includes('sendTeamChat'));
  assert.ok(main.includes('randomBytes' ) === false); // minting stays in shared
  // Index: inbound rides the EXISTING pipeline with the org mode + 'teams' source.
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes("ipcMain.handle('org:setTrigger'"));
  assert.ok(idx.includes('reconcileTeamwireHub();'));
  assert.ok(idx.includes("guardMode(org.mode),"));
  assert.match(idx, /'teams'\r?\n {2}\);/);
  assert.ok(idx.includes("ipcMain.handle('org:listPeers'"));
  assert.ok(idx.includes("ipcMain.handle('org:addPeer'"));
  assert.ok(idx.includes("ipcMain.handle('org:removePeer'"));
  assert.ok(idx.includes("ipcMain.handle('org:sendChat'"));
  assert.ok(idx.includes("source: 'teams',"));
  assert.ok(idx.includes("const source = arg === 'webhook' || arg === 'org' || arg === 'teams' ? arg : undefined;"));
  // Boot re-arm + move recovery.
  assert.ok(idx.includes('// Teamwire (PRD-11) re-arms'));
  assert.ok(idx.match(/reconcileTeamwireHub\(\);\s*\n\s*return \{ ok: false, error: `Could not copy data/));
  // Preload crosses the bridge.
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes("ipcRenderer.invoke('org:listPeers')"));
  assert.ok(pre.includes("ipcRenderer.invoke('org:sendChat'"));
  assert.ok(pre.includes("clearTriggerHistory: (source?: 'webhook' | 'org' | 'teams')"));
  // Renderer surface.
  const org = read('src/renderer/src/components/triggers/OrgSection.tsx');
  assert.ok(org.includes('listOrgPeers()'));
  assert.ok(org.includes('sendOrgChat('));
  const api = read('src/renderer/src/components/triggers/api.ts');
  assert.ok(api.includes('listOrgPeers'));
  const tab = read('src/renderer/src/components/triggers/TriggerHistoryTab.tsx');
  assert.ok(tab.includes("key: 'teams'"));
  // NO paywall in the row.
  for (const f of ['src/shared/teamwire.ts', 'src/main/teamwire.ts']) {
    const s = read(f);
    for (const banned of ['pro-user', 'upgrade', 'subscription', 'sign-in', 'licence needed']) {
      assert.ok(!s.includes(banned), f + ' must not contain: ' + banned);
    }
  }
});
