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
 */
import type { Clip, ClipAudio, ClipTransform, ID, MediaItem, Rational, Sequence, SequenceSubtitleTrack, Track, Transition } from './model';
import { addClipSorted, addTrack, clipEnd, makeClip, makeTrack, readItems, reconcileTransitions, removeClips, resolveSubtitleCues, sequenceDuration } from './timeline';
import { uid } from './ids';
import { activeTracks, isImageMedia, mediaDurationSec } from './exportPlan';
import { videoDisplaySize } from './media';
import { fpsEquals } from './time';

/** Deepest chain of nested sequences (A in B in C ... : at most this many levels below the top sequence). */
export const MAX_NEST_DEPTH = 8;

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
export type NestProblem = 'missing' | 'self' | 'cycle' | 'depth';

export function nestProblem(sequences: Seqs, hostId: ID, childId: ID): NestProblem | null {
  if (!own(sequences, childId) || !own(sequences, hostId)) return 'missing';
  if (hostId === childId) return 'self';
  if (reachableSequences(sequences, childId).has(hostId)) return 'cycle';
  if (nestDepthAbove(sequences, hostId) + 1 + nestDepthBelow(sequences, childId) > MAX_NEST_DEPTH) return 'depth';
  return null;
}

/** User-facing text for a NestProblem ("Cannot nest X in Y: ..."). */
export function nestProblemText(p: NestProblem): string {
  switch (p) {
    case 'missing': return 'the sequence no longer exists';
    case 'self': return 'a sequence cannot contain itself';
    case 'cycle': return 'the sequence already contains this one (directly or through another nested sequence)';
    case 'depth': return `nesting would be more than ${MAX_NEST_DEPTH} levels deep`;
  }
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
  for (const t of seq.videoTracks) videoTracks.push(...flattenTrack(seq, t, 'video', ctx));
  for (const t of seq.audioTracks) audioTracks.push(...flattenTrack(seq, t, 'audio', ctx));
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
        g!.tracks[j].clips.push(...t.clips);
        g!.tracks[j].transitions.push(...t.transitions);
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
  for (const I of tracks) {
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
        linkId: c.linkId ? `${N.id}>${c.linkId}` : null,
      };
      const env: Envelope[] = (io?.env ?? []).map((e) => ({ from: outerPos(e.from), to: outerPos(e.to), dir: e.dir }));
      env.push(...envN);
      const head = a === fa, tail = b === fb;
      if (kind === 'video') {
        const t = composeTransform(N.transform, c.transform, mediaOf(ctx, c.mediaId), innerSeq, outer);
        if (!t) continue; // clipped away entirely
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
 */
export function composeTransform(to: ClipTransform, ti: ClipTransform, m: MediaItem | undefined, inner: Pick<Sequence, 'width' | 'height'>, outer: Pick<Sequence, 'width' | 'height'>): ClipTransform | null {
  const Wi = inner.width, Hi = inner.height, Wo = outer.width, Ho = outer.height;
  const fo = Math.min(Wo / Wi, Ho / Hi);
  const So = fin(to.scale, 1) > 0 ? fin(to.scale, 1) : 1;
  const Si = fin(ti.scale, 1) > 0 ? fin(ti.scale, 1) : 1;
  const ro = fin(to.rotation, 0), ri = fin(ti.rotation, 0);
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
  const a = (ro * Math.PI) / 180;
  const tx = fin(ti.x, 0), ty = fin(ti.y, 0);
  const x = fin(to.x, 0) + So * fo * (tx * Math.cos(a) - ty * Math.sin(a));
  const y = fin(to.y, 0) + So * fo * (tx * Math.sin(a) + ty * Math.cos(a));
  const crop = { ...ti.crop };
  // Clip the layer to the nested clip's crop and the inner frame edge (unrotated layers with a known size).
  if (size && fi > 0 && ((ri % 360) + 360) % 360 === 0) {
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
  return {
    ...ti,
    x, y,
    scale: So * Si * k,
    rotation: ro + ri,
    opacity: clamp01(fin(to.opacity, 1)) * clamp01(fin(ti.opacity, 1)),
    crop,
  };
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
  const s0 = Math.min(...chosen.map((x) => x.clip.start));
  const s1 = Math.max(...chosen.map((x) => clipEnd(x.clip)));
  const fd = outer.fps.den / outer.fps.num;
  const outerTracks = (kind: 'video' | 'audio') => (kind === 'video' ? outer.videoTracks : outer.audioTracks);
  const innerTracks = (kind: 'video' | 'audio') => (kind === 'video' ? inner.videoTracks : inner.audioTracks);
  const hostIndex = (kind: 'video' | 'audio') => {
    const used = chosen.filter((x) => x.kind === kind);
    return used.length ? Math.min(...used.map((x) => x.index)) : -1;
  };
  const vHost = hostIndex('video'), aHost = hostIndex('audio');

  // Inner tracks: the same numbers, names and mute as the outer ones.
  for (const kind of ['video', 'audio'] as const) {
    const used = chosen.filter((x) => x.kind === kind);
    const list = innerTracks(kind);
    const n = used.length ? Math.max(...used.map((x) => x.index)) + 1 : 0;
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
        if (kind === 'video') {
          const m = Object.hasOwn(media, c.mediaId) ? media[c.mediaId] : undefined;
          const t = composeTransform(K.transform, c.transform, m, inner, outer);
          if (!t) continue;
          copy.transform = t;
        } else {
          copy.audio.gain = (copy.audio.gain || 0) + (K.audio.gain || 0);
          copy.audio.volume = Math.max(0, copy.audio.volume) * Math.max(0, K.audio.volume) * Math.max(0, I.volume);
          if (K.audio.muted) copy.audio.muted = true;
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
      created.push(...copies.map((c) => c.id));
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
