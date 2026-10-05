import React, { memo } from 'react';
import { AudioLines, Blend, Moon } from 'lucide-react';
import type { Clip, Transition, TransitionType } from '@shared/model';
import { clipEnd } from '@shared/timeline';

export const TRANSITION_LABEL: Record<TransitionType, string> = {
  crossDissolve: 'Cross Dissolve', dipToBlack: 'Dip to Black', audioCrossfade: 'Audio Crossfade',
};

/** Pixel span of a transition given its clips. Centered on the cut when both sides exist. */
export function transitionSpan(tr: Transition, clipsById: Map<string, Clip>, zoom: number, duration = tr.duration): { x: number; w: number; anchor: number; centered: boolean } | null {
  const out = tr.outClipId ? clipsById.get(tr.outClipId) : undefined;
  const inc = tr.inClipId ? clipsById.get(tr.inClipId) : undefined;
  if (out && inc) { const cut = inc.start; return { x: (cut - duration / 2) * zoom, w: duration * zoom, anchor: cut, centered: true }; }
  if (inc) return { x: inc.start * zoom, w: duration * zoom, anchor: inc.start, centered: false };
  if (out) return { x: (clipEnd(out) - duration) * zoom, w: duration * zoom, anchor: clipEnd(out), centered: false };
  return null;
}

export interface TransitionViewProps { transition: Transition; trackId: string; x: number; w: number; height: number; selected: boolean }

export const TransitionView = memo(function TransitionView({ transition, trackId, x, w, height, selected }: TransitionViewProps) {
  const Icon = transition.type === 'crossDissolve' ? Blend : transition.type === 'dipToBlack' ? Moon : AudioLines;
  return (
    <div
      className={['tl-transition', selected ? 'selected' : ''].filter(Boolean).join(' ')}
      data-transition-id={transition.id} data-track-id={trackId}
      style={{ left: x, width: Math.max(4, w), height: height - 2 }}
      title={`${TRANSITION_LABEL[transition.type]} · ${transition.duration} frames`}
    >
      {w >= 18 ? <Icon /> : null}
      <div className="tl-tr-edge left" data-edge="left" />
      <div className="tl-tr-edge right" data-edge="right" />
    </div>
  );
});
