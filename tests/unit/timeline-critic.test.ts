/**
 * Regression tests for the adversarial-critic findings on timeline editing (critic C findings F1–F8 and
 * critic B probes B1 / B3 / B10). Each `describe` names the finding it pins down.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMediaItem, createSequence } from '../../shared/project';
import type { Clip, MediaItem, Sequence, Track } from '../../shared/model';
import {
  makeClip, sortTrack, clipEnd, clipSourceOut, maxDurationFrom, rippleTrimStart, rippleTrimEnd, rippleShift, rippleDeleteClips,
  extractRange, trimStart, trimEnd, trimLimits, rollEdit, slideClip, slipClip, razorAt, splitClip, addTransition, clearRange,
  resolveSubtitleCues, moveClips, placeClips, findClip,
} from '../../shared/timeline';
import { resolveThreePointEdit } from '../../src/panels/source/threePoint';
import { trimRange, rollRange, slideRange } from '../../src/panels/timeline/interactions';
import { rulerTicks } from '../../src/panels/timeline/viewMath';
import { stripRulerTicks } from '../../src/panels/storyline/StoryStrip';
import { diffSequences } from '../../src/panels/compare/diff';
import { useStore, resetStore } from '../../src/state/store';
import { secondsToFrames } from '../../shared/time';

const FPS = { num: 24, den: 1 };
const INF = () => Infinity;
/** 'short' media is 1.5 s = 36 frames at 24 fps; everything else is unbounded. */
const SHORT = (id: string) => (id === 'short' ? 1.5 : Infinity);

function put(t: Track, start: number, duration: number, o: Partial<Clip> = {}): Clip {
  const c = makeClip({ mediaId: o.mediaId ?? 'm', name: 'c', sourceIn: o.sourceIn ?? 0, duration, kind: t.kind }, start);
  Object.assign(c, o); t.clips.push(c); sortTrack(t); return c;
}
const S = () => createSequence('S', FPS);

// ------------------------------------------------------------------
describe('F1 ripple shifts never push clips below frame 0', () => {
  it('rippleTrimStart of a clip at 0 leaves an unlinked clip on another track at 0 (its track is blocked)', () => {
    const s = S();
    const v = put(s.videoTracks[0], 0, 100);
    const after = put(s.videoTracks[0], 100, 50);
    const music = put(s.audioTracks[1], 0, 500);
    expect(rippleTrimStart(s, v.id, 10, INF)).toBe(10);
    expect(v).toMatchObject({ start: 0, duration: 90 });
    expect(after.start).toBe(90);
    expect(music.start).toBe(0);
  });

  it('a track whose first mover has room still ripples into the trimmed window; one that has not is blocked', () => {
    const s = S();
    const v = put(s.videoTracks[0], 5, 100);
    const a = put(s.audioTracks[0], 20, 20);  // starts inside the trimmed head: moves to 10 (in front of the edit point)
    const b = put(s.audioTracks[1], 7, 20);   // would land at -3: the whole track is blocked
    const b2 = put(s.audioTracks[1], 150, 20);
    expect(rippleTrimStart(s, v.id, 15, INF)).toBe(15);
    expect(v).toMatchObject({ start: 5, duration: 90 });
    expect(a.start).toBe(10);
    expect(b.start).toBe(7); expect(b2.start).toBe(150);
  });

  it('rippleShift blocks a track rather than moving its first clip below 0', () => {
    const s = S();
    const x = put(s.videoTracks[0], 3, 10);
    const y = put(s.audioTracks[0], 20, 10);
    expect(rippleShift(s, 0, -5)).toEqual([s.audioTracks[0].id]);
    expect(x.start).toBe(3); expect(y.start).toBe(15);
  });

  it('extractRange with an In before 0 does not move clips below 0', () => {
    const s = S();
    const x = put(s.videoTracks[0], 10, 10);
    extractRange(s, -20, 5);
    expect(x.start).toBeGreaterThanOrEqual(0);
  });

  it('ripple delete / ripple trim end keep every start >= 0', () => {
    const s = S();
    const a = put(s.videoTracks[0], 0, 10); const b = put(s.videoTracks[0], 10, 10); put(s.audioTracks[0], 12, 10);
    rippleDeleteClips(s, [a.id]);
    rippleTrimEnd(s, b.id, 3, INF);
    for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) expect(c.start).toBeGreaterThanOrEqual(0);
  });
});

