/**
 * Pure timeline operations. These functions mutate the Sequence passed in (intended to be an immer draft)
 * and never touch anything outside of it. All positions are integer frames.
 */
import type { Clip, ClipAudio, ClipTransform, Sequence, SequenceSubtitleCue, StoryBlock, Track, Transition, TransitionType, ID, Rational, Marker } from './model';
import { isDraft } from 'immer';
import { uid } from './ids';
import { secondsToFrames } from './time';

export type MediaDurationLookup = (mediaId: ID) => number; // seconds (Infinity for images/unknown)

export const MIN_CLIP_FRAMES = 1;

export function defaultTransform(): ClipTransform {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } };
}
export function defaultAudio(): ClipAudio {
  return { gain: 0, volume: 1, fadeIn: 0, fadeOut: 0, muted: false };
}

export function clipEnd(c: Clip): number { return c.start + c.duration; }

/** Source out point (seconds, exclusive). */
export function clipSourceOut(c: Clip, fps: Rational): number {
  return c.sourceIn + (c.duration * fps.den / fps.num) * c.speed;
}

/** Source time (seconds) at a given timeline frame inside the clip. */
export function sourceTimeAt(c: Clip, frame: number, fps: Rational): number {
  return c.sourceIn + ((frame - c.start) * fps.den / fps.num) * c.speed;
}

export function allTracks(seq: Sequence): Track[] { return [...seq.videoTracks, ...seq.audioTracks]; }

export function findTrack(seq: Sequence, trackId: ID): Track | undefined {
  return allTracks(seq).find((t) => t.id === trackId);
}

export interface ClipLocation { track: Track; clip: Clip; index: number }

/**
 * The clip with `clipId`, its track and index. Inside a recipe the returned clip may be written to (it is a draft,
 * or a private copy put in place of an original); only the matching clip is drafted, the scan reads raw items.
 */
export function findClip(seq: Sequence, clipId: ID): ClipLocation | undefined {
  for (const track of allTracks(seq)) {
    const items = readItems(track.clips);
    for (let index = 0; index < items.length; index++) {
      if (items[index].id === clipId) return { track, clip: writableClip(track, index), index };
    }
  }
  return undefined;
}

/** Read-only findClip: the raw clip (never drafted). Use it when the clip is only read or its track is checked. */
function locateClip(seq: Sequence, clipId: ID): { track: Track; clip: Clip; index: number } | undefined {
  for (const track of allTracks(seq)) {
    const items = readItems(track.clips);
    for (let index = 0; index < items.length; index++) if (items[index].id === clipId) return { track, clip: items[index], index };
  }
  return undefined;
}

const IMMER_STATE = Symbol.for('immer-state');
interface DraftInternals { base_: unknown; copy_: unknown; modified_?: boolean }

/**
 * The object to read `item`'s fields from without drafting its nested objects: an unmodified draft's base (the
 * same values), else `item` itself. Spreading a draft reads every field through the proxy, drafting each nested
 * object it meets.
 */
function readable<T>(item: T): T {
  const st = item !== null && typeof item === 'object' ? (item as Record<symbol, DraftInternals | undefined>)[IMMER_STATE] : undefined;
  return st && !st.modified_ ? (st.base_ as T) : item;
}

/**
 * Read-only items of a (possibly immer-drafted) array without creating a child proxy per element. Reading the
 * elements of a draft array drafts each one; scanning 600+ clips that way on every commit dominated edit latency
 * (P-03). Items already drafted come back as their draft (reading primitive fields off them is free); the rest are
 * the untouched originals. `current()` is not used: with auto-freeze off it deep-copies every untouched clip.
 * Never mutate through the result: write through writableClip / writableItem, or replace the array.
 */
export function readItems<T>(arr: T[]): readonly T[] {
  if (!isDraft(arr)) return arr;
  const st = (arr as unknown as Record<symbol, DraftInternals | undefined>)[IMMER_STATE];
  const raw = st ? (st.copy_ ?? st.base_) : undefined;
  return Array.isArray(raw) ? (raw as T[]) : arr;
}

// ------------------------------------------------------------------
// Writing inside an immer recipe without drafting whole arrays
// ------------------------------------------------------------------
//
// The ops below scan raw items (readItems) and only draft what they change. When a clip array is reordered or
// rebuilt from raw items (sortTrack, clearRange, removeClips, rippleShift), it is replaced by a plain array that
// may hold *originals* (objects of the base state, usually frozen) at new indexes. Immer does not draft those on
// read (it only drafts an item that still sits at its base index), so every write to an item goes through
// writableItem: drafts and objects created during this recipe are written in place, an original is replaced
// by a private copy. Outside a recipe (plain data, as in the unit tests) everything is written in place, as before.

/** Clips copied shallowly from an original (nested transform / audio / arrays still shared with it). */
const shallowCopies = new WeakSet<object>();
/** Members of base arrays that are not frozen (a project that was loaded and not yet committed). */
const unfrozenBaseMembers = new WeakMap<readonly unknown[], Set<unknown>>();

