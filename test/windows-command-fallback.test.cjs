'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { resolveCommand, windowsFallbackCandidates } = loadTs('src/main/shellEnv.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

const WINDOWS_ENV = {
  APPDATA: 'C:\\Users\\Tester\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\Tester'
};

function genericCandidates(command, env = WINDOWS_ENV) {
  const appData = env.APPDATA ?? '';
  const localAppData = env.LOCALAPPDATA ?? '';
  const home = env.USERPROFILE ?? env.HOME ?? '';
  return [
    `${appData}\\npm\\${command}.cmd`,
    `${appData}\\npm\\${command}`,
    `${localAppData}\\Programs\\claude\\${command}.exe`,
    `${home}\\.claude\\local\\${command}.cmd`,
    `${home}\\.claude\\local\\${command}`
  ];
}

test('agy adds its official LOCALAPPDATA location after existing fallbacks', () => {
  assert.deepEqual(windowsFallbackCandidates('agy', WINDOWS_ENV), [
    ...genericCandidates('agy'),
    'C:\\Users\\Tester\\AppData\\Local\\agy\\bin\\agy.exe'
  ]);
});

test('Antigravity fallback lookup normalizes command case and an exe suffix', () => {
  for (const command of ['AGY', 'agy.exe', 'AGY.EXE']) {
    assert.equal(
      windowsFallbackCandidates(command, WINDOWS_ENV).at(-1),
      'C:\\Users\\Tester\\AppData\\Local\\agy\\bin\\agy.exe',
      command
    );
  }
});

test('fallbacks do not map agy to the unverified antigravity.cmd launcher', () => {
  assert.ok(
    windowsFallbackCandidates('agy', WINDOWS_ENV).every((candidate) => !candidate.endsWith('antigravity.cmd'))
  );
});

test('Codex, OpenCode, and Claude retain the existing generic fallback order', () => {
  for (const command of ['codex', 'opencode', 'claude']) {
    assert.deepEqual(windowsFallbackCandidates(command, WINDOWS_ENV), genericCandidates(command));
  }
});

test('missing or invalid LOCALAPPDATA does not add an Antigravity candidate', () => {
  for (const localAppData of [
    undefined,
    '',
    'relative-path',
    '\\Users\\Tester\\AppData\\Local',
    '/c/Users/Tester/AppData/Local'
  ]) {
    const env = { ...WINDOWS_ENV, LOCALAPPDATA: localAppData };
    assert.deepEqual(windowsFallbackCandidates('agy', env), genericCandidates('agy', env));
  }
});

test('Antigravity fallback preserves spaces and Unicode in LOCALAPPDATA', () => {
  for (const localAppData of [
    'C:\\Users\\Test User\\AppData\\Local',
    'C:\\使用者\\測試\\AppData\\Local',
    '\\\\server\\share\\Profile'
  ]) {
    const candidates = windowsFallbackCandidates('agy', { ...WINDOWS_ENV, LOCALAPPDATA: localAppData });
    assert.equal(candidates.at(-1), path.win32.join(localAppData, 'agy', 'bin', 'agy.exe'));
  }
});

test('resolveCommand finds agy in its Windows LOCALAPPDATA install location', { skip: process.platform !== 'win32' }, (t) => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-agy-'));
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-agy-appdata-'));
  const userProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-agy-home-'));
  const executable = path.join(localAppData, 'agy', 'bin', 'agy.exe');
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousAppData = process.env.APPDATA;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPath = process.env.PATH;

  t.after(() => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(localAppData, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(userProfile, { recursive: true, force: true });
  });

  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '');
  // Isolate every env root the fallback list consults, so a real agy install on
  // the host (e.g. %APPDATA%\npm\agy.cmd) cannot shadow the LOCALAPPDATA target.
  process.env.LOCALAPPDATA = localAppData;
  process.env.APPDATA = appData;
  process.env.USERPROFILE = userProfile;
  process.env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

  assert.equal(resolveCommand('agy'), executable);
  assert.equal(new PtyManager().commandPath('agy'), executable);
});
