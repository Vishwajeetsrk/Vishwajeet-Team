/**
 * PRD-4 — portable team files (one .md installs a team).
 * Gate: parse/serialize roundtrip is lossless for members; import strips and
 * REPORTS secret-shaped fields (values never reach the team); validation
 * mirrors the hire allowlists (provider/role/bundled skills); every staged
 * member goes through validateHireManifest + deliverHire (review-gated) and
 * the file path can never spawn or create a mission.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const tf = loadTs('src/shared/teamFile.ts');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const VALID = `---
spec: vishwajeet-team/file@1
name: Growth Team
members:
  - name: Pam
    description: Support specialist
    provider: claude
    role: ops
    skills: md-hive-sync, capabilities
  - name: Dev
    provider: codex
    role: engineer
---
# Growth Team playbook
freeform body ignored by the importer
`;

test('parse: valid file yields the team, members in order', () => {
  const r = tf.parseTeamFile(VALID);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.team.name, 'Growth Team');
  assert.equal(r.team.members.length, 2);
  const [pam, dev] = r.team.members;
  assert.deepEqual(pam, {
    name: 'Pam', description: 'Support specialist', provider: 'claude',
    role: 'ops', skills: ['md-hive-sync', 'capabilities']
  });
  assert.equal(dev.role, 'engineer');
  assert.deepEqual(r.strippedKeys, []);
});

test('serialize→parse roundtrip preserves every member field', () => {
  const team = tf.parseTeamFile(VALID).team;
  const back = tf.parseTeamFile(tf.serializeTeamFile(team));
  assert.equal(back.ok, true, back.errors.join('; '));
  assert.deepEqual(back.team.members, team.members);
  assert.equal(back.team.name, team.name);
});

test('import strips secret-shaped fields and reports their NAMES only', () => {
  const dirty = `---
spec: vishwajeet-team/file@1
name: Leaky
apiKey: sk-live-NEVER-STORE-ME
members:
  - name: Pam
    provider: claude
    password: hunter2
    token: abc123
---
`;
  const r = tf.parseTeamFile(dirty);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.ok(r.strippedKeys.includes('apiKey'));
  assert.ok(r.strippedKeys.includes('password'));
  assert.ok(r.strippedKeys.includes('token'));
  const serialized = JSON.stringify(r.team);
  assert.ok(!serialized.includes('NEVER-STORE-ME'), 'value never reaches the team');
  assert.ok(!serialized.includes('hunter2'));
  assert.ok(!serialized.includes('abc123'));
  // and the names come back for the review screen, never the values
  assert.ok(!r.strippedKeys.some((k) => /sk-live|hunter2|abc123/.test(k)));
});

test('stripSecrets catches nested secret keys too', () => {
  const { clean, strippedKeys } = tf.stripSecrets({
    ok: true,
    env: { GITHUB_TOKEN: 'ghp_x', SAFE: 'keep' },
    auth: { api_key: 'nope' }
  });
  assert.deepEqual(clean, { ok: true, env: { SAFE: 'keep' }, auth: {} });
  assert.ok(strippedKeys.includes('GITHUB_TOKEN'));
  assert.ok(strippedKeys.includes('api_key'));
});

test('validation rejects wrong spec, empty roster, and out-of-allowlist fields', () => {
  const bad = (body) => tf.parseTeamFile(`---\n${body}\n---\n`);
  const cases = [
    ['spec: other/spec@9\nname: T\nmembers:\n  - name: Pam', /spec must be/],
    [`spec: ${tf.TEAM_FILE_SPEC}\nname: T`, /at least one member/],
    [`spec: ${tf.TEAM_FILE_SPEC}\nname: T\nmembers:\n  - name: Pam\n    provider: evilcli`, /provider must be/],
    [`spec: ${tf.TEAM_FILE_SPEC}\nname: T\nmembers:\n  - name: Pam\n    role: hacker`, /unknown role/],
    [`spec: ${tf.TEAM_FILE_SPEC}\nname: T\nmembers:\n  - name: Pam\n    skills: ../../etc/passwd`, /not bundled/],
    [`spec: ${tf.TEAM_FILE_SPEC}\nname: T\nmembers:\n  - name: "Pam; rm -rf /"`, /name required/]
  ];
  for (const [body, re] of cases) {
    const r = bad(body);
    assert.equal(r.ok, false, body);
    assert.ok(r.errors.some((e) => re.test(e)), `${body} → ${r.errors.join('; ')}`);
  }
});

test('oversized and fence-less files are refused', () => {
  assert.equal(tf.parseTeamFile('no fences here').ok, false);
  assert.equal(tf.parseTeamFile('x'.repeat(tf.TEAM_FILE_MAX_BYTES + 1)).ok, false);
});

test('member→hire conversion runs the SAME hire validator', () => {
  const ok = tf.teamMemberToHireManifest({
    name: 'Pam', provider: 'claude', role: 'ops', skills: ['md-hive-sync']
  });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.manifest.spec, 'munder-difflin/hire@1');
  assert.equal(ok.manifest.name, 'Pam');
  assert.ok(ok.manifest.capabilities?.includes('ops'), 'role lands as a capability');
  const bad = tf.teamMemberToHireManifest({ name: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.manifest, undefined);
});

test('main wires pick/save/stage — and stage can only review, never spawn', () => {
  const main = read('src/main/index.ts');
  assert.ok(main.includes("ipcMain.handle('team:pick'"));
  assert.ok(main.includes("ipcMain.handle('team:save'"));
  assert.ok(main.includes("ipcMain.handle('team:stage'"));
  assert.ok(main.includes('deliverHire(v.manifest)'), 'stage routes through review-gated deliverHire');
  assert.ok(main.includes('teamMemberToHireManifest'), 'conversion + hire validation');
  // The handlers sit between the hire imports and the window factory; nothing
  // in the team section may spawn or touch missions.
  const teamSection = main.slice(main.indexOf("ipcMain.handle('team:pick'"), main.indexOf('function createWindow'));
  assert.ok(!/spawnAgent|missions|armMission/.test(teamSection), 'no spawn/mission in team IPC');
});

test('preload exposes the three team methods with typed results', () => {
  const pre = read('src/preload/index.ts');
  assert.ok(pre.includes('teamPick:'));
  assert.ok(pre.includes('teamSave:'));
  assert.ok(pre.includes('teamStageMember:'));
  assert.ok(pre.includes("ipcRenderer.invoke('team:pick')"));
  assert.ok(pre.includes("ipcRenderer.invoke('team:save'"));
  assert.ok(pre.includes("ipcRenderer.invoke('team:stage'"));
});

test('WorkersTab exports the roster, previews an import, stages per-member', () => {
  const tab = read('src/renderer/src/components/WorkersTab.tsx');
  assert.ok(tab.includes('serializeTeamFile'), 'export builds from the live roster');
  assert.ok(tab.includes("window.cth.teamSave"), 'export saves via dialog');
  assert.ok(tab.includes("window.cth.teamPick()"), 'import picks a file');
  assert.ok(tab.includes('teamPreview'), 'review screen state');
  assert.ok(tab.includes('teamPreview.strippedKeys'), 'stripped keys surfaced');
  assert.ok(tab.includes('teamPreview.team.members.map'), 'members listed for review');
  assert.ok(tab.includes('stageMember(m)'), 'per-member Hire button');
  assert.ok(tab.includes('!a.isGod'), 'the orchestrator is never exported');
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    for (const k of ['teamTitle', 'teamIntro', 'teamExport', 'teamImport', 'teamExported',
      'teamFailed', 'teamEmptyRoster', 'teamStripped', 'teamPausedNote', 'teamHire',
      'teamStaging', 'teamDismiss']) {
      assert.ok(json.workersTab?.[k], `${loc}: workersTab.${k}`);
    }
  }
});