function isPlainData(v: unknown): v is object {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep copy of plain data (an original never contains drafts). */
function thaw<T>(v: T): T {
  if (Array.isArray(v)) return v.map(thaw) as unknown as T;
  if (!isPlainData(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = thaw((v as Record<string, unknown>)[k]);
  return out as T;
}

/** Is `item` (raw, read from `owner[key]`) an object of the base state, which must never be written? */
function isOriginalItem(owner: object, key: string, item: object): boolean {
  if (Object.isFrozen(item)) return true;
  const st = (owner as Record<symbol, DraftInternals | undefined>)[IMMER_STATE];
  const base = st ? (st.base_ as Record<string, unknown>)[key] : undefined;
  // A frozen base array was produced by immer with auto-freeze: every original item in it is frozen as well.
  if (!Array.isArray(base) || Object.isFrozen(base)) return false;
  let members = unfrozenBaseMembers.get(base);
  if (!members) { members = new Set(base); unfrozenBaseMembers.set(base, members); }
  return members.has(item);
}

/** `owner[key][i]`, safe to write: a draft, an object created in this recipe, or a private copy of an original. */
function writableItem<T extends object>(owner: object, key: string, i: number): T {
  const arr = (owner as Record<string, T[]>)[key];
  const item = arr[i]; // a draft when the array is a draft and the item still sits at its base index
  if (!isDraft(owner) || isDraft(item)) return item;
  if (isOriginalItem(owner, key, item)) { const w = thaw(item); arr[i] = w; return w; }
  if (shallowCopies.has(item)) {
    shallowCopies.delete(item);
    const rec = item as Record<string, unknown>;
    for (const k of Object.keys(rec)) if (isPlainData(rec[k])) rec[k] = thaw(rec[k]);
  }
  return item;
}

function writableClip(track: Track, i: number): Clip { return writableItem<Clip>(track, 'clips', i); }

/**
 * `owner[key]` as a plain array that may be reordered / filled in place: a draft array is replaced by a plain
 * copy of its raw items (no proxy per element). Items still need writableItem (or copyOnWrite) before a write.
 */
function ownArray<T>(owner: object, key: string): T[] {
  const arr = (owner as Record<string, T[]>)[key];
  if (!isDraft(arr)) return arr;
  const plain = readItems(arr).slice();
  (owner as Record<string, T[]>)[key] = plain;
  return plain;
}

/**
 * Write `patch` into `arr[i]` (arr = ownArray(owner, key)): in place for drafts / new objects / plain data,
 * else a shallow copy replaces the original. Cheaper than drafting when many items change (ripple).
 */
function patchItem<T extends object>(owner: object, key: string, arr: T[], i: number, patch: Partial<T>): T {
  const item = arr[i];
  if (!isDraft(owner) || isDraft(item) || !isOriginalItem(owner, key, item)) { Object.assign(item, patch); return item; }
  const w = { ...item, ...patch };
  // A frozen original was deep-frozen by immer, so its nested objects are frozen too: freezing the copy makes it
  // a finished value immer does not walk again when it finalizes the array (and a later write copies it again).
  if (Object.isFrozen(item)) Object.freeze(w); else shallowCopies.add(w);
  arr[i] = w;
  return w;
}

const byStart = (a: Clip, b: Clip) => a.start - b.start;

export function sortTrack(track: Track): void {
  const clips = readItems(track.clips);
  for (let i = 1; i < clips.length; i++) {
    // Sort the raw items (stable, same order as sorting the draft) instead of drafting every clip.
    if (clips[i - 1].start > clips[i].start) { ownArray<Clip>(track, 'clips').sort(byStart); return; }
  }
}

/**
 * Add `clip` to `track` in start order: exactly `track.clips.push(clip); sortTrack(track)` (a stable sort puts it
 * after every clip with the same start), without sorting. On a sorted track (always, outside hostile data) it is
 * one scan and a splice into the raw items instead of a full sort: an insert edit adds a clip to, and splits a
 * clip on, every track, and the sorts were most of its cost before V8 has optimized them (the first edits).
 */
export function addClipSorted(track: Track, clip: Clip): void {
  const items = readItems(track.clips);
  let at = items.length;
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && items[i - 1].start > items[i].start) { track.clips.push(clip); sortTrack(track); return; } // unsorted: as before
    if (at === items.length && items[i].start > clip.start) at = i;
  }
  if (at === items.length) { track.clips.push(clip); return; }
  ownArray<Clip>(track, 'clips').splice(at, 0, clip);
}

/** Clips sharing `clip`'s link (in track order), or just `clip`. Inside a recipe the results may be written to. */
export function linkedClips(seq: Sequence, clip: Clip): Clip[] {
  if (!clip.linkId) return [clip];
  const out: Clip[] = [];
  for (const t of allTracks(seq)) {
    const items = readItems(t.clips);
    for (let i = 0; i < items.length; i++) if (items[i].linkId === clip.linkId) out.push(writableClip(t, i));
  }
  return out;
}

/** Clips whose id is in `ids`, in track order. Inside a recipe the results may be written to. */
export function clipsWithIds(seq: Sequence, ids: Iterable<ID>): Clip[] {
  const set = ids instanceof Set ? ids as Set<ID> : new Set(ids);
  const out: Clip[] = [];
  if (set.size === 0) return out;
  for (const t of allTracks(seq)) {
    const items = readItems(t.clips);
    for (let i = 0; i < items.length; i++) if (set.has(items[i].id)) out.push(writableClip(t, i));
  }
  return out;
}

/**
 * Set the audio stream played by the audio clips among `clipIds`: an absolute ffprobe index, or undefined to follow the
 * media's preferred stream (what export does for a clip without one). Video clips have no stream and clips on locked
 * tracks never change; an invalid index changes nothing. Returns the changed clips (writable inside a recipe).
 */
export function setClipAudioStream(seq: Sequence, clipIds: Iterable<ID>, index: number | undefined): Clip[] {
  const out: Clip[] = [];
  if (index !== undefined && !(Number.isInteger(index) && index >= 0)) return out;
  const ids = clipIds instanceof Set ? clipIds as Set<ID> : new Set(clipIds);
  for (const t of seq.audioTracks) {
    if (t.locked) continue;
    const items = readItems(t.clips);
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      if (!ids.has(c.id) || c.kind !== 'audio' || c.audioStream === index) continue;
      const w = writableClip(t, i);
      if (index === undefined) delete w.audioStream; else w.audioStream = index;
      out.push(w);
    }
  }
  return out;
}

export function clipsInRange(track: Track, start: number, end: number, except: Set<ID> = new Set()): Clip[] {
  return track.clips.filter((c) => !except.has(c.id) && c.start < end && clipEnd(c) > start);
}

export function clipAt(track: Track, frame: number): Clip | undefined {
  return track.clips.find((c) => c.start <= frame && clipEnd(c) > frame);
}

