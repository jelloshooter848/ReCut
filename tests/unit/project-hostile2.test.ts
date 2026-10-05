/**
 * Critic round B: hostile project data that survived normalizeProject (B1, B3-B10) and the repair report (B2).
 *
 * Contract added here:
 *  - every timeline position / duration (frames) is a safe integer in 0..MAX_TIMELINE_FRAMES after load;
 *    fractional values are rounded (clip ends are rounded, so touching clips keep touching);
 *  - clips on one track never overlap after load: a clip overlapping the previous one has its head trimmed when
 *    at least one frame of it remains, otherwise it is moved (unchanged) to a new track of the same kind;
 *  - unknown values nested deeper than MAX_PROJECT_DEPTH are dropped (JSON.stringify / structuredClone work);
 *  - speed is clamped to the UI range, settings to their UI ranges;
 *  - mediaIds that only resolve through Object.prototype are treated as missing media;
 *  - duplicate ids are re-issued (first occurrence keeps its id);
 *  - normalizeProjectWithReport lists what it repaired; valid data reports nothing.
 */
import { describe, it, expect } from 'vitest';
import { createProject, normalizeProject, normalizeProjectWithReport, ProjectIncompatibleError } from '../../shared/project';
import { MAX_TIMELINE_FRAMES, MAX_PROJECT_DEPTH, MAX_SOURCE_SECONDS } from '../../shared/limits';
import { SPEED_PERCENT_MAX, SPEED_PERCENT_MIN } from '../../shared/timeline';
import * as TL from '../../shared/timeline';
import type { Clip, Sequence } from '../../shared/model';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const rt = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const clip = (id: string, start: number, duration: number, extra: Any = {}) => ({ id, mediaId: 'm1', name: id, start, duration, sourceIn: 0, speed: 1, ...extra });

function base() {
  const p = rt(createProject('H')) as Any;
  p.media.m1 = { id: 'm1', name: 'M', path: '/tmp/x.mp4', kind: 'video' };
  const sid: string = p.activeSequenceId;
  return { p, sid, seq: p.sequences[sid] };
}
const seqOf = (n: Any): Sequence => n.sequences[n.activeSequenceId];
const isFrame = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TIMELINE_FRAMES;

/** Every frame-valued field of a sequence (and its snapshots) is a safe integer in range. */
function expectFramesInRange(s: Sequence): void {
  for (const t of [...s.videoTracks, ...s.audioTracks]) {
    for (const c of t.clips) {
      expect(isFrame(c.start), `clip ${c.id} start ${c.start}`).toBe(true);
      expect(isFrame(c.duration) && c.duration >= 1, `clip ${c.id} duration ${c.duration}`).toBe(true);
      expect(c.start + c.duration <= MAX_TIMELINE_FRAMES, `clip ${c.id} end`).toBe(true);
    }
    for (const tr of t.transitions) expect(isFrame(tr.duration), `transition ${tr.id}`).toBe(true);
  }
  for (const m of s.markers) { expect(isFrame(m.time), `marker ${m.time}`).toBe(true); expect(isFrame(m.duration)).toBe(true); expect(m.time + m.duration <= MAX_TIMELINE_FRAMES).toBe(true); }
  for (const b of s.storyBlocks) { expect(isFrame(b.start) && isFrame(b.end) && b.start <= b.end, `block ${b.start}-${b.end}`).toBe(true); }
  for (const st of s.subtitleTracks) for (const c of st.cues) {
    expect(isFrame(c.start) && isFrame(c.duration), `cue ${c.id} ${c.start}+${c.duration}`).toBe(true);
    expect(Number.isSafeInteger(c.offset) && Math.abs(c.offset) <= MAX_TIMELINE_FRAMES, `cue offset ${c.offset}`).toBe(true);
  }
  const v = s.view;
  expect(isFrame(v.playhead), `playhead ${v.playhead}`).toBe(true);
  expect(Number.isFinite(v.scroll) && v.scroll >= 0 && v.scroll <= MAX_TIMELINE_FRAMES, `scroll ${v.scroll}`).toBe(true);
  for (const x of [v.inPoint, v.outPoint]) expect(x === null || isFrame(x), `in/out ${x}`).toBe(true);
  for (const sn of s.snapshots) expectFramesInRange({ ...sn.data, snapshots: [] } as Sequence);
}

