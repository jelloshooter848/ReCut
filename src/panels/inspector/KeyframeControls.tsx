/**
 * Keyframe controls (Roadmap §11) for one animatable Inspector row (Position, Scale, Opacity, Level):
 *  - KeyframeButton, on the row: a diamond, filled when a selected clip has a keyframe at the playhead. Click adds a
 *    keyframe there holding the current value (the first one makes the property animated), or removes it.
 *  - KeyframeBar, under the row while the property is animated: previous / next keyframe (moves the playhead), the
 *    interpolation of the segment at the playhead (Linear / Ease) and Clear (back to a static value).
 * The value fields of an animated row edit the keyframe at the playhead, or add one there (ClipInspector,
 * writeClipProperty). Every action is one undo step (store actions in src/state/store.ts).
 */
import React from 'react';
import { ChevronLeft, ChevronRight, Diamond, X } from 'lucide-react';
import type { Clip, ID, KeyframeInterp } from '@shared/model';
import { clipEnd } from '@shared/timeline';
import { clipFrameAt, clipKeyframeFrames, keyframeAt, keyframesOf, KEYFRAME_GROUPS, segmentKeyframe, type KeyframeGroup } from '@shared/keyframes';
import { activeSequence, useStore } from '@/state';
import { getTransport } from '@/app/transport';
import { IconButton, Select } from '@/components/ui';

/** The active sequence's playhead now (read at click time; rows that are not animated do not subscribe to it). */
export function playheadNow(): number { return activeSequence(useStore.getState())?.view.playhead ?? 0; }

/** Whether any of `clips` animates `group`. */
export function groupAnimated(clips: readonly Clip[], group: KeyframeGroup): boolean {
  const props = KEYFRAME_GROUPS[group];
  return clips.some((c) => props.some((p) => keyframesOf(c, p)));
}

/** A keyframe of `group` at the playhead (at the clip frame an edit there lands on) in any of `clips`. */
function keyframeAtPlayhead(clips: readonly Clip[], group: KeyframeGroup, playhead: number): boolean {
  const props = KEYFRAME_GROUPS[group];
  return clips.some((c) => props.some((p) => !!keyframeAt(keyframesOf(c, p), clipFrameAt(c, playhead))));
}

function seek(seqId: ID, frame: number): void {
  const t = getTransport('program');
  if (t) t.seekFrame(frame); else useStore.getState().setView(seqId, { playhead: frame });
}

const GROUP_LABEL: Record<KeyframeGroup, string> = { position: 'position', scale: 'scale', opacity: 'opacity', volume: 'level' };

export function KeyframeButton({ seqId, clips, group, playhead }: { seqId: ID; clips: readonly Clip[]; group: KeyframeGroup; playhead: number | null }) {
  const on = playhead !== null && keyframeAtPlayhead(clips, group, playhead);
  const ids = clips.map((c) => c.id);
  return (
    <IconButton icon={Diamond} size="sm" className={['insp-kf-btn', on ? 'on' : ''].filter(Boolean).join(' ')} toggled={on}
      label={on ? `Remove ${GROUP_LABEL[group]} keyframe at the playhead` : `Add ${GROUP_LABEL[group]} keyframe at the playhead`}
      data-testid={`kf-${group}`} data-on={on ? '1' : '0'}
      onClick={() => {
        const st = useStore.getState();
        const ph = playheadNow();
        if (keyframeAtPlayhead(clips, group, ph)) st.removeClipKeyframe(seqId, ids, group, ph);
        else st.addClipKeyframe(seqId, ids, group, ph);
      }} />
  );
}

const INTERP_OPTIONS: { value: KeyframeInterp; label: string }[] = [{ value: 'linear', label: 'Linear' }, { value: 'ease', label: 'Ease' }];

export function KeyframeBar({ seqId, clips, group, playhead }: { seqId: ID; clips: readonly Clip[]; group: KeyframeGroup; playhead: number }) {
  const props = KEYFRAME_GROUPS[group];
  const ids = clips.map((c) => c.id);
  // Keyframes on the timeline (inside their clips' visible ranges), for previous / next.
  let prev = -Infinity, next = Infinity, count = 0;
  for (const c of clips) {
    for (const f of clipKeyframeFrames(c, props)) {
      const at = c.start + f;
      if (at < c.start || at >= clipEnd(c)) continue;
      count++;
      if (at < playhead && at > prev) prev = at;
      if (at > playhead && at < next) next = at;
    }
  }
  // The segment the playhead is in (or the keyframe on it): its interpolation.
  let seg: KeyframeInterp | null = null;
  for (const c of clips) {
    for (const p of props) {
      const kf = segmentKeyframe(keyframesOf(c, p), Math.round(playhead) - c.start);
      if (kf) { seg = kf.interp ?? 'linear'; break; }
    }
    if (seg) break;
  }
  const st = useStore.getState;
  return (
    <div className="insp-row insp-kf-row" data-prop={`${group}-keyframes`}>
      <div className="insp-label insp-kf-count" title="Keyframes inside the clip">{count} keyframe{count === 1 ? '' : 's'}</div>
      <div className="insp-ctl">
        <IconButton icon={ChevronLeft} size="sm" label="Previous keyframe" disabled={prev === -Infinity} data-testid={`kf-${group}-prev`} onClick={() => seek(seqId, prev)} />
        <IconButton icon={ChevronRight} size="sm" label="Next keyframe" disabled={next === Infinity} data-testid={`kf-${group}-next`} onClick={() => seek(seqId, next)} />
        <Select size="sm" value={seg ?? 'linear'} options={INTERP_OPTIONS} disabled={!seg} data-testid={`kf-${group}-interp`}
          title={seg ? 'Interpolation from the keyframe at (or before) the playhead to the next one' : 'Put the playhead on a keyframe or between two to set how it moves to the next one'}
          onChange={(v) => st().setClipKeyframeInterp(seqId, ids, group, playheadNow(), v)} />
        <IconButton icon={X} size="sm" label={`Remove all ${GROUP_LABEL[group]} keyframes (keeps the value at the playhead)`} data-testid={`kf-${group}-clear`}
          onClick={() => st().clearClipKeyframes(seqId, ids, group, playheadNow())} />
      </div>
    </div>
  );
}
