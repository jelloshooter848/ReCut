/**
 * Property test for shared/timeline.ts (ported from the adversarial critic's fuzz harness): random sequences,
 * random edit operations, and the timeline invariants checked after every operation. Fixed seeds and bounded
 * iterations so it runs in a few seconds and any failure reproduces exactly (the message names the seed,
 * the step and the last operations).
 *
 * Invariants:
 *  - per track: clips sorted, no overlaps, integer start >= 0, integer duration >= 1, finite sourceIn >= 0;
 *  - a clip that fitted its media keeps fitting (source out <= media duration); clips that were already past
 *    their media end before an op are exempt;
 *  - transitions: not dangling, adjacent, integer duration in [1, clip length], in + out <= clip length,
 *    at most one in- and one out-transition per clip;
 *  - story blocks: start >= 0, end > start;
 *  - clips on locked tracks are never changed;
 *  - edge edits never move an edge opposite to the drag (trim / roll / slip / slide).
 */
import { describe, it, expect } from 'vitest';
import { createSequence } from '../../shared/project';
import type { Clip, Rational, Sequence } from '../../shared/model';
import * as T from '../../shared/timeline';
import { FPS_PRESETS } from '../../shared/time';

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const MEDIA: Record<string, number> = { m10: 10, m3: 3.7, mInf: Infinity, m1: 0.05 };
const md = (id: string) => MEDIA[id] ?? Infinity;
const SPEEDS = [1, 1, 1, 0.01, 100, 0.37, 2.5, 1.5];

/**
 * Clips created within their media carry an enumerable `_fit` mark: they must stay within it. Ops copy clips
 * with object spread (split tails, cleared tails), so pieces of a fitting clip inherit the mark.
 */
type Marked = Clip & { _fit?: true };
const markFit = (c: Clip) => { (c as Marked)._fit = true; };

function overruns(c: Clip, fps: Rational): boolean {
  const m = md(c.mediaId);
  return Number.isFinite(m) && T.clipSourceOut(c, fps) > m + 1e-6;
}

function check(seq: Sequence, fps: Rational): string[] {
  const errs: string[] = [];
  for (const t of T.allTracks(seq)) {
    let prevEnd = -Infinity;
    let prevStart = -Infinity;
    for (const c of t.clips) {
      if (!Number.isInteger(c.start) || c.start < 0) errs.push(`${t.name} bad start ${c.start}`);
      if (!Number.isInteger(c.duration) || c.duration < T.MIN_CLIP_FRAMES) errs.push(`${t.name} bad duration ${c.duration}`);
      if (!Number.isFinite(c.sourceIn) || c.sourceIn < 0) errs.push(`${t.name} bad sourceIn ${c.sourceIn}`);
      if (c.start < prevStart) errs.push(`${t.name} unsorted at ${c.start}`);
      if (c.start < prevEnd) errs.push(`${t.name} overlap at ${c.start} < ${prevEnd}`);
      prevEnd = Math.max(prevEnd, T.clipEnd(c)); prevStart = c.start;
      if ((c as Marked)._fit && overruns(c, fps)) errs.push(`${t.name} source out ${T.clipSourceOut(c, fps)} > media ${md(c.mediaId)} (speed ${c.speed})`);
    }
    const byId = new Map(t.clips.map((c) => [c.id, c]));
    for (const tr of t.transitions) {
      const a = tr.outClipId ? byId.get(tr.outClipId) : undefined, b = tr.inClipId ? byId.get(tr.inClipId) : undefined;
      if ((tr.outClipId && !a) || (tr.inClipId && !b)) errs.push(`${t.name} transition dangling`);
      if (a && b && T.clipEnd(a) !== b.start) errs.push(`${t.name} transition not adjacent`);
      if (!(tr.duration >= 1) || !Number.isInteger(tr.duration)) errs.push(`${t.name} transition bad duration ${tr.duration}`);
      if (a && tr.duration > a.duration) errs.push(`${t.name} transition longer than out clip`);
      if (b && tr.duration > b.duration) errs.push(`${t.name} transition longer than in clip`);
    }
    for (const c of t.clips) {
      const ins = t.transitions.filter((x) => x.inClipId === c.id), outs = t.transitions.filter((x) => x.outClipId === c.id);
      if (ins.length > 1 || outs.length > 1) errs.push(`${t.name} ${ins.length} in / ${outs.length} out transitions on one clip`);
      if (ins[0] && outs[0] && ins[0] !== outs[0] && ins[0].duration + outs[0].duration > c.duration) errs.push(`${t.name} in+out transitions exceed clip`);
    }
  }
  for (const b of seq.storyBlocks) if (!(b.end > b.start) || b.start < 0) errs.push(`story block ${b.start}..${b.end}`);
  return errs;
}