export function sequenceDuration(seq: Sequence): number {
  let end = 0;
  for (const t of allTracks(seq)) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function mediaFrames(mediaDuration: number, fps: Rational): number {
  return Number.isFinite(mediaDuration) ? Math.max(1, secondsToFrames(mediaDuration, fps)) : Number.MAX_SAFE_INTEGER;
}

/** Clip speed range in percent, shared by the Inspector field and the Speed / Duration dialog (forward only). */
export const SPEED_PERCENT_MIN = 1;
export const SPEED_PERCENT_MAX = 10000;
/** Clamp a speed percentage into [SPEED_PERCENT_MIN, SPEED_PERCENT_MAX]; returns a speed multiplier (1 = 100 %). */
export function clampSpeedPercent(pct: number): number {
  const p = Number.isFinite(pct) ? pct : 100;
  return Math.max(SPEED_PERCENT_MIN, Math.min(SPEED_PERCENT_MAX, p)) / 100;
}

/** Max timeline frames available from sourceIn given speed. */
export function maxDurationFrom(sourceIn: number, speed: number, mediaDuration: number, fps: Rational): number {
  if (!Number.isFinite(mediaDuration)) return Number.MAX_SAFE_INTEGER;
  const avail = Math.max(0, mediaDuration - sourceIn) / speed;
  return Math.max(0, Math.floor(avail * fps.num / fps.den + 1e-6));
}

/**
 * Latest frame the clip's tail may be extended to by its media. Never before the clip's current end: a clip
 * that already runs past its media end (e.g. after a relink to a shorter file) cannot grow, but dragging its
 * tail outward must not pull it back either.
 */
export function maxClipEnd(clip: Clip, mediaDuration: number, fps: Rational): number {
  return Math.max(clipEnd(clip), clip.start + maxDurationFrom(clip.sourceIn, clip.speed, mediaDuration, fps));
}

// ------------------------------------------------------------------
// Transition maintenance
// ------------------------------------------------------------------

/** Drop transitions whose clips are gone or no longer adjacent. */
export function reconcileTransitions(track: Track): void {
  if (track.transitions.length === 0) return;
  // Clips are only read: scan them without creating draft proxies, index (by id) only the clips that a
  // transition names: tracks hold thousands of clips and a few hundred transitions.
  const clips = readItems(track.clips);
  const trs = readItems(track.transitions);
  const named = new Set<ID>();
  for (const t of trs) { if (t.outClipId) named.add(t.outClipId); if (t.inClipId) named.add(t.inClipId); }
  const byId = new Map<ID, Clip>();
  for (const c of clips) if (named.has(c.id)) byId.set(c.id, c);
  const kept: Transition[] = [];
  for (let i = 0; i < trs.length; i++) {
    let tr = trs[i];
    const a = tr.outClipId ? byId.get(tr.outClipId) : null;
    const b = tr.inClipId ? byId.get(tr.inClipId) : null;
    if (tr.outClipId && !a) continue;
    if (tr.inClipId && !b) continue;
    if (a && b && clipEnd(a) !== b.start) continue;
    if (!a && !b) continue;
    const limit = Math.min(a ? a.duration : Infinity, b ? b.duration : Infinity);
    let d = tr.duration;
    if (!Number.isFinite(d) || d < 1) d = 1;
    if (d > limit) d = Math.max(1, limit);
    if (d !== tr.duration) { tr = writableItem<Transition>(track, 'transitions', i); tr.duration = d; } // draft only what changes
    kept.push(tr);
  }
  // Only replace the array when something was dropped, so untouched tracks keep their identity.
  if (kept.length !== trs.length) track.transitions = kept;
  if (kept.length < 2) return;
  // Two transitions on one clip (its in- and out-transition) must not overlap: in + out <= clip.duration.
  // The out-transition gives way; if nothing is left of it, it is dropped.
  // Cheap read-only check first: overlaps are rare, and the fix-up below drafts every transition.
  const firstBy = (list: readonly Transition[], key: 'inClipId' | 'outClipId') => {
    const m = new Map<ID, Transition>();
    for (const t of list) { const id = t[key]; if (id && !m.has(id)) m.set(id, t); }
    return m;
  };
  {
    const ins = firstBy(kept, 'inClipId'), outs = firstBy(kept, 'outClipId');
    let overlap = false;
    for (const [id, tin] of ins) {
      const tout = outs.get(id); if (!tout || tout === tin) continue;
      const c = byId.get(id);
      if (c && tin.duration + tout.duration > c.duration) { overlap = true; break; }
    }
    if (!overlap) return;
  }
  // Work on indexes into the (raw) list and write through writableItem: the list may hold originals.
  const at = (j: number) => readItems(track.transitions)[j];
  const live = readItems(track.transitions);
  const ins = new Map<ID, number[]>();
  const outs = new Map<ID, number[]>();
  for (let j = 0; j < live.length; j++) {
    const t = live[j];
    if (t.inClipId) { const l = ins.get(t.inClipId); if (l) l.push(j); else ins.set(t.inClipId, [j]); }
    if (t.outClipId) { const l = outs.get(t.outClipId); if (l) l.push(j); else outs.set(t.outClipId, [j]); }
  }
  const drop = new Set<ID>();
  for (const c of clips) {
    const il = ins.get(c.id); if (!il) continue;
    const ol = outs.get(c.id); if (!ol) continue;
    const tin = il.find((j) => !drop.has(at(j).id));
    const tout = ol.find((j) => !drop.has(at(j).id));
    if (tin === undefined || tout === undefined || tin === tout) continue;
    if (at(tin).duration + at(tout).duration <= c.duration) continue;
    const room = c.duration - at(tin).duration;
    if (room >= 1) writableItem<Transition>(track, 'transitions', tout).duration = room; else drop.add(at(tout).id);
  }
  if (drop.size) track.transitions = readItems(track.transitions).filter((t) => !drop.has(t.id));
}

/** Frames of `clip` already used by its transition on the other edge (excluding `exceptId`). */
function otherEdgeUse(track: Track, clip: Clip, edge: 'in' | 'out', exceptId?: ID): number {
  const t = readItems(track.transitions).find((x) => x.id !== exceptId && (edge === 'in' ? x.inClipId === clip.id : x.outClipId === clip.id));
  return t ? t.duration : 0;
}

/**
 * Longest duration a transition between `outClip` and `inClip` may have so that no clip carries
 * overlapping in- and out-transitions. `exceptId` is the transition being resized (ignored).
 */
export function transitionLimit(track: Track, outClip: Clip | undefined | null, inClip: Clip | undefined | null, exceptId?: ID): number {
  // outClip's other edge is its in-transition; inClip's other edge is its out-transition.
  const a = outClip ? outClip.duration - otherEdgeUse(track, outClip, 'in', exceptId) : Infinity;
  const b = inClip ? inClip.duration - otherEdgeUse(track, inClip, 'out', exceptId) : Infinity;
  return Math.min(a, b);
}

export function reconcileAll(seq: Sequence): void {
  for (const t of allTracks(seq)) { sortTrack(t); reconcileTransitions(t); }
}

export function transitionsForClip(track: Track, clipId: ID): { in?: Transition; out?: Transition } {
  return {
    in: track.transitions.find((t) => t.inClipId === clipId),
    out: track.transitions.find((t) => t.outClipId === clipId),
  };
}

export function addTransition(seq: Sequence, trackId: ID, frame: number, type: TransitionType, duration: number): Transition | null {
  const track = findTrack(seq, trackId);
  if (!track || track.locked) return null;
  // Find the cut at `frame`: clip ending at frame and/or clip starting at frame (read only: raw items).
  const clips = readItems(track.clips);
  const outClip = clips.find((c) => clipEnd(c) === frame);
  const inClip = clips.find((c) => c.start === frame);
  if (!outClip && !inClip) return null;
  if ((type === 'audioCrossfade') !== (track.kind === 'audio')) {
    // allow crossDissolve on audio to mean crossfade
    if (track.kind === 'audio') type = 'audioCrossfade';
    else return null;
  }
  // Remove existing transition at this cut
  const atCut = (t: Transition) => (outClip && t.outClipId === outClip.id) || (inClip && t.inClipId === inClip.id);
  if (readItems(track.transitions).some(atCut)) track.transitions = readItems(track.transitions).filter((t) => !atCut(t));
  let dur = Math.max(1, Math.min(duration, transitionLimit(track, outClip, inClip)));
  if (transitionLimit(track, outClip, inClip) < 1) {
    // A clip's other edge already uses every frame: share the clip between both transitions instead
    // (the existing one is shortened; on a 1-frame clip it gives way entirely).
    const trs = readItems(track.transitions);
    const sides = [
      { clip: outClip, other: outClip && trs.find((t) => t.inClipId === outClip.id) },
      { clip: inClip, other: inClip && trs.find((t) => t.outClipId === inClip.id) },
    ];
    dur = Math.max(1, duration);
    for (const { clip, other } of sides) if (clip) dur = Math.min(dur, other ? Math.max(1, Math.floor(clip.duration / 2)) : clip.duration);
    for (const { clip, other } of sides) {
      if (!clip || !other || other.duration + dur <= clip.duration) continue;
      // Indexes may have shifted (a transition dropped on the other side): look it up by id, write a writable item.
      const j = readItems(track.transitions).findIndex((t) => t.id === other.id);
      const w = writableItem<Transition>(track, 'transitions', j);
      w.duration = clip.duration - dur;
      if (w.duration < 1) track.transitions = readItems(track.transitions).filter((t) => t !== w);
    }
  }
  const tr: Transition = {
    id: uid('tr'), type, duration: dur,
    outClipId: outClip?.id ?? null, inClipId: inClip?.id ?? null,
  };
  track.transitions.push(tr);
  return tr;
}

export function removeTransition(seq: Sequence, transitionId: ID): void {
  for (const t of allTracks(seq)) {
    const trs = readItems(t.transitions);
    if (trs.some((tr) => tr.id === transitionId)) t.transitions = trs.filter((tr) => tr.id !== transitionId);
  }
}

// ------------------------------------------------------------------
// Shifting / ripple helpers
// ------------------------------------------------------------------

/**
 * Shift clips starting at or after `fromFrame` by `delta` on all unlocked tracks.
 * A track is skipped if shifting would cause a collision (a clip spanning fromFrame on that track) or would
 * move its earliest mover before frame 0. Returns the ids of tracks that were shifted.
 */
export function rippleShift(seq: Sequence, fromFrame: number, delta: number, opts: { onlyTrackIds?: Set<ID>; except?: Set<ID>; skipTrackIds?: Set<ID> } = {}): ID[] {
  const shifted: ID[] = [];
  if (delta === 0) return shifted;
  const except = opts.except;
  for (const track of allTracks(seq)) {
    if (track.locked) continue;
    if (opts.onlyTrackIds && !opts.onlyTrackIds.has(track.id)) continue;
    if (opts.skipTrackIds && opts.skipTrackIds.has(track.id)) continue;
    // Scan raw items; only the movers are written (copies of originals, no proxy per clip).
    const items = readItems(track.clips);
    let firstMover = Infinity; // no spread: tracks can hold 100k+ clips
    for (const c of items) if (c.start >= fromFrame && !except?.has(c.id) && c.start < firstMover) firstMover = c.start;
    if (firstMover === Infinity) continue;
    if (delta < 0) {
      // Leftward shift: block the whole track if the earliest mover would land before frame 0, or if a
      // non-moving clip would be overlapped by it after the shift (e.g. a clip spanning the gap being closed).
      if (firstMover + delta < 0) continue;
      const blocker = items.some((c) => !except?.has(c.id) && c.start < fromFrame && clipEnd(c) > firstMover + delta);
      if (blocker) continue;
    }
    const arr = ownArray<Clip>(track, 'clips');
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (c.start >= fromFrame && !except?.has(c.id)) patchItem<Clip>(track, 'clips', arr, i, { start: c.start + delta });
    }
    // Markers stay anchored to time (Premiere behaviour).
    shifted.push(track.id);
    reconcileTransitions(track);
  }
  // Story blocks follow ripple so structure stays aligned. For a leftward shift the removed region is
  // [fromFrame + delta, fromFrame): boundaries inside it collapse onto its start.
  const lo = Math.min(fromFrame, fromFrame + delta);
  const mapStart = (f: number) => (f >= fromFrame ? f + delta : f > lo ? lo : f);
  const mapEnd = (f: number) => (f > fromFrame ? f + delta : f > lo ? lo : f);
  // A block that falls entirely inside the removed region collapses to nothing and is dropped. The list is only
  // replaced when a block changes.
  const blocks = readItems(seq.storyBlocks);
  let changed = false;
  for (const b of blocks) {
    const start = Math.max(0, mapStart(b.start));
    const end = mapEnd(b.end);
    if (end <= start || start !== b.start || end !== b.end) { changed = true; break; }
  }
  if (changed) {
    const arr = ownArray<StoryBlock>(seq, 'storyBlocks');
    const kept: StoryBlock[] = [];
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      const start = Math.max(0, mapStart(b.start));
      const end = mapEnd(b.end);
      if (end <= start) continue;
      kept.push(start === b.start && end === b.end ? b : patchItem<StoryBlock>(seq, 'storyBlocks', arr, i, { start, end }));
    }
    seq.storyBlocks = kept;
  }
  return shifted;
}

