'use strict';

/**
 * Phase 5 — pure IPC validators for the `memory:*` surface.
 *
 * REAL vs MOCK:
 * - REAL: `memoryIpcValidation.ts` (validateMemoryWrite / validateMemoryQuery /
 *   validateMemoryRef / validateMemoryEdit / MEMORY_LIMITS) and the shared
 *   constants in `src/shared/memoryRecord.ts`. No Electron, no service, no repo.
 * - MOCK: none — these functions are dependency-free by construction; this file
 *   deliberately never touches MemoryService (that is memory-pipeline/scopes).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  MEMORY_LIMITS, validateMemoryWrite, validateMemoryQuery, validateMemoryRef, validateMemoryEdit,
} = loadTs('src/main/memoryIpcValidation.ts');
const { MEMORY_CONTENT_MAX, MEMORY_SCOPES, MEMORY_TYPES, MEMORY_STATUSES } = loadTs('src/shared/memoryRecord.ts');

/** A fully valid write body — every other case is derived by mutating one field. */
function body(overrides = {}) {
  return {
    scope: 'global',
    type: 'fact',
    content: 'the office prefers concise status updates',
    projectId: null,
    agentId: null,
    taskId: null,
    computerId: null,
    importance: null,
    confidence: null,
    expiresAt: null,
    ...overrides,
  };
}

test('validateMemoryWrite: accepts a valid body and passes values through unchanged', () => {
  const raw = body({
    scope: 'project', type: 'decision', projectId: 'proj-1',
    importance: 4, confidence: 0.8, expiresAt: 1_800_000_000_000,
  });
  const res = validateMemoryWrite(raw);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.value, {
    scope: 'project',
    type: 'decision',
    content: raw.content,
    projectId: 'proj-1',
    agentId: null,
    taskId: null,
    computerId: null,
    importance: 4,
    confidence: 0.8,
    expiresAt: 1_800_000_000_000,
  });
});

test('validateMemoryWrite: scope and type must be known enums', () => {
  const badScope = validateMemoryWrite(body({ scope: 'universe' }));
  assert.equal(badScope.ok, false);
  assert.match(badScope.error, /^scope must be one of: /);
  assert.match(badScope.error, new RegExp(MEMORY_SCOPES.join(', ')));

  const badType = validateMemoryWrite(body({ type: 'gossip' }));
  assert.equal(badType.ok, false);
  assert.match(badType.error, /^type must be one of: /);
  assert.match(badType.error, new RegExp(MEMORY_TYPES.join(', ')));

  assert.equal(validateMemoryWrite(body({ scope: 42 })).ok, false, 'non-string scope rejected');
  assert.equal(validateMemoryWrite(body({ type: null })).ok, false, 'null type rejected');
  assert.equal(validateMemoryWrite('nope').ok, false, 'non-object body rejected');
  assert.equal(validateMemoryWrite([]).ok, false, 'array body rejected');
  assert.equal(validateMemoryWrite(null).ok, false, 'null body rejected');
});

test('validateMemoryWrite: content bounds (empty / non-string / over MEMORY_CONTENT_MAX)', () => {
  const empty = validateMemoryWrite(body({ content: '   ' }));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /content must be at least 1 character/);

  const notString = validateMemoryWrite(body({ content: 12345 }));
  assert.equal(notString.ok, false);
  assert.match(notString.error, /content must be a string/);

  const over = validateMemoryWrite(body({ content: 'x'.repeat(MEMORY_LIMITS.content + 1) }));
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(`content exceeds ${MEMORY_LIMITS.content} characters`));

  const atMax = validateMemoryWrite(body({ content: 'y'.repeat(MEMORY_LIMITS.content) }));
  assert.equal(atMax.ok, true, 'exactly at the limit is allowed');
  assert.equal(MEMORY_LIMITS.content, MEMORY_CONTENT_MAX, 'limit mirrors the shared constant');
});

