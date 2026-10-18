'use strict';

/**
 * Owner-approval delivery (#713) — the PURE half.
 *
 * The orchestrator prepares a delivery action on an ASK ME card (one target
 * agent, one sentence, an expiry); the owner clicks "Approve and deliver" and
 * the app types the shown sentence into that agent's session. These tests pin
 * the rules the renderer and the main process must AGREE on: sentence shape,
 * expiry (fail-closed), and the single-use claim that survives a restart via
 * tasks.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  OWNER_APPROVAL_SENTENCE_MAX,
  validateApprovalSentence,
  validateApprovalAction,
  isApprovalExpired,
  isApprovalConsumed,
  claimApproval,
  failApproval,
  liveApproval
} = loadTs('src/shared/ownerApproval.ts');

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

const action = (over = {}) => ({
  agentId: 'dev1',
  sentence: 'Approve the $42 charge to the vendor portal.',
  pressEnter: true,
  expiresAt: FUTURE,
  ...over
});

test('a normal one-line sentence is accepted', () => {
  assert.equal(validateApprovalSentence('Approve the $42 charge.'), null);
});

test('surrounding whitespace is trimmed before the checks', () => {
  assert.equal(validateApprovalSentence('  yes, ship it  '), null);
  assert.equal(validateApprovalSentence('   '), 'empty');
});

test('empty and whitespace-only sentences are rejected', () => {
  assert.equal(validateApprovalSentence(''), 'empty');
  assert.equal(validateApprovalSentence('   \t  '), 'empty');
});

test('a non-string is rejected outright', () => {
  assert.equal(validateApprovalSentence(42), 'not-a-string');
  assert.equal(validateApprovalSentence(null), 'not-a-string');
  assert.equal(validateApprovalSentence(undefined), 'not-a-string');
  assert.equal(validateApprovalSentence({ toString: () => 'x' }), 'not-a-string');
});

test('a sentence over the cap is rejected', () => {
  const ok = 'x'.repeat(OWNER_APPROVAL_SENTENCE_MAX);
  assert.equal(validateApprovalSentence(ok), null);
  assert.equal(validateApprovalSentence(`${ok}x`), 'too-long');
});

test('control characters (CR, LF, TAB, DEL) are rejected', () => {
  // The card must show EXACTLY what runs — an invisible newline would split
  // a command, a TAB would re-tokenize it.
  assert.equal(validateApprovalSentence('line one\nline two'), 'control-chars');
  assert.equal(validateApprovalSentence('a\r b'), 'control-chars');
  assert.equal(validateApprovalSentence('a\tb'), 'control-chars');
  assert.equal(validateApprovalSentence('a\u0000b'), 'control-chars');
  assert.equal(validateApprovalSentence('a\u007Fb'), 'control-chars');
});

test('zero-width and bidi-override characters are rejected', () => {
  // An invisible joiner or a bidi override makes the VISIBLE sentence differ
  // from what actually executes — the whole point of showing it on the card.
  assert.equal(validateApprovalSentence('a\u200Bb'), 'control-chars');
  assert.equal(validateApprovalSentence('a\u200Db'), 'control-chars');
  assert.equal(validateApprovalSentence('a\u202Eb'), 'control-chars');
  assert.equal(validateApprovalSentence('a\uFEFFb'), 'control-chars');
  assert.equal(validateApprovalSentence('a\u2066b\u2069'), 'control-chars');
});

test('action shape: missing agent, boolean, or unparseable expiry fails', () => {
  assert.equal(validateApprovalAction(null), 'bad-shape');
  assert.equal(validateApprovalAction({}), 'bad-shape');
  assert.equal(validateApprovalAction({ ...action(), agentId: '' }), 'bad-shape');
  assert.equal(validateApprovalAction({ ...action(), agentId: 7 }), 'bad-shape');
  assert.equal(validateApprovalAction({ ...action(), pressEnter: 'yes' }), 'bad-shape');
  assert.equal(validateApprovalAction({ ...action(), expiresAt: 'soon' }), 'bad-expiry');
  assert.equal(validateApprovalAction({ ...action(), expiresAt: undefined }), 'bad-expiry');
});

test('a well-formed future action validates clean', () => {
  assert.equal(validateApprovalAction(action()), null);
});

test('expiry is fail-closed: unparseable means expired', () => {
  assert.equal(isApprovalExpired({ expiresAt: 'whenever' }), true);
  assert.equal(isApprovalExpired({ expiresAt: '' }), true);
  assert.equal(isApprovalExpired({ expiresAt: PAST }), true);
  assert.equal(isApprovalExpired({ expiresAt: FUTURE }), false);
  // now === expiresAt is expired (half-open interval [start, end)).
  assert.equal(isApprovalExpired({ expiresAt: FUTURE }, Date.parse(FUTURE)), true);
});

test('consumed = delivered OR failed; both are dead', () => {
  assert.equal(isApprovalConsumed({}), false);
  assert.equal(isApprovalConsumed({ deliveredAt: '2026-01-01T00:00:00.000Z' }), true);
  assert.equal(isApprovalConsumed({ failed: 'pty write failed' }), true);
  assert.equal(isApprovalConsumed({ deliveredAt: '', failed: '' }), false);
});

test('claim stamps deliveredAt once; a second claim is already-used', () => {
  const a = action();
  const first = claimApproval(a, 'delivered to dev1 session abc', 1000);
  assert.equal(first.ok, true);
  assert.equal(first.action.deliveredAt, new Date(1000).toISOString());
  assert.equal(first.action.deliveryNote, 'delivered to dev1 session abc');
  // The ORIGINAL is untouched (claim returns a copy — the caller persists it).
  assert.equal(a.deliveredAt, undefined);
  // Re-claiming the CLAIMED copy fails.
  const second = claimApproval(first.action, undefined, 2000);
  assert.deepEqual(second, { ok: false, reason: 'already-used' });
});

test('claim refuses an expired action even when unconsumed', () => {
  const expired = action({ expiresAt: PAST });
  // now (2026) is well past PAST (2000).
  assert.deepEqual(claimApproval(expired, undefined, Date.parse('2026-01-01T00:00:00.000Z')), {
    ok: false,
    reason: 'expired'
  });
});

test('claim refuses at the exact expiry instant', () => {
  const at = action({ expiresAt: new Date(5000).toISOString() });
  const before = claimApproval(at, undefined, 4999);
  assert.equal(before.ok, true);
  const atInstant = claimApproval(at, undefined, 5000);
  assert.deepEqual(atInstant, { ok: false, reason: 'expired' });
});

test('claim with no note leaves deliveryNote unset', () => {
  const r = claimApproval(action(), undefined, 1);
  assert.equal(r.ok, true);
  assert.equal('deliveryNote' in r.action, false);
});

test('failApproval records the reason, capped, and keeps deliveredAt', () => {
  const claimed = claimApproval(action(), undefined, 1);
  assert.equal(claimed.ok, true);
  const failed = failApproval(claimed.action, 'y'.repeat(500));
  assert.equal(failed.failed.length, 200);
  assert.equal(failed.deliveredAt, claimed.action.deliveredAt);
});

test('liveApproval: only a live (undelivered, unexpired) action shows the button', () => {
  assert.equal(liveApproval(undefined), null);
  assert.equal(liveApproval({}), null);
  const live = liveApproval({ delivery: action() });
  assert.equal(live?.agentId, 'dev1');
  assert.equal(live?.sentence, action().sentence);

  assert.equal(liveApproval({ delivery: action({ deliveredAt: '2026-01-01T00:00:00.000Z' }) }), null);
  assert.equal(liveApproval({ delivery: action({ failed: 'dead pty' }) }), null);
  assert.equal(liveApproval({ delivery: action({ expiresAt: PAST }) }), null);
});
