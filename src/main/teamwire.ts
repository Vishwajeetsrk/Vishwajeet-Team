/**
 * PRD-11 — the teamwire transport (main process).
 *
 * Inbound: a tiny HTTP listener (no relay, no tunnel, no third service) on
 * `orgPort` that verifies signatures from the SHARED org key before a single
 * byte of an envelope is parsed. An unknown peer id, a wrong signature and a
 * body over the cap earn the SAME 404 — a probe learns nothing but "no".
 *
 * Outbound: plain POST to a stored peer URL with their per-peer secret
 * (the org key they gave us). One attempt, no queue — a chat that fails tells
 * the operator why, instead of silently rotting in a retry loop.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import {
  TEAMWIRE_BODY_MAX,
  TEAMWIRE_TS_HEADER,
  TEAMWIRE_SIG_HEADER,
  TEAMWIRE_WINDOW_MS,
  verifyTeamwire,
  validateTeamwireEnvelope,
  signTeamwire,
  packEnvelope,
  type OrgPeer,
  type TeamwireEnvelope
} from '../shared/teamwire';
import { type TriggerMode } from '../shared/triggers';

const TEAMWIRE_RATE_INTERVAL_MS = 60_000;
const TEAMWIRE_RATE_MAX = 60;
const SEND_TIMEOUT_MS = 8_000;

export type TeamwireMode = TriggerMode;

/** What the caller did with an accepted envelope; totals are the operator's visibility. */
export interface TeamwireInboundResult {
  /** `accepted` = verified + handed on; `rejected` = verified but refused by mode. */
  ok: boolean;
  accepted?: boolean;
  reason?: string;
}

/** Rate limiter: one sliding-minute window per `ip|peerId` (fixed-window is enough here). */
const rates = new Map<string, { count: number; windowStart: number }>();
function allowRequest(key: string, nowMs: number): boolean {
  const slot = rates.get(key);
  if (!slot || nowMs - slot.windowStart >= TEAMWIRE_RATE_INTERVAL_MS) {
    rates.set(key, { count: 1, windowStart: nowMs });
    return true;
  }
  slot.count += 1;
  return slot.count <= TEAMWIRE_RATE_MAX;
}

/** Test seam: reset the in-memory rate window. */
export function resetTeamwireRateLimiter(): void {
  rates.clear();
}

export type TeamwireHandler = (from: TeamwireEnvelope['from'], envelope: TeamwireEnvelope) => { ok: boolean; reason?: string } | void;

/**
 * The inbound half. Certainty rules (carried over from WebhookServer):
 *   - the handler's response tells the caller ONLY ok/rejected — never internals;
 *   - signatures are compared against the shared org key, re-read on every call
 *     so a rotation needs no restart;
 *   - the peer id in the path is IDENTIFIER DISPLAY ONLY — auth comes from the
 *     shared key, so renaming a peer never breaks a working pipe.
 */
export class TeamwireHub {
  private server: Server | null = null;
  private listeningLatch: Promise<boolean> | null = null;
  /** Random value used so an error reply cannot echo request content. */
  private readonly decoy = Math.random().toString(36).slice(2);
  /** Marks that the constructor's caller must keep this instance alive. */
  alive = true;

  constructor(
    private readonly port: number,
    private readonly host: string,
    /** Returns the CURRENT org key (live config), or '' while none is set. */
    private readonly getSecret: () => string,
    private readonly getMode: () => TriggerMode,
    private readonly onEnvelope: TeamwireHandler
  ) {}

  listening(): boolean {
    return !!this.server && !!this.listeningLatch;
  }

  /** Bind the HTTP server; resolve true when listening, false on any failure. */
  listen(): Promise<boolean> {
    if (this.listeningLatch) return this.listeningLatch;
    this.listeningLatch = new Promise<boolean>((resolve) => {
      try {
        this.server = createServer((req, res) => {
          void this.handleRequest(req, res).catch(() => {
            this.reject(res);
          });
        });
        this.server.on('error', () => {
          this.server = null;
          this.listeningLatch = null;
          resolve(false);
        });
        this.server.listen(this.port, this.host, () => resolve(true));
      } catch {
        this.server = null;
        this.listeningLatch = null;
        resolve(false);
      }
    });
    return this.listeningLatch;
  }

