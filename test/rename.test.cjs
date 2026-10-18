/**
 * Rename — "Vishwajeet Team [AI Company]".
 * The product surfaces carry the new name; protocol identifiers, on-disk data
 * paths and upstream attribution deliberately keep the old ones (deep links,
 * codex session dirs, hire spec ids and The Office parody notice must not
 * break or misattribute). This test pins both halves so neither drifts.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const FULL = 'Vishwajeet Team [AI Company]';

test('package identity carries the new name', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'vishwajeet-team');
  assert.equal(pkg.productName, FULL);
  assert.equal(pkg.author, 'Vishwajeet');
  assert.equal(pkg.homepage, 'https://github.com/Vishwajeetsrk/Team');
});

test('installer metadata carries the new name and clean artifact names', () => {
  const yml = read('electron-builder.yml');
  assert.ok(yml.includes(`productName: ${FULL}`));
  assert.ok(yml.includes('appId: com.vishwajeetsrk.team'));
  assert.ok(yml.includes('shortcutName: Vishwajeet Team'));
  assert.ok(yml.includes('artifactName: Vishwajeet-Team-${version}-win-x64-setup.exe'));
  assert.ok(yml.includes('artifactName: Vishwajeet-Team-${version}-win-x64-portable.exe'));
  assert.ok(yml.includes('Vishwajeet-Team-${version}-mac-${arch}'));
  assert.ok(yml.includes('Vishwajeet-Team-${version}-linux-x86_64.AppImage'));
  assert.ok(yml.includes('owner: Vishwajeetsrk') && yml.includes('repo: Team'),
    'publish still points at your repo');
  // Scheme stays for back-compat with existing munderdifflin:// deep links.
  assert.ok(yml.includes('- munderdifflin'), 'URL scheme unchanged');
  assert.ok(!yml.includes('Munder-Difflin-'), 'no old artifact names left');
});

test('window title and splash carry the new name', () => {
  const main = read('src/main/index.ts');
  assert.ok(main.includes(`title: isFloor ? '${FULL} — Floor' : '${FULL}'`),
    'window title');
  const html = read('src/renderer/index.html');
  assert.ok(html.includes(`<title>${FULL}</title>`));
  assert.ok(html.includes('<div class="title">VISHWAJEET TEAM</div>'));
  assert.ok(html.includes('<div class="mk">VT</div>'), 'splash monogram');
});

test('updater polls YOUR repo and names YOUR artifacts', () => {
  const upd = read('src/shared/updateState.ts');
  assert.ok(upd.includes("REPO = 'Vishwajeetsrk/Team'"), 'shared REPO');
  assert.ok(upd.includes('Vishwajeet-Team-${v}-win-x64-setup.exe'), 'installerUrl');
  assert.ok(upd.includes('Vishwajeet-Team-${v}-mac-${arch}.dmg'));
  assert.ok(upd.includes('Vishwajeet-Team-${v}-linux-x86_64.AppImage'));
  const main = read('src/main/updater.ts');
  assert.ok(main.includes("const REPO = 'Vishwajeetsrk/Team'"), 'main-side REPO aligned');
  assert.ok(!upd.includes('chaitanyagiri') && !main.includes('chaitanyagiri'),
    'no upstream repo left in the update path');
});

test('locales carry the new brand, upstream Pro copy untouched', () => {
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const raw = read(`src/renderer/src/i18n/locales/${loc}.json`);
    const json = JSON.parse(raw);
    assert.ok(json.onboarding?.titles?.persona?.includes('VISHWAJEET TEAM'),
      `${loc} onboarding welcome`);
    assert.ok(json.onboarding?.persona?.body?.includes('Vishwajeet Team'), `${loc} persona body`);
    assert.ok(json.updatesSection?.downloadedDetail?.includes('Vishwajeet Team'), `${loc} update copy`);
    assert.ok(json.triggersTab?.organisationBlurb?.includes('Vishwajeet Team'), `${loc} org blurb`);
    // PRD-9/branding direction (DECIDED by Vishwajeet 2026-10-18): the hero card
    // carries the free-forever banner in every language. The historical Pro
    // launch copy was allowed to keep the upstream name ONLY while it still
    // rendered; the handoff rewrote it, so the pin now asserts its ABSENCE plus
    // the new banner, so no sales copy can sneak back.
    const heroCopy = json.settingsHero ?? {};
    const heroText = Object.values(heroCopy).filter((v) => typeof v === 'string').join(' ');
    assert.ok(!/munder difflin pro|50% off|founders' wall\?/i.test(heroText), `${loc} no Pro sales banner`);
    assert.ok(/free/i.test(heroCopy.proLaunch ?? ''), `${loc} hero copy is the free banner`);
  }
});

test('identifiers that must NOT change still carry the old token', () => {
  // Protocol + spec + on-disk paths: renaming these breaks deep links, hire
  // manifests and existing session dirs.
  const hire = read('src/shared/hire.ts');
  assert.ok(hire.includes("'munder-difflin/hire@1'"), 'hire spec id');
  const hive = read('src/main/hive.ts');
  assert.ok(hive.includes('munder-difflin-'), 'named-pipe prefix');
  const readme = read('README.md');
  assert.ok(readme.includes('# Vishwajeet Team [AI Company]'), 'README heading');
  assert.ok(readme.includes('*Munder Difflin* is an affectionate parody'),
    'parody attribution kept');
});