describe('B1: huge timeline positions are repaired on load', () => {
  it('view playhead / scroll / in / out 1e17 and absurd zoom', () => {
    const { p, sid, seq } = base();
    seq.view = { playhead: 1e17, scroll: 1e17, zoom: 1e300, inPoint: 1e17, outPoint: 1e13 };
    const s = normalizeProject(p).sequences[sid];
    expect(s.view).toMatchObject({ playhead: 0, scroll: 0, inPoint: null, outPoint: null });
    expect(s.view.zoom).toBeLessThanOrEqual(50);
    seq.view = { playhead: 1e17, scroll: 0, zoom: 1e-300, inPoint: null, outPoint: null };
    expect(normalizeProject(p).sequences[sid].view.zoom).toBeGreaterThanOrEqual(1e-4);
    expectFramesInRange(normalizeProject(p).sequences[sid]);
  });

  it('clips placed beyond MAX_TIMELINE_FRAMES are dropped; a clip running past it is shortened', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('ok', 0, 24), clip('far', 1e17, 24), clip('safeFar', 1e15, 24), clip('maxStart', MAX_TIMELINE_FRAMES, 24),
      clip('long', MAX_TIMELINE_FRAMES - 10, 1e15), clip('hugeDur', 100, 1e308)];
    const s = normalizeProject(p).sequences[sid];
    const byId = Object.fromEntries(s.videoTracks.flatMap((t) => t.clips).map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(['hugeDur', 'long', 'ok']);
    expect(byId.long).toMatchObject({ start: MAX_TIMELINE_FRAMES - 10, duration: 10 });
    expect(byId.hugeDur.start + byId.hugeDur.duration).toBe(MAX_TIMELINE_FRAMES);
    expectFramesInRange(s);
  });

  it('markers, story blocks and free cues far out are dropped or clamped; the result is always in range', () => {
    const { p, sid, seq } = base();
    seq.markers = [{ time: 1e13 }, { id: 'ok', time: 5, duration: 1e13 }, { time: 2.6, duration: 0.4 }];
    seq.storyBlocks = [{ start: 1e13, end: 1e13 + 5 }, { id: 'sb', start: 10, end: 1e13 }, { start: 1.4, end: 7.6 }];
    seq.subtitleTracks = [{ id: 'st', name: 's', language: 'en', enabled: true, cues: [
      { id: 'far', start: 1e13, duration: 10, offset: 0, text: 'far' },
      { id: 'long', start: 10, duration: 1e308, offset: 0, text: 'long' },
      { id: 'att', clipId: 'c', srcStart: 1, srcEnd: 2, start: 1e17, duration: -5, offset: 1e17, text: 'attached' },
    ] }];
    const s = normalizeProject(p).sequences[sid];
    expect(s.markers.map((m) => [m.time, m.duration])).toEqual([[5, MAX_TIMELINE_FRAMES - 5], [3, 0]]);
    expect(s.storyBlocks.map((b) => [b.start, b.end])).toEqual([[10, MAX_TIMELINE_FRAMES], [1, 8]]);
    const cues = s.subtitleTracks[0].cues;
    expect(cues.map((c) => c.id)).toEqual(['long', 'att']);
    expect(cues[0]).toMatchObject({ start: 10, duration: MAX_TIMELINE_FRAMES - 10 });
    expect(cues[1]).toMatchObject({ start: 0, duration: 0, offset: 0, clipId: 'c' });
    expectFramesInRange(s);
  });

  it('snapshot data is bounded like its sequence', () => {
    const { p, sid, seq } = base();
    const data: Any = rt(seq); delete data.snapshots;
    data.view = { playhead: 1e17, scroll: 1e17, zoom: 4, inPoint: null, outPoint: null };
    data.videoTracks = [{ clips: [clip('x', 1e17, 5), clip('y', 0.5, 3.25)] }];
    seq.snapshots = [{ id: 'sn', name: 'n', createdAt: 1, data }];
    const s = normalizeProject(p).sequences[sid];
    expect(s.snapshots[0].data.videoTracks[0].clips.map((c) => c.id)).toEqual(['y']);
    expectFramesInRange(s);
  });

  it('source positions in seconds beyond MAX_SOURCE_SECONDS: clips / scenes / detected scenes dropped', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('ok', 0, 10, { sourceIn: 5.5 }), clip('far', 10, 10, { sourceIn: 1e21 })];
    p.scenes = { ok: { name: 'ok', mediaId: 'm1', in: 1, out: 2 }, far: { name: 'far', mediaId: 'm1', in: 1, out: 1e21 } };
    p.media.m1.detectedScenes = [{ id: 'd1', start: 0, end: 1 }, { id: 'd2', start: MAX_SOURCE_SECONDS + 1, end: 1e300 }];
    const n = normalizeProject(p);
    expect(n.sequences[sid].videoTracks[0].clips.map((c) => c.id)).toEqual(['ok']);
    expect(n.sequences[sid].videoTracks[0].clips[0].sourceIn).toBe(5.5);
    expect(Object.keys(n.scenes)).toEqual(['ok']);
    expect(n.media.m1.detectedScenes.map((d) => d.id)).toEqual(['d1']);
  });
});

