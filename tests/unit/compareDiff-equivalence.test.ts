/**
 * diffSequences matches clips through indexes (critic B perf finding: the full scan was quadratic, 5k vs 5k
 * clips took ~1.1 s). This checks the indexed matcher pairs exactly like the original full-scan matcher on
 * random inputs, and that a large diff is fast.
 */
import { describe, it, expect } from 'vitest';
import { createSequence } from '../../shared/project';
import { clipSourceOut, makeClip } from '../../shared/timeline';
import { fpsEquals } from '../../shared/time';
import type { Clip, Rational, Sequence } from '../../shared/model';
import { clipIdentityKey, diffSequences, type DiffKind } from '../../src/panels/compare/diff';

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** The original matcher: every pending A clip scores every unmatched B clip. Returns A clip id -> [kind, B clip id]. */
function referencePairs(a: Sequence, b: Sequence): Map<string, [DiffKind, string]> {
  const fpsA = a.fps;
  const conv = (f: number, from: Rational, to: Rational) => (fpsEquals(from, to) ? f : Math.round((f * to.num * from.den) / (to.den * from.num)));
  interface It { c: Clip; ti: number; startA: number; key: string; out: number }
  const collect = (seq: Sequence): It[] => seq.videoTracks.flatMap((t, ti) => t.clips.map((c) => {
    const dA = conv(c.duration, seq.fps, fpsA);
    return { c, ti, startA: conv(c.start, seq.fps, fpsA), key: clipIdentityKey(c, dA), out: clipSourceOut(c, seq.fps) };
  }));
  const pick = (x: It, cands: It[], score: (y: It) => number) => {
    let best: It | undefined; let bestScore = -Infinity;
    for (const y of cands) {
      const s = score(y);
      if (s === -Infinity) continue;
      const tie = best ? (y.ti === x.ti ? 1 : 0) - (best.ti === x.ti ? 1 : 0) : 0;
      const closer = best ? Math.abs(best.startA - x.startA) - Math.abs(y.startA - x.startA) : 0;
      if (!best || s > bestScore || (s === bestScore && (tie > 0 || (tie === 0 && closer > 0)))) { best = y; bestScore = s; }
    }
    return best;
  };
  const itemsA = collect(a); const unmatched = new Set(collect(b));
  const out = new Map<string, [DiffKind, string]>();
  let pending = itemsA;
  const pass = (kind: DiffKind, score: (x: It, y: It) => number) => {
    const rest: It[] = [];
    for (const x of pending) {
      const y = pick(x, [...unmatched], (c) => score(x, c));
      if (y) { unmatched.delete(y); out.set(x.c.id, [kind, y.c.id]); } else rest.push(x);
    }
    pending = rest;
  };
  pass('same', (x, y) => (x.key === y.key && x.startA === y.startA ? 1 : -Infinity));
  pass('moved', (x, y) => (x.key === y.key ? 1 : -Infinity));
  pass('trimmed', (x, y) => {
    if (x.c.mediaId !== y.c.mediaId) return -Infinity;
    const ov = Math.min(x.out, y.out) - Math.max(x.c.sourceIn, y.c.sourceIn);
    return ov > 0 ? ov : -Infinity;
  });
  return out;
}

const SOURCE_INS = [0, 0.5, 1, 1.25, 2, 3.5, 5, 8];
const SPEEDS = [1, 1, 1, 2, 0.5];

