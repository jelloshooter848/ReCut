/**
 * Level-of-detail lane (P-05): clips narrower than LOD_MIN_CLIP_PX are drawn as merged bars into ONE canvas per
 * track lane covering the viewport, instead of one DOM subtree (+ filmstrip / waveform) per clip. Hit-testing for
 * these clips is positional (`data-lod-lane`, see viewMath.lodHit).
 */
import React, { useLayoutEffect, useRef } from 'react';
import type { Clip } from '@shared/model';
import type { FilterLook } from './ClipView';
import { mergeLodRuns } from './viewMath';

export interface LodLaneProps {
  kind: 'video' | 'audio';
  /** Narrow clips of this lane that overlap the view, sorted by start. */
  clips: Clip[];
  zoom: number;
  /** Content-space x (px) of the canvas' left edge (the scroll position). */
  originPx: number;
  widthPx: number;
  height: number;
  selected: ReadonlySet<string>;
  look: (clip: Clip) => FilterLook;
  offline: (clip: Clip) => boolean;
}

const FALLBACK = { video: '#3b5a8a', audio: '#3f7a5a' };
let palette: { video: string; audio: string } | null = null;
function colors(): { video: string; audio: string } {
  if (palette) return palette;
  try {
    const cs = getComputedStyle(document.documentElement);
    palette = { video: cs.getPropertyValue('--clip-video').trim() || FALLBACK.video, audio: cs.getPropertyValue('--clip-audio').trim() || FALLBACK.audio };
  } catch { palette = FALLBACK; }
  return palette;
}

export function LodLane({ kind, clips, zoom, originPx, widthPx, height, selected, look, offline }: LodLaneProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = Math.max(1, height - 2);
  const w = Math.max(1, Math.ceil(widthPx));

  // Redrawn on every render: the parent only re-renders on structure / zoom / scroll / selection changes, and a
  // lane draws at most a few thousand rects.
  useLayoutEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const base = colors()[kind];
    // Pass 1: plain clips merged into runs; a 1 px separator marks cuts where clips are at least 3 px wide.
    const plain: Clip[] = [];
    const special: Clip[] = [];
    for (const c of clips) (selected.has(c.id) || !c.enabled || look(c) !== 'none' || offline(c) ? special : plain).push(c);
    const runs = mergeLodRuns(plain, zoom, originPx, 0, w);
    ctx.fillStyle = base;
    for (const r of runs) ctx.fillRect(r.x, 0, r.w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (const r of runs) {
      for (let i = r.first + 1; i <= r.last; i++) {
        if (plain[i].duration * zoom >= 3) ctx.fillRect(Math.round(plain[i].start * zoom - originPx), 0, 1, h);
      }
    }
    // Pass 2: clips with a state (selected / disabled / filtered / offline) one by one.
    for (const c of special) {
      const a = c.start * zoom - originPx;
      const b = Math.max(a + 1, (c.start + c.duration) * zoom - originPx);
      const lk = look(c);
      ctx.globalAlpha = lk === 'hide' ? 0.12 : lk === 'dim' ? 0.35 : !c.enabled ? 0.6 : 1;
      ctx.fillStyle = offline(c) ? (kind === 'audio' ? '#5d2a2a' : '#6b2b2b') : base;
      ctx.fillRect(a, 0, b - a, h);
      if (selected.has(c.id)) { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(a, 0, b - a, h); }
      ctx.globalAlpha = 1;
    }
  });

  return <canvas ref={ref} className="tl-lod-lane" data-lod-lane style={{ left: originPx, top: 1, width: w, height: h }} />;
}
