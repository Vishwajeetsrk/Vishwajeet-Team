import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import type { Agent } from '@/store/store';
import type { ComputerRecord, ComputerStatus, TerminalInfo, BrowserStatusInfo, WorkspaceInfo } from '@shared/computer';

interface AgentComputerModalProps {
  agent: Agent;
  onClose: () => void;
}

// Preset desktop wallpapers
const WALLPAPERS = [
  {
    id: 'bird-rock',
    name: 'Desert Rock (Default)',
    url: 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=1280&q=80',
    gradient: 'linear-gradient(135deg, #2b3a4a 0%, #1e2630 100%)'
  },
  {
    id: 'retro-grid',
    name: 'Retro Terminal',
    url: '',
    gradient: 'radial-gradient(ellipse at center, #1a2332 0%, #0d1117 100%)'
  },
  {
    id: 'cyberpunk',
    name: 'Neon Horizon',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1280&q=80',
    gradient: 'linear-gradient(135deg, #1f1435 0%, #0c0814 100%)'
  }
];

export function AgentComputerModal({ agent, onClose }: AgentComputerModalProps) {
  const { t } = useTranslation();
  const [rec, setRec] = useState<ComputerRecord | null>(null);
  const [liveStatus, setLiveStatus] = useState<ComputerStatus>('READY');
  const [isSleeping, setIsSleeping] = useState(false);
  const [term, setTerm] = useState<TerminalInfo | null>(null);
  const [bstat, setBstat] = useState<BrowserStatusInfo | null>(null);
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [activeWindow, setActiveWindow] = useState<'terminal' | 'browser' | 'code' | 'files'>('terminal');
  const [isFullscreenDesktop, setIsFullscreenDesktop] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedWallpaper, setSelectedWallpaper] = useState(WALLPAPERS[0]);
  const [interactiveTakeover, setInteractiveTakeover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clockTime, setClockTime] = useState<string>('');

  // Agent virtual cursor state
  const [cursorPos, setCursorPos] = useState({ x: 340, y: 180 });
  const [actionLabel, setActionLabel] = useState<string>('Monitoring system tasks');
  const [isClicking, setIsClicking] = useState(false);

  // Terminal input state for interactive mode
  const [termInput, setTermInput] = useState('');
  const [simulatedLogs, setSimulatedLogs] = useState<string[]>([
    `[system] ${agent.name}'s computer environment online.`,
    `[system] runtime: local-sandbox | ptyId: ${agent.ptyId ?? 'live-agent-pty'}`,
    `[agent:${agent.name.toLowerCase()}] checking workspace tasks...`,
    `[agent:${agent.name.toLowerCase()}] idle and awaiting command dispatch.`
  ]);

  // Keep clock updated
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setClockTime(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Ensure computer record exists for this agent
  const refreshComputer = useCallback(async () => {
    try {
      let got = await window.cth.computerGetForAgent(agent.id);
      if (!got.ok && got.code === 'NOT_FOUND') {
        const created = await window.cth.computerEnsureForAgent(agent.id);
        if (created.ok) {
          got = await window.cth.computerGetForAgent(agent.id);
        }
      }
      if (got.ok && got.value) {
        setRec(got.value);
        setIsSleeping(got.value.status === 'SLEEPING');
        const [s, tm, b, w] = await Promise.all([
          window.cth.computerGetStatus(got.value.id),
          window.cth.computerTerminalInfo(got.value.id),
          window.cth.computerBrowserStatus(got.value.id),
          window.cth.computerWorkspaceInfo(got.value.id)
        ]);
        if (s.ok) setLiveStatus(s.value.live.status);
        if (tm.ok) setTerm(tm.value);
        if (b.ok) setBstat(b.value);
        if (w.ok) setWs(w.value);
      }
    } catch {
      // Main process fallback
    }
  }, [agent.id]);

  useEffect(() => {
    void refreshComputer();
    const timer = setInterval(() => void refreshComputer(), 5000);
    return () => clearInterval(timer);
  }, [refreshComputer]);

  // Agent thought / action simulation loop for visual liveliness
  useEffect(() => {
    if (isSleeping) return;
    const actions = [
      { x: 260, y: 140, label: 'Inspecting source files...', window: 'code' },
      { x: 380, y: 210, label: 'Running test suite in terminal...', window: 'terminal' },
      { x: 490, y: 170, label: 'Reading documentation in browser...', window: 'browser' },
      { x: 310, y: 250, label: 'Compiling project build...', window: 'terminal' },
      { x: 420, y: 190, label: 'Formatting workspace assets...', window: 'files' }
    ] as const;

    let idx = 0;
    const actionInterval = setInterval(() => {
      idx = (idx + 1) % actions.length;
      const act = actions[idx];
      setCursorPos({ x: act.x, y: act.y });
      setActionLabel(act.label);
      setIsClicking(true);
      setTimeout(() => setIsClicking(false), 400);
      if (Math.random() > 0.4) {
        setActiveWindow(act.window);
      }
    }, 4500);

    return () => clearInterval(actionInterval);
  }, [isSleeping]);

  // Toggle sleep/wake
  const toggleSleep = async () => {
    if (!rec) return;
    setBusy(true);
    try {
      if (isSleeping) {
        await window.cth.computerResume(rec.id);
        setIsSleeping(false);
        setLiveStatus('READY');
      } else {
        await window.cth.computerPause(rec.id);
        setIsSleeping(true);
        setLiveStatus('SLEEPING');
      }
      await refreshComputer();
    } catch (e) {
      console.error('Sleep toggle failed:', e);
    } finally {
      setBusy(false);
    }
  };

  const handleSendTerminal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!termInput.trim()) return;
    setSimulatedLogs((prev) => [...prev, `$ ${termInput}`, `[output] executed command: ${termInput}`]);
    setTermInput('');
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: isFullscreenDesktop ? 0 : 20,
        fontFamily: 'var(--cth-font-ui)'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isFullscreenDesktop) onClose();
      }}
    >
      <div
        style={{
          width: isFullscreenDesktop ? '100vw' : '720px',
          maxWidth: '100%',
          height: isFullscreenDesktop ? '100vh' : 'auto',
          background: '#121214',
          borderRadius: isFullscreenDesktop ? 0 : 16,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.12)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transition: 'all 0.25s ease'
        }}
      >
        {/* ── Top Bar: Gear, Computer Title, Close (matches media_1792401361294.png) ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px 8px',
            background: '#121214',
            color: '#ffffff',
            position: 'relative'
          }}
        >
          {/* Settings Cog */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            aria-label="Computer Settings"
            style={{
              background: showSettings ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
              border: 'none',
              color: '#cccccc',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease'
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>

          {/* Title: Computer */}
          <span
            style={{
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: 0.2,
              color: '#ffffff'
            }}
          >
            Computer
          </span>

          {/* Close Button: ✕ */}
          <button
            onClick={onClose}
            aria-label="Close computer"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#999999',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              lineHeight: 1
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Subtitle: Atlas's screen ── */}
        <div style={{ padding: '0 20px 10px', color: '#9e9e9e', fontSize: 13, fontWeight: 400 }}>
          {agent.name}&apos;s screen
        </div>

        {/* ── Settings Drawer (Toggled by Cog) ── */}
        {showSettings && (
          <div
            style={{
              background: '#1a1a1e',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
              padding: '12px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              fontSize: 12,
              color: '#ddd'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>Wallpaper Theme:</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {WALLPAPERS.map((wp) => (
                  <button
                    key={wp.id}
                    onClick={() => setSelectedWallpaper(wp)}
                    style={{
                      background: selectedWallpaper.id === wp.id ? '#3b82f6' : 'rgba(255, 255, 255, 0.1)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      padding: '4px 8px',
                      cursor: 'pointer',
                      fontSize: 11
                    }}
                  >
                    {wp.name}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Interactive Takeover:</span>
              <button
                onClick={() => setInteractiveTakeover(!interactiveTakeover)}
                style={{
                  background: interactiveTakeover ? '#10b981' : '#374151',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                {interactiveTakeover ? 'Human Control Active' : 'Spectator (Autonomous)'}
              </button>
            </div>
          </div>
        )}

        {/* ── The Computer Screen Viewport (Bezel + Screen + Desktop OS) ── */}
        <div style={{ padding: isFullscreenDesktop ? 0 : '0 16px 14px', flex: 1, display: 'flex' }}>
          <div
            style={{
              flex: 1,
              position: 'relative',
              borderRadius: isFullscreenDesktop ? 0 : 12,
              overflow: 'hidden',
              aspectRatio: isFullscreenDesktop ? undefined : '16 / 9.6',
              height: isFullscreenDesktop ? 'calc(100vh - 120px)' : undefined,
              background: selectedWallpaper.gradient,
              backgroundImage: selectedWallpaper.url ? `url(${selectedWallpaper.url})` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.1)',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {/* Desktop Icons column */}
            <div
              style={{
                position: 'absolute',
                top: 14,
                left: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                zIndex: 2
              }}
            >
              {[
                { id: 'terminal', label: 'Terminal', icon: 'terminal' },
                { id: 'browser', label: 'Google Chrome', icon: 'chrome' },
                { id: 'code', label: 'VS Code', icon: 'code' },
                { id: 'files', label: 'Files', icon: 'folder' }
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => setActiveWindow(item.id as typeof activeWindow)}
                  style={{
                    background: activeWindow === item.id ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    padding: '4px 6px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                    color: '#ffffff',
                    width: 58,
                    textAlign: 'center',
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)'
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 6,
                      background: 'rgba(20, 20, 26, 0.75)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                      color: activeWindow === item.id ? '#60a5fa' : '#ffffff'
                    }}
                  >
                    <Icon name={item.icon === 'chrome' ? 'web' : (item.icon as Parameters<typeof Icon>[0]['name'])} />
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 500, letterSpacing: -0.2 }}>{item.label}</span>
                </button>
              ))}
            </div>

            {/* Desktop Active Window */}
            {!isSleeping && (
              <div
                style={{
                  position: 'absolute',
                  top: 24,
                  left: 84,
                  right: 20,
                  bottom: 42,
                  background: 'rgba(15, 17, 23, 0.92)',
                  backdropFilter: 'blur(12px)',
                  borderRadius: 8,
                  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  zIndex: 3
                }}
              >
                {/* Window Titlebar */}
                <div
                  style={{
                    height: 28,
                    background: 'rgba(25, 28, 38, 0.95)',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 10px',
                    color: '#aaa',
                    fontSize: 11
                  }}
                >
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f56' }} />
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ffbd2e' }} />
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#27c93f' }} />
                    <span style={{ marginLeft: 6, fontWeight: 600, color: '#eee' }}>
                      {activeWindow === 'terminal' && `bash — ${agent.cwd ?? '~/workspace'}`}
                      {activeWindow === 'browser' && `Chrome — ${bstat?.url ?? 'localhost:3000'}`}
                      {activeWindow === 'code' && `Visual Studio Code — ${agent.name}`}
                      {activeWindow === 'files' && `File Explorer — ${ws?.fileCount ?? 0} items`}
                    </span>
                  </div>
                  <span style={{ fontSize: 9, color: '#666' }}>
                    PID {term?.pid ?? 2048} · {liveStatus}
                  </span>
                </div>

                {/* Window Content */}
                <div style={{ flex: 1, padding: 10, overflow: 'auto', fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: '#d1d5db' }}>
                  {activeWindow === 'terminal' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {simulatedLogs.map((log, i) => (
                        <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                          {log}
                        </div>
                      ))}
                      {interactiveTakeover && (
                        <form onSubmit={handleSendTerminal} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <span style={{ color: '#10b981' }}>{agent.name.toLowerCase()}@pc:~$</span>
                          <input
                            type="text"
                            value={termInput}
                            onChange={(e) => setTermInput(e.target.value)}
                            placeholder="Type command..."
                            style={{
                              flex: 1,
                              background: 'transparent',
                              border: 'none',
                              outline: 'none',
                              color: '#fff',
                              fontFamily: 'inherit',
                              fontSize: 'inherit'
                            }}
                          />
                        </form>
                      )}
                    </div>
                  )}

                  {activeWindow === 'browser' && (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
                      <div style={{ background: '#222', padding: '4px 8px', borderRadius: 4, fontSize: 10, color: '#999' }}>
                        🌐 URL: {bstat?.url ?? 'http://localhost:3000'}
                      </div>
                      <div style={{ flex: 1, background: '#fff', borderRadius: 4, padding: 12, color: '#111' }}>
                        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
                          {bstat?.title ?? `${agent.name}'s Web Preview`}
                        </div>
                        <p style={{ fontSize: 11, color: '#555' }}>
                          Browser instance running in sandbox profile {bstat?.profileId ?? agent.id}.
                        </p>
                      </div>
                    </div>
                  )}

                  {activeWindow === 'code' && (
                    <div style={{ color: '#9cdcfe' }}>
                      <span style={{ color: '#6a9955' }}>// Agent workspace code editor</span>
                      <br />
                      <span style={{ color: '#569cd6' }}>import</span> {'{ useState, useEffect }'} <span style={{ color: '#569cd6' }}>from</span> <span style={{ color: '#ce9178' }}>&apos;react&apos;</span>;
                      <br /><br />
                      <span style={{ color: '#569cd6' }}>export function</span> <span style={{ color: '#dcdcaa' }}>AgentTaskExecutor</span>() {'{'}
                      <br />
                      &nbsp;&nbsp;<span style={{ color: '#569cd6' }}>const</span> [status, setStatus] = <span style={{ color: '#dcdcaa' }}>useState</span>(<span style={{ color: '#ce9178' }}>&apos;running&apos;</span>);
                      <br />
                      &nbsp;&nbsp;<span style={{ color: '#c586c0' }}>return</span> &lt;<span style={{ color: '#4ec9b0' }}>Workspace</span> agent={'{'}&apos;{agent.name}&apos;{'}'} /&gt;;
                      <br />
                      {'}'}
                    </div>
                  )}

                  {activeWindow === 'files' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ color: '#fbbf24' }}>📁 src/</div>
                      <div style={{ paddingLeft: 12 }}>📄 index.ts</div>
                      <div style={{ paddingLeft: 12 }}>📄 config.json</div>
                      <div style={{ color: '#fbbf24' }}>📁 tests/</div>
                      <div style={{ paddingLeft: 12 }}>📄 app.test.ts</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sleeping Overlay */}
            {isSleeping && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0, 0, 0, 0.85)',
                  backdropFilter: 'blur(10px)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  zIndex: 10,
                  color: '#ffffff'
                }}
              >
                <div style={{ fontSize: 32 }}>☾</div>
                <div style={{ fontWeight: 600, fontSize: 16 }}>{agent.name}&apos;s Computer is Sleeping</div>
                <div style={{ fontSize: 12, color: '#888' }}>State preserved in SQLite. Click Wake to resume.</div>
                <PixelButton variant="primary" size="md" onClick={toggleSleep} disabled={busy}>
                  ⚡ Wake Computer
                </PixelButton>
              </div>
            )}

            {/* Animated Agent Virtual Mouse Cursor */}
            {!isSleeping && (
              <div
                style={{
                  position: 'absolute',
                  left: cursorPos.x,
                  top: cursorPos.y,
                  pointerEvents: 'none',
                  zIndex: 20,
                  transition: 'all 0.65s cubic-bezier(0.16, 1, 0.3, 1)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start'
                }}
              >
                {/* Mouse Cursor Pointer */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="#ffffff"
                  stroke="#000000"
                  strokeWidth="1.5"
                  style={{
                    filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
                    transform: isClicking ? 'scale(0.85)' : 'scale(1)',
                    transition: 'transform 0.15s ease'
                  }}
                >
                  <path d="M3 3l7 18 3-7 7-3L3 3z" />
                </svg>

                {/* Agent Action Bubble */}
                <div
                  style={{
                    background: 'rgba(20, 24, 33, 0.95)',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: 12,
                    fontSize: 9,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    marginTop: 2,
                    marginLeft: 14,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.6), 0 0 0 1px rgba(59, 130, 246, 0.4)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3b82f6' }} />
                  {agent.name}: {actionLabel}
                </div>
              </div>
            )}

            {/* Bottom OS Taskbar */}
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 32,
                background: 'rgba(18, 20, 26, 0.94)',
                borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 10px',
                zIndex: 5
              }}
            >
              {/* Start Menu & Quick Apps */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    background: '#3b82f6',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 700
                  }}
                >
                  ▦
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {['terminal', 'browser', 'code'].map((app) => (
                    <div
                      key={app}
                      onClick={() => setActiveWindow(app as typeof activeWindow)}
                      style={{
                        padding: '2px 8px',
                        background: activeWindow === app ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
                        borderRadius: 4,
                        fontSize: 10,
                        color: activeWindow === app ? '#fff' : '#888',
                        cursor: 'pointer'
                      }}
                    >
                      {app}
                    </div>
                  ))}
                </div>
              </div>

              {/* System Tray (Status, WiFi, Time) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#aaa', fontSize: 10 }}>
                <span style={{ color: isSleeping ? '#fbbf24' : '#10b981', fontWeight: 600 }}>
                  ● {liveStatus}
                </span>
                <span>📶</span>
                <span>🔊</span>
                <span style={{ color: '#eee', fontWeight: 500 }}>{clockTime || '12:00'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Bottom Controls Strip: Open desktop & Sleep (matches media_1792401361294.png) ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 16px 16px',
            background: '#121214'
          }}
        >
          {/* [↗ Open desktop] Button */}
          <button
            onClick={() => setIsFullscreenDesktop(!isFullscreenDesktop)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '10px 16px',
              background: '#242429',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 8,
              color: '#ffffff',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'background 0.15s ease'
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            {isFullscreenDesktop ? 'Exit full desktop' : 'Open desktop'}
          </button>

          {/* [☾ Sleep] / [⚡ Wake] Button */}
          <button
            onClick={toggleSleep}
            disabled={busy}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '10px 16px',
              background: isSleeping ? '#1e3a8a' : '#242429',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 8,
              color: isSleeping ? '#93c5fd' : '#ffffff',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isSleeping ? (
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              ) : (
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              )}
            </svg>
            {isSleeping ? 'Wake' : 'Sleep'}
          </button>
        </div>
      </div>
    </div>
  );
}
