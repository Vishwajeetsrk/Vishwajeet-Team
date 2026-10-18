/**
 * Electron browser runtime for computers — a BrowserWindow per computer on its
 * OWN persistent partition (`persist:computer-<id>`), driven exclusively from
 * the main process. The renderer never touches these windows: every navigation,
 * capture and visibility change flows through ComputerManager, which applies the
 * default-deny permission checks first.
 *
 * Testability: the BrowserWindow constructor and profile-dir resolver are
 * injectable. Under plain node `BrowserWindow` from electron is undefined, so a
 * test constructs the adapter with a fake window class and exercises the real
 * adapter logic (partition wiring, status tracking, capture fallback, wipe).
 * A labeled `npx electron` script proves the same code against a real window.
 *
 * Profile wipe honesty: Chromium keeps files in a partition locked (cookies,
 * caches) until the window/session releases them — an immediate rmSync can hit
 * EPERM on Windows. `dispose` therefore attempts the wipe with retries, and if
 * the runtime still holds the directory it registers the partition in a
 * pending-wipe registry file that the NEXT launch (fresh process, no locks)
 * flushes. The wipe is never silently dropped.
 */

import { BrowserWindow, app } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ComputerRecord } from '../shared/computer';
import type { BrowserStatusInfo } from '../shared/computer';
import type { BrowserRuntime } from './computer';

/**
 * Phase 7 (M2) — the built-in LOOPBACK-ONLY allowlist used when a session has
 * no injected `networkGate` (fail-closed: no internet egress, but the local
 * harness stays reachable). `network=true` computers get an injected gate that
 * allows everything; everyone else lands here or behind an equivalent check.
 */
export function loopbackOnlyAllowed(rawUrl: string): boolean {
  const url = rawUrl.trim().toLowerCase();
  if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) {
    return true; // local/document schemes — no network egress
  }
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (!h) return false;
    // Exact loopback only — a suffix trick like `127.0.0.1.evil.test` must not pass.
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
  } catch {
    return false; // unparsable → deny
  }
}

/** Minimal surface of Electron's BrowserWindow that this adapter relies on. */
export interface BrowserWindowLike {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  show(): void;
  hide(): void;
  isVisible(): boolean;
  close(): void;
  isDestroyed(): boolean;
  setMenuBarVisibility?(visible: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  webContents: {
    capturePage(): Promise<{ toPNG(): Buffer; isEmpty?(): boolean }>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    isDestroyed?(): boolean;
    session?: DownloadSessionLike;
  };
}

export type BrowserWindowCtor = new (options: Record<string, unknown>) => BrowserWindowLike;

export interface ComputerBrowserDeps {
  /** Window factory. Defaults to the real electron BrowserWindow. */
  BrowserWindow?: BrowserWindowCtor;
  /** On-disk partition dir for a `persist:` partition (wipe path). null = skip. */
  profileDirFor?: (partition: string) => string | null;
  /** Injectable remover (tests); defaults to fs.rmSync with recursive+force. */
  remover?: (dir: string) => void;
  /** Pending-wipe registry file. undefined = derive from electron userData; null = disabled. */
  wipeRegistryFile?: string | null;
  /** Retry pacing for locked-profile wipes. */
  wipeRetryDelayMs?: number;
  /**
   * `browserDownloads` gate for the session's `will-download` event. When the
   * gate is absent, throws, or returns false the download is prevented —
   * default-deny even if nobody wired the check.
   */
  downloadGate?: (computerId: string) => boolean;
  /**
   * Phase 7 (M2) — `network` gate for the session's `onBeforeRequest` hook.
   * When the gate is absent the session falls back to LOOPBACK-ONLY (built-in
   * default-deny: no internet egress). A throwing gate denies (fail closed).
   */
  networkGate?: (computerId: string, url: string) => boolean;
  /** Best-effort diagnostics sink. */
  log?: (message: string) => void;
}

interface WinState {
  win: BrowserWindowLike;
  url: string;
  title: string;
  visible: boolean;
  partition: string;
  session?: DownloadSessionLike;
  onDownload?: (event: DownloadEventLike, item: unknown, wc: unknown) => void;
}

interface DownloadSessionLike {
  on(event: 'will-download', listener: (event: DownloadEventLike, item: unknown, wc: unknown) => void): void;
  removeListener?(event: 'will-download', listener: (event: DownloadEventLike, item: unknown, wc: unknown) => void): void;
  /** Phase 7 (M2) — present on the real Electron session; optional for fakes. */
  webRequest?: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void
    ): void;
  };
}

