/**
 * Keyframes (Roadmap §11): evaluation (linear, ease, edges), clip-relative time through moves, trims, razor and speed
 * changes, the pure edits, load-time repair, store actions (one undo step each) and the FFmpeg expression the export
 * builds (evaluated here with the same arithmetic FFmpeg uses).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createProject, createSequence, normalizeProject, normalizeProjectWithReport } from '../../shared/project';
import type { Clip, Keyframe, Sequence, Track } from '../../shared/model';
import {
  addKeyframeAt, clearKeyframes, clipFrameAt, clipKeyframeFrames, easeCurve, evaluateClipProperty, evaluateKeyframes, exprNum,
  hasKeyframes, keyframeAt, keyframeRange, keyframesExpr, keyframesOf, normalizeKeyframeList, putKeyframe, removeKeyframeAt,
  segmentKeyframe, setInterpAt, shiftClipKeyframes, transformAt, writeClipProperty, MAX_KEYFRAMES_PER_PROPERTY,
} from '../../shared/keyframes';
import {
  clearRange, clipEnd, makeClip, moveClips, razorAt, rippleTrimStart, rollEdit, slideClip, slipClip, sortTrack, splitClip, trimEnd, trimStart,
} from '../../shared/timeline';
import { useStore, resetStore } from '../../src/state/store';

const FPS = { num: 24, den: 1 };
const INF = () => Infinity;
const kf = (frame: number, value: number, interp?: 'ease'): Keyframe => (interp ? { frame, value, interp } : { frame, value });

function put(track: Track, start: number, duration: number, o: { sourceIn?: number; speed?: number; linkId?: string } = {}): Clip {
  const c = makeClip({ mediaId: 'm', name: `${track.name}@${start}`, sourceIn: o.sourceIn ?? 10, duration, speed: o.speed, kind: track.kind, linkId: o.linkId ?? null }, start);
  track.clips.push(c);
  sortTrack(track);
  return c;
}
const seqWith = (): Sequence => createSequence('S', FPS);

/** The export's expression as a JS function of the clip frame (FFmpeg's clip(x, lo, hi) and + - * / only). */
function exprFn(keys: Keyframe[]): (k: number) => number {
  const src = keyframesExpr(keys, 'K');
  expect(src).toMatch(/^[\d.+\-*/(),K clip]+$/);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function('clip', 'K', `return ${src};`) as (c: (x: number, a: number, b: number) => number, k: number) => number;
  const clip = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
  return (k) => f(clip, k);
}

