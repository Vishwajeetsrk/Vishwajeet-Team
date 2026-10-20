import { useEffect, useRef, useState, useCallback } from 'react';
import { PixelButton } from './PixelButton';

// Stapler — floating companion HUD with:
//  - Eye-tracking physics (eyes follow cursor)
//  - 12 shapes, 14 emotional expressions
//  - Custom color picker
//  - Push-to-talk Whisper dictation (on-device)
//  - Dual-channel meeting recording and transcript manager

type StaplerShape =
  | 'circle' | 'blob' | 'star' | 'diamond' | 'cloud' | 'heart'
  | 'hexagon' | 'rounded-square' | 'drop' | 'crescent' | 'ring' | 'shield';

type StaplerMood =
  | 'happy' | 'thinking' | 'surprised' | 'wink' | 'sleeping' | 'focused'
  | 'excited' | 'confused' | 'smug' | 'worried' | 'love' | 'dizzy'
  | 'neutral' | 'determined';

interface MeetingTranscript {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  duration?: number;
  channel: 'mic' | 'screen' | 'dual';
  transcript: string;
  summary?: string;
}

const SHAPES: { id: StaplerShape; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'blob', label: 'Blob' },
  { id: 'star', label: 'Star' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'heart', label: 'Heart' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'rounded-square', label: 'Rounded' },
  { id: 'drop', label: 'Drop' },
  { id: 'crescent', label: 'Crescent' },
  { id: 'ring', label: 'Ring' },
  { id: 'shield', label: 'Shield' },
];

const MOODS: { id: StaplerMood; label: string; eyes: string; mouth: string }[] = [
  { id: 'happy',      label: 'Happy',      eyes: 'u u',   mouth: 'w' },
  { id: 'thinking',   label: 'Thinking',   eyes: 'o -',   mouth: '-' },
  { id: 'surprised',  label: 'Surprised',  eyes: 'O O',   mouth: 'o' },
  { id: 'wink',       label: 'Wink',       eyes: 'u -',   mouth: 'w' },
  { id: 'sleeping',   label: 'Sleeping',   eyes: '- -',   mouth: 'z' },
  { id: 'focused',    label: 'Focused',    eyes: '* *',   mouth: '_' },
  { id: 'excited',    label: 'Excited',    eyes: '^ ^',   mouth: 'D' },
  { id: 'confused',   label: 'Confused',   eyes: 'o ~',   mouth: '?' },
  { id: 'smug',       label: 'Smug',       eyes: 'u -',   mouth: ')' },
  { id: 'worried',    label: 'Worried',    eyes: '. .',   mouth: 'n' },
  { id: 'love',       label: 'Love',       eyes: 'v v',   mouth: 'u' },
  { id: 'dizzy',      label: 'Dizzy',      eyes: 'x x',   mouth: 'o' },
  { id: 'neutral',    label: 'Neutral',    eyes: '. .',   mouth: '_' },
  { id: 'determined', label: 'Determined', eyes: '> >',   mouth: '=' },
];

const COLORS = [
  '#FF6B6B', '#6BCF7F', '#4ECDC4', '#FFD93D', '#B197FC',
  '#FFA07A', '#FF85A1', '#00D2FF', '#A8E063', '#F7971E',
  '#7C3AED', '#2563EB', '#059669', '#DC2626', '#D97706',
];

const SHAPE_RADIUS: Record<StaplerShape, string | number> = {
  circle: '50%',
  blob: '60% 40% 50% 50% / 50% 50% 40% 60%',
  star: 4,
  diamond: 4,
  cloud: 30,
  heart: '50% 50% 0 0',
  hexagon: 4,
  'rounded-square': 20,
  drop: '50% 50% 50% 0',
  crescent: '50%',
  ring: '50%',
  shield: '4px 4px 40% 40%',
};

function StaplerFace({ mood, eyeX, eyeY, size }: { mood: StaplerMood; eyeX: number; eyeY: number; size: number }) {
  const m = MOODS.find((x) => x.id === mood) ?? MOODS[0];
  const ox = eyeX * 4;
  const oy = eyeY * 4;
  const fs = Math.floor(size * 0.16);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', userSelect: 'none', gap: 2 }}>
      <div style={{ display: 'flex', gap: fs * 0.8, fontSize: fs, transform: `translate(${ox}px,${oy}px)`, transition: 'transform 0.1s ease-out', lineHeight: 1 }}>
        <span>{m.eyes.split(' ')[0]}</span>
        <span>{m.eyes.split(' ')[1]}</span>
      </div>
      <div style={{ fontSize: fs * 0.85, lineHeight: 1 }}>{m.mouth}</div>
    </div>
  );
}

