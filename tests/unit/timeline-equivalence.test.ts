/**
 * Equivalence property test for the store-commit performance pass on shared/timeline.ts: the optimized ops scan
 * raw (non-draft) items, draft only what they change, and rebuild arrays from raw items (sortTrack, clearRange,
 * removeClips, rippleShift). They must give exactly the results of the previous implementation
 * (tests/unit/timeline-reference.ts) on random sequences:
 *
 *  - on plain data (as the unit tests and the fuzz test call them);
 *  - inside an immer recipe on a deep-frozen base (the store: every committed project is frozen);
 *  - inside a recipe on an unfrozen base (a project just loaded, before its first commit): the base must not change;
 *  - with several ops in one recipe (store actions chain ops; arrays rebuilt from raw items hold originals at new
 *    indexes, which later ops must copy instead of writing);
 *  - followClipMarkers in a second recipe (the store's stamp step).
 *
 * Ids are deterministic (uid is mocked with a counter reset before each run) so both implementations mint the
 * same ids in the same order.
 */
import { describe, it, expect, vi } from 'vitest';
import { produce, freeze } from 'immer';

vi.mock('../../shared/ids', () => {
  let n = 0;
  return { uid: (prefix = '') => `${prefix}${(n++).toString(36)}`, __reset: () => { n = 0; } };
});

import * as ids from '../../shared/ids';
import { createSequence } from '../../shared/project';
import type { Rational, Sequence } from '../../shared/model';
import * as N from '../../shared/timeline';
import * as O from './timeline-reference';
import { FPS_PRESETS } from '../../shared/time';

type TL = typeof N;
const OLD = O as unknown as TL;
const resetIds = () => (ids as unknown as { __reset: () => void }).__reset();

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: () => number, xs: T[]): T => xs[ri(r, 0, xs.length - 1)];

const MEDIA: Record<string, number> = { m10: 10, m3: 3.7, mInf: Infinity, m1: 0.05 };
const md = (id: string) => MEDIA[id] ?? Infinity;
const SPEEDS = [1, 1, 1, 0.5, 2.5, 1.5];

/** Serialized state for comparison (both implementations build objects with the same key order). */
const canon = (v: unknown): string => JSON.stringify(v) ?? 'undefined';

