/**
 * Source Monitor: previews one media item with JKL transport, in/out marking, scrub bar, subtitle overlay and
 * Insert / Overwrite into the active sequence. Playback is driven by a SourcePlayer (one <video> element).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftToLine, ArrowRightToLine, BetweenHorizontalStart, ChevronFirst, ChevronLast, Eraser, Film, GripVertical, Library,
  LoaderCircle, Pause, Play, Repeat, Replace, StepBack, StepForward, TriangleAlert, Volume2, VolumeX, WifiOff,
} from 'lucide-react';
import type { MediaItem, SubtitleCue } from '@shared/model';
import { formatSequenceTimecode, formatSourceFrameTimecode, framesToSeconds, secondsToFrames, secondsToFramesFloor, fpsLabel } from '@shared/time';
import { pathToMediaUrl } from '@shared/ipc';
import { useStore, identityLabel, startProxy } from '@/state';
import type { StoreState } from '@/state';
import { SourcePlayer, resolvePlaybackPath, mediaFps, mediaSize, type SourcePlayerStatus } from '@/playback';
import { isStillImage } from '@/playback/mediaSource';
import { resumeAudio } from '@/app/media';
import { registerTransport, setActiveTransport, shuttle, useActiveTransportId, type Transport } from '@/app/transport';
import { setClipDrag } from '@/app/dnd';
import { Button, Dialog, EmptyState, IconButton, Select, Slider, TextField, TimecodeField, toast } from '@/components/ui';
import { isEditableTarget } from '@/keyboard/useShortcuts';
import type { PanelProps } from '../registry';
import { ScrubBar } from './ScrubBar';
import { WaveformView } from './WaveformView';
import { insertSourceIntoSequence, IMAGE_DURATION } from './insert';
import './source.css';

/** Max rate at which playback time is written back to the store. */
const REPORT_INTERVAL_MS = 1000 / 30;

type Zoom = 'fit' | '50' | '100';
const ZOOM_OPTIONS = [{ value: 'fit', label: 'Fit' }, { value: '50', label: '50%' }, { value: '100', label: '100%' }] as const;

function selectMedia(s: StoreState): MediaItem | undefined {
  const id = s.ui.sourceClip?.mediaId;
  return id ? s.project.media[id] : undefined;
}

/**
 * Primitive key capturing everything that changes what the player should load: the file, and the audio stream it
 * plays (`preferredAudioStream`; changing it reloads the item so the Source Monitor switches track).
 */
export function selectLoadKey(s: StoreState): string {
  const m = selectMedia(s);
  if (!m) return '';
  return [m.id, m.path, m.kind, m.offline ? 1 : 0, m.probe ? 1 : 0, m.probe?.browserPlayable ? 1 : 0, m.proxy.status, m.proxy.path ?? '', s.project.settings.useProxies ? 1 : 0, m.preferredAudioStream ?? ''].join('|');
}

/**
 * Error-card title for media that cannot be previewed: the probe's real reason (e.g. AC-3 audio) rather than the
 * video codec, which is usually fine (E-08).
 */
export function describeDecodeProblem(media: MediaItem | undefined): string {
  const p = media?.probe;
  if (!p) return 'Cannot decode this file';
  if (isStillImage(media)) {
    const m = /\.([^./\\]+)$/.exec(media!.path);
    return `${m ? m[1].toUpperCase() : 'This'} image needs a preview proxy`;
  }
  const reason = p.playabilityReason?.trim();
  if (reason) {
    const audio = /audio codec\s+([\w.-]+)/i.exec(reason);
    if (audio) return `${codecName(audio[1])} audio can't be decoded for preview`;
    const video = /video codec\s+([\w.-]+)/i.exec(reason);
    if (video) return `${codecName(video[1])} video can't be decoded for preview`;
    const container = /container\s+([\w.,-]+)/i.exec(reason);
    if (container) return `${container[1].split(',')[0].toUpperCase()} container can't be played for preview`;
    return `${reason.replace(/\s*not supported by Chromium\s*$/i, '')} can't be decoded for preview`;
  }
  return `Cannot decode ${p.video?.codec ?? p.audio[0]?.codec ?? p.container ?? 'this file'}`;
}