function randomPair(r: () => number): [Sequence, Sequence] {
  const fpsA = { num: 24, den: 1 };
  const fpsB = r() < 0.2 ? { num: 30000, den: 1001 } : fpsA;
  const a = createSequence('A', fpsA); const b = createSequence('B', fpsB);
  let n = 0;
  const add = (s: Sequence, track: number, start: number, media: string, sourceIn: number, duration: number, speed: number) => {
    const c = makeClip({ mediaId: media, name: media, sourceIn, duration, speed, kind: 'video' }, start);
    c.id = `${s.name}${n++}`;
    s.videoTracks[track].clips.push(c);
  };
  for (let track = 0; track < 3; track++) {
    let pa = ri(r, 0, 3), pb = ri(r, 0, 3);
    for (let i = ri(r, 0, 12); i > 0; i--) {
      const media = `m${ri(r, 1, 3)}`; const sourceIn = SOURCE_INS[ri(r, 0, SOURCE_INS.length - 1)];
      const duration = [12, 24, 36, 48][ri(r, 0, 3)]; const speed = SPEEDS[ri(r, 0, SPEEDS.length - 1)];
      const roll = r();
      if (roll < 0.8) add(a, track, pa, media, sourceIn, duration, speed);
      if (roll > 0.15) {
        // B: identical, moved, trimmed or new
        const v = r();
        const bIn = v < 0.3 ? sourceIn + [-0.5, -0.25, 0.25, 0.5, 1 / 48, -1 / 48][ri(r, 0, 5)] : sourceIn;
        const bDur = v < 0.45 ? duration + ri(r, -6, 6) : duration;
        const bStart = v > 0.85 ? pb + ri(r, 0, 30) : pb;
        if (fpsEquals(fpsA, fpsB)) add(b, ri(r, 0, 9) === 0 ? (track + 1) % 3 : track, bStart, media, Math.max(0, bIn), Math.max(1, bDur), speed);
        else add(b, track, Math.round(bStart * 30000 / 1001 / 24), media, Math.max(0, bIn), Math.max(1, Math.round(bDur * 30000 / 1001 / 24)), speed);
        pb = bStart + Math.max(1, bDur) + ri(r, 0, 2);
      }
      pa += duration + ri(r, 0, 2);
    }
  }
  for (const s of [a, b]) for (const t of s.videoTracks) t.clips.sort((x, y) => x.start - y.start);
  return [a, b];
}

describe('diffSequences indexed matcher', () => {
  it('pairs exactly like the original full scan on random inputs', () => {
    let pairsSeen = 0; const kinds = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const [a, b] = randomPair(mulberry32(seed * 31337));
      const ref = referencePairs(a, b);
      const got = diffSequences(a, b);
      const mine = new Map<string, [DiffKind, string]>();
      for (const e of got.a) if (e.match) mine.set(e.clipId, [e.kind, e.match.clipId]);
      expect([...mine.entries()].sort(), `seed ${seed}`).toEqual([...ref.entries()].sort());
      const matchedB = new Set([...ref.values()].map((v) => v[1]));
      expect(got.b.filter((e) => e.kind === 'onlyB').map((e) => e.clipId).sort(), `seed ${seed} onlyB`)
        .toEqual(b.videoTracks.flatMap((t) => t.clips.map((c) => c.id)).filter((id) => !matchedB.has(id)).sort());
      pairsSeen += ref.size; for (const v of ref.values()) kinds.add(v[0]);
    }
    // the generator exercises every pass
    expect(kinds).toEqual(new Set(['same', 'moved', 'trimmed']));
    expect(pairsSeen).toBeGreaterThan(1000);
  });

  it('diffs 20k vs 20k clips quickly (the full scan was quadratic)', () => {
    const N = 20_000;
    const a = createSequence('A', { num: 24, den: 1 }); const b = createSequence('B', { num: 24, den: 1 });
    for (let i = 0; i < N; i++) {
      a.videoTracks[0].clips.push(makeClip({ mediaId: 'm1', name: 'c', sourceIn: i, duration: 10, kind: 'video' }, i * 10));
      b.videoTracks[0].clips.push(makeClip({ mediaId: 'm1', name: 'c', sourceIn: i + 0.1, duration: 10, kind: 'video' }, i * 10));
    }
    const t0 = Date.now();
    const r = diffSequences(a, b);
    const ms = Date.now() - t0;
    expect(r.counts.trimmed).toBe(N);
    expect(ms).toBeLessThan(3000);
  });
});
