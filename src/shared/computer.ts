/**
 * Shared computer-runtime types for the AI Company OS Phase 4 runtime.
 *
 * Single definition shared by main (ComputerManager, IPC), preload (typed api)
 * and renderer (ComputerPanel), mirroring how `goalRecord` is shared. Pure
 * types + constants only — no node/electron imports (renderer-safe).
 */

export const COMPUTERS_SCHEMA_VERSION = 1;

export type ComputerStatus =
  | 'OFFLINE'
  | 'STARTING'
  | 'READY'
  | 'WORKING'
  | 'WAITING'
  | 'PAUSED'
  | 'USER_CONTROL'
  | 'STOPPING'
  | 'SLEEPING'
  | 'ERROR';

export const COMPUTER_STATUSES: readonly ComputerStatus[] = [
  'OFFLINE', 'STARTING', 'READY', 'WORKING', 'WAITING',
  'PAUSED', 'USER_CONTROL', 'STOPPING', 'SLEEPING', 'ERROR',
];

/**
 * The complete transition table. An operation that would move a computer
 * outside these edges is rejected with INVALID_STATE — never forced.
 *
 * Semantics (kept deliberately narrow):
 * - STARTING/STOPPING are the only in-flight states (one op at a time).
 * - READY/WAITING are both "running, no current work"; READY is entered at
 *   start, WAITING after a working period ends.
 * - SLEEPING only via the idle policy (sleepAfterIdleMs > 0, default off).
 * - USER_CONTROL is reached only by takeControl and exits only by
 *   releaseControl (or stop).
 * - ERROR exits via start (retry) or stop.
 */
export const COMPUTER_TRANSITIONS: Record<ComputerStatus, readonly ComputerStatus[]> = {
  OFFLINE: ['STARTING'],
  STARTING: ['READY', 'ERROR', 'STOPPING'],
  READY: ['WORKING', 'WAITING', 'PAUSED', 'USER_CONTROL', 'SLEEPING', 'STOPPING', 'ERROR'],
  WORKING: ['WAITING', 'PAUSED', 'USER_CONTROL', 'SLEEPING', 'STOPPING', 'ERROR'],
  WAITING: ['WORKING', 'PAUSED', 'USER_CONTROL', 'SLEEPING', 'STOPPING', 'ERROR'],
  PAUSED: ['READY', 'STOPPING', 'ERROR'],
  USER_CONTROL: ['READY', 'WORKING', 'WAITING', 'STOPPING', 'ERROR'],
  STOPPING: ['OFFLINE', 'ERROR'],
  SLEEPING: ['STARTING', 'OFFLINE', 'ERROR'],
  ERROR: ['STARTING', 'OFFLINE'],
};

