/**
 * Program Monitor: renders the active sequence through SequencePlayer and owns the 'program' transport.
 *
 * Sync model
 *  - Paused: `sequence.view.playhead` in the store is the source of truth. Any outside change (timeline click,
 *    keyboard, TimecodeField) is pushed to the player with seek().
 *  - Playing: the player's clock drives; onFrame() writes the frame back with setView (cheap, no history).
 *  - Frame-driven UI (timecode readouts, scrub playhead) listens to a FrameSignal (<= ~15 Hz while playing)
 *    instead of React state, so the panel itself never re-renders per frame.
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftToLine, ArrowRightToLine, ArrowUpFromLine, BookmarkPlus, Captions, CaptionsOff, ChevronFirst, ChevronLast, Ellipsis, Expand, FoldHorizontal,
  Film, Frame, Maximize2, Minimize2, Monitor, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, TriangleAlert, Volume2, VolumeX, WifiOff, X,
} from 'lucide-react';
import type { Clip, ID, Marker, MediaItem, Rational, Sequence } from '@shared/model';
import { formatSequenceTimecode } from '@shared/time';
import { clipAt, nextEdit, prevEdit, sequenceDuration } from '@shared/timeline';
import { flattenSequence } from '@shared/nest';
import { SequencePlayer, planFrame, type MissingMedia } from '@/playback';
import { useStore } from '@/state/store';
import { activeSequence, activeSequenceDuration, originalTimecode } from '@/state/selectors';
import type { StoreState } from '@/state/types';
import { startProxy } from '@/state/mediaActions';
import { getAudioContext, getPool, resumeAudio } from '@/app/media';
import { registerTransport, setActiveTransport, shuttle, useActiveTransportId, type Transport } from '@/app/transport';
import { useLayoutStore } from '@/components/layout/layoutStore';
import { IconButton, Select, Slider, TimecodeField, openContextMenu, type MenuItem } from '@/components/ui';
import { isEditableTarget } from '@/keyboard/useShortcuts';
import { getShortcutLabel } from '@/keyboard/shortcuts';
import { COMMAND_IDS } from '@/keyboard/commandIds';
import type { PanelProps } from '../registry';
import { createFrameSignal, useFrame, type FrameSignal } from './frameSignal';
import { createProgramTransport } from './programTransport';
import { ScrubBar, type ScrubBarProps } from './ScrubBar';
import { AudioMeter } from './AudioMeter';
import { classifyMissing, sequenceMissing } from './missing';
import './program.css';

const DEFAULT_FPS: Rational = { num: 24000, den: 1001 };
const NO_MARKERS: readonly Marker[] = [];
const RESOLUTION_OPTIONS = [
  { value: 'full', label: 'Full' },
  { value: '1/2', label: '1/2' },
  { value: '1/4', label: '1/4' },
] as const;
type Resolution = (typeof RESOLUTION_OPTIONS)[number]['value'];

/** Monitor view preferences survive remounts (maximize / workspace switches) without living in the project. */
const prefs = { volume: 1, muted: false, tcMode: 'sequence' as 'sequence' | 'source', safeMargins: false, subtitles: true, loop: false };

interface MonitorStatus { missing: MissingMedia[]; proxy: boolean }
const EMPTY_STATUS: MonitorStatus = { missing: [], proxy: false };

/** True when nothing the player cares about changed (immer keeps untouched sub-trees referentially equal). */
function sameRenderContent(a: Sequence, b: Sequence): boolean {
  return a.videoTracks === b.videoTracks && a.audioTracks === b.audioTracks && a.subtitleTracks === b.subtitleTracks
    && a.fps === b.fps && a.width === b.width && a.height === b.height;
}

/** Top-most enabled video clip under the playhead. */
function topClipAt(seq: Sequence, frame: number): Clip | undefined {
  for (let i = seq.videoTracks.length - 1; i >= 0; i--) {
    const t = seq.videoTracks[i];
    if (t.muted) continue;
    const c = clipAt(t, frame);
    if (c && c.enabled) return c;
  }
  return undefined;
}