export interface ClearRangeResult {
  /** Clips that were removed entirely. */
  removed: ID[];
  /** Clips cut in two: `head` kept its id, `tail` is a new clip. */
  splits: { head: Clip; tail: Clip }[];
}

/**
 * Remove the [start,end) range from a track's clips (splitting clips that straddle boundaries). `fps` is the
 * owning sequence's frame rate (needed to advance the sourceIn of the kept tails).
 */
export function clearRange(track: Track, start: number, end: number, fps: Rational, except: Set<ID> = new Set()): ClearRangeResult {
  const res: ClearRangeResult = { removed: [], splits: [] };
  if (end <= start) return res;
  const hit = (c: Clip) => !(except.has(c.id) || clipEnd(c) <= start || c.start >= end);
  // Raw scan first: a track with nothing in the range keeps its array. It is still sorted / reconciled as before:
  // callers (moveClips) rely on that check running between placements.
  const items = readItems(track.clips);
  if (!items.some(hit)) { sortTrack(track); reconcileTransitions(track); return res; }
  const result: Clip[] = [];
  for (const c of items) {
    if (!hit(c)) { result.push(c); continue; }
    const cEnd = clipEnd(c);
    if (c.start >= start && cEnd <= end) { res.removed.push(c.id); continue; }
    // Heads and tails are new objects (shallow copies, as before): mark those made from an original so a later
    // writableItem in the same recipe un-shares their nested objects first.
    const fresh = (x: Clip): Clip => { if (isDraft(track) && !isDraft(c)) shallowCopies.add(x); return x; };
    let head: Clip | null = null;
    if (c.start < start) {
      // keep head
      head = fresh({ ...c, duration: start - c.start });
      result.push(head);
    }
    if (cEnd > end) {
      // keep tail (new id so both halves can coexist)
      const consumed = end - c.start;
      const tail: Clip = fresh({
        ...c,
        id: c.start < start ? uid('clip') : c.id,
        start: end,
        duration: cEnd - end,
        sourceIn: c.sourceIn + consumed * (fps.den / fps.num) * c.speed,
      });
      if (c.start < start) {
        // Cut in two: the tail is a new clip, so the out-transition (if any) must follow it.
        tail.audio = { ...c.audio, fadeIn: 0 };
        const trs = readItems(track.transitions);
        for (let j = 0; j < trs.length; j++) if (trs[j].outClipId === c.id) writableItem<Transition>(track, 'transitions', j).outClipId = tail.id;
        if (head) res.splits.push({ head, tail });
      }
      result.push(tail);
    }
  }
  track.clips = result;
  sortTrack(track);
  reconcileTransitions(track);
  return res;
}

/** Remove subtitle cues attached to any of `clipIds` (sequence cue tracks). */
export function dropCuesForClips(seq: Sequence, clipIds: Iterable<ID>): void {
  const ids = clipIds instanceof Set ? clipIds as Set<ID> : new Set(clipIds);
  if (ids.size === 0) return;
  const attached = (c: { clipId?: ID }) => !!c.clipId && ids.has(c.clipId);
  for (const st of seq.subtitleTracks) {
    const cues = readItems(st.cues);
    if (cues.some(attached)) st.cues = cues.filter((c) => !attached(c));
  }
}

/**
 * A clip `headId` was cut so that it now ends at source time `headEndSrc` and a new clip `tail` starts at
 * source time `tailStartSrc` (equal for a plain split; larger when a range was cleared out of the middle).
 * Cues after the cut move to the tail; a cue straddling it is duplicated so both halves keep rendering.
 */
export function splitCuesAt(seq: Sequence, headId: ID, headEndSrc: number, tail: Clip, tailStartSrc: number): void {
  for (const st of seq.subtitleTracks) {
    const extra: typeof st.cues = [];
    const cues = readItems(st.cues); // raw scan: only the head's cues are drafted
    for (let j = 0; j < cues.length; j++) {
      const raw = cues[j];
      if (raw.clipId !== headId || raw.srcStart === undefined || raw.srcEnd === undefined) continue;
      if (raw.srcEnd <= tailStartSrc + 1e-9 && raw.srcStart < tailStartSrc - 1e-9) continue; // stays on the head
      const cue = writableItem<SequenceSubtitleCue>(st, 'cues', j);
      if (cue.srcStart === undefined || cue.srcEnd === undefined) continue;
      if (cue.srcStart >= tailStartSrc - 1e-9) { cue.clipId = tail.id; continue; }
      if (cue.srcEnd <= tailStartSrc + 1e-9) continue; // entirely before the tail: stays on the head
      if (cue.srcStart >= headEndSrc - 1e-9) {
        // starts inside the removed region, ends inside the tail: move what is left of it
        cue.clipId = tail.id; cue.srcStart = tailStartSrc; continue;
      }
      extra.push({ ...cue, id: uid('scue'), clipId: tail.id, srcStart: tailStartSrc });
      cue.srcEnd = headEndSrc;
    }
    for (const e of extra) st.cues.push(e);
  }
}

/** clearRange on a track of `seq`, keeping attached subtitle cues consistent. */
function clearRangeIn(seq: Sequence, track: Track, start: number, end: number, except?: Set<ID>): void {
  const res = clearRange(track, start, end, seq.fps, except);
  dropCuesForClips(seq, res.removed);
  const spf = seq.fps.den / seq.fps.num;
  for (const { head, tail } of res.splits) splitCuesAt(seq, head.id, head.sourceIn + head.duration * spf * head.speed, tail, tail.sourceIn);
}

// ------------------------------------------------------------------
// Placing clips
// ------------------------------------------------------------------

export interface NewClipSpec {
  mediaId: ID;
  name: string;
  sourceIn: number;      // seconds
  duration: number;      // frames
  speed?: number;
  kind: 'video' | 'audio';
  audioStream?: number;
  linkId?: ID | null;
  tags?: string[];
  characters?: string[];
  plotlines?: string[];
  locations?: string[];
  notes?: string;
  color?: string;
  sceneRecordId?: ID;
  originLabel?: string;
}

export function makeClip(spec: NewClipSpec, start: number): Clip {
  return {
    id: uid('clip'),
    mediaId: spec.mediaId,
    name: spec.name,
    start,
    duration: Math.max(MIN_CLIP_FRAMES, Math.round(spec.duration)),
    sourceIn: spec.sourceIn,
    speed: spec.speed ?? 1,
    linkId: spec.linkId ?? null,
    enabled: true,
    kind: spec.kind,
    audioStream: spec.audioStream,
    transform: defaultTransform(),
    audio: defaultAudio(),
    tags: spec.tags ?? [],
    characters: spec.characters ?? [],
    plotlines: spec.plotlines ?? [],
    locations: spec.locations ?? [],
    notes: spec.notes ?? '',
    color: spec.color,
    sceneRecordId: spec.sceneRecordId,
    originLabel: spec.originLabel,
  };
}

