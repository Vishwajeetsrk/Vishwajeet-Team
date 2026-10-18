/**
 * PRD-11 — Teamwire, the free cross-office wire.
 *
 * Design: no relay, no middleman, no account. Office A POSTs an envelope
 * straight to office B's listener (`POST /teamwire/<peerId>`) with
 * `x-md-team-ts` + `x-md-team-sig`, where
 *
 *      sig = HMAC-SHA256( shared secret, `${ts}.${body}` )
 *
 * — the same scheme Slack uses for its webhook signatures, expressed over our
 * own headers. The secret is the orgTrigger key both offices agreed on out of
 * band; it never travels in a message. Timestamps sit in the plain so a 5-minute
 * replay window keeps captured bodies useless afterwards. Everything below is
 * pure and main-free so the test file can exercise the exact bytes main signs
 * and verifies.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** Captured requests die after this long; a resend within the window is fine. */
export const TEAMWIRE_WINDOW_MS = 5 * 60_000;
/** Inbound body cap — anything larger is poison, not a teammate. */
export const TEAMWIRE_BODY_MAX = 32 * 1024;
/** Chat text cap (chars, not bytes) — matches the terminal handoff doc. */
export const TEAMWIRE_TEXT_MAX = 4000;
/** Headers on the wire. Ours, prefixed; mirrors how `x-md-webhook-secret` works. */
export const TEAMWIRE_TS_HEADER = 'x-md-team-ts';
export const TEAMWIRE_SIG_HEADER = 'x-md-team-sig';

/** One teammate's inbound/outbound entry in the operator's config. */
export interface OrgPeer {
  /** Stable local id (also the URL path id for inbound). */
  id: string;
  /** Display name across the app + history. */
  name: string;
  /** Where outbound chat goes: their teamwire listener, full URL. */
  url: string;
  /** The secret THIS office uses to bag outbound chat to them (their org key). */
  secret?: string;
  /** Outbound delivery bookkeeping, updated on every send. */
  lastOkAt?: number;
  lastErrAt?: number;
  lastError?: string;
}

export interface TeamwireEnvelope {
  v: 1;
  from: { id: string; name: string };
  kind: 'chat' | 'note';
  text: string;
  /** 13-digit ms at the SENDING office; the replay window doubles as clock drift tolerance. */
  sentAt: number;
}

/** Everything signed is placed here so sender and verifier derive identical bytes. */
export function teamwireSigningInput(tsMs: number, body: string): string {
  return `${tsMs}.${body}`;
}

export function signTeamwire(secret: string, tsMs: number, body: string): string {
  return createHmac('sha256', secret).update(teamwireSigningInput(tsMs, body)).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Constant-time header check for an inbound request. Every failure mode —
 * wrong secret, stale ts, junk sig, far-future ts (a drift attack, not a resend) —
 * collapses to `false` and upstream answers 404, the same answer an unknown
 * peer id would earn.
 */
export function verifyTeamwire(secret: string, tsHeader: unknown, sigHeader: unknown, body: string, nowMs: number): boolean {
  if (typeof tsHeader !== 'string' || !/^\d{13}$/.test(tsHeader)) return false;
  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > TEAMWIRE_WINDOW_MS) return false;
  if (typeof sigHeader !== 'string' || !HEX64.test(sigHeader)) return false;
  const computed = signTeamwire(secret, ts, body);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(computed, 'hex');
    b = Buffer.from(sigHeader, 'hex');
  } catch {
    return false;
  }
  if (a.length !== 32) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whitelist parse of a verified body. Anything extra, oversize, or
 * implausible-enveloped is rejected whole — no partial adoption, so a malformed
 * field can never rename a teammate or smuggle anything into the history.
 */
export function validateTeamwireEnvelope(raw: unknown, nowMs: number): { ok: true; envelope: TeamwireEnvelope } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'body-not-object' };
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return { ok: false, reason: 'version' };
  const from = o.from;
  if (!from || typeof from !== 'object') return { ok: false, reason: 'from' };
  const fid = (from as Record<string, unknown>).id;
  const fname = (from as Record<string, unknown>).name;
  if (typeof fid !== 'string' || !fid || fid.length > 32) return { ok: false, reason: 'from.id' };
  if (typeof fname !== 'string' || !fname.trim() || fname.length > 60) return { ok: false, reason: 'from.name' };
  if (o.kind !== 'chat' && o.kind !== 'note') return { ok: false, reason: 'kind' };
  if (typeof o.text !== 'string' || !o.text.trim() || o.text.length > TEAMWIRE_TEXT_MAX) return { ok: false, reason: 'text' };
  if (typeof o.sentAt !== 'number' || !Number.isFinite(o.sentAt) || Math.abs(nowMs - o.sentAt) > TEAMWIRE_WINDOW_MS) {
    return { ok: false, reason: 'sentAt' };
  }
  return {
    ok: true,
    envelope: { v: 1, from: { id: fid, name: fname.trim() }, kind: o.kind, text: o.text, sentAt: o.sentAt }
  };
}

export function packEnvelope(envelope: TeamwireEnvelope): string {
  return JSON.stringify(envelope);
}

/** Build an envelope now. `chat` is human-visible; `note` records state. */
export function buildEnvelope(fromId: string, fromName: string, kind: 'chat' | 'note', text: string, nowMs: number): TeamwireEnvelope {
  return { v: 1, from: { id: fromId, name: fromName }, kind, text, sentAt: nowMs };
}

// ─── Peer list hygiene (config → transport) ─────────────────────────────────

export const PEER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
export const MIN_PEER_SECRET = 24;
export const MAX_PEER_SECRET = 512;

function validUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.toString();
}

/**
 * One row of config → the fields transport actually uses, with everything
 * else dropped. Returns `undefined` for rows that cannot be made usable; the
 * hub simply never sees them.
 */
export function sanitizeOrgPeer(raw: unknown, fallbackId: string): OrgPeer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && PEER_ID_RE.test(o.id) ? o.id : undefined;
  const url = validUrl(o.url);
  if (!url) return undefined;
  const secret = typeof o.secret === 'string' && o.secret.length >= MIN_PEER_SECRET && o.secret.length <= MAX_PEER_SECRET ? o.secret : undefined;
  const peer: OrgPeer = {
    id: id || (PEER_ID_RE.test(fallbackId) ? fallbackId : fallbackId.replace(/[^a-z0-9._-]/gi, '_').toLowerCase() || 'peer'),
    name: (typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id || fallbackId).slice(0, 60),
    url
  };
  if (secret) peer.secret = secret;
  if (typeof o.lastOkAt === 'number' && Number.isFinite(o.lastOkAt)) peer.lastOkAt = o.lastOkAt;
  if (typeof o.lastErrAt === 'number' && Number.isFinite(o.lastErrAt)) peer.lastErrAt = o.lastErrAt;
  if (typeof o.lastError === 'string' && o.lastError.length <= 200) peer.lastError = o.lastError;
  return peer;
}

/** Minted for outbound bagging when an operator leaves the secret blank. */
export function mintPeerSecret(): string {
  return randomBytes(24).toString('hex');
}

