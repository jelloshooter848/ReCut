/**
 * Playhead overlay. Subscribes to view.playhead only so moving it never re-renders the clip tree,
 * and page-flips the view when the playhead leaves it (playback, keyboard stepping).
 */
import React, { useLayoutEffect, useRef } from 'react';
import { useStore, usePlayhead } from '@/state';
import { frameToX, pageFlipScroll } from './viewMath';
import { RULER_H } from './types';

export interface PlayheadProps {
  seqId: string;
  zoom: number;
  scroll: number;
  width: number;
  /** When true (e.g. during a ruler scrub or clip drag) the view is not auto-flipped. */
  suppressFlip: React.MutableRefObject<boolean>;
}

export function Playhead({ seqId, zoom, scroll, width, suppressFlip }: PlayheadProps) {
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
  const left = Math.round(x);
  return (
    <>
      <div className="tl-playhead" style={{ left }} data-playhead />
      <div className="tl-playhead-head" style={{ left, height: RULER_H * 0.55 }} />
    </>
  );
}