// ------------------------------------------------------------------
describe('F2 extending an edge never pulls it back when the clip already overruns its media', () => {
  it('trimEnd outward keeps the end (and trimLimits.maxEnd is never before the current end)', () => {
    const s = S();
    const c = put(s.videoTracks[0], 0, 48, { mediaId: 'short' });
    expect(trimLimits(s, s.videoTracks[0], c, 1.5).maxEnd).toBe(48);
    expect(trimEnd(s, c.id, 49, SHORT)).toBe(48);
    expect(trimEnd(s, c.id, 49, SHORT, { ignoreNeighbors: true })).toBe(48);
    expect(c.duration).toBe(48);
    // shrinking still works
    expect(trimEnd(s, c.id, 30, SHORT)).toBe(30);
  });

  it('rippleTrimEnd outward keeps the end', () => {
    const s = S();
    const c = put(s.videoTracks[0], 0, 48, { mediaId: 'short' });
    const n = put(s.videoTracks[0], 48, 10);
    expect(rippleTrimEnd(s, c.id, 60, SHORT)).toBe(48);
    expect(c.duration).toBe(48); expect(n.start).toBe(48);
  });

  it('rippleTrimEnd leaves a linked clip on a locked track alone (like rippleTrimStart)', () => {
    const s = S();
    const v = put(s.videoTracks[0], 0, 100, { linkId: 'L' });
    const a = put(s.audioTracks[0], 0, 100, { linkId: 'L' });
    const n = put(s.audioTracks[0], 100, 50);
    s.audioTracks[0].locked = true;
    expect(rippleTrimEnd(s, v.id, 120, INF)).toBe(120);
    expect(v.duration).toBe(120);
    expect(a.duration).toBe(100); expect(n.start).toBe(100);
  });

  it('rollEdit right keeps the cut where it is', () => {
    const s = S();
    const a = put(s.videoTracks[0], 0, 48, { mediaId: 'short' });
    const b = put(s.videoTracks[0], 48, 48, { sourceIn: 10 });
    expect(rollEdit(s, a.id, b.id, 50, SHORT)).toBe(48);
    expect(a.duration).toBe(48); expect(b.start).toBe(48);
    // rolling left is still allowed
    expect(rollEdit(s, a.id, b.id, 40, SHORT)).toBe(40);
  });

  it('slideClip right does not move the clip left', () => {
    const s = S();
    const t = s.videoTracks[0];
    put(t, 0, 48, { mediaId: 'short' }); const c = put(t, 48, 24); put(t, 72, 48, { sourceIn: 10 });
    expect(slideClip(s, c.id, 5, SHORT)).toBe(0);
    expect(c.start).toBe(48);
    expect(slideClip(s, c.id, -5, SHORT)).toBe(-5);
  });

  it('the timeline drag ranges (interactions.ts) agree: never pull an extending edge back', () => {
    const s = S();
    const t = s.videoTracks[0];
    const a = put(t, 0, 48, { mediaId: 'short' }); const c = put(t, 48, 24); put(t, 72, 48, { sourceIn: 10 });
    const [, maxEnd] = trimRange(s, t, a, 'end', false, SHORT);
    expect(maxEnd).toBeGreaterThanOrEqual(48);
    const [, maxEndRipple] = trimRange(s, t, a, 'end', true, SHORT);
    expect(maxEndRipple).toBeGreaterThanOrEqual(48);
    const [rMin, rMax] = rollRange(s, a, c, SHORT);
    expect(rMin).toBeLessThanOrEqual(48); expect(rMax).toBeGreaterThanOrEqual(48);
    const [sMin, sMax] = slideRange(s, t, c, SHORT);
    expect(sMin).toBeLessThanOrEqual(0); expect(sMax).toBeGreaterThanOrEqual(0);
  });

  it('three-point whole-clip edits never exceed the media (floor, not round)', () => {
    // 1.53 s at 24 fps = 36.72 frames: rounding would give 37 frames = 1.5417 s > 1.53 s
    const r = resolveThreePointEdit({ fps: FPS, playhead: 0, seqIn: null, seqOut: null, srcIn: null, srcOut: null, mediaDuration: 1.53 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frames).toBe(maxDurationFrom(0, 1, 1.53, FPS));
    expect(r.frames).toBe(36);
    expect(r.inS + (r.frames / 24)).toBeLessThanOrEqual(1.53 + 1e-9);
    // the store turns (in, out) back into frames with secondsToFrames: it must land on the same count
    expect(secondsToFrames(r.outS - r.inS, FPS)).toBe(r.frames);
    // an explicit source In near the end
    const r2 = resolveThreePointEdit({ fps: FPS, playhead: 0, seqIn: null, seqOut: null, srcIn: 0.51, srcOut: null, mediaDuration: 1.53 });
    expect(r2.ok && r2.frames).toBe(maxDurationFrom(0.51, 1, 1.53, FPS));
    expect(r2.ok && secondsToFrames(r2.outS - r2.inS, FPS)).toBe(r2.ok && r2.frames);
  });

  it('three-point edits with a source Out inside the media keep rounding', () => {
    const r = resolveThreePointEdit({ fps: FPS, playhead: 0, seqIn: null, seqOut: null, srcIn: 0, srcOut: 1.03, mediaDuration: 100 });
    expect(r.ok && r.frames).toBe(25); // 24.72 frames rounds to 25, media has room
  });
});

// ------------------------------------------------------------------
describe('F3 split / razor reconciles transitions', () => {
  it('razor leaves no transition longer than the clip it belongs to', () => {
    const s = S();
    const t = s.videoTracks[0];
    put(t, 0, 48); put(t, 48, 48);
    const tr = addTransition(s, t.id, 48, 'crossDissolve', 40)!;
    razorAt(s, 46);
    const tail = t.clips.find((c) => c.start === 46)!;
    expect(tr.outClipId).toBe(tail.id);
    expect(t.transitions[0].duration).toBeLessThanOrEqual(tail.duration);
    expect(t.transitions[0].duration).toBe(2);
  });

  it('splitClip on the in-side of a transition shortens it to the head', () => {
    const s = S();
    const t = s.videoTracks[0];
    put(t, 0, 48); const b = put(t, 48, 48);
    addTransition(s, t.id, 48, 'crossDissolve', 40);
    splitClip(s, t, b, 50);
    expect(t.transitions[0].duration).toBe(2);
  });

  it('the store razor commit leaves a consistent transition', () => {
    resetStore();
    const st = useStore.getState();
    const seq = createSequence('R', FPS); st.addSequence(seq);
    const t = useStore.getState().project.sequences[seq.id].videoTracks[0];
    useStore.setState((x) => {
      const s2 = structuredClone(x.project.sequences[seq.id]);
      const tt = s2.videoTracks[0];
      put(tt, 0, 48); put(tt, 48, 48);
      addTransition(s2, tt.id, 48, 'crossDissolve', 40);
      return { project: { ...x.project, sequences: { ...x.project.sequences, [seq.id]: s2 } } };
    });
    useStore.getState().razor(seq.id, 46);
    const tt = useStore.getState().project.sequences[seq.id].videoTracks.find((x) => x.id === t.id)!;
    const byId = new Map(tt.clips.map((c) => [c.id, c]));
    for (const tr of tt.transitions) {
      if (tr.outClipId) expect(tr.duration).toBeLessThanOrEqual(byId.get(tr.outClipId)!.duration);
      if (tr.inClipId) expect(tr.duration).toBeLessThanOrEqual(byId.get(tr.inClipId)!.duration);
    }
  });
});

// ------------------------------------------------------------------
describe('F4 subtitle cues never land before 0', () => {
  it('resolveSubtitleCues clamps an unattached cue at 0 and drops one that ends at or before 0', () => {
    const s = S();
    s.subtitleTracks.push({ id: 'st', name: 'S', language: 'en', enabled: true, cues: [
      { id: 'q', start: 0, duration: 48, offset: -12, text: 'hi' },
      { id: 'gone', start: 10, duration: 5, offset: -20, text: 'x' },
      { id: 'edge', start: 10, duration: 5, offset: -15, text: 'y' },
    ] });
    const r = resolveSubtitleCues(s);
    expect(r.map((c) => [c.id, c.start, c.end])).toEqual([['q', 0, 36]]);
  });

  it('updateCue clamps the offset so the cue starts at >= 0 (unattached and attached)', () => {
    resetStore();
    const st = useStore.getState();
    const seq = createSequence('C', FPS); st.addSequence(seq);
    const trackId = useStore.getState().addSequenceSubtitleTrack(seq.id)!;
    const cueId = useStore.getState().addManualCue(seq.id, trackId, { start: 24, duration: 24, text: 'a' })!;
    useStore.getState().updateCue(seq.id, cueId, { offset: -100 });
    const cue = () => useStore.getState().project.sequences[seq.id].subtitleTracks[0].cues.find((c) => c.id === cueId)!;
    expect(cue().offset).toBe(-24);
    useStore.getState().updateCue(seq.id, cueId, { offset: 7 });
    expect(cue().offset).toBe(7);
    useStore.getState().updateCue(seq.id, cueId, { offset: Number.NaN });
    expect(cue().offset).toBe(7);
    // attached cue: clip at frame 10, cue 1 s into the clip -> base start 34; offset may not go below -34
    useStore.setState((x) => {
      const s2 = structuredClone(x.project.sequences[seq.id]);
      const clip = put(s2.videoTracks[0], 10, 100, { id: 'clipX' });
      s2.subtitleTracks[0].cues.push({ id: 'att', clipId: clip.id, srcStart: 1, srcEnd: 2, start: 0, duration: 24, offset: 0, text: 'b' });
      return { project: { ...x.project, sequences: { ...x.project.sequences, [seq.id]: s2 } } };
    });
    useStore.getState().updateCue(seq.id, 'att', { offset: -1000 });
    expect(useStore.getState().project.sequences[seq.id].subtitleTracks[0].cues.find((c) => c.id === 'att')!.offset).toBe(-34);
  });
});

// ------------------------------------------------------------------
describe('F7 compare diff: head/tail deltas round symmetrically and never -0', () => {
  function seqWith(sourceIn: number, duration: number) {
    const s = S();
    const c = makeClip({ mediaId: 'm1', name: 'm1', sourceIn, duration, kind: 'video' }, 0);
    s.videoTracks[0].clips.push(c);
    return s;
  }
  it('a B clip starting 2.5 frames earlier in the source reports -3 (mirror of +3)', () => {
    const later = diffSequences(seqWith(10, 48), seqWith(10 + 2.5 / 24, 48));
    const earlier = diffSequences(seqWith(10, 48), seqWith(10 - 2.5 / 24, 48));
    expect(later.a[0].headDelta).toBe(3);
    expect(earlier.a[0].headDelta).toBe(-3);
    expect(earlier.a[0].tailDelta).toBe(-3);
  });
  it('a sub-frame negative delta is +0, not -0', () => {
    const r = diffSequences(seqWith(10, 48), seqWith(10 - 0.4 / 24, 48));
    expect(r.a[0].kind).toBe('trimmed');
    expect(Object.is(r.a[0].headDelta, 0)).toBe(true);
    expect(Object.is(r.a[0].tailDelta, 0)).toBe(true);
  });
});

// ------------------------------------------------------------------
describe('F8 clearRange computes the tail sourceIn without injected fps', () => {
  it('uses the fps argument', () => {
    const s = S();
    const t = s.videoTracks[0];
    put(t, 0, 48, { sourceIn: 1 });
    clearRange(t, 12, 24, FPS);
    const tail = t.clips.find((c) => c.start === 24)!;
    expect(tail.sourceIn).toBeCloseTo(2, 12);
  });
});

// ------------------------------------------------------------------
describe('B3 trims never produce a duration below MIN_CLIP_FRAMES, even on overlapping (unrepaired) tracks', () => {
  function overlapping() {
    const s = S();
    const t = s.videoTracks[0];
    const a = put(t, 0, 100, { id: 'A' }); const b = put(t, 50, 10, { id: 'B' });
    return { s, t, a, b };
  }
  it('trimStart inward on a clip that overlaps its predecessor', () => {
    const { s, b } = overlapping();
    const applied = trimStart(s, b.id, 55, () => 1000);
    expect(b.duration).toBeGreaterThanOrEqual(1);
    expect(applied).toBe(55);
    expect(b).toMatchObject({ start: 55, duration: 5 });
  });
  it('trimEnd outward on a clip overlapped by its successor', () => {
    const { s, a } = overlapping();
    trimEnd(s, a.id, 120, () => 1000);
    expect(a.duration).toBeGreaterThanOrEqual(1);
    expect(clipEnd(a)).toBeGreaterThanOrEqual(100);
  });
  it('trimStart outward never moves the start later than it is', () => {
    const { s, b } = overlapping();
    trimStart(s, b.id, 40, () => 1000);
    expect(b.start).toBeLessThanOrEqual(50);
    expect(b.duration).toBeGreaterThanOrEqual(10);
  });
});

// ------------------------------------------------------------------
describe('B10 very large selections do not overflow the call stack', () => {
  const N = 130_000;
  // moveClips / placeClips are quadratic in the number of clips moved (each destination is cleared), so
  // only the linear ripple paths are exercised at this size; their spreads were replaced by loops as well.
  it('rippleShift, ripple delete and ripple trim on a 130k-clip track', () => {
    const s = S();
    const t = s.videoTracks[0];
    const clips: Clip[] = [];
    for (let i = 0; i < N; i++) clips.push(makeClip({ mediaId: 'm', name: 'c', sourceIn: 0, duration: 1, kind: 'video' }, 10 + i));
    t.clips = clips;
    expect(() => rippleShift(s, 5, -2)).not.toThrow();
    expect(t.clips[0].start).toBe(8);
    expect(t.clips[N - 1].start).toBe(8 + N - 1);
    expect(() => rippleDeleteClips(s, [clips[0].id])).not.toThrow();
    expect(t.clips[0].start).toBe(8);
    expect(() => rippleTrimStart(s, t.clips[0].id, 5, INF)).not.toThrow();
  });
  it('moveClips / placeClips still work after replacing the spreads', () => {
    const s = S();
    const t = s.videoTracks[0];
    const a = put(t, 10, 5); const b = put(t, 20, 5);
    expect(moveClips(s, [{ clipId: a.id, toTrackId: t.id, toStart: -3 }, { clipId: b.id, toTrackId: t.id, toStart: 7 }], 'overwrite')).toBe(true);
    expect([findClip(s, a.id)!.clip.start, findClip(s, b.id)!.clip.start]).toEqual([0, 10]);
    const p1 = makeClip({ mediaId: 'm', name: 'p', sourceIn: 0, duration: 4, kind: 'video' }, 2);
    const p2 = makeClip({ mediaId: 'm', name: 'p', sourceIn: 0, duration: 6, kind: 'audio' }, 2);
    expect(placeClips(s, [{ trackId: t.id, clip: p1 }, { trackId: s.audioTracks[0].id, clip: p2 }], 'insert')).toBe(true);
    expect(findClip(s, b.id)!.clip.start).toBe(16); // rippled by the longest placement (6)
  });
});

// ------------------------------------------------------------------
describe('B1 rulers terminate at huge scroll positions', () => {
  it('rulerTicks at scroll 1e17 returns promptly with a bounded tick count', () => {
    const t0 = Date.now();
    const ticks = rulerTicks(FPS, 4, 1e17, 800);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ticks.length).toBeLessThan(1000);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].frame).toBeGreaterThan(ticks[i - 1].frame);
  });
  it('rulerTicks with a degenerate zoom returns nothing', () => {
    expect(rulerTicks(FPS, 0, 0, 800)).toEqual([]);
    expect(rulerTicks(FPS, -1, 0, 800)).toEqual([]);
    expect(rulerTicks(FPS, Number.NaN, 0, 800)).toEqual([]);
  });
  it('story strip ruler ticks are bounded for a 1e17-frame sequence', () => {
    const extent = 1e17;
    const width = 1000;
    const ppf = (width / extent) * 64;
    const t0 = Date.now();
    const ticks = stripRulerTicks(ppf, 24, extent, FPS);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(20_000);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].frame).toBeGreaterThan(ticks[i - 1].frame);
  });
  it('story strip ruler ticks for a normal sequence are unchanged in shape', () => {
    const ticks = stripRulerTicks(1, 24, 24 * 60, FPS); // 1 px per frame, one minute
    expect(ticks[0]).toMatchObject({ frame: 0, major: true });
    expect(ticks.filter((t) => t.major).map((t) => t.frame).slice(0, 3)).toEqual([0, 120, 240]); // 5 s majors
    expect(ticks.filter((t) => !t.major).map((t) => t.frame).slice(0, 2)).toEqual([24, 48]); // 1 s minors
  });
});

