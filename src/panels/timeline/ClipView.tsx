/**
 * One clip on the timeline. Memoised: the parent only passes primitives plus store references that are
 * structurally shared, so unrelated edits (and playhead moves / small scrolls) do not re-render clips.
 */
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import type { Clip, MediaItem, Rational } from '@shared/model';
import { formatSequenceSecondsTimecode, validFpsOr } from '@shared/time';
import { AUDIO_KEY_PROPS, clipKeyframeFrames, TRANSFORM_KEY_PROPS } from '@shared/keyframes';
import type { WaveformData } from '@shared/ipc';
import { thumbs, waves } from '@/app/media';
import { peaksForRange } from '@/playback/thumbnails';
import { waveformStream, previewReason } from '@/playback/mediaSource';
import { labelColorHex } from '@/components/ui/ColorSwatch';
import { CLIP_BAR_H, COMPACT_ROW_H } from './types';
import { MEDIA_MIN_CLIP_PX } from './viewMath';
import { afterMediaSettle } from './mediaSettle';
import { drawWaveBars, snappedBorderPx, validDpr, waveBarExtents, waveCanvasSize } from './waveBars';
import { formatSyncOffset, mediaNeedsProxy } from './clipBadges';

export type FilterLook = 'none' | 'dim' | 'hide';

export interface ClipViewProps {
  clip: Clip;
  trackId: string;
  trackKind: 'video' | 'audio';
  trackLocked: boolean;
  height: number;
  zoom: number;
  selected: boolean;
  filter: FilterLook;
  media: MediaItem | undefined;
  fps: Rational;
  showSourceTc: boolean;
  /** Visible pixel range inside the clip (quantised by the parent). */
  visFrom: number;
  visTo: number;
  /** Whether the clip's start / end edge is a cut shared with an adjacent clip (rolling-edit affordance). */
  cutAtStart: boolean;
  cutAtEnd: boolean;
  /** Frames this clip is out of sync with its linked partner (0 / undefined = in sync). */
  syncOffset?: number;
  /** Device pixel ratio: the waveform canvas is sized and drawn in device pixels (default 1). */
  dpr?: number;
}

const MAX_TILES_PER_REQUEST = 48;
const NO_TILES: Record<number, string> = {};
const MAX_WAVE_CANVAS_PX = 4096;
/** .tl-clip border width (px): the clip body (and the waveform canvas in it) starts this far inside the clip box. */
const CLIP_BORDER_PX = 1;

function quantizeTime(t: number): number { return Math.round(t * 10) / 10; }

// Constant parts of a clip, created once: React skips an element it already rendered (same object), so a clip slot
// handed to another clip (a page flip) does not re-render the link icon or diff the edges.
const LINK_ICON = <Link2 />;
const WAVE_LINE = <div className="tl-wave-line" />;
const EDGE_START = <div className="tl-clip-edge left " data-edge="start" />;
const EDGE_START_CUT = <div className="tl-clip-edge left cut" data-edge="start" />;
const EDGE_END = <div className="tl-clip-edge right " data-edge="end" />;
const EDGE_END_CUT = <div className="tl-clip-edge right cut" data-edge="end" />;

/** More keyframes than this on one clip are not drawn (they would merge into a line). */
const MAX_KEY_MARKS = 400;

const waveMaxCache = new WeakMap<WaveformData, number>();
/** Loudest peak of a waveform (cached per data object) used to normalise the drawing. */
function waveMax(w: WaveformData): number {
  let m = waveMaxCache.get(w);
  if (m === undefined) { m = 1; for (let i = 0; i < w.peaks.length; i++) if (w.peaks[i] > m) m = w.peaks[i]; waveMaxCache.set(w, m); }
  return m;
}

