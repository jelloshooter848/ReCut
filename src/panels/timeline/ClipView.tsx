/**
 * One clip on the timeline. Memoised: the parent only passes primitives plus store references that are
 * structurally shared, so unrelated edits (and playhead moves / small scrolls) do not re-render clips.
 */
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import type { Clip, MediaItem, Rational } from '@shared/model';
import { formatSecondsTimecode } from '@shared/time';
import type { WaveformData } from '@shared/ipc';
import { thumbs, waves } from '@/app/media';
import { peaksForRange } from '@/playback/thumbnails';
import { labelColorHex } from '@/components/ui/ColorSwatch';
import { CLIP_BAR_H, COMPACT_ROW_H } from './types';

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
}

const MAX_TILES_PER_REQUEST = 48;
const MAX_WAVE_CANVAS_PX = 4096;

function quantizeTime(t: number): number { return Math.round(t * 10) / 10; }

export const ClipView = memo(function ClipView(p: ClipViewProps) {
  const { clip, trackKind, height, zoom, media, fps, visFrom, visTo } = p;
  const x = clip.start * zoom;
  const w = Math.max(2, clip.duration * zoom);
  const compact = height < COMPACT_ROW_H;
  const bodyTop = compact ? 0 : CLIP_BAR_H;
  const bodyH = Math.max(4, height - 2 - bodyTop - 2);
  const frameSec = fps.den / fps.num;
  const path = media?.path ?? '';
  const offline = !media || media.offline;
  const isVideo = trackKind === 'video';
  const isImage = media?.kind === 'image';

  // ---- filmstrip -------------------------------------------------------------------------
  const tileW = Math.max(16, Math.round(bodyH * 16 / 9));
  const tileCount = Math.ceil(w / tileW);
  const firstTile = Math.max(0, Math.floor(visFrom / tileW));
  const lastTile = Math.min(tileCount, Math.ceil(visTo / tileW));
  const [tiles, setTiles] = useState<Record<number, string>>({});
  const tilesGen = useRef(0);
  const stripKey = `${path}|${tileW}|${zoom}|${clip.sourceIn}|${clip.speed}`;
  useEffect(() => { setTiles({}); tilesGen.current++; }, [stripKey]);
  useEffect(() => {
    if (!isVideo || offline || !media || media.kind === 'audio' || lastTile <= firstTile) return;
    const gen = tilesGen.current;
    const idx: number[] = []; const times: number[] = [];
    for (let i = firstTile; i < lastTile && idx.length < MAX_TILES_PER_REQUEST; i++) {
      if (tiles[i]) continue;
      idx.push(i);
      times.push(isImage ? 0 : quantizeTime(Math.max(0, clip.sourceIn + ((i * tileW + tileW / 2) / zoom) * frameSec * clip.speed)));
    }
    if (!idx.length) return;
    let alive = true;
    thumbs.filmstrip(path, times, tileW, media.id).then((urls) => {
      if (!alive || gen !== tilesGen.current) return;
      setTiles((prev) => { const next = { ...prev }; idx.forEach((i, j) => { if (urls[j]) next[i] = urls[j]; }); return next; });
    }).catch(() => { /* ignore */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, offline, path, firstTile, lastTile, tileW, zoom, clip.sourceIn, clip.speed, stripKey]);

  // ---- waveform --------------------------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [wave, setWave] = useState<WaveformData | null>(() => (path ? waves.peek(path) ?? null : null));
  useEffect(() => {
    if (isVideo || offline || !media || !path) return;
    const hit = waves.peek(path);
    if (hit !== undefined) { setWave(hit); return; }
    let alive = true;
    waves.get(path, media.id).then((d) => { if (alive) setWave(d); }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [isVideo, offline, path, media]);
  const waveX = visFrom;
  const waveW = Math.min(MAX_WAVE_CANVAS_PX, Math.max(0, visTo - visFrom));
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || isVideo) return;
    const cw = Math.max(1, Math.round(waveW)); const ch = Math.max(1, Math.round(bodyH));
    if (cv.width !== cw) cv.width = cw;
    if (cv.height !== ch) cv.height = ch;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (!wave) return;
    const t0 = clip.sourceIn + (waveX / zoom) * frameSec * clip.speed;
    const t1 = clip.sourceIn + ((waveX + cw) / zoom) * frameSec * clip.speed;
    const peaks = peaksForRange(wave, t0, t1, cw);
    const mid = ch / 2;
    const gain = Math.max(0, Math.min(2, clip.audio.volume)) * (clip.audio.muted ? 0.25 : 1);
    ctx.fillStyle = p.selected ? 'rgba(230, 245, 236, 0.95)' : 'rgba(175, 232, 200, 0.85)';
    for (let i = 0; i < cw; i++) {
      const v = Math.max(0.5, (peaks[i] / 255) * mid * gain);
      ctx.fillRect(i, mid - v, 1, v * 2);
    }
  }, [wave, waveX, waveW, bodyH, zoom, clip.sourceIn, clip.speed, clip.audio.volume, clip.audio.muted, frameSec, isVideo, p.selected]);

  // ---- labels ----------------------------------------------------------------------------
  const mediaFps = media?.probe?.video?.fps ?? fps;
  const srcTc = p.showSourceTc ? formatSecondsTimecode(clip.sourceIn, mediaFps) : null;
  const stripe = labelColorHex(clip.color);
  const characters = clip.characters.slice(0, 2);
  const fadeInW = clip.audio.fadeIn * zoom;
  const fadeOutW = clip.audio.fadeOut * zoom;

  const cls = useMemo(() => [
    'tl-clip', trackKind, p.selected ? 'selected' : '', clip.enabled ? '' : 'disabled', offline ? 'offline' : '',
    p.filter === 'dim' ? 'dim' : p.filter === 'hide' ? 'hide' : '', compact ? 'compact' : '', p.trackLocked ? 'locked' : '',
  ].filter(Boolean).join(' '), [trackKind, p.selected, clip.enabled, offline, p.filter, compact, p.trackLocked]);

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
      className={cls} data-clip-id={clip.id} data-track-id={p.trackId}
      style={{ left: x, width: w, height: height - 2 }}
      title={`${clip.name}${media ? `\n${media.name}` : ''}`}
    >
      {stripe ? <div className="tl-clip-stripe" style={{ background: stripe }} /> : null}
      <div className="tl-clip-bar">
        {clip.linkId ? <Link2 /> : null}
        <span className="tl-clip-name">{clip.name}</span>
        {srcTc ? <span className="tl-clip-tc">{srcTc}</span> : null}
        {clip.speed !== 1 ? <span className="tl-badge speed">{Math.round(clip.speed * 100)}%</span> : null}
        {offline ? <span className="tl-badge offline">OFFLINE</span> : null}
        {characters.map((c) => <span key={c} className="tl-badge" title={c}>{c}</span>)}
      </div>
      <div className="tl-clip-body" style={{ top: bodyTop }}>
        {isVideo ? tileEls : (
          <>
            <div className="tl-wave-line" />
            {waveW > 0 ? <canvas ref={canvasRef} className="tl-wave" style={{ left: waveX, width: waveW, height: bodyH }} /> : null}
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
      <div className={['tl-clip-edge', 'left', p.cutAtStart ? 'cut' : ''].join(' ')} data-edge="start" />
      <div className={['tl-clip-edge', 'right', p.cutAtEnd ? 'cut' : ''].join(' ')} data-edge="end" />
    </div>
  );
});
