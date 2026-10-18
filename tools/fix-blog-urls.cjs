'use strict';
// Fix blog source URLs + brand so a fresh Eleventy build matches the
// rebranded docs/blog the parallel agent committed (and CI stays green).
const fs = require('fs');
const path = require('path');

const REPLACEMENTS = [
  // GitHub org/repo — old upstream paths → our fork.
  [/https:\/\/github\.com\/chaitanyagiri\/munder-difflin/g, 'https://github.com/Vishwajeetsrk/Team'],
  [/https:\/\/github\.com\/HarnessMD\/munder-difflin/g, 'https://github.com/Vishwajeetsrk/Team'],
  // Brand display names (matches the parallel agent's built-HTML sweep).
  [/Munder Difflin Blog/g, 'Vishwajeet Team Blog'],
  [/Munder Difflin, Inc\./g, 'Vishwajeet Team, Inc.'],
  [/Munder Difflin/g, 'Vishwajeet Team'],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, out);
    else if (/\.(md|njk|liquid|html|js|mjs)$/.test(e.name)) out.push(fp);
  }
  return out;
}

let changedFiles = 0;
let totalRepls = 0;

// site.js — brand + author + github social.
const sitePath = path.join('blog', 'src', '_data', 'site.js');
{
  let t = fs.readFileSync(sitePath, 'utf8');
  const before = t;
  t = t
    .replace('name: "Munder Difflin"', 'name: "Vishwajeet Team"')
    .replace('blogName: "Munder Difflin Blog"', 'blogName: "Vishwajeet Team Blog"')
    .replace('name: "Chaitanya Giri"', 'name: "Vishwajeet"')
    .replace('https://github.com/chaitanyagiri/munder-difflin', 'https://github.com/Vishwajeetsrk/Team');
  if (t !== before) {
    fs.writeFileSync(sitePath, t);
    changedFiles++;
    console.log('fixed', sitePath);
  }
}

// Posts + layouts.
for (const f of walk(path.join('blog', 'src'))) {
  if (f === sitePath) continue;
  let t = fs.readFileSync(f, 'utf8');
  const before = t;
  for (const [re, rep] of REPLACEMENTS) t = t.replace(re, rep);
  if (t !== before) {
    const n = (before.match(/chaitanyagiri|HarnessMD|Munder Difflin/g) || []).length;
    totalRepls += n;
    fs.writeFileSync(f, t);
    changedFiles++;
  }
}

console.log(`changed ${changedFiles} files, ~${totalRepls} replacements`);