export function canTransition(from: ComputerStatus, to: ComputerStatus): boolean {
  return COMPUTER_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses in which the computer's runtime processes are believed up. */
export function isRunningStatus(s: ComputerStatus): boolean {
  return s === 'STARTING' || s === 'READY' || s === 'WORKING'
    || s === 'WAITING' || s === 'PAUSED' || s === 'USER_CONTROL';
}

export interface ComputerResourceLimits {
  /** Max ms for a start op before it fails with TIMEOUT. */
  startTimeoutMs: number;
  /** Hard cap on returned screenshot payloads (bytes of PNG). */
  screenshotMaxBytes: number;
  /** Browser windows per computer — the only real enforceable window limit. */
  maxBrowserWindows: number;
  /** Idle policy: ms of no activity in READY/WAITING before SLEEPING. 0 = disabled. */
  sleepAfterIdleMs: number;
  /** Bounded retry attempts for transient start failures. */
  maxStartAttempts: number;
}

export const DEFAULT_RESOURCE_LIMITS: ComputerResourceLimits = {
  startTimeoutMs: 15_000,
  screenshotMaxBytes: 4 * 1024 * 1024,
  maxBrowserWindows: 1,
  sleepAfterIdleMs: 0,
  maxStartAttempts: 3,
};

/**
 * Permission model — default-deny for sensitive capabilities.
 *
 * `agent` = the OWNING agent, checked in the main process (never in the UI).
 * `user`  = the local operator (the renderer is the trusted UI process; agent
 *           influence reaches main only via hive/hooks, which cannot call
 *           computer IPC — so the CEO cannot grant itself permissions).
 *
 * `agent.terminalExec` defaults true: the owner's own terminal is the product
 * core; blanket default-deny there would make computer-registered agents
 * unusable. Everything sensitive (nav, downloads, network, cross-agent,
 * external actions) defaults false/empty.
 */
export interface ComputerAgentPermissions {
  terminalExec: boolean;
  browserNav: boolean;
  browserDownloads: boolean;
  network: boolean;
  /** Other agent ids allowed to READ this computer's workspace. */
  crossAgentRead: string[];
  /** Other agent ids allowed to WRITE this computer's workspace. */
  crossAgentWrite: string[];
  externalActions: boolean;
}

export interface ComputerUserPermissions {
  screenView: boolean;
  screenControl: boolean;
}

export interface ComputerPermissions {
  agent: ComputerAgentPermissions;
  user: ComputerUserPermissions;
}

export const DEFAULT_COMPUTER_PERMISSIONS: ComputerPermissions = {
  agent: {
    terminalExec: true,
    browserNav: false,
    browserDownloads: false,
    network: false,
    crossAgentRead: [],
    crossAgentWrite: [],
    externalActions: false,
  },
  user: {
    screenView: true,
    screenControl: true,
  },
};

export interface ComputerConfig {
  /** URL opened by openBrowser when none is given. */
  homeUrl?: string;
  /** Reserved; browsers are lazy (never auto-opened by start). */
  openBrowserOnStart?: boolean;
}

export type ComputerPersistencePolicy = 'retain' | 'dispose';

export interface ComputerRecord {
  /** 'cmp-<rand>' — minted once, stable for life, never regenerated. */
  id: string;
  /** Owning hive agent id. */
  agentId: string;
  projectId: string | null;
  /** Last-known status; live status is in-memory, persisted for stale detection. */
  status: ComputerStatus;
  /** Only 'local' exists today; container runtime is reserved, never faked. */
  runtimeType: 'local';
  workspaceId: string;
  workspaceRoot: string;
  /** Electron session partition, 'persist:computer-<id>' — the browser profile. */
  browserProfileId: string | null;
  createdAt: number;
  updatedAt: number;
  lastStartedAt: number | null;
  persistencePolicy: ComputerPersistencePolicy;
  resourceLimits: ComputerResourceLimits;
  permissions: ComputerPermissions;
  config: ComputerConfig;
}

/** Structured result — every operation returns one of these two shapes. */
export type ComputerOpCode =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'INTERNAL';

/** Failure-only op — assignable to any ComputerOp<T>; used by guard helpers. */
export type ComputerFailOp = { ok: false; error: string; code: ComputerOpCode };

export type ComputerOp<T = unknown> =
  | { ok: true; value: T }
  | ComputerFailOp;

export function opOk(): ComputerOp<undefined>;
export function opOk<T>(value: T): ComputerOp<T>;
export function opOk<T>(value?: T): ComputerOp<T | undefined> {
  return { ok: true, value: value as T };
}

export function opFail(code: ComputerOpCode, error: string): ComputerFailOp {
  return { ok: false, error, code };
}

/** Actors that reach ComputerManager checks. */
export type ComputerActor =
  | { kind: 'user' }                              // local operator via renderer IPC
  | { kind: 'agent'; agentId: string };           // an agent identity (hooks/hive paths)

export const USER_ACTOR: ComputerActor = { kind: 'user' };

/** Names of the durable log events (`appendLog({kind:'computer', event: …})`). */
export const COMPUTER_EVENTS = [
  'created',
  'starting',
  'ready',
  'stopped',
  'failed',
  'workspace-init',
  'workspace-recovered',
  'workspace-missing',
  'browser-opened',
  'browser-closed',
  'browser-navigated',
  'browser-error',
  'screen-captured',
  'paused',
  'resumed',
  'control-started',
  'control-ended',
  'watching',
  'permission-denied',
  'recovered-offline',
  'reconciled',
  'disposed',
  'sleeping',
  'status',
] as const;

export type ComputerEventKind = (typeof COMPUTER_EVENTS)[number];

/** Live push payload for the `computer:updated` channel. */
export interface ComputerUpdatedPayload {
  computerId: string;
  agentId: string;
  status: ComputerStatus;
  reason?: string;
}

export interface TerminalInfo {
  ptyId: string | null;
  running: boolean;
  pid?: number;
  cwd?: string;
  lastOutputAt?: number;
}

export interface BrowserStatusInfo {
  open: boolean;
  url?: string;
  title?: string;
  loading?: boolean;
  profileId?: string | null;
}

export interface WorkspaceInfo {
  workspaceId: string;
  root: string;
  exists: boolean;
  fileCount?: number;
}

/** Marker for capabilities the current backend does not provide. */
export const UNSUPPORTED_MESSAGE = 'unsupported by the local computer runtime';