function randomSeq(r: () => number, fps: Rational): Sequence {
  resetIds();
  const seq = createSequence('S', fps);
  for (const t of N.allTracks(seq)) {
    let pos = ri(r, 0, 5);
    const n = ri(r, 0, 12);
    for (let i = 0; i < n; i++) {
      const mediaId = Object.keys(MEDIA)[ri(r, 0, 3)];
      const speed = pick(r, SPEEDS);
      const mdur = md(mediaId);
      const sourceIn = Number.isFinite(mdur) ? r() * mdur * 0.5 : r() * 100;
      const maxD = N.maxDurationFrom(sourceIn, speed, mdur, fps);
      if (maxD < 1) continue;
      const dur = Math.max(1, Math.min(maxD, ri(r, 1, 50)));
      const c = N.makeClip({ mediaId, name: 'c', sourceIn, duration: dur, speed, kind: t.kind, tags: r() < 0.3 ? ['x'] : [] }, pos);
      if (r() < 0.15) c.enabled = false;
      t.clips.push(c);
      pos += dur + (r() < 0.5 ? 0 : ri(r, 1, 10));
    }
  }
  // Links: V1/A1 pairs at the same start, sometimes V2/A2 too.
  for (const [vi_, ai] of [[0, 0], [1, 1]] as const) {
    const v = seq.videoTracks[vi_], a = seq.audioTracks[ai];
    for (const c of v.clips) { const m = a.clips.find((x) => x.start === c.start); if (m && r() < 0.7) c.linkId = m.linkId = 'L' + c.id; }
  }
  for (const t of N.allTracks(seq)) {
    const kind = t.kind === 'audio' ? 'audioCrossfade' : 'crossDissolve';
    for (let i = 0; i + 1 < t.clips.length; i++) if (N.clipEnd(t.clips[i]) === t.clips[i + 1].start && r() < 0.5) N.addTransition(seq, t.id, t.clips[i + 1].start, kind, ri(r, 1, 40));
    if (t.clips.length && r() < 0.2) N.addTransition(seq, t.id, t.clips[0].start, kind, ri(r, 1, 40));
  }
  if (r() < 0.2) pick(r, N.allTracks(seq)).locked = true;
  seq.storyBlocks = [{ id: 'b1', name: 'b', start: 3, end: 40, color: '', notes: '' }, { id: 'b2', name: 'c', start: 40, end: ri(r, 41, 120), color: '', notes: '' }];
  // Clip-anchored subtitle cues and markers.
  const all = N.allTracks(seq).flatMap((t) => t.clips);
  if (all.length) {
    seq.subtitleTracks = [{ id: 'st', name: 'en', language: 'en', enabled: true, cues: [] }];
    for (let i = 0; i < 6; i++) {
      const c = pick(r, all);
      const s0 = c.sourceIn + r() * 2;
      seq.subtitleTracks[0].cues.push({ id: `cue${i}`, clipId: c.id, srcStart: s0, srcEnd: s0 + 0.2 + r() * 2, start: 0, duration: 1, offset: 0, text: 't' });
    }
    seq.subtitleTracks[0].cues.push({ id: 'free', start: 10, duration: 5, offset: 0, text: 'free' });
    for (let i = 0; i < 4; i++) {
      const c = pick(r, all);
      seq.markers.push({ id: `mk${i}`, time: c.start + ri(r, 0, c.duration - 1), duration: 0, name: '', note: '', color: '', kind: 'continuity', clipId: c.id });
    }
    seq.markers.push({ id: 'mkf', time: 7, duration: 0, name: '', note: '', color: '', kind: 'marker' });
    seq.markers.sort((a, b) => a.time - b.time);
  }
  return seq;
}

interface OpSpec { label: string; run: (T: TL, seq: Sequence) => unknown }