/** Overwrite: place the clip, trimming/removing whatever it covers on the same track. */
export function overwriteClip(seq: Sequence, trackId: ID, clip: Clip): boolean {
  const track = findTrack(seq, trackId);
  if (!track || track.locked) return false;
  clearRangeIn(seq, track, clip.start, clipEnd(clip), new Set([clip.id]));
  addClipSorted(track, clip);
  reconcileTransitions(track);
  return true;
}

/**
 * Insert: split any clip spanning `clip.start` on all unlocked tracks, ripple everything after by clip.duration,
 * then place the clip.
 */
export function insertClip(seq: Sequence, trackId: ID, clip: Clip, opts: { rippleTracks?: 'all' | 'own' } = {}): boolean {
  const track = findTrack(seq, trackId);
  if (!track || track.locked) return false;
  const tracks = opts.rippleTracks === 'own' ? [track] : allTracks(seq).filter((t) => !t.locked);
  splitTracksAt(seq, tracks, clip.start);
  rippleShift(seq, clip.start, clip.duration, { onlyTrackIds: new Set(tracks.map((t) => t.id)) });
  addClipSorted(track, clip);
  reconcileTransitions(track);
  return true;
}

/** Place a group of clips (e.g. linked video+audio) using insert or overwrite semantics atomically. */
export function placeClips(seq: Sequence, placements: { trackId: ID; clip: Clip }[], mode: 'insert' | 'overwrite'): boolean {
  if (placements.length === 0) return false;
  for (const p of placements) { const t = findTrack(seq, p.trackId); if (!t || t.locked) return false; }
  if (mode === 'overwrite') {
    for (const p of placements) overwriteClip(seq, p.trackId, p.clip);
    return true;
  }
  let start = Infinity, end = -Infinity;
  for (const p of placements) { start = Math.min(start, p.clip.start); end = Math.max(end, clipEnd(p.clip)); }
  const length = end - start;
  // Split tracks are reconciled once, after the ripple (rippleShift reconciles every track it shifts): the split
  // only shortens clips, which the ripple does not change, so one pass gives what a pass after each step gave.
  const split: Track[] = [];
  splitTracksAt(seq, allTracks(seq).filter((t) => !t.locked), start, { reconcile: false, split });
  const shifted = new Set(rippleShift(seq, start, length));
  for (const t of split) if (!shifted.has(t.id)) reconcileTransitions(t);
  for (const p of placements) {
    const t = findTrack(seq, p.trackId)!;
    // Guard against anything still overlapping on tracks that could not ripple. When nothing overlaps (the ripple
    // made room) clearRange would only re-sort and re-reconcile the track, which the reconcile below covers.
    const s = p.clip.start, e = clipEnd(p.clip);
    if (readItems(t.clips).some((c) => c.id !== p.clip.id && c.start < e && clipEnd(c) > s)) clearRangeIn(seq, t, s, e, new Set([p.clip.id]));
    addClipSorted(t, p.clip); reconcileTransitions(t);
  }
  return true;
}

// ------------------------------------------------------------------
// Split / razor
// ------------------------------------------------------------------

export function splitClip(seq: Sequence, track: Track, clip: Clip, frame: number, reconcile = true): Clip | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null;
  const src = readable(clip); // the tail copies every nested object, so read them without drafting
  const consumedSec = (frame - src.start) * seq.fps.den / seq.fps.num * src.speed;
  const tail: Clip = {
    ...src,
    id: uid('clip'),
    start: frame,
    duration: clipEnd(src) - frame,
    sourceIn: src.sourceIn + consumedSec,
    transform: { ...src.transform, crop: { ...src.transform.crop } },
    audio: { ...src.audio, fadeIn: 0 },
    tags: [...src.tags], characters: [...src.characters], plotlines: [...src.plotlines], locations: [...src.locations],
  };
  clip.duration = frame - src.start;
  clip.audio = { ...src.audio, fadeOut: 0 };
  // transitions: out transition moves to tail
  const trs = readItems(track.transitions);
  for (let j = 0; j < trs.length; j++) if (trs[j].outClipId === clip.id) writableItem<Transition>(track, 'transitions', j).outClipId = tail.id;
  addClipSorted(track, tail);
  // Both halves are shorter than the original: a transition on either side may now exceed its clip (unless the
  // caller reconciles the track itself once it is done with it).
  if (reconcile) reconcileTransitions(track);
  // subtitle cues attached to this clip: those after the split point move to the tail, straddlers are duplicated
  splitCuesAt(seq, clip.id, tail.sourceIn, tail, tail.sourceIn);
  return tail;
}

/**
 * Split whatever strictly spans `frame` on each of `tracks` (a clip boundary at `frame` is not split).
 * Tails that came from clips sharing a linkId are re-linked to each other with a fresh linkId so the
 * head pair and the tail pair stay independently linked. Returns the created tails. `reconcile: false` leaves the
 * split tracks' transitions to the caller (`split` collects those tracks).
 */
function splitTracksAt(seq: Sequence, tracks: Track[], frame: number, opts: { reconcile?: boolean; split?: Track[] } = {}): Clip[] {
  const tails: { tail: Clip; oldLink: ID | null }[] = [];
  for (const track of tracks) {
    const i = readItems(track.clips).findIndex((x) => x.start < frame && clipEnd(x) > frame);
    if (i < 0) continue;
    const c = writableClip(track, i);
    const tail = splitClip(seq, track, c, frame, opts.reconcile ?? true);
    if (tail) { tails.push({ tail, oldLink: c.linkId }); opts.split?.push(track); }
  }
  const groups = new Map<ID, Clip[]>();
  for (const t of tails) if (t.oldLink) { const g = groups.get(t.oldLink) ?? []; g.push(t.tail); groups.set(t.oldLink, g); }
  for (const g of groups.values()) if (g.length > 1) { const link = uid('link'); for (const c of g) c.linkId = link; }
  return tails.map((t) => t.tail);
}

/** Razor at frame: splits the clip under `frame` on the given tracks (or all unlocked tracks), keeping links. */
export function razorAt(seq: Sequence, frame: number, trackIds?: ID[], opts: { linked?: boolean } = {}): Clip[] {
  const created: Clip[] = [];
  const linked = opts.linked ?? true;
  const targets = trackIds ? allTracks(seq).filter((t) => trackIds.includes(t.id)) : allTracks(seq);
  const done = new Set<ID>();
  for (const track of targets) {
    if (track.locked) continue;
    const i = readItems(track.clips).findIndex((c) => c.start < frame && clipEnd(c) > frame);
    if (i < 0 || done.has(readItems(track.clips)[i].id)) continue;
    const clip = writableClip(track, i);
    const group = linked ? linkedClips(seq, clip) : [clip];
    const newLink = group.length > 1 ? uid('link') : null;
    for (const g of group) {
      const loc = locateClip(seq, g.id)!;
      if (loc.track.locked) continue;
      const tail = splitClip(seq, loc.track, g, frame);
      done.add(g.id);
      if (tail) { if (newLink) tail.linkId = newLink; created.push(tail); }
    }
  }
  return created;
}

// ------------------------------------------------------------------
// Removal
// ------------------------------------------------------------------

export function removeClips(seq: Sequence, clipIds: ID[]): void {
  const ids = new Set(clipIds);
  const removed = new Set<ID>();
  for (const t of allTracks(seq)) {
    if (t.locked) continue;
    // Raw scan: only tracks that lose a clip get a new array (and a transition check).
    const items = readItems(t.clips);
    if (!items.some((c) => ids.has(c.id))) continue;
    t.clips = items.filter((c) => { if (ids.has(c.id)) { removed.add(c.id); return false; } return true; });
    reconcileTransitions(t);
  }
  // Only cues attached to clips that were actually removed (clips on locked tracks keep theirs).
  dropCuesForClips(seq, removed);
}

