import { describe, it, expect } from 'vitest';
import { createSequence } from '../../shared/project';
import type { Clip, Sequence, Track, SequenceSubtitleCue } from '../../shared/model';
import {
  MIN_CLIP_FRAMES, makeClip, overwriteClip, insertClip, placeClips, splitClip, razorAt, removeClips, rippleDeleteClips,
  liftRange, extractRange, trimLimits, trimStart, trimEnd, rippleTrimStart, rippleTrimEnd, rollEdit, slipClip, slideClip,
  moveClips, addTransition, removeTransition, reconcileTransitions, transitionsForClip, addTrack, removeTrack, renameTracks,
  editPoints, nextEdit, prevEdit, addMarker, resolveSubtitleCues, rippleShift, sequenceDuration, maxDurationFrom, mediaFrames,
  clipEnd, clipSourceOut, sourceTimeAt, clipAt, clipsInRange, findClip, linkedClips, sortTrack, clearRange, followClipMarkers,
} from '../../shared/timeline';

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------
const FPS = { num: 24, den: 1 };
const NTSC = { num: 24000, den: 1001 };
const S = (f = FPS) => createSequence('S', f);
const V = (s: Sequence, i = 0) => s.videoTracks[i];
const A = (s: Sequence, i = 0) => s.audioTracks[i];

interface PutOpts { name?: string; sourceIn?: number; speed?: number; linkId?: string | null; mediaId?: string; id?: string }
/** Place a clip directly on a track (fixture building, no edit semantics). */
function put(track: Track, start: number, duration: number, o: PutOpts = {}): Clip {
  const c = makeClip({ mediaId: o.mediaId ?? 'm', name: o.name ?? `${track.name}@${start}`, sourceIn: o.sourceIn ?? 0, duration, speed: o.speed, kind: track.kind, linkId: o.linkId ?? null }, start);
  if (o.id) c.id = o.id;
  track.clips.push(c);
  sortTrack(track);
  return c;
}
/** Frame-exact layout of a track: [start, end] pairs in order. */
const lay = (t: Track) => t.clips.map((c) => [c.start, clipEnd(c)]);
const ids = (t: Track) => t.clips.map((c) => c.id);
const media = (d: Record<string, number> = {}) => (id: string) => d[id] ?? Infinity;
const INF = media();
const sec = (frames: number, fps = FPS) => (frames * fps.den) / fps.num;

function cue(partial: Partial<SequenceSubtitleCue> & { id: string }): SequenceSubtitleCue {
  return { start: 0, duration: 24, offset: 0, text: partial.id, ...partial };
}

// ------------------------------------------------------------------
describe('basics', () => {
  it('makeClip rounds duration, enforces the minimum and fills defaults', () => {
    const c = makeClip({ mediaId: 'm', name: 'n', sourceIn: 1.5, duration: 23.6, kind: 'video' }, 10);
    expect(c).toMatchObject({ start: 10, duration: 24, sourceIn: 1.5, speed: 1, linkId: null, enabled: true, kind: 'video', tags: [], notes: '' });
    expect(c.transform.scale).toBe(1);
    expect(c.audio.fadeIn).toBe(0);
    expect(makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 0, kind: 'audio' }, 0).duration).toBe(MIN_CLIP_FRAMES);
    expect(makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 5, kind: 'audio', speed: 2, linkId: 'L' }, 0)).toMatchObject({ speed: 2, linkId: 'L' });
  });

  it('clipEnd / clipSourceOut / sourceTimeAt / clipAt / clipsInRange', () => {
    const s = S();
    const c = put(V(s), 48, 48, { sourceIn: 2, speed: 2 });
    expect(clipEnd(c)).toBe(96);
    expect(clipSourceOut(c, s.fps)).toBe(6);     // 2 + 2s * 2x
    expect(sourceTimeAt(c, 72, s.fps)).toBe(4);  // 1s in at 2x
    expect(clipAt(V(s), 48)).toBe(c);
    expect(clipAt(V(s), 96)).toBeUndefined();
    expect(clipsInRange(V(s), 0, 48)).toEqual([]);
    expect(clipsInRange(V(s), 0, 49)).toEqual([c]);
    expect(clipsInRange(V(s), 0, 49, new Set([c.id]))).toEqual([]);
  });

  it('sequenceDuration spans all tracks', () => {
    const s = S();
    expect(sequenceDuration(s)).toBe(0);
    put(V(s), 0, 100); put(A(s, 2), 50, 100);
    expect(sequenceDuration(s)).toBe(150);
  });

  it('maxDurationFrom / mediaFrames with finite and Infinity media', () => {
    expect(maxDurationFrom(0, 1, Infinity, FPS)).toBe(Number.MAX_SAFE_INTEGER);
    expect(maxDurationFrom(2, 1, 10, FPS)).toBe(192);
    expect(maxDurationFrom(2, 2, 10, FPS)).toBe(96);
    expect(maxDurationFrom(12, 1, 10, FPS)).toBe(0);
    expect(maxDurationFrom(0, 1, 10, NTSC)).toBe(239); // 239.76 -> never promise a partial frame
    expect(maxDurationFrom(sec(240, NTSC), 1, sec(480, NTSC), NTSC)).toBe(240);
    expect(mediaFrames(10, FPS)).toBe(240);
    expect(mediaFrames(Infinity, FPS)).toBe(Number.MAX_SAFE_INTEGER);
    expect(mediaFrames(0, FPS)).toBe(1);
  });

  it('findClip / linkedClips', () => {
    const s = S();
    const v = put(V(s), 0, 10, { linkId: 'L' }); const a = put(A(s), 0, 10, { linkId: 'L' }); const x = put(A(s, 1), 0, 10);
    expect(findClip(s, a.id)).toMatchObject({ index: 0, clip: a });
    expect(findClip(s, 'nope')).toBeUndefined();
    expect(linkedClips(s, v)).toEqual([v, a]);
    expect(linkedClips(s, x)).toEqual([x]);
  });
});

// ------------------------------------------------------------------
describe('overwriteClip', () => {
  it('places on an empty track', () => {
    const s = S();
    const c = makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 48, kind: 'video' }, 0);
    expect(overwriteClip(s, V(s).id, c)).toBe(true);
    expect(lay(V(s))).toEqual([[0, 48]]);
  });

  it('over the middle of a clip splits it into head/tail; tail gets a new id, correct sourceIn and the out-transition', () => {
    const s = S();
    const a = put(V(s), 0, 100, { sourceIn: 1 }); const b = put(V(s), 100, 50);
    a.audio.fadeIn = 6; a.audio.fadeOut = 6;
    const tr = addTransition(s, V(s).id, 100, 'crossDissolve', 12)!;
    const n = makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 20, kind: 'video' }, 40);
    overwriteClip(s, V(s).id, n);
    expect(lay(V(s))).toEqual([[0, 40], [40, 60], [60, 100], [100, 150]]);
    const [head, mid, tail] = V(s).clips;
    expect(head.id).toBe(a.id);
    expect(mid).toBe(n);
    expect(tail.id).not.toBe(a.id);
    expect(tail.sourceIn).toBeCloseTo(1 + 60 / 24, 12);
    expect(head.sourceIn).toBe(1);
    expect(tail.audio.fadeIn).toBe(0);
    expect(tail.audio.fadeOut).toBe(6);
    expect(head.audio.fadeIn).toBe(6);
    expect(V(s).transitions).toHaveLength(1);
    expect(V(s).transitions[0]).toMatchObject({ id: tr.id, outClipId: tail.id, inClipId: b.id });
  });

  it('over the head trims the clip start (same id, sourceIn advances)', () => {
    const s = S();
    const a = put(V(s), 0, 100, { sourceIn: 0.5 });
    overwriteClip(s, V(s).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 30, kind: 'video' }, 0));
    expect(lay(V(s))).toEqual([[0, 30], [30, 100]]);
    expect(V(s).clips[1].id).toBe(a.id);
    expect(V(s).clips[1].sourceIn).toBeCloseTo(0.5 + 30 / 24, 12);
  });

  it('over the tail trims the clip end (same id, sourceIn unchanged)', () => {
    const s = S();
    const a = put(V(s), 0, 100, { sourceIn: 0.5 });
    overwriteClip(s, V(s).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 40, kind: 'video' }, 80));
    expect(lay(V(s))).toEqual([[0, 80], [80, 120]]);
    expect(V(s).clips[0].id).toBe(a.id);
    expect(V(s).clips[0].sourceIn).toBe(0.5);
  });

  it('covering a clip entirely removes it (and its transitions); exact coverage too', () => {
    const s = S();
    put(V(s), 10, 20); put(V(s), 30, 10); put(V(s), 100, 10);
    addTransition(s, V(s).id, 30, 'crossDissolve', 4);
    const n = makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 50, kind: 'video' }, 0);
    overwriteClip(s, V(s).id, n);
    expect(lay(V(s))).toEqual([[0, 50], [100, 110]]);
    expect(V(s).transitions).toEqual([]);
    const s2 = S(); put(V(s2), 10, 20);
    overwriteClip(s2, V(s2).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 20, kind: 'video' }, 10));
    expect(V(s2).clips).toHaveLength(1);
  });

  it('refuses locked / unknown tracks and leaves other tracks alone', () => {
    const s = S();
    put(A(s), 0, 100);
    V(s).locked = true;
    expect(overwriteClip(s, V(s).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 10, kind: 'video' }, 0))).toBe(false);
    expect(overwriteClip(s, 'nope', makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 10, kind: 'video' }, 0))).toBe(false);
    expect(V(s).clips).toEqual([]);
    expect(lay(A(s))).toEqual([[0, 100]]);
  });
});

