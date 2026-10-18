'use strict';

/**
 * Phase 6 — Security bypass removal (design §5 "autoMode no longer arms the
 * shim", §7 "the supervisor grants nothing").
 *
 * REAL vs MOCK:
 * - REAL: `autoApproveEnv` from src/shared/actionPolicy.ts (the shipped gate),
 *   plus SOURCE text of the shipped src/main/index.ts and
 *   src/shared/actionPolicy.ts.
 * - MOCK: none. The three autoMode-sensitive postures are grepped in the
 *   source the build actually uses — a regression back to `cfg.autoMode` alone
 *   fails here even if unit tests pass.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { autoApproveEnv } = loadTs('src/shared/actionPolicy.ts');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
const POLICY = fs.readFileSync(path.join(ROOT, 'src/shared/actionPolicy.ts'), 'utf8');

test('autoApproveEnv truth table: autoMode alone never arms the shim', () => {
  assert.equal(autoApproveEnv(true, true), true, 'both opt-ins required — only all-true arms');
  assert.equal(autoApproveEnv(true, false), false, 'autoMode without the security flag');
  assert.equal(autoApproveEnv(true, undefined), false, 'autoMode with no security config');
  assert.equal(autoApproveEnv(false, true), false, 'security flag without autoMode');
  assert.equal(autoApproveEnv(false, undefined), false, 'both off');
  assert.equal(autoApproveEnv(false, false), false);
});

test('index.ts: every autoMode-sensitive posture goes through autoApproveEnv', () => {
  // The three postures the design names: argsWithAutoModeFlag (CLI harness
  // auto-approve flag), HIVE_AUTO_APPROVE (pi shim), oc.permission
  // (OpenCode allow-block). None may key off cfg.autoMode directly.
  const modePosture = /(?:HIVE_AUTO_APPROVE\s*=|argsWithAutoModeFlag\(|oc\.permission\s*=)/g;
  const hits = [...INDEX.matchAll(modePosture)];
  assert.ok(hits.length >= 3, `expected at least the three posture sites, found ${hits.length}`);

  for (const hit of hits) {
    const start = hit.index;
    // Look back a few lines for the statement that produced this expression.
    const window = INDEX.slice(Math.max(0, start - 300), start + 200);
    assert.match(
      window,
      /autoApproveEnv\(/,
      `posture near offset ${start} must consult autoApproveEnv — raw cfg.autoMode alone is a Phase 6 regression:\n${window}`
    );
  }

  // Belt and braces: no statement in index.ts assigns a posture from bare
  // cfg.autoMode (the .autoMode field may still be read for UI display).
  assert.doesNotMatch(
    INDEX,
    /=\s*cfg\.autoMode\s*\?/,
    'an assignment gated on bare cfg.autoMode is the bypass the design removed'
  );
  assert.doesNotMatch(
    INDEX,
    /argsWithAutoModeFlag\(\s*[^,]+,\s*cfg\.autoMode\b/,
    'argsWithAutoModeFlag must receive autoApproveEnv(...) as its second arg, not cfg.autoMode'
  );
  assert.doesNotMatch(
    INDEX,
    /if\s*\(\s*cfg\.autoMode\s*\)\s*oc\.permission/,
    'oc.permission allow-block must be gated on autoApproveEnv, not cfg.autoMode'
  );
});

test('actionPolicy.ts is pure: no electron, no fs, no config import (grants nothing)', () => {
  // Strip block + line comments so prose ("no electron, no fs") can't mask code.
  const code = POLICY
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /from\s+['"]electron['"]/, 'no electron import');
  assert.doesNotMatch(code, /from\s+['"]node:fs['"]|require\(['"]node:fs['"]\)/, 'no fs import');
  assert.doesNotMatch(code, /\bwriteConfig\b|\breadConfig\b/, 'the pure evaluator never reads or writes user config');
  assert.doesNotMatch(code, /import[^\n]*config/i, 'no config-shaped import');
  // The module exports the evaluator + autoApproveEnv + EMERGENCY_OFF only
  // through its public surface — it has no mutation of global state.
  assert.doesNotMatch(code, /\bglobalThis\b|\bprocess\.env\b/, 'no ambient process reads');
});
