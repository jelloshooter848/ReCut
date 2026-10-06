/**
 * Playhead overlay. Subscribes to view.playhead only so moving it never re-renders the clip tree,
 * and page-flips the view when the playhead leaves it (playback, keyboard stepping).
 *
 * Deliberate rendering trade-off (roadmap §1, A4; docs/attack/performance.md): the line and its head are one
 * composited layer (will-change: transform) moved by transform only, at playheadX (frameToX snapped to a device
 * pixel). The transform is held by a paused Web Animation whose two keyframes are both the target transform (see
 * holdTransform): Chromium applies a change of an animated transform to the compositor directly, while a plain
 * style.transform change, even on a will-change layer, re-layerizes the whole page every frame. A paused animation
 * produces no frames while the playhead is still. The position is set in a layout effect of the same React commit
 * as the store update (before paint, so never a frame behind), and the layer has no pointer events, like the former
 * line and head: clicks and drags still reach the ruler / tracks underneath.
 */
import React, { useLayoutEffect, useRef } from 'react';
import { useStore, usePlayhead } from '@/state';
import { frameToX, pageFlipScroll, playheadX } from './viewMath';
import { RULER_H } from './types';
import { snappedBorderPx } from './waveBars';

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
  return <PlayheadLayer x={playheadX(playhead, zoom, scroll, dpr)} dpr={dpr} />;
}

const HEAD_STYLE = { height: RULER_H * 0.55 };
const LINE_STYLES = new Map<number, React.CSSProperties>();
/** The 1px line as whole device pixels (like a 1px border: 1 device px at dpr 1.5, 2 at dpr 2), as it rendered before. */
function lineStyle(dpr: number): React.CSSProperties {
  let st = LINE_STYLES.get(dpr);
  if (!st) { st = { width: snappedBorderPx(1, dpr) }; LINE_STYLES.set(dpr, st); }
  return st;
}

/** What holdTransform needs of an element (an HTMLElement; a stub in tests). */
export interface TransformTarget {
  style: { transform: string };
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
}

/**
 * Sets `el`'s transform to `transform` through a paused animation holding that exact value (two equal keyframes),
 * reusing the animation in `held` (its keyframes are replaced). Falls back to style.transform without Web Animations.
 */
export function holdTransform(el: TransformTarget, transform: string, held: { current: Animation | null }): void {
  const keyframes: Keyframe[] = [{ transform }, { transform }];
  const a = held.current;
  if (a && a.playState === 'paused' && a.effect && 'setKeyframes' in a.effect) { (a.effect as KeyframeEffect).setKeyframes(keyframes); return; }
  if (typeof el.animate !== 'function') { el.style.transform = transform; return; }
  a?.cancel();
  const n = el.animate(keyframes, { duration: 1e9, fill: 'both' });
  n.pause();
  held.current = n;
}

/** Web Animations available (renderer): the layer's transform is held by holdTransform, not by the style attribute. */
const HOLD = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

/** The playhead's layer at `x` (CSS px from the lane's left edge, on a device pixel: playheadX). */
export function PlayheadLayer({ x, dpr = 1 }: { x: number; dpr?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const held = useRef<Animation | null>(null);
  useLayoutEffect(() => { if (HOLD && ref.current) holdTransform(ref.current, `translateX(${x}px)`, held); }, [x]);
  useLayoutEffect(() => () => { held.current?.cancel(); held.current = null; }, []);
  return (
    <div ref={ref} className="tl-playhead-layer" style={HOLD ? undefined : { transform: `translateX(${x}px)` }}>
      <div className="tl-playhead" data-playhead style={lineStyle(dpr)} />
      <div className="tl-playhead-head" style={HEAD_STYLE} />
    </div>
  );
}
