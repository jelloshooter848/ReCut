/**
 * Nested sequences and compound clips (Roadmap §8). Pure: no DOM, no Node.
 *
 * A nested clip is an ordinary Clip with `sequenceId` set: it plays that project sequence (the "inner" sequence)
 * instead of a media file. Its `mediaId` holds the same id, so the trim limits (the "media duration" is the inner
 * sequence's length) and the linked-clip sync badge work unchanged; `sourceIn` is seconds of the inner timeline and
 * `speed` is always 1. A nested clip on a video track shows the inner sequence's video tracks, one on an audio track
 * plays the inner sequence's audio tracks.
 *
 * Preview and export share one path: `flattenSequence` turns a sequence with nested clips into an equivalent
 * sequence of media clips only, which the preview planner (src/playback/planner.ts) and the export plan / render
 * graph (shared/exportPlan.ts, electron/export/renderGraph.ts) render as they render any sequence. No intermediate
 * file is rendered. Rules (docs/ARCHITECTURE.md "Nested sequences"):
 *
 * - Time: the inner sequence is played at the outer frame rate. Outer frame f shows the inner timeline at time
 *   `sourceIn + (f - start) / outerFps`; an inner clip covers the outer frames whose start time lies inside it (an
 *   inner cut lands on the first outer frame that starts at or after it), and plays its media at that time. With
 *   equal frame rates this is frame for frame.
 * - Each active inner track (mute / solo of the inner sequence) becomes a track of the flattened sequence at the
 *   nested clip's place in the outer track order; clips keep their own transitions.
 * - Picture: the inner frame is conformed into the outer frame like a media file (fit, then the nested clip's
 *   transform): the transforms are composed per layer, the nested clip's crop and the inner frame edge clip each
 *   unrotated layer, and the nested clip's opacity multiplies each layer's (so overlapping semi-transparent inner
 *   layers show through each other, see docs/LIMITATIONS.md).
 * - Sound: inner track volume, clip gain / volume / fades, then the nested clip's gain, volume and fades.
 * - Transitions at a nested clip's edges become gain / alpha ramps ("envelopes") on the clips of both sides, with
 *   the inner frames before / after the nested clip's in / out as its handles.
 * - The nested clip past the end of its inner sequence is empty (black / silence), like media trimmed past its end.
 * - References to a missing sequence, or that close a cycle, render nothing (normalizeProject repairs cycles).
 * - Limits: nesting is at most MAX_NEST_DEPTH levels deep, and no sequence may flatten to more than MAX_FLAT_TRACKS
 *   tracks or MAX_FLAT_CLIPS clips (flattenedSize, computed without flattening). nestProblem / nestLimitProblem
 *   refuse edits past them; normalizeProject cuts references past them in files (nestingRepairs, nestSizeRepairs).
 */
import type { Clip, ClipAudio, ClipTransform, ID, Keyframe, MediaItem, Rational, Sequence, SequenceSubtitleTrack, Track, TransformKeyframes, Transition } from './model';
import { evaluateKeyframes, hasKeyframes, hasMotionKeyframes, MAX_KEYFRAMES_PER_PROPERTY, TRANSFORM_KEY_PROPS } from './keyframes';
import { addClipSorted, addTrack, clipEnd, makeClip, makeTrack, readItems, reconcileTransitions, removeClips, resolveSubtitleCues, sequenceDuration } from './timeline';
import { uid } from './ids';
import { activeTracks, isImageMedia, mediaDurationSec } from './exportPlan';
import { videoDisplaySize } from './media';
import { fpsEquals } from './time';

/** Deepest chain of nested sequences (A in B in C ... : at most this many levels below the top sequence). */
export const MAX_NEST_DEPTH = 8;

/**
 * Most tracks (video and audio together) and clips a sequence may flatten to (`flattenSequence`, measured by
 * `flattenedSize`), beside MAX_NEST_DEPTH: every active inner track of every nested clip becomes a flattened track,
 * so nesting multiplies per level (9 sequences each nesting the next on 4 tracks flatten to 349,524 tracks).
 * A sequence whose own tracks / clips are already more than this is held to its own count instead.
 *
 * Measured on the development machine (Linux, Node 22, warm, median of 7 runs), flattenSequence takes:
 * - 993 flattened tracks (1 clip each): 3 ms. Tracks are cheap; 1,000 leaves room for any real edit (a season of 20
 *   episodes of 6 tracks, each nesting 5 scenes of 6 tracks, with dissolves between them, counts 42).
 * - flattened clips: about 3 to 6 us each, so ~150 ms (one level of nesting) to ~250 ms (two levels) at 50,000.
 *   A realistic season (20 episodes x 5 scenes, about 24,000 clips) already takes ~100 ms, so a lower limit would
 *   cut real projects; 50,000 is twice that season. (100,000 measured 300 to 620 ms.)
 */
export const MAX_FLAT_TRACKS = 1_000;
export const MAX_FLAT_CLIPS = 50_000;

/** A clip that plays a sequence. */
export function isNestedClip(c: Pick<Clip, 'sequenceId'> | null | undefined): c is Clip & { sequenceId: ID } {
  return !!c && typeof c.sequenceId === 'string' && c.sequenceId !== '';
}

type Seqs = Readonly<Record<ID, Sequence>>;

function own(sequences: Seqs, id: ID): Sequence | undefined {
  return Object.hasOwn(sequences, id) ? sequences[id] : undefined;
}

/** Sequence ids the clips of `seq` nest directly (cached per track list). */
const refsCache = new WeakMap<object, ID[]>();
export function nestedSequenceRefs(seq: Pick<Sequence, 'videoTracks' | 'audioTracks'>): readonly ID[] {
  const key = seq.videoTracks;
  const hit = refsCache.get(key);
  if (hit && refsCache.get(seq.audioTracks) === hit) return hit;
  const set = new Set<ID>();
  for (const t of seq.videoTracks) for (const c of t.clips) if (isNestedClip(c)) set.add(c.sequenceId);
  for (const t of seq.audioTracks) for (const c of t.clips) if (isNestedClip(c)) set.add(c.sequenceId);
  const out = [...set];
  refsCache.set(key, out); refsCache.set(seq.audioTracks, out);
  return out;
}

/** True when any clip of `seq` is a nested clip. */
export function hasNestedClips(seq: Pick<Sequence, 'videoTracks' | 'audioTracks'>): boolean {
  return nestedSequenceRefs(seq).length > 0;
}