describe('B6: fractional frame positions are rounded', () => {
  it('a fractional clip becomes whole frames', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('a', 0.5, 10.25)];
    const c = normalizeProject(p).sequences[sid].videoTracks[0].clips[0];
    expect([c.start, c.duration]).toEqual([1, 10]); // start round(0.5)=1, end round(10.75)=11
  });

  it('200 back-to-back fractional clips stay back-to-back on one track, all kept', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = Array.from({ length: 200 }, (_, i) => clip('c' + i, i * 9.75 + 0.5, 9.75));
    const s = normalizeProject(p).sequences[sid];
    const clips = s.videoTracks[0].clips;
    expect(clips).toHaveLength(200);
    expect(s.videoTracks).toHaveLength(3);
    for (let i = 1; i < clips.length; i++) expect(clips[i].start).toBe(clips[i - 1].start + clips[i - 1].duration);
    expectFramesInRange(s);
  });

  it('a clip of at least one (fractional) frame keeps at least one whole frame', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('a', 3.2, 1.1)]; // 3 .. round(4.3)=4 -> 1 frame
    seq.videoTracks[1].clips = [clip('b', 3.6, 1.3)]; // 4 .. round(4.9)=5 -> 1 frame
    const s = normalizeProject(p).sequences[sid];
    expect(s.videoTracks[0].clips.map((c) => [c.start, c.duration])).toEqual([[3, 1]]);
    expect(s.videoTracks[1].clips.map((c) => [c.start, c.duration])).toEqual([[4, 1]]);
  });

  it('transition durations are rounded', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('a', 0, 20), clip('b', 20, 20)];
    seq.videoTracks[0].transitions = [{ id: 't', type: 'crossDissolve', duration: 6.6, outClipId: 'a', inClipId: 'b' }];
    expect(normalizeProject(p).sequences[sid].videoTracks[0].transitions[0].duration).toBe(7);
  });
});

describe('B3: overlapping clips on one track are resolved on load', () => {
  it('partly overlapping: the later clip loses its overlapping head (sourceIn follows)', () => {
    const { p, sid, seq } = base();
    seq.fps = { num: 25, den: 1 };
    seq.videoTracks[0].clips = [clip('A', 0, 100), clip('B', 50, 100, { sourceIn: 2, speed: 2 })];
    const s = normalizeProject(p).sequences[sid];
    const [a, b] = s.videoTracks[0].clips;
    expect([a.id, a.start, a.duration]).toEqual(['A', 0, 100]);
    expect([b.id, b.start, b.duration]).toEqual(['B', 100, 50]);
    expect(b.sourceIn).toBeCloseTo(2 + 50 / 25 * 2, 9); // 50 frames at 25 fps, speed 2
    expect(s.videoTracks).toHaveLength(3);
  });

  it('fully covered: the clip moves unchanged to a new track of the same kind', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('A', 0, 100), clip('B', 50, 10), clip('C', 55, 10)];
    seq.audioTracks[1].clips = [clip('X', 0, 10, { kind: 'audio' }), clip('Y', 0, 10, { kind: 'audio' })];
    const s = normalizeProject(p).sequences[sid];
    expect(s.videoTracks.map((t) => t.clips.map((c) => `${c.id}@${c.start}+${c.duration}`))).toEqual([['A@0+100'], [], [], ['B@50+10'], ['C@55+10']]);
    expect(s.videoTracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5']);
    expect(s.audioTracks.map((t) => t.clips.map((c) => c.id))).toEqual([[], ['X'], [], ['Y']]);
    expect(s.audioTracks[3].kind).toBe('audio');
    // second B / C pair: C overlaps B on the overflow track -> C goes one further (B at 50..60, C at 55..65)
  });

  it('after the repair, trimStart never yields a negative duration and a reload keeps every clip', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('A', 0, 100), clip('B', 50, 10)];
    const n = normalizeProject(p);
    const s = n.sequences[sid];
    TL.trimStart(s, 'B', 55, () => 1000);
    const B = TL.findClip(s, 'B')!.clip;
    expect(B.duration).toBeGreaterThanOrEqual(1);
    const again = normalizeProject(rt(n)).sequences[sid];
    expect(TL.allTracks(again).flatMap((t) => t.clips.map((c) => c.id)).sort()).toEqual(['A', 'B']);
  });

  it('touching clips (end == next start) are not overlaps', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('A', 0, 10), clip('B', 10, 10), clip('C', 20, 10)];
    const r = normalizeProjectWithReport(p);
    expect(r.project.sequences[sid].videoTracks[0].clips.map((c) => c.id)).toEqual(['A', 'B', 'C']);
    expect(r.repairs).toEqual([]);
  });
});