// ------------------------------------------------------------------
describe('insertClip', () => {
  function fixture() {
    const s = S();
    const v = put(V(s), 0, 100, { linkId: 'L', name: 'v' });
    const a = put(A(s), 0, 100, { linkId: 'L', name: 'a' });
    const x = put(A(s, 1), 50, 30, { name: 'x' });
    s.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [
      cue({ id: 'early', clipId: v.id, srcStart: 0.5, srcEnd: 1 }),
      cue({ id: 'late', clipId: v.id, srcStart: 3, srcEnd: 3.5 }),
    ] });
    return { s, v, a, x };
  }

  it('in the middle of V1 splits the spanning clips on ALL unlocked tracks and ripples the rest', () => {
    const { s, v, a, x } = fixture();
    const n = makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 24, kind: 'video' }, 40);
    expect(insertClip(s, V(s).id, n)).toBe(true);
    expect(lay(V(s))).toEqual([[0, 40], [40, 64], [64, 124]]);
    expect(lay(A(s))).toEqual([[0, 40], [64, 124]]);
    expect(lay(A(s, 1))).toEqual([[74, 104]]);
    expect(A(s, 1).clips[0]).toBe(x);
    const vTail = V(s).clips[2]; const aTail = A(s).clips[1];
    expect(vTail.sourceIn).toBeCloseTo(40 / 24, 12);
    expect(aTail.sourceIn).toBeCloseTo(40 / 24, 12);
    // head pair keeps the old link, tail pair gets a fresh shared link
    expect(v.linkId).toBe('L'); expect(a.linkId).toBe('L');
    expect(vTail.linkId).toBeTruthy(); expect(vTail.linkId).not.toBe('L'); expect(aTail.linkId).toBe(vTail.linkId);
    // attached cue after the split point follows the tail
    const cues = s.subtitleTracks[0].cues;
    expect(cues.find((c) => c.id === 'early')!.clipId).toBe(v.id);
    expect(cues.find((c) => c.id === 'late')!.clipId).toBe(vTail.id);
  });

  it('at an existing clip boundary does NOT split, just ripples', () => {
    const s = S();
    put(V(s), 0, 100); put(V(s), 100, 100); put(A(s), 0, 100); put(A(s), 100, 100);
    const n = makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 24, kind: 'video' }, 100);
    insertClip(s, V(s).id, n);
    expect(lay(V(s))).toEqual([[0, 100], [100, 124], [124, 224]]);
    expect(lay(A(s))).toEqual([[0, 100], [124, 224]]);
    expect(V(s).clips).toHaveLength(3);
    expect(A(s).clips).toHaveLength(2);
  });

  it('leaves a locked track untouched (no split, no shift)', () => {
    const { s } = fixture();
    const a2 = A(s, 2); a2.locked = true; const l = put(a2, 0, 100, { name: 'locked' });
    A(s, 1).locked = true;
    insertClip(s, V(s).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 24, kind: 'video' }, 40));
    expect(lay(V(s))).toEqual([[0, 40], [40, 64], [64, 124]]);
    expect(lay(a2)).toEqual([[0, 100]]);
    expect(a2.clips[0]).toBe(l);
    expect(lay(A(s, 1))).toEqual([[50, 80]]);
  });

  it('rippleTracks: own only touches the target track; refuses a locked target', () => {
    const { s } = fixture();
    insertClip(s, V(s).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 24, kind: 'video' }, 40), { rippleTracks: 'own' });
    expect(lay(V(s))).toEqual([[0, 40], [40, 64], [64, 124]]);
    expect(lay(A(s))).toEqual([[0, 100]]);
    expect(lay(A(s, 1))).toEqual([[50, 80]]);
    V(s).locked = true;
    expect(insertClip(s, V(s).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 24, kind: 'video' }, 0))).toBe(false);
  });

  it('inserting at the sequence start pushes everything', () => {
    const { s } = fixture();
    insertClip(s, V(s).id, makeClip({ mediaId: 'm', name: 'n', sourceIn: 0, duration: 10, kind: 'video' }, 0));
    expect(lay(V(s))).toEqual([[0, 10], [10, 110]]);
    expect(lay(A(s))).toEqual([[10, 110]]);
    expect(lay(A(s, 1))).toEqual([[60, 90]]);
  });
});

// ------------------------------------------------------------------
describe('placeClips', () => {
  it('insert mode places a linked v+a pair atomically, splitting and rippling once', () => {
    const s = S();
    put(V(s), 0, 100); put(A(s), 0, 100); put(A(s, 1), 100, 50);
    const v = makeClip({ mediaId: 'm', name: 'v', sourceIn: 0, duration: 24, kind: 'video', linkId: 'N' }, 50);
    const a = makeClip({ mediaId: 'm', name: 'a', sourceIn: 0, duration: 24, kind: 'audio', linkId: 'N' }, 50);
    expect(placeClips(s, [{ trackId: V(s).id, clip: v }, { trackId: A(s).id, clip: a }], 'insert')).toBe(true);
    expect(lay(V(s))).toEqual([[0, 50], [50, 74], [74, 124]]);
    expect(lay(A(s))).toEqual([[0, 50], [50, 74], [74, 124]]);
    expect(lay(A(s, 1))).toEqual([[124, 174]]);
    expect(V(s).clips[1]).toBe(v); expect(A(s).clips[1]).toBe(a);
    expect(V(s).clips[2].sourceIn).toBeCloseTo(50 / 24, 12);
  });

  it('insert mode with staggered placements ripples by the union length', () => {
    const s = S();
    put(V(s), 100, 10); put(A(s), 100, 10);
    const v = makeClip({ mediaId: 'm', name: 'v', sourceIn: 0, duration: 24, kind: 'video' }, 50);
    const a = makeClip({ mediaId: 'm', name: 'a', sourceIn: 0, duration: 30, kind: 'audio' }, 60);
    placeClips(s, [{ trackId: V(s).id, clip: v }, { trackId: A(s).id, clip: a }], 'insert');
    expect(lay(V(s))).toEqual([[50, 74], [140, 150]]);
    expect(lay(A(s))).toEqual([[60, 90], [140, 150]]);
  });

  it('overwrite mode overwrites each target; refuses any locked target or empty list', () => {
    const s = S();
    put(V(s), 0, 100); put(A(s), 0, 100);
    const v = makeClip({ mediaId: 'm', name: 'v', sourceIn: 0, duration: 24, kind: 'video' }, 50);
    const a = makeClip({ mediaId: 'm', name: 'a', sourceIn: 0, duration: 24, kind: 'audio' }, 50);
    expect(placeClips(s, [{ trackId: V(s).id, clip: v }, { trackId: A(s).id, clip: a }], 'overwrite')).toBe(true);
    expect(lay(V(s))).toEqual([[0, 50], [50, 74], [74, 100]]);
    expect(lay(A(s))).toEqual([[0, 50], [50, 74], [74, 100]]);
    expect(placeClips(s, [], 'overwrite')).toBe(false);
    A(s).locked = true;
    const before = JSON.stringify([lay(V(s)), lay(A(s))]);
    expect(placeClips(s, [{ trackId: V(s).id, clip: makeClip({ mediaId: 'm', name: 'v2', sourceIn: 0, duration: 24, kind: 'video' }, 0) }, { trackId: A(s).id, clip: makeClip({ mediaId: 'm', name: 'a2', sourceIn: 0, duration: 24, kind: 'audio' }, 0) }], 'insert')).toBe(false);
    expect(JSON.stringify([lay(V(s)), lay(A(s))])).toBe(before);
  });
});