/** Every sequence reachable from `seqId` through nested clips (not including `seqId` unless a cycle leads back). */
export function reachableSequences(sequences: Seqs, seqId: ID): Set<ID> {
  const seen = new Set<ID>();
  const stack = [...(own(sequences, seqId) ? nestedSequenceRefs(sequences[seqId]) : [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = own(sequences, id);
    if (s) for (const r of nestedSequenceRefs(s)) if (!seen.has(r)) stack.push(r);
  }
  return seen;
}

/** The project sequences `seq` needs to render (transitively), keyed by id: what an ExportRequest carries. */
export function nestedSequencesFor(seq: Sequence, sequences: Seqs): Record<ID, Sequence> {
  const out: Record<ID, Sequence> = {};
  const stack = [...nestedSequenceRefs(seq)];
  while (stack.length) {
    const id = stack.pop()!;
    if (Object.hasOwn(out, id)) continue;
    const s = own(sequences, id);
    if (!s) continue;
    out[id] = s;
    for (const r of nestedSequenceRefs(s)) stack.push(r);
  }
  return out;
}

/** Longest chain of nested sequences below `seqId` (0: nests nothing). Cycles count as unbounded (Infinity). */
export function nestDepthBelow(sequences: Seqs, seqId: ID, memo = new Map<ID, number>(), onPath = new Set<ID>()): number {
  const m = memo.get(seqId);
  if (m !== undefined) return m;
  if (onPath.has(seqId)) return Infinity;
  const s = own(sequences, seqId);
  if (!s) return 0;
  onPath.add(seqId);
  let d = 0;
  for (const r of nestedSequenceRefs(s)) {
    if (!own(sequences, r)) continue;
    d = Math.max(d, 1 + nestDepthBelow(sequences, r, memo, onPath));
  }
  onPath.delete(seqId);
  memo.set(seqId, d);
  return d;
}

/** Longest chain of sequences nesting `seqId` (0: nothing nests it). Cycles count as Infinity. */
export function nestDepthAbove(sequences: Seqs, seqId: ID): number {
  // parents index
  const parents = new Map<ID, ID[]>();
  for (const id of Object.keys(sequences)) {
    for (const r of nestedSequenceRefs(sequences[id])) {
      const l = parents.get(r);
      if (l) { if (!l.includes(id)) l.push(id); } else parents.set(r, [id]);
    }
  }
  const memo = new Map<ID, number>();
  const onPath = new Set<ID>();
  const up = (id: ID): number => {
    const m = memo.get(id);
    if (m !== undefined) return m;
    if (onPath.has(id)) return Infinity;
    onPath.add(id);
    let d = 0;
    for (const p of parents.get(id) ?? []) d = Math.max(d, 1 + up(p));
    onPath.delete(id);
    memo.set(id, d);
    return d;
  };
  return up(seqId);
}

/** Why `childId` cannot be nested in `hostId`, or null when it can. */
export type NestProblem = 'missing' | 'self' | 'cycle' | 'depth' | 'size';

/**
 * Why `childId` cannot be nested in `hostId`, or null when it can. `adding` are the clips the caller adds to the
 * host, for the size limit (MAX_FLAT_TRACKS / MAX_FLAT_CLIPS on the host and every sequence that contains it): by
 * default one clip per kind playing the whole child (what nesting the sequence makes), each on a new track. Pass
 * `[]` when `sequences` already holds the edited host (a dry run of the edit, as the store does): the size is then
 * measured on it as it is.
 */
export function nestProblem(sequences: Seqs, hostId: ID, childId: ID, adding?: readonly Clip[]): NestProblem | null {
  const host = own(sequences, hostId), child = own(sequences, childId);
  if (!child || !host) return 'missing';
  if (hostId === childId) return 'self';
  if (reachableSequences(sequences, childId).has(hostId)) return 'cycle';
  if (nestDepthAbove(sequences, hostId) + 1 + nestDepthBelow(sequences, childId) > MAX_NEST_DEPTH) return 'depth';
  const add = adding ?? wholeNestedClips(host, child);
  const seqs = add.length ? { ...sequences, [hostId]: withExtraTracks(host, add) } : sequences;
  if (nestSizeExceeded(seqs, hostId)) return 'size';
  return null;
}

/**
 * The nesting limits for an edited project (`sequences` already holds the edit made in `hostId`, e.g. Make Compound
 * Clip or Break Apart on a copy): 'cycle' when the host contains itself, 'depth' when a chain of nested sequences
 * through it is deeper than MAX_NEST_DEPTH, 'size' when it or a sequence that contains it flattens past the size
 * limits; null when none.
 */
export function nestLimitProblem(sequences: Seqs, hostId: ID): Exclude<NestProblem, 'missing' | 'self'> | null {
  if (!own(sequences, hostId)) return null;
  if (reachableSequences(sequences, hostId).has(hostId)) return 'cycle';
  if (nestDepthAbove(sequences, hostId) + nestDepthBelow(sequences, hostId) > MAX_NEST_DEPTH) return 'depth';
  if (nestSizeExceeded(sequences, hostId)) return 'size';
  return null;
}

const fmtCount = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The size limits in words ("1,000 tracks or 50,000 clips"). */
export const FLAT_LIMIT_TEXT = `${fmtCount(MAX_FLAT_TRACKS)} tracks or ${fmtCount(MAX_FLAT_CLIPS)} clips`;

/** User-facing text for a NestProblem ("Cannot nest X in Y: ..."). */
export function nestProblemText(p: NestProblem): string {
  switch (p) {
    case 'missing': return 'the sequence no longer exists';
    case 'self': return 'a sequence cannot contain itself';
    case 'cycle': return 'the sequence already contains this one (directly or through another nested sequence)';
    case 'depth': return `nesting would be more than ${MAX_NEST_DEPTH} levels deep`;
    case 'size': return `nesting would expand to more than ${FLAT_LIMIT_TEXT} when flattened`;
  }
}

// ---------------------------------------------------------------------------------------------------
// Flattened size (the second nesting limit, beside depth)
// ---------------------------------------------------------------------------------------------------

/** Tracks and clips (video and audio together) of a flattened sequence. */
export interface FlatSize { tracks: number; clips: number }

type Kind = 'video' | 'audio';
const KINDS: readonly Kind[] = ['video', 'audio'];

/**
 * One kind of a sequence as flattening makes it: its track and clip count, and its clips as weighted spans over its
 * timeline (frames), so the clips a nested clip of this sequence plays over a window are a prefix-sum lookup.
 */
interface KindSize {
  tracks: number;
  clips: number;
  starts: Float64Array; startSum: Float64Array; // spans by start, prefix sums of their weights
  ends: Float64Array; endSum: Float64Array;     // spans by end, prefix sums of their weights
}

/** A nested clip that expands: its span on its track widened by transition handles, its inner tracks and clips. */
interface NestItem { clip: Clip; start: number; from: number; to: number; n: number; w: number }
interface TrackScan { clips: number; nested: NestItem[]; plain: { from: number; to: number }[] }

/** Frames a transition at a nested clip's edge can add before / after it (flattenTrack's handles, at most half its length). */
function edgeExtents(T: Track, kind: Kind): Map<ID, { before: number; after: number }> {
  const out = new Map<ID, { before: number; after: number }>();
  const get = (id: ID) => { let x = out.get(id); if (!x) { x = { before: 0, after: 0 }; out.set(id, x); } return x; };
  for (const tr of T.transitions) {
    if (!tr.outClipId || !tr.inClipId || tr.type === 'dipToBlack' || !typeOk(kind, tr.type)) continue;
    const D = Math.round(tr.duration);
    if (!Number.isFinite(D) || D <= 0) continue;
    const h = Math.floor(D / 2);
    const i = get(tr.inClipId), o = get(tr.outClipId);
    if (h > i.before) i.before = h;
    if (h > o.after) o.after = h;
  }
  return out;
}

/**
 * Tracks flattenTrack makes for the nested clips `items` (in start order) beside the base track: each goes to the
 * first group (in creation order) that has ended by its start, else to a new group; a group has as many tracks as
 * its widest member. First fit through a segment tree of group ends, so a track with thousands of overlapping
 * nested clips stays O(n log n).
 */
function groupTracks(items: readonly NestItem[]): number {
  if (items.length === 0) return 0;
  let cap = 1;
  while (cap < items.length) cap *= 2;
  const tree = new Float64Array(2 * cap).fill(Infinity);
  const widest: number[] = [];
  for (const it of items) {
    let g = -1;
    if (tree[1] <= it.from) {
      let i = 1;
      while (i < cap) i = tree[2 * i] <= it.from ? 2 * i : 2 * i + 1;
      g = i - cap;
    }
    if (g < 0) { g = widest.length; widest.push(it.n); } else if (it.n > widest[g]) widest[g] = it.n;
    let i = g + cap;
    tree[i] = it.to;
    for (i >>= 1; i >= 1; i >>= 1) tree[i] = Math.min(tree[2 * i], tree[2 * i + 1]);
  }
  let n = 0;
  for (const x of widest) n += x;
  return n;
}

/** First index of sorted `a` whose value is greater than `x`. */
function upperBound(a: Float64Array, x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

/** Weight of the spans that start at or before `b` and end after `a` (all of them when the window is not finite). */
function windowSum(k: KindSize, a: number, b: number): number {
  const total = k.startSum[k.startSum.length - 1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return total;
  const v = k.startSum[upperBound(k.starts, b)] - k.endSum[upperBound(k.ends, a)];
  return v < 0 ? 0 : v > total ? total : v;
}

function spansOf(list: { from: number; to: number; w: number }[]): Pick<KindSize, 'starts' | 'startSum' | 'ends' | 'endSum'> {
  const build = (key: 'from' | 'to') => {
    const sorted = [...list].sort((x, y) => x[key] - y[key]);
    const at = new Float64Array(sorted.length), sum = new Float64Array(sorted.length + 1);
    sorted.forEach((x, i) => { at[i] = x[key]; sum[i + 1] = sum[i] + x.w; });
    return [at, sum] as const;
  };
  const [starts, startSum] = build('from');
  const [ends, endSum] = build('to');
  return { starts, startSum, ends, endSum };
}

/**
 * The size flattenSequence gives each sequence, computed from per-sequence counts memoized bottom-up, without
 * flattening. It counts every clip and track as enabled and unmuted (so disabling a clip or muting a track never
 * changes it), and for a nested clip the inner clips its window (with transition handles) overlaps, so a nested
 * sequence cut into many pieces counts about once. Clips in `cut` count as plain clips (references being removed).
 */
class FlatSizer {
  private readonly memo = new Map<string, KindSize | null>();
  readonly cut = new Set<Clip>();
  constructor(private readonly sequences: Seqs) {}

  /** Measure `id` again (after cutting some of its clips). */
  forget(id: ID): void { for (const k of KINDS) this.memo.delete(`${k}\u0000${id}`); }

  total(id: ID): FlatSize {
    let tracks = 0, clips = 0;
    for (const k of KINDS) { const s = this.of(id, k); if (s) { tracks += s.tracks; clips += s.clips; } }
    return { tracks, clips };
  }

  of(id: ID, kind: Kind): KindSize | null {
    const key = `${kind}\u0000${id}`;
    if (this.memo.has(key)) return this.memo.get(key)!;
    const seq = own(this.sequences, id);
    if (!seq) return null;
    this.memo.set(key, null); // a reference back while measuring (only through a cycle) expands to nothing
    let tracks = 0, clips = 0;
    const spans: { from: number; to: number; w: number }[] = [];
    for (const t of this.scan(seq, kind)) {
      tracks += 1 + groupTracks(t.nested);
      clips += t.clips;
      for (const p of t.plain) spans.push({ from: p.from, to: p.to, w: 1 });
      for (const x of t.nested) { clips += x.w; if (x.w > 0) spans.push({ from: x.from, to: x.to, w: x.w }); }
    }
    const out: KindSize = { tracks, clips, ...spansOf(spans) };
    this.memo.set(key, out);
    return out;
  }

  /** Per track of `kind`: its clip count, its nested clips that expand (not cut, inner present, no cycle), its other clips. */
  scan(seq: Sequence, kind: Kind): TrackScan[] {
    const fdO = fdOf(seq.fps);
    return (kind === 'video' ? seq.videoTracks : seq.audioTracks).map((T) => {
      const ext = edgeExtents(T, kind);
      const nested: NestItem[] = [];
      const plain: TrackScan['plain'] = [];
      for (const c of T.clips) {
        const e = ext.get(c.id);
        const from = c.start - (e?.before ?? 0), to = clipEnd(c) + (e?.after ?? 0);
        if (!isNestedClip(c) || this.cut.has(c)) { plain.push({ from, to }); continue; }
        const inner = own(this.sequences, c.sequenceId);
        if (!inner || cyclic(this.sequences, seq.id, c.sequenceId)) continue;
        const k = this.of(c.sequenceId, kind);
        if (!k) continue;
        // The inner clips flattenTrack / mapNested keep: they end after the window's first outer frame and start
        // at or before its last one (outer frame f shows inner time sourceIn + (f - start) x outer frame duration).
        const fdI = fdOf(inner.fps);
        const a = (c.sourceIn + (from - c.start + 1e-6) * fdO) / fdI;
        const b = (c.sourceIn + (to - 1 - c.start + 1e-6) * fdO) / fdI;
        nested.push({ clip: c, start: c.start, from, to, n: k.tracks, w: windowSum(k, a, b) });
      }
      nested.sort((x, y) => x.start - y.start);
      return { clips: T.clips.length, nested, plain };
    });
  }
}

const ownTracks = (s: Sequence) => s.videoTracks.length + s.audioTracks.length;
function ownClips(s: Sequence): number {
  let n = 0;
  for (const t of s.videoTracks) n += t.clips.length;
  for (const t of s.audioTracks) n += t.clips.length;
  return n;
}
/** True when `size` is past the limits for `seq` (a sequence is always allowed its own tracks and clips). */
function overLimit(seq: Sequence, size: FlatSize): boolean {
  return size.tracks > Math.max(MAX_FLAT_TRACKS, ownTracks(seq)) || size.clips > Math.max(MAX_FLAT_CLIPS, ownClips(seq));
}

/**
 * Tracks and clips (video and audio together) flattenSequence makes of `seqId` with every clip and track enabled:
 * an upper bound of what it makes, computed without flattening (see FlatSizer). Zero for a missing sequence.
 */
export function flattenedSize(sequences: Seqs, seqId: ID): FlatSize {
  return new FlatSizer(sequences).total(seqId);
}

/** Sequences that contain `seqId` (directly or through other nested sequences). */
function containers(sequences: Seqs, seqId: ID): ID[] {
  const parents = new Map<ID, ID[]>();
  for (const id of Object.keys(sequences)) {
    for (const r of nestedSequenceRefs(sequences[id])) {
      const l = parents.get(r);
      if (l) l.push(id); else parents.set(r, [id]);
    }
  }
  const seen = new Set<ID>([seqId]);
  const stack = [seqId];
  const out: ID[] = [];
  while (stack.length) {
    for (const p of parents.get(stack.pop()!) ?? []) if (!seen.has(p)) { seen.add(p); out.push(p); stack.push(p); }
  }
  return out;
}

/** True when `hostId` or a sequence that contains it flattens past MAX_FLAT_TRACKS / MAX_FLAT_CLIPS. */
export function nestSizeExceeded(sequences: Seqs, hostId: ID): boolean {
  const sizer = new FlatSizer(sequences);
  for (const id of [hostId, ...containers(sequences, hostId)]) {
    const s = own(sequences, id);
    if (s && overLimit(s, sizer.total(id))) return true;
  }
  return false;
}

/** The nested clips nesting `child` in `host` makes (as nestedClipsFor), for measuring only. */
function wholeNestedClips(host: Sequence, child: Sequence): Clip[] {
  const hasV = child.videoTracks.some((t) => t.clips.length > 0);
  const hasA = child.audioTracks.some((t) => t.clips.length > 0);
  const kinds: Kind[] = hasV || hasA ? KINDS.filter((k) => (k === 'video' ? hasV : hasA)) : [...KINDS];
  const duration = Math.max(1, Math.floor((sequenceSeconds(child) * host.fps.num) / host.fps.den + 1e-6));
  return kinds.map((kind) => ({ id: `\u0000nest-check-${kind}`, mediaId: child.id, sequenceId: child.id, name: '', start: 0, duration, sourceIn: 0, speed: 1, kind, enabled: true, linkId: null } as unknown as Clip));
}

/** `host` with one more track per kind holding the clips of `add` of that kind (for measuring only). */
function withExtraTracks(host: Sequence, add: readonly Clip[]): Sequence {
  const extra = (kind: Kind, list: Track[]): Track[] => {
    const clips = add.filter((c) => (c.kind ?? 'video') === kind);
    return clips.length ? [...list, { id: `\u0000nest-check-${kind}`, clips, transitions: [] } as unknown as Track] : list;
  };
  return { ...host, videoTracks: extra('video', host.videoTracks), audioTracks: extra('audio', host.audioTracks) };
}

/** Length of a sequence's timeline in seconds (what a nested clip can play). */
export function sequenceSeconds(seq: Sequence): number {
  return (sequenceDuration(seq) * seq.fps.den) / seq.fps.num;
}

/**
 * The nested references that must be cut so the project has no cycle and no chain deeper than MAX_NEST_DEPTH:
 * `[hostId, childId]` pairs, in a deterministic order (`order` first, then the remaining ids sorted). Used by
 * normalizeProject: the clips of such a pair lose their `sequenceId` (they become clips of missing media).
 */
export function nestingRepairs(sequences: Seqs, order: readonly ID[]): [ID, ID][] {
  const ids = [...new Set([...order.filter((id) => own(sequences, id)), ...Object.keys(sequences).sort()])];
  const cut = new Set<string>();
  const key = (a: ID, b: ID) => `${a}\u0000${b}`;
  const out: [ID, ID][] = [];
  const edges = (id: ID) => nestedSequenceRefs(sequences[id]).filter((r) => own(sequences, r) && !cut.has(key(id, r)));
  // Cycles: depth-first from each sequence in order; a reference back to a sequence on the current path is cut.
  const state = new Map<ID, 1 | 2>();
  const visit = (id: ID) => {
    state.set(id, 1);
    for (const r of edges(id)) {
      const st = state.get(r);
      if (st === 1) { cut.add(key(id, r)); out.push([id, r]); continue; }
      if (st === undefined) visit(r);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  // Depth: longest path from any root; a reference that would sit deeper than the limit is cut.
  let changed = true;
  while (changed) {
    changed = false;
    const below = new Map<ID, number>();
    const depthBelow = (id: ID): number => {
      const m = below.get(id);
      if (m !== undefined) return m;
      let d = 0;
      for (const r of edges(id)) d = Math.max(d, 1 + depthBelow(r));
      below.set(id, d);
      return d;
    };
    for (const id of ids) {
      if (depthBelow(id) <= MAX_NEST_DEPTH) continue;
      // Walk down the deepest chain and cut its first reference past the limit.
      let cur = id, level = 0;
      while (true) {
        const next = edges(cur).find((r) => depthBelow(r) + 1 === depthBelow(cur));
        if (next === undefined) break;
        level++;
        if (level > MAX_NEST_DEPTH) { cut.add(key(cur, next)); out.push([cur, next]); changed = true; break; }
        cur = next;
      }
      if (changed) break;
    }
  }
  return out;
}

/**
 * The nested clips that must be cut so no sequence flattens past MAX_FLAT_TRACKS / MAX_FLAT_CLIPS (flattenedSize;
 * a sequence is always allowed its own tracks and clips): `[hostId, clipId]` pairs, in a deterministic order. Used
 * by normalizeProject after nestingRepairs (no cycles, no chain past MAX_NEST_DEPTH): such a clip loses its
 * `sequenceId` (it becomes a clip of missing media), and the clips linked to it that nest the same sequence go with
 * it (a nested picture + sound pair is cut as one).
 *
 * Greedy, bottom up: sequences in order of nesting depth below them (`order` first, then the remaining ids sorted,
 * among equals), each measured with what it nests already cut down. In a sequence past a limit, nested clips are cut
 * widest first (most inner tracks while the track count is over, then most clips while the clip count is over; the
 * later one on the timeline among equals) until it fits. Cutting a sequence's own references never changes the
 * sequences below it, so the result passes again unchanged: normalizing the repaired project cuts nothing more.
 */
export function nestSizeRepairs(sequences: Seqs, order: readonly ID[]): [ID, ID][] {
  const ids = [...new Set([...order.filter((id) => own(sequences, id)), ...Object.keys(sequences).sort()])];
  const depth = new Map<ID, number>();
  const rank = new Map<ID, number>();
  ids.forEach((id, i) => { rank.set(id, i); nestDepthBelow(sequences, id, depth); });
  const bottomUp = [...ids].sort((a, b) => (depth.get(a)! - depth.get(b)!) || (rank.get(a)! - rank.get(b)!));
  const sizer = new FlatSizer(sequences);
  const out: [ID, ID][] = [];
  for (const id of bottomUp) {
    const seq = sequences[id];
    if (!overLimit(seq, sizer.total(id))) continue;
    // Units: a nested clip and the clips linked to it that nest the same sequence, in timeline order.
    const scans = KINDS.map((k) => sizer.scan(seq, k));
    const units = new Map<string, { clips: Clip[]; n: number; w: number; at: number }>();
    let at = 0;
    for (const kind of scans) for (const t of kind) for (const x of t.nested) {
      const key = x.clip.linkId ? `l\u0000${x.clip.linkId}\u0000${x.clip.sequenceId}` : `c\u0000${x.clip.id}\u0000${at}`;
      let u = units.get(key);
      if (!u) { u = { clips: [], n: 0, w: 0, at: at++ }; units.set(key, u); }
      u.clips.push(x.clip); u.n += x.n; u.w += x.w;
    }
    const cut = new Set<Clip>();
    const base = ownClips(seq);
    const measure = (extra: readonly { clips: Clip[] }[] = []): FlatSize => {
      const gone = new Set(cut);
      for (const u of extra) for (const c of u.clips) gone.add(c);
      let tracks = 0, clips = base;
      for (const kind of scans) for (const t of kind) {
        const live = t.nested.filter((x) => !gone.has(x.clip));
        tracks += 1 + groupTracks(live);
        for (const x of live) clips += x.w;
      }
      return { tracks, clips };
    };
    const limT = Math.max(MAX_FLAT_TRACKS, ownTracks(seq)), limC = Math.max(MAX_FLAT_CLIPS, base);
    for (;;) {
      const now = measure();
      const byTracks = now.tracks > limT;
      if (!byTracks && now.clips <= limC) break;
      const left = [...units.values()].filter((u) => !u.clips.some((c) => cut.has(c)));
      left.sort(byTracks ? (a, b) => (b.n - a.n) || (b.at - a.at) : (a, b) => (b.w - a.w) || (b.at - a.at));
      // The shortest run of `left` that brings the count within the limit (cutting all of them always does).
      let lo = 1, hi = left.length;
      const fits = (k: number) => { const s = measure(left.slice(0, k)); return byTracks ? s.tracks <= limT : s.clips <= limC; };
      while (lo < hi) { const mid = (lo + hi) >> 1; if (fits(mid)) hi = mid; else lo = mid + 1; }
      for (const u of left.slice(0, hi)) for (const c of u.clips) cut.add(c);
    }
    for (const c of cut) { sizer.cut.add(c); out.push([id, c.id]); }
    sizer.forget(id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------------------------------

/**
 * A linear ramp over absolute frames `[from, to)` of the flattened sequence: weight 0 -> 1 (`dir` 1) or 1 -> 0
 * (`dir` -1), clamped outside. Multiplies a clip's alpha (video) or gain (audio).
 */
export interface Envelope { from: number; to: number; dir: 1 | -1 }

/** Where a clip of a flattened sequence came from. */
export interface FlatOrigin {
  /** Nested clips it plays inside, outermost first (empty: a clip of the outer sequence itself). */
  path: ID[];
  /** The clip of the sequence it is on (an inner clip, or the outer clip it copies). */
  source: Clip;
  /** The sequence `source` belongs to. */
  sequenceId: ID;
  /** Envelopes (absolute frames of the flattened sequence). */
  env: Envelope[];
}

const origins = new WeakMap<Clip, FlatOrigin>();
const trackGroups = new WeakMap<Track, ID>();
const flatSources = new WeakMap<Sequence, Sequence>();
const flatWarnings = new WeakMap<Sequence, string[]>();

/** Origin of a clip of a flattened sequence (undefined for a clip used as it is). */
export function flatOrigin(c: Clip): FlatOrigin | undefined { return origins.get(c); }

/** Weight (0..1) of a clip's envelopes at `frame` (1 when it has none). */
export function envelopeAt(c: Clip, frame: number): number {
  const o = origins.get(c);
  if (!o || o.env.length === 0) return 1;
  let w = 1;
  for (const e of o.env) w *= envelopeWeight(e, frame);
  return w;
}

export function envelopeWeight(e: Envelope, frame: number): number {
  const len = e.to - e.from;
  if (!(len > 0)) return e.dir > 0 ? (frame >= e.from ? 1 : 0) : (frame < e.from ? 1 : 0);
  const t = (frame - e.from) / len;
  const v = e.dir > 0 ? t : 1 - t;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The outer track a track of a flattened sequence belongs to (its own id for tracks of the outer sequence). */
export function trackGroupId(t: Track): ID { return trackGroups.get(t) ?? t.id; }

/** The sequence a flattened sequence was made from (itself when it was not flattened). */
export function unflattened(seq: Sequence): Sequence { return flatSources.get(seq) ?? seq; }

/** Problems found while flattening (missing / cyclic nested sequences), for export warnings. */
export function flattenWarnings(seq: Sequence): readonly string[] { return flatWarnings.get(seq) ?? []; }

/** The outermost clip of the sequence a flattened clip stands for (its own id for outer clips). */
export function outerClipId(c: Clip): ID {
  const o = origins.get(c);
  return o && o.path.length ? o.path[0] : (o ? o.source.id : c.id);
}

interface Memo {
  media: Readonly<Record<ID, MediaItem>>;
  deps: [ID, Sequence | undefined][];
  flat: Sequence;
}
const memo = new WeakMap<Sequence, Memo>();

/** Strongly connected components of the nesting graph (cycle detection), cached per `sequences` record. */
const sccCache = new WeakMap<object, Map<ID, number>>();
function sccOf(sequences: Seqs): Map<ID, number> {
  let m = sccCache.get(sequences);
  if (m) return m;
  m = new Map();
  let index = 0, comp = 0;
  const idx = new Map<ID, number>(), low = new Map<ID, number>(), stack: ID[] = [], on = new Set<ID>();
  const strong = (v: ID) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of nestedSequenceRefs(sequences[v])) {
      if (!own(sequences, w)) continue;
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      let w: ID;
      do { w = stack.pop()!; on.delete(w); m!.set(w, comp); } while (w !== v);
      comp++;
    }
  };
  for (const id of Object.keys(sequences)) if (!idx.has(id)) strong(id);
  sccCache.set(sequences, m);
  return m;
}

/** True when the nested reference host -> child closes a cycle. */
function cyclic(sequences: Seqs, hostId: ID, childId: ID): boolean {
  if (hostId === childId) return true;
  const scc = sccOf(sequences);
  const a = scc.get(hostId), b = scc.get(childId);
  return a !== undefined && a === b;
}

/**
 * `seq` with every nested clip expanded into the media clips it plays (see the module comment), or `seq` itself
 * when it has no nested clip. Memoized per sequence object while the sequences it nests and `media` are the same
 * objects, so the planner's per-track caches stay valid from frame to frame.
 *
 * In the result, the nested clips themselves stay on their tracks disabled (so the length and the clip lookups of
 * the outer sequence are unchanged), subtitle cues are resolved to free cues, and the tracks made for nested content
 * report the outer track they belong to through `trackGroupId`.
 */
export function flattenSequence(seq: Sequence, sequences: Seqs, media: Readonly<Record<ID, MediaItem>>): Sequence {
  if (flatSources.has(seq) || !hasNestedClips(seq)) return seq;
  const m = memo.get(seq);
  if (m && m.media === media && m.deps.every(([id, s]) => own(sequences, id) === s)) return m.flat;
  const deps = new Map<ID, Sequence | undefined>();
  const warnings: string[] = [];
  const flat = buildFlat(seq, { sequences, media, deps, warnings });
  memo.set(seq, { media, deps: [...deps], flat });
  flatSources.set(flat, seq);
  if (warnings.length) flatWarnings.set(flat, warnings);
  return flat;
}

interface Ctx {
  sequences: Seqs;
  media: Readonly<Record<ID, MediaItem>>;
  deps: Map<ID, Sequence | undefined>;
  warnings: string[];
}

/** Flattened inner sequence, recording what it depends on in the outer context. */
function innerFlat(ctx: Ctx, host: Sequence, id: ID): Sequence | null {
  const inner = own(ctx.sequences, id);
  ctx.deps.set(id, inner);
  if (!inner) return null;
  if (cyclic(ctx.sequences, host.id, id)) return null;
  const flat = flattenSequence(inner, ctx.sequences, ctx.media);
  // The inner result's own dependencies are dependencies of the outer one.
  const im = memo.get(inner);
  if (im) for (const [k, v] of im.deps) ctx.deps.set(k, v);
  for (const w of flattenWarnings(flat)) if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
  return flat;
}

function buildFlat(seq: Sequence, ctx: Ctx): Sequence {
  const videoTracks: Track[] = [];
  const audioTracks: Track[] = [];
  // Loops, not push(...spread): a spread of a huge array overflows the stack (RangeError).
  for (const t of seq.videoTracks) append(videoTracks, flattenTrack(seq, t, 'video', ctx));
  for (const t of seq.audioTracks) append(audioTracks, flattenTrack(seq, t, 'audio', ctx));
  return { ...seq, videoTracks, audioTracks, subtitleTracks: freeSubtitleTracks(seq), snapshots: [] };
}

/** The sequence's subtitle tracks with every cue resolved to a free (unanchored) cue at its current place. */
function freeSubtitleTracks(seq: Sequence): SequenceSubtitleTrack[] {
  if (!seq.subtitleTracks.length) return seq.subtitleTracks;
  const byTrack = new Map<ID, SequenceSubtitleTrack['cues']>();
  for (const c of resolveSubtitleCues(seq)) {
    const l = byTrack.get(c.trackId) ?? [];
    l.push({ id: c.id, start: c.start, duration: c.end - c.start, offset: 0, text: c.text });
    byTrack.set(c.trackId, l);
  }
  return seq.subtitleTracks.map((t) => ({ ...t, cues: t.enabled ? byTrack.get(t.id) ?? [] : [] }));
}

const fdOf = (fps: Rational) => fps.den / fps.num;

/** Transition types the export renders on a track of `kind` (shared/exportPlan.ts planTrackSegments). */
function typeOk(kind: 'video' | 'audio', t: Transition['type']): boolean {
  return kind === 'audio' ? t === 'audioCrossfade' || t === 'crossDissolve' : t === 'crossDissolve' || t === 'dipToBlack';
}

interface EdgeWork { before: number; after: number; env: Envelope[] }

function flattenTrack(seq: Sequence, T: Track, kind: 'video' | 'audio', ctx: Ctx): Track[] {
  if (!T.clips.some(isNestedClip)) return [T];
  const fd = fdOf(seq.fps);
  const clips = [...T.clips].sort((a, b) => a.start - b.start);
  const byId = new Map<ID, Clip>();
  for (const c of clips) if (c.enabled) byId.set(c.id, c);
  // Inner sequences of the enabled nested clips (null: missing or cyclic -> rendered as nothing).
  const inner = new Map<ID, Sequence | null>();
  for (const c of clips) {
    if (!isNestedClip(c) || !c.enabled || inner.has(c.sequenceId)) continue;
    const f = innerFlat(ctx, seq, c.sequenceId);
    inner.set(c.sequenceId, f);
    if (!f) {
      const why = own(ctx.sequences, c.sequenceId) ? 'it contains this sequence (a cycle)' : 'the sequence is missing from the project';
      const w = `Nested clip "${c.name}" on ${T.name}: ${why}; rendered as ${kind === 'video' ? 'black' : 'silence'}.`;
      if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
    }
  }
  const work = new Map<ID, EdgeWork>();
  const w = (id: ID) => { let x = work.get(id); if (!x) { x = { before: 0, after: 0, env: [] }; work.set(id, x); } return x; };
  const nestedIds = new Set<ID>();
  for (const c of clips) if (isNestedClip(c)) nestedIds.add(c.id);
  const touches = (tr: Transition) => (!!tr.outClipId && nestedIds.has(tr.outClipId)) || (!!tr.inClipId && nestedIds.has(tr.inClipId));
  const baseTransitions: Transition[] = [];
  const nestTransitions: Transition[] = [];
  for (const tr of T.transitions) (touches(tr) ? nestTransitions : baseTransitions).push(tr);
  // Frames of a clip already used by its transitions that stay on the base track (so ramps do not overlap them).
  const used = new Map<ID, number>();
  for (const tr of baseTransitions) {
    const half = Math.ceil(Math.max(0, tr.duration) / 2);
    for (const id of [tr.outClipId, tr.inClipId]) if (id) used.set(id, (used.get(id) ?? 0) + half);
  }
  const room = (c: Clip) => Math.max(0, c.duration - (used.get(c.id) ?? 0) - (work.get(c.id)?.before ?? 0) - (work.get(c.id)?.after ?? 0));
  const cutOf = (tr: Transition) => {
    const o = tr.outClipId ? byId.get(tr.outClipId) : undefined;
    const i = tr.inClipId ? byId.get(tr.inClipId) : undefined;
    return o ? clipEnd(o) : i ? i.start : 0;
  };
  for (const tr of [...nestTransitions].sort((a, b) => cutOf(a) - cutOf(b))) {
    if (!typeOk(kind, tr.type)) continue;
    const D = Math.max(0, Math.round(tr.duration));
    if (!Number.isFinite(D) || D <= 0) continue;
    const o = tr.outClipId ? byId.get(tr.outClipId) : undefined;
    const i = tr.inClipId ? byId.get(tr.inClipId) : undefined;
    if (tr.outClipId && tr.inClipId) {
      if (!o || !i || clipEnd(o) !== i.start) continue;
      const cut = i.start;
      if (tr.type === 'dipToBlack') {
        const h = Math.min(Math.floor(D / 2), room(o), room(i));
        if (h < 1) continue;
        w(o.id).env.push({ from: cut - h, to: cut, dir: -1 });
        w(i.id).env.push({ from: cut, to: cut + h, dir: 1 });
        continue;
      }
      const h = Math.min(Math.floor(D / 2), room(o), room(i), handleAfter(o, seq, ctx), handleBefore(i, seq, ctx));
      if (h < 1) continue;
      w(o.id).after = h; w(i.id).before = h;
      w(o.id).env.push({ from: cut - h, to: cut + h, dir: -1 });
      w(i.id).env.push({ from: cut - h, to: cut + h, dir: 1 });
    } else if (i && !tr.outClipId) {
      w(i.id).env.push({ from: i.start, to: i.start + Math.min(D, i.duration), dir: 1 });
    } else if (o && !tr.inClipId) {
      w(o.id).env.push({ from: clipEnd(o) - Math.min(D, o.duration), to: clipEnd(o), dir: -1 });
    }
  }

  // Base track: the outer clips (nested ones as disabled placeholders; clips with ramps as copies).
  const base: Clip[] = [];
  const groups: { end: number; tracks: { clips: Clip[]; transitions: Transition[] }[] }[] = [];
  for (const c of clips) {
    const ew = work.get(c.id);
    if (isNestedClip(c)) {
      base.push({ ...c, enabled: false });
      const fl = c.enabled ? inner.get(c.sequenceId) : null;
      if (!fl) continue;
      const mapped = mapNested(seq, c, fl, kind, ew, ctx);
      if (!mapped.length || mapped.every((t) => t.clips.length === 0)) continue;
      const from = c.start - (ew?.before ?? 0), to = clipEnd(c) + (ew?.after ?? 0);
      let g = groups.find((x) => x.end <= from);
      if (!g) { g = { end: to, tracks: [] }; groups.push(g); }
      g.end = to;
      mapped.forEach((t, j) => {
        if (!g!.tracks[j]) g!.tracks[j] = { clips: [], transitions: [] };
        append(g!.tracks[j].clips, t.clips);
        append(g!.tracks[j].transitions, t.transitions);
      });
      continue;
    }
    if (!ew) { base.push(c); continue; }
    const copy: Clip = { ...c, start: c.start - ew.before, duration: c.duration + ew.before + ew.after, sourceIn: c.sourceIn - ew.before * fd * c.speed };
    const env = [...ew.env];
    if (kind === 'audio' && (ew.before || ew.after)) {
      // The clip's own fades stay where they were: as ramps, since its edges moved.
      if (c.audio.fadeIn > 0) env.push({ from: c.start, to: c.start + c.audio.fadeIn, dir: 1 });
      if (c.audio.fadeOut > 0) env.push({ from: clipEnd(c) - c.audio.fadeOut, to: clipEnd(c), dir: -1 });
      copy.audio = { ...c.audio, fadeIn: 0, fadeOut: 0 };
    }
    shiftedKeys(c, copy, ew.before); // keyframes are clip-relative: the copy starts ew.before frames earlier
    origins.set(copy, { path: [], source: c, sequenceId: seq.id, env });
    base.push(copy);
  }
  base.sort((a, b) => a.start - b.start);
  const out: Track[] = [{ ...T, clips: base, transitions: baseTransitions }];
  groups.forEach((g, gi) => g.tracks.forEach((t, j) => {
    const sub: Track = { ...T, id: `${T.id}#${gi}.${j}`, clips: t.clips.sort((a, b) => a.start - b.start), transitions: t.transitions, solo: T.solo, muted: T.muted };
    trackGroups.set(sub, T.id);
    out.push(sub);
  }));
  return out;
}

/** Source frames (outer frames) available past the end of a clip, for a transition's handle. */
function handleAfter(c: Clip, seq: Sequence, ctx: Ctx): number {
  const fd = fdOf(seq.fps);
  if (isNestedClip(c)) {
    const inner = own(ctx.sequences, c.sequenceId);
    if (!inner) return 0;
    const avail = sequenceSeconds(inner) - (c.sourceIn + c.duration * fd);
    return Math.max(0, Math.floor(avail / fd + 1e-6));
  }
  const m = Object.hasOwn(ctx.media, c.mediaId) ? ctx.media[c.mediaId] : undefined;
  if (!m || m.offline) return 0;
  const dur = mediaDurationSec(m);
  if (!Number.isFinite(dur)) return Infinity;
  const speed = c.speed > 0 ? c.speed : 1;
  const srcOut = c.sourceIn + c.duration * fd * speed;
  return Math.max(0, Math.floor(((dur - srcOut) / speed) / fd + 1e-6));
}

/** Source frames (outer frames) available before the start of a clip. */
function handleBefore(c: Clip, seq: Sequence, ctx: Ctx): number {
  const fd = fdOf(seq.fps);
  if (isNestedClip(c)) return Math.max(0, Math.floor(c.sourceIn / fd + 1e-6));
  const m = Object.hasOwn(ctx.media, c.mediaId) ? ctx.media[c.mediaId] : undefined;
  if (!m || m.offline) return 0;
  if (isImageMedia(m)) return Infinity;
  const speed = c.speed > 0 ? c.speed : 1;
  return Math.max(0, Math.floor((c.sourceIn / speed) / fd + 1e-6));
}

/**
 * The tracks a nested clip contributes (one per active inner track of its kind), in outer frames, limited to the
 * clip's range widened by its transition handles.
 */
function mapNested(outer: Sequence, N: Clip & { sequenceId: ID }, innerSeq: Sequence, kind: 'video' | 'audio', ew: EdgeWork | undefined, ctx: Ctx): { clips: Clip[]; transitions: Transition[] }[] {
  const fdO = fdOf(outer.fps), fdI = fdOf(innerSeq.fps);
  const sameRate = fpsEquals(outer.fps, innerSeq.fps);
  const S = N.start, E = clipEnd(N);
  const winFrom = S - (ew?.before ?? 0), winTo = E + (ew?.after ?? 0);
  const tIn = N.sourceIn;
  /** First outer frame whose start time is at or after inner frame `x` (fractional allowed). */
  const outerFrameOf = (x: number) => Math.ceil(S + (x * fdI - tIn) / fdO - 1e-6);
  /** Outer position (fractional) of inner position `x` (envelopes, fades). */
  const outerPos = (x: number) => (sameRate ? S + x - Math.round(tIn / fdO) : S + (x * fdI - tIn) / fdO);
  const envN: Envelope[] = [...(ew?.env ?? [])];
  if (kind === 'audio') {
    if (N.audio.fadeIn > 0) envN.push({ from: S, to: S + N.audio.fadeIn, dir: 1 });
    if (N.audio.fadeOut > 0) envN.push({ from: E - N.audio.fadeOut, to: E, dir: -1 });
  }
  const tracks = activeTracks(kind === 'video' ? innerSeq.videoTracks : innerSeq.audioTracks);
  const out: { clips: Clip[]; transitions: Transition[] }[] = [];
  if (kind === 'audio' && N.audio.muted) return out;
  // Keyframes: the nested clip's own are relative to its start; the composed ones are evaluated within each copy's
  // range widened by the transition handles an inner transition can add (`pad`).
  const R = Math.round(tIn / fdO);
  const keyed = hasKeyframes(N);
  for (const I of tracks) {
    const pad = Math.ceil(longestTransition(I) * (sameRate ? 1 : fdI / fdO)) + 1;
    const mappedClips: Clip[] = [];
    const ids = new Map<ID, Clip>();
    const intact = new Map<ID, { head: boolean; tail: boolean }>();
    for (const c of [...I.clips].sort((a, b) => a.start - b.start)) {
      if (!c.enabled || isNestedClip(c)) continue; // nested clips of the inner sequence are already expanded
      const fa = outerFrameOf(c.start), fb = outerFrameOf(clipEnd(c));
      const a = Math.max(fa, winFrom), b = Math.min(fb, winTo);
      if (b <= a) continue;
      const speed = c.speed > 0 ? c.speed : 1;
      const sourceIn = sameRate
        ? c.sourceIn + (a - fa) * fdO * speed
        : c.sourceIn + Math.max(0, tIn + (a - S) * fdO - c.start * fdI) * speed;
      const io = origins.get(c);
      const copy: Clip = {
        ...c,
        id: `${N.id}>${c.id}`,
        start: a, duration: b - a, sourceIn,
        // Linked inner clips stay linked across the nested video / audio pair (one link group per nested link).
        linkId: c.linkId ? `${N.linkId ?? N.id}>${c.linkId}` : null,
      };
      const env: Envelope[] = (io?.env ?? []).map((e) => ({ from: outerPos(e.from), to: outerPos(e.to), dir: e.dir }));
      append(env, envN);
      const head = a === fa, tail = b === fb;
      const keys = keyed || hasKeyframes(c);
      const nMap: FrameMap = { mul: 1, add: S - a };
      const iMap: FrameMap = sameRate ? { mul: 1, add: c.start + S - R - a } : { mul: fdI / fdO, add: S - a + (c.start * fdI - tIn) / fdO };
      const lo = -pad, hi = b - a - 1 + pad;
      if (kind === 'video') {
        const m = mediaOf(ctx, c.mediaId);
        const t = composeTransform(N.transform, c.transform, m, innerSeq, outer, hasMotionKeyframes(c));
        if (!t) continue; // clipped away entirely
        if (keys) composeTransformKeys(t, N.transform, c.transform, m, innerSeq, outer, nMap, iMap, lo, hi);
        copy.transform = t;
      } else {
        const a0 = c.audio;
        const audio: ClipAudio = {
          ...a0,
          gain: (Number.isFinite(a0.gain) ? a0.gain : 0) + (Number.isFinite(N.audio.gain) ? N.audio.gain : 0),
          volume: Math.max(0, a0.volume) * Math.max(0, N.audio.volume) * Math.max(0, I.volume),
        };
        if (!(head && tail && sameRate)) {
          if (a0.fadeIn > 0) env.push({ from: outerPos(c.start), to: outerPos(c.start + a0.fadeIn), dir: 1 });
          if (a0.fadeOut > 0) env.push({ from: outerPos(clipEnd(c) - a0.fadeOut), to: outerPos(clipEnd(c)), dir: -1 });
          audio.fadeIn = 0; audio.fadeOut = 0;
        }
        if (keys) composeAudioKeys(audio, N.audio, a0, I.volume, nMap, iMap, lo, hi);
        copy.audio = audio;
      }
      origins.set(copy, { path: [N.id, ...(io?.path ?? [])], source: io?.source ?? c, sequenceId: io?.sequenceId ?? innerSeq.id, env });
      mappedClips.push(copy);
      ids.set(c.id, copy);
      intact.set(c.id, { head, tail });
    }
    // The inner track's transitions between clips that are both still there (shortened to what is left of them);
    // a fade from / to black whose clip edge was cut off by the nested clip's range becomes a ramp.
    const transitions: Transition[] = [];
    for (const tr of I.transitions) {
      const o = tr.outClipId ? ids.get(tr.outClipId) : undefined;
      const i = tr.inClipId ? ids.get(tr.inClipId) : undefined;
      let D = sameRate ? tr.duration : Math.round((tr.duration * fdI) / fdO);
      if (tr.outClipId && tr.inClipId) {
        if (!o || !i || clipEnd(o) !== i.start) continue;
        D = Math.min(D, o.duration, i.duration);
        if (D >= 1) transitions.push({ ...tr, id: `${N.id}>${tr.id}`, outClipId: o.id, inClipId: i.id, duration: D });
      } else if (i && !tr.outClipId) {
        if (sameRate && intact.get(tr.inClipId!)?.head) transitions.push({ ...tr, id: `${N.id}>${tr.id}`, inClipId: i.id, duration: Math.min(D, i.duration) });
        else if (typeOk(kind, tr.type)) origins.get(i)!.env.push({ from: outerPos(innerClipStart(I, tr.inClipId!)), to: outerPos(innerClipStart(I, tr.inClipId!) + tr.duration), dir: 1 });
      } else if (o && !tr.inClipId) {
        if (sameRate && intact.get(tr.outClipId!)?.tail) transitions.push({ ...tr, id: `${N.id}>${tr.id}`, outClipId: o.id, duration: Math.min(D, o.duration) });
        else if (typeOk(kind, tr.type)) {
          const end = innerClipEnd(I, tr.outClipId!);
          origins.get(o)!.env.push({ from: outerPos(end - tr.duration), to: outerPos(end), dir: -1 });
        }
      }
    }
    out.push({ clips: mappedClips, transitions });
  }
  return out;
}

/** Longest finite transition of a track (0 when none). */
function longestTransition(I: Track): number {
  let d = 0;
  for (const t of I.transitions) if (Number.isFinite(t.duration) && t.duration > d) d = t.duration;
  return d;
}

/** `into.push(...items)` without the spread (which overflows the stack for very long arrays). */
function append<T>(into: T[], items: readonly T[]): void {
  for (const x of items) into.push(x);
}

function innerClipStart(I: Track, id: ID): number { return I.clips.find((c) => c.id === id)?.start ?? 0; }
function innerClipEnd(I: Track, id: ID): number { const c = I.clips.find((x) => x.id === id); return c ? clipEnd(c) : 0; }

function mediaOf(ctx: Ctx, id: ID): MediaItem | undefined {
  return Object.hasOwn(ctx.media, id) ? ctx.media[id] : undefined;
}

const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d);

/**
 * The transform of an inner layer drawn straight into the outer frame: the inner layer's transform `ti` (in the inner
 * frame), then the inner frame fitted into the outer one and the nested clip's transform `to`. Null when the nested
 * clip's crop or the inner frame edge hides the layer entirely. The preview compositor and the export graph place a
 * layer the same way (fit, crop in place, scale, rotate, offset), so the composition is exact for both.
 *
 * Static values only: the result carries no keyframes (composeTransformKeys adds the composed ones). The clipping to
 * the nested crop and the inner frame edge is done for unrotated layers whose position and scale are fixed
 * (`innerMotion` false): it is a fixed crop, which cannot follow a moving layer.
 */
export function composeTransform(to: ClipTransform, ti: ClipTransform, m: MediaItem | undefined, inner: Pick<Sequence, 'width' | 'height'>, outer: Pick<Sequence, 'width' | 'height'>, innerMotion = false): ClipTransform | null {
  const g = layerGeometry(to, m, inner, outer);
  const So = fin(to.scale, 1) > 0 ? fin(to.scale, 1) : 1;
  const Si = fin(ti.scale, 1) > 0 ? fin(ti.scale, 1) : 1;
  const ri = fin(ti.rotation, 0);
  const tx = fin(ti.x, 0), ty = fin(ti.y, 0);
  const x = fin(to.x, 0) + So * g.fo * (tx * g.cos - ty * g.sin);
  const y = fin(to.y, 0) + So * g.fo * (tx * g.sin + ty * g.cos);
  const crop = { ...ti.crop };
  // Clip the layer to the nested clip's crop and the inner frame edge (unrotated, unmoving layers with a known size).
  const { size, fi } = g;
  const Wi = inner.width, Hi = inner.height;
  if (!innerMotion && size && fi > 0 && ((ri % 360) + 360) % 360 === 0) {
    const co = to.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const k1 = Si * fi; // inner pixels per media pixel
    const X0 = -Wi / 2 + clamp01(co.left) * Wi, X1 = Wi / 2 - clamp01(co.right) * Wi;
    const Y0 = -Hi / 2 + clamp01(co.top) * Hi, Y1 = Hi / 2 - clamp01(co.bottom) * Hi;
    const u0 = (size.width / 2 + (X0 - tx) / k1) / size.width, u1 = (size.width / 2 + (X1 - tx) / k1) / size.width;
    const v0 = (size.height / 2 + (Y0 - ty) / k1) / size.height, v1 = (size.height / 2 + (Y1 - ty) / k1) / size.height;
    const EPS = 1e-6;
    if (u0 > crop.left + EPS) crop.left = Math.min(1, u0);
    if (1 - u1 > crop.right + EPS) crop.right = Math.min(1, 1 - u1);
    if (v0 > crop.top + EPS) crop.top = Math.min(1, v0);
    if (1 - v1 > crop.bottom + EPS) crop.bottom = Math.min(1, 1 - v1);
    if (crop.left + crop.right >= 1 - EPS || crop.top + crop.bottom >= 1 - EPS) return null;
  }
  const { keyframes: _k, ...rest } = ti;
  return {
    ...rest,
    x, y,
    scale: So * Si * g.k,
    rotation: g.ro + ri,
    opacity: clamp01(fin(to.opacity, 1)) * clamp01(fin(ti.opacity, 1)),
    crop,
  };
}

/** Constants of composeTransform: the inner frame's fit into the outer one, the fit ratio for the media, the rotation. */
function layerGeometry(to: ClipTransform, m: MediaItem | undefined, inner: Pick<Sequence, 'width' | 'height'>, outer: Pick<Sequence, 'width' | 'height'>) {
  const Wi = inner.width, Hi = inner.height, Wo = outer.width, Ho = outer.height;
  const fo = Math.min(Wo / Wi, Ho / Hi);
  const size = videoDisplaySize(m?.probe?.video, 'element');
  // Ratio of the two fit scales (media into the inner frame, then into the outer) to the direct fit (1 when the
  // frames have the same shape, whatever the media size).
  let k = 1;
  let fi = 0;
  if (size) {
    fi = Math.min(Wi / size.width, Hi / size.height);
    const direct = Math.min(Wo / size.width, Ho / size.height);
    k = (fo * fi) / direct;
  }
  const ro = fin(to.rotation, 0);
  const a = (ro * Math.PI) / 180;
  return { fo, k, fi, size, ro, cos: Math.cos(a), sin: Math.sin(a) };
}

// ---------------------------------------------------------------------------------------------------
// Keyframes through nesting (Roadmap §8 x §11)
// ---------------------------------------------------------------------------------------------------

/**
 * Where a source clip's keyframes land on a flattened copy: copy frame = source frame x `mul` + `add`. Keyframe
 * frames are clip-relative (shared/keyframes.ts), so a copy that starts elsewhere than its source, or plays an inner
 * sequence of another frame rate, needs its keyframes re-timed. With equal rates `mul` is 1 (a shift); across rates
 * it is innerFrameDuration / outerFrameDuration (a rescale: the keyframes keep their place in real time).
 */
export interface FrameMap { mul: number; add: number }

/** Keyframe frames are kept to 1e-6 frame (the FFmpeg expressions print 6 decimals). */
const qf = (f: number) => Math.round(f * 1e6) / 1e6;

function remapKeys(keys: readonly Keyframe[] | undefined, m: FrameMap): Keyframe[] | undefined {
  if (!keys || keys.length === 0) return undefined;
  if (m.mul === 1 && m.add === 0) return keys as Keyframe[];
  return keys.map((k) => ({ ...k, frame: qf(k.frame * m.mul + m.add) }));
}

/** An input of a composed property: a keyframe list in copy frames, or a fixed value. */
interface KeyInput { keys?: readonly Keyframe[]; value: number }

function keyInput(keys: readonly Keyframe[] | undefined, value: number): KeyInput {
  if (!keys || keys.length === 0) return { value };
  // A list that never changes is a fixed value (evaluateKeyframes returns it everywhere).
  if (keys.every((k) => k.value === keys[0].value)) return { value: keys[0].value };
  return { keys, value };
}

/**
 * The keyframe list of a property composed from `inputs` by `fn` (undefined when no input varies: the property is then
 * fixed at `fn` of the values). With one varying input, `fn` is affine in it, so its keyframes are mapped value by value
 * (interpolation kept). With more, the result is sampled into linear keyframes: at every input keyframe, and at every
 * integer frame where two inputs that `pairs` multiplies vary together or an input eases, within [lo, hi] (the frames
 * the copy can render, transition handles included). So the result equals `fn` of the inputs at every integer frame,
 * and between them wherever it is linear anyway. At most MAX_KEYFRAMES_PER_PROPERTY keyframes: denser sampling is
 * strided down to that (the curve is then linear between the kept samples).
 */
export function composeKeyList(inputs: readonly KeyInput[], pairs: readonly (readonly [number, number])[], fn: (v: readonly number[]) => number, lo: number, hi: number): Keyframe[] | undefined {
  const vary: number[] = [];
  inputs.forEach((x, i) => { if (x.keys) vary.push(i); });
  if (vary.length === 0) return undefined;
  const base = inputs.map((x) => x.value);
  if (vary.length === 1) {
    const j = vary[0];
    return inputs[j].keys!.map((kf) => {
      const v = base.slice(); v[j] = kf.value;
      const out: Keyframe = { frame: kf.frame, value: fn(v) };
      if (kf.interp === 'ease') out.interp = 'ease';
      return out;
    });
  }
  // Changing spans of each input, the spans to sample per frame, and the input keyframes in [lo, hi].
  const spans: [number, number][][] = inputs.map(() => []);
  const dense: [number, number][] = [];
  const pts = new Set<number>([qf(lo), qf(hi)]);
  for (const j of vary) {
    const k = inputs[j].keys!;
    for (let i = 0; i + 1 < k.length; i++) {
      if (k[i].value === k[i + 1].value) continue;
      spans[j].push([k[i].frame, k[i + 1].frame]);
      if (k[i].interp === 'ease') dense.push([k[i].frame, k[i + 1].frame]);
    }
    for (const kf of k) if (kf.frame > lo && kf.frame < hi) pts.add(kf.frame);
  }
  for (const [p, q] of pairs) {
    const A = spans[p], B = spans[q];
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      const a = Math.max(A[i][0], B[j][0]), b = Math.min(A[i][1], B[j][1]);
      if (b > a) dense.push([a, b]);
      if (A[i][1] < B[j][1]) i++; else j++;
    }
  }
  // Integer frames of the dense spans (inside [lo, hi]), thinned evenly when there are more than the list can hold.
  const ranges = dense.map(([a, b]) => [Math.max(Math.ceil(a), Math.ceil(lo)), Math.min(Math.floor(b), Math.floor(hi))] as const).filter(([a, b]) => b >= a);
  const count = ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
  const step = Math.max(1, Math.ceil(count / MAX_KEYFRAMES_PER_PROPERTY));
  for (const [a, b] of ranges) for (let n = a; n <= b; n += step) pts.add(n);
  let frames = [...pts].sort((a, b) => a - b).filter((f, i, arr) => i === 0 || f - arr[i - 1] > 1e-3);
  if (frames.length > MAX_KEYFRAMES_PER_PROPERTY) {
    const s = (frames.length - 1) / (MAX_KEYFRAMES_PER_PROPERTY - 1);
    frames = Array.from({ length: MAX_KEYFRAMES_PER_PROPERTY }, (_, i) => frames[Math.round(i * s)]);
  }
  return frames.map((f) => ({ frame: f, value: fn(inputs.map((x) => (x.keys ? evaluateKeyframes(x.keys, f) : x.value))) }));
}

/**
 * The composed keyframes of a flattened video layer (see composeTransform for the formulas), written on `t` (the
 * composed static transform): the nested clip `N`'s keyframes (moved by `nMap`) with the inner layer `ti`'s (moved by
 * `iMap`). `t` keeps no keyframes when neither side has any.
 */
export function composeTransformKeys(t: ClipTransform, to: ClipTransform, ti: ClipTransform, m: MediaItem | undefined, inner: Pick<Sequence, 'width' | 'height'>, outer: Pick<Sequence, 'width' | 'height'>, nMap: FrameMap, iMap: FrameMap, lo: number, hi: number): void {
  const nk = to.keyframes, ik = ti.keyframes;
  delete t.keyframes;
  if (!hasAny(nk) && !hasAny(ik)) return;
  const g = layerGeometry(to, m, inner, outer);
  const pos = (v: number, d: number) => fin(v, d);
  const xo = keyInput(remapKeys(nk?.x, nMap), pos(to.x, 0)), yo = keyInput(remapKeys(nk?.y, nMap), pos(to.y, 0));
  const so = keyInput(remapKeys(nk?.scale, nMap), fin(to.scale, 1) > 0 ? fin(to.scale, 1) : 1);
  const oo = keyInput(remapKeys(nk?.opacity, nMap), fin(to.opacity, 1));
  const xi = keyInput(remapKeys(ik?.x, iMap), pos(ti.x, 0)), yi = keyInput(remapKeys(ik?.y, iMap), pos(ti.y, 0));
  const si = keyInput(remapKeys(ik?.scale, iMap), fin(ti.scale, 1) > 0 ? fin(ti.scale, 1) : 1);
  const oi = keyInput(remapKeys(ik?.opacity, iMap), fin(ti.opacity, 1));
  const { fo, k, cos, sin } = g;
  // Inputs [outer offset, outer scale, inner x, inner y]: the outer scale multiplies the inner offset (rotated).
  const pairs = [[1, 2], [1, 3]] as const;
  const out: TransformKeyframes = {};
  const x = composeKeyList([xo, so, xi, yi], pairs, ([a, s, u, v]) => a + s * fo * (u * cos - v * sin), lo, hi);
  const y = composeKeyList([yo, so, xi, yi], pairs, ([a, s, u, v]) => a + s * fo * (u * sin + v * cos), lo, hi);
  const sc = composeKeyList([so, si], [[0, 1]], ([a, b]) => a * b * k, lo, hi);
  const op = composeKeyList([oo, oi], [[0, 1]], ([a, b]) => clamp01(a) * clamp01(b), lo, hi);
  if (x) out.x = x;
  if (y) out.y = y;
  if (sc) out.scale = sc;
  if (op) out.opacity = op;
  if (Object.keys(out).length) t.keyframes = out;
}

/**
 * The composed level keyframes of a flattened audio clip (inner level x nested clip level x inner track volume),
 * written on `a` (the composed static audio); none when neither side has level keyframes.
 */
export function composeAudioKeys(a: ClipAudio, an: ClipAudio, ai: ClipAudio, trackVolume: number, nMap: FrameMap, iMap: FrameMap, lo: number, hi: number): void {
  delete a.keyframes;
  const nk = an.keyframes?.volume, ik = ai.keyframes?.volume;
  if (!nk?.length && !ik?.length) return;
  const tv = Math.max(0, trackVolume);
  const vol = composeKeyList([keyInput(remapKeys(ik, iMap), ai.volume), keyInput(remapKeys(nk, nMap), an.volume)], [[0, 1]],
    ([u, v]) => Math.max(0, u) * Math.max(0, v) * tv, lo, hi);
  if (vol) a.keyframes = { volume: vol };
}

function hasAny(k: TransformKeyframes | undefined): boolean {
  return !!k && !!(k.x?.length || k.y?.length || k.scale?.length || k.opacity?.length);
}

/** A video copy's level keyframes (unused on a picture clip, kept for when it is linked audio's twin) moved by `delta`. */
function shiftedAudioKeys(copy: Clip, delta: number): void {
  const vk = remapKeys(copy.audio.keyframes?.volume, { mul: 1, add: delta });
  if (vk) copy.audio.keyframes = { ...copy.audio.keyframes, volume: vk };
}

/** The copy of a clip that starts `delta` frames earlier than its source (a transition handle): keyframes moved. */
function shiftedKeys(c: Clip, copy: Clip, delta: number): void {
  if (!delta || !hasKeyframes(c)) return;
  const m: FrameMap = { mul: 1, add: delta };
  const tk = c.transform.keyframes;
  if (hasAny(tk)) {
    const next: TransformKeyframes = {};
    for (const p of TRANSFORM_KEY_PROPS) { const l = remapKeys(tk?.[p], m); if (l) next[p] = l; }
    copy.transform = { ...copy.transform, keyframes: next };
  }
  const vk = remapKeys(c.audio.keyframes?.volume, m);
  if (vk) copy.audio = { ...copy.audio, keyframes: { ...copy.audio.keyframes, volume: vk } };
}

function clamp01(v: number): number { return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }

// ---------------------------------------------------------------------------------------------------
// Commands (pure ops on immer drafts or plain data, called from store actions: src/state/store.ts)
// ---------------------------------------------------------------------------------------------------

function plain<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function rawClips(seq: Sequence): { track: Track; clip: Clip; index: number; kind: 'video' | 'audio' }[] {
  const out: { track: Track; clip: Clip; index: number; kind: 'video' | 'audio' }[] = [];
  seq.videoTracks.forEach((t, index) => { for (const c of readItems(t.clips)) out.push({ track: t, clip: c, index, kind: 'video' }); });
  seq.audioTracks.forEach((t, index) => { for (const c of readItems(t.clips)) out.push({ track: t, clip: c, index, kind: 'audio' }); });
  return out;
}

/** Frames [start, end) of a sequence subtitle cue on its sequence (null: not placeable). */
function cueSpan(seq: Sequence, cue: SequenceSubtitleTrack['cues'][number], byId: Map<ID, Clip>): { start: number; end: number } | null {
  if (!cue.clipId) return { start: cue.start + cue.offset, end: cue.start + cue.duration + cue.offset };
  const c = byId.get(cue.clipId);
  if (!c || cue.srcStart === undefined || cue.srcEnd === undefined) return null;
  const toF = (sec: number) => c.start + Math.round(((sec - c.sourceIn) / (c.speed || 1)) * seq.fps.num / seq.fps.den) + cue.offset;
  return { start: toF(cue.srcStart), end: toF(cue.srcEnd) };
}

/** First unlocked track of `kind` at index `from` or above with nothing in [start, end); a new track when none. */
function freeTrack(seq: Sequence, kind: 'video' | 'audio', from: number, start: number, end: number): Track {
  const list = kind === 'video' ? seq.videoTracks : seq.audioTracks;
  for (let i = Math.max(0, from); i < list.length; i++) {
    const t = list[i];
    if (t.locked) continue;
    if (!readItems(t.clips).some((c) => c.start < end && clipEnd(c) > start)) return t;
  }
  return addTrack(seq, kind);
}

export type CompoundResult = { ok: true; videoClipId: ID | null; audioClipId: ID | null } | { ok: false; error: string };

/**
 * Make Compound Clip: the clips `clipIds` of `outer` (and the clips linked to them) move into `inner` (a new, empty
 * sequence the caller made with the outer sequence's settings) at the same relative positions and track numbers,
 * with the transitions between them, and one nested clip per kind (video, audio; linked) takes their place on the
 * lowest of their tracks that is free over the whole range (a new track when none is). Subtitle cues attached to
 * the moved clips stay where they are, attached to the nested clip. Inner audio track volumes keep the mix
 * unchanged under the nested clip's track volume. Refused when a clip is on a locked track.
 */
export function makeCompoundClip(outer: Sequence, clipIds: Iterable<ID>, inner: Sequence): CompoundResult {
  const want = new Set(clipIds);
  const all = rawClips(outer);
  const links = new Set<ID>();
  for (const x of all) if (want.has(x.clip.id) && x.clip.linkId) links.add(x.clip.linkId);
  const chosen = all.filter((x) => want.has(x.clip.id) || (!!x.clip.linkId && links.has(x.clip.linkId)));
  if (chosen.length === 0) return { ok: false, error: 'Select the clips to nest first.' };
  if (chosen.some((x) => x.track.locked)) return { ok: false, error: 'A selected clip is on a locked track.' };
  const ids = new Set(chosen.map((x) => x.clip.id));
  let s0 = Infinity, s1 = -Infinity;
  for (const x of chosen) { s0 = Math.min(s0, x.clip.start); s1 = Math.max(s1, clipEnd(x.clip)); }
  const fd = outer.fps.den / outer.fps.num;
  const outerTracks = (kind: 'video' | 'audio') => (kind === 'video' ? outer.videoTracks : outer.audioTracks);
  const innerTracks = (kind: 'video' | 'audio') => (kind === 'video' ? inner.videoTracks : inner.audioTracks);
  const hostIndex = (kind: 'video' | 'audio') => {
    const used = chosen.filter((x) => x.kind === kind);
    let i = Infinity;
    for (const x of used) i = Math.min(i, x.index);
    return used.length ? i : -1;
  };
  const vHost = hostIndex('video'), aHost = hostIndex('audio');

  // Inner tracks: the same numbers, names and mute as the outer ones.
  for (const kind of ['video', 'audio'] as const) {
    const used = chosen.filter((x) => x.kind === kind);
    const list = innerTracks(kind);
    let n = 0;
    for (const x of used) n = Math.max(n, x.index + 1);
    while (list.length < n) list.push(makeTrack(kind, list.length + 1));
    const src = outerTracks(kind);
    const host = kind === 'video' ? vHost : aHost;
    list.forEach((it, i) => {
      const ot = src[i];
      if (!ot) return;
      it.name = ot.name;
      it.muted = ot.muted;
      // The host track's volume applies on top of the nested clip: keep each track's level as it was.
      if (kind === 'audio' && host >= 0) {
        const hv = src[host]?.volume ?? 1;
        it.volume = hv > 0 ? ot.volume / hv : ot.volume;
      }
    });
  }
  for (const x of chosen) {
    const copy = plain(x.clip);
    copy.start = x.clip.start - s0;
    innerTracks(x.kind)[x.index].clips.push(copy);
  }
  for (const kind of ['video', 'audio'] as const) {
    const list = innerTracks(kind);
    outerTracks(kind).forEach((t, i) => {
      if (!list[i]) return;
      for (const tr of readItems(t.transitions)) {
        const ends = [tr.outClipId, tr.inClipId].filter((x): x is ID => !!x);
        if (ends.length && ends.every((id) => ids.has(id))) list[i].transitions.push(plain(tr));
      }
    });
    for (const t of list) { t.clips.sort((a, b) => a.start - b.start); reconcileTransitions(t); }
  }

  // The nested clips (placed after the selection is removed).
  const linkId = vHost >= 0 && aHost >= 0 ? uid('link') : null;
  const make = (kind: 'video' | 'audio'): Clip => {
    const c = makeClip({ mediaId: inner.id, name: inner.name, sourceIn: 0, duration: s1 - s0, kind, linkId }, s0);
    c.sequenceId = inner.id;
    return c;
  };
  const vClip = vHost >= 0 ? make('video') : null;
  const aClip = aHost >= 0 ? make('audio') : null;
  const anchor = (vClip ?? aClip)!;

  // Cues on the moved clips: same place, attached to the nested clip (inner timeline seconds).
  const byId = new Map<ID, Clip>(chosen.map((x) => [x.clip.id, x.clip] as const));
  for (const st of outer.subtitleTracks) {
    const cues = readItems(st.cues);
    if (!cues.some((c) => c.clipId && ids.has(c.clipId))) continue;
    st.cues = cues.map((c) => {
      if (!c.clipId || !ids.has(c.clipId)) return c;
      const span = cueSpan(outer, c, byId);
      if (!span) return c;
      return { ...c, clipId: anchor.id, srcStart: (span.start - s0) * fd, srcEnd: (span.end - s0) * fd, offset: 0, start: span.start, duration: Math.max(1, span.end - span.start) };
    });
  }
  removeClips(outer, [...ids]);
  if (vClip) { const t = freeTrack(outer, 'video', vHost, s0, s1); addClipSorted(t, vClip); reconcileTransitions(t); }
  if (aClip) { const t = freeTrack(outer, 'audio', aHost, s0, s1); addClipSorted(t, aClip); reconcileTransitions(t); }
  return { ok: true, videoClipId: vClip?.id ?? null, audioClipId: aClip?.id ?? null };
}

export type BreakApartResult = { ok: true; clipIds: ID[] } | { ok: false; error: string };

/**
 * Break Apart Compound Clip: the nested clip `clipId` (and the nested clips linked to it that play the same range
 * of the same sequence) is replaced by copies of the inner sequence's clips over the range it plays, one level deep
 * (nested clips inside stay nested), at the same timeline positions. Inner track N goes to the nested clip's track
 * or the next free one above it, in order, new tracks when needed. The nested clip's transform / opacity and gain /
 * volume / mute and the inner track volumes are folded into the copies; clips of muted inner tracks come out
 * disabled; inner transitions between copied clips are kept; cues attached to the nested clip become free cues.
 * Not possible across frame rates. The inner sequence stays in the project.
 */
export function breakApartCompoundClip(outer: Sequence, clipId: ID, sequences: Seqs, media: Readonly<Record<ID, MediaItem>>): BreakApartResult {
  const all = rawClips(outer);
  const hit = all.find((x) => x.clip.id === clipId);
  if (!hit || !isNestedClip(hit.clip)) return { ok: false, error: 'Select a nested sequence clip.' };
  const N = hit.clip;
  const inner = own(sequences, N.sequenceId);
  if (!inner) return { ok: false, error: 'Its sequence is no longer in the project.' };
  if (!fpsEquals(inner.fps, outer.fps)) return { ok: false, error: 'The nested sequence has another frame rate.' };
  const group = all.filter((x) => x.clip.id === N.id || (!!N.linkId && x.clip.linkId === N.linkId && isNestedClip(x.clip)
    && x.clip.sequenceId === N.sequenceId && x.clip.start === N.start && x.clip.duration === N.duration && Math.abs(x.clip.sourceIn - N.sourceIn) < 1e-9));
  if (group.some((x) => x.track.locked)) return { ok: false, error: 'The clip is on a locked track.' };
  const fd = outer.fps.den / outer.fps.num;
  const inF = Math.round(N.sourceIn / fd);
  const start = N.start, end = clipEnd(N);
  const linkMap = new Map<ID, ID>();
  const mapLink = (id: ID | null) => { if (!id) return null; let n = linkMap.get(id); if (!n) { n = uid('link'); linkMap.set(id, n); } return n; };
  const created: ID[] = [];
  const groupIds = new Set(group.map((x) => x.clip.id));
  const byId = new Map<ID, Clip>(group.map((x) => [x.clip.id, x.clip] as const));
  for (const st of outer.subtitleTracks) {
    const cues = readItems(st.cues);
    if (!cues.some((c) => c.clipId && groupIds.has(c.clipId))) continue;
    st.cues = cues.map((c) => {
      if (!c.clipId || !groupIds.has(c.clipId)) return c;
      const span = cueSpan(outer, c, byId);
      if (!span) return c;
      const { clipId: _c, srcStart: _s, srcEnd: _e, ...rest } = c;
      return { ...rest, start: span.start, duration: Math.max(1, span.end - span.start), offset: 0 };
    });
  }
  removeClips(outer, [...groupIds]);
  for (const x of group) {
    const K = x.clip;
    const kind = x.kind;
    const tracks = kind === 'video' ? inner.videoTracks : inner.audioTracks;
    const live = new Set(activeTracks(tracks).map((t) => t.id));
    let from = x.index;
    for (const I of tracks) {
      const pad = Math.ceil(longestTransition(I)) + 1;
      const copies: Clip[] = [];
      const idMap = new Map<ID, ID>();
      for (const c of readItems(I.clips)) {
        const a = Math.max(c.start, inF), b = Math.min(clipEnd(c), inF + K.duration);
        if (b <= a) continue;
        const copy = plain(c);
        copy.id = uid('clip');
        copy.start = start + (a - inF);
        copy.duration = b - a;
        copy.sourceIn = c.sourceIn + (a - c.start) * fd * (c.speed || 1);
        copy.linkId = mapLink(c.linkId);
        if (!live.has(I.id)) copy.enabled = false;
        if (a > c.start) copy.audio.fadeIn = 0;
        if (b < clipEnd(c)) copy.audio.fadeOut = 0;
        // Keyframes (clip-relative): the inner clip's move with the copy's new start, the nested clip's are composed in.
        const keys = hasKeyframes(K) || hasKeyframes(c);
        const kMap: FrameMap = { mul: 1, add: K.start - copy.start };
        const iMap: FrameMap = { mul: 1, add: c.start - a };
        const lo = -pad, hi = copy.duration - 1 + pad;
        if (kind === 'video') {
          const m = Object.hasOwn(media, c.mediaId) ? media[c.mediaId] : undefined;
          const t = composeTransform(K.transform, c.transform, m, inner, outer, hasMotionKeyframes(c));
          if (!t) continue;
          if (keys) composeTransformKeys(t, K.transform, c.transform, m, inner, outer, kMap, iMap, lo, hi);
          copy.transform = t;
          if (keys) shiftedAudioKeys(copy, c.start - a);
        } else {
          copy.audio.gain = (copy.audio.gain || 0) + (K.audio.gain || 0);
          copy.audio.volume = Math.max(0, copy.audio.volume) * Math.max(0, K.audio.volume) * Math.max(0, I.volume);
          if (K.audio.muted) copy.audio.muted = true;
          if (keys) composeAudioKeys(copy.audio, K.audio, c.audio, I.volume, kMap, iMap, lo, hi);
        }
        idMap.set(c.id, copy.id);
        copies.push(copy);
      }
      if (!copies.length) { from++; continue; }
      const target = freeTrack(outer, kind, from, start, end);
      from = (kind === 'video' ? outer.videoTracks : outer.audioTracks).indexOf(target) + 1;
      for (const copy of copies) addClipSorted(target, copy);
      for (const tr of readItems(I.transitions)) {
        const o = tr.outClipId ? idMap.get(tr.outClipId) : null;
        const i = tr.inClipId ? idMap.get(tr.inClipId) : null;
        if ((tr.outClipId && !o) || (tr.inClipId && !i)) continue;
        target.transitions.push({ ...plain(tr), id: uid('tr'), outClipId: o ?? null, inClipId: i ?? null });
      }
      reconcileTransitions(target);
      for (const c of copies) created.push(c.id);
    }
  }
  return { ok: true, clipIds: created };
}

/**
 * The clips that nest sequence `child` in `host` at `frame`: a video clip when the child has video clips (or
 * nothing at all), an audio clip when it has audio clips (or nothing), linked, as long as the child's timeline at the
 * host's frame rate (at least one frame).
 */
export function nestedClipsFor(host: Pick<Sequence, 'fps'>, child: Sequence, frame: number): Clip[] {
  const hasV = child.videoTracks.some((t) => t.clips.length > 0);
  const hasA = child.audioTracks.some((t) => t.clips.length > 0);
  const kinds: ('video' | 'audio')[] = hasV || hasA ? [...(hasV ? ['video' as const] : []), ...(hasA ? ['audio' as const] : [])] : ['video', 'audio'];
  const duration = Math.max(1, Math.floor((sequenceSeconds(child) * host.fps.num) / host.fps.den + 1e-6));
  const linkId = kinds.length > 1 ? uid('link') : null;
  return kinds.map((kind) => {
    const c = makeClip({ mediaId: child.id, name: child.name, sourceIn: 0, duration, kind, linkId }, Math.max(0, Math.round(frame)));
    c.sequenceId = child.id;
    return c;
  });
}

/** Inner timeline frame of the nested clip `clip` at outer frame `frame` (Open in Timeline puts the inner playhead there). */
export function innerFrameAt(clip: Clip, frame: number, outerFps: Rational, innerFps: Rational): number {
  const f = Math.max(clip.start, Math.min(clipEnd(clip) - 1, frame));
  const t = clip.sourceIn + ((f - clip.start) * outerFps.den) / outerFps.num;
  return Math.max(0, Math.floor((t * innerFps.num) / innerFps.den + 1e-6));
}

/**
 * Match Frame through nesting: the media clip of the flattened sequence that plays under `clip` (a clip of `seq`) at
 * `frame`, and its source time. For a media clip, the clip itself. Null when nothing plays there.
 */
export function sourceUnder(seq: Sequence, clip: Clip, frame: number, sequences: Seqs, media: Readonly<Record<ID, MediaItem>>): { clip: Clip; time: number } | null {
  const fd = seq.fps.den / seq.fps.num;
  if (!isNestedClip(clip)) return { clip, time: clip.sourceIn + (frame - clip.start) * fd * clip.speed };
  const flat = flattenSequence(seq, sequences, media);
  const tracks = clip.kind === 'audio' ? flat.audioTracks : flat.videoTracks;
  for (let i = tracks.length - 1; i >= 0; i--) {
    for (const c of tracks[i].clips) {
      if (!c.enabled || c.start > frame || clipEnd(c) <= frame) continue;
      const o = origins.get(c);
      if (o && o.path[0] === clip.id) return { clip: c, time: c.sourceIn + (frame - c.start) * fd * c.speed };
    }
  }
  return null;
}