describe('B4: values nested deeper than MAX_PROJECT_DEPTH are cut off', () => {
  const deep = (depth: number) => JSON.parse('['.repeat(depth) + ']'.repeat(depth));

  it('depth 6000 under an unknown top-level key / clip / probe field: structuredClone and JSON.stringify work', () => {
    const { p, sid, seq } = base();
    // built as text: JSON.stringify of the deep value itself would overflow
    seq.videoTracks[0].clips = [clip('a', 0, 10, { extra: '__DEEP__' })];
    p.media.m1.probe = { container: 'mp4', duration: 1, size: 1, startTime: 0, browserPlayable: true, audio: [{ index: 1, x: '__DEEP__' }], subtitles: [] };
    p.extra = '__DEEP__';
    const deepText = '['.repeat(6000) + ']'.repeat(6000);
    const text = JSON.stringify(p).replaceAll('"__DEEP__"', deepText);
    const r = normalizeProjectWithReport(JSON.parse(text));
    const n = r.project as Any;
    expect(() => structuredClone(n)).not.toThrow();
    expect(() => JSON.stringify(n)).not.toThrow();
    // the unknown values are cut off below MAX_PROJECT_DEPTH; everything known is intact
    expect(depthOf(n)).toBeLessThanOrEqual(MAX_PROJECT_DEPTH);
    expect(depthOf(n.extra)).toBe(MAX_PROJECT_DEPTH - 1); // root (1) > extra (2) > ... > depth MAX_PROJECT_DEPTH
    expect(n.sequences[sid].videoTracks[0].clips[0]).toMatchObject({ id: 'a', start: 0, duration: 10 });
    expect(n.media.m1.probe.audio[0].index).toBe(1);
    expect(r.repairs.join('\n')).toMatch(/nested/);
    expect(r.repairs.join('\n')).toMatch(/\(3x\)/); // three deep values cut
  });

  /** Nesting depth of a value (a scalar is 0, [] is 1); iterative, so it works on any input. */
  function depthOf(root: unknown): number {
    let max = 0;
    const stack: [unknown, number][] = [[root, 1]];
    while (stack.length) {
      const [v, d] = stack.pop()!;
      if (!v || typeof v !== 'object') continue;
      max = Math.max(max, d);
      for (const x of Object.values(v)) stack.push([x, d + 1]);
    }
    return max;
  }

  it('unknown values nested within MAX_PROJECT_DEPTH are kept', () => {
    const { p } = base();
    p.future = { a: { b: [1, { c: 'kept' }] } };
    p.alsoDeep = deep(MAX_PROJECT_DEPTH - 2); // root (1) > alsoDeep array (2) > ... still within the limit
    const r = normalizeProjectWithReport(p);
    expect((r.project as Any).future).toEqual({ a: { b: [1, { c: 'kept' }] } });
    expect((r.project as Any).alsoDeep).toEqual(deep(MAX_PROJECT_DEPTH - 2));
    expect(r.repairs).toEqual([]);
  });
});

describe('B5: speed is clamped to the UI range', () => {
  it('1e308 -> max, 1e-300 -> min, valid kept', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('fast', 0, 10, { speed: 1e308 }), clip('slow', 10, 10, { speed: 1e-300 }), clip('ok', 20, 10, { speed: 2.5 })];
    const clips = normalizeProject(p).sequences[sid].videoTracks[0].clips;
    expect(clips.map((c) => c.speed)).toEqual([SPEED_PERCENT_MAX / 100, SPEED_PERCENT_MIN / 100, 2.5]);
  });
});

