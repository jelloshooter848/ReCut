/**
 * Nested sequences (Roadmap §8, shared/nest.ts): cycle / depth rules, normalizeProject repairs, and flattening —
 * the preview planner and the export segment plan of a nested timeline match each other and the equivalent flat
 * timeline frame for frame.
 */
import { describe, it, expect } from 'vitest';
import type { Clip, ID, MediaItem, Rational, Sequence, Track, Transition } from '../../shared/model';
import { createProject, createSequence, normalizeProjectWithReport } from '../../shared/project';
import { defaultAudio, defaultTransform, sequenceDuration } from '../../shared/timeline';
import {
  composeTransform, envelopeAt, flatOrigin, flattenSequence, flattenWarnings, MAX_NEST_DEPTH, nestDepthBelow, nestedSequencesFor, nestProblem,
  nestingRepairs, outerClipId, reachableSequences, trackGroupId, unflattened,
} from '../../shared/nest';
import { activeTracks as exportActiveTracks, planTrackSegments, widenRangeForTransitions } from '../../shared/exportPlan';
import { planFrame } from '../../src/playback/planner';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { fixtureSettings } from './export-plan-fixture';

const R24: Rational = { num: 24, den: 1 };
const R25: Rational = { num: 25, den: 1 };

function media(id: string, over: Partial<MediaItem> = {}, dur = 600): MediaItem {
  return {
    id, name: id, path: `/media/${id}.mp4`, kind: 'video', category: 'Movie', identity: {}, binId: null,
    probe: {
      container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: dur, size: 1, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
      subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: R24, avgFps: R24, isVfr: false },
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0, ...over,
  };
}
const MEDIA: Record<ID, MediaItem> = { A: media('A'), B: media('B'), C: media('C') };

