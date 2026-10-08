/**
 * The flattened size limit of nested sequences (shared/nest.ts MAX_FLAT_TRACKS / MAX_FLAT_CLIPS, beside
 * MAX_NEST_DEPTH): the size computation (flattenedSize) against what flattenSequence really makes, nestProblem's
 * 'size' reason, the store paths that create nested clips, the load repair (deterministic, stable, no clip lost), a
 * realistic season-scale project that stays legal, and flattening time at the limits.
 * bugs/closed/2026-10-08-nested-fan-out-flatten-blowup.md
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Clip, ID, MediaItem, Project, Rational, Sequence, Track, Transition } from '../../shared/model';
import { createMediaItem, createProject, createSequence, normalizeProjectWithReport } from '../../shared/project';
import { allTracks, defaultAudio, defaultTransform, makeTrack } from '../../shared/timeline';
import {
  FLAT_LIMIT_TEXT, flattenSequence, flattenedSize, MAX_FLAT_CLIPS, MAX_FLAT_TRACKS, MAX_NEST_DEPTH, nestLimitProblem, nestProblem, nestProblemText,
  nestSizeRepairs, nestingRepairs,
} from '../../shared/nest';
import { useStore, resetStore } from '../../src/state/store';

const R24: Rational = { num: 24, den: 1 };
const R25: Rational = { num: 25, den: 1 };
const NTSC: Rational = { num: 30000, den: 1001 };

function media(id: string, dur = 3600): MediaItem {
  return {
    ...createMediaItem(`/media/${id}.mp4`, id), id, kind: 'video',
    probe: {
      container: 'mp4', duration: dur, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: R24, avgFps: R24, isVfr: false },
    },
  };
}
const MEDIA: Record<ID, MediaItem> = { M: media('M'), N: media('N') };

let nextId = 0;
function clip(mediaId: string, start: number, duration: number, over: Partial<Clip> = {}): Clip {
  return {
    id: `c${nextId++}`, mediaId, name: mediaId, start, duration, sourceIn: 0, speed: 1, linkId: null, enabled: true, kind: 'video',
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '', ...over,
  };
}
function nested(child: string, start: number, duration: number, over: Partial<Clip> = {}): Clip {
  return clip(child, start, duration, { sequenceId: child, name: `nest ${child}`, ...over });
}
function mkSeq(id: string, v = 1, a = 1, fps: Rational = R24): Sequence {
  const track = (kind: 'video' | 'audio', i: number): Track => ({ ...makeTrack(kind, i + 1), id: `${id}${kind === 'video' ? 'V' : 'A'}${i + 1}` });
  const s = createSequence(id, fps);
  s.id = id;
  s.videoTracks = Array.from({ length: v }, (_, i) => track('video', i));
  s.audioTracks = Array.from({ length: a }, (_, i) => track('audio', i));
  return s;
}
function put(t: Track, ...clips: Clip[]): void {
  for (const c of clips) { c.kind = t.kind; t.clips.push(c); }
  t.clips.sort((x, y) => x.start - y.start);
}
const record = (...seqs: Sequence[]): Record<ID, Sequence> => Object.fromEntries(seqs.map((s) => [s.id, s]));

/** Tracks and clips of what flattenSequence really makes. */
function actual(seq: Sequence, seqs: Record<ID, Sequence>): { tracks: number; clips: number } {
  const f = flattenSequence(seq, seqs, MEDIA);
  return { tracks: f.videoTracks.length + f.audioTracks.length, clips: allTracks(f).reduce((n, t) => n + t.clips.length, 0) };
}

/** Levels L0..L(depth): each nests the next on every one of its K video tracks; the last holds one media clip per track. */
function fanOut(K: number, depth: number, leafClips = 1): Sequence[] {
  const seqs = Array.from({ length: depth + 1 }, (_, i) => mkSeq(`L${i}`, K, 1));
  for (let i = 0; i < depth; i++) for (const t of seqs[i].videoTracks) put(t, nested(`L${i + 1}`, 0, 48 * leafClips));
  for (const t of seqs[depth].videoTracks) for (let j = 0; j < leafClips; j++) put(t, clip('M', 48 * j, 48, { sourceIn: j * 2 }));
  return seqs;
}

