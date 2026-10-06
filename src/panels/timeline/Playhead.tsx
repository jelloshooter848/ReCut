/**
 * Playhead overlay. Subscribes to view.playhead only so moving it never re-renders the clip tree,
 * and page-flips the view when the playhead leaves it (playback, keyboard stepping).
 *
 * Deliberate rendering trade-off (roadmap §1, A4; docs/attack/performance.md): the line and its head are one
 * composited layer (will-change: transform) moved by transform only, at playheadX (frameToX snapped to a device
 * pixel). A move is then a compositor-only transform update, not a repaint + re-layerization of the page. The
 * position is set in the same render as before (same React commit as the store update), and the layer has no
 * pointer events, like the former line and head: clicks and drags still reach the ruler / tracks underneath.
 */
import React, { useLayoutEffect, useRef } from 'react';
import { useStore, usePlayhead } from '@/state';
import { frameToX, pageFlipScroll, playheadX } from './viewMath';
import { RULER_H } from './types';

export interface PlayheadProps {
  seqId: string;
  zoom: number;
  scroll: number;
  width: number;
  /** Device pixel ratio (the line snaps to device pixels). */
  dpr: number;
  /** When true (e.g. during a ruler scrub or clip drag) the view is not auto-flipped. */
  suppressFlip: React.MutableRefObject<boolean>;
}

export function Playhead({ seqId, zoom, scroll, width, dpr, suppressFlip }: PlayheadProps) {
  const playhead = usePlayhead(seqId);
  const widthRef = useRef(width);
  widthRef.current = width;

  // Page flip. It runs in a store subscription, synchronously inside the setView that moved the playhead, so the
  // flip's scroll lands in the same React render and commit as the playhead move (one commit per step instead of a
  // second one from a layout effect). Only playhead / playing changes flip: scrolling away from the playhead must
  // not snap back.
  useLayoutEffect(() => {
    const flip = (ph: number, isPlaying: boolean, prevScroll: number, z: number) => {
      const w = widthRef.current;
      if (w <= 0 || suppressFlip.current) return;
      const next = pageFlipScroll(ph, prevScroll, w / z);
      if (next !== null && (isPlaying || next !== prevScroll)) useStore.getState().setView(seqId, { scroll: next });
    };
    const v0 = useStore.getState().project.sequences[seqId]?.view;
    let lastPh = v0?.playhead ?? 0;
    let lastPlaying = useStore.getState().playback.playing;
    // Same as the mount-time run of the former layout effect.
    if (v0) flip(v0.playhead, lastPlaying, v0.scroll, v0.zoom);
    return useStore.subscribe((s) => {
      const v = s.project.sequences[seqId]?.view;
      if (!v) return;
      const ph = v.playhead, isPlaying = s.playback.playing;
      if (ph === lastPh && isPlaying === lastPlaying) return;
      lastPh = ph; lastPlaying = isPlaying;
      flip(ph, isPlaying, v.scroll, v.zoom);
    });
  }, [seqId, suppressFlip]);

  const x = frameToX(playhead, zoom, scroll);
  if (x < -8 || x > width + 8) return null;
  return <PlayheadLayer x={playheadX(playhead, zoom, scroll, dpr)} />;
}

const HEAD_STYLE = { height: RULER_H * 0.55 };

/** The playhead's layer at `x` (CSS px from the lane's left edge, on a device pixel: playheadX). */
export function PlayheadLayer({ x }: { x: number }) {
  return (
    <div className="tl-playhead-layer" style={{ transform: `translateX(${x}px)` }}>
      <div className="tl-playhead" data-playhead />
      <div className="tl-playhead-head" style={HEAD_STYLE} />
    </div>
  );
}