const CODEC_NAMES: Record<string, string> = { ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD', hevc: 'HEVC', h265: 'HEVC', h264: 'H.264', mpeg2video: 'MPEG-2', vc1: 'VC-1', pcm_s16le: 'PCM', mp2: 'MP2', mp3: 'MP3', aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', av1: 'AV1', vp9: 'VP9', prores: 'ProRes' };
function codecName(c: string): string { return CODEC_NAMES[c.toLowerCase()] ?? c.toUpperCase(); }

export function SourcePanel({ focused, active }: PanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const spRef = useRef<SourcePlayer | null>(null);
  const getPlayer = () => { if (!spRef.current) spRef.current = new SourcePlayer(); return spRef.current; };

  const media = useStore(selectMedia);
  const loadKey = useStore(selectLoadKey);
  const inPoint = useStore((s) => s.ui.sourceClip?.inPoint ?? null);
  const outPoint = useStore((s) => s.ui.sourceClip?.outPoint ?? null);
  const useProxies = useStore((s) => s.project.settings.useProxies);
  const subtitleTracks = useStore((s) => s.project.subtitleTracks);
  const activeSequenceId = useStore((s) => s.project.activeSequenceId);
  const transportActive = useActiveTransportId() === 'source';

  const [status, setStatus] = useState<SourcePlayerStatus>(() => getPlayer().status());
  const [time, setTime] = useState(0);
  const [durationEl, setDurationEl] = useState(0);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [subclipOpen, setSubclipOpen] = useState(false);
  const [subclipName, setSubclipName] = useState('');

  const fps = useMemo(() => mediaFps(media), [media]);
  // Stills are drawn with an <img>: the original (PNG / JPEG / WebP / GIF / BMP) or its PNG proxy.
  const isImage = media?.kind === 'image' || isStillImage(media);
  const [imageFailed, setImageFailed] = useState<string | null>(null);
  const isAudio = media?.kind === 'audio' || (!!media?.probe && !media.probe.video && media.probe.audio.length > 0);
  const resolution = useMemo(() => (media ? resolvePlaybackPath(media, useProxies) : null), [media, useProxies]);
  const probedDuration = media?.probe?.duration ?? 0;
  const duration = isImage ? IMAGE_DURATION : (durationEl > 0 ? durationEl : probedDuration);
  const durationFrames = Number.isFinite(duration) && duration > 0 ? Math.max(1, secondsToFrames(duration, fps)) : 0;
  const cues: SubtitleCue[] = useMemo(() => {
    if (!media) return [];
    const out: SubtitleCue[] = [];
    for (const tid of media.subtitleTrackIds) { const t = subtitleTracks[tid]; if (t) out.push(...t.cues); }
    return out.sort((a, b) => a.start - b.start);
  }, [media, subtitleTracks]);
  const currentCue = useMemo(() => cues.find((c) => c.start <= time && time < c.end) ?? null, [cues, time]);

  // ------------------------------------------------------------- refs shared with the transport / callbacks
  const live = useRef({ inPoint, outPoint, duration, fps, loop, isImage, mediaId: media?.id ?? null, playRange: null as { in: number; out: number } | null });
  live.current.inPoint = inPoint; live.current.outPoint = outPoint; live.current.duration = duration; live.current.fps = fps;
  live.current.loop = loop; live.current.isImage = isImage; live.current.mediaId = media?.id ?? null;
  const lastReported = useRef<number>(-1);
  const lastReportAt = useRef(0);

  const report = useCallback((t: number, force: boolean) => {
    const now = performance.now();
    if (!force && now - lastReportAt.current < REPORT_INTERVAL_MS) return;
    lastReportAt.current = now;
    lastReported.current = t;
    const st = useStore.getState();
    if (st.ui.sourceClip && st.ui.sourceClip.mediaId === live.current.mediaId && Math.abs(st.ui.sourceClip.time - t) > 1e-6) st.setSourceTime(t);
  }, []);

  // ------------------------------------------------------------- player lifecycle
  useEffect(() => {
    const sp = getPlayer();
    const offState = sp.onStateChange((s) => setStatus({ ...s }));
    const offTime = sp.onTime((t) => {
      setTime(t);
      const d = sp.duration(); if (d > 0) setDurationEl((prev) => (Math.abs(prev - d) > 1e-3 ? d : prev));
      const range = live.current.playRange;
      if (range && sp.isPlaying && sp.playbackRate > 0 && t >= range.out - 1e-4) {
        if (live.current.loop) { sp.seek(range.in); }
        else { live.current.playRange = null; sp.pause(); sp.seek(Math.max(range.in, range.out - framesToSeconds(1, live.current.fps))); }
      }
      report(t, !sp.isPlaying);
    });
    const offEnded = sp.onEnded(() => {
      if (live.current.loop) { sp.seek(live.current.playRange?.in ?? live.current.inPoint ?? 0); sp.play(); }
      else live.current.playRange = null;
    });
    return () => { offState(); offTime(); offEnded(); sp.destroy(); spRef.current = null; };
  }, [report]);

  // Attach the <video> to the stage once it exists (re-run when the stage is re-created, e.g. empty → loaded).
  useEffect(() => {
    const sp = spRef.current; const wrap = videoWrapRef.current;
    if (sp && wrap) sp.attach(wrap);
  }, [media?.id, isImage]);

  // Load / reload the media file when the item or its playable path changes.
  useEffect(() => {
    const sp = getPlayer();
    const st = useStore.getState();
    const m = selectMedia(st);
    const sameMedia = sp.currentMedia?.id === m?.id;
    const resume = sameMedia ? sp.currentTime() : (st.ui.sourceClip?.time ?? 0);
    setDurationEl(0);
    live.current.playRange = null;
    if (!m || m.kind === 'image' || isStillImage(m)) {
      sp.load(null, { useProxies: st.project.settings.useProxies });
      setStatus(sp.status());
      setTime(0);
      lastReported.current = 0;
      return;
    }
    sp.load(m, { useProxies: st.project.settings.useProxies });
    setStatus(sp.status());
    if (resume > 0) sp.seek(resume);
    setTime(sp.currentTime());
    lastReported.current = resume;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  // Follow external changes to ui.sourceClip.time (Transcript / Scenes panels) without feedback from our own reports.
  useEffect(() => useStore.subscribe((s, prev) => {
    const sc = s.ui.sourceClip; const psc = prev.ui.sourceClip;
    if (!sc || !psc || sc.time === psc.time) return;
    if (sc.mediaId !== psc.mediaId) return; // handled by the load effect
    const sp = spRef.current; if (!sp || sp.currentMedia?.id !== sc.mediaId) return;
    if (Math.abs(sc.time - lastReported.current) < 1e-6) return;
    lastReported.current = sc.time;
    sp.seek(sc.time);
  }), []);

  // ------------------------------------------------------------- transport actions
  const seekSeconds = useCallback((t: number) => { const sp = getPlayer(); sp.seek(t); setTime(sp.currentTime()); report(sp.currentTime(), true); }, [report]);
  const seekFrame = useCallback((f: number) => { const sp = getPlayer(); sp.seekFrame(Math.max(0, f)); setTime(sp.currentTime()); report(sp.currentTime(), true); }, [report]);
  const frameStart = useCallback(() => framesToSeconds(getPlayer().currentFrame(), live.current.fps), []);
  const play = useCallback(() => {
    const sp = getPlayer();
    void resumeAudio();
    live.current.playRange = null;
    if (live.current.loop) {
      // Loop on: play In → Out (or the whole clip) and wrap at the Out point.
      const { inPoint: i, outPoint: o, duration: d } = live.current;
      const range = { in: i ?? 0, out: o ?? d };
      if (range.out > range.in) {
        live.current.playRange = range;
        const t = sp.currentTime();
        if (t < range.in || t >= range.out - 1e-4) sp.seek(range.in);
      }
    }
    if (sp.playbackRate <= 0) sp.setRate(1);
    sp.play();
  }, []);
  const pause = useCallback(() => { getPlayer().pause(); }, []);
  const toggle = useCallback(() => { getPlayer().isPlaying ? pause() : play(); }, [play, pause]);
  const stepFrames = useCallback((n: number) => { const sp = getPlayer(); sp.stepFrames(n); setTime(sp.currentTime()); report(sp.currentTime(), true); }, [report]);
  const markIn = useCallback(() => { useStore.getState().setSourceIn(frameStart()); }, [frameStart]);
  const markOut = useCallback(() => {
    // Out point is exclusive: the end of the current frame.
    useStore.getState().setSourceOut(framesToSeconds(getPlayer().currentFrame() + 1, live.current.fps));
  }, []);
  const clearInOut = useCallback(() => { const st = useStore.getState(); st.setSourceIn(null); st.setSourceOut(null); }, []);
  const goToIn = useCallback(() => { seekSeconds(live.current.inPoint ?? 0); }, [seekSeconds]);
  const goToOut = useCallback(() => {
    const { outPoint: o, duration: d, fps: f } = live.current;
    const end = o ?? d;
    if (!Number.isFinite(end)) return;
    seekFrame(Math.max(0, secondsToFrames(end, f) - 1));
  }, [seekFrame]);
  const playInToOut = useCallback(() => {
    const { inPoint: i, outPoint: o, duration: d } = live.current;
    const range = { in: i ?? 0, out: o ?? d };
    if (!(range.out > range.in)) return;
    const sp = getPlayer();
    void resumeAudio();
    sp.pause();
    sp.seek(range.in);
    live.current.playRange = range;
    if (sp.playbackRate <= 0) sp.setRate(1);
    sp.play();
  }, []);

  const insertAt = useCallback((mode: 'insert' | 'overwrite') => { insertSourceIntoSequence(mode, { duration: live.current.duration }); }, []);

  const openSubclip = useCallback(() => {
    const m = media; if (!m) return;
    const n = Object.values(useStore.getState().project.scenes).filter((x) => x.mediaId === m.id).length + 1;
    setSubclipName(`${m.name} – Scene ${n}`);
    setSubclipOpen(true);
  }, [media]);
  const makeSubclip = useCallback(() => {
    const id = useStore.getState().sceneFromSource(subclipName.trim() || undefined);
    setSubclipOpen(false);
    if (id) toast('ok', `Added "${subclipName.trim() || 'scene'}" to the library`);
    else toast('warn', 'Could not create subclip — mark a non-empty In/Out range');
  }, [subclipName]);

  // ------------------------------------------------------------- Transport registration
  const goToEnd = useCallback(() => { const d = live.current.duration; if (Number.isFinite(d) && d > 0) seekFrame(Math.max(0, secondsToFrames(d, live.current.fps) - 1)); }, [seekFrame]);
  const transport = useMemo<Transport>(() => ({
    id: 'source',
    toggle, play, pause,
    stop: () => { getPlayer().setRate(0); },
    setRate: (r) => { const sp = getPlayer(); if (r !== 0) void resumeAudio(); live.current.playRange = null; sp.setRate(r); if (r !== 0 && !sp.isPlaying) sp.play(); },
    getRate: () => { const sp = getPlayer(); return sp.isPlaying ? sp.playbackRate : 0; },
    stepFrames,
    seekFrame,
    currentFrame: () => getPlayer().currentFrame(),
    durationFrames: () => { const d = live.current.duration; return Number.isFinite(d) && d > 0 ? secondsToFrames(d, live.current.fps) : 0; },
    goToStart: () => seekFrame(0),
    goToEnd,
    markIn, markOut, clearInOut, goToIn, goToOut, playInToOut,
    isPlaying: () => getPlayer().isPlaying,
  }), [toggle, play, pause, stepFrames, seekFrame, goToEnd, markIn, markOut, clearInOut, goToIn, goToOut, playInToOut]);
  useEffect(() => registerTransport(transport), [transport]);

  useEffect(() => {
    if (focused) { setActiveTransport('source'); useStore.getState().setActivePanel('source'); }
  }, [focused]);

  // Stop playback when the tab is hidden behind another panel.
  useEffect(() => { if (!active && spRef.current?.isPlaying) spRef.current.pause(); }, [active]);

  const activate = () => { setActiveTransport('source'); if (useStore.getState().ui.activePanel !== 'source') useStore.getState().setActivePanel('source'); };

  // Keyboard fallback when the panel element itself is focused (global shortcuts normally route via the active transport).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableTarget(e.target) || (e.target as HTMLElement).closest?.('.numfield, .slider, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    // Physical keys (e.code) + Shift, like the global dispatcher: CapsLock cannot flip mark / go-to (E-25).
    switch (e.code) {
      case 'Space': transport.toggle(); break;
      case 'KeyJ': shuttle(transport, -1); break;
      case 'KeyK': transport.setRate(0); break;
      case 'KeyL': shuttle(transport, 1); break;
      case 'ArrowLeft': transport.stepFrames(e.shiftKey ? -5 : -1); break;
      case 'ArrowRight': transport.stepFrames(e.shiftKey ? 5 : 1); break;
      case 'Home': transport.goToStart(); break;
      case 'End': transport.goToEnd(); break;
      case 'KeyI': if (e.shiftKey) transport.goToIn(); else transport.markIn(); break;
      case 'KeyO': if (e.shiftKey) transport.goToOut(); else transport.markOut(); break;
      case 'Comma': if (e.shiftKey) handled = false; else insertAt('insert'); break;
      case 'Period': if (e.shiftKey) handled = false; else insertAt('overwrite'); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  // ------------------------------------------------------------- derived display values
  const playing = status.state === 'playing';
  const loading = status.state === 'loading';
  const imagePath = isImage ? resolution?.path ?? null : null;
  const errored = !!media && (isImage ? !imagePath || imageFailed === imagePath : (status.state === 'error' || !resolution?.path));
  const size = mediaSize(media);
  const curFrame = secondsToFramesFloor(time, fps);
  const inFrame = inPoint !== null ? secondsToFrames(inPoint, fps) : null;
  const outFrame = outPoint !== null ? secondsToFrames(outPoint, fps) : null;
  const rangeFrames = (outFrame ?? durationFrames) - (inFrame ?? 0);
  const decodeError = describeDecodeProblem(media);
  const proxyBusy = media?.proxy.status === 'queued' || media?.proxy.status === 'running';

  const zoomStyle = (): React.CSSProperties | undefined => {
    if (zoom === 'fit' || !size) return undefined;
    const s = zoom === '50' ? 0.5 : 1;
    return { width: Math.round(size.width * s), height: Math.round(size.height * s) };
  };

  if (!media) {
    return (
      <div ref={rootRef} className="panel source-panel" tabIndex={0} onPointerDown={activate} data-state="empty">
        <EmptyState icon={Film} title="No clip loaded" description="Double-click a clip in the Project panel or a transcript result to open it here." />
      </div>
    );
  }

  return (
    <div ref={rootRef} className={['panel', 'source-panel', transportActive ? 'transport-active' : ''].filter(Boolean).join(' ')} tabIndex={0} onPointerDownCapture={activate} onKeyDown={onKeyDown}
      data-state={status.state} data-media-id={media.id} data-transport-active={transportActive ? 'true' : 'false'}>
      <div ref={stageRef} className={['source-stage', zoom !== 'fit' ? 'zoomed' : ''].filter(Boolean).join(' ')}>
        {isImage ? (
          imagePath ? (
            <img className={['source-image', zoom !== 'fit' ? 'zoomed' : ''].filter(Boolean).join(' ')} style={zoomStyle()} src={pathToMediaUrl(imagePath)} alt={media.name} draggable={false}
              data-testid="source-image" onError={() => setImageFailed(imagePath)} onLoad={() => setImageFailed((p) => (p === imagePath ? null : p))} />
          ) : null
        ) : (
          <div ref={videoWrapRef} className={['source-video-wrap', zoom !== 'fit' ? 'zoomed' : '', isAudio ? 'hidden-video' : ''].filter(Boolean).join(' ')} style={zoomStyle()} />
        )}
        {isAudio && !errored ? <WaveformView media={media} duration={duration} time={time} inPoint={inPoint} outPoint={outPoint} /> : null}
        <div className="source-overlay">
          <div className="source-label">
            <span className="name" title={media.path}>{media.name}</span>
            {identityLabel(media) && identityLabel(media) !== media.name ? <span className="identity">{identityLabel(media)}</span> : null}
          </div>
          <div className="source-badges">
            {status.usingProxy || (isImage && resolution?.usingProxy) ? <span className="source-badge proxy" title={isImage ? 'Showing the PNG preview proxy' : status.reason ?? 'Playing the proxy file'}>Proxy</span> : null}
            {media.offline ? <span className="source-badge offline"><WifiOff /> Offline</span> : null}
            {size ? <span className="source-badge" title="Source resolution">{size.width}×{size.height}</span> : null}
          </div>
          {currentCue ? <div className="source-subtitle">{currentCue.text}</div> : null}
          {loading && !errored ? <div className="source-spinner"><LoaderCircle className="spin" /></div> : null}
          {errored ? (
            <div className="source-error-card" role="alert">
              <TriangleAlert />
              {media.offline ? (
                <>
                  <div className="title">Media offline</div>
                  <div className="desc">{media.path}</div>
                </>
              ) : !media.probe ? (
                <>
                  <div className="title">{media.probeError ? 'Cannot read file' : 'Analyzing…'}</div>
                  <div className="desc">{media.probeError ?? status.reason ?? 'Waiting for probe'}</div>
                </>
              ) : isImage && imagePath ? (
                <>
                  <div className="title" data-testid="source-error-title">This image could not be decoded</div>
                  <div className="desc">{imagePath}</div>
                </>
              ) : (
                <>
                  <div className="title" data-testid="source-error-title">{decodeError}</div>
                  <div className="desc">{proxyBusy ? `Generating proxy… ${Math.round((media.proxy.progress ?? 0) * 100)}%` : 'Generate a proxy to preview this file.'}</div>
                  {!proxyBusy ? <Button size="sm" variant="primary" onClick={() => { void startProxy(media.id); }}>Generate proxy</Button> : null}
                  {media.proxy.status === 'failed' && media.proxy.error ? <div className="desc text-danger">{media.proxy.error}</div> : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <ScrubBar
        duration={duration} time={time} inPoint={inPoint} outPoint={outPoint} fps={fps}
        scenes={media.detectedScenes} cues={cues}
        onSeekFrame={(f) => { if (isImage) return; if (getPlayer().isPlaying) pause(); seekFrame(f); }}
      />

      <div className="source-tc-row">
        <TimecodeField value={curFrame} fps={fps} max={Math.max(0, durationFrames - 1)} min={0} onChange={(f) => { if (!isImage) seekFrame(f); }} title="Current time (click to type, drag to scrub)" className="tc-current" />
        <div className="tc-line2">
          <span className="tc-label">In</span>
          <TimecodeField value={inFrame ?? 0} fps={fps} min={0} max={Math.max(0, durationFrames)} tone={inFrame === null ? 'default' : 'playhead'}
            onChange={(f) => useStore.getState().setSourceIn(framesToSeconds(f, fps))} title="In point" className="tc-in" />
          <span className="tc-label">Out</span>
          <TimecodeField value={outFrame ?? durationFrames} fps={fps} min={0} max={Math.max(0, durationFrames)} tone={outFrame === null ? 'default' : 'playhead'}
            onChange={(f) => useStore.getState().setSourceOut(framesToSeconds(f, fps))} title="Out point" className="tc-out" />
          <div className="tc-meta">
            <span title={media.probe?.startTimecode ? `Source timecode, from the file's embedded start timecode ${media.probe.startTimecode.text}` : 'Source timecode'}>TC <span className="mono" data-testid="source-file-tc">{formatSourceFrameTimecode(curFrame, fps, media.probe?.startTimecode)}</span></span>
            <span title="Media duration" className="mono tc-mdur">{Number.isFinite(duration) ? formatSequenceTimecode(durationFrames, fps) : '—'}</span>
            <span title="Frame rate" className="tc-fps">{fpsLabel(fps)} fps</span>
          </div>
        </div>
        <span className="tc-label">Dur</span>
        <span className="mono text-sm tc-dur" title="In → Out duration">{formatSequenceTimecode(Math.max(0, rangeFrames), fps)}</span>
        <Select<Zoom> size="sm" value={zoom} options={ZOOM_OPTIONS} onChange={setZoom} title="Zoom" aria-label="Zoom" />
      </div>

      <div className="source-transport">
        <IconButton size="sm" icon={ArrowLeftToLine} label="Mark In" shortcut="I" className="mark-in" toggled={inPoint !== null} accent2 onClick={markIn} />
        <IconButton size="sm" icon={ChevronFirst} label="Go to In" shortcut="Shift+I" onClick={goToIn} />
        <IconButton size="sm" icon={StepBack} label="Step Back" shortcut="←" onClick={() => stepFrames(-1)} disabled={isImage} />
        <IconButton size="sm" icon={playing ? Pause : Play} label={playing ? 'Pause' : 'Play'} shortcut="Space" className="play" onClick={toggle} disabled={isImage || errored} />
        <IconButton size="sm" icon={StepForward} label="Step Forward" shortcut="→" onClick={() => stepFrames(1)} disabled={isImage} />
        <IconButton size="sm" icon={ChevronLast} label="Go to Out" shortcut="Shift+O" onClick={goToOut} />
        <IconButton size="sm" icon={ArrowRightToLine} label="Mark Out" shortcut="O" className="mark-out" toggled={outPoint !== null} accent2 onClick={markOut} />
        <span className="sep" />
        <IconButton size="sm" icon={Eraser} label="Clear In/Out" onClick={clearInOut} disabled={inPoint === null && outPoint === null} />
        <IconButton size="sm" icon={Repeat} label={loop ? 'Loop: on (play In → Out)' : 'Loop playback In → Out'} toggled={loop} onClick={() => { const next = !loop; setLoop(next); if (next && !getPlayer().isPlaying) playInToOut(); }} disabled={isImage} />
        <span className="sep" />
        <IconButton size="sm" icon={BetweenHorizontalStart} label="Insert" shortcut="," className="insert" onClick={() => insertAt('insert')} disabled={!activeSequenceId} />
        <IconButton size="sm" icon={Replace} label="Overwrite" shortcut="." className="overwrite" onClick={() => insertAt('overwrite')} disabled={!activeSequenceId} />
        <span
          className="drag-handle" role="button" aria-label="Drag marked range to the timeline" title="Drag marked range to the timeline"
          draggable
          onDragStart={(e) => {
            const d = live.current.duration;
            setClipDrag(e.dataTransfer, {
              mediaId: media.id, in: inPoint ?? 0, out: outPoint ?? (Number.isFinite(d) && d > 0 ? d : IMAGE_DURATION), name: media.name, origin: 'source',
            });
          }}
        >
          <GripVertical />
        </span>
        <IconButton size="sm" icon={Library} label="Make Subclip → Library" onClick={openSubclip} disabled={!(rangeFrames > 0)} />
        <span className="spacer" />
        <div className="volume">
          <IconButton size="sm" icon={muted ? VolumeX : Volume2} label={muted ? 'Unmute' : 'Mute'} toggled={muted} onClick={() => { const m = !muted; setMuted(m); getPlayer().setMuted(m); }} />
          <Slider value={muted ? 0 : volume} min={0} max={1} step={0.01} defaultValue={1} title="Volume"
            onChange={(v) => { setVolume(v); getPlayer().setVolume(v); if (muted && v > 0) { setMuted(false); getPlayer().setMuted(false); } }} />
        </div>
      </div>

      <Dialog open={subclipOpen} title="Make Subclip" onClose={() => setSubclipOpen(false)} width={360} onSubmit={makeSubclip}
        footer={<><Button onClick={() => setSubclipOpen(false)}>Cancel</Button><Button variant="primary" onClick={makeSubclip}>Add to Library</Button></>}>
        <div className="col gap-6">
          <label className="text-dim text-sm">Name</label>
          <TextField value={subclipName} onChange={setSubclipName} selectOnFocus autoFocus />
          <div className="text-dim text-xs mono">{formatSequenceTimecode(inFrame ?? 0, fps)} → {formatSequenceTimecode(outFrame ?? durationFrames, fps)} ({formatSequenceTimecode(Math.max(0, rangeFrames), fps)})</div>
        </div>
      </Dialog>
    </div>
  );
}

export default SourcePanel;