describe('evaluation', () => {
  it('holds the first value before the first keyframe and the last after the last', () => {
    const keys = [kf(10, 2), kf(20, 4)];
    expect(evaluateKeyframes(keys, -100)).toBe(2);
    expect(evaluateKeyframes(keys, 10)).toBe(2);
    expect(evaluateKeyframes(keys, 20)).toBe(4);
    expect(evaluateKeyframes(keys, 1e9)).toBe(4);
    expect(evaluateKeyframes(keys, NaN)).toBe(2);
  });

  it('a single keyframe is a constant', () => {
    for (const k of [-5, 0, 7, 100]) expect(evaluateKeyframes([kf(7, 0.25)], k)).toBe(0.25);
  });

  it('linear interpolation, also at fractional frames', () => {
    const keys = [kf(0, 0), kf(10, 100), kf(20, 50)];
    expect(evaluateKeyframes(keys, 5)).toBe(50);
    expect(evaluateKeyframes(keys, 2.5)).toBe(25);
    expect(evaluateKeyframes(keys, 15)).toBe(75);
    expect(evaluateKeyframes(keys, 10)).toBe(100);
  });

  it('ease is smoothstep: symmetric, flat at both ends, the earlier keyframe chooses it', () => {
    expect(easeCurve(0)).toBe(0);
    expect(easeCurve(1)).toBe(1);
    expect(easeCurve(0.5)).toBe(0.5);
    expect(easeCurve(0.25)).toBeCloseTo(0.15625, 12);
    expect(easeCurve(0.25) + easeCurve(0.75)).toBeCloseTo(1, 12);
    const keys = [kf(0, 0, 'ease'), kf(10, 1), kf(20, 0)];
    expect(evaluateKeyframes(keys, 2.5)).toBeCloseTo(0.15625, 12);
    expect(evaluateKeyframes(keys, 15)).toBe(0.5); // second segment is linear
    expect(evaluateKeyframes(keys, 12.5)).toBe(0.75);
    // slope near the ends is below the linear slope
    expect(evaluateKeyframes(keys, 1)).toBeLessThan(0.1);
  });

  it('evaluates clip properties in clip-relative frames; static values without keyframes', () => {
    const s = seqWith();
    const c = put(s.videoTracks[0], 100, 50);
    expect(evaluateClipProperty('opacity', c, 120)).toBe(1);
    expect(transformAt(c, 120)).toBe(c.transform); // nothing animated: the clip's own object
    c.transform.keyframes = { opacity: [kf(0, 0), kf(10, 1)], x: [kf(0, -100), kf(20, 100)] };
    expect(evaluateClipProperty('opacity', c, 100)).toBe(0);
    expect(evaluateClipProperty('opacity', c, 105)).toBe(0.5);
    const t = transformAt(c, 110);
    expect(t).toMatchObject({ x: 0, y: 0, scale: 1, opacity: 1 });
    expect(t.crop).toBe(c.transform.crop);
    c.audio.keyframes = { volume: [kf(0, 1), kf(48, 0)] };
    expect(evaluateClipProperty('volume', c, 124)).toBe(0.5);
    expect(hasKeyframes(c)).toBe(true);
  });

  it('keyframes count timeline frames, independent of clip speed', () => {
    const s = seqWith();
    const slow = put(s.videoTracks[0], 0, 96, { speed: 0.5 });
    const fast = put(s.videoTracks[0], 200, 24, { speed: 4 });
    for (const c of [slow, fast]) c.transform.keyframes = { scale: [kf(0, 1), kf(24, 2)] };
    expect(evaluateClipProperty('scale', slow, 12)).toBe(1.5);
    expect(evaluateClipProperty('scale', fast, 212)).toBe(1.5);
  });

  it('keyframeRange covers the keyframes inside the window and both ends', () => {
    const c = put(seqWith().videoTracks[0], 0, 100);
    c.transform.keyframes = { scale: [kf(-10, 3), kf(10, 0.5), kf(50, 2), kf(200, 1)] };
    expect(keyframeRange(c, 'scale', 0, 99)).toEqual({ min: 0.5, max: 2 });
    expect(keyframeRange(c, 'scale', 0, 5)).toEqual({ min: evaluateKeyframes(c.transform.keyframes.scale!, 5), max: 1.75 });
    expect(keyframeRange(c, 'opacity', 0, 99)).toEqual({ min: 1, max: 1 });
  });
});

