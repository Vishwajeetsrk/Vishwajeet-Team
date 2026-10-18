'use strict';

/**
 * Phase 6 — ApprovalDesk (design §2 desk shape, §4 hook semantics: one-shot
 * retry token, 60 s TTL, single use; §9 "approvals-desk": pending→decide,
 * token TTL/single-use, persistence roundtrip).
 *
 * REAL vs MOCK:
 * - REAL: `ApprovalDesk` from src/main/approvals.ts on a real temp file —
 *   `req`/`decide`/`consumeRetry`/`pendingCount` plus the JSON temp+rename
 *   persistence and a second desk instance constructed on the same path.
 * - MOCK: none. (`randomUUID`/`Date.now` are the platform's; the TTL check
 *   injects `now` the way `consumeRetry(agentId, action, now)` allows.)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ApprovalDesk } = loadTs('src/main/approvals.ts');

const AGENT = 'agent-1';

function makeDesk(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-approvals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'approvals.json');
  const desk = new ApprovalDesk(() => file);
  return { dir, file, desk };
}
const ask = (over = {}) => ({
  domain: 'hive-tool',
  action: 'Bash',
  actor: AGENT,
  detail: 'arbitrary shell execution requires operator approval',
  ruleId: 'catalog:hive-bash',
  ...over,
});

test('req dedupes a pending item on domain+action+actor', (t) => {
  const { desk } = makeDesk(t);

  const first = desk.req(ask());
  assert.equal(first.status, 'pending');
  assert.match(first.id, /^apr-/);
  assert.equal(first.kind, 'policy');

  // Same triple → the SAME pending item, not a duplicate row.
  const again = desk.req(ask({ detail: 'a second identical ask' }));
  assert.equal(again.id, first.id, 'pending dedupe must key on domain+action+actor');
  assert.equal(desk.pendingCount(), 1);

  // A different actor, action or domain is a different request.
  assert.notEqual(desk.req(ask({ actor: 'agent-2' })).id, first.id);
  assert.notEqual(desk.req(ask({ action: 'Read' })).id, first.id);
  assert.notEqual(desk.req(ask({ domain: 'computer-op' })).id, first.id);
  assert.equal(desk.pendingCount(), 4);
});

test('approving an AGENT item arms a one-shot retry token (true once, then false)', (t) => {
  const { desk } = makeDesk(t);
  const item = desk.req(ask());

  assert.equal(desk.consumeRetry(AGENT, 'Bash'), false, 'no token before a decision');

  const res = desk.decide(item.id, true, 'user');
  assert.equal(res.ok, true);
  assert.equal(res.item.status, 'approved');
  assert.equal(res.item.decidedBy, 'user');

  assert.equal(desk.consumeRetry(AGENT, 'Bash'), true, 'the approved agent call passes once');
  assert.equal(desk.consumeRetry(AGENT, 'Bash'), false, 'single use — the token is spent');

  // The token is keyed agent+action: another tool or agent is unaffected.
  const second = desk.req(ask({ action: 'Write' }));
  desk.decide(second.id, true, 'user');
  assert.equal(desk.consumeRetry(AGENT, 'Read'), false, 'a different action has no token');
  assert.equal(desk.consumeRetry('agent-2', 'Write'), false, 'a different agent has no token');
  assert.equal(desk.consumeRetry(AGENT, 'Write'), true);
});

test('retry tokens expire after the 60 s TTL', (t) => {
  const { desk } = makeDesk(t);
  const item = desk.req(ask());
  desk.decide(item.id, true, 'user');

  // 61 s past "now" the token is dead even though it was never consumed …
  assert.equal(desk.consumeRetry(AGENT, 'Bash', Date.now() + 61_000), false, 'expired token must not pass');
  // … and it is gone either way (expiry consumes).
  assert.equal(desk.consumeRetry(AGENT, 'Bash'), false, 'an expired token is also deleted');

  // Inside the window it still passes: re-arm and check at +59 s.
  const fresh = desk.req(ask());
  desk.decide(fresh.id, true, 'user');
  assert.equal(desk.consumeRetry(AGENT, 'Bash', Date.now() + 59_000), true, 'valid inside the TTL');
});

test('a USER-actor approval arms NO token; a deny arms nothing at all', (t) => {
  const { desk } = makeDesk(t);

  // Operator-originated request (actor 'user' = the user's own action).
  const userItem = desk.req(ask({ actor: 'user' }));
  assert.equal(desk.decide(userItem.id, true, 'user').ok, true);
  assert.equal(desk.consumeRetry('user', 'Bash'), false, 'user approvals never arm tokens');

  // Denying an agent request arms nothing.
  const denied = desk.req(ask({ actor: 'agent-9' }));
  const res = desk.decide(denied.id, false, 'user');
  assert.equal(res.ok, true);
  assert.equal(res.item.status, 'denied');
  assert.equal(desk.consumeRetry('agent-9', 'Bash'), false, 'denied items arm no retry token');
  assert.equal(desk.consumeRetry(AGENT, 'Bash'), false);
});

test('a decided item cannot be decided twice; unknown ids error out', (t) => {
  const { desk } = makeDesk(t);
  const item = desk.req(ask());

  assert.equal(desk.decide(item.id, true, 'user').ok, true);
  const twice = desk.decide(item.id, false, 'user');
  assert.equal(twice.ok, false, 'one-shot decision');
  assert.match(twice.error, /already approved/);
  assert.equal(desk.get(item.id).status, 'approved', 'the first decision stands');

  const again = desk.decide(item.id, true, 'user');
  assert.equal(again.ok, false);

  const missing = desk.decide('apr-does-not-exist', true, 'user');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);
});

test('persistence roundtrip: a fresh desk on the same path sees every item and decision', (t) => {
  const { file, desk } = makeDesk(t);

  const pending = desk.req(ask());
  const decided = desk.req(ask({ action: 'Write', actor: 'agent-2' }));
  assert.equal(desk.decide(decided.id, true, 'user').ok, true);
  const denied = desk.req(ask({ action: 'Read', actor: 'agent-3' }));
  assert.equal(desk.decide(denied.id, false, 'user').ok, true);
  assert.equal(desk.pendingCount(), 1, 'only the untouched ask stays pending');

  // The file is real JSON written temp+rename …
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.items.length, 3);
  const onDisk = doc.items.find((i) => i.id === decided.id);
  assert.equal(onDisk.status, 'approved', 'decisions persist');
  assert.equal(onDisk.decidedBy, 'user');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'temp file is renamed away, never left behind');

  // … and a NEW desk instance over the same path restores the full state.
  const restored = new ApprovalDesk(() => file);
  assert.equal(restored.list().length, 3);
  assert.equal(restored.pendingCount(), 1);
  assert.equal(restored.get(pending.id).status, 'pending');
  assert.equal(restored.get(decided.id).status, 'approved');
  assert.equal(restored.get(denied.id).status, 'denied');
  assert.equal(restored.get(decided.id).decidedBy, 'user');
  assert.deepEqual(restored.list({ status: 'approved' }).map((i) => i.id), [decided.id]);
  // Decisions follow the dedupe rule: re-asking for the DECIDED request creates
  // a NEW pending item (the old one is no longer pending), while the untouched
  // pending ask still dedupes.
  assert.equal(restored.req(ask()).id, pending.id, 'still-pending ask dedupes');
  const next = restored.req(ask({ action: 'Write', actor: 'agent-2' }));
  assert.notEqual(next.id, decided.id, 'a decided request re-asks as a new item');
  assert.equal(next.status, 'pending');
  assert.equal(restored.pendingCount(), 2);
});

test('pendingCount tracks only pending items', (t) => {
  const { desk } = makeDesk(t);
  assert.equal(desk.pendingCount(), 0);

  const a = desk.req(ask());
  desk.req(ask({ action: 'Read' })); // different action → its own item
  assert.equal(desk.pendingCount(), 2);

  desk.decide(a.id, true, 'user');
  assert.equal(desk.pendingCount(), 1);
  assert.equal(desk.list().length, 2, 'decided items stay listed');
  assert.equal(desk.list({ status: 'pending' }).length, 1);
});