function projectOf(seqs: Sequence[]): Project {
  const p = createProject('size');
  p.media = { ...MEDIA };
  p.sequences = record(...seqs);
  p.sequenceOrder = seqs.map((s) => s.id);
  p.activeSequenceId = seqs[0].id;
  return p;
}
const cloneRaw = (p: Project) => JSON.parse(JSON.stringify(p)) as unknown;
const clipTotal = (p: Project) => Object.values(p.sequences).reduce((n, s) => n + allTracks(s).reduce((k, t) => k + t.clips.length, 0), 0);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------- size computation

describe('flattenedSize', () => {
  it('is the sequence itself without nesting', () => {
    const s = mkSeq('S', 2, 2);
    put(s.videoTracks[0], clip('M', 0, 10), clip('M', 10, 10));
    put(s.audioTracks[1], clip('M', 0, 10));
    expect(flattenedSize(record(s), 'S')).toEqual({ tracks: 4, clips: 3 });
    expect(actual(s, record(s))).toEqual({ tracks: 4, clips: 3 });
    expect(flattenedSize({}, 'nope')).toEqual({ tracks: 0, clips: 0 });
  });

  it('equals what flattenSequence makes for a fan-out, at every level', () => {
    const seqs = fanOut(3, 4, 2);
    const rec = record(...seqs);
    for (const s of seqs) expect(flattenedSize(rec, s.id), s.id).toEqual(actual(s, rec));
    // 3 tracks per level: t(L4) = 3, t(Li) = 3 (1 + t(Li+1)): 3, 12, 39, 120, 363 video tracks (+ 1 audio track each).
    expect(flattenedSize(rec, 'L0').tracks).toBe(364);
  });

  it('counts a nested sequence cut into many pieces about once (the clips each piece plays)', () => {
    const inner = mkSeq('I', 1, 1);
    for (let j = 0; j < 100; j++) put(inner.videoTracks[0], clip('M', 10 * j, 10, { sourceIn: j }));
    const host = mkSeq('H', 1, 1);
    // The inner timeline (1000 frames) razored into 50 pieces of 20 frames, in order.
    for (let k = 0; k < 50; k++) put(host.videoTracks[0], nested('I', 20 * k, 20, { sourceIn: (20 * k) / 24 }));
    const rec = record(inner, host);
    const size = flattenedSize(rec, 'H');
    expect(size).toEqual(actual(host, rec));
    expect(size.clips).toBe(50 + 100); // the placeholders and each inner clip once
    expect(size.tracks).toBe(1 + 1 + 1); // H V1 + one group of the inner V1 + H A1
  });

  it('is never less than what flattenSequence makes (random nested projects: transitions, frame rates, disabled clips, mutes)', () => {
    const rates = [R24, R25, NTSC];
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const n = 3 + Math.floor(r() * 4);
      const seqs = Array.from({ length: n }, (_, i) => mkSeq(`S${seed}-${i}`, 1 + Math.floor(r() * 3), 1 + Math.floor(r() * 2), rates[Math.floor(r() * 3)]));
      for (let i = n - 1; i >= 0; i--) {
        const s = seqs[i];
        for (const t of allTracks(s)) {
          let f = Math.floor(r() * 5);
          let prev: Clip | null = null;
          const count = Math.floor(r() * 6);
          for (let j = 0; j < count; j++) {
            const dur = 4 + Math.floor(r() * 40);
            const nest = i + 1 < n && r() < 0.5;
            const c = nest
              ? nested(seqs[i + 1 + Math.floor(r() * (n - i - 1))].id, f, dur, { sourceIn: r() * 2 })
              : clip(r() < 0.5 ? 'M' : 'N', f, dur, { sourceIn: 1 + r() * 20 });
            if (r() < 0.1) c.enabled = false;
            put(t, c);
            if (prev && prev.start + prev.duration === f && r() < 0.6) {
              const types: Transition['type'][] = t.kind === 'video' ? ['crossDissolve', 'dipToBlack'] : ['audioCrossfade', 'crossDissolve'];
              t.transitions.push({ id: `${c.id}-tr`, type: types[Math.floor(r() * 2)], duration: 2 + Math.floor(r() * 16), outClipId: prev.id, inClipId: c.id });
            }
            prev = c;
            f += dur + (r() < 0.5 ? 0 : Math.floor(r() * 10));
          }
          if (r() < 0.1) t.muted = true;
          else if (r() < 0.05) t.solo = true;
        }
      }
      const rec = record(...seqs);
      for (const s of seqs) {
        const est = flattenedSize(rec, s.id), got = actual(s, rec);
        expect(est.tracks, `seed ${seed} ${s.id} tracks`).toBeGreaterThanOrEqual(got.tracks);
        expect(est.clips, `seed ${seed} ${s.id} clips`).toBeGreaterThanOrEqual(got.clips);
      }
    }
  });

  it('does not change when a clip is disabled or a track muted (the limit cannot be dodged by toggling)', () => {
    const seqs = fanOut(3, 3);
    const rec = record(...seqs);
    const before = flattenedSize(rec, 'L0');
    seqs[1].videoTracks[0].muted = true;
    seqs[0].videoTracks[1].clips[0].enabled = false;
    const rec2 = record(...seqs.map((s) => ({ ...s, videoTracks: [...s.videoTracks] })));
    expect(flattenedSize(rec2, 'L0')).toEqual(before);
    expect(actual(rec2.L0, rec2).tracks).toBeLessThan(before.tracks);
  });
});