// ------------------------------------------------------------------
describe('setClipSpeed never stretches a clip past its media end (rounding)', () => {
  let media: MediaItem;
  beforeEach(() => {
    resetStore();
    const m = createMediaItem('/media/short.mkv', 'short.mkv');
    media = { ...m, kind: 'video', probe: {
      container: 'matroska', duration: 1.5, size: 1, startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false }, audio: [], subtitles: [],
    } };
    useStore.getState().addMedia([media]);
  });
  for (const ripple of [false, true]) {
    it(`speed 0.35 on a whole-media clip (ripple ${ripple})`, () => {
      const seq = createSequence('Sp', FPS); useStore.getState().addSequence(seq);
      const [vid] = useStore.getState().insertFromSource(seq.id, { mediaId: media.id, in: 0, out: 1.5, atFrame: 0, mode: 'insert' });
      useStore.getState().setClipSpeed(seq.id, vid, 0.35, { ripple });
      const c = findClip(useStore.getState().project.sequences[seq.id], vid)!.clip;
      // 36 frames / 0.35 = 102.86 frames: round would give 103 (past the media), floor gives 102
      expect(c.duration).toBe(102);
      expect(clipSourceOut(c, FPS)).toBeLessThanOrEqual(1.5 + 1e-9);
    });
  }
  it('keeps plain rounding when the media has room', () => {
    const seq = createSequence('Sp2', FPS); useStore.getState().addSequence(seq);
    const [vid] = useStore.getState().insertFromSource(seq.id, { mediaId: media.id, in: 0, out: 0.5, atFrame: 0, mode: 'insert' });
    useStore.getState().setClipSpeed(seq.id, vid, 0.35);
    // 12 / 0.35 = 34.29 -> 34
    expect(findClip(useStore.getState().project.sequences[seq.id], vid)!.clip.duration).toBe(34);
  });
});

// keep slipClip import used: its guard is the reference behaviour for F2
describe('slipClip reference guard', () => {
  it('found by the fuzz: slipping a clip does not slip its linked partner on a locked track', () => {
    const s = S();
    const v = put(s.videoTracks[0], 0, 48, { linkId: 'L', sourceIn: 5 });
    const a = put(s.audioTracks[0], 0, 48, { linkId: 'L', sourceIn: 5 });
    s.audioTracks[0].locked = true;
    expect(slipClip(s, v.id, 24, INF)).toBe(24);
    expect(v.sourceIn).toBe(6);
    expect(a.sourceIn).toBe(5);
  });

  it('a clip longer than its media cannot slip later, but never backwards', () => {
    const s = S();
    const c = put(s.videoTracks[0], 0, 48, { mediaId: 'short', sourceIn: 0.5 });
    expect(slipClip(s, c.id, 5, SHORT)).toBe(0);
  });
});

export type { Sequence };