/** Ripple delete: remove the clips and close the gaps they leave. Processes gaps right-to-left. */
export function rippleDeleteClips(seq: Sequence, clipIds: ID[]): void {
  const locs = clipIds.map((id) => locateClip(seq, id)).filter((l): l is ClipLocation => !!l && !l.track.locked);
  const ranges = locs.map((l) => ({ start: l.clip.start, end: clipEnd(l.clip) }));
  removeClips(seq, locs.map((l) => l.clip.id));
  // Merge overlapping/adjacent ranges (across tracks) into gap intervals, then close them right-to-left
  // so earlier gaps are still at their original positions when processed.
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  for (let i = merged.length - 1; i >= 0; i--) {
    const gap = merged[i];
    // Tracks with a clip still spanning the gap are left alone by rippleShift's collision check.
    rippleShift(seq, gap.end, -(gap.end - gap.start));
  }
}

/** Disabled clips that can be removed (not on a locked track), in track order. */
export function removableDisabledClipIds(seq: Sequence): ID[] {
  const out: ID[] = [];
  for (const t of allTracks(seq)) if (!t.locked) for (const c of readItems(t.clips)) if (!c.enabled) out.push(c.id);
  return out;
}

/** Ripple-delete every disabled clip (unlocked tracks): turns a what-if experiment into a real cut. Returns the count. */
export function rippleDeleteDisabledClips(seq: Sequence): number {
  const ids = removableDisabledClipIds(seq);
  if (ids.length) rippleDeleteClips(seq, ids);
  return ids.length;
}

/** Lift: remove the in/out range on the given tracks (no shift). */
export function liftRange(seq: Sequence, inF: number, outF: number, trackIds?: ID[]): void {
  for (const t of allTracks(seq)) {
    if (t.locked) continue;
    if (trackIds && !trackIds.includes(t.id)) continue;
    clearRangeIn(seq, t, inF, outF);
  }
}

/** Extract: remove the in/out range and close the gap. */
export function extractRange(seq: Sequence, inF: number, outF: number, trackIds?: ID[]): void {
  liftRange(seq, inF, outF, trackIds);
  rippleShift(seq, outF, -(outF - inF), trackIds ? { onlyTrackIds: new Set(trackIds) } : {});
}

// ------------------------------------------------------------------
// Trimming
// ------------------------------------------------------------------

export interface TrimLimits { minStart: number; maxStart: number; minEnd: number; maxEnd: number }

export function trimLimits(seq: Sequence, track: Track, clip: Clip, mediaDur: number): TrimLimits {
  const clips = readItems(track.clips); // read only; holds `clip` itself when it was drafted / made writable
  const idx = clips.indexOf(clip);
  const prev = clips[idx - 1];
  const next = clips[idx + 1];
  const handleBefore = Math.floor((clip.sourceIn / clip.speed) * seq.fps.num / seq.fps.den + 1e-6); // frames of media available before sourceIn
  const maxDur = maxDurationFrom(clip.sourceIn, clip.speed, mediaDur, seq.fps);
  // The limits only ever bound how far an edge may move outward: they never lie on the inner side of the
  // edge's current position (a clip already past its media end, or one overlapping a neighbour on a track
  // that was not repaired, keeps its edge instead of being pulled back / getting a negative duration).
  return {
    minStart: Math.min(clip.start, Math.max(prev ? clipEnd(prev) : 0, clip.start - handleBefore, 0)),
    maxStart: clipEnd(clip) - MIN_CLIP_FRAMES,
    minEnd: clip.start + MIN_CLIP_FRAMES,
    maxEnd: Math.max(clipEnd(clip), Math.min(next ? next.start : Number.MAX_SAFE_INTEGER, clip.start + maxDur)),
  };
}

/** Trim head: move the clip's start to newStart keeping the end fixed. Returns applied start. */
export function trimStart(seq: Sequence, clipId: ID, newStart: number, mediaDur: MediaDurationLookup, opts: { ignoreNeighbors?: boolean } = {}): number {
  const loc = findClip(seq, clipId);
  if (!loc || loc.track.locked) return NaN;
  const { track, clip } = loc;
  const lim = trimLimits(seq, track, clip, mediaDur(clip.mediaId));
  const minStart = opts.ignoreNeighbors ? Math.max(0, clip.start - Math.floor((clip.sourceIn / clip.speed) * seq.fps.num / seq.fps.den + 1e-6)) : lim.minStart;
  const target = Math.max(minStart, Math.min(lim.maxStart, newStart));
  const delta = target - clip.start;
  clip.sourceIn = Math.max(0, clip.sourceIn + delta * seq.fps.den / seq.fps.num * clip.speed);
  clip.start = target;
  clip.duration -= delta;
  reconcileTransitions(track);
  return target;
}

/** Trim tail: move the clip's end to newEnd keeping start fixed. Returns applied end. */
export function trimEnd(seq: Sequence, clipId: ID, newEnd: number, mediaDur: MediaDurationLookup, opts: { ignoreNeighbors?: boolean } = {}): number {
  const loc = findClip(seq, clipId);
  if (!loc || loc.track.locked) return NaN;
  const { track, clip } = loc;
  const lim = trimLimits(seq, track, clip, mediaDur(clip.mediaId));
  const maxEnd = opts.ignoreNeighbors ? maxClipEnd(clip, mediaDur(clip.mediaId), seq.fps) : lim.maxEnd;
  const target = Math.max(lim.minEnd, Math.min(maxEnd, newEnd));
  clip.duration = target - clip.start;
  reconcileTransitions(track);
  return target;
}

/**
 * Ripple trim head. `newStart` is expressed in the pre-edit timeline (like dragging the head with the
 * ripple tool): moving it right by d trims d frames off the head and reveals later source; moving it left
 * by d reveals earlier source. The clip's start stays anchored at its old position and everything that
 * starts at or after it (on all unlocked tracks, where no collision results) shifts by -d / +d.
 * Only linked clips that share the same start are trimmed together. Returns the applied (clamped) newStart.
 */
export function rippleTrimStart(seq: Sequence, clipId: ID, newStart: number, mediaDur: MediaDurationLookup): number {
  const loc = findClip(seq, clipId);
  if (!loc || loc.track.locked) return NaN;
  const oldStart = loc.clip.start;
  const group = linkedClips(seq, loc.clip).filter((c) => c.start === oldStart && !locateClip(seq, c.id)!.track.locked);
  let target = newStart;
  for (const g of group) {
    const handleBefore = Math.floor((g.sourceIn / g.speed) * seq.fps.num / seq.fps.den + 1e-6);
    target = Math.max(oldStart - handleBefore, Math.min(clipEnd(g) - MIN_CLIP_FRAMES, target));
  }
  const delta = target - oldStart; // > 0 shrink head, < 0 extend head
  if (delta === 0) return oldStart;
  const except = new Set(group.map((g) => g.id));
  for (const g of group) {
    g.sourceIn = Math.max(0, g.sourceIn + delta * seq.fps.den / seq.fps.num * g.speed);
    g.duration -= delta;
  }
  rippleShift(seq, oldStart, -delta, { except });
  reconcileAll(seq);
  return target;
}

/** Ripple trim tail: changes clip end and shifts everything after accordingly. */
export function rippleTrimEnd(seq: Sequence, clipId: ID, newEnd: number, mediaDur: MediaDurationLookup): number {
  const loc = findClip(seq, clipId);
  if (!loc || loc.track.locked) return NaN;
  const oldEnd = clipEnd(loc.clip);
  // Like rippleTrimStart: linked clips on locked tracks are left alone (their track does not ripple either).
  const group = linkedClips(seq, loc.clip).filter((c) => clipEnd(c) === oldEnd && !locateClip(seq, c.id)!.track.locked);
  let target = newEnd;
  for (const g of group) {
    target = Math.max(g.start + MIN_CLIP_FRAMES, Math.min(maxClipEnd(g, mediaDur(g.mediaId), seq.fps), target));
  }
  const delta = target - oldEnd;
  if (delta === 0) return oldEnd;
  if (delta > 0) rippleShift(seq, oldEnd, delta, {});
  for (const g of group) g.duration += delta;
  if (delta < 0) rippleShift(seq, oldEnd, delta, { except: new Set(group.map((g) => g.id)) });
  reconcileAll(seq);
  return target;
}