// ------------------------------------------------------------------------------- nestProblem

describe("nestProblem: 'size'", () => {
  it('refuses a nest that would push the host past the track limit', () => {
    const wide = mkSeq('W', 600, 1); // 600 tracks of its own: legal, and 601 flattened
    put(wide.videoTracks[0], clip('M', 0, 10));
    const host = mkSeq('H', 1, 1);
    const rec = record(wide, host);
    expect(nestProblem(rec, 'H', 'W')).toBeNull();
    put(host.videoTracks[0], nested('W', 0, 10));
    const rec2 = record(wide, { ...host, videoTracks: [...host.videoTracks] });
    expect(flattenedSize(rec2, 'H').tracks).toBe(1 + 600 + 1);
    expect(nestProblem(rec2, 'H', 'W')).toBe('size');
    expect(nestProblemText('size')).toBe(`nesting would expand to more than ${FLAT_LIMIT_TEXT} when flattened`);
    expect(FLAT_LIMIT_TEXT).toBe('1,000 tracks or 50,000 clips');
  });

  it('refuses a nest that would push a sequence containing the host past the limit', () => {
    const d = mkSeq('D', 300, 1);
    put(d.videoTracks[0], clip('M', 0, 10));
    const h = mkSeq('H', 1, 1);
    put(h.videoTracks[0], nested('D', 0, 10));
    const g = mkSeq('G', 3, 1);
    for (const t of g.videoTracks) put(t, nested('H', 0, 10));
    const rec = record(d, h, g);
    expect(flattenedSize(rec, 'G').tracks).toBeLessThanOrEqual(MAX_FLAT_TRACKS);
    // H alone could take D again (about 600 tracks), but G shows H three times.
    expect(nestProblem({ ...rec, G: mkSeq('G', 3, 1) }, 'H', 'D')).toBeNull();
    expect(nestProblem(rec, 'H', 'D')).toBe('size');
    expect(nestLimitProblem(rec, 'H')).toBeNull();
  });

  it('refuses a nest past the clip limit', () => {
    const big = mkSeq('B', 1, 1);
    const n = Math.ceil(MAX_FLAT_CLIPS * 0.6);
    for (let j = 0; j < n; j++) big.videoTracks[0].clips.push(clip('M', j, 1));
    const host = mkSeq('H', 1, 1);
    put(host.videoTracks[0], nested('B', 0, n));
    const rec = record(big, host);
    expect(flattenedSize(rec, 'H').clips).toBe(1 + n);
    expect(nestProblem(rec, 'H', 'B')).toBe('size');
    // A short piece of it plays only the clips under it.
    const piece = nested('B', n + 10, 100, { sourceIn: 0 });
    expect(nestProblem(rec, 'H', 'B', [piece])).toBeNull();
  });

  it('checks missing, self, cycle and depth first, as before', () => {
    const a = mkSeq('a'), b = mkSeq('b');
    put(a.videoTracks[0], nested('b', 0, 10));
    put(b.videoTracks[0], clip('M', 0, 10));
    const rec = record(a, b);
    expect(nestProblem(rec, 'a', 'zz')).toBe('missing');
    expect(nestProblem(rec, 'a', 'a')).toBe('self');
    expect(nestProblem(rec, 'b', 'a')).toBe('cycle');
    expect(nestProblem(rec, 'a', 'b')).toBeNull();
  });
});

