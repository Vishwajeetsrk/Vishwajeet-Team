'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  COMPUTER_LIMITS,
  validateCreateComputer,
  validateComputerRef,
  validateOpenBrowser,
  validateNavigate,
  validateUrl,
  validateWatch,
  validateDispose,
  validateConfigure,
  isComputerStatus,
} = loadTs('src/main/computerIpcValidation.ts');

// ─── validateCreateComputer ──────────────────────────────────────────────────

test('validateCreateComputer accepts a well-formed body and trims ids', () => {
  const ok = validateCreateComputer({ agentId: '  alpha  ', projectId: 'proj-1' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { agentId: 'alpha', projectId: 'proj-1' });

  const noProject = validateCreateComputer({ agentId: 'alpha' });
  assert.deepEqual(noProject.value, { agentId: 'alpha' });

  const nullProject = validateCreateComputer({ agentId: 'alpha', projectId: null });
  assert.deepEqual(nullProject.value, { agentId: 'alpha' }, 'null projectId dropped, not rejected');
});

test('validateCreateComputer rejects malformed bodies without throwing', () => {
  const cases = [
    [undefined, /body must be an object/],
    [null, /body must be an object/],
    ['alpha', /body must be an object/],
    [[], /body must be an object/],
    [{}, /agentId must be a non-empty string/],
    [{ agentId: '' }, /agentId must be a non-empty string/],
    [{ agentId: '   ' }, /agentId must be a non-empty string/],
    [{ agentId: 42 }, /agentId must be a non-empty string/],
    [{ agentId: 'a'.repeat(COMPUTER_LIMITS.id + 1) }, /exceeds/],
    [{ agentId: 'alpha', projectId: 7 }, /projectId must be a non-empty string/],
    [{ agentId: 'alpha', projectId: '' }, /projectId must be a non-empty string/],
  ];
  for (const [input, pattern] of cases) {
    const res = validateCreateComputer(input);
    assert.equal(res.ok, false, `expected failure for ${JSON.stringify(input)}`);
    assert.match(res.error, pattern);
  }
});

// ─── validateComputerRef ─────────────────────────────────────────────────────

test('validateComputerRef requires an object with a non-empty bounded id', () => {
  assert.deepEqual(validateComputerRef({ id: 'cmp-1' }), { ok: true, value: 'cmp-1' });
  assert.equal(validateComputerRef({}).ok, false);
  assert.equal(validateComputerRef({ id: '' }).ok, false);
  assert.equal(validateComputerRef({ id: 'x'.repeat(129) }).ok, false);
  assert.equal(validateComputerRef(null).ok, false);
  assert.equal(validateComputerRef('cmp-1').ok, false);
  assert.equal(validateComputerRef(['cmp-1']).ok, false);
});

// ─── validateUrl / validateOpenBrowser / validateNavigate ────────────────────

test('validateUrl allow-lists http(s)/about and bounds length', () => {
  assert.deepEqual(validateUrl('https://example.com/x'), { ok: true, value: 'https://example.com/x' });
  assert.deepEqual(validateUrl('http://localhost:5173'), { ok: true, value: 'http://localhost:5173' });
  assert.equal(validateUrl('about:blank').ok, true);

  for (const bad of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>',
    'vbscript:msgbox',
    'ftp://example.com',
    'example.com',
    '',
    '   ',
    42,
    'https://' + 'a'.repeat(COMPUTER_LIMITS.url),
  ]) {
    const res = validateUrl(bad);
    assert.equal(res.ok, false, `must reject ${JSON.stringify(bad).slice(0, 40)}`);
  }
});