interface DownloadEventLike {
  preventDefault(): void;
}

const WIPE_REGISTRY_NAME = 'computer-wipes.json';
const CAPTURE_RETRY_DELAY_MS = 150;
const WIPE_ATTEMPTS = 4;

export class ComputerBrowser implements BrowserRuntime {
  private readonly windows = new Map<string, WinState>();
  /** Partition names awaiting a wipe the runtime could not complete yet. */
  private readonly pendingWipes = new Set<string>();

  constructor(private readonly deps: ComputerBrowserDeps = {}) {
    // Next-launch recovery: the previous process recorded a locked profile.
    // This process has no windows on it yet, so the directory is deletable.
    this.loadPendingWipes();
  }

  async open(rec: ComputerRecord, url: string): Promise<{ ok: boolean; error?: string; unsupported?: boolean }> {
    const Ctor = this.Ctor;
    if (!Ctor) return { ok: false, unsupported: true, error: 'browser runtime unavailable (not running under Electron)' };
    this.closeInternal(rec.id);

    let win: BrowserWindowLike;
    const partition = rec.browserProfileId ?? `persist:computer-${rec.id}`;
    try {
      win = new Ctor({
        show: false, // hidden by default: a computer's browser is an agent tool, not a user window
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          sandbox: true,
          webSecurity: true,
          autoplayPolicy: 'user-gesture-required',
        },
      });
    } catch (e) {
      return { ok: false, error: `window create failed: ${(e as Error).message}` };
    }