/** A random op chosen from the current state, referring to clips / tracks by id only (it runs on other copies). */
function randomOp(r: () => number, seq: Sequence): OpSpec {
  const tracks = N.allTracks(seq);
  const clips = tracks.flatMap((t) => t.clips);
  const f = () => ri(r, -5, N.sequenceDuration(seq) + 10);
  const k = ri(r, 0, 22);
  if (!clips.length && k > 2) return { label: 'noop', run: () => null };
  const clip = () => pick(r, clips);
  const tr = () => pick(r, tracks);
  switch (k) {
    case 0: {
      const t = tr(); const at = Math.max(0, f()); const d = ri(r, 1, 30); const mode = r() < 0.5; const ripple = r() < 0.5 ? 'all' : 'own';
      return { label: `${mode ? 'overwrite' : 'insert'} ${t.name}@${at}+${d}`, run: (T, s) => {
        const c = T.makeClip({ mediaId: 'mInf', name: 'n', sourceIn: 0, duration: d, kind: t.kind }, at);
        return mode ? T.overwriteClip(s, t.id, c) : T.insertClip(s, t.id, c, { rippleTracks: ripple });
      } };
    }
    case 1: {
      const v = pick(r, seq.videoTracks), a = pick(r, seq.audioTracks); const at = Math.max(0, f()); const d = ri(r, 1, 30); const mode = r() < 0.5 ? 'insert' : 'overwrite';
      return { label: `place ${mode}@${at}`, run: (T, s) => {
        const link = 'Lnew';
        return T.placeClips(s, [
          { trackId: v.id, clip: T.makeClip({ mediaId: 'mInf', name: 'v', sourceIn: 0, duration: d, kind: 'video', linkId: link }, at) },
          { trackId: a.id, clip: T.makeClip({ mediaId: 'mInf', name: 'a', sourceIn: 0, duration: d, kind: 'audio', linkId: link }, at) },
        ], mode);
      } };
    }
    case 2: { const fr = f(); const only = r() < 0.3 ? [tr().id] : undefined; const linked = r() < 0.8;
      return { label: `razor ${fr}`, run: (T, s) => T.razorAt(s, fr, only, { linked }).map((c) => c.id) }; }
    case 3: { const ids_ = [clip().id, ...(r() < 0.3 ? [clip().id] : [])]; return { label: 'remove', run: (T, s) => T.removeClips(s, ids_) }; }
    case 4: { const ids_ = [clip().id, ...(r() < 0.3 ? [clip().id] : [])]; return { label: 'rippleDelete', run: (T, s) => T.rippleDeleteClips(s, ids_) }; }
    case 5: { const a = f(), b = a + ri(r, 0, 20); const only = r() < 0.3 ? [tr().id] : undefined; return { label: `lift ${a} ${b}`, run: (T, s) => T.liftRange(s, a, b, only) }; }
    case 6: { const a = f(), b = a + ri(r, 0, 20); const only = r() < 0.3 ? [tr().id] : undefined; return { label: `extract ${a} ${b}`, run: (T, s) => T.extractRange(s, a, b, only) }; }
    case 7: { const c = clip(); const n = c.start + ri(r, -40, 40); const ign = r() < 0.3; return { label: `trimStart ${n}`, run: (T, s) => T.trimStart(s, c.id, n, md, { ignoreNeighbors: ign }) }; }
    case 8: { const c = clip(); const n = N.clipEnd(c) + ri(r, -40, 40); const ign = r() < 0.3; return { label: `trimEnd ${n}`, run: (T, s) => T.trimEnd(s, c.id, n, md, { ignoreNeighbors: ign }) }; }
    case 9: { const c = clip(); const n = c.start + ri(r, -40, 40); return { label: `rippleTrimStart ${n}`, run: (T, s) => T.rippleTrimStart(s, c.id, n, md) }; }
    case 10: { const c = clip(); const n = N.clipEnd(c) + ri(r, -40, 40); return { label: `rippleTrimEnd ${n}`, run: (T, s) => T.rippleTrimEnd(s, c.id, n, md) }; }
    case 11: {
      const t = tracks.find((tt) => tt.clips.some((c, i) => i + 1 < tt.clips.length && N.clipEnd(c) === tt.clips[i + 1].start));
      if (!t) return { label: 'noop', run: () => null };
      const i = t.clips.findIndex((c, i2) => i2 + 1 < t.clips.length && N.clipEnd(c) === t.clips[i2 + 1].start);
      const a = t.clips[i].id, b = t.clips[i + 1].id; const nf = N.clipEnd(t.clips[i]) + ri(r, -30, 30);
      return { label: `roll ${nf}`, run: (T, s) => T.rollEdit(s, a, b, nf, md) };
    }
    case 12: { const c = clip(); const d = ri(r, -500, 500); return { label: `slip ${d}`, run: (T, s) => T.slipClip(s, c.id, d, md) }; }
    case 13: { const c = clip(); const d = ri(r, -30, 30); return { label: `slide ${d}`, run: (T, s) => T.slideClip(s, c.id, d, md) }; }
    case 14: case 15: case 16: {
      const c = clip(); const t = N.findClip(seq, c.id)!.track;
      const sameKind = tracks.filter((x) => x.kind === t.kind); const to = pick(r, sameKind);
      const at = f();
      const group = k === 16 ? clips.filter(() => r() < 0.2) : N.linkedClips(seq, c);
      const moves = (group.length ? group : [c]).map((g) => ({ clipId: g.id, toTrackId: g.id === c.id ? to.id : N.findClip(seq, g.id)!.track.id, toStart: g.start + (at - c.start) }));
      const mode = k === 14 ? 'overwrite' : 'insert';
      return { label: `move ${mode} x${moves.length}`, run: (T, s) => T.moveClips(s, moves, mode) };
    }
    case 17: {
      const t = tr(); if (!t.clips.length) return { label: 'noop', run: () => null };
      const c = pick(r, t.clips); const fr = r() < 0.5 ? c.start : N.clipEnd(c); const d = ri(r, 1, 60);
      return { label: `addTransition ${fr}`, run: (T, s) => { const x = T.addTransition(s, t.id, fr, t.kind === 'audio' ? 'audioCrossfade' : 'crossDissolve', d); return x && { ...x }; } };
    }
    case 18: {
      const trs = tracks.flatMap((t) => t.transitions); if (!trs.length) return { label: 'noop', run: () => null };
      const id = pick(r, trs).id; return { label: 'removeTransition', run: (T, s) => T.removeTransition(s, id) };
    }
    case 19: { const c = clip(); const d = ri(r, -10, 10); const ex = r() < 0.3 ? new Set([c.id]) : undefined;
      return { label: `rippleShift ${d}`, run: (T, s) => T.rippleShift(s, c.start, d, { except: ex }) }; }
    case 20: { const t = ri(r, 0, 100); return { label: `addMarker ${t}`, run: (T, s) => T.addMarker(s, { time: t, duration: 0, name: '', note: '', color: '', kind: 'marker' }).id }; }
    case 21: return { label: 'rippleDeleteDisabled', run: (T, s) => T.rippleDeleteDisabledClips(s) };
    case 22: { const t = tr(); const a = f(), b = a + ri(r, 1, 15); const ex = r() < 0.3 && t.clips.length ? new Set([pick(r, t.clips).id]) : undefined;
      return { label: `clearRange ${a} ${b}`, run: (T, s) => { const tt = T.findTrack(s, t.id)!; const res = T.clearRange(tt, a, b, s.fps, ex); return { removed: res.removed, splits: res.splits.map((x) => [x.head.id, x.tail.id]) }; } }; }
  }
  return { label: 'noop', run: () => null };
}

