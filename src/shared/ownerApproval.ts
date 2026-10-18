/**
 * Owner-approval delivery for ASK ME cards (#713).
 *
 * Some sign-offs need the owner's own input in a specific agent's session, not
 * a message relayed by the orchestrator: writing to a live system, uploading
 * something off the machine, spending money. The orchestrator prepares a
 * delivery action (one target agent, one sentence, an expiry) on the card; the
 * owner sees the exact sentence on the ASK ME card and clicks "Approve and
 * deliver" to have the app type it directly into the named session as the
 * owner's input — bypassing orchestrator-mediated dispatch (#44/#45) for this
 * one, owner-clicked case.
 *
 * This module is the PURE half: schema, text validation, expiry and the
 * single-use transition. It never reads config, never touches the filesystem,
 * never talks to a PTY — so the renderer can validate the card, the main
 * process can re-validate atomically at delivery time, and both agree on the
 * rules. The delivery side (queue gates, typing, god notification) lives in
 * hive.ts / index.ts.
 *
 * Deliberate limits, documented for the operator:
 *   - one action per card (the card shows the sentence; there is no list);
 *   - the sentence is what the card displayed — later edits to the card's
 *     question can never change an approved payload (the freeze happens in
 *     main before anything is typed);
 *   - this records approvals made through the app's UI. It is not
 *     tamper-resistant attribution, and it does not isolate agents that run
 *     under the same OS account.
 */

/** How the sentence reaches the target's terminal. `true` types the sentence
 *  then presses Enter (the normal submit path); `false` types it without
 *  Enter, leaving the owner's composer with the text staged (for a sentence
 *  that is a command prefix, or when the owner wants a final look). */
export interface OwnerApprovalAction {
  /** Hive agent id whose session receives the sentence. Must be a live agent
   *  at delivery time; a restarted agent is detected by the caller (registry
   *  session check) and makes the delivery fail closed. */
  agentId: string;
  /** The exact single line of text the card displayed. Frozen on first
   *  approval attempt — main never re-reads the sentence from a later card
   *  edit; it types what was claimed. */
  sentence: string;
  /** Whether Enter is pressed after typing. Displayed on the card. */
  pressEnter: boolean;
  /** ISO-8601 instant after which the action must not be delivered. Displayed
   *  on the card; re-checked in main immediately before typing. */
  expiresAt: string;
  /** Set the moment a delivery attempt is ACCEPTED for typing (before the PTY
   *  write). Each approval is usable once, atomically — a second click, a
   *  double-mounted component, or a race with a restore cannot double-send.
   *  Survives app restart because it is persisted on the card (tasks.json). */
  deliveredAt?: string;
  /** Set when the typing failed (dead PTY, agent gone, session changed). The
   *  card stays visible with the failure so the outcome is never silent; a
   *  human must re-ask — the app never retries an approval on its own. */
  failed?: string;
  /** One-line note recorded for the orchestrator / audit trail (e.g. which
   *  session the sentence landed in). */
  deliveryNote?: string;
}

/** Cap on the sentence the orchestrator may propose. The sentence is typed as
 *  one line into a live TUI; longer text belongs in a file the agent reads,
 *  not in the approval itself. */
export const OWNER_APPROVAL_SENTENCE_MAX = 300;

/**
 * Characters we refuse in an approval sentence.
 *
 * The sentence is the owner's word typed verbatim into a terminal. Control
 * characters (including CR/LF/TAB), zero-width joiners/marks, bidi override
 * and embedding controls, BOM, soft hyphen, and other format characters would
 * let the VISIBLE sentence differ from what actually executes (an invisible
 * line break splits a command; a bidi override reorders arguments on screen).
 * The card must show exactly what runs, so they are rejected outright.
 *
 * Expressed as unicode escapes (never literal control bytes) so the source
 * file itself stays plain printable text.
 */
const FORBIDDEN = new RegExp(
  '[' +
    '\\u0000-\\u001F\\u007F' +       // C0 controls + DEL (incl. CR/LF/TAB)
    '\\u00AD' +                       // soft hyphen
    '\\u200B-\\u200F' +               // ZWSP, ZWNJ, ZWJ, LRM, RLM
    '\\u202A-\\u202E' +               // bidi embedding / override
    '\\u2060-\\u2064' +               // word joiner, invisible operators
    '\\u2066-\\u2069' +               // bidi isolates
    '\\uFEFF' +                       // BOM / ZWNBSP
  ']',
  'u'
);

/** Why a sentence was rejected. A short, stable token — the UI maps it to a
 *  localized string; logs can use it raw. */