function randomSeq(r: () => number, fps: Rational): Sequence {
  const seq = createSequence('S', fps);
  for (const t of T.allTracks(seq)) {
    let pos = ri(r, 0, 5);
    const n = ri(r, 0, 6);
    for (let i = 0; i < n; i++) {
      const mediaId = Object.keys(MEDIA)[ri(r, 0, 3)];
      const speed = SPEEDS[ri(r, 0, SPEEDS.length - 1)];
      const mdur = md(mediaId);
      const sourceIn = Number.isFinite(mdur) ? r() * mdur * 0.5 : r() * 100;
      const maxD = T.maxDurationFrom(sourceIn, speed, mdur, fps);
      if (maxD < 1) continue;
      // Mostly clips within their media; some already run past it (e.g. after a relink to a shorter file).
      const over = r() < 0.15;
      const dur = over ? Math.max(1, Math.min(maxD, 60)) + ri(r, 1, 20) : Math.max(1, Math.min(maxD, ri(r, 1, 60)));
      const c = T.makeClip({ mediaId, name: 'c', sourceIn, duration: dur, speed, kind: t.kind }, pos);
      if (!over) markFit(c);
      t.clips.push(c);
      pos += dur + (r() < 0.5 ? 0 : ri(r, 1, 10));
    }
  }
  const v = seq.videoTracks[0], a = seq.audioTracks[0];
  for (const c of v.clips) { const m = a.clips.find((x) => x.start === c.start); if (m && r() < 0.7) c.linkId = m.linkId = 'L' + c.id; }
  for (const t of T.allTracks(seq)) {
    const kind = t.kind === 'audio' ? 'audioCrossfade' : 'crossDissolve';
    for (let i = 0; i + 1 < t.clips.length; i++) if (T.clipEnd(t.clips[i]) === t.clips[i + 1].start && r() < 0.5) T.addTransition(seq, t.id, t.clips[i + 1].start, kind, ri(r, 1, 40));
    if (t.clips.length && r() < 0.2) T.addTransition(seq, t.id, t.clips[0].start, kind, ri(r, 1, 40));
  }
  if (r() < 0.2) { const ts = T.allTracks(seq); ts[ri(r, 0, ts.length - 1)].locked = true; }
  seq.storyBlocks = [{ id: 'b', name: 'b', start: 3, end: 40, color: '', notes: '' }];
  return seq;
}