export const ClipView = memo(function ClipView(p: ClipViewProps) {
  const { clip, trackKind, height, zoom, media, fps, visFrom, visTo } = p;
  const x = clip.start * zoom;
  const w = Math.max(2, clip.duration * zoom);
  const compact = height < COMPACT_ROW_H;
  const bodyTop = compact ? 0 : CLIP_BAR_H;
  const bodyH = Math.max(4, height - 2 - bodyTop - 2);
  const frameSec = fps.den / fps.num;
  // A nested sequence clip (Roadmap §8) has no media of its own: no filmstrip or waveform, a NEST badge instead.
  const nested = typeof clip.sequenceId === 'string' && clip.sequenceId !== '';
  const path = nested ? '' : media?.path ?? '';
  const offline = !nested && (!media || media.offline);
  const needsProxy = !offline && mediaNeedsProxy(media);
  const syncOffset = p.syncOffset ?? 0;
  const isVideo = trackKind === 'video';
  const isImage = media?.kind === 'image';

  // ---- filmstrip -------------------------------------------------------------------------
  const tileW = Math.max(16, Math.round(bodyH * 16 / 9));
  const tileCount = Math.ceil(w / tileW);
  const firstTile = Math.max(0, Math.floor(visFrom / tileW));
  const lastTile = Math.min(tileCount, Math.ceil(visTo / tileW));
  const stripKey = `${path}|${tileW}|${zoom}|${clip.sourceIn}|${clip.speed}`;
  // Tiles are tagged with the strip they belong to: a new strip shows none without an extra state update (a reset
  // effect would re-render every clip once more right after it mounts, e.g. on each playback page flip).
  const [strip, setStrip] = useState<{ key: string; tiles: Record<number, string> }>(() => ({ key: stripKey, tiles: NO_TILES }));
  // P-05: no filmstrip for narrow clips; requests wait MEDIA_SETTLE_MS for the view to settle (zooming / fast
  // scrolling re-runs this effect and cancels the timer) and for a pause in the editing (afterMediaSettle), and are
  // aborted when the clip leaves the viewport.
  const wantMedia = w >= MEDIA_MIN_CLIP_PX;
  const stripOn = wantMedia && isVideo && !offline && !nested && !!media && media.kind !== 'audio';
  const tileTime = (i: number) => (isImage ? 0 : quantizeTime(Math.max(0, clip.sourceIn + ((i * tileW + tileW / 2) / zoom) * frameSec * clip.speed)));
  // Fully cached strips (revisiting a view, a playback page flip) paint in the same render, read from the thumbnail
  // cache, instead of through an effect + state update (a second render and commit of every such clip). Kept in a
  // ref for the strip so a later LRU eviction cannot drop a tile already shown.
  const cachedRef = useRef<{ key: string; tiles: Record<number, string> }>({ key: '', tiles: NO_TILES });
  if (cachedRef.current.key !== stripKey) cachedRef.current = { key: stripKey, tiles: NO_TILES };
  let tiles = strip.key === stripKey ? strip.tiles : NO_TILES;
  if (cachedRef.current.tiles !== NO_TILES) tiles = tiles === NO_TILES ? cachedRef.current.tiles : { ...cachedRef.current.tiles, ...tiles };
  if (stripOn && lastTile > firstTile) {
    let n = 0; let got: Record<number, string> | null = {};
    for (let i = firstTile; i < lastTile && n < MAX_TILES_PER_REQUEST; i++) {
      if (tiles[i]) continue;
      n++;
      const u = thumbs.peek(path, tileTime(i), tileW);
      if (!u) { got = null; break; }
      got[i] = u;
    }
    if (got && n) { cachedRef.current = { key: stripKey, tiles: { ...cachedRef.current.tiles, ...got } }; tiles = { ...tiles, ...got }; }
  }
  useEffect(() => {
    if (!stripOn || lastTile <= firstTile) return;
    const idx: number[] = []; const times: number[] = [];
    for (let i = firstTile; i < lastTile && idx.length < MAX_TILES_PER_REQUEST; i++) {
      if (tiles[i]) continue;
      idx.push(i);
      times.push(tileTime(i));
    }
    if (!idx.length) return;
    const apply = (urls: string[]) => {
      if (ac.signal.aborted) return;
      if (!urls.some(Boolean)) return;
      setStrip((prev) => {
        const next = prev.key === stripKey ? { ...prev.tiles } : {};
        idx.forEach((i, j) => { if (urls[j]) next[i] = urls[j]; });
        return { key: stripKey, tiles: next };
      });
    };
    const ac = new AbortController();
    // Anything not fully cached (see above) waits for the view to settle and for a pause in the editing (mediaSettle).
    const cancel = afterMediaSettle(() => {
      thumbs.filmstrip(path, times, tileW, media.id, ac.signal).then(apply).catch(() => { /* ignore */ });
    });
    return () => { cancel(); ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripOn, path, firstTile, lastTile, tileW, zoom, clip.sourceIn, clip.speed, stripKey]);

  // ---- waveform --------------------------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The clip's audio stream (the one export renders; undefined = the first, see waveformStream).
  const waveSt = isVideo ? undefined : waveformStream(media, clip.audioStream ?? media?.preferredAudioStream);
  // Tagged with its media path and stream: a ClipView reused for another clip (ClipLane slots) never shows the previous
  // clip's waveform, and a cached one appears in the same render.
  const [waveState, setWaveState] = useState<{ path: string; stream?: number; data: WaveformData | null }>(() => ({ path, stream: waveSt, data: path ? waves.peek(path, waveSt) ?? null : null }));
  const wave = waveState.path === path && waveState.stream === waveSt ? waveState.data : (path ? waves.peek(path, waveSt) ?? null : null);
  useEffect(() => {
    if (!wantMedia || isVideo || offline || nested || !media || !path) return;
    const hit = waves.peek(path, waveSt);
    // Only when it differs: a same-value setState right after mount still costs a (bailed-out) render and commit.
    if (hit !== undefined) { if (hit !== wave) setWaveState({ path, stream: waveSt, data: hit }); return; }
    let alive = true;
    const cancel = afterMediaSettle(() => {
      waves.get(path, media.id, waveSt).then((d) => { if (alive) setWaveState((w) => (w.path === path && w.stream === waveSt && w.data === d ? w : { path, stream: waveSt, data: d })); }).catch(() => { /* ignore */ });
    });
    return () => { alive = false; cancel(); };
  }, [wantMedia, isVideo, offline, path, media, waveSt]); // eslint-disable-line react-hooks/exhaustive-deps
  const waveX = visFrom;
  const waveW = wantMedia ? Math.min(MAX_WAVE_CANVAS_PX, Math.max(0, visTo - visFrom)) : 0;
  const dpr = validDpr(p.dpr ?? 1);
  // Backing store in device pixels; the CSS size maps it 1:1 onto them (<= 0.5 device px wider than waveW). Canvas
  // column 0 sits at clip px waveX (the body starts inside the clip's left border, as rendered at this dpr), so the
  // waveform lines up with the timeline; the body clips what falls under the borders. Not squeezed by the global
  // `canvas { max-width: 100% }` (timeline.css), which would resample the bars.
  const waveSize = waveCanvasSize(waveW, bodyH, dpr);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || isVideo) return;
    const { w: cw, h: ch } = waveSize;
    if (cv.width !== cw) cv.width = cw;
    if (cv.height !== ch) cv.height = ch;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!wave) return;
    // Source time range of the canvas box (its CSS width, = cw device columns).
    const t0 = clip.sourceIn + (waveX / zoom) * frameSec * clip.speed;
    const t1 = clip.sourceIn + ((waveX + waveSize.cssW) / zoom) * frameSec * clip.speed;
    // One peak per device column: the max of every sample overlapping the column (no decimation).
    const peaks = peaksForRange(wave, t0, t1, cw);
    // Display normalisation: quiet sources are boosted (up to ~6x) so the shape stays readable, like most NLEs.
    const scale = 1 / Math.max(0.16, waveMax(wave) / 255);
    const gain = Math.max(0, Math.min(2, clip.audio.volume)) * (clip.audio.muted ? 0.25 : 1) * scale;
    ctx.fillStyle = p.selected ? 'rgba(230, 245, 236, 0.95)' : 'rgba(175, 232, 200, 0.85)';
    // Filled device-pixel bars (waveBars.ts): integer fillRects, runs of equal columns merged; the silent baseline
    // is 1 CSS px (0.5 px half height), at least 1 device px.
    drawWaveBars(ctx, waveBarExtents(peaks, ch, gain, 0.5 * dpr), cw);
  }, [wave, waveX, waveSize.w, waveSize.h, waveSize.cssW, bodyH, zoom, clip.sourceIn, clip.speed, clip.audio.volume, clip.audio.muted, frameSec, isVideo, p.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- labels ----------------------------------------------------------------------------
  const mediaFps = validFpsOr(media?.probe?.video?.fps, fps);
  const srcTc = p.showSourceTc ? formatSequenceSecondsTimecode(clip.sourceIn, mediaFps) : null;
  const stripe = labelColorHex(clip.color);
  const characters = clip.characters.slice(0, 2);
  // Keyframes (Roadmap §11): read-only diamonds at the clip's keyframes (picture properties on video, level on audio)
  // inside its visible range, from the clip's keyframe objects only (nothing for a clip without keyframes).
  const kfSource = isVideo ? clip.transform.keyframes : clip.audio.keyframes;
  const keyMarks = useMemo(() => {
    if (!kfSource) return null;
    const frames = clipKeyframeFrames(clip, isVideo ? TRANSFORM_KEY_PROPS : AUDIO_KEY_PROPS).filter((f) => f >= 0 && f < clip.duration);
    if (!frames.length || frames.length > MAX_KEY_MARKS) return null;
    return (
      <div className="tl-keyframes" data-keyframes={frames.length}>
        {frames.map((f) => <span key={f} className="tl-keyframe" style={{ left: (f + 0.5) * zoom }} title={`Keyframe at clip frame ${f}`} />)}
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kfSource, clip.duration, zoom, isVideo]);
  const fadeInW = clip.audio.fadeIn * zoom;
  const fadeOutW = clip.audio.fadeOut * zoom;

  const cls = useMemo(() => [
    'tl-clip', trackKind, p.selected ? 'selected' : '', clip.enabled ? '' : 'disabled', offline ? 'offline' : '', needsProxy ? 'needs-proxy' : '',
    p.filter === 'dim' ? 'dim' : p.filter === 'hide' ? 'hide' : '', compact ? 'compact' : '', p.trackLocked ? 'locked' : '', nested ? 'nested' : '',
  ].filter(Boolean).join(' '), [trackKind, p.selected, clip.enabled, offline, needsProxy, p.filter, compact, p.trackLocked, nested]);

  const tileEls: React.ReactNode[] = [];
  if (isVideo && !offline) {
    for (let i = firstTile; i < lastTile; i++) {
      const url = tiles[i];
      if (!url) continue;
      tileEls.push(<img key={i} className="tl-thumb" src={url} alt="" draggable={false} style={{ left: i * tileW, width: tileW }} />);
    }
  }

  return (
    <div
      className={cls} data-clip-id={clip.id} data-track-id={p.trackId} data-nested={nested ? clip.sequenceId : undefined}
      style={{ left: x, width: w, height: height - 2 }}
      title={nested ? `${clip.name}\nNested sequence (double-click to open in the timeline)` : `${clip.name}${media ? `\n${media.name}` : ''}`}
    >
      {stripe ? <div className="tl-clip-stripe" style={{ background: stripe }} /> : null}
      <div className="tl-clip-bar">
        {syncOffset !== 0 ? (
          <span className="tl-badge sync" data-sync-offset={syncOffset} title={`Out of sync with its linked ${isVideo ? 'audio' : 'video'} by ${formatSyncOffset(syncOffset)} frames`}>{formatSyncOffset(syncOffset)}</span>
        ) : null}
        {clip.linkId ? LINK_ICON : null}
        <span className="tl-clip-name">{clip.name}</span>
        {srcTc ? <span className="tl-clip-tc">{srcTc}</span> : null}
        {clip.speed !== 1 ? <span className="tl-badge speed">{Math.round(clip.speed * 100)}%</span> : null}
        {offline ? <span className="tl-badge offline">OFFLINE</span> : null}
        {nested ? <span className="tl-badge nested" title="Nested sequence">NEST</span> : null}
        {needsProxy ? <span className="tl-badge needs-proxy" title={previewReason(media) ? `Needs a proxy to preview: ${previewReason(media)}` : 'Needs a proxy to preview'}>PROXY</span> : null}
        {characters.map((c) => <span key={c} className="tl-badge" title={c}>{c}</span>)}
      </div>
      <div className="tl-clip-body" style={{ top: bodyTop }}>
        {nested ? <div className="tl-nest-body" /> : isVideo ? tileEls : (
          <>
            {WAVE_LINE}
            {waveW > 0 ? <canvas ref={canvasRef} className="tl-wave" style={{ left: waveX - snappedBorderPx(CLIP_BORDER_PX, dpr), width: waveSize.cssW, height: waveSize.cssH }} /> : null}
          </>
        )}
      </div>
      {!isVideo && fadeInW > 0 ? (
        <svg className="tl-fade" style={{ left: 0, width: fadeInW, top: bodyTop }} viewBox={`0 0 ${fadeInW} ${bodyH}`} preserveAspectRatio="none">
          <polygon points={`0,0 ${fadeInW},0 0,${bodyH}`} fill="rgba(0,0,0,0.45)" />
          <line x1={0} y1={bodyH} x2={fadeInW} y2={0} stroke="rgba(255,255,255,0.8)" strokeWidth={1} />
        </svg>
      ) : null}
      {!isVideo && fadeOutW > 0 ? (
        <svg className="tl-fade" style={{ right: 0, width: fadeOutW, top: bodyTop }} viewBox={`0 0 ${fadeOutW} ${bodyH}`} preserveAspectRatio="none">
          <polygon points={`0,0 ${fadeOutW},0 ${fadeOutW},${bodyH}`} fill="rgba(0,0,0,0.45)" />
          <line x1={0} y1={0} x2={fadeOutW} y2={bodyH} stroke="rgba(255,255,255,0.8)" strokeWidth={1} />
        </svg>
      ) : null}
      {keyMarks}
      {p.cutAtStart ? EDGE_START_CUT : EDGE_START}
      {p.cutAtEnd ? EDGE_END_CUT : EDGE_END}
    </div>
  );
});
