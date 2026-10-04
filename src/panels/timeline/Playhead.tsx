/**
 * Playhead overlay. Subscribes to view.playhead only so moving it never re-renders the clip tree,
 * and page-flips the view when the playhead leaves it (playback, keyboard stepping).
 */
import React, { useEffect } from 'react';
import { useStore } from '@/state';
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
  const playhead = useStore((s) => s.project.sequences[seqId]?.view.playhead ?? 0);
  const playing = useStore((s) => s.playback.playing);

  useEffect(() => {
    if (width <= 0 || suppressFlip.current) return;
    const next = pageFlipScroll(playhead, scroll, width / zoom);
    if (next !== null && (playing || next !== scroll)) useStore.getState().setView(seqId, { scroll: next });
    // Intentionally only on playhead changes: scrolling away from the playhead must not snap back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing]);

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