describe('clip-relative time through edits', () => {
  let s: Sequence;
  let c: Clip;
  beforeEach(() => {
    s = seqWith();
    c = put(s.videoTracks[0], 100, 100);
    c.transform.keyframes = { x: [kf(10, 0), kf(50, 400)] };
    c.audio.keyframes = { volume: [kf(20, 1), kf(60, 0)] };
  });
  const xAt = (clip: Clip, frame: number) => evaluateClipProperty('x', clip, frame);

  it('moving the clip moves the animation with it', () => {
    expect(moveClips(s, [{ clipId: c.id, toTrackId: s.videoTracks[0].id, toStart: 300 }], 'overwrite')).toBe(true);
    const moved = s.videoTracks[0].clips[0];
    expect(moved.start).toBe(300);
    expect(xAt(moved, 330)).toBe(200);
  });

  it('head trim keeps each keyframe on the same timeline frame and source moment; tail trim leaves them', () => {
    const before = [110, 130, 150, 170].map((f) => xAt(c, f));
    trimStart(s, c.id, 130, INF);
    expect(c.start).toBe(130);
    expect(c.transform.keyframes!.x!.map((k) => k.frame)).toEqual([-20, 20]); // the first is now before the clip
    expect(c.audio.keyframes!.volume!.map((k) => k.frame)).toEqual([-10, 30]);
    expect([150, 170].map((f) => xAt(c, f))).toEqual(before.slice(2));
    trimStart(s, c.id, 100, INF); // trim back out: the hidden keyframe shows again
    expect(c.transform.keyframes!.x!.map((k) => k.frame)).toEqual([10, 50]);
    expect([110, 130, 150, 170].map((f) => xAt(c, f))).toEqual(before);
    trimEnd(s, c.id, 140, INF);
    expect(c.transform.keyframes!.x!.map((k) => k.frame)).toEqual([10, 50]); // past the end, still shaping the motion
    expect(xAt(c, 139)).toBe(290);
  });

  it('ripple trim, roll and slide shift the trimmed clip; slip keeps the keyframes in the clip', () => {
    rippleTrimStart(s, c.id, 110, INF);
    expect(c.transform.keyframes!.x![0].frame).toBe(0);
    const s2 = seqWith();
    const a = put(s2.videoTracks[0], 0, 100);
    const b = put(s2.videoTracks[0], 100, 100);
    b.transform.keyframes = { opacity: [kf(10, 0), kf(20, 1)] };
    rollEdit(s2, a.id, b.id, 105, INF);
    expect(b.transform.keyframes!.opacity!.map((k) => k.frame)).toEqual([5, 15]);
    const mid = put(s2.videoTracks[0], 200, 50);
    const after = put(s2.videoTracks[0], 250, 50);
    after.transform.keyframes = { opacity: [kf(10, 0)] };
    slideClip(s2, mid.id, 5, INF);
    const afterNow = s2.videoTracks[0].clips.find((x) => x.id === after.id)!;
    expect(afterNow.start).toBe(255);
    expect(afterNow.transform.keyframes!.opacity![0].frame).toBe(5);
    slipClip(s2, b.id, 10, INF);
    expect(b.transform.keyframes!.opacity!.map((k) => k.frame)).toEqual([5, 15]);
  });

  it('razor: both parts keep every keyframe, so the animation does not change across the cut', () => {
    const before = [100, 125, 140, 160, 199].map((f) => [xAt(c, f), evaluateClipProperty('volume', c, f)]);
    const tails = razorAt(s, 140);
    expect(tails).toHaveLength(1);
    const [head, tail] = s.videoTracks[0].clips;
    expect(head.transform.keyframes!.x!.map((k) => k.frame)).toEqual([10, 50]);
    expect(tail.transform.keyframes!.x!.map((k) => k.frame)).toEqual([-30, 10]);
    const after = [100, 125, 140, 160, 199].map((f) => { const cl = f < 140 ? head : tail; return [xAt(cl, f), evaluateClipProperty('volume', cl, f)]; });
    expect(after).toEqual(before);
    // the head's list was not shared with (or shifted by) the tail
    expect(head.transform.keyframes!.x).not.toBe(tail.transform.keyframes!.x);
  });

  it('splitClip and an overwrite that covers the head keep the tail on its source moments', () => {
    const tail = splitClip(s, s.videoTracks[0], c, 120)!;
    expect(tail.audio.keyframes!.volume!.map((k) => k.frame)).toEqual([0, 40]);
    expect(c.audio.keyframes!.volume!.map((k) => k.frame)).toEqual([20, 60]);
    const s2 = seqWith();
    const d = put(s2.videoTracks[0], 0, 100);
    d.transform.keyframes = { scale: [kf(30, 1), kf(60, 2)] };
    const orig = d.transform.keyframes.scale!;
    clearRange(s2.videoTracks[0], 0, 40, FPS);
    const kept = s2.videoTracks[0].clips[0];
    expect(kept.start).toBe(40);
    expect(kept.transform.keyframes!.scale!.map((k) => k.frame)).toEqual([-10, 20]);
    expect(orig.map((k) => k.frame)).toEqual([30, 60]); // the original object is not written
    expect(evaluateClipProperty('scale', kept, 70)).toBe(evaluateClipProperty('scale', d, 70));
  });

  it('a clip without keyframes is not given any', () => {
    const plain = put(s.videoTracks[0], 300, 50);
    trimStart(s, plain.id, 310, INF);
    shiftClipKeyframes(plain, 5);
    expect(plain.transform.keyframes).toBeUndefined();
    expect(plain.audio.keyframes).toBeUndefined();
  });
});