// ------------------------------------------------------------------------------- store paths

describe('store paths that create nested clips check the size limit', () => {
  const S = () => useStore.getState();
  beforeEach(() => {
    resetStore();
    S().addMedia([MEDIA.M]);
  });
  const add = (s: Sequence) => { S().addSequence(s); return s.id; };

  it('Nest Sequence and paste refuse past the limit, with the reason, measured on the placement itself', () => {
    const wide = mkSeq('W', 600, 1);
    put(wide.videoTracks[0], clip(MEDIA.M.id, 0, 10));
    add(wide);
    const host = add(mkSeq('H', 2, 1));
    expect(S().nestSequence(host, 'W', 0).length).toBe(1);
    // Later on the same track it shares the flattened tracks of the first one (602 tracks): allowed.
    expect(S().nestSequence(host, 'W', 100).length).toBe(1);
    // At the same time on V2 it needs 601 more tracks of its own.
    expect(S().nestSequence(host, 'W', 0, { videoTrackId: 'HV2' })).toEqual([]);
    expect(S().ui.toasts.at(-1)?.text).toBe(`Cannot nest the sequence here: nesting would expand to more than ${FLAT_LIMIT_TEXT} when flattened`);
    const placed = S().project.sequences.H.videoTracks[0].clips[0];
    expect(S().placeClipsAction(host, [{ trackId: 'HV1', clip: { ...placed, id: 'pasted', start: 200 } }], 'overwrite')).toBe(true);
    expect(S().placeClipsAction(host, [{ trackId: 'HV2', clip: { ...placed, id: 'pasted2', start: 0 } }], 'overwrite')).toBe(false);
    expect(S().ui.toasts.at(-1)?.text).toMatch(/^Cannot place "W": nesting would expand to more than 1,000 tracks/);
    expect(S().project.sequences.H.videoTracks[0].clips.length).toBe(3);
    expect(S().project.sequences.H.videoTracks[1].clips.length).toBe(0);
  });

  it('Make Compound Clip refuses a compound that would nest too deep (it did not check before)', () => {
    const seqs = Array.from({ length: MAX_NEST_DEPTH + 1 }, (_, i) => mkSeq(`s${i}`, 1, 1));
    for (let i = 0; i < MAX_NEST_DEPTH; i++) put(seqs[i].videoTracks[0], nested(`s${i + 1}`, 0, 10, { id: `n${i}` }));
    put(seqs[MAX_NEST_DEPTH].videoTracks[0], clip(MEDIA.M.id, 0, 10));
    put(seqs[0].videoTracks[0], clip(MEDIA.M.id, 20, 10, { id: 'm0' }));
    for (const s of [...seqs].reverse()) add(s);
    // s0 > (new) > s1 > ... > s8: 9 levels.
    expect(S().makeCompoundClip('s0', ['n0'])).toBeNull();
    expect(S().ui.toasts.at(-1)?.text).toBe(`Cannot make a compound clip: nesting would be more than ${MAX_NEST_DEPTH} levels deep`);
    expect(S().project.sequences.s0.videoTracks[0].clips[0].sequenceId).toBe('s1');
    // A compound of the plain clip next to it adds no level.
    expect(S().makeCompoundClip('s0', ['m0'])).toBeTruthy();
  });
});

// ------------------------------------------------------------------------------- load repair