interface Root { seq: Sequence }
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Runs `ops` (in one recipe when `recipe`) with implementation T; returns [canonical result, canonical returns]. */
function runPlain(T: TL, base: Sequence, ops: OpSpec[]): [string, string] {
  resetIds();
  const s = clone(base);
  const rets = ops.map((o) => canon(o.run(T, s)));
  return [canon(s), rets.join('|')];
}
function runRecipe(T: TL, base: Root, ops: OpSpec[]): [string, string, Root] {
  resetIds();
  let rets: string[] = [];
  const next = produce(base, (d) => { rets = ops.map((o) => canon(o.run(T, d.seq))); });
  return [canon(next.seq), rets.join('|'), next];
}

describe('optimized timeline ops = previous implementation (random sequences)', () => {
  const SEEDS = 150;
  const STEPS = 10;
  for (const { label, fps } of [FPS_PRESETS[0], FPS_PRESETS[2]]) {
    it(`plain data, frozen-base recipes, unfrozen-base recipes, chained recipes @${label}`, () => {
      const failures: string[] = [];
      for (let seed = 1; seed <= SEEDS && failures.length < 3; seed++) {
        const r = mulberry32(seed * 104729);
        let state = randomSeq(r, fps); // advanced with the reference implementation on plain data
        const history: string[] = [];
        for (let step = 0; step < STEPS && failures.length < 3; step++) {
          const nOps = r() < 0.35 ? ri(r, 2, 4) : 1;
          // Each op of a chain is chosen from the state the reference reaches after the earlier ones (ids are
          // deterministic, so later ops may name clips the earlier ones created).
          const specs: OpSpec[] = [];
          { const work = clone(state); resetIds(); for (let i = 0; i < nOps; i++) { const o = randomOp(r, work); specs.push(o); o.run(OLD, work); } }
          const where = `seed ${seed} step ${step} [${[...history.slice(-2), specs.map((o) => o.label).join(' + ')].join(' | ')}]`;
          const [refPlain, refRet] = runPlain(OLD, state, specs);
          const [newPlain, newRet] = runPlain(N, state, specs);
          if (newPlain !== refPlain || newRet !== refRet) { failures.push(`${where}: plain data differs`); break; }
          // Frozen base, as the store holds it.
          const frozen: Root = freeze({ seq: clone(state) }, true);
          let refRecipe: string, refRecipeRet: string, refNext: Root | null, newRecipe: string, newRecipeRet: string, newNext: Root;
          try {
            [refRecipe, refRecipeRet, refNext] = runRecipe(OLD, frozen, specs);
          } catch {
            // The reference itself fails on some chains on frozen data: it wrote a transition that an earlier step had
            // put back in the list as an original ("Cannot assign to read only property 'duration' / 'outClipId'"),
            // i.e. the store edit threw. The optimized ops must give the plain-data result there.
            [refRecipe, refRecipeRet, refNext] = [refPlain, refRet, null];
          }
          try { [newRecipe, newRecipeRet, newNext] = runRecipe(N, frozen, specs); } catch (e) { failures.push(`${where}: frozen-base recipe threw ${(e as Error).message}`); break; }
          if (newRecipe !== refRecipe || newRecipeRet !== refRecipeRet) { failures.push(`${where}: frozen-base recipe differs`); break; }
          if (refRecipe !== refPlain) { failures.push(`${where}: reference recipe != reference plain (harness)`); break; }
          // Unfrozen base (a loaded project before its first commit): the base must stay as it was.
          const loose: Root = { seq: clone(state) };
          const before = canon(loose.seq);
          let looseRes: string;
          try { [looseRes] = runRecipe(N, loose, specs); } catch (e) { failures.push(`${where}: unfrozen-base recipe threw ${(e as Error).message}`); break; }
          if (looseRes !== refPlain) { failures.push(`${where}: unfrozen-base recipe differs`); break; }
          if (canon(loose.seq) !== before) { failures.push(`${where}: unfrozen base was mutated`); break; }
          // The store's stamp step: clip-anchored markers follow their clip, in a second recipe.
          const refStamp = canon(produce(refNext ?? newNext, (d) => { OLD.followClipMarkers(frozen.seq, d.seq); }).seq);
          const newStamp = canon(produce(newNext, (d) => { N.followClipMarkers(frozen.seq, d.seq); }).seq);
          if (newStamp !== refStamp) { failures.push(`${where}: followClipMarkers differs`); break; }
          state = JSON.parse(refPlain);
          history.push(specs.map((o) => o.label).join(' + '));
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('writes after a raw reorder in the same recipe go to copies, never to the frozen base', () => {
    resetIds();
    const seq = createSequence('S', { num: 24, den: 1 });
    const v = seq.videoTracks[0];
    for (let i = 0; i < 6; i++) v.clips.push(N.makeClip({ mediaId: 'mInf', name: `c${i}`, sourceIn: 0, duration: 10, kind: 'video' }, i * 10));
    N.addTransition(seq, v.id, 30, 'crossDissolve', 6);
    const base: Root = freeze({ seq }, true);
    const next = produce(base, (d) => {
      N.razorAt(d.seq, 5);                      // tail pushed + raw sort: originals now sit at shifted indexes
      const loc = N.findClip(d.seq, v.clips[4].id)!;
      loc.clip.audio.gain = 3;                  // nested write on a clip that was an original at a new index
      N.slideClip(d.seq, v.clips[2].id, 2, md); // neighbours are written through writableClip
      N.rippleShift(d.seq, 0, 1);
      N.findClip(d.seq, v.clips[5].id)!.clip.transform.crop.left = 0.25;
    });
    expect(next.seq.videoTracks[0].clips.map((c) => c.start)).toEqual([1, 6, 11, 23, 33, 41, 51]);
    expect(next.seq.videoTracks[0].clips.find((c) => c.id === v.clips[4].id)!.audio.gain).toBe(3);
    expect(next.seq.videoTracks[0].clips.find((c) => c.id === v.clips[5].id)!.transform.crop.left).toBe(0.25);
    expect(v.clips[4].audio.gain).toBe(0);
    expect(v.clips[5].transform.crop.left).toBe(0);
    expect(v.clips.map((c) => c.start)).toEqual([0, 10, 20, 30, 40, 50]);
  });
});