/** Applies a random op; returns its label, plus a direction error when an edge moved against the drag. */
function randomOp(r: () => number, seq: Sequence): { op: string; err?: string } {
  const tracks = T.allTracks(seq);
  const clips = tracks.flatMap((t) => t.clips);
  const pickClip = () => clips[ri(r, 0, clips.length - 1)];
  const f = () => ri(r, -5, T.sequenceDuration(seq) + 10);
  const k = ri(r, 0, 16);
  if (!clips.length && k !== 0) return { op: 'noop' };
  const dir = (label: string, requested: number, applied: number) =>
    (Number.isNaN(applied) || requested === 0 || applied === 0 || Math.sign(applied) === Math.sign(requested) ? { op: label } : { op: label, err: `${label}: moved ${applied} for a drag of ${requested}` });
  switch (k) {
    case 0: {
      const t = tracks[ri(r, 0, tracks.length - 1)];
      const c = T.makeClip({ mediaId: 'mInf', name: 'n', sourceIn: 0, duration: ri(r, 1, 30), kind: t.kind }, Math.max(0, f()));
      markFit(c);
      if (r() < 0.5) T.overwriteClip(seq, t.id, c); else T.insertClip(seq, t.id, c);
      return { op: 'place' };
    }
    case 1: { const fr = f(); T.razorAt(seq, fr); return { op: `razor ${fr}` }; }
    case 2: { T.removeClips(seq, [pickClip().id]); return { op: 'remove' }; }
    case 3: { T.rippleDeleteClips(seq, [pickClip().id]); return { op: 'rippleDelete' }; }
    case 4: { const a = f(), b = a + ri(r, 0, 20); T.liftRange(seq, a, b); return { op: `lift ${a} ${b}` }; }
    case 5: { const a = f(), b = a + ri(r, 0, 20); T.extractRange(seq, a, b); return { op: `extract ${a} ${b}` }; }
    case 6: { const c = pickClip(); const s0 = c.start; const n = s0 + ri(r, -40, 40); const got = T.trimStart(seq, c.id, n, md); return dir(`trimStart ${n}`, n - s0, got - s0); }
    case 7: { const c = pickClip(); const e0 = T.clipEnd(c); const n = e0 + ri(r, -40, 40); const got = T.trimEnd(seq, c.id, n, md); return dir(`trimEnd ${n}`, n - e0, got - e0); }
    case 8: { const c = pickClip(); const s0 = c.start; const n = s0 + ri(r, -40, 40); const got = T.rippleTrimStart(seq, c.id, n, md); return dir(`rippleTrimStart ${n}`, n - s0, got - s0); }
    case 9: { const c = pickClip(); const e0 = T.clipEnd(c); const n = e0 + ri(r, -40, 40); const got = T.rippleTrimEnd(seq, c.id, n, md); return dir(`rippleTrimEnd ${n}`, n - e0, got - e0); }
    case 10: {
      const t = tracks.find((tt) => tt.clips.some((c, i) => i + 1 < tt.clips.length && T.clipEnd(c) === tt.clips[i + 1].start));
      if (!t) return { op: 'noop' };
      const i = t.clips.findIndex((c, i2) => i2 + 1 < t.clips.length && T.clipEnd(c) === t.clips[i2 + 1].start);
      const cut = T.clipEnd(t.clips[i]); const nf = cut + ri(r, -30, 30);
      const got = T.rollEdit(seq, t.clips[i].id, t.clips[i + 1].id, nf, md);
      return dir(`roll ${nf}`, nf - cut, got - cut);
    }
    case 11: { const d = ri(r, -500, 500); return dir(`slip ${d}`, d, T.slipClip(seq, pickClip().id, d, md)); }
    case 12: { const d = ri(r, -30, 30); return dir(`slide ${d}`, d, T.slideClip(seq, pickClip().id, d, md)); }
    case 13: case 14: {
      const c = pickClip(); const t = T.findClip(seq, c.id)!.track;
      const sameKind = tracks.filter((x) => x.kind === t.kind); const to = sameKind[ri(r, 0, sameKind.length - 1)];
      const at = f();
      const moves = T.linkedClips(seq, c).map((g) => ({ clipId: g.id, toTrackId: g.id === c.id ? to.id : T.findClip(seq, g.id)!.track.id, toStart: g.start + (at - c.start) }));
      T.moveClips(seq, moves, k === 13 ? 'overwrite' : 'insert');
      return { op: `move ${k === 13 ? 'overwrite' : 'insert'}` };
    }
    case 15: {
      const t = tracks[ri(r, 0, tracks.length - 1)]; if (!t.clips.length) return { op: 'noop' };
      const c = t.clips[ri(r, 0, t.clips.length - 1)];
      T.addTransition(seq, t.id, r() < 0.5 ? c.start : T.clipEnd(c), t.kind === 'audio' ? 'audioCrossfade' : 'crossDissolve', ri(r, 1, 60));
      return { op: 'addTransition' };
    }
    case 16: { const c = pickClip(); const d = ri(r, -10, 10); T.rippleShift(seq, c.start, d, {}); return { op: `rippleShift ${d}` }; }
  }
  return { op: 'noop' };
}

const lockedSnapshot = (seq: Sequence) => JSON.stringify(T.allTracks(seq).filter((t) => t.locked).map((t) => t.clips));

describe('timeline op fuzz (invariants after every op)', () => {
  const SEEDS = 600;
  const STEPS = 40;
  for (const { label, fps } of FPS_PRESETS) {
    it(`invariants @${label} (${SEEDS} seeds x ${STEPS} ops)`, () => {
      const failures: string[] = [];
      for (let seed = 1; seed <= SEEDS && failures.length < 5; seed++) {
        const r = mulberry32(seed * 7919);
        const seq = randomSeq(r, fps);
        const e0 = check(seq, fps);
        expect(e0, `seed ${seed}: generator produced an invalid sequence`).toEqual([]);
        const ops: string[] = [];
        for (let step = 0; step < STEPS; step++) {
          const locked = lockedSnapshot(seq);
          const { op, err } = randomOp(r, seq);
          ops.push(op);
          const errs = check(seq, fps);
          if (err) errs.push(err);
          if (lockedSnapshot(seq) !== locked) errs.push('a clip on a locked track changed');
          if (errs.length) { failures.push(`seed ${seed} step ${step} [${ops.slice(-3).join(' | ')}]: ${errs.slice(0, 3).join('; ')}`); break; }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