describe('edits', () => {
  it('putKeyframe inserts in order, replaces at the same frame and keeps the interpolation', () => {
    let keys = putKeyframe(undefined, 10, 1);
    keys = putKeyframe(keys, 0, 0, 'ease');
    keys = putKeyframe(keys, 5.4, 0.5);
    expect(keys).toEqual([kf(0, 0, 'ease'), kf(5, 0.5), kf(10, 1)]);
    keys = putKeyframe(keys, 0, 0.2);
    expect(keys[0]).toEqual(kf(0, 0.2, 'ease'));
    keys = putKeyframe(keys, 0, 0.2, 'linear');
    expect(keys[0]).toEqual(kf(0, 0.2));
    const full = Array.from({ length: MAX_KEYFRAMES_PER_PROPERTY }, (_, i) => kf(i, 0));
    expect(putKeyframe(full, -1, 1)).toHaveLength(MAX_KEYFRAMES_PER_PROPERTY);
  });

  it('writeClipProperty edits the keyframe at the playhead when animated, else the static value', () => {
    const c = put(seqWith().videoTracks[0], 100, 50);
    writeClipProperty(c, 'opacity', 120, 0.4);
    expect(c.transform.opacity).toBe(0.4);
    expect(keyframesOf(c, 'opacity')).toBeUndefined();
    addKeyframeAt(c, ['opacity'], 100);
    writeClipProperty(c, 'opacity', 140, 2); // clamped to 1, a new keyframe at clip frame 40
    expect(c.transform.keyframes!.opacity).toEqual([kf(0, 0.4), kf(40, 1)]);
    expect(c.transform.opacity).toBe(0.4); // static value untouched while animated
    writeClipProperty(c, 'opacity', 500, 0.9); // outside the clip: its last frame
    expect(keyframeAt(c.transform.keyframes!.opacity, 49)?.value).toBe(0.9);
    writeClipProperty(c, 'scale', 100, NaN);
    expect(c.transform.scale).toBe(1);
  });

  it('add / remove at the playhead; removing the last keyframe leaves the value static; clear', () => {
    const c = put(seqWith().videoTracks[0], 100, 50);
    c.transform.x = 30;
    addKeyframeAt(c, ['x', 'y'], 110);
    expect(c.transform.keyframes).toEqual({ x: [kf(10, 30)], y: [kf(10, 0)] });
    writeClipProperty(c, 'x', 130, 90); // y (animated) is keyed there too, at its current value
    expect(c.transform.keyframes!.y).toEqual([kf(10, 0), kf(30, 0)]);
    removeKeyframeAt(c, ['x', 'y'], 110);
    expect(c.transform.keyframes).toEqual({ x: [kf(30, 90)], y: [kf(30, 0)] });
    removeKeyframeAt(c, ['y'], 130);
    removeKeyframeAt(c, ['x'], 130);
    expect(c.transform.keyframes).toBeUndefined();
    expect(c.transform.x).toBe(90);
    c.audio.keyframes = { volume: [kf(0, 1), kf(10, 0)] };
    clearKeyframes(c, ['volume'], 105);
    expect(c.audio.keyframes).toBeUndefined();
    expect(c.audio.volume).toBe(0.5);
  });

  it('interpolation applies to the segment that starts at the keyframe; segmentKeyframe finds it', () => {
    const c = put(seqWith().videoTracks[0], 0, 100);
    c.transform.keyframes = { scale: [kf(0, 1), kf(10, 2), kf(20, 1)] };
    expect(segmentKeyframe(c.transform.keyframes.scale, 15)?.frame).toBe(10);
    expect(segmentKeyframe(c.transform.keyframes.scale, 25)).toBeUndefined();
    expect(segmentKeyframe(c.transform.keyframes.scale, 20)?.frame).toBe(20);
    setInterpAt(c, ['scale'], 15, 'ease');
    expect(c.transform.keyframes.scale![1]).toEqual(kf(10, 2, 'ease'));
    expect(evaluateClipProperty('scale', c, 15)).toBe(1.5);
    expect(evaluateClipProperty('scale', c, 12)).toBeCloseTo(2 - easeCurve(0.2), 12);
  });

  it('clipFrameAt keeps the edit inside the clip; clipKeyframeFrames merges properties', () => {
    const c = put(seqWith().videoTracks[0], 100, 50);
    expect([clipFrameAt(c, 90), clipFrameAt(c, 120.4), clipFrameAt(c, 400)]).toEqual([0, 20, 49]);
    c.transform.keyframes = { x: [kf(5, 0), kf(9, 1)], y: [kf(5, 0)], opacity: [kf(2, 1)] };
    c.audio.keyframes = { volume: [kf(30, 1)] };
    expect(clipKeyframeFrames(c)).toEqual([2, 5, 9, 30]);
    expect(clipKeyframeFrames(c, ['x', 'y'])).toEqual([5, 9]);
  });
});

