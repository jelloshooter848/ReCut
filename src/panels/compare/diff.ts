/**
 * Structural comparison of two sequences (Compare panel).
 *
 * Pure: no DOM, no store. Walks the video tracks of A and B and pairs clips up:
 *  - identity key = mediaId + round(sourceIn * 1000) + duration (frames, in A's rate) + speed
 *  - 'same'    same key at the same timeline position
 *  - 'moved'   same key at a different timeline position
 *  - 'trimmed' same media with overlapping source ranges but different in/out (head/tail frame deltas reported)
 *  - 'onlyA' / 'onlyB' everything left over
 * Both result lists are ordered by timeline position (then track index).
 */
import type { Clip, ID, Rational, Sequence } from '../../../shared/model';
import { clipSourceOut, sequenceDuration } from '../../../shared/timeline';
import { fpsEquals, secondsToFrames } from '../../../shared/time';

export type DiffKind = 'same' | 'moved' | 'trimmed' | 'onlyA' | 'onlyB';
export const DIFF_KINDS: readonly DiffKind[] = ['same', 'moved', 'trimmed', 'onlyA', 'onlyB'];

export interface DiffEntry {
  kind: DiffKind;
  side: 'A' | 'B';
  clipId: ID;
  mediaId: ID;
  name: string;
  trackIndex: number;
  /** Timeline range in the owning sequence's frames. */
  start: number;
  end: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  speed: number;
  enabled: boolean;
  key: string;
  /** Counterpart on the other side for same / moved / trimmed. */
  match?: { clipId: ID; start: number; end: number; trackIndex: number };
  /** moved (and trimmed when also displaced): counterpart start minus own start, in this side's frames. */
  positionDelta?: number;
  /** trimmed: frames by which B differs from A at the head (positive = B starts later in the source). */
  headDelta?: number;
  /** trimmed: frames by which B differs from A at the tail (positive = B ends later in the source). */
  tailDelta?: number;
}

export type DiffCounts = Record<DiffKind, number>;

export interface DiffResult {
  a: DiffEntry[];
  b: DiffEntry[];
  /** same / moved / trimmed count pairs once; onlyA / onlyB count clips. */
  counts: DiffCounts;
  durationA: number;
  durationB: number;
  /** B's duration expressed in A's frame rate minus A's duration. */
  durationDelta: number;
  fpsMismatch: boolean;
}

interface Item {
  clip: Clip;
  /** Position in the side's collected list (B: candidate order for tie-breaking). */
  index: number;
  trackIndex: number;
  /** start / duration expressed in A's frame rate (identity for A). */
  startA: number;
  durationA: number;
  sourceOut: number;
  key: string;
}

export function clipIdentityKey(c: Clip, durationFrames = c.duration): string {
  return `${c.mediaId}|${Math.round(c.sourceIn * 1000)}|${durationFrames}|${c.speed}`;
}

/** Round half away from zero, never -0: a delta of -2.5 frames mirrors +2.5 (-3 / +3). */
function roundSigned(x: number): number {
  const r = x < 0 ? -Math.round(-x) : Math.round(x);
  return r === 0 ? 0 : r;
}

/** secondsToFrames for signed deltas: symmetric around 0 and never -0. */
function deltaFrames(seconds: number, fps: Rational): number {
  const f = secondsToFrames(Math.abs(seconds), fps);
  return seconds < 0 && f !== 0 ? -f : f;
}

function convertFrames(frames: number, from: Rational, to: Rational): number {
  if (fpsEquals(from, to)) return frames;
  return roundSigned((frames * to.num * from.den) / (to.den * from.num));
}

function collect(seq: Sequence, fpsA: Rational): Item[] {
  const out: Item[] = [];
  seq.videoTracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      const durationA = convertFrames(clip.duration, seq.fps, fpsA);
      out.push({
        clip, index: out.length, trackIndex,
        startA: convertFrames(clip.start, seq.fps, fpsA),
        durationA,
        sourceOut: clipSourceOut(clip, seq.fps),
        key: clipIdentityKey(clip, durationA),
      });
    }
  });
  return out;
}