describe('B7: mediaIds that only resolve through Object.prototype are missing media', () => {
  for (const mid of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    it(mid, () => {
      const { p, sid, seq } = base();
      seq.videoTracks[0].clips = [clip('a', 0, 24, { mediaId: mid })];
      seq.audioTracks[0].clips = [clip('b', 0, 24, { mediaId: mid, kind: 'audio' })];
      p.scenes = { s: { name: 's', mediaId: mid, in: 0, out: 1 } };
      p.subtitleTracks = { t: { name: 't', mediaId: mid, cues: [] } };
      const n = normalizeProject(p);
      const s = n.sequences[sid];
      for (const c of [s.videoTracks[0].clips[0], s.audioTracks[0].clips[0]]) {
        expect(Object.hasOwn(n.media, c.mediaId)).toBe(false);
        expect((n.media as Any)[c.mediaId]).toBeUndefined();
      }
      expect((n.media as Any)[n.scenes.s.mediaId]).toBeUndefined();
      expect(n.subtitleTracks.t.mediaId).toBeNull();
    });
  }

  it('an unknown (deleted) media id is kept as is; an own media key is resolved normally', () => {
    const { p, sid, seq } = base();
    p.media.constructor = { name: 'C', path: '/c.mkv' };
    seq.videoTracks[0].clips = [clip('a', 0, 24, { mediaId: 'med-gone' }), clip('b', 24, 24, { mediaId: 'constructor' })];
    const n = normalizeProject(p);
    expect(n.sequences[sid].videoTracks[0].clips.map((c) => c.mediaId)).toEqual(['med-gone', 'constructor']);
    expect((n.media as Any).constructor.path).toBe('/c.mkv');
  });
});

describe('B8: bin cycle repair is linear', () => {
  it('a 100k bin chain normalizes in well under a second', () => {
    const p = rt(createProject('x')) as Any;
    p.bins = {};
    const N = 100_000;
    for (let i = 0; i < N; i++) p.bins['b' + i] = { name: 'b', parentId: i ? 'b' + (i - 1) : null };
    p.bins.b0.parentId = 'b' + (N - 1); // and close it into one big cycle
    const t0 = performance.now();
    const n = normalizeProject(p);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(Object.values(n.bins).filter((b) => b.parentId === null)).toHaveLength(1);
  });

  it('cuts the same edge as before: the one closing the cycle on the walk from the first bin', () => {
    const p = rt(createProject('x')) as Any;
    p.bins = { a: { name: 'a', parentId: 'b' }, b: { name: 'b', parentId: 'c' }, c: { name: 'c', parentId: 'a' }, d: { name: 'd', parentId: 'c' }, e: { name: 'e', parentId: 'e' } };
    const n = normalizeProject(p);
    expect(Object.fromEntries(Object.values(n.bins).map((b) => [b.id, b.parentId]))).toEqual({ a: 'b', b: 'c', c: null, d: 'c', e: null });
  });
});