// ------------------------------------------------------------------
describe('splitClip / razorAt', () => {
  it('splitClip computes the tail sourceIn with speed, clears the right fades, moves the out-transition and reassigns cues', () => {
    const s = S();
    const a = put(V(s), 0, 100, { sourceIn: 10, speed: 2 }); const b = put(V(s), 100, 50);
    a.audio.fadeIn = 12; a.audio.fadeOut = 12;
    const tr = addTransition(s, V(s).id, 100, 'crossDissolve', 10)!;
    s.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [
      cue({ id: 'c1', clipId: a.id, srcStart: 11, srcEnd: 12 }),
      cue({ id: 'c2', clipId: a.id, srcStart: 12.5, srcEnd: 13 }),
      cue({ id: 'c3', clipId: a.id, srcStart: 14, srcEnd: 15 }),
      cue({ id: 'free', start: 10 }),
    ] });
    const tail = splitClip(s, V(s), a, 30)!;
    expect(lay(V(s))).toEqual([[0, 30], [30, 100], [100, 150]]);
    expect(tail.sourceIn).toBe(10 + (30 / 24) * 2); // 12.5
    expect(a.sourceIn).toBe(10);
    expect(tail.id).not.toBe(a.id);
    expect(tail.linkId).toBeNull();
    expect(a.audio).toMatchObject({ fadeIn: 12, fadeOut: 0 });
    expect(tail.audio).toMatchObject({ fadeIn: 0, fadeOut: 12 });
    expect(tail.transform).not.toBe(a.transform); expect(tail.tags).not.toBe(a.tags);
    expect(V(s).transitions[0]).toMatchObject({ id: tr.id, outClipId: tail.id, inClipId: b.id });
    const byId = Object.fromEntries(s.subtitleTracks[0].cues.map((c) => [c.id, c.clipId]));
    expect(byId).toEqual({ c1: a.id, c2: tail.id, c3: tail.id, free: undefined });
  });

  it('splitClip returns null on or outside the clip edges', () => {
    const s = S(); const a = put(V(s), 10, 20);
    expect(splitClip(s, V(s), a, 10)).toBeNull();
    expect(splitClip(s, V(s), a, 30)).toBeNull();
    expect(splitClip(s, V(s), a, 5)).toBeNull();
    expect(lay(V(s))).toEqual([[10, 30]]);
  });

  it('razorAt splits a linked pair together and gives the tails a NEW shared linkId', () => {
    const s = S();
    const v = put(V(s), 0, 100, { linkId: 'L' }); const a = put(A(s), 0, 100, { linkId: 'L' }); put(A(s, 1), 0, 100);
    const created = razorAt(s, 40);
    expect(created).toHaveLength(3);
    expect(lay(V(s))).toEqual([[0, 40], [40, 100]]);
    expect(lay(A(s))).toEqual([[0, 40], [40, 100]]);
    expect(lay(A(s, 1))).toEqual([[0, 40], [40, 100]]);
    const vt = V(s).clips[1]; const at = A(s).clips[1];
    expect(v.linkId).toBe('L'); expect(a.linkId).toBe('L');
    expect(vt.linkId).toBeTruthy(); expect(vt.linkId).not.toBe('L'); expect(at.linkId).toBe(vt.linkId);
    expect(A(s, 1).clips[1].linkId).toBeNull();
    expect(linkedClips(s, vt)).toEqual([vt, at]);
  });

  it('razorAt honours trackIds (linked partner still follows), linked:false, boundaries and locked tracks', () => {
    const s = S();
    put(V(s), 0, 100, { linkId: 'L' }); put(A(s), 0, 100, { linkId: 'L' }); put(A(s, 1), 0, 100);
    expect(razorAt(s, 40, [V(s).id])).toHaveLength(2);
    expect(lay(A(s))).toEqual([[0, 40], [40, 100]]);
    expect(lay(A(s, 1))).toEqual([[0, 100]]);
    expect(razorAt(s, 40)).toHaveLength(1); // only A2 remains unsplit at 40
    expect(razorAt(s, 40)).toHaveLength(0); // boundary: nothing to split

    const s2 = S();
    put(V(s2), 0, 100, { linkId: 'L' }); put(A(s2), 0, 100, { linkId: 'L' });
    expect(razorAt(s2, 20, [V(s2).id], { linked: false })).toHaveLength(1);
    expect(lay(V(s2))).toEqual([[0, 20], [20, 100]]);
    expect(lay(A(s2))).toEqual([[0, 100]]);
    expect(V(s2).clips[1].linkId).toBe('L'); // unlinked razor keeps the existing link on both halves
    expect(razorAt(s2, 60, undefined, { linked: false })).toHaveLength(2); // no trackIds -> every track

    const s3 = S();
    put(V(s3), 0, 100); V(s3).locked = true;
    expect(razorAt(s3, 50)).toHaveLength(0);
    expect(lay(V(s3))).toEqual([[0, 100]]);
  });
});

// ------------------------------------------------------------------
describe('removeClips / rippleDeleteClips', () => {
  it('removeClips removes clips, their transitions and attached cues; locked tracks keep both', () => {
    const s = S();
    const a = put(V(s), 0, 100); const b = put(V(s), 100, 100); const l = put(A(s), 0, 100);
    A(s).locked = true;
    addTransition(s, V(s).id, 100, 'crossDissolve', 10);
    s.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [
      cue({ id: 'ca', clipId: a.id, srcStart: 0, srcEnd: 1 }), cue({ id: 'cb', clipId: b.id, srcStart: 0, srcEnd: 1 }),
      cue({ id: 'cl', clipId: l.id, srcStart: 0, srcEnd: 1 }), cue({ id: 'free' }),
    ] });
    removeClips(s, [a.id, l.id]);
    expect(ids(V(s))).toEqual([b.id]);
    expect(V(s).transitions).toEqual([]);
    expect(ids(A(s))).toEqual([l.id]);
    expect(s.subtitleTracks[0].cues.map((c) => c.id)).toEqual(['cb', 'cl', 'free']);
  });

  it('ripple delete of a single clip closes the gap on its track and shifts later clips on other tracks', () => {
    const s = S();
    put(V(s), 0, 100); const b = put(V(s), 100, 100); put(V(s), 200, 100);
    put(A(s), 0, 100); put(A(s), 200, 100);
    put(A(s, 1), 200, 50);
    s.storyBlocks.push({ id: 'sb', name: 'act 2', start: 200, end: 300, color: '', notes: '' });
    rippleDeleteClips(s, [b.id]);
    expect(lay(V(s))).toEqual([[0, 100], [100, 200]]);
    expect(lay(A(s))).toEqual([[0, 100], [100, 200]]);
    expect(lay(A(s, 1))).toEqual([[100, 150]]);
    expect(s.storyBlocks[0]).toMatchObject({ start: 100, end: 200 });
  });

  it('a track with a clip spanning the gap is NOT shifted; others are', () => {
    const s = S();
    put(V(s), 0, 100); const b = put(V(s), 100, 100); put(V(s), 200, 100);
    put(A(s), 50, 200); put(A(s), 300, 100);          // spans the gap -> blocked
    put(A(s, 1), 0, 100); put(A(s, 1), 200, 100);     // free -> shifted
    put(A(s, 2), 100, 100); put(A(s, 2), 200, 100);   // occupies exactly the gap -> blocked
    rippleDeleteClips(s, [b.id]);
    expect(lay(V(s))).toEqual([[0, 100], [100, 200]]);
    expect(lay(A(s))).toEqual([[50, 250], [300, 400]]);
    expect(lay(A(s, 1))).toEqual([[0, 100], [100, 200]]);
    expect(lay(A(s, 2))).toEqual([[100, 200], [200, 300]]);
  });

  it('two non-adjacent clips on one track: both gaps close, later clips move by the sum', () => {
    const s = S();
    const a = put(V(s), 0, 100, { name: 'A' }); put(V(s), 100, 100, { name: 'B' }); const c = put(V(s), 200, 100, { name: 'C' }); put(V(s), 300, 100, { name: 'D' });
    put(A(s), 350, 10);
    rippleDeleteClips(s, [a.id, c.id]);
    expect(V(s).clips.map((x) => x.name)).toEqual(['B', 'D']);
    expect(lay(V(s))).toEqual([[0, 100], [100, 200]]);
    expect(lay(A(s))).toEqual([[150, 160]]);
  });

  it('two adjacent clips (and clips on different tracks) merge into one gap; locked clips are ignored', () => {
    const s = S();
    const a = put(V(s), 0, 100); const b = put(V(s), 100, 100); put(V(s), 200, 100);
    const x = put(A(s), 50, 100); put(A(s), 300, 10);
    rippleDeleteClips(s, [a.id, b.id, x.id]);
    expect(lay(V(s))).toEqual([[0, 100]]);
    expect(lay(A(s))).toEqual([[100, 110]]);

    const s2 = S();
    const l = put(V(s2), 0, 100); put(V(s2), 100, 100); V(s2).locked = true;
    put(A(s2), 100, 10);
    rippleDeleteClips(s2, [l.id]);
    expect(lay(V(s2))).toEqual([[0, 100], [100, 200]]);
    expect(lay(A(s2))).toEqual([[100, 110]]);
  });
});

// ------------------------------------------------------------------
describe('liftRange / extractRange / clearRange', () => {
  function fixture() {
    const s = S();
    const a = put(V(s), 0, 100, { sourceIn: 1 }); const b = put(V(s), 100, 100, { sourceIn: 5 });
    const x = put(A(s), 0, 200, { sourceIn: 0 });
    put(A(s, 1), 150, 100);
    return { s, a, b, x };
  }

  it('liftRange clears the range on all tracks without shifting', () => {
    const { s, a, b, x } = fixture();
    liftRange(s, 50, 150);
    expect(lay(V(s))).toEqual([[0, 50], [150, 200]]);
    expect(ids(V(s))).toEqual([a.id, b.id]);            // head keeps id; trimmed-at-head clip keeps id
    expect(V(s).clips[1].sourceIn).toBeCloseTo(5 + 50 / 24, 12);
    expect(lay(A(s))).toEqual([[0, 50], [150, 200]]);
    expect(A(s).clips[0].id).toBe(x.id); expect(A(s).clips[1].id).not.toBe(x.id);
    expect(A(s).clips[1].sourceIn).toBeCloseTo(150 / 24, 12);
    expect(lay(A(s, 1))).toEqual([[150, 250]]);
  });

  it('extractRange clears and closes the gap across tracks', () => {
    const { s } = fixture();
    extractRange(s, 50, 150);
    expect(lay(V(s))).toEqual([[0, 50], [50, 100]]);
    expect(lay(A(s))).toEqual([[0, 50], [50, 100]]);
    expect(lay(A(s, 1))).toEqual([[50, 150]]);
  });

  it('extractRange / liftRange restricted to tracks leave the others alone', () => {
    const { s } = fixture();
    extractRange(s, 50, 150, [V(s).id]);
    expect(lay(V(s))).toEqual([[0, 50], [50, 100]]);
    expect(lay(A(s))).toEqual([[0, 200]]);
    expect(lay(A(s, 1))).toEqual([[150, 250]]);
    const f2 = fixture(); f2.s.audioTracks[0].locked = true;
    liftRange(f2.s, 0, 300);
    expect(f2.s.videoTracks[0].clips).toEqual([]);
    expect(lay(f2.s.audioTracks[0])).toEqual([[0, 200]]);
  });

  it('clearRange with except keeps the excepted clip and ignores empty ranges', () => {
    const s = S();
    const a = put(V(s), 0, 100); put(V(s), 100, 100);
    clearRange(V(s), 0, 50, new Set([a.id]));
    expect(lay(V(s))).toEqual([[0, 100], [100, 200]]);
    clearRange(V(s), 50, 50);
    expect(lay(V(s))).toEqual([[0, 100], [100, 200]]);
  });
});

