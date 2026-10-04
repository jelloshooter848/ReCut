/**
 * Pure timeline operations. These functions mutate the Sequence passed in (intended to be an immer draft)
 * and never touch anything outside of it. All positions are integer frames.
 */
import type { Clip, ClipAudio, ClipTransform, Sequence, Track, Transition, TransitionType, ID, Rational, Marker } from './model';
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

export function findClip(seq: Sequence, clipId: ID): ClipLocation | undefined {
  for (const track of allTracks(seq)) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return undefined;
}

export function sortTrack(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start);
}

export function linkedClips(seq: Sequence, clip: Clip): Clip[] {
  if (!clip.linkId) return [clip];
  const out: Clip[] = [];
  for (const t of allTracks(seq)) for (const c of t.clips) if (c.linkId === clip.linkId) out.push(c);
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

/** Max timeline frames available from sourceIn given speed. */
export function maxDurationFrom(sourceIn: number, speed: number, mediaDuration: number, fps: Rational): number {
  if (!Number.isFinite(mediaDuration)) return Number.MAX_SAFE_INTEGER;
  const avail = Math.max(0, mediaDuration - sourceIn) / speed;
  return Math.max(0, Math.floor(avail * fps.num / fps.den + 1e-6));
}

// ------------------------------------------------------------------
// Transition maintenance
// ------------------------------------------------------------------

/** Drop transitions whose clips are gone or no longer adjacent. */
export function reconcileTransitions(track: Track): void {
  const byId = new Map(track.clips.map((c) => [c.id, c]));
  track.transitions = track.transitions.filter((tr) => {
    const a = tr.outClipId ? byId.get(tr.outClipId) : null;
    const b = tr.inClipId ? byId.get(tr.inClipId) : null;
    if (tr.outClipId && !a) return false;
    if (tr.inClipId && !b) return false;
    if (a && b && clipEnd(a) !== b.start) return false;
    if (!a && !b) return false;
    const limit = Math.min(a ? a.duration : Infinity, b ? b.duration : Infinity);
    if (tr.duration > limit) tr.duration = Math.max(1, limit);
    return true;
  });
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
  // Find the cut at `frame`: clip ending at frame and/or clip starting at frame.
  const outClip = track.clips.find((c) => clipEnd(c) === frame);
  const inClip = track.clips.find((c) => c.start === frame);
  if (!outClip && !inClip) return null;
  if ((type === 'audioCrossfade') !== (track.kind === 'audio')) {
    // allow crossDissolve on audio to mean crossfade
    if (track.kind === 'audio') type = 'audioCrossfade';
    else return null;
  }
  // Remove existing transition at this cut
  track.transitions = track.transitions.filter((t) => !(
    (outClip && t.outClipId === outClip.id) || (inClip && t.inClipId === inClip.id)
  ));
  const limit = Math.min(outClip ? outClip.duration : Infinity, inClip ? inClip.duration : Infinity);
  const tr: Transition = {
    id: uid('tr'), type, duration: Math.max(1, Math.min(duration, limit)),
    outClipId: outClip?.id ?? null, inClipId: inClip?.id ?? null,
  };
  track.transitions.push(tr);
  return tr;
}

export function removeTransition(seq: Sequence, transitionId: ID): void {
  for (const t of allTracks(seq)) t.transitions = t.transitions.filter((tr) => tr.id !== transitionId);
}

// ------------------------------------------------------------------
// Shifting / ripple helpers
// ------------------------------------------------------------------

/**
 * Shift clips starting at or after `fromFrame` by `delta` on all unlocked tracks.
 * A track is skipped if shifting would cause a collision (a clip spanning fromFrame on that track).
 * Returns the ids of tracks that were shifted.
 */
export function rippleShift(seq: Sequence, fromFrame: number, delta: number, opts: { onlyTrackIds?: Set<ID>; except?: Set<ID>; skipTrackIds?: Set<ID> } = {}): ID[] {
  const shifted: ID[] = [];
  if (delta === 0) return shifted;
  for (const track of allTracks(seq)) {
    if (track.locked) continue;
    if (opts.onlyTrackIds && !opts.onlyTrackIds.has(track.id)) continue;
    if (opts.skipTrackIds && opts.skipTrackIds.has(track.id)) continue;
    const movers = track.clips.filter((c) => c.start >= fromFrame && !(opts.except?.has(c.id)));
    if (movers.length === 0) continue;
    if (delta < 0) {
      // Leftward shift: block the whole track if a non-moving clip would be overlapped by the
      // earliest mover after the shift (e.g. a clip spanning the gap being closed).
      const firstMover = Math.min(...movers.map((c) => c.start));
      const blocker = track.clips.find((c) => !opts.except?.has(c.id) && c.start < fromFrame && clipEnd(c) > firstMover + delta);
      if (blocker) continue;
    }
    for (const c of movers) c.start += delta;
    // Markers stay anchored to time (Premiere behaviour).
    shifted.push(track.id);
    reconcileTransitions(track);
  }
  // Story blocks follow ripple so structure stays aligned. For a leftward shift the removed region is
  // [fromFrame + delta, fromFrame): boundaries inside it collapse onto its start.
  const lo = Math.min(fromFrame, fromFrame + delta);
  const mapStart = (f: number) => (f >= fromFrame ? f + delta : f > lo ? lo : f);
  const mapEnd = (f: number) => (f > fromFrame ? f + delta : f > lo ? lo : f);
  for (const b of seq.storyBlocks) {
    b.start = Math.max(0, mapStart(b.start));
    b.end = Math.max(b.start + 1, mapEnd(b.end));
  }
  return shifted;
}

/** Remove the [start,end) range from a track's clips (splitting clips that straddle boundaries). */
export function clearRange(track: Track, start: number, end: number, except: Set<ID> = new Set()): void {
  if (end <= start) return;
  const result: Clip[] = [];
  const fps = track._fps as Rational | undefined; // injected by callers via withFps
  for (const c of track.clips) {
    if (except.has(c.id) || clipEnd(c) <= start || c.start >= end) { result.push(c); continue; }
    const cEnd = clipEnd(c);
    if (c.start < start) {
      // keep head
      const head = { ...c, duration: start - c.start };
      result.push(head);
    }
    if (cEnd > end) {
      // keep tail (new id so both halves can coexist)
      const consumed = end - c.start;
      const tail: Clip = {
        ...c,
        id: c.start < start ? uid('clip') : c.id,
        start: end,
        duration: cEnd - end,
        sourceIn: c.sourceIn + consumed * (fps ? fps.den / fps.num : 0) * c.speed,
      };
      if (c.start < start) {
        // Cut in two: the tail is a new clip, so the out-transition (if any) must follow it.
        tail.audio = { ...c.audio, fadeIn: 0 };
        for (const tr of track.transitions) if (tr.outClipId === c.id) tr.outClipId = tail.id;
      }
      result.push(tail);
    }
  }
  track.clips = result;
  sortTrack(track);
  reconcileTransitions(track);
}

// Tracks need the sequence fps for source math in clearRange; we attach it transiently.
declare module './model' { interface Track { _fps?: Rational } }
function withFps(seq: Sequence): void { for (const t of allTracks(seq)) t._fps = seq.fps; }
function stripFps(seq: Sequence): void { for (const t of allTracks(seq)) delete t._fps; }

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
  withFps(seq);
  clearRange(track, clip.start, clipEnd(clip), new Set([clip.id]));
  stripFps(seq);
  track.clips.push(clip);
  sortTrack(track);
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
  track.clips.push(clip);
  sortTrack(track);
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
  const start = Math.min(...placements.map((p) => p.clip.start));
  const length = Math.max(...placements.map((p) => clipEnd(p.clip))) - start;
  splitTracksAt(seq, allTracks(seq).filter((t) => !t.locked), start);
  rippleShift(seq, start, length);
  for (const p of placements) {
    const t = findTrack(seq, p.trackId)!;
    // Guard against anything still overlapping on tracks that could not ripple
    withFps(seq); clearRange(t, p.clip.start, clipEnd(p.clip), new Set([p.clip.id])); stripFps(seq);
    t.clips.push(p.clip); sortTrack(t); reconcileTransitions(t);
  }
  return true;
}