describe('B9: duplicate ids are re-issued (first occurrence keeps its id)', () => {
  const allClips = (s: Sequence): Clip[] => TL.allTracks(s).flatMap((t) => t.clips);

  it('clip ids across tracks; transitions on the renamed clip\'s track follow it', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('X', 0, 100)];
    seq.videoTracks[1].clips = [clip('X', 200, 50), clip('Y', 250, 50)];
    seq.videoTracks[1].transitions = [{ id: 't', type: 'crossDissolve', duration: 10, outClipId: 'X', inClipId: 'Y' }];
    const s = normalizeProject(p).sequences[sid];
    const ids = allClips(s).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.videoTracks[0].clips[0].id).toBe('X');
    const renamed = s.videoTracks[1].clips[0];
    expect(renamed.id).not.toBe('X');
    expect(s.videoTracks[1].transitions).toEqual([{ id: 't', type: 'crossDissolve', duration: 10, outClipId: renamed.id, inClipId: 'Y' }]);
    TL.removeClips(s, ['X']);
    expect(allClips(s).map((c) => c.start)).toEqual([200, 250]);
  });

  it('duplicate clip ids on one track: a transition between them is kept, pointing at the right clips', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[0].clips = [clip('X', 0, 100), clip('X', 100, 50)];
    seq.videoTracks[0].transitions = [{ id: 't', type: 'crossDissolve', duration: 10, outClipId: 'X', inClipId: 'X' }];
    const tr = normalizeProject(p).sequences[sid].videoTracks[0];
    expect(tr.clips[0].id).toBe('X');
    expect(tr.clips[1].id).not.toBe('X');
    expect(tr.transitions).toEqual([{ id: 't', type: 'crossDissolve', duration: 10, outClipId: 'X', inClipId: tr.clips[1].id }]);
  });

  it('track ids (also across video / audio), transition, marker, story block, subtitle track and cue ids', () => {
    const { p, sid, seq } = base();
    seq.videoTracks[1].id = seq.videoTracks[0].id;
    seq.audioTracks[0].id = seq.videoTracks[0].id;
    seq.videoTracks[0].clips = [clip('a', 0, 10), clip('b', 10, 10), clip('c', 20, 10)];
    seq.videoTracks[0].transitions = [
      { id: 'T', type: 'crossDissolve', duration: 4, outClipId: 'a', inClipId: 'b' },
      { id: 'T', type: 'crossDissolve', duration: 4, outClipId: 'b', inClipId: 'c' },
    ];
    seq.markers = [{ id: 'M', time: 1 }, { id: 'M', time: 2 }];
    seq.storyBlocks = [{ id: 'B', start: 0, end: 5 }, { id: 'B', start: 5, end: 9 }];
    seq.subtitleTracks = [
      { id: 'S', name: 'a', cues: [{ id: 'Q', start: 0, duration: 5, offset: 0, text: 'a' }, { id: 'Q', start: 5, duration: 5, offset: 0, text: 'b' }] },
      { id: 'S', name: 'b', cues: [{ id: 'Q', start: 9, duration: 5, offset: 0, text: 'c' }] },
    ];
    const r = normalizeProjectWithReport(p);
    const s = r.project.sequences[sid];
    const uniq = (xs: string[]) => expect(new Set(xs).size, xs.join(',')).toBe(xs.length);
    uniq(TL.allTracks(s).map((t) => t.id));
    expect(s.videoTracks[0].id).toBe(seq.videoTracks[0].id);
    uniq(s.videoTracks[0].transitions.map((t) => t.id));
    expect(s.videoTracks[0].transitions).toHaveLength(2);
    uniq(s.markers.map((m) => m.id)); expect(s.markers[0].id).toBe('M');
    uniq(s.storyBlocks.map((b) => b.id)); expect(s.storyBlocks[0].id).toBe('B');
    uniq(s.subtitleTracks.map((t) => t.id)); expect(s.subtitleTracks[0].id).toBe('S');
    uniq(s.subtitleTracks.flatMap((t) => t.cues.map((c) => c.id)));
    expect(r.repairs.join('\n')).toMatch(/duplicate/i);
  });
});

describe('B10: settings ranges, odd cues / story blocks, formatVersion', () => {
  it('settings are clamped to the UI ranges', () => {
    const { p } = base();
    p.settings = { ...p.settings, autosaveIntervalSec: 1e-300, proxyHeight: 1e308, defaultTransitionFrames: 1e308 };
    let s = normalizeProject(p).settings;
    expect([s.autosaveIntervalSec, s.proxyHeight, s.defaultTransitionFrames]).toEqual([5, 1080, 600]);
    p.settings = { ...p.settings, autosaveIntervalSec: 1e9, proxyHeight: 1, defaultTransitionFrames: 0.4 };
    s = normalizeProject(p).settings;
    expect([s.autosaveIntervalSec, s.proxyHeight, s.defaultTransitionFrames]).toEqual([3600, 540, 1]);
    p.settings = { ...p.settings, autosaveIntervalSec: 12.4, proxyHeight: 700, defaultTransitionFrames: 30.6 };
    s = normalizeProject(p).settings;
    expect([s.autosaveIntervalSec, s.proxyHeight, s.defaultTransitionFrames]).toEqual([12, 720, 31]);
  });

  it('a free cue with a negative (or zero) duration is dropped; a story block with start > end is swapped', () => {
    const { p, sid, seq } = base();
    seq.subtitleTracks = [{ id: 'st', name: 's', language: 'en', enabled: true, cues: [
      { id: 'neg', start: 5, duration: -100, offset: 0, text: 'neg' },
      { id: 'zero', start: 5, duration: 0, offset: 0, text: 'zero' },
      { id: 'ok', start: 5, duration: 10, offset: 0, text: 'ok' },
    ] }];
    seq.storyBlocks = [{ id: 'b', start: 50, end: 10 }, { start: 1e308, end: -1e308 }];
    const s = normalizeProject(p).sequences[sid];
    expect(s.subtitleTracks[0].cues.map((c) => c.id)).toEqual(['ok']);
    expect(s.storyBlocks.map((b) => [b.id, b.start, b.end])).toEqual([['b', 10, 50]]);
  });

  it('formatVersion must be a positive integer: 0 / -1 / 0.5 / 1.5 are not ReCut projects; 1 opens', () => {
    for (const fv of [0, -1, 0.5, 1.5, -0]) {
      const { p } = base(); p.formatVersion = fv;
      expect(() => normalizeProject(p), String(fv)).toThrow(ProjectIncompatibleError);
      expect(() => normalizeProject(p), String(fv)).toThrow(/not a ReCut project/);
    }
    const { p } = base();
    expect(normalizeProject(p).formatVersion).toBe(1);
  });
});