describe('FFmpeg expression', () => {
  const lists: Keyframe[][] = [
    [kf(0, 5)],
    [kf(0, 0), kf(48, 1)],
    [kf(-12, 0.25, 'ease'), kf(12, 1), kf(36, 1), kf(40, 0, 'ease'), kf(100, -350.5)],
    Array.from({ length: 64 }, (_, i) => kf(i * 3, Math.sin(i) * 100, i % 2 ? 'ease' : undefined)),
  ];
  it('evaluates to the same values as the preview, at whole and fractional frames', () => {
    for (const keys of lists) {
      const f = exprFn(keys);
      for (let k = -20; k <= 200; k += 0.25) expect(f(k)).toBeCloseTo(evaluateKeyframes(keys, k), 4);
    }
  });

  it('writes plain decimals (negative ones in parentheses) and skips flat segments', () => {
    expect(exprNum(1e-7)).toBe('0');
    expect(exprNum(-0.5)).toBe('(-0.5)');
    expect(exprNum(123456.1234567)).toBe('123456.123457');
    expect(keyframesExpr([kf(0, 2), kf(10, 2)], 'K')).toBe('2');
    expect(keyframesExpr([kf(0, 0), kf(10, 1, 'ease'), kf(20, 1)], 'n')).toBe('0+1*clip((n-0)/10,0,1)');
    expect(keyframesExpr([kf(0, 0, 'ease'), kf(10, 1)], 'n')).toBe('0+1*clip((n-0)/10,0,1)*clip((n-0)/10,0,1)*(3-2*clip((n-0)/10,0,1))');
  });

  it('nests parentheses logarithmically, not per keyframe', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => kf(i, i % 2));
    const src = keyframesExpr(keys, 'K');
    let depth = 0, max = 0;
    for (const ch of src) { if (ch === '(') max = Math.max(max, ++depth); else if (ch === ')') depth--; }
    expect(max).toBeLessThan(20);
    expect(exprFn(keys)(500.5)).toBeCloseTo(0.5, 6);
  });
});