/** Rolling edit: move the cut between outClip and inClip to newFrame (durations of both change, total stays). */
export function rollEdit(seq: Sequence, outClipId: ID, inClipId: ID, newFrame: number, mediaDur: MediaDurationLookup): number {
  const a = findClip(seq, outClipId); const b = findClip(seq, inClipId);
  if (!a || !b || a.track.locked || b.track.locked) return NaN;
  const cut = clipEnd(a.clip);
  if (b.clip.start !== cut) return NaN;
  const maxA = maxClipEnd(a.clip, mediaDur(a.clip.mediaId), seq.fps); // never left of the cut
  const handleB = Math.floor((b.clip.sourceIn / b.clip.speed) * seq.fps.num / seq.fps.den + 1e-6);
  const minB = b.clip.start - handleB;
  const target = Math.max(a.clip.start + MIN_CLIP_FRAMES, minB, Math.min(maxA, clipEnd(b.clip) - MIN_CLIP_FRAMES, newFrame));
  const delta = target - cut;
  if (delta === 0) return cut;
  a.clip.duration += delta;
  b.clip.sourceIn = Math.max(0, b.clip.sourceIn + delta * seq.fps.den / seq.fps.num * b.clip.speed);
  b.clip.start += delta;
  b.clip.duration -= delta;
  reconcileTransitions(a.track);
  return target;
}

/** Slip: change the source range shown by the clip without moving it. deltaFrames > 0 shows later material. */
export function slipClip(seq: Sequence, clipId: ID, deltaFrames: number, mediaDur: MediaDurationLookup): number {
  const loc = findClip(seq, clipId);
  if (!loc || loc.track.locked) return 0;
  const group = linkedClips(seq, loc.clip).filter((g) => !locateClip(seq, g.id)!.track.locked); // locked tracks never change
  let d = deltaFrames;
  for (const g of group) {
    const handleBefore = Math.floor((g.sourceIn / g.speed) * seq.fps.num / seq.fps.den + 1e-6);
    const maxDur = maxDurationFrom(g.sourceIn, g.speed, mediaDur(g.mediaId), seq.fps);
    const handleAfter = Math.max(0, maxDur - g.duration); // a clip longer than its media cannot slip later, but never backwards
    d = Math.max(-handleBefore, Math.min(handleAfter, d));
  }
  for (const g of group) g.sourceIn = Math.max(0, g.sourceIn + d * seq.fps.den / seq.fps.num * g.speed);
  return d;
}

/** Slide: move the clip in time, trimming neighbours to compensate so overall duration stays constant. */
export function slideClip(seq: Sequence, clipId: ID, deltaFrames: number, mediaDur: MediaDurationLookup): number {
  const loc = findClip(seq, clipId);
  if (!loc || loc.track.locked) return 0;
  const { track, clip, index } = loc;
  // Neighbours are read raw and only made writable when they are trimmed.
  const raw = readItems(track.clips);
  const prev = raw[index - 1];
  const next = raw[index + 1];
  let d = deltaFrames;
  // An adjacent neighbour is trimmed to compensate; across a gap the clip may only move within the gap.
  if (prev) {
    const gap = clip.start - clipEnd(prev);
    if (gap === 0) {
      d = Math.min(d, maxClipEnd(prev, mediaDur(prev.mediaId), seq.fps) - clipEnd(prev)); // prev can extend this much (>= 0)
      d = Math.max(d, -(prev.duration - MIN_CLIP_FRAMES));    // prev can shrink this much
    } else d = Math.max(d, -Math.max(0, gap));
  } else d = Math.max(d, -clip.start);
  if (next) {
    const gap = next.start - clipEnd(clip);
    if (gap === 0) {
      const handleNext = Math.floor((next.sourceIn / next.speed) * seq.fps.num / seq.fps.den + 1e-6);
      d = Math.max(d, -handleNext);                           // next can extend backwards this much
      d = Math.min(d, next.duration - MIN_CLIP_FRAMES);       // next can shrink this much
    } else d = Math.min(d, Math.max(0, gap));
  }
  if (d === 0) return 0;
  if (prev && clipEnd(prev) === clip.start) writableClip(track, index - 1).duration += d;
  if (next && next.start === clipEnd(clip)) {
    const n = writableClip(track, index + 1);
    n.sourceIn = Math.max(0, n.sourceIn + d * seq.fps.den / seq.fps.num * n.speed);
    n.start += d; n.duration -= d;
  }
  clip.start += d;
  sortTrack(track);
  reconcileTransitions(track);
  return d;
}

// ------------------------------------------------------------------
// Moving
// ------------------------------------------------------------------

export interface MoveSpec { clipId: ID; toTrackId: ID; toStart: number }

/**
 * Move clips to new positions/tracks. `toStart` values are in the pre-move timeline.
 * - overwrite: the clips are lifted (leaving gaps) and destinations are cleared.
 * - insert (Premiere insert-move / rearrange): the clips are extracted — the gap each leaves on its source
 *   track is closed — and then inserted at the destination, rippling everything after it on all unlocked
 *   tracks. A destination after the vacated range is pulled back by the closed gap.
 * The delta is clamped once so the earliest clip lands at >= 0 and relative spacing is kept.
 */