function entryOf(it: Item, side: 'A' | 'B', kind: DiffKind): DiffEntry {
  const c = it.clip;
  return {
    kind, side, clipId: c.id, mediaId: c.mediaId, name: c.name, trackIndex: it.trackIndex,
    start: c.start, end: c.start + c.duration, duration: c.duration, sourceIn: c.sourceIn, sourceOut: it.sourceOut,
    speed: c.speed, enabled: c.enabled, key: it.key,
  };
}

function matchRef(it: Item) {
  return { clipId: it.clip.id, start: it.clip.start, end: it.clip.start + it.clip.duration, trackIndex: it.trackIndex };
}

function byPosition(x: DiffEntry, y: DiffEntry): number {
  return x.start - y.start || x.trackIndex - y.trackIndex || x.clipId.localeCompare(y.clipId);
}

function sourceOverlap(a: Item, b: Item): number {
  return Math.min(a.sourceOut, b.sourceOut) - Math.max(a.clip.sourceIn, b.clip.sourceIn);
}

/** Pick the best remaining candidate by a score (higher wins); ties prefer same track then nearest start. */
function pick(a: Item, candidates: Item[], score: (b: Item) => number): Item | undefined {
  let best: Item | undefined;
  let bestScore = -Infinity;
  for (const b of candidates) {
    const s = score(b);
    if (s === -Infinity) continue;
    const tie = best ? (b.trackIndex === a.trackIndex ? 1 : 0) - (best.trackIndex === a.trackIndex ? 1 : 0) : 0;
    const closer = best ? Math.abs(best.startA - a.startA) - Math.abs(b.startA - a.startA) : 0;
    if (!best || s > bestScore || (s === bestScore && (tie > 0 || (tie === 0 && closer > 0)))) { best = b; bestScore = s; }
  }
  return best;
}

function groupBy(items: Item[], keyOf: (it: Item) => string): Map<string, Item[]> {
  const m = new Map<string, Item[]>();
  for (const it of items) { const k = keyOf(it); const l = m.get(k); if (l) l.push(it); else m.set(k, [it]); }
  return m;
}

/** First index in `sorted` (ascending sourceIn) whose sourceIn is >= v. */
function lowerBound(sorted: Item[], v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid].clip.sourceIn < v) lo = mid + 1; else hi = mid; }
  return lo;
}

