import { describe, it, expect } from 'vitest';
import { createSequence } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import type { Clip, Sequence } from '../../shared/model';
import { diffSequences, clipIdentityKey, summarizeDiff } from '../../src/panels/compare/diff';

const FPS = { num: 24, den: 1 };

function seqWith(clips: { start: number; duration: number; sourceIn: number; media?: string; speed?: number; track?: number; id?: string }[], fps = FPS): Sequence {
  const s = createSequence('S', fps);
  for (const c of clips) {
    const clip: Clip = makeClip({ mediaId: c.media ?? 'm1', name: c.media ?? 'm1', sourceIn: c.sourceIn, duration: c.duration, speed: c.speed ?? 1, kind: 'video' }, c.start);
    if (c.id) clip.id = c.id;
    s.videoTracks[c.track ?? 0].clips.push(clip);
  }
  return s;
}

describe('diffSequences', () => {
  it('classifies identical sequences as all same', () => {
    const a = seqWith([{ start: 0, duration: 48, sourceIn: 0, id: 'a1' }, { start: 48, duration: 24, sourceIn: 10, id: 'a2' }]);
    const b = seqWith([{ start: 0, duration: 48, sourceIn: 0, id: 'b1' }, { start: 48, duration: 24, sourceIn: 10, id: 'b2' }]);
    const r = diffSequences(a, b);
    expect(r.counts).toEqual({ same: 2, moved: 0, trimmed: 0, onlyA: 0, onlyB: 0 });
    expect(r.a.map((e) => e.kind)).toEqual(['same', 'same']);
    expect(r.b.map((e) => e.kind)).toEqual(['same', 'same']);
    expect(r.a[0].match?.clipId).toBe('b1');
    expect(r.b[1].match?.clipId).toBe('a2');
    expect(r.durationA).toBe(72); expect(r.durationB).toBe(72); expect(r.durationDelta).toBe(0);
    expect(r.fpsMismatch).toBe(false);
  });

  it('detects a clip removed from B as onlyA and reports the duration delta', () => {
    const a = seqWith([{ start: 0, duration: 48, sourceIn: 0 }, { start: 48, duration: 24, sourceIn: 10 }, { start: 72, duration: 48, sourceIn: 20 }]);
    const b = seqWith([{ start: 0, duration: 48, sourceIn: 0 }, { start: 48, duration: 48, sourceIn: 20 }]);
    const r = diffSequences(a, b);
    expect(r.counts.onlyA).toBe(1);
    expect(r.counts.same).toBe(1);
    expect(r.counts.moved).toBe(1);
    const only = r.a.find((e) => e.kind === 'onlyA')!;
    expect(only.sourceIn).toBe(10);
    expect(only.start).toBe(48);
    expect(r.durationDelta).toBe(-24);
    // ordered by timeline position
    expect(r.a.map((e) => e.start)).toEqual([0, 48, 72]);
  });

  it('detects a clip added to B as onlyB', () => {
    const a = seqWith([{ start: 0, duration: 48, sourceIn: 0 }]);
    const b = seqWith([{ start: 0, duration: 48, sourceIn: 0 }, { start: 48, duration: 12, sourceIn: 50, media: 'm2' }]);
    const r = diffSequences(a, b);
    expect(r.counts).toEqual({ same: 1, moved: 0, trimmed: 0, onlyA: 0, onlyB: 1 });
    expect(r.b[1].kind).toBe('onlyB');
    expect(r.b[1].mediaId).toBe('m2');
    expect(r.a).toHaveLength(1);
    expect(r.durationDelta).toBe(12);
  });

  it('detects moved clips with a position delta', () => {
    const a = seqWith([{ start: 0, duration: 48, sourceIn: 0, id: 'a1' }, { start: 48, duration: 24, sourceIn: 10, id: 'a2' }]);
    const b = seqWith([{ start: 0, duration: 24, sourceIn: 10, id: 'b2' }, { start: 24, duration: 48, sourceIn: 0, id: 'b1' }]);
    const r = diffSequences(a, b);
    expect(r.counts.moved).toBe(2);
    expect(r.counts.same).toBe(0);
    const a1 = r.a.find((e) => e.clipId === 'a1')!;
    expect(a1.kind).toBe('moved');
    expect(a1.positionDelta).toBe(24);
    expect(a1.match?.clipId).toBe('b1');
    const b2 = r.b.find((e) => e.clipId === 'b2')!;
    expect(b2.positionDelta).toBe(48);
    expect(b2.match?.clipId).toBe('a2');
  });

  it('detects trimmed clips and reports head/tail frame deltas', () => {
    // B: head trimmed 1s later (24 frames) and tail extended by 12 frames.
    const a = seqWith([{ start: 0, duration: 96, sourceIn: 10, id: 'a1' }]);
    const b = seqWith([{ start: 0, duration: 84, sourceIn: 11, id: 'b1' }]);
    const r = diffSequences(a, b);
    expect(r.counts).toEqual({ same: 0, moved: 0, trimmed: 1, onlyA: 0, onlyB: 0 });
    expect(r.a[0].kind).toBe('trimmed');
    expect(r.a[0].headDelta).toBe(24);
    expect(r.a[0].tailDelta).toBe(12);
    expect(r.b[0].headDelta).toBe(24);
    expect(r.b[0].tailDelta).toBe(12);
    expect(r.a[0].match?.clipId).toBe('b1');
    expect(r.a[0].positionDelta).toBeUndefined();
  });

  it('treats non-overlapping source ranges of the same media as different clips', () => {
    const a = seqWith([{ start: 0, duration: 24, sourceIn: 0 }]);
    const b = seqWith([{ start: 0, duration: 24, sourceIn: 50 }]);
    const r = diffSequences(a, b);
    expect(r.counts.trimmed).toBe(0);
    expect(r.counts.onlyA).toBe(1);
    expect(r.counts.onlyB).toBe(1);
  });

  it('prefers same-position matches when duplicates of the same clip exist', () => {
    const a = seqWith([{ start: 0, duration: 24, sourceIn: 0, id: 'a1' }, { start: 100, duration: 24, sourceIn: 0, id: 'a2' }]);
    const b = seqWith([{ start: 100, duration: 24, sourceIn: 0, id: 'b2' }, { start: 200, duration: 24, sourceIn: 0, id: 'b1' }]);
    const r = diffSequences(a, b);
    expect(r.a.find((e) => e.clipId === 'a2')!.kind).toBe('same');
    expect(r.a.find((e) => e.clipId === 'a2')!.match?.clipId).toBe('b2');
    expect(r.a.find((e) => e.clipId === 'a1')!.kind).toBe('moved');
    expect(r.a.find((e) => e.clipId === 'a1')!.match?.clipId).toBe('b1');
  });

  it('walks every video track and keeps track indices', () => {
    const a = seqWith([{ start: 0, duration: 24, sourceIn: 0, track: 0 }, { start: 0, duration: 24, sourceIn: 5, track: 1, media: 'm2' }]);
    const b = seqWith([{ start: 0, duration: 24, sourceIn: 0, track: 0 }]);
    const r = diffSequences(a, b);
    expect(r.counts.same).toBe(1);
    expect(r.counts.onlyA).toBe(1);
    expect(r.a.find((e) => e.kind === 'onlyA')!.trackIndex).toBe(1);
  });

  it('handles a frame-rate mismatch by comparing in A frames', () => {
    const a = seqWith([{ start: 0, duration: 48, sourceIn: 0 }], { num: 24, den: 1 });
    const b = seqWith([{ start: 0, duration: 96, sourceIn: 0 }], { num: 48, den: 1 });
    const r = diffSequences(a, b);
    expect(r.fpsMismatch).toBe(true);
    expect(r.counts.same).toBe(1);
    expect(r.durationDelta).toBe(0);
  });

  it('identity key includes media, source in, duration and speed', () => {
    const c = makeClip({ mediaId: 'm', name: 'm', sourceIn: 1.2345, duration: 10, speed: 2, kind: 'video' }, 0);
    expect(clipIdentityKey(c)).toBe('m|1235|10|2');
  });

  it('summarizes counts', () => {
    expect(summarizeDiff({ same: 3, moved: 1, trimmed: 0, onlyA: 1, onlyB: 0 })).toBe('3 same · 1 moved · 1 only in A');
    expect(summarizeDiff({ same: 0, moved: 0, trimmed: 0, onlyA: 0, onlyB: 0 })).toBe('No video clips');
  });
});