function fitBox(cw: number, ch: number, w: number, h: number): { w: number; h: number } {
  if (cw <= 0 || ch <= 0 || w <= 0 || h <= 0) return { w: 0, h: 0 };
  const s = Math.min(cw / w, ch / h);
  return { w: Math.max(2, Math.floor(w * s)), h: Math.max(2, Math.floor(h * s)) };
}

// ---------------------------------------------------------------- frame-driven readouts

function TimecodeOverlay({ frame, fps, mode, onToggle }: { frame: FrameSignal; fps: Rational; mode: 'sequence' | 'source'; onToggle(): void }) {
  const f = useFrame(frame);
  // Only the source timecode depends on the clips: in sequence mode an edit does not render this readout.
  const videoTracks = useStore((s) => (mode === 'source' ? activeSequence(s)?.videoTracks : undefined));
  let text = formatSequenceTimecode(f, fps);
  let file = '';
  if (mode === 'source' && videoTracks) {
    const st = useStore.getState();
    const seq = activeSequence(st);
    // Nested clips show the source timecode of the media under them (shared/nest.ts).
    const clip = seq ? topClipAt(flattenSequence(seq, st.project.sequences, st.project.media), f) : undefined;
    if (clip) {
      const tc = originalTimecode(clip, f, fps, st.project.media[clip.mediaId]);
      text = tc.sourceTimecode;
      file = tc.identityLabel || tc.fileName;
    } else { text = '--:--:--:--'; }
  }
  return (
    <button type="button" className={['pm-tc', mode === 'source' ? 'source' : ''].filter(Boolean).join(' ')} onClick={onToggle} data-testid="program-timecode"
      title={mode === 'source' ? 'Showing source timecode of the top clip. Click for sequence timecode.' : 'Showing sequence timecode. Click for source timecode of the top clip.'}>
      <span className="pm-tc-mode">{mode === 'source' ? 'SRC' : 'SEQ'}</span>
      <span>{text}</span>
      {file ? <span className="pm-tc-file">{file}</span> : null}
    </button>
  );
}

function CurrentTimecode({ frame, fps, onSeek }: { frame: FrameSignal; fps: Rational; onSeek(f: number): void }) {
  const f = useFrame(frame);
  const max = useStore(activeSequenceDuration);
  return <TimecodeField className="pm-tcfield" value={f} fps={fps} min={0} max={Math.max(0, max)} onChange={onSeek} title="Current time (click to type, drag to scrub)" />;
}

// ---------------------------------------------------------------- duration-driven parts
// The sequence duration changes with most timeline edits (a ripple insert, a trim at the end): only these read it,
// so an edit does not re-render the whole panel (its transport and tool buttons).

const SequenceDurationField = memo(function SequenceDurationField({ fps }: { fps: Rational }) {
  const duration = useStore(activeSequenceDuration);
  return <TimecodeField className="pm-dur" value={duration} fps={fps} onChange={() => { /* read-only */ }} scrub={false} disabled tone="default" title="Sequence duration" />;
});

const ProgramScrubBar = memo(function ProgramScrubBar(props: Omit<ScrubBarProps, 'durationFrames'>) {
  const duration = useStore(activeSequenceDuration);
  return <ScrubBar durationFrames={duration} {...props} />;
});

function RateChip({ playing, rate }: { playing: boolean; rate: number }) {
  if (!playing || rate === 1) return null;
  return <span className="pm-chip rate" title="Shuttle rate">{rate < 0 ? '◀' : '▶'} {Math.abs(rate)}×</span>;
}

// ---------------------------------------------------------------- panel