    const state: WinState = { win, url: '', title: '', visible: false, partition };
    this.windows.set(rec.id, state);
    win.on('page-title-updated', (...args: unknown[]) => {
      state.title = String(args[1] ?? '');
    });
    win.on('closed', () => {
      if (this.windows.get(rec.id) === state) this.windows.delete(rec.id);
    });
    win.webContents.on('did-navigate', (...args: unknown[]) => {
      const to = String(args[1] ?? '');
      if (to) state.url = to;
    });
    // Default-deny downloads: only a truthfully granted browserDownloads cap
    // lets the session start a download; a missing/throwing gate denies.
    const session = win.webContents.session;
    if (session) {
      const computerId = rec.id;
      const onDownload = (event: DownloadEventLike): void => {
        let allowed = false;
        try {
          allowed = this.deps.downloadGate ? this.deps.downloadGate(computerId) === true : false;
        } catch {
          allowed = false; // fail closed
        }
        if (!allowed) event.preventDefault();
      };
      session.on('will-download', onDownload);
      state.session = session;
      state.onDownload = onDownload;

      // Phase 7 (M2): default-deny NETWORK for the session. Every subresource,
      // navigation and XHR passes `onBeforeRequest`; no gate ⇒ loopback-only,
      // throwing gate ⇒ deny (both fail closed — design §2b).
      const wr = session.webRequest;
      if (wr && typeof wr.onBeforeRequest === 'function') {
        let blocked = 0;
        const onBeforeRequest = (details: { url: string }, cb: (r: { cancel: boolean }) => void): void => {
          let allow = false;
          try {
            allow = this.deps.networkGate
              ? this.deps.networkGate(computerId, details.url) === true
              : loopbackOnlyAllowed(details.url);
          } catch {
            allow = false;
          }
          if (!allow) {
            blocked += 1;
            if (blocked === 1 || blocked % 50 === 0) {
              this.deps.log?.(`[network] blocked (x${blocked}) ${details.url}`);
            }
          }
          cb({ cancel: !allow });
        };
        wr.onBeforeRequest({ urls: ['<all_urls>'] }, onBeforeRequest);
      }
    }
    if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);

    try {
      await win.loadURL(url);
    } catch (e) {
      // Failed load must not leave a zombie window behind.
      try { win.close(); } catch { /* already gone */ }
      if (this.windows.get(rec.id) === state) this.windows.delete(rec.id);
      return { ok: false, error: `navigation failed: ${(e as Error).message}` };
    }
    state.url = safeCall(() => win.getURL(), url);
    state.title = safeCall(() => win.getTitle(), '');
    return { ok: true };
  }

  async close(computerId: string): Promise<{ ok: boolean; error?: string }> {
    this.closeInternal(computerId);
    return { ok: true };
  }

  async navigate(computerId: string, url: string): Promise<{ ok: boolean; error?: string; unsupported?: boolean }> {
    const state = this.windows.get(computerId);
    if (!state || state.win.isDestroyed()) return { ok: false, error: 'browser window is not open' };
    try {
      await state.win.loadURL(url);
    } catch (e) {
      return { ok: false, error: `navigation failed: ${(e as Error).message}` };
    }
    state.url = safeCall(() => state.win.getURL(), url);
    state.title = safeCall(() => state.win.getTitle(), state.title);
    return { ok: true };
  }

  status(computerId: string): BrowserStatusInfo {
    const state = this.windows.get(computerId);
    if (!state || state.win.isDestroyed()) return { open: false };
    return {
      open: true,
      url: safeCall(() => state.win.getURL(), state.url) || state.url || undefined,
      title: safeCall(() => state.win.getTitle(), state.title) || state.title || undefined,
    };
  }

  async capture(computerId: string): Promise<{ ok: boolean; png?: Buffer; error?: string; unsupported?: boolean }> {
    const state = this.windows.get(computerId);
    if (!state || state.win.isDestroyed()) return { ok: false, error: 'browser window is not open' };

    let png = await captureOnce(state.win);
    // A hidden window may not have painted yet: prove it, show briefly, retry,
    // then put it back exactly how it was.
    if (isEmptyImage(png) && !state.visible) {
      try { state.win.show(); state.visible = true; } catch { /* non-fatal */ }
      await delay(CAPTURE_RETRY_DELAY_MS);
      png = await captureOnce(state.win);
      try { state.win.hide(); state.visible = false; } catch { /* non-fatal */ }
    }
    if (!png) return { ok: false, error: 'capturePage unavailable' };
    return { ok: true, png };
  }

  setVisible(computerId: string, show: boolean): { ok: boolean; error?: string } {
    const state = this.windows.get(computerId);
    if (!state || state.win.isDestroyed()) return { ok: false, error: 'browser window is not open' };
    try {
      if (show) state.win.show();
      else state.win.hide();
      state.visible = show;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Close the window and — under the destructive policy — wipe the profile.
   * Retries a few times against Chromium's file locks; a directory still
   * locked afterwards is registered for the next launch, never forgotten.
   */
  async dispose(computerId: string, wipeProfile: boolean): Promise<{ ok: boolean; error?: string }> {
    const state = this.windows.get(computerId);
    const partition = state?.partition ?? `persist:computer-${computerId}`;
    this.closeInternal(computerId);
    if (!wipeProfile) return { ok: true };

    const dir = this.profileDirFor(partition);
    if (!dir) return { ok: true }; // no resolver → nothing provable, nothing claimed

    const delayMs = this.deps.wipeRetryDelayMs ?? 150;
    for (let attempt = 0; attempt < WIPE_ATTEMPTS; attempt++) {
      if (attempt > 0) await delay(delayMs);
      if (this.tryRemove(dir)) {
        this.pendingWipes.delete(partition);
        this.persistRegistry();
        return { ok: true };
      }
    }
    // Still locked: schedule the wipe for the next launch and say so.
    this.pendingWipes.add(partition);
    this.persistRegistry();
    this.deps.log?.(`profile wipe deferred to next launch (runtime still holds ${dir})`);
    return { ok: true };
  }

  async shutdownAll(): Promise<void> {
    for (const id of [...this.windows.keys()]) this.closeInternal(id);
    await this.flushPendingWipes();
  }

  /**
   * Retry every registered pending wipe (call at shutdown and at construction
   * of the next launch). Anything still locked stays in the registry.
   */
  async flushPendingWipes(): Promise<void> {
    if (!this.pendingWipes.size) return;
    const delayMs = this.deps.wipeRetryDelayMs ?? 150;
    for (const partition of [...this.pendingWipes]) {
      const dir = this.profileDirFor(partition);
      if (!dir || !existsSync(dir)) {
        this.pendingWipes.delete(partition);
        continue;
      }
      for (let attempt = 0; attempt < WIPE_ATTEMPTS; attempt++) {
        if (attempt > 0) await delay(delayMs);
        if (this.tryRemove(dir)) break;
      }
      if (!existsSync(dir)) {
        this.pendingWipes.delete(partition);
        this.deps.log?.(`deferred profile wipe completed for ${partition}`);
      }
    }
    this.persistRegistry();
  }

  /** Partition names with a wipe still pending (test/inspection surface). */
  listPendingWipes(): string[] {
    return [...this.pendingWipes];
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private get Ctor(): BrowserWindowCtor | undefined {
    return this.deps.BrowserWindow ?? (BrowserWindow as unknown as BrowserWindowCtor | undefined);
  }

  private closeInternal(computerId: string): void {
    const state = this.windows.get(computerId);
    if (!state) return;
    this.windows.delete(computerId);
    if (state.session && state.onDownload) {
      try { state.session.removeListener?.('will-download', state.onDownload); } catch { /* session gone */ }
    }
    try {
      if (!state.win.isDestroyed()) state.win.close();
    } catch { /* already gone */ }
  }

  /**
   * Profile dir for a partition. Electron keeps partitions at
   * `<userData>/Partitions/<name without "persist:">`.
   */
  private profileDirFor(partition: string): string | null {
    if (this.deps.profileDirFor) return this.deps.profileDirFor(partition);
    try {
      return join(app.getPath('userData'), 'Partitions', partition.replace(/^persist:/, ''));
    } catch {
      return null;
    }
  }

  private tryRemove(dir: string): boolean {
    try {
      const remove = this.deps.remover ?? ((d: string) => rmSync(d, { recursive: true, force: true }));
      remove(dir);
      return !existsSync(dir);
    } catch {
      return false;
    }
  }

  private registryFile(): string | null {
    if (this.deps.wipeRegistryFile !== undefined) return this.deps.wipeRegistryFile;
    try {
      return join(app.getPath('userData'), 'Partitions', WIPE_REGISTRY_NAME);
    } catch {
      return null;
    }
  }

  private loadPendingWipes(): void {
    const file = this.registryFile();
    if (!file) return;
    try {
      if (!existsSync(file)) return;
      const names: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(names)) {
        for (const n of names) if (typeof n === 'string' && n) this.pendingWipes.add(n);
      }
    } catch {
      // Corrupt registry: drop it (a lost registry is a missed best-effort
      // wipe, never a crash); rewrite cleanly on next persist.
      return;
    }
    // Best effort at construction — synchronous first attempt, async retries
    // continue when flushPendingWipes() is awaited later.
    for (const partition of [...this.pendingWipes]) {
      const dir = this.profileDirFor(partition);
      if (!dir || !existsSync(dir) || this.tryRemove(dir)) this.pendingWipes.delete(partition);
    }
    this.persistRegistry();
  }

  private persistRegistry(): void {
    const file = this.registryFile();
    if (!file) return;
    try {
      if (this.pendingWipes.size === 0) {
        if (existsSync(file)) rmSync(file, { force: true });
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify([...this.pendingWipes]), 'utf8');
    } catch {
      // Registry persistence is best-effort; the in-memory set still governs
      // this process's flush attempts.
    }
  }
}

async function captureOnce(win: BrowserWindowLike): Promise<Buffer | null> {
  try {
    const img = await win.webContents.capturePage();
    return img.toPNG();
  } catch {
    return null;
  }
}

function isEmptyImage(png: Buffer | null): boolean {
  if (!png || png.length === 0) return true;
  // Tiny payloads mean "nothing painted" even if they parse as a PNG header.
  return png.length < 64;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runtime factory for wiring: returns null under plain node (electron's
 * BrowserWindow import resolves to undefined there), the real adapter under
 * Electron main. `gates` (Phase 7/M2) carries the download/network closures
 * from index.ts — absent gates keep the adapter's own default-deny behavior.
 */
export function createComputerBrowser(
  log?: (m: string) => void,
  gates?: Pick<ComputerBrowserDeps, 'downloadGate' | 'networkGate'>
): ComputerBrowser | null {
  if (typeof BrowserWindow !== 'function') return null;
  return new ComputerBrowser({
    BrowserWindow: BrowserWindow as unknown as BrowserWindowCtor,
    log,
    ...(gates?.downloadGate ? { downloadGate: gates.downloadGate } : {}),
    ...(gates?.networkGate ? { networkGate: gates.networkGate } : {})
  });
}