// ------------------------------------------------------------------
// Split / razor
// ------------------------------------------------------------------

export function splitClip(seq: Sequence, track: Track, clip: Clip, frame: number): Clip | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null;
  const consumedSec = (frame - clip.start) * seq.fps.den / seq.fps.num * clip.speed;
  const tail: Clip = {
    ...clip,
    id: uid('clip'),
    start: frame,
    duration: clipEnd(clip) - frame,
    sourceIn: clip.sourceIn + consumedSec,
    transform: { ...clip.transform, crop: { ...clip.transform.crop } },
    audio: { ...clip.audio, fadeIn: 0 },
    tags: [...clip.tags], characters: [...clip.characters], plotlines: [...clip.plotlines], locations: [...clip.locations],
  };
  clip.duration = frame - clip.start;
  clip.audio = { ...clip.audio, fadeOut: 0 };
  // transitions: out transition moves to tail
  for (const tr of track.transitions) if (tr.outClipId === clip.id) tr.outClipId = tail.id;
  track.clips.push(tail);
  sortTrack(track);
  // subtitle cues attached to this clip: reassign those after the split point to the tail
  for (const st of seq.subtitleTracks) for (const cue of st.cues) {
    if (cue.clipId === clip.id && cue.srcStart !== undefined && cue.srcStart >= tail.sourceIn) cue.clipId = tail.id;
  }
  return tail;
}