describe('load repair', () => {
  it.each([4, 5])('cuts a %i-track fan-out 8 levels deep to the limits: deterministic, stable, no clip lost', (K) => {
    const p = projectOf(fanOut(K, MAX_NEST_DEPTH));
    const raw = JSON.stringify(p);
    const a = normalizeProjectWithReport(JSON.parse(raw));
    const b = normalizeProjectWithReport(JSON.parse(raw));
    const q = a.project;
    expect(a.repairs.join('\n')).toMatch(new RegExp(`nested sequence that would expand to more than ${FLAT_LIMIT_TEXT} when flattened made offline \\(\\d+x\\)`));
    // Deterministic: the same clips are cut.
    const cuts = (x: Project) => Object.values(x.sequences).flatMap((s) => allTracks(s).flatMap((t) => t.clips.filter((c) => !c.sequenceId && c.mediaId.startsWith('L')).map((c) => `${s.id}/${c.id}`))).sort();
    expect(cuts(a.project)).toEqual(cuts(b.project));
    expect(a.repairs).toEqual(b.repairs);
    // No clip lost; every sequence within the limits; flattening is fast and within them.
    expect(clipTotal(q)).toBe(clipTotal(p));
    for (const id of q.sequenceOrder) {
      const s = flattenedSize(q.sequences, id);
      expect(s.tracks, id).toBeLessThanOrEqual(MAX_FLAT_TRACKS);
      expect(s.clips, id).toBeLessThanOrEqual(MAX_FLAT_CLIPS);
    }
    const t0 = performance.now();
    const flat = flattenSequence(q.sequences.L0, q.sequences, q.media);
    const ms = performance.now() - t0;
    expect(flat.videoTracks.length + flat.audioTracks.length).toBeLessThanOrEqual(MAX_FLAT_TRACKS);
    expect(ms).toBeLessThan(1000);
    // Stable: the repaired project normalizes with no repair at all.
    const again = normalizeProjectWithReport(cloneRaw(q));
    expect(again.repairs).toEqual([]);
    expect(nestSizeRepairs(q.sequences, q.sequenceOrder)).toEqual([]);
    expect(nestingRepairs(q.sequences, q.sequenceOrder)).toEqual([]);
    // Cut as little as reasonably possible: the deepest levels keep all their references.
    const kept = (id: string) => q.sequences[id].videoTracks.filter((t) => t.clips.some((c) => c.sequenceId)).length;
    expect(kept(`L${MAX_NEST_DEPTH - 1}`)).toBe(K);
    expect(kept('L0')).toBeGreaterThanOrEqual(1);
  });

  it('cuts the widest, then the later, references first, and a linked picture + sound pair as one', () => {
    const big = mkSeq('B', 1, 1);
    const n = Math.ceil(MAX_FLAT_CLIPS * 0.3);
    for (let j = 0; j < n; j++) { big.videoTracks[0].clips.push(clip('M', j, 1)); big.audioTracks[0].clips.push(clip('M', j, 1)); }
    const small = mkSeq('T', 1, 1);
    put(small.videoTracks[0], clip('M', 0, 10));
    const host = mkSeq('H', 1, 1);
    // Three linked pairs of B (60 % of the clip limit each) and one small nested clip at the end.
    for (let k = 0; k < 3; k++) {
      put(host.videoTracks[0], nested('B', k * n, n, { id: `bv${k}`, linkId: `l${k}` }));
      put(host.audioTracks[0], nested('B', k * n, n, { id: `ba${k}`, linkId: `l${k}` }));
    }
    put(host.videoTracks[0], nested('T', 3 * n, 10, { id: 'tv' }));
    const rec = record(big, small, host);
    const cut = nestSizeRepairs(rec, ['H', 'B', 'T']);
    expect(cut).toEqual([['H', 'bv2'], ['H', 'ba2'], ['H', 'bv1'], ['H', 'ba1']]);
    expect(nestSizeRepairs(rec, ['H', 'B', 'T'])).toEqual(cut);
  });

  it('a sequence already past the limit with its own tracks is not cut for that', () => {
    const own = mkSeq('O', MAX_FLAT_TRACKS + 50, 1);
    put(own.videoTracks[0], clip('M', 0, 10));
    expect(nestSizeRepairs(record(own), ['O'])).toEqual([]);
  });

  it('a realistic season (20 episodes of 5 scenes, linked picture and sound, dissolves) is not cut and can nest more', () => {
    const seqs: Sequence[] = [];
    const scene = (id: string) => {
      const s = mkSeq(id, 3, 3);
      for (const t of allTracks(s)) {
        let prev: Clip | null = null;
        for (let j = 0; j < 40; j++) {
          const c = clip(j % 2 ? 'M' : 'N', j * 24, 24, { sourceIn: 10 + j * 3 });
          put(t, c);
          if (prev && j % 5 === 0) t.transitions.push({ id: `${c.id}-x`, type: t.kind === 'video' ? 'crossDissolve' : 'audioCrossfade', duration: 12, outClipId: prev.id, inClipId: c.id });
          prev = c;
        }
      }
      seqs.push(s);
      return s;
    };
    /** `host` plays `children` back to back on V1 / A1 as linked pairs, with a dissolve at every cut, plus extras on V2 / A2. */
    const nestAll = (host: Sequence, children: Sequence[], len: number) => {
      let pv: Clip | null = null, pa: Clip | null = null;
      children.forEach((c, k) => {
        const v = nested(c.id, k * len, len, { linkId: `${host.id}-${k}` });
        const a = nested(c.id, k * len, len, { linkId: `${host.id}-${k}` });
        put(host.videoTracks[0], v); put(host.audioTracks[0], a);
        if (pv && pa) {
          host.videoTracks[0].transitions.push({ id: `${v.id}-x`, type: 'crossDissolve', duration: 24, outClipId: pv.id, inClipId: v.id });
          host.audioTracks[0].transitions.push({ id: `${a.id}-x`, type: 'audioCrossfade', duration: 24, outClipId: pa.id, inClipId: a.id });
        }
        pv = v; pa = a;
        put(host.videoTracks[1], clip('M', k * len, 48));
        put(host.audioTracks[1], clip('N', k * len, len));
      });
    };
    const episodes: Sequence[] = [];
    for (let e = 0; e < 20; e++) {
      const ep = mkSeq(`E${e}`, 3, 3);
      nestAll(ep, Array.from({ length: 5 }, (_, k) => scene(`E${e}S${k}`)), 960);
      episodes.push(ep); seqs.push(ep);
    }
    const season = mkSeq('Season', 3, 3);
    nestAll(season, episodes, 4800);
    seqs.unshift(season);
    const p = projectOf(seqs);
    const { project: q, repairs } = normalizeProjectWithReport(cloneRaw(p));
    expect(repairs).toEqual([]);
    const size = flattenedSize(q.sequences, 'Season');
    const t0 = performance.now();
    const got = actual(q.sequences.Season, q.sequences);
    const ms = performance.now() - t0;
    console.log(`[season] estimate ${size.tracks} tracks / ${size.clips} clips; flatten ${got.tracks} tracks / ${got.clips} clips in ${ms.toFixed(0)} ms`);
    expect(size.tracks).toBeGreaterThanOrEqual(got.tracks);
    expect(size.clips).toBeGreaterThanOrEqual(got.clips);
    expect(size.tracks).toBeLessThan(MAX_FLAT_TRACKS / 10);
    expect(size.clips * 2, 'room to double').toBeLessThanOrEqual(MAX_FLAT_CLIPS);
    // Another episode (or the season nested in a franchise cut) is still allowed.
    expect(nestProblem(q.sequences, 'Season', 'E0')).toBeNull();
  });
});

