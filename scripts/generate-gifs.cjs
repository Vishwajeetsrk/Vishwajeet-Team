const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const demos = [
  { in: 'docs/media/hero.mp4', out: 'docs/media/hero.gif', scale: 640, dur: 6 },
  { in: 'docs/media/demo/agent-cards.mp4', out: 'docs/media/demo/agent-cards.gif', scale: 520, dur: 6 },
  { in: 'docs/media/demo/orchestrator.mp4', out: 'docs/media/demo/orchestrator.gif', scale: 520, dur: 6 },
  { in: 'docs/media/demo/hire-agent.mp4', out: 'docs/media/demo/hire-agent.gif', scale: 520, dur: 6 },
  { in: 'docs/media/demo/memory.mp4', out: 'docs/media/demo/memory.gif', scale: 520, dur: 6 },
  { in: 'docs/media/demo/autonomy.mp4', out: 'docs/media/demo/autonomy.gif', scale: 520, dur: 6 },
  { in: 'docs/media/demo/agents.mp4', out: 'docs/media/demo/agents.gif', scale: 520, dur: 6 },
  { in: 'docs/media/demo/setup.mp4', out: 'docs/media/demo/setup.gif', scale: 520, dur: 6 }
];

for (const d of demos) {
  const inPath = path.join(root, d.in);
  const outPath = path.join(root, d.out);
  if (!fs.existsSync(inPath)) {
    console.warn(`Skipping missing ${inPath}`);
    continue;
  }
  console.log(`Rendering ${d.out}...`);
  const vf = `fps=12,scale=${d.scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`;
  const cmd = `ffmpeg -y -i "${inPath}" -vf "${vf}" -t ${d.dur} "${outPath}"`;
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✓ Created ${d.out} (${Math.round(fs.statSync(outPath).size / 1024)} KB)`);
}
console.log('All animated GIF previews generated successfully!');