export function diffSequences(a: Sequence, b: Sequence): DiffResult {
  const fpsA = a.fps;
  const itemsA = collect(a, fpsA);
  const itemsB = collect(b, fpsA);
  const unmatchedB = new Set(itemsB);
  const outA: DiffEntry[] = [];
  const outB: DiffEntry[] = [];
  const counts: DiffCounts = { same: 0, moved: 0, trimmed: 0, onlyA: 0, onlyB: 0 };

  const pairs: { a: Item; b: Item; kind: DiffKind }[] = [];
  let pending = itemsA;

  // Each pass pairs every pending A clip with the best unmatched B clip. Instead of scoring every B clip
  // (quadratic: 5k x 5k clips took over a second), candidates come from an index that contains every B clip
  // that can score at all; `pick` sees them in B's order, so the result is the same as a full scan.
  const pass = (kind: DiffKind, candidatesOf: (x: Item) => Item[], score: (x: Item, y: Item) => number) => {
    const rest: Item[] = [];
    for (const x of pending) {
      const y = pick(x, candidatesOf(x).filter((c) => unmatchedB.has(c)), (c) => score(x, c));
      if (y) { unmatchedB.delete(y); pairs.push({ a: x, b: y, kind }); }
      else rest.push(x);
    }
    pending = rest;
  };
  const none: Item[] = [];
  // Pass 1: identical clips at the same position.
  const byKeyAt = groupBy(itemsB, (it) => `${it.key}@${it.startA}`);
  pass('same', (x) => byKeyAt.get(`${x.key}@${x.startA}`) ?? none, (x, y) => (x.key === y.key && x.startA === y.startA ? 1 : -Infinity));
  // Pass 2: identical clips elsewhere.
  const byKey = groupBy(itemsB, (it) => it.key);
  pass('moved', (x) => byKey.get(x.key) ?? none, (x, y) => (x.key === y.key ? 1 : -Infinity));
  // Pass 3: same media with overlapping source ranges. Per media, B clips sorted by sourceIn; a clip can only
  // overlap x if its sourceIn lies in [x.sourceIn - longest range, x.sourceOut].
  const byMedia = new Map<string, { sorted: Item[]; maxLen: number }>();
  for (const [mediaId, list] of groupBy(itemsB.filter((it) => !Number.isNaN(it.clip.sourceIn) && !Number.isNaN(it.sourceOut)), (it) => it.clip.mediaId)) {
    let maxLen = 0;
    for (const it of list) maxLen = Math.max(maxLen, it.sourceOut - it.clip.sourceIn);
    byMedia.set(mediaId, { sorted: [...list].sort((p, q) => p.clip.sourceIn - q.clip.sourceIn || p.index - q.index), maxLen });
  }
  pass('trimmed', (x) => {
    const g = byMedia.get(x.clip.mediaId);
    if (!g || Number.isNaN(x.clip.sourceIn) || Number.isNaN(x.sourceOut)) return none;
    const out: Item[] = [];
    for (let i = lowerBound(g.sorted, x.clip.sourceIn - g.maxLen - 1e-9 * (1 + g.maxLen)); i < g.sorted.length && g.sorted[i].clip.sourceIn <= x.sourceOut; i++) {
      if (unmatchedB.has(g.sorted[i])) out.push(g.sorted[i]);
    }
    return out.sort((p, q) => p.index - q.index);
  }, (x, y) => {
    if (x.clip.mediaId !== y.clip.mediaId) return -Infinity;
    const ov = sourceOverlap(x, y);
    return ov > 0 ? ov : -Infinity;
  });

  for (const { a: x, b: y, kind } of pairs) {
    counts[kind]++;
    const ea = entryOf(x, 'A', kind);
    const eb = entryOf(y, 'B', kind);
    ea.match = matchRef(y);
    eb.match = matchRef(x);
    if (kind !== 'same') {
      const deltaA = y.startA - x.startA;
      if (deltaA !== 0) {
        ea.positionDelta = deltaA;
        eb.positionDelta = convertFrames(-deltaA, fpsA, b.fps);
      }
    }
    if (kind === 'trimmed') {
      const head = deltaFrames((y.clip.sourceIn - x.clip.sourceIn) / x.clip.speed, fpsA);
      const tail = deltaFrames((y.sourceOut - x.sourceOut) / x.clip.speed, fpsA);
      ea.headDelta = head; ea.tailDelta = tail;
      eb.headDelta = head; eb.tailDelta = tail;
    }
    outA.push(ea);
    outB.push(eb);
  }
  for (const x of pending) { counts.onlyA++; outA.push(entryOf(x, 'A', 'onlyA')); }
  for (const y of unmatchedB) { counts.onlyB++; outB.push(entryOf(y, 'B', 'onlyB')); }

  outA.sort(byPosition);
  outB.sort(byPosition);
  const durationA = sequenceDuration(a);
  const durationB = sequenceDuration(b);
  return {
    a: outA, b: outB, counts, durationA, durationB,
    durationDelta: convertFrames(durationB, b.fps, fpsA) - durationA,
    fpsMismatch: !fpsEquals(a.fps, b.fps),
  };
}

/** Human summary like "3 same · 1 moved · 1 only in A". */
export function summarizeDiff(counts: DiffCounts): string {
  const parts: string[] = [];
  if (counts.same) parts.push(`${counts.same} same`);
  if (counts.moved) parts.push(`${counts.moved} moved`);
  if (counts.trimmed) parts.push(`${counts.trimmed} trimmed`);
  if (counts.onlyA) parts.push(`${counts.onlyA} only in A`);
  if (counts.onlyB) parts.push(`${counts.onlyB} only in B`);
  return parts.length ? parts.join(' · ') : 'No video clips';
}