// ------------------------------------------------------------------------------- flattening at the limits

describe('flattening at the limits stays fast', () => {
  it('a fan-out just under the track limit, and one just under the clip limit', () => {
    const time = (seqs: Sequence[]) => {
      const rec = record(...seqs);
      const size = flattenedSize(rec, 'L0');
      const t0 = performance.now();
      const got = actual(rec.L0, rec);
      const ms = performance.now() - t0;
      return { size, got, ms };
    };
    // 9 tracks per level, 2 levels below the top: 9 x (1 + 90) + 1 = 820 tracks; 1 or 68 leaf clips per track
    // (729 leaf tracks: about 49,600 clips).
    const tracks = time(fanOut(9, 2, 1));
    const clips = time(fanOut(9, 2, 68));
    for (const [what, r] of [['tracks', tracks], ['clips', clips]] as const) {
      console.log(`[at the limit: ${what}] ${r.got.tracks} tracks, ${r.got.clips} clips: flatten ${r.ms.toFixed(1)} ms`);
      expect(r.size.tracks).toBeLessThanOrEqual(MAX_FLAT_TRACKS);
      expect(r.size.clips).toBeLessThanOrEqual(MAX_FLAT_CLIPS);
      expect(r.ms).toBeLessThan(2000);
    }
  });
});