// ------------------------------------------------------------------
describe('trimStart / trimEnd / trimLimits', () => {
  const M = media({ m: 10 }); // 10 s = 240 frames

  it('trimLimits accounts for neighbours, media handles and MIN_CLIP_FRAMES', () => {
    const s = S();
    put(V(s), 0, 80); const b = put(V(s), 100, 100, { sourceIn: 2 }); put(V(s), 250, 10);
    expect(trimLimits(s, V(s), b, 10)).toEqual({ minStart: 80, maxStart: 199, minEnd: 101, maxEnd: 250 });
    const s2 = S(); const c = put(V(s2), 100, 100, { sourceIn: 2 });
    expect(trimLimits(s2, V(s2), c, 10)).toEqual({ minStart: 52, maxStart: 199, minEnd: 101, maxEnd: 292 });
    expect(trimLimits(s2, V(s2), c, Infinity).maxEnd).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('trimLimits handleBefore floors at 23.976 so sourceIn can never go negative', () => {
    const s = S(NTSC);
    const c = put(V(s), 100, 48, { sourceIn: 1 }); // 23.976 frames of handle -> 23
    const lim = trimLimits(s, V(s), c, 10);
    expect(lim.minStart).toBe(77);
    expect(trimStart(s, c.id, 0, M)).toBe(77);
    expect(c.sourceIn).toBeGreaterThanOrEqual(0);
    expect(c.sourceIn).toBeCloseTo(1 - 23 * 1001 / 24000, 12);
    // an exact frame count of handle is fully available despite float noise
    const d = put(V(s, 1), 300, 48, { sourceIn: sec(240, NTSC) });
    expect(trimLimits(s, V(s, 1), d, 20).minStart).toBe(60);
  });

  it('trimStart is clamped by the previous clip, media handle, MIN_CLIP_FRAMES and keeps the end fixed', () => {
    const s = S();
    put(V(s), 0, 80); const b = put(V(s), 100, 100, { sourceIn: 2 });
    expect(trimStart(s, b.id, 0, M)).toBe(80);
    expect(b).toMatchObject({ start: 80, duration: 120 });
    expect(b.sourceIn).toBeCloseTo(2 - 20 / 24, 12);
    expect(trimStart(s, b.id, 500, M)).toBe(199);
    expect(b).toMatchObject({ start: 199, duration: 1 });
    expect(b.sourceIn).toBeCloseTo(2 + 99 / 24, 12);

    const s2 = S(); const c = put(V(s2), 100, 100, { sourceIn: 1 });
    expect(trimStart(s2, c.id, 0, M)).toBe(76);
    expect(c.sourceIn).toBeCloseTo(0, 12);
    expect(c.sourceIn).toBeGreaterThanOrEqual(0);
  });

  it('trimStart ignoreNeighbors may overlap the previous clip but still respects media', () => {
    const s = S();
    put(V(s), 0, 80); const b = put(V(s), 100, 100, { sourceIn: 2 });
    expect(trimStart(s, b.id, 0, M, { ignoreNeighbors: true })).toBe(52);
    expect(b.sourceIn).toBeCloseTo(0, 12);
  });

  it('trimEnd is clamped by the next clip, media end and MIN_CLIP_FRAMES; start stays fixed', () => {
    const s = S();
    const b = put(V(s), 100, 100, { sourceIn: 2 }); put(V(s), 250, 10);
    expect(trimEnd(s, b.id, 400, M)).toBe(250);
    expect(b).toMatchObject({ start: 100, duration: 150, sourceIn: 2 });
    expect(trimEnd(s, b.id, 100, M)).toBe(101);
    expect(b.duration).toBe(1);
    expect(trimEnd(s, b.id, 400, M, { ignoreNeighbors: true })).toBe(292);
    const s2 = S(); const c = put(V(s2), 100, 100, { sourceIn: 2 });
    expect(trimEnd(s2, c.id, 400, M)).toBe(292);
    expect(trimEnd(s2, c.id, 100000, INF)).toBe(100000);
  });

  it('trims drop transitions that are no longer at a cut and return NaN for locked/missing clips', () => {
    const s = S();
    const a = put(V(s), 0, 100); const b = put(V(s), 100, 100);
    addTransition(s, V(s).id, 100, 'crossDissolve', 10);
    trimEnd(s, a.id, 90, INF);
    expect(V(s).transitions).toEqual([]);
    V(s).locked = true;
    expect(trimEnd(s, b.id, 150, INF)).toBeNaN();
    expect(trimStart(s, b.id, 150, INF)).toBeNaN();
    expect(trimStart(s, 'nope', 0, INF)).toBeNaN();
  });
});

// ------------------------------------------------------------------
describe('rippleTrimStart', () => {
  function fixture(sourceIn = 5) {
    const s = S();
    const a = put(V(s), 0, 100, { name: 'A' }); const b = put(V(s), 100, 100, { name: 'B', sourceIn }); const c = put(V(s), 200, 100, { name: 'C' });
    const x = put(A(s), 100, 50, { name: 'x' }); const y = put(A(s), 150, 100, { name: 'y' });
    const z = put(A(s, 1), 0, 100, { name: 'z' }); const w = put(A(s, 1), 100, 100, { name: 'w' });
    return { s, a, b, c, x, y, z, w };
  }

  it('shrinking the head keeps the clip anchored, reveals later source and pulls everything after left', () => {
    const { s, a, b, c } = fixture();
    expect(rippleTrimStart(s, b.id, 110, INF)).toBe(110);
    expect(lay(V(s))).toEqual([[0, 100], [100, 190], [190, 290]]);
    expect(ids(V(s))).toEqual([a.id, b.id, c.id]);
    expect(b.sourceIn).toBeCloseTo(5 + 10 / 24, 12);
    expect(c.sourceIn).toBe(0);
    // A1 clips start at/after the edit point and have room: they move left
    expect(lay(A(s))).toEqual([[90, 140], [140, 240]]);
    // A2's clip at the edit point cannot move left (z is in the way): that track stays put
    expect(lay(A(s, 1))).toEqual([[0, 100], [100, 200]]);
  });

  it('extending the head reveals earlier source and pushes everything after right', () => {
    const { s, b, c, w } = fixture();
    expect(rippleTrimStart(s, b.id, 90, INF)).toBe(90);
    expect(lay(V(s))).toEqual([[0, 100], [100, 210], [210, 310]]);
    expect(b.sourceIn).toBeCloseTo(5 - 10 / 24, 12);
    expect(c.sourceIn).toBe(0);
    expect(lay(A(s))).toEqual([[110, 160], [160, 260]]);
    expect(lay(A(s, 1))).toEqual([[0, 100], [110, 210]]);
    expect(A(s, 1).clips[1]).toBe(w);
  });

  it('is clamped by the media handle when extending and by MIN_CLIP_FRAMES when shrinking', () => {
    const f = fixture(0.5); // 12 frames of handle
    expect(rippleTrimStart(f.s, f.b.id, 0, INF)).toBe(88);
    expect(f.b).toMatchObject({ start: 100, duration: 112 });
    expect(f.b.sourceIn).toBeCloseTo(0, 12);
    expect(lay(V(f.s))).toEqual([[0, 100], [100, 212], [212, 312]]);
    const g = fixture();
    expect(rippleTrimStart(g.s, g.b.id, 500, INF)).toBe(199);
    expect(g.b).toMatchObject({ start: 100, duration: 1 });
    expect(lay(V(g.s))).toEqual([[0, 100], [100, 101], [101, 201]]);
    expect(rippleTrimStart(g.s, g.b.id, 100, INF)).toBe(100); // no-op
  });

  it('trims linked clips sharing the start together and reports NaN for locked', () => {
    const s = S();
    const v = put(V(s), 100, 100, { linkId: 'L', sourceIn: 2 }); const a = put(A(s), 100, 100, { linkId: 'L', sourceIn: 2 }); const n = put(A(s), 200, 10);
    const far = put(A(s, 1), 50, 100, { linkId: 'L' }); // linked but different start: untouched
    expect(rippleTrimStart(s, v.id, 124, INF)).toBe(124);
    expect(v).toMatchObject({ start: 100, duration: 76 }); expect(v.sourceIn).toBe(3);
    expect(a).toMatchObject({ start: 100, duration: 76 }); expect(a.sourceIn).toBe(3);
    expect(n.start).toBe(176);
    expect(far).toMatchObject({ start: 50, duration: 100 });
    V(s).locked = true;
    expect(rippleTrimStart(s, v.id, 130, INF)).toBeNaN();
  });

  it('at the sequence start it can extend into negative "newStart" (clip stays at 0)', () => {
    const s = S();
    const b = put(V(s), 0, 100, { sourceIn: 2 }); const c = put(V(s), 100, 10);
    expect(rippleTrimStart(s, b.id, -24, INF)).toBe(-24);
    expect(b).toMatchObject({ start: 0, duration: 124, sourceIn: 1 });
    expect(c.start).toBe(124);
  });
});

// ------------------------------------------------------------------
describe('rippleTrimEnd', () => {
  function fixture() {
    const s = S();
    put(V(s), 0, 100); const b = put(V(s), 100, 100, { sourceIn: 2 }); const c = put(V(s), 200, 100);
    const x = put(A(s), 200, 50); const sp = put(A(s, 1), 150, 100);
    return { s, b, c, x, sp };
  }

  it('shrinking pulls following clips left; a spanning clip on another track blocks only that track', () => {
    const { s, b, c, x, sp } = fixture();
    expect(rippleTrimEnd(s, b.id, 180, INF)).toBe(180);
    expect(b).toMatchObject({ start: 100, duration: 80, sourceIn: 2 });
    expect(c.start).toBe(180);
    expect(x.start).toBe(180);
    expect(sp).toMatchObject({ start: 150, duration: 100 });
  });

  it('extending pushes following clips right', () => {
    const { s, b, c, x } = fixture();
    expect(rippleTrimEnd(s, b.id, 220, INF)).toBe(220);
    expect(b.duration).toBe(120);
    expect(c.start).toBe(220);
    expect(x.start).toBe(220);
  });

  it('is clamped by media and MIN_CLIP_FRAMES; linked clips sharing the end follow', () => {
    const { s, b } = fixture();
    expect(rippleTrimEnd(s, b.id, 400, media({ m: 10 }))).toBe(292);
    expect(rippleTrimEnd(s, b.id, 10, INF)).toBe(101);
    expect(b.duration).toBe(1);
    const s2 = S();
    const v = put(V(s2), 0, 100, { linkId: 'L' }); const a = put(A(s2), 0, 100, { linkId: 'L' }); const n = put(V(s2), 100, 10);
    expect(rippleTrimEnd(s2, v.id, 120, INF)).toBe(120);
    expect(v.duration).toBe(120); expect(a.duration).toBe(120); expect(n.start).toBe(120);
  });
});

// ------------------------------------------------------------------
describe('rollEdit', () => {
  const M = media({ a: 5, b: 100 }); // A has 120 frames of media
  function fixture() {
    const s = S();
    const a = put(V(s), 0, 100, { mediaId: 'a' }); const b = put(V(s), 100, 100, { mediaId: 'b', sourceIn: 1 });
    return { s, a, b };
  }

  it('moves the cut, keeping total duration; limited by A media end', () => {
    const { s, a, b } = fixture();
    expect(rollEdit(s, a.id, b.id, 130, M)).toBe(120);
    expect(a).toMatchObject({ start: 0, duration: 120 });
    expect(b).toMatchObject({ start: 120, duration: 80 });
    expect(b.sourceIn).toBeCloseTo(1 + 20 / 24, 12);
    expect(a.duration + b.duration).toBe(200);
  });

  it('limited by B handle before and by MIN_CLIP_FRAMES', () => {
    const { s, a, b } = fixture();
    expect(rollEdit(s, a.id, b.id, 0, M)).toBe(76);
    expect(a.duration).toBe(76);
    expect(b).toMatchObject({ start: 76, duration: 124 });
    expect(b.sourceIn).toBeCloseTo(0, 12);
    const f2 = fixture();
    expect(rollEdit(f2.s, f2.a.id, f2.b.id, 1000, INF)).toBe(199);
    const f3 = fixture();
    expect(rollEdit(f3.s, f3.a.id, f3.b.id, -1000, media({ a: 5, b: 100 }))).toBe(76);
  });

  it('returns NaN for non-adjacent clips or locked tracks and keeps transitions at the cut', () => {
    const s = S();
    const a = put(V(s), 0, 100); const b = put(V(s), 150, 100);
    expect(rollEdit(s, a.id, b.id, 120, INF)).toBeNaN();
    const f = fixture();
    const tr = addTransition(f.s, V(f.s).id, 100, 'crossDissolve', 10)!;
    rollEdit(f.s, f.a.id, f.b.id, 110, INF);
    expect(V(f.s).transitions[0].id).toBe(tr.id);
    V(f.s).locked = true;
    expect(rollEdit(f.s, f.a.id, f.b.id, 115, INF)).toBeNaN();
  });
});

// ------------------------------------------------------------------
describe('slipClip', () => {
  const M = media({ m: 10 });
  it('clamps to media handles on both sides and never moves the clip', () => {
    const s = S();
    const c = put(V(s), 10, 48, { sourceIn: 2 }); // 48 frames before, 144 after
    expect(slipClip(s, c.id, 200, M)).toBe(144);
    expect(c.sourceIn).toBe(8);
    expect(c).toMatchObject({ start: 10, duration: 48 });
    expect(slipClip(s, c.id, -1000, M)).toBe(-192);
    expect(c.sourceIn).toBe(0);
    expect(slipClip(s, c.id, 12, M)).toBe(12);
    expect(c.sourceIn).toBe(0.5);
  });

  it('applies the tightest limit across the linked group and respects speed', () => {
    const s = S();
    const v = put(V(s), 0, 48, { linkId: 'L', sourceIn: 2 }); const a = put(A(s), 0, 48, { linkId: 'L', sourceIn: 1 });
    expect(slipClip(s, v.id, -100, M)).toBe(-24);
    expect(v.sourceIn).toBe(1); expect(a.sourceIn).toBe(0);
    const s2 = S();
    const f = put(V(s2), 0, 48, { sourceIn: 2, speed: 2 }); // 4 s consumed; 24 frames of handle before
    expect(slipClip(s2, f.id, -100, M)).toBe(-24);
    expect(f.sourceIn).toBe(0);
    expect(slipClip(s2, f.id, 1000, M)).toBe(72); // (10-0)/2*24 = 120 max, minus 48
    expect(f.sourceIn).toBe(6);
    V(s2).locked = true;
    expect(slipClip(s2, f.id, 1, M)).toBe(0);
  });
});

// ------------------------------------------------------------------
describe('slideClip', () => {
  const M = media({ m: 10 });
  function fixture() {
    const s = S();
    const a = put(V(s), 0, 100, { name: 'A' }); const b = put(V(s), 100, 50, { name: 'B' }); const c = put(V(s), 150, 100, { name: 'C', sourceIn: 2 });
    return { s, a, b, c };
  }

  it('slides right: previous grows, next shrinks from its head, total duration unchanged', () => {
    const { s, a, b, c } = fixture();
    expect(slideClip(s, b.id, 20, M)).toBe(20);
    expect(lay(V(s))).toEqual([[0, 120], [120, 170], [170, 250]]);
    expect(a.sourceIn).toBe(0);
    expect(c.sourceIn).toBeCloseTo(2 + 20 / 24, 12);
    expect(b.sourceIn).toBe(0);
    expect(sequenceDuration(s)).toBe(250);
  });

  it('slides left: previous shrinks, next grows backwards', () => {
    const { s, c } = fixture();
    expect(slideClip(s, V(s).clips[1].id, -30, M)).toBe(-30);
    expect(lay(V(s))).toEqual([[0, 70], [70, 120], [120, 250]]);
    expect(c.sourceIn).toBeCloseTo(2 - 30 / 24, 12);
  });

  it('is limited by neighbour media and MIN_CLIP_FRAMES', () => {
    const f1 = fixture();
    expect(slideClip(f1.s, f1.b.id, 500, M)).toBe(99);   // C can shrink to 1 frame (A could grow 140)
    expect(lay(V(f1.s))).toEqual([[0, 199], [199, 249], [249, 250]]);
    const f2 = fixture();
    expect(slideClip(f2.s, f2.b.id, -500, M)).toBe(-48); // C has 48 frames of handle
    expect(lay(V(f2.s))).toEqual([[0, 52], [52, 102], [102, 250]]);
  });

  it('with a gap, it only moves within the gap; without neighbours it is bounded by 0', () => {
    const s = S();
    put(V(s), 0, 100); const b = put(V(s), 120, 50); put(V(s), 200, 100);
    expect(slideClip(s, b.id, -50, M)).toBe(-20);
    expect(lay(V(s))).toEqual([[0, 100], [100, 150], [200, 300]]);
    // now adjacent to the previous clip: it extends; the gap to the next clip bounds the move
    expect(slideClip(s, b.id, 100, M)).toBe(50);
    expect(lay(V(s))).toEqual([[0, 150], [150, 200], [200, 300]]);
    const s2 = S(); const lone = put(V(s2), 10, 10);
    expect(slideClip(s2, lone.id, -50, M)).toBe(-10);
    expect(lone.start).toBe(0);
  });
});

// ------------------------------------------------------------------
describe('moveClips', () => {
  it('overwrite mode moves across tracks, clearing what it lands on', () => {
    const s = S();
    const a = put(V(s), 0, 100); put(V(s, 1), 50, 30); const far = put(V(s, 1), 200, 10);
    expect(moveClips(s, [{ clipId: a.id, toTrackId: V(s, 1).id, toStart: 40 }], 'overwrite')).toBe(true);
    expect(V(s).clips).toEqual([]);
    expect(lay(V(s, 1))).toEqual([[40, 140], [200, 210]]);
    expect(ids(V(s, 1))).toEqual([a.id, far.id]);
  });

  it('overwrite mode partially covering a clip trims it; negative targets clamp to 0', () => {
    const s = S();
    const a = put(V(s), 300, 50); const b = put(V(s, 1), 0, 100, { sourceIn: 1 });
    moveClips(s, [{ clipId: a.id, toTrackId: V(s, 1).id, toStart: -10 }], 'overwrite');
    expect(lay(V(s, 1))).toEqual([[0, 50], [50, 100]]);
    expect(V(s, 1).clips[1].id).toBe(b.id);
    expect(V(s, 1).clips[1].sourceIn).toBeCloseTo(1 + 50 / 24, 12);
  });

  it('insert mode splits the destination and ripples all tracks', () => {
    const s = S();
    const a = put(V(s), 0, 100, { sourceIn: 1 }); const b = put(V(s), 100, 100); const x = put(A(s), 80, 10);
    expect(moveClips(s, [{ clipId: b.id, toTrackId: V(s).id, toStart: 50 }], 'insert')).toBe(true);
    expect(lay(V(s))).toEqual([[0, 50], [50, 150], [150, 200]]);
    expect(V(s).clips[0].id).toBe(a.id); expect(V(s).clips[1].id).toBe(b.id);
    expect(V(s).clips[2].sourceIn).toBeCloseTo(1 + 50 / 24, 12);
    expect(x.start).toBe(180);
  });

  it('moves a linked pair together and refuses video->audio or locked tracks', () => {
    const s = S();
    const v = put(V(s), 0, 100, { linkId: 'L' }); const a = put(A(s), 0, 100, { linkId: 'L' });
    expect(moveClips(s, [{ clipId: v.id, toTrackId: V(s, 1).id, toStart: 50 }, { clipId: a.id, toTrackId: A(s, 1).id, toStart: 50 }], 'overwrite')).toBe(true);
    expect(lay(V(s, 1))).toEqual([[50, 150]]); expect(lay(A(s, 1))).toEqual([[50, 150]]);
    expect(V(s).clips).toEqual([]); expect(A(s).clips).toEqual([]);
    expect(moveClips(s, [{ clipId: v.id, toTrackId: A(s).id, toStart: 0 }], 'overwrite')).toBe(false);
    expect(lay(V(s, 1))).toEqual([[50, 150]]);
    V(s, 2).locked = true;
    expect(moveClips(s, [{ clipId: v.id, toTrackId: V(s, 2).id, toStart: 0 }], 'overwrite')).toBe(false);
    expect(moveClips(s, [{ clipId: 'nope', toTrackId: V(s).id, toStart: 0 }], 'overwrite')).toBe(false);
  });
});

// ------------------------------------------------------------------
describe('transitions', () => {
  it('addTransition on a cut clamps to the shorter clip and replaces an existing one', () => {
    const s = S();
    const a = put(V(s), 0, 100); const b = put(V(s), 100, 50);
    const t1 = addTransition(s, V(s).id, 100, 'crossDissolve', 120)!;
    expect(t1).toMatchObject({ type: 'crossDissolve', duration: 50, outClipId: a.id, inClipId: b.id });
    const t2 = addTransition(s, V(s).id, 100, 'dipToBlack', 10)!;
    expect(V(s).transitions).toEqual([t2]);
    expect(transitionsForClip(V(s), a.id).out).toBe(t2);
    expect(transitionsForClip(V(s), b.id).in).toBe(t2);
  });

  it('on a clip start/end with no neighbour uses null for the missing side; no cut -> null', () => {
    const s = S();
    const a = put(V(s), 10, 100);
    expect(addTransition(s, V(s).id, 10, 'crossDissolve', 12)).toMatchObject({ outClipId: null, inClipId: a.id, duration: 12 });
    expect(addTransition(s, V(s).id, 110, 'crossDissolve', 12)).toMatchObject({ outClipId: a.id, inClipId: null });
    expect(V(s).transitions).toHaveLength(2);
    expect(addTransition(s, V(s).id, 50, 'crossDissolve', 12)).toBeNull();
    expect(addTransition(s, V(s).id, 10, 'crossDissolve', 0)!.duration).toBe(1);
  });

  it('type/track compatibility and locked tracks', () => {
    const s = S();
    put(V(s), 0, 100); put(A(s), 0, 100);
    expect(addTransition(s, V(s).id, 0, 'audioCrossfade', 12)).toBeNull();
    expect(addTransition(s, A(s).id, 0, 'crossDissolve', 12)!.type).toBe('audioCrossfade');
    A(s).locked = true;
    expect(addTransition(s, A(s).id, 100, 'audioCrossfade', 12)).toBeNull();
  });

  it('removeTransition and reconcileTransitions after clips stop being adjacent', () => {
    const s = S();
    const a = put(V(s), 0, 100); const b = put(V(s), 100, 100); put(V(s), 200, 100);
    const t1 = addTransition(s, V(s).id, 100, 'crossDissolve', 10)!;
    const t2 = addTransition(s, V(s).id, 200, 'crossDissolve', 10)!;
    removeTransition(s, t1.id);
    expect(V(s).transitions.map((t) => t.id)).toEqual([t2.id]);
    moveClips(s, [{ clipId: b.id, toTrackId: V(s).id, toStart: 120 }], 'overwrite');
    expect(V(s).transitions).toEqual([]);
    const t3 = addTransition(s, V(s).id, 0, 'crossDissolve', 60)!;
    a.duration = 20; reconcileTransitions(V(s));
    expect(t3.duration).toBe(20);
    V(s).transitions.push({ id: 'ghost', type: 'crossDissolve', duration: 5, outClipId: 'gone', inClipId: null });
    V(s).transitions.push({ id: 'none', type: 'crossDissolve', duration: 5, outClipId: null, inClipId: null });
    reconcileTransitions(V(s));
    expect(V(s).transitions.map((t) => t.id)).toEqual([t3.id]);
  });
});

// ------------------------------------------------------------------
describe('tracks', () => {
  it('addTrack appends an unpatched, numbered track; removeTrack renumbers default names', () => {
    const s = S();
    const v4 = addTrack(s, 'video');
    expect(v4).toMatchObject({ name: 'V4', kind: 'video', patched: false });
    expect(s.videoTracks).toHaveLength(4);
    expect(addTrack(s, 'audio').name).toBe('A4');
    // insert at an index: renumbers default names and clamps out-of-range indices
    const v2 = addTrack(s, 'video', 1);
    expect(s.videoTracks.indexOf(v2)).toBe(1);
    expect(s.videoTracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5']);
    expect(s.audioTracks.indexOf(addTrack(s, 'audio', 99))).toBe(4);
    expect(s.audioTracks.indexOf(addTrack(s, 'audio', -5))).toBe(0);
    expect(s.audioTracks.map((t) => t.name)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    s.videoTracks.splice(1, 1); s.audioTracks.splice(0, 1); s.audioTracks.splice(3, 1); renameTracks(s);
    s.videoTracks[2].name = 'Titles';
    expect(removeTrack(s, s.videoTracks[1].id)).toBe(true);
    expect(s.videoTracks.map((t) => t.name)).toEqual(['V1', 'Titles', 'V3']);
    expect(removeTrack(s, s.audioTracks[0].id)).toBe(true);
    expect(s.audioTracks.map((t) => t.name)).toEqual(['A1', 'A2', 'A3']);
    expect(removeTrack(s, 'nope')).toBe(false);
  });

  it('removeTrack refuses the last track of a kind; renameTracks is idempotent', () => {
    const s = S();
    removeTrack(s, s.videoTracks[0].id); removeTrack(s, s.videoTracks[0].id);
    expect(removeTrack(s, s.videoTracks[0].id)).toBe(false);
    expect(s.videoTracks).toHaveLength(1);
    renameTracks(s); renameTracks(s);
    expect(s.videoTracks[0].name).toBe('V1');
  });
});

// ------------------------------------------------------------------
describe('navigation / markers', () => {
  it('editPoints collects 0, clip edges and markers; nextEdit/prevEdit walk them', () => {
    const s = S();
    put(V(s), 0, 100); put(V(s), 100, 100); put(A(s), 50, 70);
    addMarker(s, { time: 300, duration: 0, name: 'm', note: '', color: '', kind: 'marker' });
    expect(editPoints(s)).toEqual([0, 50, 100, 120, 200, 300]);
    expect(editPoints(s, [V(s).id])).toEqual([0, 100, 200, 300]);
    expect(nextEdit(s, 100)).toBe(120);
    expect(nextEdit(s, 0)).toBe(50);
    expect(nextEdit(s, 300)).toBeNull();
    expect(prevEdit(s, 100)).toBe(50);
    expect(prevEdit(s, 1)).toBe(0);
    expect(prevEdit(s, 0)).toBeNull();
  });

  it('addMarker keeps markers sorted and assigns ids', () => {
    const s = S();
    const m2 = addMarker(s, { time: 200, duration: 0, name: 'b', note: '', color: '', kind: 'chapter' });
    const m1 = addMarker(s, { time: 10, duration: 5, name: 'a', note: '', color: '', kind: 'marker' });
    expect(m1.id).toBeTruthy(); expect(m1.id).not.toBe(m2.id);
    expect(s.markers.map((m) => m.name)).toEqual(['a', 'b']);
  });
});

// ------------------------------------------------------------------
describe('rippleShift', () => {
  it('shifts clips at/after fromFrame on unlocked tracks, honours onlyTrackIds/skipTrackIds/except, reports tracks', () => {
    const s = S();
    put(V(s), 0, 100); const b = put(V(s), 100, 100); const x = put(A(s), 100, 10); const y = put(A(s, 1), 100, 10); A(s, 1).locked = true;
    const z = put(A(s, 2), 100, 10);
    expect(rippleShift(s, 100, 24, { skipTrackIds: new Set([A(s, 2).id]) })).toEqual([V(s).id, A(s).id]);
    expect(b.start).toBe(124); expect(x.start).toBe(124); expect(y.start).toBe(100); expect(z.start).toBe(100);
    expect(rippleShift(s, 100, 10, { onlyTrackIds: new Set([A(s, 2).id]) })).toEqual([A(s, 2).id]);
    expect(z.start).toBe(110); expect(b.start).toBe(124);
    expect(rippleShift(s, 100, -10, { except: new Set([b.id]) })).toEqual([A(s).id, A(s, 2).id]);
    expect(b.start).toBe(124); expect(x.start).toBe(114);
    expect(rippleShift(s, 0, 0)).toEqual([]);
  });

  it('leftward shift is blocked only when a non-moving clip would actually be overlapped', () => {
    const s = S();
    put(V(s), 0, 100); const v = put(V(s), 200, 50);                 // free -> moves
    put(A(s), 50, 100); const a = put(A(s), 300, 10);                 // ends at 150 <= 200-100 -> moves
    put(A(s, 1), 50, 120); const b = put(A(s, 1), 200, 10);           // ends at 170 > 100 -> blocked
    expect(rippleShift(s, 200, -100)).toEqual([V(s).id, A(s).id]);
    expect(v.start).toBe(100); expect(a.start).toBe(200); expect(b.start).toBe(200);
  });

  it('adjusts story blocks: shifts blocks after the point, stretches spanning ones, collapses deleted regions', () => {
    const s = S();
    s.storyBlocks.push(
      { id: '1', name: 'before', start: 0, end: 150, color: '', notes: '' },
      { id: '2', name: 'at', start: 150, end: 200, color: '', notes: '' },
      { id: '3', name: 'span', start: 100, end: 300, color: '', notes: '' },
      { id: '4', name: 'after', start: 300, end: 400, color: '', notes: '' },
    );
    rippleShift(s, 150, 24);
    expect(s.storyBlocks.map((b) => [b.start, b.end])).toEqual([[0, 150], [174, 224], [100, 324], [324, 424]]);
    const s2 = S();
    s2.storyBlocks.push(
      { id: '1', name: 'before', start: 0, end: 100, color: '', notes: '' },
      { id: '2', name: 'endsInside', start: 0, end: 150, color: '', notes: '' },
      { id: '3', name: 'inside', start: 120, end: 180, color: '', notes: '' },
      { id: '4', name: 'span', start: 50, end: 300, color: '', notes: '' },
      { id: '5', name: 'after', start: 200, end: 300, color: '', notes: '' },
      { id: '6', name: 'startsInside', start: 150, end: 300, color: '', notes: '' },
    );
    rippleShift(s2, 200, -100); // remove [100,200)
    // 'inside' lay entirely in the removed region: it collapses to nothing and is dropped (QA-27).
    expect(s2.storyBlocks.map((b) => [b.name, b.start, b.end])).toEqual([
      ['before', 0, 100], ['endsInside', 0, 100], ['span', 50, 200], ['after', 100, 200], ['startsInside', 100, 200],
    ]);
  });
});

// ------------------------------------------------------------------
describe('resolveSubtitleCues', () => {
  function fixture() {
    const s = S();
    const c = put(V(s), 48, 100, { sourceIn: 2 });
    s.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [
      cue({ id: 'in', clipId: c.id, srcStart: 3, srcEnd: 4 }),
      cue({ id: 'clipped', clipId: c.id, srcStart: 1, srcEnd: 2.5 }),
      cue({ id: 'tailclip', clipId: c.id, srcStart: 6, srcEnd: 9 }),
      cue({ id: 'outside', clipId: c.id, srcStart: 10, srcEnd: 11 }),
      cue({ id: 'nosrc', clipId: c.id }),
      cue({ id: 'offset', clipId: c.id, srcStart: 3, srcEnd: 3.5, offset: 5 }),
      cue({ id: 'free', start: 10, duration: 20, offset: 2 }),
      cue({ id: 'orphan', clipId: 'gone', srcStart: 0, srcEnd: 1 }),
    ] });
    return { s, c };
  }
  const byId = (s: Sequence) => Object.fromEntries(resolveSubtitleCues(s).map((r) => [r.id, [r.start, r.end]]));

  it('derives clip-attached positions from the clip, clips to clip bounds and drops orphans/outside cues', () => {
    const { s, c } = fixture();
    const r = byId(s);
    expect(r).toEqual({ in: [72, 96], clipped: [48, 60], tailclip: [144, 148], offset: [77, 89], free: [12, 32] });
    const res = resolveSubtitleCues(s);
    expect(res.map((x) => x.start)).toEqual([...res.map((x) => x.start)].sort((a, b) => a - b));
    expect(res.find((x) => x.id === 'in')).toMatchObject({ trackId: 'st', clipId: c.id, orphan: false, text: 'in' });
    expect(res.find((x) => x.id === 'free')!.clipId).toBeUndefined();
  });

  it('moves with the clip, honours speed, and disappears when the clip is removed or disabled', () => {
    const { s, c } = fixture();
    c.start = 100;
    expect(byId(s).in).toEqual([124, 148]);
    c.speed = 2;
    expect(byId(s).in).toEqual([112, 124]);
    c.speed = 1;
    c.enabled = false;
    expect(Object.keys(byId(s))).toEqual(['free']);
    c.enabled = true;
    removeClips(s, [c.id]);
    expect(Object.keys(byId(s))).toEqual(['free']);
  });

  it('skips disabled subtitle tracks', () => {
    const { s } = fixture();
    s.subtitleTracks[0].enabled = false;
    expect(resolveSubtitleCues(s)).toEqual([]);
  });

  it('after a razor, cues resolve at the same timeline position via the tail; a cue straddling the cut is duplicated onto the tail', () => {
    const { s, c } = fixture();
    s.subtitleTracks[0].cues.push(cue({ id: 'straddle', clipId: c.id, srcStart: 3.5, srcEnd: 5 })); // [84, 120] before the cut
    const before = byId(s);
    expect(before.straddle).toEqual([84, 120]);
    const [tail] = razorAt(s, 100);
    const after = byId(s);
    const copy = s.subtitleTracks[0].cues.find((x) => x.text === 'straddle' && x.id !== 'straddle')!;
    expect(copy).toMatchObject({ clipId: tail.id, srcStart: c.sourceIn + 52 / 24, srcEnd: 5 });
    expect(after[copy.id]).toEqual([100, 120]);
    delete after[copy.id];
    expect(after).toEqual({ ...before, straddle: [84, 100] });
    expect(s.subtitleTracks[0].cues.find((x) => x.id === 'tailclip')!.clipId).not.toBe(c.id);
    expect(s.subtitleTracks[0].cues.find((x) => x.id === 'straddle')).toMatchObject({ clipId: c.id, srcEnd: c.sourceIn + 52 / 24 });
  });
});

// ------------------------------------------------------------------
describe('attack fixes (QA-11/12/14/15/17, E-18)', () => {
  it('splitClip duplicates a straddling cue: head keeps [srcStart, split), tail gets [split, srcEnd)', () => {
    const s = S();
    const a = put(V(s), 0, 96);
    s.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [cue({ id: 'x', clipId: a.id, srcStart: 1, srcEnd: 3 })] });
    const tail = splitClip(s, V(s), a, 48)!;
    const cues = s.subtitleTracks[0].cues;
    expect(cues).toHaveLength(2);
    expect(cues.find((c) => c.id === 'x')).toMatchObject({ clipId: a.id, srcStart: 1, srcEnd: 2 });
    expect(cues.find((c) => c.id !== 'x')).toMatchObject({ clipId: tail.id, srcStart: 2, srcEnd: 3, text: 'x' });
    expect(resolveSubtitleCues(s).map((r) => [r.start, r.end])).toEqual([[24, 48], [48, 72]]);
  });

  it('insert into the middle of a clip duplicates the straddling cue onto the tail', () => {
    const s = S();
    const a = put(V(s), 0, 96);
    s.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [cue({ id: 'x', clipId: a.id, srcStart: 1, srcEnd: 3 })] });
    insertClip(s, V(s).id, makeClip({ mediaId: 'n', name: 'ins', sourceIn: 0, duration: 10, kind: 'video' }, 48));
    expect(resolveSubtitleCues(s).map((r) => [r.start, r.end])).toEqual([[24, 48], [58, 82]]);
  });

  it('overwrite / lift / removeTrack drop the cues of clips they delete; an overwrite inside a clip moves later cues to the tail', () => {
    const s = S();
    const a = put(V(s), 0, 48); const b = put(V(s), 48, 96);
    s.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [
      cue({ id: 'ca', clipId: a.id, srcStart: 0, srcEnd: 1 }),
      cue({ id: 'cb1', clipId: b.id, srcStart: 0.5, srcEnd: 1 }),       // frames 60..72 (inside the overwrite)
      cue({ id: 'cb2', clipId: b.id, srcStart: 0.5, srcEnd: 2.5 }),     // 60..108 straddles the overwrite end (96)
      cue({ id: 'cb3', clipId: b.id, srcStart: 3, srcEnd: 3.5 }),       // 120..132 after it
      cue({ id: 'free', start: 0 }),
    ] });
    overwriteClip(s, V(s).id, makeClip({ mediaId: 'n', name: 'ow', sourceIn: 0, duration: 108, kind: 'video' }, -12 + 12)); // covers a entirely + b head
    // a is gone with its cue; b keeps id (tail) → cues before its new sourceIn are invisible but attached
    expect(s.subtitleTracks[0].cues.map((c) => c.id)).not.toContain('ca');
    const s2 = S();
    const c = put(V(s2), 0, 144);
    s2.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [
      cue({ id: 'early', clipId: c.id, srcStart: 0, srcEnd: 1 }),       // 0..24 head
      cue({ id: 'cross', clipId: c.id, srcStart: 1.5, srcEnd: 3 }),     // 36..72 straddles cleared [48,60)... and tail start 60
      cue({ id: 'late', clipId: c.id, srcStart: 4, srcEnd: 5 }),        // 96..120 tail
    ] });
    overwriteClip(s2, V(s2).id, makeClip({ mediaId: 'n', name: 'ow', sourceIn: 0, duration: 12, kind: 'video' }, 48));
    const tail = V(s2).clips[2];
    const byText = (t: string) => s2.subtitleTracks[0].cues.filter((x) => x.text === t);
    expect(byText('late')[0].clipId).toBe(tail.id);
    expect(byText('early')[0].clipId).toBe(c.id);
    expect(byText('cross').map((x) => [x.clipId, x.srcStart, x.srcEnd])).toEqual([[c.id, 1.5, 2], [tail.id, 2.5, 3]]);
    expect(resolveSubtitleCues(s2).filter((r) => r.text === 'cross').map((r) => [r.start, r.end])).toEqual([[36, 48], [60, 72]]);
    // lift the whole thing: no cue left behind
    liftRange(s2, 0, 1000);
    expect(s2.subtitleTracks[0].cues).toEqual([]);
    // removeTrack
    const s3 = S();
    const d = put(V(s3, 1), 0, 48);
    s3.subtitleTracks.push({ id: 'st', name: 'st', language: 'en', enabled: true, cues: [cue({ id: 'cd', clipId: d.id, srcStart: 0, srcEnd: 1 }), cue({ id: 'free', start: 0 })] });
    expect(removeTrack(s3, V(s3, 1).id)).toBe(true);
    expect(s3.subtitleTracks[0].cues.map((x) => x.id)).toEqual(['free']);
  });

  it('moveClips clamps the delta once: a multi-clip move past 0 keeps spacing', () => {
    const s = S();
    const a = put(V(s), 10, 20); const b = put(V(s), 40, 20);
    expect(moveClips(s, [{ clipId: a.id, toTrackId: V(s).id, toStart: -20 }, { clipId: b.id, toTrackId: V(s).id, toStart: 10 }], 'overwrite')).toBe(true);
    expect(lay(V(s))).toEqual([[0, 20], [30, 50]]);
  });

  it('insert-move closes the vacated gap on the source track and adjusts a later destination', () => {
    const s = S();
    const a = put(V(s), 0, 96); const b = put(V(s), 96, 96); const c = put(V(s), 192, 96);
    const x = put(A(s), 300, 10);
    // drag a to just before c (pre-move frame 192): result b, a, c with no gaps
    expect(moveClips(s, [{ clipId: a.id, toTrackId: V(s).id, toStart: 192 }], 'insert')).toBe(true);
    expect(ids(V(s))).toEqual([b.id, a.id, c.id]);
    expect(lay(V(s))).toEqual([[0, 96], [96, 192], [192, 288]]);
    expect(x.start).toBe(300); // closing the gap pulls x back by 96, the insert pushes it forward again: sync kept
  });

  it('insert-move to an earlier point (E-18 repro): no gaps left behind', () => {
    const s = S();
    const a = put(V(s), 0, 96); const b = put(V(s), 96, 96); const c = put(V(s), 192, 96);
    expect(moveClips(s, [{ clipId: c.id, toTrackId: V(s).id, toStart: 96 }], 'insert')).toBe(true);
    expect(ids(V(s))).toEqual([a.id, c.id, b.id]);
    expect(lay(V(s))).toEqual([[0, 96], [96, 192], [192, 288]]);
  });

  it('insert-move of a linked pair closes the gap on both source tracks', () => {
    const s = S();
    const v = put(V(s), 0, 50, { linkId: 'L' }); const a = put(A(s), 0, 50, { linkId: 'L' });
    const v2 = put(V(s), 50, 50, { linkId: 'M' }); const a2 = put(A(s), 50, 50, { linkId: 'M' });
    moveClips(s, [{ clipId: v.id, toTrackId: V(s).id, toStart: 100 }, { clipId: a.id, toTrackId: A(s).id, toStart: 100 }], 'insert');
    expect(ids(V(s))).toEqual([v2.id, v.id]); expect(ids(A(s))).toEqual([a2.id, a.id]);
    expect(lay(V(s))).toEqual([[0, 50], [50, 100]]); expect(lay(A(s))).toEqual([[0, 50], [50, 100]]);
  });

  it('slipClip on a clip longer than its media never moves the source backwards', () => {
    const s = S();
    const a = put(V(s), 0, 240, { sourceIn: 5, mediaId: 'short' }); // media is 6 s: clip asks for 10 s
    expect(slipClip(s, a.id, 10, media({ short: 6 }))).toBe(0);
    expect(a.sourceIn).toBe(5);
    expect(slipClip(s, a.id, -24, media({ short: 6 }))).toBe(-24);
    expect(a.sourceIn).toBe(4);
  });

  it('transitions on both edges of a clip never overlap (add / reconcile)', () => {
    const s = S();
    const a = put(V(s), 0, 100); const b = put(V(s), 100, 12); const c = put(V(s), 112, 100);
    addTransition(s, V(s).id, 100, 'crossDissolve', 8);
    const t2 = addTransition(s, V(s).id, 112, 'crossDissolve', 12)!;
    expect(t2.duration).toBe(4); // 12 - 8 already used by b's in-transition
    // a full clip is shared when the other edge used every frame
    const s2 = S();
    put(V(s2), 0, 100); const m = put(V(s2), 100, 12); put(V(s2), 112, 100);
    const first = addTransition(s2, V(s2).id, 100, 'crossDissolve', 12)!;
    const second = addTransition(s2, V(s2).id, 112, 'crossDissolve', 12)!;
    expect(first.duration + second.duration).toBeLessThanOrEqual(m.duration);
    expect(V(s2).transitions).toHaveLength(2);
    // reconcile shrinks the out-transition when the sum exceeds the clip
    const tin = transitionsForClip(V(s), b.id).in!;
    tin.duration = 10;
    reconcileTransitions(V(s));
    expect(transitionsForClip(V(s), b.id).out!.duration).toBe(2);
    tin.duration = 12;
    reconcileTransitions(V(s));
    expect(transitionsForClip(V(s), b.id).out).toBeUndefined();
    expect(a.id && c.id).toBeTruthy();
  });

  it('followClipMarkers: clip-linked markers follow a move, stay on head trims, lose clipId when the clip vanishes', () => {
    const prev = S();
    const a = put(V(prev), 0, 100, { sourceIn: 2 });
    prev.markers.push({ id: 'm', time: 30, duration: 0, name: 'n', note: '', color: '', kind: 'continuity', clipId: a.id },
      { id: 'free', time: 31, duration: 0, name: 'f', note: '', color: '', kind: 'marker' });
    const next = structuredClone(prev);
    V(next).clips[0].start = 200;
    followClipMarkers(prev, next);
    expect(next.markers.map((m) => [m.id, m.time])).toEqual([['free', 31], ['m', 230]]);
    const trimmed = structuredClone(prev);
    trimStart(trimmed, a.id, 10, INF);
    followClipMarkers(prev, trimmed);
    expect(trimmed.markers.find((m) => m.id === 'm')!.time).toBe(30);
    const gone = structuredClone(prev);
    V(gone).clips = [];
    followClipMarkers(prev, gone);
    expect(gone.markers.find((m) => m.id === 'm')).toMatchObject({ time: 30 });
    expect(gone.markers.find((m) => m.id === 'm')!.clipId).toBeUndefined();
  });
});

describe('shared speed range', () => {
  it('Inspector and Speed dialog share 1 %–10 000 %', async () => {
    const { SPEED_PERCENT_MIN, SPEED_PERCENT_MAX, clampSpeedPercent } = await import('../../shared/timeline');
    expect([SPEED_PERCENT_MIN, SPEED_PERCENT_MAX]).toEqual([1, 10000]);
    expect(clampSpeedPercent(0.5)).toBe(0.01);
    expect(clampSpeedPercent(5)).toBe(0.05);
    expect(clampSpeedPercent(2500)).toBe(25);
    expect(clampSpeedPercent(20000)).toBe(100);
    expect(clampSpeedPercent(Number.NaN)).toBe(1);
  });
});
