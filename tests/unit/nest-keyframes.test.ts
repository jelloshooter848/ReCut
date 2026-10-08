/**
 * Keyframes inside nested sequences (Roadmap §8 × §11, shared/nest.ts flattenSequence): a nested timeline whose inner
 * clips, nested clips, or both carry keyframes plays and exports what the equivalent flat timeline (keyframes computed
 * by hand) does, frame for frame:
 *  - time: a flattened clip's keyframes give the source clip's value at the corresponding frame (a shift at the same
 *    rate; rescaled by fdI / fdO across frame rates); the nested clip's own keyframes are in outer clip frames;
 *  - values: position / scale / rotation compose as composeTransform does with both sides' values at that frame,
 *    opacity = N(t) × inner(t), level = inner(t) × N(t) × inner track volume; exact at integer frames;
 *  - long clips with both sides animated: at most MAX_KEYFRAMES_PER_PROPERTY keyframes, and the export graph builds;
 *  - inner layers whose own position or scale is keyed keep the inner clip's own crop (not cut to the inner frame edge
 *    or the nested crop: a documented limitation, docs/LIMITATIONS.md); layers that only move with the nested clip are
 *    still cut there (the cut is in the layer's own picture, which the nested clip's motion does not change);
 *  - clips without keyframes on either side come through without a `keyframes` key.
 * Checked in the preview planner (per-frame transform, alpha, gain) and on the flattened clips the render graph
 * evaluates (shared/keyframes.ts evaluateClipProperty, the same evaluation as its filters).
 */
import { describe, it, expect } from 'vitest';
import type { Clip, ClipTransform, ExportSettings, ID, Keyframe, MediaItem, Rational, Sequence, Track, TransformKeyframes, Transition } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { clipEnd, defaultAudio, defaultTransform } from '../../shared/timeline';
import { composeTransform, flatOrigin, flattenSequence, isNestedClip } from '../../shared/nest';
import { evaluateClipProperty, evaluateKeyframes, exprNum, MAX_KEYFRAMES_PER_PROPERTY, TRANSFORM_KEY_PROPS, transformAt } from '../../shared/keyframes';
import { dbToLinear, planFrame } from '../../src/playback/planner';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { fixtureSettings } from './export-plan-fixture';

const R24: Rational = { num: 24, den: 1 };
const R25: Rational = { num: 25, den: 1 };
const EXACT = 1e-6;

// ------------------------------------------------------------------------------- builders (as tests/unit/nest.test.ts)

