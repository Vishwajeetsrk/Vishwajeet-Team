#!/usr/bin/env node
const { spawnSync } = require('child_process');

// Clean up any empty string code-signing environment variables so electron-builder doesn't treat them as file paths
const signingKeys = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'CSC_INSTALLER_LINK',
  'CSC_INSTALLER_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
];

for (const key of signingKeys) {
  if (process.env[key] !== undefined && !process.env[key].trim()) {
    delete process.env[key];
  }
}

// When no CSC_LINK is set, disable auto-discovery to prevent unwanted keychain lookups on CI
if (!process.env.CSC_LINK) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

const userArgs = process.argv.slice(2);
const args = ['electron-builder', ...userArgs];
console.log('[tools/package.cjs] Running:', 'npx', args.join(' '));

const result = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: true,
  env: process.env
});

if (result.error) {
  console.error('[tools/package.cjs] Execution error:', result.error);
  process.exit(1);
}
process.exit(result.status ?? 0);
