'use strict';

/**
 * Phase 6 — AuditStore (design §2 "append-only JSONL, redacted", §9
 * "audit-store": cap ring, redaction — a secret never lands on disk,
 * newest-first query).
 *
 * REAL vs MOCK:
 * - REAL: `AuditStore` from src/main/audit.ts against a temp root on the real
 *   filesystem (appendFileSync / readFileSync / mkdirSync are the shipped
 *   ones), and the SAME `redactSecrets` battery from src/main/hive.ts that
 *   `record()` runs every line through.
 * - MOCK: none. Roots are `fs.mkdtempSync` directories removed per test.
 *
 * Cap-ring trimming (2 MB / 5000 events) is NOT exercised here: writing 2 MB
 * per test run is pure cost for a branch `trimIfNeeded` covers with three
 * lines; the fail-closed + redaction + query invariants are the security ones.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { AuditStore } = loadTs('src/main/audit.ts');
const { redactSecrets } = loadTs('src/main/hive.ts');

const FILE = 'audit-log.jsonl';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('record + query: events land on disk as JSONL and come back newest-first', (t) => {
  const dir = tmpRoot(t);
  const audit = new AuditStore(() => dir);

  audit.record({ kind: 'policy-decision', actor: 'agent-1', domain: 'hive-tool', action: 'Read', decision: 'allow', ruleId: 'catalog:hive-safe' });
  audit.record({ kind: 'policy-decision', actor: 'agent-1', domain: 'hive-tool', action: 'Bash', decision: 'require-approval', ruleId: 'catalog:hive-bash' });
  audit.record({ kind: 'emergency-changed', actor: 'user', decision: '{"stopped":true,"paused":false,"externalDisabled":false}' });

  const file = path.join(dir, FILE);
  assert.ok(fs.existsSync(file), 'audit-log.jsonl must exist at root');
  assert.equal(lines(file).length, 3, 'one JSONL line per event');
  for (const raw of lines(file)) assert.doesNotThrow(() => JSON.parse(raw), 'every line must be valid JSON');

  const all = audit.query();
  assert.equal(all.length, 3);
  assert.equal(all[0].kind, 'emergency-changed', 'newest event first');
  assert.equal(all[1].action, 'Bash');
  assert.equal(all[2].action, 'Read', 'oldest last');
  assert.ok(all[0].at, 'timestamped at write time');
});

test('query: kind filter is exact-equality, limit caps the newest slice', (t) => {
  const dir = tmpRoot(t);
  const audit = new AuditStore(() => dir);

  for (let i = 0; i < 3; i++) audit.record({ kind: 'policy-decision', actor: 'agent-1', action: `tool-${i}`, decision: 'allow' });
  audit.record({ kind: 'emergency-changed', actor: 'user', decision: '{"stopped":true,"paused":false,"externalDisabled":false}' });
  audit.record({ kind: 'approval-decided', actor: 'user', approvalId: 'apr-1', decision: 'approved' });

  const decisions = audit.query({ kind: 'policy-decision' });
  assert.equal(decisions.length, 3);
  assert.ok(decisions.every((e) => e.kind === 'policy-decision'), 'kind filter must be exact');

  // `kind` is equality, not substring: a partial string matches nothing …
  assert.equal(audit.query({ kind: 'policy' }).length, 0);
  // … and an unknown kind is an empty result, not an error.
  assert.deepEqual(audit.query({ kind: 'nope' }), []);

  const limited = audit.query({ kind: 'policy-decision', limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].action, 'tool-2', 'limit keeps the NEWEST events');
  assert.equal(limited[1].action, 'tool-1');
});

test('a secret in an event detail NEVER reaches disk (redacted in place)', (t) => {
  const dir = tmpRoot(t);
  const audit = new AuditStore(() => dir);

  const OPENAI_SHAPED = 'sk-live-abc123secret';
  const AWS_SHAPED = 'AKIAABCDEF1234567890';
  assert.notEqual(redactSecrets(OPENAI_SHAPED), OPENAI_SHAPED, 'fixture 1 must be secret-shaped');
  assert.notEqual(redactSecrets(AWS_SHAPED), AWS_SHAPED, 'fixture 2 must be secret-shaped');

  audit.record({ kind: 'policy-decision', actor: 'agent-1', decision: 'allow', detail: `deploy used ${OPENAI_SHAPED} and ${AWS_SHAPED}` });

  const text = fs.readFileSync(path.join(dir, FILE), 'utf8');
  assert.ok(!text.includes(OPENAI_SHAPED), 'openai-shaped secret must not be on disk');
  assert.ok(!text.includes(AWS_SHAPED), 'aws-shaped key id must not be on disk');
  assert.ok(text.includes('[redacted]'), 'the redaction placeholder must be on disk instead');

  // The event itself survives (redacted, parseable) — never silently absent.
  const [evt] = audit.query({ kind: 'policy-decision' });
  assert.ok(evt, 'the event is still recorded');
  assert.ok(!evt.detail.includes(OPENAI_SHAPED));
  assert.ok(evt.detail.includes('[redacted]'));
});

test('redaction that would break the JSON line is DROPPED (fail-closed)', (t) => {
  const dir = tmpRoot(t);
  const audit = new AuditStore(() => dir);
  const file = path.join(dir, FILE);

  audit.record({ kind: 'policy-decision', actor: 'agent-1', action: 'Read', decision: 'allow' });
  const before = lines(file).length;

  // Crafted input: the detail ends in a raw quote, so redactSecrets' labeled
  // key=value rule swallows the JSON-escaped backslash and leaves a dangling
  // `"` — the redacted line is no longer parseable.
  const crafted = { kind: 'policy-decision', actor: 'agent-1', action: 'Write', detail: 'secret: abcdef"' };
  const probe = JSON.stringify({ at: '2026-01-01T00:00:00.000Z', ...crafted });
  assert.throws(
    () => JSON.parse(redactSecrets(probe)),
    SyntaxError,
    'the fixture must genuinely break under redaction (otherwise this test proves nothing)'
  );

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    audit.record(crafted);
  } finally {
    console.error = original;
  }

  assert.equal(lines(file).length, before, 'a line redaction could not parse must NOT reach disk');
  assert.ok(
    errors.some((e) => e.includes('fail-closed')),
    'the fail-closed drop must be logged'
  );
  const kept = audit.query();
  assert.equal(kept.length, 1, 'only the clean event is queryable');
  assert.ok(kept.every((e) => e.action !== 'Write'), 'the undroppable event is gone');
});

test('a missing audit directory is created on first record', (t) => {
  const parent = tmpRoot(t);
  const nested = path.join(parent, 'deeply', 'nested', 'audit-home');
  assert.ok(!fs.existsSync(nested), 'fixture: directory must not exist yet');

  const audit = new AuditStore(() => nested);
  audit.record({ kind: 'policy-decision', actor: 'user', decision: 'allow' });

  assert.ok(fs.existsSync(nested), 'record() must mkdir -p its root');
  assert.equal(lines(path.join(nested, FILE)).length, 1);
  // Query before any record on a missing root is an empty array, not a throw.
  const empty = new AuditStore(() => path.join(parent, 'never-written'));
  assert.deepEqual(empty.query(), []);
});

test('a corrupt line in the file is skipped by query (the sink never throws)', (t) => {
  const dir = tmpRoot(t);
  const audit = new AuditStore(() => dir);
  const file = path.join(dir, FILE);

  audit.record({ kind: 'policy-decision', actor: 'agent-1', action: 'Read', decision: 'allow' });
  audit.record({ kind: 'policy-decision', actor: 'agent-1', action: 'Bash', decision: 'deny' });
  fs.appendFileSync(file, '{"at":"truncated","kind":"policy-DECI', 'utf8'); // hand-corrupted tail

  const got = audit.query();
  assert.equal(got.length, 2, 'the corrupt line is skipped, the good ones survive');
  assert.equal(got[0].action, 'Bash');
  assert.equal(got[1].action, 'Read');
  assert.ok(got.every((e) => e.decision), 'only parseable events come back');

  // Same behaviour through the kind filter (it walks the same lines).
  assert.equal(audit.query({ kind: 'policy-decision' }).length, 2);
});