test('validateMemoryWrite: each scope demands its primary reference', () => {
  // global → owner is derived as 'system'; no reference required.
  assert.equal(validateMemoryWrite(body({ scope: 'global' })).ok, true);

  const cases = [
    { scope: 'project', primary: 'projectId', value: 'proj-1' },
    { scope: 'agent', primary: 'agentId', value: 'agent-1' },
    { scope: 'task', primary: 'taskId', value: 'plan-1' },
    { scope: 'computer', primary: 'computerId', value: 'cmp-1' },
  ];
  for (const { scope, primary, value } of cases) {
    const missing = validateMemoryWrite(body({ scope, [primary]: null }));
    assert.equal(missing.ok, false, `${scope} without ${primary} must fail`);
    assert.equal(missing.error, `${primary} is required for scope '${scope}'`);

    const blank = validateMemoryWrite(body({ scope, [primary]: '   ' }));
    assert.equal(blank.ok, false, `${scope} with blank ${primary} must fail`);
    assert.match(blank.error, new RegExp(`^${primary} (is required for scope|must be at least 1 character)`),
      `unexpected blank-ref error: ${blank.error}`);

    const wrongType = validateMemoryWrite(body({ scope, [primary]: 7 }));
    assert.equal(wrongType.ok, false, `${scope} with numeric ${primary} must fail`);

    const ok = validateMemoryWrite(body({ scope, [primary]: value }));
    assert.equal(ok.ok, true, `${scope} with its ${primary} must pass: ${ok.error}`);
    assert.equal(ok.value[primary], value);
    // The other references stay null — a renderer payload can't smuggle extras.
    for (const other of ['projectId', 'agentId', 'taskId', 'computerId']) {
      if (other !== primary && scope !== 'global') assert.equal(ok.value[other], null, `${other} not smuggled into ${scope}`);
    }
  }
});

test('validateMemoryWrite: importance 0..5 integer, confidence 0..1, expiresAt epoch-ms', () => {
  for (const good of [0, 1, 2, 3, 4, 5]) {
    assert.equal(validateMemoryWrite(body({ importance: good })).ok, true, `importance ${good} accepted`);
  }
  for (const bad of [6, -1, 1.5, '3', Number.NaN]) {
    const res = validateMemoryWrite(body({ importance: bad }));
    assert.equal(res.ok, false, `importance ${bad} rejected`);
    assert.match(res.error, /importance must be (a number|an integer 0\.\.5)/);
  }
  assert.equal(validateMemoryWrite(body({ importance: null })).ok, true, 'null importance = default');

  for (const good of [0, 0.5, 1]) {
    assert.equal(validateMemoryWrite(body({ confidence: good })).ok, true, `confidence ${good} accepted`);
  }
  for (const bad of [1.5, -0.2, '0.9', Number.POSITIVE_INFINITY]) {
    const res = validateMemoryWrite(body({ confidence: bad }));
    assert.equal(res.ok, false, `confidence ${bad} rejected`);
    assert.match(res.error, /confidence must be (a number|within 0\.\.1)/);
  }

  assert.equal(validateMemoryWrite(body({ expiresAt: null })).ok, true, 'null expiresAt = keep forever');
  assert.equal(validateMemoryWrite(body({ expiresAt: undefined })).ok, true, 'omitted expiresAt = keep forever');
  assert.equal(validateMemoryWrite(body({ expiresAt: 1_900_000_000_000 })).ok, true);
  for (const bad of [0, -5, 'tomorrow', Number.NaN]) {
    const res = validateMemoryWrite(body({ expiresAt: bad }));
    assert.equal(res.ok, false, `expiresAt ${bad} rejected`);
    assert.match(res.error, /expiresAt must be (a positive epoch-ms number|an epoch-ms number or null)/);
  }
});

test('validateMemoryQuery: forgiving defaults, strict ranges', () => {
  assert.deepEqual(validateMemoryQuery(undefined).value, {}, 'undefined → {}');
  assert.deepEqual(validateMemoryQuery(null).value, {}, 'null → {}');
  const notObject = validateMemoryQuery(['x']);
  assert.equal(notObject.ok, false);
  assert.match(notObject.error, /query must be an object/);

  const full = validateMemoryQuery({
    query: 'deploy rollback', scope: 'project', status: 'active', type: 'fact',
    projectId: 'proj-1', agentId: 'agent-1', taskId: 'plan-1',
    limit: 25, budgetChars: 900,
  });
  assert.equal(full.ok, true, full.error);
  assert.equal(full.value.limit, 25);

  assert.equal(validateMemoryQuery({ status: 'all' }).ok, true, "'all' is the UI-only wildcard");
  for (const st of MEMORY_STATUSES) {
    assert.equal(validateMemoryQuery({ status: st }).ok, true, `status ${st} accepted`);
  }
  assert.equal(validateMemoryQuery({ status: 'zombie' }).ok, false);
  assert.match(validateMemoryQuery({ status: 'zombie' }).error, /status must be one of: .* or 'all'/);
  assert.equal(validateMemoryQuery({ scope: 'universe' }).ok, false);
  assert.equal(validateMemoryQuery({ type: 'gossip' }).ok, false);
  assert.equal(validateMemoryQuery({ projectId: 42 }).ok, false, 'ref fields must be strings or null');
  assert.equal(validateMemoryQuery({ query: 'x'.repeat(MEMORY_LIMITS.query + 1) }).ok, false);
  assert.match(validateMemoryQuery({ query: 'x'.repeat(MEMORY_LIMITS.query + 1) }).error, /query exceeds 200 characters/);

  assert.equal(validateMemoryQuery({ limit: 1 }).ok, true);
  assert.equal(validateMemoryQuery({ limit: MEMORY_LIMITS.limit }).ok, true);
  for (const bad of [0, MEMORY_LIMITS.limit + 1, 2.5, '10']) {
    const res = validateMemoryQuery({ limit: bad });
    assert.equal(res.ok, false, `limit ${bad} rejected`);
    assert.match(res.error, /limit must be an integer 1\.\.100/);
  }

  assert.equal(validateMemoryQuery({ budgetChars: 1 }).ok, true);
  assert.equal(validateMemoryQuery({ budgetChars: MEMORY_LIMITS.budgetChars }).ok, true);
  for (const bad of [0, MEMORY_LIMITS.budgetChars + 1, 9.5]) {
    const res = validateMemoryQuery({ budgetChars: bad });
    assert.equal(res.ok, false, `budgetChars ${bad} rejected`);
    assert.match(res.error, /budgetChars must be an integer 1\.\.100000/);
  }
});