/**
 * Split whatever strictly spans `frame` on each of `tracks` (a clip boundary at `frame` is not split).
 * Tails that came from clips sharing a linkId are re-linked to each other with a fresh linkId so the
 * head pair and the tail pair stay independently linked. Returns the created tails.
 */
function splitTracksAt(seq: Sequence, tracks: Track[], frame: number): Clip[] {
  const tails: { tail: Clip; oldLink: ID | null }[] = [];
  for (const track of tracks) {
    const c = track.clips.find((x) => x.start < frame && clipEnd(x) > frame);
    if (!c) continue;
    const tail = splitClip(seq, track, c, frame);
    if (tail) tails.push({ tail, oldLink: c.linkId });
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
    const clip = track.clips.find((c) => c.start < frame && clipEnd(c) > frame);
    if (!clip || done.has(clip.id)) continue;
    const group = linked ? linkedClips(seq, clip) : [clip];
    const newLink = group.length > 1 ? uid('link') : null;
    for (const g of group) {
      const loc = findClip(seq, g.id)!;
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
    t.clips = t.clips.filter((c) => { if (ids.has(c.id)) { removed.add(c.id); return false; } return true; });
    reconcileTransitions(t);
  }
  // Only cues attached to clips that were actually removed (clips on locked tracks keep theirs).
  for (const st of seq.subtitleTracks) st.cues = st.cues.filter((c) => !(c.clipId && removed.has(c.clipId)));
}

/** Ripple delete: remove the clips and close the gaps they leave. Processes gaps right-to-left. */
export function rippleDeleteClips(seq: Sequence, clipIds: ID[]): void {
  const locs = clipIds.map((id) => findClip(seq, id)).filter((l): l is ClipLocation => !!l && !l.track.locked);
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

/** Lift: remove the in/out range on the given tracks (no shift). */
export function liftRange(seq: Sequence, inF: number, outF: number, trackIds?: ID[]): void {
  withFps(seq);
  for (const t of allTracks(seq)) {
    if (t.locked) continue;
    if (trackIds && !trackIds.includes(t.id)) continue;
    clearRange(t, inF, outF);
  }
  stripFps(seq);
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
  const idx = track.clips.indexOf(clip);
  const prev = track.clips[idx - 1];
  const next = track.clips[idx + 1];
  const handleBefore = Math.floor((clip.sourceIn / clip.speed) * seq.fps.num / seq.fps.den + 1e-6); // frames of media available before sourceIn
  const maxDur = maxDurationFrom(clip.sourceIn, clip.speed, mediaDur, seq.fps);
  return {
    minStart: Math.max(prev ? clipEnd(prev) : 0, clip.start - handleBefore, 0),
    maxStart: clipEnd(clip) - MIN_CLIP_FRAMES,
    minEnd: clip.start + MIN_CLIP_FRAMES,
    maxEnd: Math.min(next ? next.start : Number.MAX_SAFE_INTEGER, clip.start + maxDur),
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
  const maxEnd = opts.ignoreNeighbors ? clip.start + maxDurationFrom(clip.sourceIn, clip.speed, mediaDur(clip.mediaId), seq.fps) : lim.maxEnd;
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
  const group = linkedClips(seq, loc.clip).filter((c) => c.start === oldStart && !findClip(seq, c.id)!.track.locked);
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
  const group = linkedClips(seq, loc.clip).filter((c) => clipEnd(c) === oldEnd);
  let target = newEnd;
  for (const g of group) {
    const maxEnd = g.start + maxDurationFrom(g.sourceIn, g.speed, mediaDur(g.mediaId), seq.fps);
    target = Math.max(g.start + MIN_CLIP_FRAMES, Math.min(maxEnd, target));
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
  const maxA = a.clip.start + maxDurationFrom(a.clip.sourceIn, a.clip.speed, mediaDur(a.clip.mediaId), seq.fps);
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
  const group = linkedClips(seq, loc.clip);
  let d = deltaFrames;
  for (const g of group) {
    const handleBefore = Math.floor((g.sourceIn / g.speed) * seq.fps.num / seq.fps.den + 1e-6);
    const maxDur = maxDurationFrom(g.sourceIn, g.speed, mediaDur(g.mediaId), seq.fps);
    const handleAfter = maxDur - g.duration;
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
  const prev = track.clips[index - 1];
  const next = track.clips[index + 1];
  let d = deltaFrames;
  // An adjacent neighbour is trimmed to compensate; across a gap the clip may only move within the gap.
  if (prev) {
    const gap = clip.start - clipEnd(prev);
    if (gap === 0) {
      const maxPrevEnd = prev.start + maxDurationFrom(prev.sourceIn, prev.speed, mediaDur(prev.mediaId), seq.fps);
      d = Math.min(d, maxPrevEnd - clipEnd(prev));            // prev can extend this much
      d = Math.max(d, -(prev.duration - MIN_CLIP_FRAMES));    // prev can shrink this much
    } else d = Math.max(d, -gap);
  } else d = Math.max(d, -clip.start);
  if (next) {
    const gap = next.start - clipEnd(clip);
    if (gap === 0) {
      const handleNext = Math.floor((next.sourceIn / next.speed) * seq.fps.num / seq.fps.den + 1e-6);
      d = Math.max(d, -handleNext);                           // next can extend backwards this much
      d = Math.min(d, next.duration - MIN_CLIP_FRAMES);       // next can shrink this much
    } else d = Math.min(d, gap);
  }
  if (d === 0) return 0;
  if (prev && clipEnd(prev) === clip.start) prev.duration += d;
  if (next && next.start === clipEnd(clip)) {
    next.sourceIn = Math.max(0, next.sourceIn + d * seq.fps.den / seq.fps.num * next.speed);
    next.start += d; next.duration -= d;
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

/** Move clips to new positions/tracks. In overwrite mode, destinations are cleared; in insert mode, destinations ripple. */
export function moveClips(seq: Sequence, moves: MoveSpec[], mode: 'overwrite' | 'insert'): boolean {
  const lifted: { clip: Clip; toTrackId: ID; toStart: number; fromTrackId: ID }[] = [];
  for (const m of moves) {
    const loc = findClip(seq, m.clipId);
    const dest = findTrack(seq, m.toTrackId);
    if (!loc || loc.track.locked || !dest || dest.locked || dest.kind !== loc.track.kind) return false;
    lifted.push({ clip: loc.clip, toTrackId: m.toTrackId, toStart: Math.max(0, m.toStart), fromTrackId: loc.track.id });
  }
  // remove from source tracks
  const ids = new Set(lifted.map((l) => l.clip.id));
  for (const t of allTracks(seq)) t.clips = t.clips.filter((c) => !ids.has(c.id));
  if (mode === 'insert') {
    const start = Math.min(...lifted.map((l) => l.toStart));
    const end = Math.max(...lifted.map((l) => l.toStart + l.clip.duration));
    splitTracksAt(seq, allTracks(seq).filter((t) => !t.locked), start);
    rippleShift(seq, start, end - start);
  }
  for (const l of lifted) {
    const t = findTrack(seq, l.toTrackId)!;
    l.clip.start = l.toStart;
    withFps(seq); clearRange(t, l.clip.start, clipEnd(l.clip)); stripFps(seq);
    t.clips.push(l.clip);
    sortTrack(t);
  }
  for (const t of allTracks(seq)) reconcileTransitions(t);
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

export function addTrack(seq: Sequence, kind: 'video' | 'audio'): Track {
  const list = kind === 'video' ? seq.videoTracks : seq.audioTracks;
  const t = makeTrack(kind, list.length + 1);
  t.patched = false;
  list.push(t);
  return t;
}

export function removeTrack(seq: Sequence, trackId: ID): boolean {
  const vi = seq.videoTracks.findIndex((t) => t.id === trackId);
  if (vi >= 0) { if (seq.videoTracks.length <= 1) return false; seq.videoTracks.splice(vi, 1); renameTracks(seq); return true; }
  const ai = seq.audioTracks.findIndex((t) => t.id === trackId);
  if (ai >= 0) { if (seq.audioTracks.length <= 1) return false; seq.audioTracks.splice(ai, 1); renameTracks(seq); return true; }
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
    for (const c of t.clips) { set.add(c.start); set.add(clipEnd(c)); }
  }
  for (const m of seq.markers) set.add(m.time);
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
  seq.markers.sort((a, b) => a.time - b.time);
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
        out.push({ id: cue.id, trackId: st.id, start: cue.start + cue.offset, end: cue.start + cue.duration + cue.offset, text: cue.text, orphan: false });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