  close(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // a dying listener must never crash shutdown
      }
    }
    this.server = null;
    this.listeningLatch = null;
    this.alive = false;
  }

  private reject(res: ServerResponse, code = 404): void {
    try {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no' }));
    } catch {
      // already answered
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || req.method !== 'POST') {
      this.reject(res);
      return;
    }
    // The one route: /teamwire/<peerId>. Anything else is a probe.
    const m = /^\/teamwire\/([a-z0-9][a-z0-9._-]{0,31})\/?$/i.exec(req.url.split('?')[0]);
    if (!m) {
      this.reject(res);
      return;
    }
    const peerId = m[1];
    const chunks: Buffer[] = [];
    let streamed = 0;
    let oversized = false;
    for await (const chunk of req) {
      streamed += (chunk as Buffer).length;
      if (streamed > TEAMWIRE_BODY_MAX) {
        oversized = true;
        break;
      }
      chunks.push(chunk as Buffer);
    }
    if (oversized) {
      this.reject(res);
      return;
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const secret = this.getSecret();
    const tsHeader = req.headers[TEAMWIRE_TS_HEADER];
    const sigHeader = req.headers[TEAMWIRE_SIG_HEADER];
    if (!secret || !verifyTeamwire(secret, tsHeader, sigHeader, body, Date.now())) {
      this.reject(res);
      return;
    }
    if (!allowRequest(`${req.socket.remoteAddress ?? ''}|${peerId}`, Date.now())) {
      this.reject(res, 429);
      return;
    }
    const now = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.reject(res);
      return;
    }
    const verdict = validateTeamwireEnvelope(parsed, now);
    if (!verdict.ok) {
      this.reject(res);
      return;
    }
    let result: { ok: boolean; reason?: string } | void;
    try {
      result = this.onEnvelope(verdict.envelope.from, verdict.envelope);
    } catch {
      // a handler crash must never read as "wrong secret"
      this.reject(res, 500);
      return;
    }
    const accepted = result?.ok !== false;
    try {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: accepted }));
    } catch {
      // client hung up; the message already landed
    }
  }
}

export interface TeamwireSendResult {
  ok: boolean;
  error?: string;
  /** Echo of what was sent (stats + history populate from this). */
  envelope?: TeamwireEnvelope;
}

/**
 * Bag one chat to a peer. The URL comes from the operator's own config (never
 * from a message), the secret from that peer row — so a chat can only go where
 * the operator deliberately pointed it.
 */
export async function sendTeamChat(peer: OrgPeer, text: string, fromId: string, fromName: string): Promise<TeamwireSendResult> {
  const body = packEnvelope({
    v: 1,
    from: { id: fromId, name: fromName },
    kind: 'chat',
    text: text.slice(0, 4000),
    sentAt: Date.now()
  });
  const secret = peer.secret || '';
  if (!secret) return { ok: false, error: 'no-secret' };
  const ts = Date.now();
  const sig = signTeamwire(secret, ts, body);
  return await postTeamwire(peer.url, body, {
    [TEAMWIRE_TS_HEADER]: String(ts),
    [TEAMWIRE_SIG_HEADER]: sig
  });
}

async function postTeamwire(url: string, body: string, headers: Record<string, string>): Promise<TeamwireSendResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'bad-url' };
  }
    return await new Promise<TeamwireSendResult>((resolve) => {
      let settled = false;
      const finish = (r: TeamwireSendResult): void => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const reqMod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = reqMod(
        parsed,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers }
        },
        (res: { statusCode?: number; resume: () => void }) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            finish({ ok: true });
          } else {
            finish({ ok: false, error: `status-${res.statusCode ?? 0}` });
          }
        }
      );
      req.on('error', (e: Error) => finish({ ok: false, error: e.message.slice(0, 120) }));
      req.setTimeout(SEND_TIMEOUT_MS, () => {
        req.destroy(new Error('timeout'));
      });
      req.end(body);
    });
}

/** Guard used by the wiring: keep the hub's mode from drifting off the shared type. */
const TRIGGER_MODE_SET = new Set<TriggerMode>(['strict', 'allow-all', 'communication-only']);
export function guardMode(mode: unknown): TriggerMode {
  return typeof mode === 'string' && TRIGGER_MODE_SET.has(mode as TriggerMode) ? (mode as TriggerMode) : 'strict';
}

export const TEAMWIRE_WINDOW = TEAMWIRE_WINDOW_MS;