test('validateMemoryRef: non-empty string within the id cap', () => {
  assert.deepEqual(validateMemoryRef('mem-abc123'), { ok: true, value: 'mem-abc123' });
  for (const bad of ['', '   ', 42, null, undefined, {}, []]) {
    const res = validateMemoryRef(bad);
    assert.equal(res.ok, false, `id ${JSON.stringify(bad)} rejected`);
    assert.match(res.error, /id must be a non-empty string/);
  }
  const long = validateMemoryRef('x'.repeat(MEMORY_LIMITS.id + 1));
  assert.equal(long.ok, false);
  assert.match(long.error, /id too long/);
});

test('validateMemoryEdit: at least one field must be present', () => {
  const nothing = validateMemoryEdit({ id: 'mem-1' });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.error, 'edit requires at least one of: content, importance, confidence, expiresAt');

  const noId = validateMemoryEdit({ content: 'hi' });
  assert.equal(noId.ok, false);
  assert.match(noId.error, /id must be a non-empty string/);

  assert.equal(validateMemoryEdit([]).ok, false, 'array body rejected');
  assert.equal(validateMemoryEdit('x').ok, false, 'non-object body rejected');

  // Each field alone satisfies the rule.
  const contentOnly = validateMemoryEdit({ id: 'mem-1', content: 'corrected text' });
  assert.equal(contentOnly.ok, true, contentOnly.error);
  assert.deepEqual(contentOnly.value, {
    id: 'mem-1', content: 'corrected text', importance: null, confidence: null, expiresAt: undefined,
  });
  assert.equal(validateMemoryEdit({ id: 'mem-1', importance: 5 }).ok, true);
  assert.equal(validateMemoryEdit({ id: 'mem-1', confidence: 0.25 }).ok, true);
  const clearExpiry = validateMemoryEdit({ id: 'mem-1', expiresAt: null });
  assert.equal(clearExpiry.ok, true, 'null expiresAt clears the expiry');
  assert.equal(clearExpiry.value.expiresAt, null);
  assert.equal(validateMemoryEdit({ id: 'mem-1', expiresAt: 1_900_000_000_000 }).ok, true);

  // Field rules mirror the write validator.
  assert.match(validateMemoryEdit({ id: 'mem-1', content: 'x'.repeat(MEMORY_LIMITS.content + 1) }).error, /content exceeds/);
  assert.equal(validateMemoryEdit({ id: 'mem-1', content: 42 }).ok, false);
  assert.match(validateMemoryEdit({ id: 'mem-1', importance: 6 }).error, /importance must be an integer 0\.\.5/);
  assert.match(validateMemoryEdit({ id: 'mem-1', importance: 1.5 }).error, /importance must be an integer 0\.\.5/);
  assert.match(validateMemoryEdit({ id: 'mem-1', confidence: 1.2 }).error, /confidence must be within 0\.\.1/);
  assert.match(validateMemoryEdit({ id: 'mem-1', expiresAt: 0 }).error, /expiresAt must be an epoch-ms number or null/);
});

test('MEMORY_LIMITS matches the Phase 5 contract exactly', () => {
  assert.deepEqual({ ...MEMORY_LIMITS }, {
    content: 2000,
    query: 200,
    id: 200,
    ref: 200,
    limit: 100,
    budgetChars: 100_000,
  });
  assert.equal(MEMORY_LIMITS.content, MEMORY_CONTENT_MAX, 'content cap is the shared constant');
});