function media(id: string, dur = 600): MediaItem {
  return {
    id, name: id, path: `/media/${id}.mp4`, kind: 'video', category: 'Movie', identity: {}, binId: null,
    probe: {
      container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: dur, size: 1, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
      subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: R24, avgFps: R24, isVfr: false },
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}
const MEDIA: Record<ID, MediaItem> = { A: media('A'), B: media('B'), C: media('C'), D: media('D') };

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
const kf = (frame: number, value: number, interp?: 'ease'): Keyframe => (interp ? { frame, value, interp } : { frame, value });
const keyed = (keyframes: TransformKeyframes, over: Partial<ClipTransform> = {}): ClipTransform => ({ ...defaultTransform(), ...over, keyframes });
const vol = (keys: Keyframe[], over: Partial<Clip['audio']> = {}): Clip['audio'] => ({ ...defaultAudio(), ...over, keyframes: { volume: keys } });

// ------------------------------------------------------------------------------- expected values, by hand

/** A clip's transform at frame `f` (keyframes evaluated), as a static transform. */
function at(c: Clip, f: number): ClipTransform {
  const t = transformAt(c, f);
  return { x: t.x, y: t.y, scale: t.scale, rotation: t.rotation, opacity: t.opacity, crop: { ...t.crop } };
}
/** Inner timeline position (inner frames, fractional) that nested clip N shows at outer frame f. */
function innerPos(N: Clip, f: number, outer: Rational, inner: Rational): number {
  return (N.sourceIn + ((f - N.start) * outer.den) / outer.num) * inner.num / inner.den;
}
/**
 * The layer `ti` (of media `mediaId`, in the inner frame) drawn through the nested clip transform `to`: composeTransform
 * with both sides' values at this frame; an animated layer keeps `crop` (the inner clip's own crop).
 */
function compose(to: ClipTransform, ti: ClipTransform, mediaId: ID, inner: Sequence, outer: Sequence, crop = ti.crop): ClipTransform {
  const t = composeTransform(to, ti, MEDIA[mediaId], inner, outer);
  expect(t, 'layer clipped away').not.toBeNull();
  return { ...t!, crop: { ...crop } };
}
/** Keyframes at every frame of [from, to) holding `fn(f)`, clip-relative to `start`. */
function sampleKeys(fn: (f: number) => number, start: number, from: number, to: number): Keyframe[] {
  const out: Keyframe[] = [];
  for (let f = from; f < to; f++) out.push({ frame: f - start, value: fn(f) });
  return out;
}
/** A video clip of a flat reference timeline whose transform is `want(f)` at every frame (transition handles included). */
function sampledVideo(id: string, mediaId: ID, start: number, duration: number, sourceIn: number, want: (f: number) => ClipTransform, pad = 8): Clip {
  const t0 = want(start);
  const keyframes: TransformKeyframes = {};
  for (const p of TRANSFORM_KEY_PROPS) keyframes[p] = sampleKeys((f) => want(f)[p], start, start - pad, start + duration + pad);
  return clip(id, mediaId, start, duration, sourceIn, { transform: { ...t0, keyframes } });
}
/** An audio clip of a flat reference timeline with gain `gain` and level `want(f)` at every frame. */
function sampledAudio(id: string, mediaId: ID, start: number, duration: number, sourceIn: number, gain: number, want: (f: number) => number, pad = 8): Clip {
  return clip(id, mediaId, start, duration, sourceIn, { kind: 'audio', audio: vol(sampleKeys(want, start, start - pad, start + duration + pad), { gain }) });
}

// ------------------------------------------------------------------------------- comparisons

function near(got: number, want: number, tol: number, what: string): void {
  expect(Math.abs(got - want), `${what}: ${got} vs ${want}`).toBeLessThanOrEqual(tol);
}
type Tol = number | Partial<Record<'x' | 'y' | 'scale' | 'rotation' | 'opacity', number>>;
const tolOf = (tol: Tol, p: 'x' | 'y' | 'scale' | 'rotation' | 'opacity') => (typeof tol === 'number' ? tol : tol[p] ?? EXACT);
function sameTransform(got: ClipTransform, want: ClipTransform, what: string, tol: Tol = EXACT): void {
  for (const p of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) near(got[p], want[p], tolOf(tol, p), `${what} ${p}`);
  for (const s of ['left', 'top', 'right', 'bottom'] as const) near(got.crop[s], want.crop[s], 1e-9, `${what} crop.${s}`);
}

interface Lay { mediaId: string; t: number; alpha: number; tr: ClipTransform }
/** The planner's video layers at `f`, sorted by media (the flattened tracks order layers by outer track). */
function layers(seq: Sequence, f: number): Lay[] {
  return planFrame(seq, MEDIA, f, false).layers.map((l) => ({ mediaId: l.mediaId, t: l.sourceTime, alpha: l.alpha, tr: l.transform }))
    .sort((a, b) => a.mediaId.localeCompare(b.mediaId) || a.t - b.t);
}
function sameLayers(got: Lay[], want: Lay[], what: string, tol: Tol = EXACT): void {
  expect(got.map((l) => l.mediaId), what).toEqual(want.map((l) => l.mediaId));
  got.forEach((g, i) => {
    const w = want[i];
    near(g.t, w.t, 1e-9, `${what} ${g.mediaId} source time`);
    near(g.alpha, w.alpha, tolOf(tol, 'opacity'), `${what} ${g.mediaId} alpha`);
    sameTransform(g.tr, w.tr, `${what} ${g.mediaId}`, tol);
  });
}
interface Snd { mediaId: string; t: number; level: number }
/** The planner's audio at `f`: linear gain × track volume. */
function sounds(seq: Sequence, f: number): Snd[] {
  return planFrame(seq, MEDIA, f, false).audio.map((a) => ({ mediaId: a.mediaId, t: a.sourceTime, level: a.gain * a.trackVolume }))
    .sort((a, b) => a.mediaId.localeCompare(b.mediaId) || a.t - b.t);
}
function sameSounds(got: Snd[], want: Snd[], what: string, tol = EXACT): void {
  expect(got.map((s) => s.mediaId), what).toEqual(want.map((s) => s.mediaId));
  got.forEach((g, i) => { near(g.t, want[i].t, 1e-9, `${what} ${g.mediaId} source time`); near(g.level, want[i].level, tol, `${what} ${g.mediaId} level`); });
}

/** The media clips of a flattened sequence (the disabled nested placeholders left out). */
function mediaClips(flat: Sequence, kind: 'video' | 'audio'): Clip[] {
  return (kind === 'video' ? flat.videoTracks : flat.audioTracks).flatMap((t) => t.clips).filter((c) => c.enabled && !isNestedClip(c));
}
/** The id of the clip a flattened clip was made from (its own id when it is used as it is). */
const sourceId = (c: Clip) => flatOrigin(c)?.source.id ?? c.id;
function byId(clips: Clip[], id: ID): Clip {
  const c = clips.find((x) => sourceId(x) === id);
  expect(c, `flattened clip of ${id}`).toBeDefined();
  return c!;
}

/** Keyframe lists a renderer can use: non-empty, finite, strictly increasing frames, at most the cap. */
function checkLists(c: Clip): void {
  const lists: [string, Keyframe[] | undefined][] = [
    ...TRANSFORM_KEY_PROPS.map((p) => [p, c.transform.keyframes?.[p]] as [string, Keyframe[] | undefined]),
    ['volume', c.audio.keyframes?.volume],
  ];
  for (const [p, l] of lists) {
    if (!l) continue;
    expect(l.length, `${c.id} ${p} keyframes`).toBeGreaterThan(0);
    expect(l.length, `${c.id} ${p} keyframes`).toBeLessThanOrEqual(MAX_KEYFRAMES_PER_PROPERTY);
    for (let i = 0; i < l.length; i++) {
      expect(Number.isFinite(l[i].frame) && Number.isFinite(l[i].value), `${c.id} ${p}[${i}]`).toBe(true);
      if (i) expect(l[i].frame, `${c.id} ${p}[${i}] order`).toBeGreaterThan(l[i - 1].frame);
    }
  }
}

/**
 * What the render graph evaluates on each flattened video clip (evaluateClipProperty at every frame it covers, its
 * static rotation and crop) against `want(source clip id, frame)`. Returns the number of frames checked.
 */
function checkFlatVideo(flat: Sequence, want: (id: ID, f: number) => ClipTransform | null, tol: Tol = EXACT, frames?: (f: number) => boolean): number {
  let n = 0;
  for (const c of mediaClips(flat, 'video')) {
    checkLists(c);
    for (let f = c.start; f < clipEnd(c); f++) {
      if (frames && !frames(f)) continue;
      const w = want(sourceId(c), f);
      if (!w) continue;
      const what = `flattened ${c.id} @${f}`;
      for (const p of TRANSFORM_KEY_PROPS) near(evaluateClipProperty(p, c, f), w[p], tolOf(tol, p), `${what} ${p}`);
      near(c.transform.rotation, w.rotation, EXACT, `${what} rotation`);
      for (const s of ['left', 'top', 'right', 'bottom'] as const) near(c.transform.crop[s], w.crop[s], 1e-9, `${what} crop.${s}`);
      n++;
    }
  }
  return n;
}
/** The same for audio: gain (static) and level (keyframed or static) of each flattened audio clip. */
function checkFlatAudio(flat: Sequence, want: (id: ID, f: number) => { gain: number; level: number } | null, tol = EXACT, frames?: (f: number) => boolean): number {
  let n = 0;
  for (const c of mediaClips(flat, 'audio')) {
    checkLists(c);
    for (let f = c.start; f < clipEnd(c); f++) {
      if (frames && !frames(f)) continue;
      const w = want(sourceId(c), f);
      if (!w) continue;
      near(c.audio.gain, w.gain, EXACT, `flattened ${c.id} @${f} gain`);
      near(evaluateClipProperty('volume', c, f), w.level, tol, `flattened ${c.id} @${f} level`);
      n++;
    }
  }
  return n;
}

const SETTINGS = fixtureSettings({ width: 1920, height: 1080, fps: R24 });
function graph(sequence: Sequence, sequences: Record<ID, Sequence> = {}, over: Partial<ExportSettings> = {}): string {
  return buildRenderGraph({ sequence, sequences, media: MEDIA, settings: { ...SETTINGS, ...over } }).filterGraph;
}
/** The keyframed-opacity commands of a filter graph (sendcmd + lut), with the lut names made comparable. */
function opacityCommands(g: string): string[] {
  return [...g.matchAll(/(?:sendcmd=c='[^']*',)?lut@kfo\d+=a='val\*[^']*'/g)].map((m) => m[0].replace(/lut@kfo\d+/g, 'lut@kfo'));
}

// ------------------------------------------------------------------------------- (a) inner keys, trimmed nested clip

describe('keyframes on inner clips', () => {
  /**
   * Inner I: a [0,96) A@10 keyed x / y / opacity, b [96,144) B@5 without keys. Outer O: x [0,24) C, then N = I from inner
   * frame 30 for 90 frames. Flat F: a at 24 from A@10+30/24 with its keyframes shifted by -30 (by hand), b at 90.
   */
  function scene() {
    const I = mkSeq('I');
    const a = clip('a', 'A', 0, 96, 10, { transform: keyed({ x: [kf(0, -200), kf(48, 200, 'ease'), kf(96, 0)], y: [kf(0, 50), kf(96, -50)], opacity: [kf(10, 0), kf(40, 1), kf(80, 0.25)] }) });
    put(I.videoTracks[0], a, clip('b', 'B', 96, 48, 5));
    const O = mkSeq('O');
    const N = nested('N', 'I', 24, 90, 30 / 24);
    put(O.videoTracks[0], clip('x', 'C', 0, 24, 0), N);
    const F = mkSeq('F');
    put(F.videoTracks[0], clip('x', 'C', 0, 24, 0),
      clip('a', 'A', 24, 66, 10 + 30 / 24, { transform: keyed({ x: [kf(-30, -200), kf(18, 200, 'ease'), kf(66, 0)], y: [kf(-30, 50), kf(66, -50)], opacity: [kf(-20, 0), kf(10, 1), kf(50, 0.25)] }) }),
      clip('b', 'B', 90, 24, 5));
    return { I, O, F, N, a, sequences: { I, O } as Record<ID, Sequence> };
  }

  it('(a) a nested clip trimmed into a keyed clip plays its keyframes shifted, frame for frame', () => {
    const { I, O, F, N, a, sequences } = scene();
    const flat = flattenSequence(O, sequences, MEDIA);
    for (let f = 0; f < 118; f++) sameLayers(layers(flat, f), layers(F, f), `planner @${f}`);
    // The values the render graph evaluates on the flattened clips.
    const n = checkFlatVideo(flat, (id, f) => (id === 'a' ? compose(at(N, f), at(a, innerPos(N, f, O.fps, I.fps)), 'A', I, O) : null));
    expect(n).toBe(66);
    // Spot values by hand: outer 24 = inner clip frame 30, outer 42 = inner 48 (the ease keyframe), outer 90 = past a.
    const fa = byId(mediaClips(flat, 'video'), 'a');
    expect(evaluateClipProperty('x', fa, 24)).toBeCloseTo(evaluateKeyframes(a.transform.keyframes!.x!, 30), 9);
    expect(evaluateClipProperty('x', fa, 42)).toBeCloseTo(200, 9);
    expect(evaluateClipProperty('opacity', fa, 34)).toBeCloseTo(1, 9);
    expect(evaluateClipProperty('opacity', fa, 74)).toBeCloseTo(0.25, 9);
    // Clips without keyframes on either side come through as before: no keyframes key at all.
    for (const id of ['b', 'x']) expect(byId(mediaClips(flat, 'video'), id).transform).not.toHaveProperty('keyframes');
  });

  it('(a) an export range that starts inside the nested clip sends the same opacity per frame as the flat timeline', () => {
    const { O, F, sequences, a } = scene();
    for (const s of [O, F]) { s.view.inPoint = 50; s.view.outPoint = 100; }
    const gN = graph(O, sequences, { rangeMode: 'inOut' });
    const gF = graph(F, {}, { rangeMode: 'inOut' });
    expect(gN).toContain('perspective=');
    const cN = opacityCommands(gN), cF = opacityCommands(gF);
    expect(cN).toHaveLength(1);
    expect(cN).toEqual(cF);
    // The range's first frame (50) is inner clip frame 56: opacity 1 - 0.75 * 16/40 = 0.7, quantized to 1/1024.
    const q = Math.round(evaluateKeyframes(a.transform.keyframes!.opacity!, 56) * 1024) / 1024;
    expect(cN[0]).toContain(`lut@kfo=a='val*${exprNum(q)}'`);
  });

  it('clips without keyframes on either side get no keyframes key (video and audio)', () => {
    const I = mkSeq('I');
    put(I.videoTracks[0], clip('a', 'A', 0, 48, 10, { transform: { ...defaultTransform(), x: 40, opacity: 0.5 } }), clip('b', 'B', 48, 48, 5));
    put(I.audioTracks[0], clip('aa', 'A', 0, 96, 10, { kind: 'audio', audio: { ...defaultAudio(), volume: 0.5 } }));
    const O = mkSeq('O');
    put(O.videoTracks[0], nested('N', 'I', 0, 80, 0.5, { linkId: 'L', transform: { ...defaultTransform(), scale: 0.8 } }));
    put(O.audioTracks[0], nested('Na', 'I', 0, 80, 0.5, { linkId: 'L', kind: 'audio', audio: { ...defaultAudio(), volume: 0.8 } }));
    const flat = flattenSequence(O, { I, O }, MEDIA);
    const v = mediaClips(flat, 'video'), au = mediaClips(flat, 'audio');
    expect(v).toHaveLength(2);
    expect(au).toHaveLength(1);
    for (const c of v) expect(c.transform).not.toHaveProperty('keyframes');
    for (const c of au) expect(c.audio).not.toHaveProperty('keyframes');
    expect(graph(O, { I, O })).not.toMatch(/perspective|sendcmd|lut@|asetnsamples/);
  });
});

// ------------------------------------------------------------------------------- (b) keys on the nested clip

describe('keyframes on the nested clip', () => {
  for (const rotation of [0, 30]) {
    it(`(b) N keyed for position, scale and opacity over static offset layers, N rotation ${rotation}°: composed per frame, still cut to the inner frame`, () => {
      // Inner 1280x720 (fit 1.5 into the outer frame), two tracks of static, offset layers.
      const I = mkSeq('I', R24, 1280, 720);
      const a = clip('a', 'A', 0, 48, 10, { transform: { ...defaultTransform(), x: 100, y: -50, scale: 0.5, crop: { left: 0.1, top: 0, right: 0, bottom: 0.05 } } });
      const b = clip('b', 'B', 48, 48, 5, { transform: { ...defaultTransform(), x: -300 } }); // 300 px past the inner frame's left edge
      const c = clip('c', 'C', 0, 96, 0, { transform: { ...defaultTransform(), x: 400, y: 200, scale: 0.25, opacity: 0.5 } });
      put(I.videoTracks[0], a, b);
      put(I.videoTracks[1], c);
      const O = mkSeq('O');
      const N = nested('N', 'I', 10, 96, 0, {
        transform: keyed({
          x: [kf(0, 0), kf(40, 150, 'ease'), kf(95, -60)], y: [kf(0, 20), kf(95, -20)],
          scale: [kf(0, 1), kf(30, 0.6), kf(95, 1.2, 'ease')], opacity: [kf(0, 1), kf(20, 0.3), kf(60, 1)],
        }, { rotation, crop: { left: 0.05, top: 0.1, right: 0, bottom: 0 } }),
      });
      put(O.videoTracks[0], N);
      const src: Record<ID, Clip> = { a, b, c };
      // Static inner layers are cut to the inner frame edge and N's crop as without keyframes (N's motion moves the cut picture).
      const cut = (id: ID) => composeTransform(N.transform, src[id].transform, MEDIA[src[id].mediaId], I, O)!.crop;
      const want = (id: ID, f: number) => (src[id] ? compose(at(N, f), src[id].transform, src[id].mediaId, I, O, cut(id)) : null);
      const F = mkSeq('F');
      put(F.videoTracks[0], sampledVideo('a', 'A', 10, 48, 10, (f) => want('a', f)!), sampledVideo('b', 'B', 58, 48, 5, (f) => want('b', f)!));
      put(F.videoTracks[1], sampledVideo('c', 'C', 10, 96, 0, (f) => want('c', f)!));
      const flat = flattenSequence(O, { I, O }, MEDIA);
      for (let f = 8; f < 108; f++) sameLayers(layers(flat, f), layers(F, f), `planner @${f}`);
      expect(checkFlatVideo(flat, want)).toBe(96 * 2);
      // By hand at N's keyframe frames: rotation adds, opacity multiplies, the offset turns with N.
      const fa = byId(mediaClips(flat, 'video'), 'a');
      const r = (rotation * Math.PI) / 180;
      // Frame 40 = N clip frame 30: N scale 0.6, N x 150 × 30/40; a's offset (100, -50) turned by N, × 0.6 × fit 1.5.
      expect(evaluateClipProperty('x', fa, 40)).toBeCloseTo(112.5 + 0.6 * 1.5 * (100 * Math.cos(r) + 50 * Math.sin(r)), 6);
      expect(evaluateClipProperty('scale', fa, 40)).toBeCloseTo(0.6 * 0.5, 9);
      expect(evaluateClipProperty('opacity', fa, 30)).toBeCloseTo(0.3, 9);
      expect(evaluateClipProperty('opacity', byId(mediaClips(flat, 'video'), 'c'), 30)).toBeCloseTo(0.15, 9);
      expect(fa.transform.rotation).toBe(rotation);
      // Cut to the inner frame edge and the nested crop: b (300 px past the inner frame's left edge) loses its left part.
      for (const x of mediaClips(flat, 'video')) expect(x.transform.crop).toEqual(cut(sourceId(x)));
      expect(byId(mediaClips(flat, 'video'), 'b').transform.crop.left).toBeGreaterThan(0.2);
      expect(graph(O, { I, O })).toContain('perspective=');
    });
  }
});

// ------------------------------------------------------------------------------- (c) both sides, ease

describe('keyframes on both sides', () => {
  it('(c) inner and nested clip both keyed with ease: the composition, exact at every frame', () => {
    const I = mkSeq('I');
    const a = clip('a', 'A', 0, 96, 10, {
      transform: keyed({
        x: [kf(0, -150, 'ease'), kf(60, 150), kf(95, 0)], scale: [kf(0, 0.5, 'ease'), kf(95, 1)],
        opacity: [kf(0, 0.2), kf(50, 1, 'ease'), kf(95, 0.6)],
      }, { y: 30 }),
    });
    put(I.videoTracks[0], a);
    const O = mkSeq('O');
    const N = nested('N', 'I', 0, 72, 12 / 24, {
      transform: keyed({
        x: [kf(0, 50, 'ease'), kf(71, -50)], y: [kf(10, 0, 'ease'), kf(60, 40)],
        scale: [kf(0, 1.2, 'ease'), kf(36, 0.8, 'ease'), kf(71, 1)], opacity: [kf(0, 1, 'ease'), kf(71, 0.3)],
      }, { rotation: 10 }),
    });
    put(O.videoTracks[0], N);
    const want = (id: ID, f: number) => (id === 'a' ? compose(at(N, f), at(a, innerPos(N, f, O.fps, I.fps)), 'A', I, O) : null);
    const F = mkSeq('F');
    put(F.videoTracks[0], sampledVideo('a', 'A', 0, 72, 10.5, (f) => want('a', f)!));
    const flat = flattenSequence(O, { I, O }, MEDIA);
    for (let f = 0; f < 74; f++) sameLayers(layers(flat, f), layers(F, f), `planner @${f}`);
    expect(checkFlatVideo(flat, want)).toBe(72);
    // Opacity = N(t) × inner(t): outer 38 = inner 50 (inner opacity 1, N eased part-way).
    const fa = byId(mediaClips(flat, 'video'), 'a');
    expect(evaluateClipProperty('opacity', fa, 38)).toBeCloseTo(evaluateKeyframes(N.transform.keyframes!.opacity!, 38), 9);
    expect(graph(O, { I, O })).toMatch(/perspective=[\s\S]*sendcmd=/);
  });
});

// ------------------------------------------------------------------------------- (d) level

describe('level keyframes', () => {
  it('(d) volume keys inside and on the nested clip, inner track volume 0.5: level = inner × N × track', () => {
    const I = mkSeq('I');
    I.audioTracks[0].volume = 0.5;
    const aa = clip('aa', 'A', 0, 96, 10, { kind: 'audio', audio: vol([kf(0, 1), kf(48, 0.2, 'ease'), kf(96, 1.5)], { gain: -3 }) });
    const ac = clip('ac', 'B', 0, 96, 0, { kind: 'audio' }); // static, on a full-volume track
    put(I.audioTracks[0], aa);
    put(I.audioTracks[1], ac);
    const O = mkSeq('O');
    const Na = nested('Na', 'I', 24, 72, 12 / 24, { kind: 'audio', audio: vol([kf(0, 0.5), kf(36, 2, 'ease'), kf(71, 1)], { gain: 2 }) });
    put(O.audioTracks[0], Na);
    const levelOf = (id: ID, f: number) => {
      const p = innerPos(Na, f, O.fps, I.fps);
      const n = evaluateClipProperty('volume', Na, f);
      if (id === 'aa') return { gain: -1, level: evaluateClipProperty('volume', aa, p) * n * 0.5 };
      if (id === 'ac') return { gain: 2, level: n };
      return null;
    };
    const F = mkSeq('F');
    put(F.audioTracks[0], sampledAudio('aa', 'A', 24, 72, 10.5, -1, (f) => levelOf('aa', f)!.level));
    put(F.audioTracks[1], sampledAudio('ac', 'B', 24, 72, 0.5, 2, (f) => levelOf('ac', f)!.level));
    const flat = flattenSequence(O, { I, O }, MEDIA);
    for (let f = 20; f < 100; f++) sameSounds(sounds(flat, f), sounds(F, f), `planner audio @${f}`);
    expect(checkFlatAudio(flat, levelOf)).toBe(144);
    // By hand: outer 60 = inner 48 (0.2) × N at clip frame 36 (2) × 0.5, at -1 dB.
    const s = sounds(flat, 60).find((x) => x.mediaId === 'A')!;
    expect(s.level).toBeCloseTo(dbToLinear(-1) * 0.2 * 2 * 0.5, 9);
    expect(graph(O, { I, O })).toMatch(/asetnsamples=n=256:p=0,volume=volume='/);
  });
});

// ------------------------------------------------------------------------------- (e) frame rates

describe('keyframes across frame rates', () => {
  it('(e) a 25 fps inner sequence in a 24 fps one: inner keyframes rescaled by 24/25, the nested clip\'s keys in outer frames', () => {
    const I = mkSeq('I', R25);
    const a = clip('a', 'A', 0, 100, 10, { transform: keyed({ x: [kf(0, -100), kf(50, 100, 'ease'), kf(100, 0)], opacity: [kf(25, 0.2), kf(75, 1)] }) });
    const aa = clip('aa', 'A', 0, 100, 10, { kind: 'audio', audio: vol([kf(0, 1), kf(50, 0.25), kf(100, 1)]) });
    put(I.videoTracks[0], a);
    put(I.audioTracks[0], aa);
    const O = mkSeq('O');
    // From 1 s of the inner timeline: inner clip frames 25, 50, 75 land on outer frames 10, 34, 58.
    const N = nested('N', 'I', 10, 72, 1, { linkId: 'L', transform: keyed({ y: [kf(0, -20), kf(24, 20), kf(71, 0)] }) });
    put(O.videoTracks[0], N);
    put(O.audioTracks[0], nested('Na', 'I', 10, 72, 1, { linkId: 'L', kind: 'audio' }));
    // Flat 24 fps reference, rescaled by hand: inner clip frame k is outer clip frame (k - 25) × 24/25.
    const F = mkSeq('F');
    put(F.videoTracks[0], clip('a', 'A', 10, 72, 11, { transform: keyed({ x: [kf(-24, -100), kf(24, 100, 'ease'), kf(72, 0)], opacity: [kf(0, 0.2), kf(48, 1)], y: [kf(0, -20), kf(24, 20), kf(71, 0)] }) }));
    put(F.audioTracks[0], clip('aa', 'A', 10, 72, 11, { kind: 'audio', audio: vol([kf(-24, 1), kf(24, 0.25), kf(72, 1)]) }));
    const k = (f: number) => innerPos(N, f, O.fps, I.fps); // = inner clip frame (a starts at 0)
    expect(k(34)).toBeCloseTo(50, 9);
    const want = (id: ID, f: number) => (id === 'a' ? compose(at(N, f), at(a, k(f)), 'A', I, O) : null);
    const flat = flattenSequence(O, { I, O }, MEDIA);
    const KEYS = new Set([10, 34, 58]);
    // Loose between keyframes (2 % of each property's range), exact on them; N's own keys are exact everywhere.
    const loose = { x: 4, y: EXACT, opacity: 0.016, scale: EXACT, rotation: EXACT };
    for (let f = 10; f < 82; f++) {
      const tol = KEYS.has(f) ? EXACT : loose;
      sameLayers(layers(flat, f), layers(F, f), `planner @${f}`, tol);
      sameSounds(sounds(flat, f), sounds(F, f), `planner audio @${f}`, KEYS.has(f) ? EXACT : 0.015);
    }
    expect(checkFlatVideo(flat, want, EXACT, (f) => KEYS.has(f))).toBe(3);
    expect(checkFlatVideo(flat, want, loose)).toBe(72);
    const levelOf = (id: ID, f: number) => (id === 'aa' ? { gain: 0, level: evaluateClipProperty('volume', aa, k(f)) } : null);
    expect(checkFlatAudio(flat, levelOf, EXACT, (f) => KEYS.has(f))).toBe(3);
    expect(checkFlatAudio(flat, levelOf, 0.015)).toBe(72);
    // By hand on the keyframe frames.
    const fa = byId(mediaClips(flat, 'video'), 'a');
    expect(evaluateClipProperty('x', fa, 34)).toBeCloseTo(100, 6);
    expect(evaluateClipProperty('opacity', fa, 58)).toBeCloseTo(1, 6);
    expect(evaluateClipProperty('y', fa, 34)).toBeCloseTo(20, 9);
    expect(evaluateClipProperty('volume', byId(mediaClips(flat, 'audio'), 'aa'), 34)).toBeCloseTo(0.25, 6);
    graph(O, { I, O });
  });
});

// ------------------------------------------------------------------------------- (f) transitions at a nested edge

describe('keyframes next to transitions at a nested clip\'s edges', () => {
  it('(f) keyed clips extended into transition handles keep their keyframes on the same frames', () => {
    // Inner: a [0,96) A@10 keyed; aa its keyed audio.
    const I = mkSeq('I');
    const a = clip('a', 'A', 0, 96, 10, { transform: keyed({ x: [kf(0, -96), kf(96, 96)], opacity: [kf(20, 0.5), kf(30, 1)] }) });
    const aa = clip('aa', 'A', 0, 96, 10, { kind: 'audio', audio: vol([kf(0, 0.5), kf(96, 1.5)]) });
    put(I.videoTracks[0], a);
    put(I.audioTracks[0], aa);
    // Outer: y [0,24) C keyed, N [24,72) from inner frame 24, x [72,120) D@2 keyed; 8-frame dissolves / crossfades at
    // both of N's edges (4 frames each side: y and N's inner layer run 4 frames past their cut, x 4 frames before).
    const O = mkSeq('O');
    const y = clip('y', 'C', 0, 24, 0, { transform: keyed({ x: [kf(0, 0), kf(23, 50)] }) });
    const x = clip('x', 'D', 72, 48, 2, { transform: keyed({ x: [kf(0, -40), kf(47, 40)], opacity: [kf(0, 0), kf(8, 1)] }) });
    const ya = clip('ya', 'C', 0, 24, 0, { kind: 'audio', audio: vol([kf(0, 1), kf(23, 0.4)]) });
    const xa = clip('xa', 'D', 72, 48, 2, { kind: 'audio', audio: vol([kf(0, 0.2), kf(47, 1)]) });
    const N = nested('N', 'I', 24, 48, 1, { linkId: 'L' });
    const Na = nested('Na', 'I', 24, 48, 1, { linkId: 'L', kind: 'audio' });
    put(O.videoTracks[0], y, N, x);
    put(O.audioTracks[0], ya, Na, xa);
    O.videoTracks[0].transitions.push(tr('t1', 'crossDissolve', 8, 'y', 'N'), tr('t2', 'crossDissolve', 8, 'N', 'x'));
    O.audioTracks[0].transitions.push(tr('t3', 'audioCrossfade', 8, 'ya', 'Na'), tr('t4', 'audioCrossfade', 8, 'Na', 'xa'));
    // Flat: the inner clip placed at 24 from A@11, keyframes shifted by -24 by hand.
    const F = mkSeq('F');
    const fa = clip('a', 'A', 24, 48, 11, { transform: keyed({ x: [kf(-24, -96), kf(72, 96)], opacity: [kf(-4, 0.5), kf(6, 1)] }) });
    const faa = clip('aa', 'A', 24, 48, 11, { kind: 'audio', audio: vol([kf(-24, 0.5), kf(72, 1.5)]) });
    put(F.videoTracks[0], { ...y }, fa, { ...x });
    put(F.audioTracks[0], { ...ya }, faa, { ...xa });
    F.videoTracks[0].transitions.push(tr('t1', 'crossDissolve', 8, 'y', 'a'), tr('t2', 'crossDissolve', 8, 'a', 'x'));
    F.audioTracks[0].transitions.push(tr('t3', 'audioCrossfade', 8, 'ya', 'aa'), tr('t4', 'audioCrossfade', 8, 'aa', 'xa'));
    const flat = flattenSequence(O, { I, O }, MEDIA);
    for (let f = 0; f < 122; f++) {
      sameLayers(layers(flat, f), layers(F, f), `planner @${f}`);
      sameSounds(sounds(flat, f), sounds(F, f), `planner audio @${f}`);
    }
    // The flattened clips cover the handles: their keyframes evaluate where the source clip's would.
    const vids = mediaClips(flat, 'video');
    expect(byId(vids, 'x').start).toBe(68);
    expect(byId(vids, 'a').start).toBe(20);
    const want = (id: ID, f: number) => {
      if (id === 'a') return compose(at(N, f), at(a, innerPos(N, f, O.fps, I.fps)), 'A', I, O);
      if (id === 'x') return at(x, f);
      if (id === 'y') return at(y, f);
      return null;
    };
    expect(checkFlatVideo(flat, want)).toBe(28 + 56 + 52);
    expect(evaluateClipProperty('x', byId(vids, 'x'), 68)).toBeCloseTo(-40, 9); // before x's first keyframe: held
    expect(evaluateClipProperty('x', byId(vids, 'x'), 72)).toBeCloseTo(-40, 9);
    expect(evaluateClipProperty('opacity', byId(vids, 'x'), 76)).toBeCloseTo(0.5, 9);
    expect(evaluateClipProperty('x', byId(vids, 'a'), 20)).toBeCloseTo(2 * 20 - 96, 9); // inner frame 20, in the handle
    const levelOf = (id: ID, f: number) => {
      if (id === 'aa') return { gain: 0, level: evaluateClipProperty('volume', aa, innerPos(Na, f, O.fps, I.fps)) };
      if (id === 'xa') return { gain: 0, level: evaluateClipProperty('volume', xa, f) };
      if (id === 'ya') return { gain: 0, level: evaluateClipProperty('volume', ya, f) };
      return null;
    };
    expect(checkFlatAudio(flat, levelOf)).toBe(28 + 56 + 52);
    graph(O, { I, O });
  });
});

// ------------------------------------------------------------------------------- (g) two levels

describe('keyframes two levels deep', () => {
  it('(g) keys at each level compose through both nested clips', () => {
    const I = mkSeq('I');
    const a = clip('a', 'A', 0, 96, 10, { transform: keyed({ x: [kf(0, -100), kf(95, 100)] }, { crop: { left: 0.05, top: 0, right: 0.05, bottom: 0 } }) });
    put(I.videoTracks[0], a);
    const O = mkSeq('O');
    const N = nested('N', 'I', 0, 96, 0, { transform: keyed({ opacity: [kf(0, 0.2), kf(48, 1)], y: [kf(0, -30), kf(95, 30)] }) });
    put(O.videoTracks[0], N);
    const T = mkSeq('T');
    const M = nested('M', 'O', 12, 60, 1, { transform: keyed({ scale: [kf(0, 1), kf(59, 0.5, 'ease')], x: [kf(0, 0), kf(59, 80)] }, { rotation: 15 }) });
    put(T.videoTracks[0], M);
    const want = (id: ID, f: number) => {
      if (id !== 'a') return null;
      const fO = innerPos(M, f, T.fps, O.fps);
      const l1 = compose(at(N, fO), at(a, innerPos(N, fO, O.fps, I.fps)), 'A', I, O);
      return compose(at(M, f), l1, 'A', O, T, a.transform.crop);
    };
    const F = mkSeq('F');
    put(F.videoTracks[0], sampledVideo('a', 'A', 12, 60, 11, (f) => want('a', f)!));
    const sequences = { I, O, T };
    const flat = flattenSequence(T, sequences, MEDIA);
    for (let f = 10; f < 74; f++) sameLayers(layers(flat, f), layers(F, f), `planner @${f}`);
    expect(checkFlatVideo(flat, want)).toBe(60);
    const fa = byId(mediaClips(flat, 'video'), 'a');
    expect(flatOrigin(fa)!.path).toEqual(['M', 'N']);
    // By hand at T frame 36 (O frame 48 = inner 48): opacity N = 1, scale M eased half-way.
    expect(evaluateClipProperty('opacity', fa, 12)).toBeCloseTo(evaluateKeyframes(N.transform.keyframes!.opacity!, 24), 9);
    expect(evaluateClipProperty('scale', fa, 36)).toBeCloseTo(evaluateKeyframes(M.transform.keyframes!.scale!, 24), 9);
    expect(fa.transform.rotation).toBe(15);
    graph(T, sequences);
  });
});

// ------------------------------------------------------------------------------- (h) the cap

describe('long clips with both sides animated', () => {
  it(`(h) at most ${MAX_KEYFRAMES_PER_PROPERTY} keyframes per property, close to the composition, and the export graph builds`, () => {
    const L = 3000;
    const I = mkSeq('I');
    const a = clip('a', 'A', 0, L, 0, { transform: keyed({ x: [kf(0, -300, 'ease'), kf(L - 1, 300)], opacity: [kf(0, 0.5), kf(L - 1, 1)] }) });
    const aa = clip('aa', 'A', 0, L, 0, { kind: 'audio', audio: vol([kf(0, 0.5), kf(L - 1, 1.5)]) });
    put(I.videoTracks[0], a);
    put(I.audioTracks[0], aa);
    const O = mkSeq('O');
    const N = nested('N', 'I', 0, L, 0, { linkId: 'L', transform: keyed({ scale: [kf(0, 1), kf(L - 1, 0.5)], x: [kf(0, 0), kf(L - 1, 100)], opacity: [kf(0, 1), kf(L - 1, 0.4)] }) });
    const Na = nested('Na', 'I', 0, L, 0, { linkId: 'L', kind: 'audio', audio: vol([kf(0, 1), kf(L - 1, 0.5)]) });
    put(O.videoTracks[0], N);
    put(O.audioTracks[0], Na);
    const flat = flattenSequence(O, { I, O }, MEDIA);
    const fa = byId(mediaClips(flat, 'video'), 'a'), faa = byId(mediaClips(flat, 'audio'), 'aa');
    for (const p of TRANSFORM_KEY_PROPS) expect(fa.transform.keyframes?.[p]?.length ?? 0, p).toBeLessThanOrEqual(MAX_KEYFRAMES_PER_PROPERTY);
    expect(fa.transform.keyframes?.x?.length ?? 0).toBeGreaterThan(1);
    expect(faa.audio.keyframes?.volume?.length ?? 0).toBeGreaterThan(1);
    expect(faa.audio.keyframes!.volume!.length).toBeLessThanOrEqual(MAX_KEYFRAMES_PER_PROPERTY);
    // Strided samples of smooth curves: well within a hundredth of a pixel / a ten-thousandth of opacity or level.
    const want = (id: ID, f: number) => (id === 'a' ? compose(at(N, f), at(a, f), 'A', I, O) : null);
    expect(checkFlatVideo(flat, want, { x: 0.01, y: 0.01, scale: 1e-4, opacity: 1e-4, rotation: EXACT })).toBe(L);
    const levelOf = (id: ID, f: number) => (id === 'aa' ? { gain: 0, level: evaluateClipProperty('volume', aa, f) * evaluateClipProperty('volume', Na, f) } : null);
    expect(checkFlatAudio(flat, levelOf, 1e-4)).toBe(L);
    // The first and last frames are exact.
    for (const f of [0, L - 1]) {
      const w = want('a', f)!;
      near(evaluateClipProperty('x', fa, f), w.x, EXACT, `x @${f}`);
      near(evaluateClipProperty('opacity', fa, f), w.opacity, EXACT, `opacity @${f}`);
    }
    // The export's filter script builds (per-frame motion, opacity commands and level expression).
    const g = graph(O, { I, O });
    expect(g).toContain('perspective=');
    expect(g).toContain('sendcmd=');
    expect(g).toMatch(/volume=volume='st\(0,/);
  });
});