test('validateOpenBrowser: id required, url optional but scheme-checked', () => {
  const bare = validateOpenBrowser({ id: 'cmp-1' });
  assert.deepEqual(bare, { ok: true, value: { id: 'cmp-1' } });

  const withUrl = validateOpenBrowser({ id: 'cmp-1', url: 'https://example.com' });
  assert.deepEqual(withUrl.value, { id: 'cmp-1', url: 'https://example.com' });

  const evil = validateOpenBrowser({ id: 'cmp-1', url: 'file:///C:/Windows/System32/cmd.exe' });
  assert.equal(evil.ok, false, 'file: scheme never reaches the browser adapter');

  assert.equal(validateOpenBrowser({ id: 'cmp-1', url: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateOpenBrowser({ url: 'https://example.com' }).ok, false, 'id always required');
});

test('validateNavigate requires a url while sharing the open-browser guard', () => {
  const ok = validateNavigate({ id: 'cmp-1', url: 'https://example.com' });
  assert.deepEqual(ok.value, { id: 'cmp-1', url: 'https://example.com' });

  const missing = validateNavigate({ id: 'cmp-1' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /url is required/);

  assert.equal(validateNavigate({ id: 'cmp-1', url: 'nope://x' }).ok, false);
  assert.equal(validateNavigate(null).ok, false);
});

// ─── validateWatch / validateDispose ─────────────────────────────────────────

test('validateWatch demands a strict boolean toggle', () => {
  assert.deepEqual(validateWatch({ id: 'cmp-1', on: true }), { ok: true, value: { id: 'cmp-1', on: true } });
  assert.deepEqual(validateWatch({ id: 'cmp-1', on: false }), { ok: true, value: { id: 'cmp-1', on: false } });
  assert.equal(validateWatch({ id: 'cmp-1', on: 'true' }).ok, false, 'string "true" must not coerce');
  assert.equal(validateWatch({ id: 'cmp-1' }).ok, false);
  assert.equal(validateWatch({ id: 'cmp-1', on: 1 }).ok, false);
  assert.equal(validateWatch({ id: 'cmp-1', on: undefined }).ok, false);
});

test('validateDispose normalizes confirm to a strict boolean (anything not true is false)', () => {
  assert.deepEqual(validateDispose({ id: 'cmp-1', confirm: true }), { ok: true, value: { id: 'cmp-1', confirm: true } });
  assert.equal(validateDispose({ id: 'cmp-1', confirm: 'yes' }).value.confirm, false, 'truthy string is NOT confirm');
  assert.equal(validateDispose({ id: 'cmp-1', confirm: 1 }).value.confirm, false);
  assert.equal(validateDispose({ id: 'cmp-1' }).value.confirm, false, 'missing confirm = refuse');
  assert.equal(validateDispose({ id: 'cmp-1', confirm: null }).value.confirm, false);
});

// ─── validateConfigure ───────────────────────────────────────────────────────

test('validateConfigure keeps only shape-checked permission caps and grant lists', () => {
  const res = validateConfigure({
    id: 'cmp-1',
    persistencePolicy: 'dispose',
    permissions: {
      agent: {
        terminalExec: false,
        browserNav: true,
        network: false,
        crossAgentRead: ['agent-2', 'agent-3'],
        unknownKey: 'DROP ME',
      },
      user: { screenControl: false, bogus: true },
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, {
    id: 'cmp-1',
    persistencePolicy: 'dispose',
    permissions: {
      agent: {
        terminalExec: false,
        browserNav: true,
        network: false,
        crossAgentRead: ['agent-2', 'agent-3'],
      },
      user: { screenControl: false },
    },
  }, 'unknown keys are dropped, known keys survive verbatim');

  // Prototype pollution attempt: __proto__ / constructor never surface.
  const polluted = validateConfigure({
    id: 'cmp-1',
    permissions: { agent: JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}') },
  });
  assert.equal(polluted.ok, true);
  assert.equal(({}).polluted, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(polluted.value.permissions.agent, '__proto__'));
  assert.ok(!Object.prototype.hasOwnProperty.call(polluted.value.permissions.agent, 'constructor'));
});

test('validateConfigure rejects wrong types, bad policies and oversized grant lists', () => {
  const cases = [
    [{ id: 'cmp-1', persistencePolicy: 'wipe' }, /retain or dispose/],
    [{ id: 'cmp-1', permissions: [] }, /permissions must be an object/],
    [{ id: 'cmp-1', permissions: 'nope' }, /permissions must be an object/],
    [{ id: 'cmp-1', permissions: { agent: 'nope' } }, /permissions.agent must be an object/],
    [{ id: 'cmp-1', permissions: { agent: { browserNav: 'yes' } } }, /must be a boolean/],
    [{ id: 'cmp-1', permissions: { agent: { crossAgentRead: 'agent-2' } } }, /array of strings/],
    [{ id: 'cmp-1', permissions: { agent: { crossAgentRead: [1, 2] } } }, /array of strings/],
    [{ id: 'cmp-1', permissions: { agent: { crossAgentWrite: new Array(33).fill('a') } } }, /exceeds 32 entries/],
    [{ id: 'cmp-1', permissions: { agent: { crossAgentRead: ['x'.repeat(129)] } } }, /over-long id/],
    [{ id: 'cmp-1', permissions: { user: { screenView: 1 } } }, /must be a boolean/],
    [{ id: 'cmp-1', permissions: { user: [] } }, /permissions.user must be an object/],
    [{ nope: 1 }, /id must be a non-empty string/],
  ];
  for (const [input, pattern] of cases) {
    const res = validateConfigure(input);
    assert.equal(res.ok, false, `expected failure for ${JSON.stringify(input).slice(0, 80)}`);
    assert.match(res.error, pattern);
  }
});

test('configure with neither permissions nor policy is a valid no-op patch', () => {
  const res = validateConfigure({ id: 'cmp-1' });
  assert.deepEqual(res, { ok: true, value: { id: 'cmp-1' } });
});

// ─── isComputerStatus ────────────────────────────────────────────────────────

test('isComputerStatus matches the shared status enum exactly', () => {
  for (const s of ['OFFLINE', 'STARTING', 'READY', 'WORKING', 'WAITING', 'PAUSED', 'USER_CONTROL', 'SLEEPING', 'STOPPING', 'ERROR']) {
    assert.equal(isComputerStatus(s), true, s);
  }
  for (const s of ['ready', 'TEAPOT', '', null, undefined, 42, {}, []]) {
    assert.equal(isComputerStatus(s), false, String(s));
  }
});