export function ProgramPanel({ zoneId, focused }: PanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<SequencePlayer | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const frameSig = useMemo(() => createFrameSignal(70), []);

  // ---- store (narrow selectors: primitives / stable refs only) ----
  const seqId = useStore((s) => s.project.activeSequenceId);
  const fps = useStore((s) => activeSequence(s)?.fps ?? DEFAULT_FPS);
  const seqW = useStore((s) => activeSequence(s)?.width ?? 1920);
  const seqH = useStore((s) => activeSequence(s)?.height ?? 1080);
  const inPoint = useStore((s) => activeSequence(s)?.view.inPoint ?? null);
  const outPoint = useStore((s) => activeSequence(s)?.view.outPoint ?? null);
  // Cached on the track arrays: this selector runs on every store update (each scrub / playback step). A boolean, so
  // edits that change the duration do not re-render the panel (the duration readouts subscribe themselves).
  const empty = useStore((s) => activeSequenceDuration(s) === 0);
  const markers = useStore((s) => activeSequence(s)?.markers ?? NO_MARKERS);
  const playing = useStore((s) => s.playback.playing);
  const rate = useStore((s) => s.playback.rate);
  const resolution = useStore((s) => s.project.settings.playbackResolution);
  const maximized = useLayoutStore((s) => s.maximized === zoneId);
  const transportActive = useActiveTransportId() === 'program';
  const mediaMap = useStore((s) => s.project.media);

  // ---- local UI state (rarely changing) ----
  const [tcMode, setTcMode] = useState(prefs.tcMode);
  const [safeMargins, setSafeMargins] = useState(prefs.safeMargins);
  const [subtitles, setSubtitles] = useState(prefs.subtitles);
  const [loopOn, setLoopOn] = useState(prefs.loop);
  const [loopActive, setLoopActive] = useState(false);
  const [volume, setVolume] = useState(prefs.volume);
  const [muted, setMuted] = useState(prefs.muted);
  useEffect(() => { prefs.tcMode = tcMode; prefs.safeMargins = safeMargins; prefs.subtitles = subtitles; prefs.loop = loopOn; }, [tcMode, safeMargins, subtitles, loopOn]);
  const [trueFullscreen, setTrueFullscreen] = useState(false);
  const [status, setStatus] = useState<MonitorStatus>(EMPTY_STATUS);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const statusKey = useRef('');
  const statusTimer = useRef<number | null>(null);

  // ---- missing / proxy status (throttled, only setState when it changes) ----
  const refreshStatus = useCallback(() => {
    const player = playerRef.current; if (!player) return;
    const st = useStore.getState();
    const outer = activeSequence(st);
    const seq = outer && flattenSequence(outer, st.project.sequences, st.project.media);
    let next = EMPTY_STATUS;
    if (seq) {
      // Distinct media files of the whole sequence (BUG-4), plus element failures under the playhead.
      const pool = getPool();
      const missing = sequenceMissing(seq, st.project.media, st.project.settings.useProxies, (p) => pool.getError(p), player.getMissing());
      const plan = planFrame(seq, st.project.media, player.currentFrame(), st.project.settings.useProxies);
      const proxy = plan.layers.some((l) => l.usingProxy) || plan.audio.some((a) => a.usingProxy);
      next = { missing, proxy };
    }
    const key = `${next.proxy}|${next.missing.map((m) => `${m.mediaId}:${m.clipId}:${m.reason}`).join(',')}`;
    if (key !== statusKey.current) { statusKey.current = key; setStatus(next); }
  }, []);
  const scheduleStatus = useCallback(() => {
    if (statusTimer.current !== null) return;
    statusTimer.current = window.setTimeout(() => { statusTimer.current = null; refreshStatus(); }, 150);
  }, [refreshStatus]);

  // ---- player lifecycle + store sync ----
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const player = new SequencePlayer(canvas, getPool(), getAudioContext() ?? undefined, { id: 'program' });
    playerRef.current = player;
    player.setMasterVolume(prefs.muted ? 0 : prefs.volume);

    let lastSeq: Sequence | null = null;
    let lastFlat: Sequence | null = null;
    let lastMedia: Record<ID, MediaItem> | null = null;
    let lastSettings: StoreState['project']['settings'] | null = null;

    const apply = (s: StoreState) => {
      const seq = activeSequence(s);
      if (!seq) { lastSeq = null; return; }
      const media = s.project.media;
      const settings = s.project.settings;
      const switched = !lastSeq || lastSeq.id !== seq.id;
      // Nested sequences are flattened into media clips (shared/nest.ts; memoized): an edit inside a nested sequence
      // changes the flattened sequence without changing this one.
      const flat = flattenSequence(seq, s.project.sequences, media);
      const nestChanged = flat !== lastFlat && (flat !== seq || lastFlat !== lastSeq);
      const changed = switched || nestChanged || (lastSeq !== seq && !sameRenderContent(lastSeq!, seq)) || media !== lastMedia || settings !== lastSettings;
      if (changed) {
        if (switched && player.isPlaying) player.pause();
        player.setSequence(flat, media, { useProxies: settings.useProxies, playbackResolution: settings.playbackResolution });
        if (switched) { player.seek(seq.view.playhead); frameSig.set(player.currentFrame(), true); }
        else if (!player.isPlaying) player.renderFrame(seq.view.playhead);
        scheduleStatus();
      }
      // Paused: the store playhead is the source of truth (timeline clicks, keyboard, inspector). Publish it to the
      // frame readouts here, in the store update's task, so React renders them in the same commit as the store
      // consumers (the player's onFrame a frame later then finds the value already published: no second commit).
      if (!player.isPlaying && seq.view.playhead !== player.currentFrame()) {
        player.seek(seq.view.playhead);
        frameSig.set(player.currentFrame(), true);
      }
      lastSeq = seq; lastFlat = flat; lastMedia = media; lastSettings = settings;
    };
    apply(useStore.getState());
    const unsubStore = useStore.subscribe(apply);

    const unsubFrame = player.onFrame((f) => {
      frameSig.set(f, !player.isPlaying);
      const st = useStore.getState();
      const seq = activeSequence(st);
      if (seq && seq.view.playhead !== f) st.setView(seq.id, { playhead: f });
      scheduleStatus();
    });
    const unsubState = player.onStateChange((ps) => {
      const st = useStore.getState();
      if (st.playback.playing !== ps.playing) st.setPlaying(ps.playing);
      if (st.playback.rate !== ps.rate) st.setPlaybackRate(ps.rate);
      setLoopActive(!!ps.loop);
      frameSig.set(ps.frame, true);
    });
    const unsubErr = getPool().onError(() => scheduleStatus());

    return () => {
      unsubStore(); unsubFrame(); unsubState(); unsubErr();
      if (statusTimer.current !== null) { window.clearTimeout(statusTimer.current); statusTimer.current = null; }
      player.destroy();
      playerRef.current = null;
      if (useStore.getState().playback.playing) useStore.getState().setPlaying(false);
      frameSig.dispose();
    };
  }, [frameSig, scheduleStatus]);

  // ---- canvas resolution never exceeds what the monitor shows (device pixels) ----
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    playerRef.current?.setDisplaySize(box.w * dpr, box.h * dpr);
  }, [box.w, box.h]);

  // ---- transport registration ----
  useEffect(() => {
    const t = createProgramTransport({ player: () => playerRef.current, setLoop: (on) => setLoopOn(on), loopOn: () => prefs.loop });
    transportRef.current = t;
    const unregister = registerTransport(t);
    return () => { unregister(); transportRef.current = null; };
  }, []);
  useEffect(() => { if (focused) setActiveTransport('program'); }, [focused]);

  // ---- player options mirrored from UI state ----
  useEffect(() => {
    const p = playerRef.current; if (!p) return;
    if (loopOn && inPoint !== null && outPoint !== null && outPoint > inPoint) p.setLoopRange(inPoint, outPoint);
    else p.setLoopRange(0, null);
  }, [loopOn, inPoint, outPoint, seqId]);
  useEffect(() => { playerRef.current?.setDrawSubtitles(subtitles); }, [subtitles]);
  useEffect(() => { prefs.volume = volume; prefs.muted = muted; playerRef.current?.setMasterVolume(muted ? 0 : volume); }, [volume, muted]);

  // ---- letterbox the canvas into the black area (object-fit: contain, computed so overlays can align) ----
  useLayoutEffect(() => {
    const el = videoRef.current; if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const b = fitBox(r.width, r.height, seqW, seqH);
      setBox((prev) => (prev.w === b.w && prev.h === b.h ? prev : b));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [seqW, seqH]);

  // ---- helpers ----
  const transport = () => transportRef.current;
  const focusRoot = () => rootRef.current?.focus({ preventScroll: true });
  const store = () => useStore.getState();

  const onScrub = useCallback((frame: number, phase: 'start' | 'move' | 'end') => {
    const p = playerRef.current;
    if (phase === 'start') { setActiveTransport('program'); focusRoot(); if (p?.isPlaying) p.pause(); }
    // A scrub step: the player coalesces seeks and touches only what is visible until the playhead rests.
    if (p) p.seek(frame);
    const st = useStore.getState();
    const id = st.project.activeSequenceId;
    if (id) st.setView(id, { playhead: frame });
    frameSig.set(p ? p.currentFrame() : frame, true);
  }, [frameSig]);

  const seekTo = (f: number) => transport()?.seekFrame(f);
  const goPrevEdit = () => {
    const seq = activeSequence(store()); if (!seq) return;
    const cur = transport()?.currentFrame() ?? seq.view.playhead;
    const f = prevEdit(seq, cur);
    seekTo(f ?? 0);
  };
  const goNextEdit = () => {
    const seq = activeSequence(store()); if (!seq) return;
    const cur = transport()?.currentFrame() ?? seq.view.playhead;
    const f = nextEdit(seq, cur);
    seekTo(f ?? sequenceDuration(seq));
  };
  const addMarkerHere = () => {
    const seq = activeSequence(store()); if (!seq) return;
    const t = transport()?.currentFrame() ?? seq.view.playhead;
    store().addMarker(seq.id, { time: t, name: '', note: '', duration: 0, kind: 'marker' });
  };
  const toggleTrueFullscreen = async () => {
    const api = window.recut;
    let fs = trueFullscreen;
    if (api?.toggleFullscreen) {
      try { fs = await api.toggleFullscreen(); } catch { fs = !trueFullscreen; }
    } else fs = !trueFullscreen;
    setTrueFullscreen(fs);
    const l = useLayoutStore.getState();
    if (fs && l.maximized !== zoneId) { if (l.maximized) l.toggleMaximize(); l.toggleMaximize(zoneId); }
    else if (!fs && l.maximized === zoneId) l.toggleMaximize();
  };

  const missingSplit = classifyMissing(status.missing, mediaMap);
  const generateProxies = () => { for (const id of missingSplit.proxyMediaIds) void startProxy(id); };
  const missingMenu = (): MenuItem[] => {
    const st = store();
    const seq = activeSequence(st);
    const items: MenuItem[] = [{ heading: `${status.missing.length} media file${status.missing.length === 1 ? '' : 's'} cannot be played` }];
    for (const m of status.missing) {
      const clip = seq && m.clipId ? findClipById(seq, m.clipId) : undefined;
      const media = st.project.media[m.mediaId];
      items.push({ label: `${media?.name ?? clip?.name ?? m.mediaId} — ${m.reason}`, disabled: true });
    }
    const mediaIds = [...new Set(status.missing.filter((m) => !m.channelProxy).map((m) => m.mediaId))].filter((id) => {
      const m = st.project.media[id];
      return m && !m.offline && m.probe && !(m.proxy.status === 'ready' || m.proxy.status === 'running' || m.proxy.status === 'queued');
    });
    items.push({ separator: true });
    items.push({ label: `Generate proxies (${mediaIds.length})`, disabled: mediaIds.length === 0, onSelect: () => { for (const id of mediaIds) void startProxy(id); } });
    return items;
  };

  /** Everything the narrow layout hides behind the "…" button. */
  const moreMenu = (): MenuItem[] => [
    { label: muted ? 'Unmute' : 'Mute', icon: muted ? VolumeX : Volume2, onSelect: () => setMuted((m) => !m) },
    { label: 'Subtitles', icon: Captions, checked: subtitles, onSelect: () => setSubtitles((v) => !v) },
    { label: 'Safe margins', icon: Frame, checked: safeMargins, onSelect: () => setSafeMargins((v) => !v) },
    { separator: true },
    { heading: 'Playback resolution' },
    ...RESOLUTION_OPTIONS.map((o) => ({ label: o.label, checked: resolution === o.value, onSelect: () => store().setSettings({ playbackResolution: o.value }) })),
    { separator: true },
    { label: maximized ? 'Restore panel' : 'Maximize panel', icon: maximized ? Minimize2 : Maximize2, onSelect: () => useLayoutStore.getState().toggleMaximize(zoneId) },
    { label: 'Full screen', icon: Expand, checked: trueFullscreen, onSelect: () => { void toggleTrueFullscreen(); } },
  ];

  // ---- keyboard fallback when the panel itself has focus (global shortcuts route through the transport) ----
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = transport(); if (!t) return;
    let handled = true;
    // Physical keys (e.code) + Shift, like the global dispatcher: CapsLock cannot flip mark / go-to.
    switch (e.code) {
      case 'Space': if (!e.repeat) t.toggle(); break;
      case 'KeyJ': if (!e.repeat) shuttle(t, -1); break;
      case 'KeyK': t.setRate(0); break;
      case 'KeyL': if (!e.repeat) shuttle(t, 1); break;
      case 'ArrowLeft': t.stepFrames(e.shiftKey ? -5 : -1); break;
      case 'ArrowRight': t.stepFrames(e.shiftKey ? 5 : 1); break;
      case 'Home': t.goToStart(); break;
      case 'End': t.goToEnd(); break;
      case 'KeyI': if (!e.repeat) { if (e.shiftKey) t.goToIn(); else t.markIn(); } break;
      case 'KeyO': if (!e.repeat) { if (e.shiftKey) t.goToOut(); else t.markOut(); } break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const hasInOut = inPoint !== null && outPoint !== null && outPoint > inPoint;
  const ioDuration = hasInOut ? outPoint! - inPoint! : 0;
  const tcTitle = (f: number | null) => (f === null ? '—' : formatSequenceTimecode(f, fps));

  return (
    <div
      ref={rootRef} className={['pm-root', transportActive ? 'transport-active' : ''].filter(Boolean).join(' ')} tabIndex={0} data-testid="program-panel" aria-label="Program Monitor"
      data-transport-active={transportActive ? 'true' : 'false'}
      onPointerDownCapture={() => setActiveTransport('program')}
      onFocus={() => setActiveTransport('program')}
      onKeyDown={onKeyDown}
    >
      <div className="pm-video" ref={videoRef} onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS') focusRoot(); }}
        onDoubleClick={(e) => { if ((e.target as HTMLElement).tagName === 'CANVAS') useLayoutStore.getState().toggleMaximize(zoneId); }}>
        <div className="pm-canvas-box" style={{ width: box.w || undefined, height: box.h || undefined }}>
          <canvas ref={canvasRef} className="pm-canvas" data-testid="program-canvas" width={2} height={2} />
          {safeMargins ? (
            <div className="pm-safe" aria-hidden>
              <div className="pm-safe-action" /><div className="pm-safe-title" /><div className="pm-safe-cross-h" /><div className="pm-safe-cross-v" />
            </div>
          ) : null}
        </div>
        {!seqId ? <div className="pm-empty"><Monitor /><span>No sequence open</span></div> : null}
        {seqId && empty ? (
          <div className="pm-empty" data-testid="program-empty-hint">
            <Film />
            <span className="pm-empty-title">Sequence is empty</span>
            <span>Insert from the Source monitor (<kbd>{getShortcutLabel(COMMAND_IDS.insert) || ','}</kbd> / <kbd>{getShortcutLabel(COMMAND_IDS.overwrite) || '.'}</kbd>) or drag media onto the Timeline.</span>
          </div>
        ) : null}
        <div className="pm-overlay tl">
          <TimecodeOverlay frame={frameSig} fps={fps} mode={tcMode} onToggle={() => setTcMode((m) => (m === 'sequence' ? 'source' : 'sequence'))} />
          {missingSplit.offline ? (
            <button type="button" className="pm-chip danger" data-testid="program-offline" title="Media files are offline — click for details"
              onClick={(e) => openContextMenu(missingMenu(), e.currentTarget)}>
              <WifiOff /> Offline: {missingSplit.offline}
            </button>
          ) : null}
          {missingSplit.needsProxy ? (
            <span className="pm-chip warn pm-chip-group" data-testid="program-needs-proxy">
              <button type="button" className="pm-chip-main" title="These files can't be decoded for preview — click for details" onClick={(e) => openContextMenu(missingMenu(), e.currentTarget)}>
                <TriangleAlert /> Needs proxy: {missingSplit.needsProxy}
              </button>
              {missingSplit.proxyMediaIds.length ? (
                <button type="button" className="pm-chip-action" data-testid="program-generate-proxies" title="Generate proxies for these files" onClick={generateProxies}>Generate proxies</button>
              ) : missingSplit.proxyBusy ? <span className="pm-chip-note">generating…</span> : null}
            </span>
          ) : null}
          {missingSplit.other ? (
            <button type="button" className="pm-chip warn" data-testid="program-missing" title="Some clips cannot be played — click for details"
              onClick={(e) => openContextMenu(missingMenu(), e.currentTarget)}>
              <TriangleAlert /> Can't play: {missingSplit.other}
            </button>
          ) : null}
        </div>
        <div className="pm-overlay tr">
          <RateChip playing={playing} rate={rate} />
          {status.proxy ? <span className="pm-chip proxy" data-testid="program-proxy" title="Playing from proxy media">Proxy</span> : null}
          {loopActive ? <span className="pm-chip loop" data-testid="program-loop" title="Looping in → out"><Repeat /> Loop</span> : null}
        </div>
      </div>

      <ProgramScrubBar inPoint={inPoint} outPoint={outPoint} markers={markers} frame={frameSig} onScrub={onScrub} />

      <div className="pm-bar" onClick={(e) => { if ((e.target as HTMLElement).closest('button')) focusRoot(); }}>
        <div className="pm-row main">
          <CurrentTimecode frame={frameSig} fps={fps} onSeek={seekTo} />
          <div className="pm-center">
            <IconButton icon={ChevronFirst} label="Go to start" shortcut={getShortcutLabel(COMMAND_IDS.goToStart)} data-testid="program-go-start" onClick={() => transport()?.goToStart()} />
            <IconButton icon={SkipBack} label="Go to previous edit" shortcut={getShortcutLabel(COMMAND_IDS.prevEdit)} onClick={goPrevEdit} />
            <IconButton icon={StepBack} label="Step back one frame" shortcut={getShortcutLabel(COMMAND_IDS.stepBack)} data-testid="program-step-back" onClick={() => transport()?.stepFrames(-1)} />
            <IconButton icon={playing ? Pause : Play} label={playing ? 'Pause' : 'Play'} shortcut={getShortcutLabel(COMMAND_IDS.playPause)} className={['pm-play', playing ? 'playing' : ''].join(' ')}
              data-testid="program-play" onClick={() => { void resumeAudio(); transport()?.toggle(); }} />
            <IconButton icon={StepForward} label="Step forward one frame" shortcut={getShortcutLabel(COMMAND_IDS.stepForward)} data-testid="program-step-forward" onClick={() => transport()?.stepFrames(1)} />
            <IconButton icon={SkipForward} label="Go to next edit" shortcut={getShortcutLabel(COMMAND_IDS.nextEdit)} onClick={goNextEdit} />
            <IconButton icon={ChevronLast} label="Go to end" shortcut={getShortcutLabel(COMMAND_IDS.goToEnd)} data-testid="program-go-end" onClick={() => transport()?.goToEnd()} />
          </div>
          <SequenceDurationField fps={fps} />
        </div>
        <div className="pm-row tools">
          <div className="pm-group">
            <IconButton icon={ArrowLeftToLine} label="Mark In" shortcut={getShortcutLabel(COMMAND_IDS.markIn)} accent2 toggled={inPoint !== null} data-testid="program-mark-in" onClick={() => transport()?.markIn()} />
            <IconButton icon={ArrowRightToLine} label="Mark Out" shortcut={getShortcutLabel(COMMAND_IDS.markOut)} accent2 toggled={outPoint !== null} data-testid="program-mark-out" onClick={() => transport()?.markOut()} />
            <IconButton icon={X} label="Clear In and Out" shortcut={getShortcutLabel(COMMAND_IDS.clearInOut)} data-testid="program-clear-inout" disabled={inPoint === null && outPoint === null} onClick={() => transport()?.clearInOut()} />
            <IconButton icon={Repeat} label="Loop playback between In and Out" toggled={loopOn} disabled={!hasInOut && !loopOn} data-testid="program-loop-toggle" onClick={() => setLoopOn((v) => !v)} />
            <span className="sep" />
            <IconButton icon={ArrowUpFromLine} label="Lift (remove In→Out, leave gap)" shortcut={getShortcutLabel(COMMAND_IDS.lift)} disabled={!hasInOut} data-testid="program-lift"
              onClick={() => { const id = store().project.activeSequenceId; if (id) store().liftInOut(id); }} />
            <IconButton icon={FoldHorizontal} label="Extract (remove In→Out, close gap)" shortcut={getShortcutLabel(COMMAND_IDS.extract)} disabled={!hasInOut} data-testid="program-extract"
              onClick={() => { const id = store().project.activeSequenceId; if (id) store().extractInOut(id); }} />
            <IconButton icon={BookmarkPlus} label="Add Marker" shortcut={getShortcutLabel(COMMAND_IDS.addMarker)} data-testid="program-add-marker" onClick={addMarkerHere} />
          </div>
          <div className="pm-io" title={`In ${tcTitle(inPoint)} · Out ${tcTitle(outPoint)} · Duration ${hasInOut ? tcTitle(ioDuration) : '—'}`}>
            <span className={inPoint !== null ? 'set' : ''}><b>In</b>{tcTitle(inPoint)}</span>
            <span className={outPoint !== null ? 'set' : ''}><b>Out</b>{tcTitle(outPoint)}</span>
            <span className={hasInOut ? 'set' : ''}><b>Dur</b>{hasInOut ? tcTitle(ioDuration) : '—'}</span>
          </div>
          <div className="pm-group pm-right">
            <AudioMeter player={() => playerRef.current as unknown as { getMasterGain?: () => AudioNode | null } | null} playing={playing} />
            <div className="pm-volume pm-wide">
              <IconButton icon={muted || volume === 0 ? VolumeX : Volume2} label={muted ? 'Unmute' : 'Mute'} toggled={muted} data-testid="program-mute" onClick={() => setMuted((m) => !m)} />
              <Slider value={muted ? 0 : volume} min={0} max={1} step={0.01} defaultValue={1} title="Master volume"
                onChange={(v) => { setVolume(v); if (muted && v > 0) setMuted(false); }} />
            </div>
            <span className="sep pm-wide" />
            <Select<Resolution> size="sm" className="pm-wide" value={resolution} options={RESOLUTION_OPTIONS} title="Playback resolution" aria-label="Playback resolution" data-testid="program-resolution"
              onChange={(v) => store().setSettings({ playbackResolution: v })} />
            <span className="sep pm-wide" />
            <IconButton icon={subtitles ? Captions : CaptionsOff} className="pm-wide" label={subtitles ? 'Hide subtitles' : 'Show subtitles'} toggled={subtitles} data-testid="program-subtitles" onClick={() => setSubtitles((v) => !v)} />
            <IconButton icon={Frame} className="pm-wide" label="Safe margins" toggled={safeMargins} data-testid="program-safe-margins" onClick={() => setSafeMargins((v) => !v)} />
            <IconButton icon={maximized ? Minimize2 : Maximize2} label={maximized ? 'Restore panel' : 'Maximize panel'} shortcut={getShortcutLabel(COMMAND_IDS.maximizePanel)} data-testid="program-maximize" onClick={() => useLayoutStore.getState().toggleMaximize(zoneId)} />
            <IconButton icon={Expand} className="pm-wide" label="Full screen (program monitor)" shortcut={getShortcutLabel(COMMAND_IDS.fullscreenProgram)} toggled={trueFullscreen} data-testid="program-fullscreen" onClick={() => { void toggleTrueFullscreen(); }} />
            <IconButton icon={Ellipsis} className="pm-more" label="More monitor options" data-testid="program-more" onClick={(e) => openContextMenu(moreMenu(), e.currentTarget)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function findClipById(seq: Sequence, id: ID): Clip | undefined {
  for (const t of seq.videoTracks) for (const c of t.clips) if (c.id === id) return c;
  for (const t of seq.audioTracks) for (const c of t.clips) if (c.id === id) return c;
  return undefined;
}

export default ProgramPanel;