export type OwnerApprovalSentenceError =
  | 'empty'
  | 'too-long'
  | 'control-chars'
  | 'not-a-string';

/**
 * Validate the sentence half of a proposed approval.
 *
 * Returns `null` when the sentence is acceptable, or the reason it is not.
 * Pure: same input, same verdict, no environment.
 */
export function validateApprovalSentence(sentence: unknown): OwnerApprovalSentenceError | null {
  if (typeof sentence !== 'string') return 'not-a-string';
  const trimmed = sentence.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > OWNER_APPROVAL_SENTENCE_MAX) return 'too-long';
  if (FORBIDDEN.test(trimmed)) return 'control-chars';
  return null;
}

/** Validate a full proposed action as the ORCHESTRATOR wrote it (no delivery
 *  stamps yet). Used when the card is first rendered and when main re-checks
 *  the payload the card displayed before freezing it. */
export function validateApprovalAction(
  action: unknown
): OwnerApprovalSentenceError | 'bad-shape' | 'bad-expiry' | null {
  if (!action || typeof action !== 'object') return 'bad-shape';
  const a = action as Partial<OwnerApprovalAction>;
  if (typeof a.agentId !== 'string' || !a.agentId.trim()) return 'bad-shape';
  if (typeof a.pressEnter !== 'boolean') return 'bad-shape';
  if (typeof a.expiresAt !== 'string') return 'bad-expiry';
  const expiry = Date.parse(a.expiresAt);
  if (!Number.isFinite(expiry)) return 'bad-expiry';
  return validateApprovalSentence(a.sentence);
}

/** Is this action past its expiry? Fails CLOSED: an unparseable timestamp is
 *  treated as expired (an approval we cannot bound in time must not fire). */
export function isApprovalExpired(
  action: Pick<OwnerApprovalAction, 'expiresAt'>,
  now = Date.now()
): boolean {
  const expiry = Date.parse(action.expiresAt);
  if (!Number.isFinite(expiry)) return true;
  return now >= expiry;
}

/** Has this approval already been consumed (delivered, or failed)? A consumed
 *  approval is dead: the app never re-types it without a fresh ask from the
 *  orchestrator. */
export function isApprovalConsumed(
  action: Pick<OwnerApprovalAction, 'deliveredAt' | 'failed'>
): boolean {
  return (
    (typeof action.deliveredAt === 'string' && !!action.deliveredAt) ||
    (typeof action.failed === 'string' && !!action.failed)
  );
}

/**
 * Atomically claim the single use of this action.
 *
 * Returns `{ ok: true, action }` with `deliveredAt` stamped (and the optional
 * note attached), or `{ ok: false, reason }` when the claim is refused:
 *   - 'already-used' — a prior claim stamped deliveredAt or failed;
 *   - 'expired'      — now is at or past expiresAt (or the stamp is unparseable).
 *
 * The stamp is applied to a SHALLOW COPY; the caller persists it with
 * hivePatchTask so the claim survives a restart (tasks.json is the ledger).
 * Doing the stamp as a copy-then-persist keeps the claim a single decision at
 * one instant — two concurrent clicks both call this, but only the first sees
 * a clean action, because main serializes task patches against the on-disk
 * ledger (patchTask re-reads before writing).
 */
export function claimApproval(
  action: OwnerApprovalAction,
  note?: string,
  now = Date.now()
): { ok: true; action: OwnerApprovalAction } | { ok: false; reason: 'already-used' | 'expired' } {
  if (isApprovalConsumed(action)) return { ok: false, reason: 'already-used' };
  if (isApprovalExpired(action, now)) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    action: {
      ...action,
      deliveredAt: new Date(now).toISOString(),
      ...(note ? { deliveryNote: note } : {})
    }
  };
}

/** Mark a claimed-but-failed delivery on the card (kept visible, never
 *  auto-retried). Returns a copy with `failed` set; does not touch
 *  deliveredAt (the claim already happened). */
export function failApproval(action: OwnerApprovalAction, reason: string): OwnerApprovalAction {
  return { ...action, failed: reason.slice(0, 200) };
}

/** Convenience: does this humanQA entry carry a live (undelivered, unexpired)
 *  approval action? The ASK ME card renders the Approve-and-deliver button
 *  only for entries where this is true. */
export function liveApproval(
  entry: { delivery?: OwnerApprovalAction } | null | undefined,
  now = Date.now()
): OwnerApprovalAction | null {
  const d = entry?.delivery;
  if (!d || typeof d !== 'object') return null;
  if (isApprovalConsumed(d)) return null;
  if (isApprovalExpired(d, now)) return null;
  return d;
}