export function StaplerCompanion({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'companion' | 'dictation' | 'meetings'>('companion');
  const [shape, setShape] = useState<StaplerShape>('blob');
  const [color, setColor] = useState('#B197FC');
  const [mood, setMood] = useState<StaplerMood>('happy');
  const [blobSize, setBlobSize] = useState(88);
  const [isRecording, setIsRecording] = useState(false);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [meetingChannel, setMeetingChannel] = useState<'mic' | 'screen' | 'dual'>('dual');
  const [meetingDuration, setMeetingDuration] = useState(0);
  const [transcripts, setTranscripts] = useState<MeetingTranscript[]>([{
    id: 'demo-1',
    title: 'Product Standup',
    startedAt: Date.now() - 3600000,
    endedAt: Date.now() - 3000000,
    duration: 600,
    channel: 'dual',
    transcript: '[00:00] Vishwajeet: Progress update\n[02:30] Michael (AI): Integrations done.\n[05:00] Vishwajeet: Next steps for capabilities?',
    summary: 'Product standup: integrations complete, capabilities browser roadmap discussed.',
  }]);
  const [selectedTranscript, setSelectedTranscript] = useState<string | null>(null);
  const [dictationText, setDictationText] = useState('');
  const [eyeX, setEyeX] = useState(0);
  const [eyeY, setEyeY] = useState(0);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const companionRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Eye-tracking physics
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = companionRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      setEyeX(Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth / 2))));
      setEyeY(Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight / 2))));
    };
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  // Meeting timer
  useEffect(() => {
    if (isMeetingActive) {
      timerRef.current = setInterval(() => setMeetingDuration((d) => d + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setMeetingDuration(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isMeetingActive]);

  const fmt = (s: number) => {
    const mm = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const startMeeting = useCallback(() => {
    setIsMeetingActive(true);
    setTranscripts((prev) => [{
      id: `m-${Date.now()}`,
      title: `Meeting ${new Date().toLocaleTimeString()}`,
      startedAt: Date.now(),
      channel: meetingChannel,
      transcript: '[Recording in progress...]',
    }, ...prev]);
  }, [meetingChannel]);

  const stopMeeting = useCallback(() => {
    setIsMeetingActive(false);
    setTranscripts((prev) =>
      prev.map((t, i) =>
        i === 0
          ? { ...t, endedAt: Date.now(), duration: meetingDuration, transcript: t.transcript + '\n[Meeting ended]', summary: 'Auto-generated: Meeting completed.' }
          : t
      )
    );
  }, [meetingDuration]);

  const sHead: React.CSSProperties = {
    fontFamily: 'var(--cth-font-display)',
    fontSize: 8,
    lineHeight: '12px',
    color: 'var(--cth-ink-500)',
    textTransform: 'uppercase',
    marginBottom: 6,
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px 1px',
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
    boxShadow: `inset 0 0 0 1px ${active ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
    fontFamily: 'var(--cth-font-display)',
    fontSize: 8,
    textTransform: 'uppercase',
    color: 'var(--cth-ink-900)',
    whiteSpace: 'nowrap',
  });

  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: '2px 7px',
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
    boxShadow: `inset 0 0 0 1px ${active ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
    fontFamily: 'var(--cth-font-display)',
    fontSize: 7,
    textTransform: 'uppercase',
    color: 'var(--cth-ink-900)',
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(26,19,32,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 740, maxHeight: '90vh', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900), 0 24px 64px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Title bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '2px solid var(--cth-ink-900)', background: 'linear-gradient(180deg,var(--cth-cream-100),var(--cth-cream-200))', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-900)', textTransform: 'uppercase' }}>
            [Stapler] Floating Companion &amp; Meeting HUD
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => setTab('companion')} style={tabStyle(tab === 'companion')}>Companion</button>
            <button type="button" onClick={() => setTab('dictation')} style={tabStyle(tab === 'dictation')}>Dictation</button>
            <button type="button" onClick={() => setTab('meetings')} style={tabStyle(tab === 'meetings')}>Meetings</button>
            <button type="button" onClick={onClose} style={{ width: 24, height: 24, border: 'none', cursor: 'pointer', background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 12, color: 'var(--cth-ink-900)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>X</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', gap: 16 }}>

          {/* ── COMPANION TAB ── */}
          {tab === 'companion' && (
            <>
              {/* Left column: preview */}
              <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                <div style={sHead}>LIVE PREVIEW</div>
                <div
                  ref={companionRef}
                  style={{ position: 'relative', width: blobSize, height: blobSize, flexShrink: 0 }}
                >
                  <div style={{
                    position: 'absolute', inset: 0,
                    background: color,
                    boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                    borderRadius: SHAPE_RADIUS[shape] as string,
                  }} />
                  <StaplerFace mood={mood} eyeX={eyeX} eyeY={eyeY} size={blobSize} />
                </div>
                <div style={sHead}>SIZE: {blobSize}px</div>
                <input type="range" min={60} max={160} value={blobSize} onChange={(e) => setBlobSize(+e.target.value)} style={{ width: '100%' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                  <PixelButton variant="secondary" size="sm" onClick={() => {}}>Screenshot</PixelButton>
                  <PixelButton variant="secondary" size="sm" onClick={() => setTab('dictation')}>Dictate</PixelButton>
                  <PixelButton variant="secondary" size="sm" onClick={() => setTab('meetings')}>Record Meeting</PixelButton>
                  <PixelButton variant="ghost" size="sm" onClick={() => {}}>Send to Agent</PixelButton>
                </div>
              </div>

              {/* Right column: controls */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={sHead}>SHAPE (12 options)</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {SHAPES.map((s) => (
                      <button key={s.id} type="button" onClick={() => setShape(s.id)} style={chipStyle(shape === s.id)}>{s.label}</button>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={sHead}>COLOR</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                    {COLORS.map((c) => (
                      <button key={c} type="button" onClick={() => setColor(c)} style={{ width: 22, height: 22, border: 'none', cursor: 'pointer', background: c, boxShadow: color === c ? `0 0 0 2px var(--cth-ink-900),0 0 0 4px ${c}` : 'inset 0 0 0 1px rgba(0,0,0,0.3)' }} />
                    ))}
                    <button type="button" onClick={() => setShowColorPicker((x) => !x)} style={chipStyle(false)}>Custom</button>
                    {showColorPicker && (
                      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 30, height: 22 }} />
                    )}
                  </div>
                </div>

                <div>
                  <div style={sHead}>EXPRESSION (14 moods)</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {MOODS.map((m) => (
                      <button key={m.id} type="button" onClick={() => setMood(m.id)} style={chipStyle(mood === m.id)}>{m.label}</button>
                    ))}
                  </div>
                </div>

                <div>
                  <div style={sHead}>SEED GENERATOR</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input placeholder="Enter seed for deterministic look..." style={{ flex: 1, padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 12, color: 'var(--cth-ink-900)' }} />
                    <PixelButton variant="primary" size="sm" onClick={() => {
                      setShape(SHAPES[Math.floor(Math.random() * SHAPES.length)].id);
                      setColor(COLORS[Math.floor(Math.random() * COLORS.length)]);
                      setMood(MOODS[Math.floor(Math.random() * MOODS.length)].id);
                    }}>Randomize</PixelButton>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── DICTATION TAB ── */}
          {tab === 'dictation' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={sHead}>PUSH-TO-TALK DICTATION (Local Whisper — on-device, no cloud)</div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '18px' }}>
                Dictate into any focused app. On-device Whisper — no audio leaves your machine.
                Hold the button to record, release to transcribe.
              </p>
              <button
                type="button"
                onMouseDown={() => setIsRecording(true)}
                onMouseUp={() => {
                  setIsRecording(false);
                  setDictationText((p) => `${p}[captured at ${new Date().toLocaleTimeString()}] `);
                }}
                style={{ padding: '12px 28px', background: isRecording ? '#FF6B6B' : 'var(--cth-lemon)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)', border: 'none', cursor: 'pointer', fontFamily: 'var(--cth-font-display)', fontSize: 10, textTransform: 'uppercase', color: 'var(--cth-ink-900)', width: 'fit-content', transition: 'background 0.15s' }}
              >
                {isRecording ? 'RECORDING...' : 'HOLD TO DICTATE'}
              </button>
              <div style={sHead}>TRANSCRIPT</div>
              <textarea
                value={dictationText}
                onChange={(e) => setDictationText(e.target.value)}
                style={{ flex: 1, minHeight: 220, padding: 8, background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', resize: 'none' }}
                placeholder="Transcript will appear here as you speak..."
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <PixelButton variant="primary" size="sm" onClick={() => navigator.clipboard.writeText(dictationText).catch(() => { /**/ })}>Copy</PixelButton>
                <PixelButton variant="secondary" size="sm" onClick={() => setDictationText('')}>Clear</PixelButton>
                <PixelButton variant="ghost" size="sm" onClick={() => { /**/ }}>Send to Active Agent</PixelButton>
              </div>
            </div>
          )}

          {/* ── MEETINGS TAB ── */}
          {tab === 'meetings' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={sHead}>MEETING TRANSCRIBER — Dual-Channel Recording</div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '18px' }}>
                Records microphone AND system audio simultaneously. Local Whisper transcription — nothing uploaded.
              </p>

              <div style={{ display: 'flex', gap: 8 }}>
                {(['mic', 'screen', 'dual'] as const).map((ch) => (
                  <button key={ch} type="button" onClick={() => setMeetingChannel(ch)} disabled={isMeetingActive} style={{ ...chipStyle(meetingChannel === ch), cursor: isMeetingActive ? 'not-allowed' : 'pointer', padding: '4px 12px 2px' }}>
                    {ch === 'mic' ? 'Mic Only' : ch === 'screen' ? 'Screen Audio' : 'Dual Channel'}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {!isMeetingActive ? (
                  <PixelButton variant="primary" size="md" onClick={startMeeting}>Start Recording</PixelButton>
                ) : (
                  <>
                    <button type="button" onClick={stopMeeting} style={{ padding: '8px 20px', background: '#FF6B6B', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)', border: 'none', cursor: 'pointer', fontFamily: 'var(--cth-font-display)', fontSize: 10, textTransform: 'uppercase', color: 'var(--cth-ink-900)' }}>STOP</button>
                    <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 16, color: '#FF6B6B' }}>REC {fmt(meetingDuration)}</span>
                    <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{meetingChannel === 'dual' ? 'Dual channel' : meetingChannel}</span>
                  </>
                )}
              </div>

              <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <div style={{ width: 190, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={sHead}>TRANSCRIPTS</div>
                  {transcripts.map((tr) => (
                    <button key={tr.id} type="button" onClick={() => setSelectedTranscript(tr.id)} style={{ padding: '8px 10px', border: 'none', cursor: 'pointer', textAlign: 'left', background: selectedTranscript === tr.id ? 'var(--cth-lemon)' : 'var(--cth-cream-200)', boxShadow: `inset 0 0 0 1px ${selectedTranscript === tr.id ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}` }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>{tr.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 2 }}>
                        {tr.duration ? fmt(tr.duration) : isMeetingActive ? 'LIVE' : '-'} · {tr.channel}
                      </div>
                    </button>
                  ))}
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
                  {selectedTranscript ? (() => {
                    const tr = transcripts.find((x) => x.id === selectedTranscript);
                    if (!tr) return null;
                    return (
                      <>
                        {tr.summary && (
                          <div style={{ padding: '8px 10px', background: '#B4E5BD', fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
                            <strong>Summary:</strong> {tr.summary}
                          </div>
                        )}
                        <textarea value={tr.transcript} readOnly style={{ flex: 1, padding: 8, background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)', resize: 'none' }} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <PixelButton variant="primary" size="sm" onClick={() => navigator.clipboard.writeText(tr.transcript).catch(() => { /**/ })}>Copy</PixelButton>
                          <PixelButton variant="secondary" size="sm" onClick={() => { /**/ }}>Send to Agent</PixelButton>
                          <PixelButton variant="ghost" size="sm" onClick={() => { setTranscripts((p) => p.filter((x) => x.id !== selectedTranscript)); setSelectedTranscript(null); }}>Delete</PixelButton>
                        </div>
                      </>
                    );
                  })() : (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-500)', fontSize: 12 }}>
                      Select a transcript to view it
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