describe('B2: normalizeProjectWithReport lists repairs', () => {
  it('valid projects report nothing (fresh, older minimal file)', () => {
    expect(normalizeProjectWithReport(rt(createProject('x'))).repairs).toEqual([]);
    expect(normalizeProjectWithReport({ formatVersion: 1 }).repairs).toEqual([]);
    const { p } = base();
    p.media.m1.proxy = { status: 'running' }; // jobs do not survive a restart: expected, not a repair
    p.media.m1.sceneDetectStatus = 'running';
    expect(normalizeProjectWithReport(p).repairs).toEqual([]);
  });

  it('dropped and reset data is reported; normalizing the result again reports nothing', () => {
    const { p, seq } = base();
    seq.videoTracks[0].clips = [clip('good', 0, 10), clip('nanIn', 10, 10, { sourceIn: null }), clip('frac', 20, 0.5), clip('neg', -1, 10)];
    seq.markers = [null, { time: 'x' }];
    p.settings.proxyHeight = 'big';
    const r = normalizeProjectWithReport(p);
    expect(r.repairs.length).toBeGreaterThan(0);
    for (const line of r.repairs) expect(typeof line).toBe('string');
    expect(r.repairs.join('\n')).toMatch(/clip/i);
    expect(r.repairs.join('\n')).toMatch(/marker/i);
    expect(normalizeProjectWithReport(rt(r.project)).repairs).toEqual([]);
  });

  it('normalizeProject is normalizeProjectWithReport().project', () => {
    const { p } = base();
    expect(rt(normalizeProject(rt(p)))).toEqual(rt(normalizeProjectWithReport(rt(p)).project));
  });
});

describe('sequence subtitle track sourcePaths (imported subtitle files)', () => {
  it('kept only as a list of non-empty strings; dropped when nothing usable remains; snapshots too', () => {
    const { p, sid, seq } = base();
    const tracks = () => [
      { id: 'ok', name: 'a', cues: [], sourcePaths: ['/subs/a.srt', '/subs/b.vtt'] },
      { id: 'mixed', name: 'b', cues: [], sourcePaths: ['/subs/c.srt', '', 5, null, { p: 1 }] },
      { id: 'junk', name: 'c', cues: [], sourcePaths: '/subs/d.srt' },
      { id: 'empty', name: 'd', cues: [], sourcePaths: ['', 7] },
      { id: 'none', name: 'e', cues: [] },
    ];
    seq.subtitleTracks = tracks();
    const data: Any = rt(seq); delete data.snapshots;
    seq.snapshots = [{ id: 'sn', name: 'n', createdAt: 1, data }];
    const r = normalizeProjectWithReport(p);
    const s = r.project.sequences[sid];
    for (const list of [s.subtitleTracks, s.snapshots[0].data.subtitleTracks]) {
      expect(list.map((t) => t.sourcePaths)).toEqual([['/subs/a.srt', '/subs/b.vtt'], ['/subs/c.srt'], undefined, undefined, undefined]);
      expect(list.filter((t) => 'sourcePaths' in t).map((t) => t.id)).toEqual(['ok', 'mixed']);
    }
    expect(r.repairs.join('\n')).toMatch(/subtitle source path/);
    const valid = base();
    valid.seq.subtitleTracks = [tracks()[0]];
    expect(normalizeProjectWithReport(valid.p).repairs).toEqual([]);
  });
});