export function moveClips(seq: Sequence, moves: MoveSpec[], mode: 'overwrite' | 'insert'): boolean {
  if (moves.length === 0) return false;
  const lifted: { clip: Clip; toTrackId: ID; toStart: number; fromTrackId: ID; fromStart: number }[] = [];
  let minTo = Infinity;
  for (const m of moves) minTo = Math.min(minTo, m.toStart); // no spread: a select-all move can hold 100k+ clips
  const shift = Math.max(0, -minTo);
  for (const m of moves) {
    const loc = findClip(seq, m.clipId);
    const dest = findTrack(seq, m.toTrackId);
    if (!loc || loc.track.locked || !dest || dest.locked || dest.kind !== loc.track.kind) return false;
    lifted.push({ clip: loc.clip, toTrackId: m.toTrackId, toStart: m.toStart + shift, fromTrackId: loc.track.id, fromStart: loc.clip.start });
  }
  // remove from source tracks (raw scan; only tracks that lose a clip get a new array)
  const ids = new Set(lifted.map((l) => l.clip.id));
  const touched = new Set<ID>();
  for (const t of allTracks(seq)) {
    const items = readItems(t.clips);
    if (!items.some((c) => ids.has(c.id))) continue;
    t.clips = items.filter((c) => !ids.has(c.id));
    touched.add(t.id);
  }
  if (mode === 'insert') {
    // Close the vacated ranges like a ripple delete (all unlocked tracks, so tracks that were not touched
    // stay in sync; a track with a clip spanning a gap is left alone). Right-to-left so earlier ranges
    // stay at their original positions. Remember which tracks each gap closed on.
    const ranges = lifted.map((l) => ({ start: l.fromStart, end: l.fromStart + l.clip.duration })).sort((a, b) => a.start - b.start);
    const gaps: { start: number; end: number; tracks: Set<ID> }[] = [];
    for (const r of ranges) {
      const last = gaps[gaps.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else gaps.push({ start: r.start, end: r.end, tracks: new Set() });
    }
    for (let i = gaps.length - 1; i >= 0; i--) {
      const g = gaps[i];
      // A track with nothing after the gap has nothing to shift but counts as closed.
      const idle = allTracks(seq).filter((t) => !t.locked && !readItems(t.clips).some((c) => c.start >= g.end)).map((t) => t.id);
      for (const id of [...rippleShift(seq, g.end, -(g.end - g.start)), ...idle]) g.tracks.add(id);
    }
    // Destinations are given in the pre-move timeline: map them through the gaps that closed on the
    // earliest clip's destination track (a destination inside a vacated range lands at its start).
    const first = lifted.reduce((a, b) => (b.toStart < a.toStart ? b : a));
    let mapped = first.toStart;
    for (const g of gaps) {
      if (!g.tracks.has(first.toTrackId)) continue;
      if (first.toStart >= g.end) mapped -= g.end - g.start;
      else if (first.toStart > g.start) mapped -= first.toStart - g.start;
    }
    const adj = first.toStart - mapped;
    for (const l of lifted) l.toStart = Math.max(0, l.toStart - adj);
    let start = Infinity, end = -Infinity;
    for (const l of lifted) { start = Math.min(start, l.toStart); end = Math.max(end, l.toStart + l.clip.duration); }
    splitTracksAt(seq, allTracks(seq).filter((t) => !t.locked), start);
    rippleShift(seq, start, end - start);
  }
  for (const l of lifted) {
    const t = findTrack(seq, l.toTrackId)!;
    l.clip.start = l.toStart;
    clearRangeIn(seq, t, l.clip.start, clipEnd(l.clip));
    addClipSorted(t, l.clip);
    touched.add(t.id);
  }
  // Tracks shifted or split above were reconciled there; the source and destination tracks are checked here.
  for (const t of allTracks(seq)) if (touched.has(t.id)) reconcileTransitions(t);
  return true;
}

// ------------------------------------------------------------------
// Tracks
// ------------------------------------------------------------------

export function makeTrack(kind: 'video' | 'audio', index: number): Track {
  return {
    id: uid(kind === 'video' ? 'v' : 'a'),
    name: `${kind === 'video' ? 'V' : 'A'}${index}`,
    kind, clips: [], transitions: [], muted: false, solo: false, locked: false,
    height: kind === 'video' ? 64 : 48, volume: 1, patched: index === 1,
  };
}

/** Append a track of `kind`, or insert it at `index` (clamped to [0, length]); default-named tracks are renumbered. */
export function addTrack(seq: Sequence, kind: 'video' | 'audio', index?: number): Track {
  const list = kind === 'video' ? seq.videoTracks : seq.audioTracks;
  const at = index === undefined ? list.length : Math.max(0, Math.min(list.length, Math.round(index)));
  const t = makeTrack(kind, at + 1);
  t.patched = false;
  list.splice(at, 0, t);
  if (at < list.length - 1) renameTracks(seq);
  return t;
}

export function removeTrack(seq: Sequence, trackId: ID): boolean {
  for (const list of [seq.videoTracks, seq.audioTracks]) {
    const i = list.findIndex((t) => t.id === trackId);
    if (i < 0) continue;
    if (list.length <= 1) return false;
    const [gone] = list.splice(i, 1);
    dropCuesForClips(seq, readItems(gone.clips).map((c) => c.id));
    renameTracks(seq);
    return true;
  }
  return false;
}

export function renameTracks(seq: Sequence): void {
  seq.videoTracks.forEach((t, i) => { if (/^V\d+$/.test(t.name)) t.name = `V${i + 1}`; });
  seq.audioTracks.forEach((t, i) => { if (/^A\d+$/.test(t.name)) t.name = `A${i + 1}`; });
}

// ------------------------------------------------------------------
// Navigation helpers
// ------------------------------------------------------------------

export function editPoints(seq: Sequence, trackIds?: ID[]): number[] {
  const set = new Set<number>([0]);
  for (const t of allTracks(seq)) {
    if (trackIds && !trackIds.includes(t.id)) continue;
    for (const c of readItems(t.clips)) { set.add(c.start); set.add(clipEnd(c)); }
  }
  for (const m of readItems(seq.markers)) set.add(m.time);
  return [...set].sort((a, b) => a - b);
}

export function nextEdit(seq: Sequence, frame: number): number | null {
  const pts = editPoints(seq);
  for (const p of pts) if (p > frame) return p;
  return null;
}
export function prevEdit(seq: Sequence, frame: number): number | null {
  const pts = editPoints(seq);
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i] < frame) return pts[i];
  return null;
}

export function addMarker(seq: Sequence, marker: Omit<Marker, 'id'>): Marker {
  const m: Marker = { id: uid('mk'), ...marker };
  seq.markers.push(m);
  ownArray<Marker>(seq, 'markers').sort((a, b) => a.time - b.time); // raw sort: no proxy per marker
  return m;
}

// ------------------------------------------------------------------
// Subtitle cue positions
// ------------------------------------------------------------------

export interface ResolvedCue { id: ID; trackId: ID; start: number; end: number; text: string; clipId?: ID; orphan: boolean }

export function resolveSubtitleCues(seq: Sequence): ResolvedCue[] {
  const out: ResolvedCue[] = [];
  const clipIndex = new Map<ID, Clip>();
  for (const t of seq.videoTracks) for (const c of t.clips) clipIndex.set(c.id, c);
  for (const t of seq.audioTracks) for (const c of t.clips) if (!clipIndex.has(c.id)) clipIndex.set(c.id, c);
  for (const st of seq.subtitleTracks) {
    if (!st.enabled) continue;
    for (const cue of st.cues) {
      if (cue.clipId) {
        const clip = clipIndex.get(cue.clipId);
        if (!clip || !clip.enabled || cue.srcStart === undefined || cue.srcEnd === undefined) { continue; }
        const s = clip.start + Math.round((cue.srcStart - clip.sourceIn) / clip.speed * seq.fps.num / seq.fps.den) + cue.offset;
        const e = clip.start + Math.round((cue.srcEnd - clip.sourceIn) / clip.speed * seq.fps.num / seq.fps.den) + cue.offset;
        const cs = Math.max(s, clip.start); const ce = Math.min(e, clipEnd(clip));
        if (ce <= cs) continue;
        out.push({ id: cue.id, trackId: st.id, start: cs, end: ce, text: cue.text, clipId: clip.id, orphan: false });
      } else {
        // An offset may not move a cue before the sequence start: clamp at 0, drop what is left of nothing.
        const start = Math.max(0, cue.start + cue.offset);
        const end = cue.start + cue.duration + cue.offset;
        if (!(end > start)) continue;
        out.push({ id: cue.id, trackId: st.id, start, end, text: cue.text, orphan: false });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// ------------------------------------------------------------------
// Clip-anchored markers
// ------------------------------------------------------------------

/**
 * Markers (and continuity notes) with a `clipId` follow their clip, like clip-anchored subtitle cues: the
 * source time under the marker in `prev` is kept under it in `next`. A pure move shifts the marker by the
 * move delta; a head trim (select tool) leaves it in place; a split keeps it where it is. When the clip no
 * longer exists the marker keeps its time and loses its `clipId`. Mutates `next` (an immer draft).
 */
export function followClipMarkers(prev: Sequence, next: Sequence): void {
  // Raw reads throughout (no proxy per marker / clip); only markers that change are made writable.
  const markers = readItems(next.markers);
  if (!markers.some((m) => m.clipId)) return;
  const index = (seq: Sequence) => {
    const map = new Map<ID, Clip>();
    for (const t of allTracks(seq)) for (const c of readItems(t.clips)) map.set(c.id, c);
    return map;
  };
  const before = index(prev);
  const after = index(next);
  let moved = false;
  for (let j = 0; j < markers.length; j++) {
    const m = markers[j];
    if (!m.clipId) continue;
    const a = before.get(m.clipId);
    if (!a) continue; // the clip did not exist before this edit (e.g. marker just linked): nothing to follow
    const b = after.get(m.clipId);
    if (!b) { delete writableItem<Marker>(next, 'markers', j).clipId; continue; }
    if (a === b || (a.start === b.start && a.sourceIn === b.sourceIn && a.speed === b.speed && prev.fps.num * next.fps.den === next.fps.num * prev.fps.den)) continue;
    const src = a.sourceIn + ((m.time - a.start) * prev.fps.den / prev.fps.num) * a.speed;
    const t = b.start + Math.round(((src - b.sourceIn) / b.speed) * next.fps.num / next.fps.den);
    const time = Math.max(0, t);
    if (time !== m.time) { writableItem<Marker>(next, 'markers', j).time = time; moved = true; }
  }
  if (moved) ownArray<Marker>(next, 'markers').sort((x, y) => x.time - y.time);
}
