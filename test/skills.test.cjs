'use strict';

/**
 * The skills catalog is parsed out of a hand-maintained README with no machine
 * index, so its shape is a moving target owned by someone else. These pin the
 * failures that would be SILENT: entries that stop parsing (an empty tab that
 * reads as "no skills exist") and non-entry rows leaking in as skills.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { parseCatalogMarkdown, parseSkillFrontmatter } = loadTs('src/main/skills.ts');

const MD = [
  '## 📈 Overview',
  '',
  '| Category | Skills |',        // the overview table — counts, not skills
  '|----------|--------|',
  '| 💻 Development & Code Tools | 74 |',
  '',
  '## 📄 Document Skills',
  '',
  '| Name | Description | Link |',
  '|------|-------------|------|',
  '| **docx** | Create and edit Word documents | [Source](https://github.com/anthropics/skills/tree/main/skills/docx) |',
  '| **pdf** | Extract content from PDFs | [Source](https://github.com/anthropics/skills/tree/main/skills/pdf) |',
  '',
  '## 🎨 Creative & Design',
  '',
  '| Name | Description | Link |',
  '|------|-------------|------|',
  '| **frontend-slides** | Build slide decks | [Source](https://github.com/zarazhangrui/frontend-slides) |'
].join('\n');

test('table rows parse into name, description, url and category', () => {
  const s = parseCatalogMarkdown(MD);
  assert.equal(s.length, 3);
  assert.equal(s[0].name, 'docx');
  assert.equal(s[0].description, 'Create and edit Word documents');
  assert.equal(s[0].url, 'https://github.com/anthropics/skills/tree/main/skills/docx');
  assert.equal(s[0].category, 'Document Skills');
});

test('the category emoji is stripped but the words are kept intact', () => {
  const s = parseCatalogMarkdown(MD);
  assert.equal(s[2].category, 'Creative & Design');
  assert.ok(!s.some((x) => x.category.includes('📄')));
});

test('publisher comes from the GitHub owner, since names here are bare', () => {
  const s = parseCatalogMarkdown(MD);
  assert.equal(s[0].owner, 'anthropics');
  assert.equal(s[2].owner, 'zarazhangrui');
});

test('the overview counts table does not leak in as skills', () => {
  const s = parseCatalogMarkdown(MD);
  // "74" is a count, not a skill, and its row carries no link.
  assert.ok(!s.some((x) => x.description === '74'));
  assert.ok(!s.some((x) => x.name.includes('Development & Code Tools')));
});

test('header rows and separator rules are skipped', () => {
  const s = parseCatalogMarkdown(MD);
  assert.ok(!s.some((x) => x.name === 'Name'));
  assert.ok(!s.some((x) => /^-+$/.test(x.name)));
});

test('a row without a resolvable link is dropped rather than guessed at', () => {
  const s = parseCatalogMarkdown(['## X', '| **orphan** | no link at all | TBD |'].join('\n'));
  assert.equal(s.length, 0);
});

test('SKILL.md frontmatter reads a multi-line block description whole', () => {
  const fm = parseSkillFrontmatter([
    '---',
    'name: md-audit',
    'description: |',
    '  Read-only code quality audit — scan the cwd',
    '  and return a prioritised report.',
    'version: 1.0.0',
    '---',
    '# body'
  ].join('\n'));
  assert.equal(fm.name, 'md-audit');
  assert.match(fm.description, /scan the cwd and return a prioritised report/);
});

test('inline frontmatter description and absent frontmatter both behave', () => {
  assert.equal(parseSkillFrontmatter('---\nname: x\ndescription: one liner\n---').description, 'one liner');
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter'), {});
});

test('frontmatter agents binding: flow list, single id, and block list', () => {
  const flow = parseSkillFrontmatter('---\nname: proposal\ndescription: x\nagents: [piper, jim]\n---');
  assert.deepEqual(flow.agents, ['piper', 'jim']);
  const single = parseSkillFrontmatter('---\nname: proposal\ndescription: x\nagents: piper\n---');
  assert.deepEqual(single.agents, ['piper']);
  const block = parseSkillFrontmatter([
    '---', 'name: proposal', 'description: x', 'agents:', '  - piper', '  - "jim"', '---', '# body'
  ].join('\n'));
  assert.deepEqual(block.agents, ['piper', 'jim']);
  const none = parseSkillFrontmatter('---\nname: x\ndescription: y\n---');
  assert.equal(none.agents, undefined);
});

test('a bare agents key does not swallow the next line', () => {
  const fm = parseSkillFrontmatter('---\nname: x\ndescription: y\nagents:\n---');
  assert.equal(fm.agents, undefined);
});

test('skillAppliesTo: universal by default, id-or-name match when bound', () => {
  const { skillAppliesTo } = loadTs('src/main/skills.ts');
  assert.equal(skillAppliesTo({ name: 's', boundAgents: [] }, { id: 'a1' }), true);
  assert.equal(skillAppliesTo({ name: 's' }, { id: 'a1' }), true);
  assert.equal(skillAppliesTo({ name: 's', boundAgents: ['piper'] }, { id: 'agent-7f3a', name: 'Pam' }), false);
  assert.equal(skillAppliesTo({ name: 's', boundAgents: ['pam'] }, { id: 'agent-7f3a', name: 'Pam' }), true);
  assert.equal(skillAppliesTo({ name: 's', boundAgents: ['AGENT-7F3A'] }, { id: 'agent-7f3a' }), true);
});

test('boundAgents survives the LocalSkill scan and the chip copy exists', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { listLocalSkills, skillAppliesTo } = loadTs('src/main/skills.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bind-'));
  try {
    const skillsDir = path.join(dir, '.claude', 'skills');
    fs.mkdirSync(path.join(skillsDir, 'proposal'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'proposal', 'SKILL.md'), [
      '---', 'name: proposal', 'description: How we write proposals', 'agents: [piper]', '---', '# body'
    ].join('\n'));
    fs.mkdirSync(path.join(skillsDir, 'plain'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'plain', 'SKILL.md'), '---\nname: plain\ndescription: x\n---\n');
    const rows = listLocalSkills({ cwds: [dir], bundledDir: null });
    const proposal = rows.find((r) => r.name === 'proposal');
    const plain = rows.find((r) => r.name === 'plain');
    assert.ok(proposal, 'bound skill scanned');
    assert.deepEqual(proposal.boundAgents, ['piper']);
    assert.deepEqual(plain.boundAgents, []);
    assert.equal(skillAppliesTo(proposal, { id: 'x', name: 'Piper' }), true);
    assert.equal(skillAppliesTo(proposal, { id: 'x', name: 'Jim' }), false);
    assert.equal(skillAppliesTo(plain, { id: 'x', name: 'Jim' }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const tab = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/components/SkillsTab.tsx'), 'utf8');
  assert.ok(tab.includes('skillsTab.boundTo'), 'SkillsTab must render the binding chip');
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', `src/renderer/src/i18n/locales/${loc}.json`), 'utf8'));
    assert.ok(json.skillsTab?.boundTo?.includes('{names}'), `${loc}: skillsTab.boundTo`);
  }
});