function clip(id: string, mediaId: string, start: number, duration: number, sourceIn: number, over: Partial<Clip> = {}): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn, speed: 1, linkId: null, enabled: true, kind: 'video',
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '', ...over,
  };
}
function nested(id: string, seqId: string, start: number, duration: number, sourceIn: number, over: Partial<Clip> = {}): Clip {
  return clip(id, seqId, start, duration, sourceIn, { sequenceId: seqId, name: `nest ${id}`, ...over });
}
function tr(id: string, type: Transition['type'], duration: number, outClipId: string | null, inClipId: string | null): Transition {
  return { id, type, duration, outClipId, inClipId };
}
function mkSeq(id: string, fps: Rational = R24, w = 1920, h = 1080): Sequence {
  const s = createSequence(id, fps, w, h);
  s.id = id;
  s.videoTracks.forEach((t, i) => { t.id = `${id}V${i + 1}`; });
  s.audioTracks.forEach((t, i) => { t.id = `${id}A${i + 1}`; });
  return s;
}
function put(t: Track, ...clips: Clip[]): void {
  for (const c of clips) { if (t.kind === 'audio') c.kind = 'audio'; t.clips.push(c); }
  t.clips.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------------------- frame comparisons

interface Shown { mediaId: string; t: number; alpha: number }
/** The planner's video layers at `f`, bottom to top, without ids / track indexes. */
function plannerVideo(seq: Sequence, f: number): Shown[] {
  return planFrame(seq, MEDIA, f, false).layers.map((l) => ({ mediaId: l.mediaId, t: l.sourceTime, alpha: l.alpha }));
}
function plannerAudio(seq: Sequence, f: number): Shown[] {
  return planFrame(seq, MEDIA, f, false).audio.map((a) => ({ mediaId: a.mediaId, t: a.sourceTime, alpha: a.gain * a.trackVolume }))
    .sort((a, b) => a.mediaId.localeCompare(b.mediaId) || a.t - b.t);
}
/** What the export's segment plan shows at `f` (clip segments covering f, transition handles included). */
function exportVideo(seq: Sequence, f: number, startF: number, endF: number, need: 'video' | 'audio' = 'video'): { mediaId: string; t: number }[] {
  const out: { mediaId: string; t: number }[] = [];
  const fd = seq.fps.den / seq.fps.num;
  for (const track of exportActiveTracks(need === 'video' ? seq.videoTracks : seq.audioTracks)) {
    const plan = planTrackSegments(track, seq, MEDIA, startF, endF, need, []);
    for (const s of plan.segs) {
      if (s.kind !== 'clip') continue;
      const a = startF + s.start - s.extBefore, b = startF + s.start + s.frames + s.extAfter;
      if (f < a || f >= b) continue;
      out.push({ mediaId: s.media.id, t: s.srcStart + (f - startF - s.start) * fd * s.speed });
    }
  }
  return out;
}
function close(a: Shown[] | { mediaId: string; t: number }[], b: Shown[] | { mediaId: string; t: number }[], what: string): void {
  expect(a.length, what).toBe(b.length);
  a.forEach((x, i) => {
    expect(x.mediaId, what).toBe(b[i].mediaId);
    expect(x.t, what).toBeCloseTo(b[i].t, 6);
    if ('alpha' in x && 'alpha' in b[i]) expect(x.alpha, what).toBeCloseTo((b[i] as Shown).alpha, 6);
  });
}

// ------------------------------------------------------------------------------- rules

describe('nesting rules', () => {
  const seqs = () => {
    const a = mkSeq('a'), b = mkSeq('b'), c = mkSeq('c');
    put(a.videoTracks[0], nested('nb', 'b', 0, 10, 0));
    put(b.videoTracks[0], nested('nc', 'c', 0, 10, 0));
    put(c.videoTracks[0], clip('x', 'A', 0, 10, 0));
    return { a, b, c } as Record<ID, Sequence>;
  };

  it('reports self, cycle, missing and depth problems', () => {
    const s = seqs();
    expect(nestProblem(s, 'a', 'a')).toBe('self');
    expect(nestProblem(s, 'c', 'a')).toBe('cycle');
    expect(nestProblem(s, 'b', 'a')).toBe('cycle');
    expect(nestProblem(s, 'a', 'zz')).toBe('missing');
    expect(nestProblem(s, 'a', 'c')).toBeNull();
    expect([...reachableSequences(s, 'a')].sort()).toEqual(['b', 'c']);
    expect(nestDepthBelow(s, 'a')).toBe(2);
    expect(Object.keys(nestedSequencesFor(s.a, s)).sort()).toEqual(['b', 'c']);
  });

  it('limits the nesting depth', () => {
    const s: Record<ID, Sequence> = {};
    for (let i = 0; i <= MAX_NEST_DEPTH + 1; i++) s[`s${i}`] = mkSeq(`s${i}`);
    for (let i = 0; i < MAX_NEST_DEPTH; i++) put(s[`s${i}`].videoTracks[0], nested(`n${i}`, `s${i + 1}`, 0, 10, 0));
    // s0 > s1 > ... > s8: 8 levels; one more is refused.
    expect(nestDepthBelow(s, 's0')).toBe(MAX_NEST_DEPTH);
    expect(nestProblem(s, `s${MAX_NEST_DEPTH}`, `s${MAX_NEST_DEPTH + 1}`)).toBe('depth');
    expect(nestProblem(s, 's1', `s${MAX_NEST_DEPTH + 1}`)).toBeNull(); // s0 > s1 > s9: 2 levels
    expect(nestProblem(s, `s${MAX_NEST_DEPTH + 1}`, 's1')).toBeNull(); // s9 > s1 > ... > s8: 8 levels
    expect(nestProblem(s, `s${MAX_NEST_DEPTH + 1}`, 's0')).toBe('depth'); // s9 > s0 > ... > s8: 9 levels
    expect(nestingRepairs(s, [])).toEqual([]);
    put(s[`s${MAX_NEST_DEPTH}`].videoTracks[0], nested('deep', `s${MAX_NEST_DEPTH + 1}`, 0, 10, 0));
    s[`s${MAX_NEST_DEPTH}`] = { ...s[`s${MAX_NEST_DEPTH}`], videoTracks: [...s[`s${MAX_NEST_DEPTH}`].videoTracks] };
    expect(nestingRepairs(s, [])).toEqual([[`s${MAX_NEST_DEPTH}`, `s${MAX_NEST_DEPTH + 1}`]]);
  });

  it('normalizeProject cuts cycles and keeps everything else', () => {
    const p = createProject('n');
    const s = seqs();
    put(s.c.videoTracks[1], nested('back', 'a', 0, 10, 0)); // c > a closes a cycle a > b > c > a
    p.sequences = s; p.sequenceOrder = ['a', 'b', 'c']; p.activeSequenceId = 'a';
    const { project, repairs } = normalizeProjectWithReport(JSON.parse(JSON.stringify(p)));
    expect(repairs.join('\n')).toMatch(/nested sequence that contained itself/);
    const all = Object.values(project.sequences).flatMap((q) => [...q.videoTracks, ...q.audioTracks].flatMap((t) => t.clips));
    expect(all.filter((c) => c.sequenceId).map((c) => c.id).sort()).toEqual(['nb', 'nc']);
    const back = all.find((c) => c.id === 'back')!;
    expect(back.sequenceId).toBeUndefined();
    expect(back.mediaId).toBe('a'); // a clip of missing media now: nothing is lost
    // Normalizing the result again repairs nothing.
    expect(normalizeProjectWithReport(JSON.parse(JSON.stringify(project))).repairs).toEqual([]);
  });

  it('normalizeProject keeps a valid nested clip as it is, and fixes its media id and speed', () => {
    const p = createProject('n');
    const s = seqs();
    p.sequences = s; p.sequenceOrder = ['a', 'b', 'c']; p.activeSequenceId = 'a';
    const raw = JSON.parse(JSON.stringify(p));
    expect(normalizeProjectWithReport(raw).repairs).toEqual([]);
    const bad = JSON.parse(JSON.stringify(p));
    bad.sequences.a.videoTracks[0].clips[0].mediaId = 'zzz';
    bad.sequences.a.videoTracks[0].clips[0].speed = 2;
    bad.sequences.b.videoTracks[0].clips[0].sequenceId = 42;
    const { project } = normalizeProjectWithReport(bad);
    expect(project.sequences.a.videoTracks[0].clips[0]).toMatchObject({ sequenceId: 'b', mediaId: 'b', speed: 1 });
    expect(project.sequences.b.videoTracks[0].clips[0].sequenceId).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------- flattening

/**
 * Inner sequence I (24 fps): V1 a [0,48) A@10s, b [48,96) B@5s with a 12-frame cross dissolve; A1 the same as audio.
 * Outer O: V1 x [0,24) C@0, then N = I from inner frame 12, 60 frames long (to inner frame 72), on V1 and A1.
 * Flat F: what N stands for, placed by hand.
 */
function scene(fpsInner: Rational = R24) {
  const I = mkSeq('I', fpsInner);
  put(I.videoTracks[0], clip('a', 'A', 0, 48, 10), clip('b', 'B', 48, 48, 5));
  I.videoTracks[0].transitions.push(tr('ti', 'crossDissolve', 12, 'a', 'b'));
  put(I.audioTracks[0], clip('aa', 'A', 0, 48, 10, { kind: 'audio' }), clip('ab', 'B', 48, 48, 5, { kind: 'audio' }));
  I.audioTracks[0].transitions.push(tr('tia', 'audioCrossfade', 12, 'aa', 'ab'));
  const O = mkSeq('O');
  put(O.videoTracks[0], clip('x', 'C', 0, 24, 0), nested('N', 'I', 24, 60, 12 / 24, { linkId: 'L' }));
  put(O.audioTracks[0], clip('xa', 'C', 0, 24, 0, { kind: 'audio' }), nested('Na', 'I', 24, 60, 12 / 24, { linkId: 'L', kind: 'audio' }));
  const F = mkSeq('F');
  put(F.videoTracks[0], clip('x', 'C', 0, 24, 0), clip('a', 'A', 24, 36, 10 + 12 / 24), clip('b', 'B', 60, 24, 5));
  F.videoTracks[0].transitions.push(tr('ti', 'crossDissolve', 12, 'a', 'b'));
  put(F.audioTracks[0], clip('xa', 'C', 0, 24, 0, { kind: 'audio' }), clip('aa', 'A', 24, 36, 10 + 12 / 24, { kind: 'audio' }), clip('ab', 'B', 60, 24, 5, { kind: 'audio' }));
  F.audioTracks[0].transitions.push(tr('tia', 'audioCrossfade', 12, 'aa', 'ab'));
  return { I, O, F, sequences: { I, O } as Record<ID, Sequence> };
}

describe('flattenSequence', () => {
  it('returns a sequence without nested clips unchanged', () => {
    const { F } = scene();
    expect(flattenSequence(F, {}, MEDIA)).toBe(F);
  });

  it('nested timeline = equivalent flat timeline, in the planner and the export plan, frame for frame', () => {
    const { O, F, sequences } = scene();
    const flat = flattenSequence(O, sequences, MEDIA);
    expect(sequenceDuration(flat)).toBe(sequenceDuration(O));
    expect(unflattened(flat)).toBe(O);
    const end = sequenceDuration(O);
    for (let f = 0; f < end + 2; f++) {
      close(plannerVideo(flat, f), plannerVideo(F, f), `planner video @${f}`);
      close(plannerAudio(flat, f), plannerAudio(F, f), `planner audio @${f}`);
      close(exportVideo(flat, f, 0, end), exportVideo(F, f, 0, end), `export video @${f}`);
      close(exportVideo(flat, f, 0, end, 'audio'), exportVideo(F, f, 0, end, 'audio'), `export audio @${f}`);
      // Preview and export agree on what is shown.
      close(plannerVideo(flat, f).map(({ mediaId, t }) => ({ mediaId, t })), exportVideo(flat, f, 0, end), `planner = export @${f}`);
    }
  });

  it('matches for an export range inside the nested clip', () => {
    const { O, F, sequences } = scene();
    const flat = flattenSequence(O, sequences, MEDIA);
    const r1 = widenRangeForTransitions(flat, 40, 70), r2 = widenRangeForTransitions(F, 40, 70);
    expect(r1).toEqual(r2);
    for (let f = r1.startF; f < r1.endF; f++) close(exportVideo(flat, f, r1.startF, r1.endF), exportVideo(F, f, r2.startF, r2.endF), `range @${f}`);
  });

  it('builds the same render graph segments as the flat timeline', () => {
    const { O, F, sequences } = scene();
    const settings = fixtureSettings({ width: 1920, height: 1080, fps: R24 });
    const gN = buildRenderGraph({ sequence: O, sequences, media: MEDIA, settings });
    const gF = buildRenderGraph({ sequence: F, media: MEDIA, settings });
    expect(gN.inputArgs).toEqual(gF.inputArgs);
    // Every clip segment chain (input, trims, timing, fit, fades) is the same; only the track layout differs (the
    // nested content is a track of its own, composited / mixed with the outer track's).
    const segments = (g: string) => g.split(';\n').filter((c) => /^\[\d+:/.test(c)).map((c) => c.replace(/\[[a-z]+\d+\]$/, ''));
    expect(segments(gN.filterGraph)).toEqual(segments(gF.filterGraph));
    expect(gN.frameCount).toBe(gF.frameCount);
  });

  it('keeps clip provenance and the outer track of every flattened track', () => {
    const { O, sequences } = scene();
    const flat = flattenSequence(O, sequences, MEDIA);
    const sub = flat.videoTracks.find((t) => t.id !== O.videoTracks[0].id && trackGroupId(t) === O.videoTracks[0].id)!;
    expect(sub).toBeTruthy();
    const a = sub.clips.find((c) => c.mediaId === 'A')!;
    expect(flatOrigin(a)).toMatchObject({ path: ['N'], sequenceId: 'I' });
    expect(flatOrigin(a)!.source.id).toBe('a');
    expect(outerClipId(a)).toBe('N');
    // The nested clip stays as a disabled placeholder (length, lookups).
    expect(flat.videoTracks[0].clips.find((c) => c.id === 'N')).toMatchObject({ enabled: false, sequenceId: 'I' });
  });

  it('is memoized while the nested sequences and media are the same objects', () => {
    const { O, I, sequences } = scene();
    const a = flattenSequence(O, sequences, MEDIA);
    expect(flattenSequence(O, { ...sequences }, MEDIA)).toBe(a);
    const I2 = { ...I, videoTracks: [...I.videoTracks] };
    const b = flattenSequence(O, { ...sequences, I: I2 }, MEDIA);
    expect(b).not.toBe(a);
  });

  it('plays an inner sequence of another frame rate in real time at the outer rate', () => {
    // Inner 25 fps: a [0,50) = 0..2 s, b [50,100) = 2..4 s. Nested from 0.5 s.
    const I = mkSeq('I', R25);
    put(I.videoTracks[0], clip('a', 'A', 0, 50, 10), clip('b', 'B', 50, 50, 5));
    const O = mkSeq('O');
    put(O.videoTracks[0], nested('N', 'I', 0, 84, 0.5));
    const flat = flattenSequence(O, { I, O }, MEDIA);
    // The cut at 2.0 s lands on the first outer frame starting at or after it: (2.0 - 0.5) * 24 = 36.
    expect(plannerVideo(flat, 35)).toEqual([{ mediaId: 'A', t: expect.closeTo(10 + 0.5 + 35 / 24, 9), alpha: 1 }]);
    expect(plannerVideo(flat, 36)).toEqual([{ mediaId: 'B', t: expect.closeTo(5, 9), alpha: 1 }]);
    expect(plannerVideo(flat, 37)[0].t).toBeCloseTo(5 + 1 / 24, 9);
    // Past the inner end (4.0 s = outer frame 84): nothing.
    const O2 = mkSeq('O');
    put(O2.videoTracks[0], nested('N', 'I', 0, 100, 0.5));
    const flat2 = flattenSequence(O2, { I, O: O2 }, MEDIA);
    expect(plannerVideo(flat2, 83)).toHaveLength(1);
    expect(plannerVideo(flat2, 84)).toEqual([]);
    expect(sequenceDuration(flat2)).toBe(100);
    for (let f = 0; f < 100; f++) close(plannerVideo(flat2, f).map(({ mediaId, t }) => ({ mediaId, t })), exportVideo(flat2, f, 0, 100), `fps @${f}`);
    // An inner cut that falls between outer frames: 25 fps frame 37 = 1.48 s -> first outer frame starting after it.
    const I3 = mkSeq('I', R25);
    put(I3.videoTracks[0], clip('a', 'A', 0, 37, 0), clip('b', 'B', 37, 50, 0));
    const O3 = mkSeq('O');
    put(O3.videoTracks[0], nested('N', 'I', 0, 60, 0));
    const flat3 = flattenSequence(O3, { I: I3, O: O3 }, MEDIA);
    expect(plannerVideo(flat3, 35)[0].mediaId).toBe('A'); // 35/24 = 1.4583 s < 1.48
    expect(plannerVideo(flat3, 36)[0].mediaId).toBe('B'); // 36/24 = 1.5 s
    expect(plannerVideo(flat3, 36)[0].t).toBeCloseTo(0.02, 9);
  });

  it('turns a dissolve into a nested clip into ramps with inner handles', () => {
    const { O, sequences } = scene();
    O.videoTracks[0].transitions.push(tr('tx', 'crossDissolve', 8, 'x', 'N'));
    O.videoTracks = [...O.videoTracks];
    const flat = flattenSequence(O, sequences, MEDIA);
    // Cut at 24, 4 frames each side: x (C) fades out over [20,28), N's layers fade in; N shows inner frame 8 at 20.
    for (let f = 18; f < 30; f++) {
      const layers = plannerVideo(flat, f);
      const t = Math.min(1, Math.max(0, (f - 20) / 8));
      const c = layers.find((l) => l.mediaId === 'C');
      const a = layers.find((l) => l.mediaId === 'A');
      if (f < 28) expect(c?.alpha, `x @${f}`).toBeCloseTo(1 - t, 9); else expect(c).toBeUndefined();
      if (f >= 20) { expect(a?.alpha, `N @${f}`).toBeCloseTo(t, 9); expect(a!.t).toBeCloseTo(10 + (12 + f - 24) / 24, 9); } else expect(a).toBeUndefined();
      close(layers.map(({ mediaId, t }) => ({ mediaId, t })), exportVideo(flat, f, 0, 84), `export @${f}`);
    }
    const g = buildRenderGraph({ sequence: O, sequences, media: MEDIA, settings: fixtureSettings({ width: 1920, height: 1080, fps: R24 }) });
    expect(g.filterGraph).toMatch(/fade=t=out:st=0\.833333:d=0\.333333:alpha=1/); // x: [20,28) from its first frame 0
    expect(g.filterGraph).toMatch(/tpad=start=0:|fade=t=in:st=0:d=0\.333333:alpha=1/);
  });

  it('drops a dissolve into a nested clip that has no inner frames before its in point', () => {
    const { O, sequences } = scene();
    O.videoTracks[0].clips = O.videoTracks[0].clips.map((c) => (c.id === 'N' ? { ...c, sourceIn: 0 } : c));
    O.videoTracks[0].transitions.push(tr('tx', 'crossDissolve', 8, 'x', 'N'));
    const flat = flattenSequence(O, sequences, MEDIA);
    expect(plannerVideo(flat, 23)).toEqual([{ mediaId: 'C', t: expect.closeTo(23 / 24, 9), alpha: 1 }]);
    expect(plannerVideo(flat, 24)).toEqual([{ mediaId: 'A', t: expect.closeTo(10, 9), alpha: 1 }]);
  });

  it('fades a nested clip from black and applies its opacity to every layer', () => {
    const { O, sequences } = scene();
    O.videoTracks[0].clips = O.videoTracks[0].clips.map((c) => (c.id === 'N' ? { ...c, transform: { ...c.transform, opacity: 0.5 } } : c));
    O.videoTracks[0].transitions.push(tr('tf', 'crossDissolve', 10, null, 'N'));
    const flat = flattenSequence(O, sequences, MEDIA);
    expect(plannerVideo(flat, 24)[0].alpha).toBeCloseTo(0, 9);
    expect(plannerVideo(flat, 29)[0].alpha).toBeCloseTo(0.5 * 0.5, 9);
    expect(plannerVideo(flat, 40)[0].alpha).toBeCloseTo(0.5, 9);
  });

  it('mixes inner audio with inner track volume, mute / solo and the nested clip gain, volume, fades and mute', () => {
    const { O, I, sequences } = scene();
    I.audioTracks[0] = { ...I.audioTracks[0], volume: 0.5 };
    I.audioTracks = [...I.audioTracks];
    O.audioTracks[0].clips = O.audioTracks[0].clips.map((c) => (c.id === 'Na' ? { ...c, audio: { ...c.audio, gain: 6, volume: 0.8, fadeIn: 4 } } : c));
    const flat = flattenSequence(O, { ...sequences, I }, MEDIA);
    const k = Math.pow(10, 6 / 20) * 0.8 * 0.5;
    expect(plannerAudio(flat, 40).find((a) => a.mediaId === 'A')!.alpha).toBeCloseTo(k, 6);
    expect(plannerAudio(flat, 26).find((a) => a.mediaId === 'A')!.alpha).toBeCloseTo(k * 0.5, 6);
    // Muting the inner track (or the nested clip) silences it.
    const Im = { ...I, audioTracks: I.audioTracks.map((t, i) => (i === 0 ? { ...t, muted: true } : t)) };
    expect(plannerAudio(flattenSequence(O, { ...sequences, I: Im }, MEDIA), 40).filter((a) => a.mediaId !== 'C')).toEqual([]);
    const Om = { ...O, audioTracks: O.audioTracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'Na' ? { ...c, audio: { ...c.audio, muted: true } } : c)) })) };
    expect(plannerAudio(flattenSequence(Om, { ...sequences, O: Om }, MEDIA), 40)).toEqual([]);
  });

  it('mixes nested audio into the outer track of the nested clip in the export', () => {
    const { O, sequences } = scene();
    const g = buildRenderGraph({ sequence: O, sequences, media: MEDIA, settings: fixtureSettings({ width: 1920, height: 1080, fps: R24 }) });
    // Outer A1 has its own clips on the base track and the nested content on another: both reach [aout].
    expect(g.filterGraph).toMatch(/amix=inputs=2/);
    const per = buildRenderGraph({ sequence: O, sequences, media: MEDIA, settings: fixtureSettings({ container: 'wav', audioPerTrack: true }) }, { audioTrackId: O.audioTracks[0].id });
    expect(per.filterGraph).toMatch(/amix=inputs=2/);
  });

  it('renders a missing or cyclic nested sequence as nothing, with a warning', () => {
    const O = mkSeq('O');
    put(O.videoTracks[0], nested('N', 'gone', 0, 24, 0));
    const flat = flattenSequence(O, { O }, MEDIA);
    expect(plannerVideo(flat, 5)).toEqual([]);
    expect(flattenWarnings(flat).join()).toMatch(/missing/);
    const A = mkSeq('A'), B = mkSeq('B');
    put(A.videoTracks[0], nested('nb', 'B', 0, 24, 0), clip('x', 'C', 24, 24, 0));
    put(B.videoTracks[0], nested('na', 'A', 0, 24, 0));
    const fa = flattenSequence(A, { A, B }, MEDIA);
    expect(plannerVideo(fa, 5)).toEqual([]);
    expect(plannerVideo(fa, 30)).toHaveLength(1);
    expect(flattenWarnings(fa).join()).toMatch(/cycle/);
  });

  it('flattens two levels deep', () => {
    const { I, O, sequences } = scene();
    const T = mkSeq('T');
    put(T.videoTracks[0], nested('M', 'O', 0, 84, 0));
    const flat = flattenSequence(T, { ...sequences, T }, MEDIA);
    const flatO = flattenSequence(O, sequences, MEDIA);
    for (let f = 0; f < 84; f++) close(plannerVideo(flat, f), plannerVideo(flatO, f), `deep @${f}`);
    const deep = flat.videoTracks.flatMap((t) => t.clips).find((c) => c.mediaId === 'A')!;
    expect(flatOrigin(deep)!.path).toEqual(['M', 'N']);
    expect(flatOrigin(deep)!.sequenceId).toBe(I.id);
  });

  it('applies the cross dissolve envelope to the nested side in the export graph', () => {
    const { O, sequences } = scene();
    O.videoTracks[0].transitions.push(tr('tx', 'crossDissolve', 8, 'x', 'N'));
    const flat = flattenSequence(O, sequences, MEDIA);
    const a = flat.videoTracks.flatMap((t) => t.clips).find((c) => c.mediaId === 'A')!;
    expect(envelopeAt(a, 20)).toBe(0);
    expect(envelopeAt(a, 24)).toBe(0.5);
    expect(envelopeAt(a, 28)).toBe(1);
  });
});

describe('composeTransform', () => {
  /** Where the preview draws media pixel (u, v) of a layer (sequencePlayer.paint). */
  function place(t: { x: number; y: number; scale: number; rotation: number }, W: number, H: number, vw: number, vh: number, u: number, v: number) {
    const fit = Math.min(W / vw, H / vh);
    const px = (u - vw / 2) * fit * t.scale, py = (v - vh / 2) * fit * t.scale;
    const a = (t.rotation * Math.PI) / 180;
    return { x: W / 2 + t.x + px * Math.cos(a) - py * Math.sin(a), y: H / 2 + t.y + px * Math.sin(a) + py * Math.cos(a) };
  }
  const m = media('A');

  it('places every pixel where the two-step render would', () => {
    const inner = { width: 1080, height: 1080 }, outer = { width: 1920, height: 1080 };
    const ti = { ...defaultTransform(), x: 100, y: -40, scale: 0.5, rotation: 30 };
    const to = { ...defaultTransform(), x: -200, y: 60, scale: 1.25, rotation: -15 };
    const c = composeTransform(to, ti, m, inner, outer)!;
    for (const [u, v] of [[0, 0], [1920, 0], [960, 540], [300, 1000]]) {
      const p1 = place(ti, inner.width, inner.height, 1920, 1080, u, v);
      // Inner frame as an image of 1080x1080 placed in the outer frame.
      const p2 = place(to, outer.width, outer.height, inner.width, inner.height, p1.x, p1.y);
      const p = place(c, outer.width, outer.height, 1920, 1080, u, v);
      expect(p.x).toBeCloseTo(p2.x, 6);
      expect(p.y).toBeCloseTo(p2.y, 6);
    }
  });

  it('is the identity for full-frame layers in same-shape frames', () => {
    const c = composeTransform(defaultTransform(), defaultTransform(), m, { width: 1280, height: 720 }, { width: 1920, height: 1080 })!;
    expect(c).toEqual(defaultTransform());
  });

  it('clips a layer to the inner frame and the nested clip crop', () => {
    const inner = { width: 1920, height: 1080 }, outer = { width: 1920, height: 1080 };
    // Layer moved half a frame right: its right half is outside the inner frame.
    const c = composeTransform({ ...defaultTransform(), scale: 0.5 }, { ...defaultTransform(), x: 960 }, m, inner, outer)!;
    expect(c.crop.right).toBeCloseTo(0.5, 9);
    const crop = composeTransform({ ...defaultTransform(), crop: { left: 0.25, top: 0, right: 0, bottom: 0.1 } }, defaultTransform(), m, inner, outer)!;
    expect(crop.crop).toEqual({ left: expect.closeTo(0.25, 9), top: 0, right: 0, bottom: expect.closeTo(0.1, 9) });
    expect(composeTransform(defaultTransform(), { ...defaultTransform(), x: 5000 }, m, inner, outer)).toBeNull();
  });
});