describe('load-time repair', () => {
  it('keeps valid lists, sorts, dedupes, clamps and drops junk', () => {
    expect(normalizeKeyframeList('opacity', [kf(0, 0), kf(10, 1, 'ease')])).toEqual({ value: [kf(0, 0), kf(10, 1, 'ease')], repaired: false });
    const r = normalizeKeyframeList('opacity', [kf(10, 3), { frame: 2.4, value: 0.5, interp: 'bounce' }, null, { frame: 'x', value: 1 }, kf(10, 0.2), { frame: 5, value: Infinity }]);
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual([kf(2, 0.5), kf(10, 0.2)]);
    expect(normalizeKeyframeList('scale', [kf(0, -1)]).value).toEqual([kf(0, 0.01)]);
    expect(normalizeKeyframeList('x', 'nope')).toEqual({ value: [], repaired: true });
  });

  it('a project with keyframes opens unchanged; damaged keyframes are repaired and reported', () => {
    const p = createProject('P');
    const seq = createSequence('S', FPS);
    p.sequences[seq.id] = seq; p.sequenceOrder.push(seq.id);
    const c = put(seq.videoTracks[0], 0, 48);
    c.transform.keyframes = { x: [kf(0, 0), kf(24, 100, 'ease')], opacity: [kf(-5, 0.5)] };
    c.audio.keyframes = { volume: [kf(0, 1), kf(47, 0)] };
    const json = JSON.parse(JSON.stringify(p));
    const clean = normalizeProjectWithReport(JSON.parse(JSON.stringify(json)));
    expect(clean.repairs).toEqual([]);
    const cc = clean.project.sequences[seq.id].videoTracks[0].clips[0];
    expect(cc.transform.keyframes).toEqual(c.transform.keyframes);
    expect(cc.audio.keyframes).toEqual(c.audio.keyframes);

    const bad = JSON.parse(JSON.stringify(json));
    const bc = bad.sequences[seq.id].videoTracks[0].clips[0];
    bc.transform.keyframes = { x: [kf(0, 0)], wobble: [kf(0, 1)], opacity: [] };
    bc.audio.keyframes = 'loud';
    const fixed = normalizeProjectWithReport(bad);
    expect(fixed.repairs.join(' ')).toMatch(/keyframes/);
    const fc = fixed.project.sequences[seq.id].videoTracks[0].clips[0];
    expect(fc.transform.keyframes).toEqual({ x: [kf(0, 0)] });
    expect(fc.audio.keyframes).toBeUndefined();
  });

  it('an overlap repaired at load shifts the shortened clip\'s keyframes with its head', () => {
    const p = createProject('P');
    const seq = createSequence('S', FPS);
    p.sequences[seq.id] = seq; p.sequenceOrder.push(seq.id);
    put(seq.videoTracks[0], 0, 50);
    const b = put(seq.videoTracks[0], 40, 50);
    b.transform.keyframes = { opacity: [kf(20, 0)] };
    const out = normalizeProject(JSON.parse(JSON.stringify(p)));
    const fixedB = out.sequences[seq.id].videoTracks[0].clips[1];
    expect(fixedB.start).toBe(50);
    expect(fixedB.transform.keyframes!.opacity![0].frame).toBe(10);
  });
});

describe('store actions', () => {
  beforeEach(() => { resetStore(); });
  it('add, edit, interpolate, remove and clear are one undo step each and skip the other kind / locked tracks', () => {
    const S = () => useStore.getState();
    S().newProject('K');
    const seqId = S().project.activeSequenceId!;
    S().quiet((d) => {
      const seq = d.sequences[seqId];
      put(seq.videoTracks[0], 0, 100, { linkId: 'L' });
      put(seq.audioTracks[0], 0, 100, { linkId: 'L' });
    });
    const seq = () => S().project.sequences[seqId];
    const v = () => seq().videoTracks[0].clips[0];
    const a = () => seq().audioTracks[0].clips[0];
    const ids = [v().id, a().id];
    const depth = () => S().history.past.length;
    const d0 = depth();
    S().addClipKeyframe(seqId, ids, 'opacity', 10);
    expect(v().transform.keyframes).toEqual({ opacity: [kf(10, 1)] });
    expect(a().transform.keyframes).toBeUndefined();
    S().addClipKeyframe(seqId, ids, 'volume', 50);
    expect(a().audio.keyframes).toEqual({ volume: [kf(50, 1)] });
    expect(v().audio.keyframes).toBeUndefined();
    S().addClipKeyframe(seqId, ids, 'position', 20);
    expect(v().transform.keyframes!.x).toEqual([kf(20, 0)]);
    expect(v().transform.keyframes!.y).toEqual([kf(20, 0)]);
    S().setClipKeyframeInterp(seqId, ids, 'position', 20, 'ease');
    expect(v().transform.keyframes!.x![0].interp).toBe('ease');
    expect(depth()).toBe(d0 + 4);
    S().undo();
    expect(v().transform.keyframes!.x![0].interp).toBeUndefined();
    S().removeClipKeyframe(seqId, ids, 'position', 20);
    expect(v().transform.keyframes!.x).toBeUndefined();
    S().clearClipKeyframes(seqId, ids, 'volume', 0);
    expect(a().audio.keyframes).toBeUndefined();
    S().setTrackFlags(seqId, seq().videoTracks[0].id, { locked: true });
    S().addClipKeyframe(seqId, ids, 'scale', 0);
    expect(v().transform.keyframes!.scale).toBeUndefined();
    expect(clipEnd(v())).toBe(100);
  });
});
