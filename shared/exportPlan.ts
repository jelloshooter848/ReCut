/**
 * Pure export planning, shared by the render graph (electron/export/renderGraph.ts) and the Export dialog's
 * checklist (src/panels/export/settings.ts), so the dialog shows before an export exactly what the export does:
 *
 * - which clip segments of a track render in a range (`planTrackSegments`): enabled clips in range, cut by the
 *   previous clip on overlaps, skipped when their media is missing, offline or has no stream of the needed kind;
 * - the source handles a transition gets (`transitionHandles`): it is centered on its cut, so it needs half its
 *   length of source media past the end of the outgoing clip and before the start of the incoming one. Without
 *   enough it is shortened, or dropped (a hard cut);
 * - the range the render graph actually renders (`widenRangeForTransitions`), so no transition is cut by an In/Out
 *   edge.
 *
 * Besides the render graph's warning texts, `planTrackSegments` records what it dropped, shortened or held as data
 * (`TrackPlan.transitions`, `TrackPlan.pastEnd`) for the checklist. No DOM, no Node.
 */
import type { Clip, ID, MediaItem, Sequence, Track, Transition } from './model';
import { clipEnd, sourceTimeAt, SPEED_PERCENT_MAX, SPEED_PERCENT_MIN } from './timeline';

/** Largest source position (seconds) a clip may read from (about 115 days). */
const MAX_SOURCE_SECONDS = 1e7;

/** A still image: the media kind, or a probe with a picture, no duration and no sound. */
export function isImageMedia(m: MediaItem): boolean {
  if (m.kind === 'image') return true;
  const p = m.probe;
  return !!(p && p.video && (!p.duration || p.duration <= 0) && p.audio.length === 0);
}

/** Source length in seconds; Infinity for stills and media whose length is not known. */
export function mediaDurationSec(m: MediaItem): number {
  if (isImageMedia(m)) return Infinity;
  const d = m.probe?.duration;
  return d && d > 0 ? d : Infinity;
}

/** The tracks an export renders: the soloed ones if any, otherwise every track that is not muted. */
export function activeTracks(tracks: Track[]): Track[] {
  const live = tracks.filter((t) => !t.muted);
  const solo = live.filter((t) => t.solo);
  return solo.length ? solo : live;
}

// ---------------------------------------------------------------------------------------------------
// Segment model
// ---------------------------------------------------------------------------------------------------

export interface ClipSeg {
  kind: 'clip';
  clip: Clip;
  media: MediaItem;
  /** Timeline frames relative to range start (before transition extension). */
  start: number;
  frames: number;
  /** Source position (seconds) at `start`. */
  srcStart: number;
  /** Transition handles, in frames. */
  extBefore: number;
  extAfter: number;
  /** Transition INTO this segment from the previous segment (centered on the cut). */
  transIn?: { type: Transition['type']; frames: number };
  /**
   * Fade from black/silence at segment start, in frames (may be fractional): a transition with outClipId null (its
   * length), or the incoming half of a two-sided Dip to Black (half its length; video only).
   */
  fadeIn?: number;
  /** Fade to black/silence at segment end: a transition with inClipId null, or the outgoing half of a Dip to Black. */
  fadeOut?: number;
  isImage: boolean;
  speed: number;
  /** The render graph's ffmpeg input index for the segment (-1 until it assigns one). */
  input: number;
}
export interface GapSeg { kind: 'gap'; frames: number }
export type Seg = ClipSeg | GapSeg;

/**
 * Why a transition between two clips renders shorter than set, or not at all:
 * - `handles`: the source media has too few frames past the outgoing clip's end or before the incoming clip's start;
 * - `clips`: a clip is shorter than half the transition;
 * - `tooShort`: a 1-frame transition (a centered transition renders an even number of frames);
 * - `overlap`: the transitions at both ends of a clip would overlap (the outgoing one is dropped);
 * - `notAdjacent`: the clips are no longer next to each other;
 * - `rangeEdge`: the cut is at the edge of the rendered range;
 * - `replaced`: a later transition on the same cut replaces it (a damaged project can have two).
 */
export type TransitionIssueReason = 'handles' | 'clips' | 'tooShort' | 'overlap' | 'notAdjacent' | 'rangeEdge' | 'replaced';

/**
 * What the export does with a transition between two rendered clips: renders it in full (`reason` null; an odd
 * length renders one frame less), shorter than set (`to` > 0) or not at all (`to` = 0, a hard cut).
 */
export interface TransitionOutcome {
  transition: Transition;
  track: Track;
  outClip: Clip;
  inClip: Clip;
  /** The cut (absolute timeline frame): the end of `outClip`. */
  cut: number;
  /** Set length (frames). */
  from: number;
  /** Frames rendered: 0 when the transition is dropped. */
  to: number;
  /** Why it is shortened or dropped; null when it renders in full. */
  reason: TransitionIssueReason | null;
}

/** A clip segment that needs source media past the end of its media (the last frame is held, the sound is silent). */
export interface PastEndIssue {
  clip: Clip;
  media: MediaItem;
  track: Track;
  /** Source second the segment needs up to, and the media length (seconds). */
  srcEnd: number;
  mediaDur: number;
}

export interface TrackPlan {
  track: Track;
  segs: Seg[];
  /** Every transition of the track's kind between two segments of the plan, in track order. */
  transitions: TransitionOutcome[];
  pastEnd: PastEndIssue[];
}

/** Source handles of a transition between two segments (frames per side of the cut; see `transitionHandles`). */
export interface TransitionHandles {
  /** Handle frames the transition gets on each side: it renders `2h` frames, and is dropped when `h` < 1. */
  h: number;
  /** Limit set by the clips: half the set length, and each segment's length. */
  hClips: number;
  /** Limit set by the source media: the smaller of `handleOut` and `handleIn` (Infinity: unlimited). */
  hSource: number;
  /** Source frames past the end of the outgoing segment (Infinity for stills and media of unknown length). */
  handleOut: number;
  /** Source frames before the start of the incoming segment (Infinity for stills). */
  handleIn: number;
}

/**
 * Handles for a `D`-frame transition centered on the cut between `outSeg` and `inSeg` (`fd` = seconds per sequence
 * frame). A transition renders `2 * floor(D / 2)` frames when nothing limits it (an odd length renders one frame
 * less), `2h` frames when the clips or the source handles limit it, and none when `h` < 1.
 */
export function transitionHandles(
  D: number,
  outSeg: Pick<ClipSeg, 'media' | 'srcStart' | 'frames' | 'speed'>,
  inSeg: Pick<ClipSeg, 'srcStart' | 'frames' | 'speed' | 'isImage'>,
  fd: number,
): TransitionHandles {
  const outDur = mediaDurationSec(outSeg.media);
  const srcOut = outSeg.srcStart + outSeg.frames * fd * outSeg.speed;
  const handleOut = Number.isFinite(outDur) ? Math.floor(((outDur - srcOut) / outSeg.speed) / fd + 1e-6) : Infinity;
  const handleIn = inSeg.isImage ? Infinity : Math.floor((inSeg.srcStart / inSeg.speed) / fd + 1e-6);
  // Centered on the cut: an odd duration renders D - 1 frames (not reported).
  const hClips = Math.min(Math.floor(D / 2), outSeg.frames, inSeg.frames);
  const hSource = Math.min(handleOut, handleIn);
  const h = Math.max(0, Math.min(hClips, hSource));
  return { h, hClips, hSource, handleOut, handleIn };
}

/**
 * The segments a track renders in `[startF, endF)` for one kind of output (`need`), with its transitions laid out
 * (handles, fades) and gaps in between. Problems the export works around are pushed to `warnings` (the texts the
 * export reports) and recorded in `transitions` / `pastEnd`. Throws for a clip the export cannot render at all
 * (speed out of range, invalid source position).
 */
export function planTrackSegments(
  track: Track, seq: Sequence, media: Record<ID, MediaItem>, startF: number, endF: number,
  need: 'video' | 'audio', warnings: string[],
): TrackPlan {
  const fps = seq.fps;
  const fd = fps.den / fps.num;
  const clipSegs: ClipSeg[] = [];
  const transitions: TransitionOutcome[] = [];
  const pastEnd: PastEndIssue[] = [];
  const sorted = track.clips
    .filter((c) => c.enabled && c.start < endF && clipEnd(c) > startF)
    .sort((a, b) => a.start - b.start);
  let cursor = startF;
  for (const clip of sorted) {
    const m = Object.hasOwn(media, clip.mediaId) ? media[clip.mediaId] : undefined; // "constructor" etc. are not media
    if (!m) { warnings.push(`Clip "${clip.name}" on ${track.name}: media is missing from the project; rendered as ${need === 'video' ? 'black' : 'silence'}.`); continue; }
    if (m.offline) { warnings.push(`Clip "${clip.name}" on ${track.name}: media "${m.name}" is offline; rendered as ${need === 'video' ? 'black' : 'silence'}.`); continue; }
    if (need === 'video' && m.probe && !m.probe.video) { warnings.push(`Clip "${clip.name}" on ${track.name}: media "${m.name}" has no video stream; rendered as black.`); continue; }
    if (need === 'audio' && m.probe && m.probe.audio.length === 0) { warnings.push(`Clip "${clip.name}" on ${track.name}: media "${m.name}" has no audio stream; rendered as silence.`); continue; }
    if (need === 'audio' && clip.audio.muted) continue; // muted clip => silence
    let speed = clip.speed;
    if (!(speed > 0) || !Number.isFinite(speed)) { warnings.push(`Clip "${clip.name}": invalid speed ${clip.speed}; using 1.0.`); speed = 1; }
    if (speed < (SPEED_PERCENT_MIN / 100) * (1 - 1e-9) || speed > (SPEED_PERCENT_MAX / 100) * (1 + 1e-9)) {
      throw new Error(`Clip "${clip.name}" on ${track.name}: speed ${speed * 100}% is out of range (${SPEED_PERCENT_MIN}% to ${SPEED_PERCENT_MAX}%). Fix the clip speed and export again.`);
    }
    const segStartAbs = Math.max(clip.start, startF, cursor);
    const segEndAbs = Math.min(clipEnd(clip), endF);
    if (segEndAbs <= segStartAbs) continue;
    if (segStartAbs > Math.max(clip.start, startF)) warnings.push(`Clip "${clip.name}" overlaps the previous clip on ${track.name}; the overlap is trimmed.`);
    const srcStart = sourceTimeAt({ ...clip, speed }, segStartAbs, fps);
    if (!Number.isFinite(srcStart) || Math.abs(srcStart) > MAX_SOURCE_SECONDS) {
      throw new Error(`Clip "${clip.name}" on ${track.name}: source position ${String(clip.sourceIn)} s is not valid. Fix the clip and export again.`);
    }
    const mediaDur = mediaDurationSec(m);
    if (Number.isFinite(mediaDur)) {
      const srcEnd = sourceTimeAt({ ...clip, speed }, segEndAbs, fps);
      if (srcEnd > mediaDur + fd / 2 + 1e-6) {
        warnings.push(`Clip "${clip.name}" on ${track.name} extends past the end of its media "${m.name}" (needs ${srcEnd.toFixed(2)}s, media is ${mediaDur.toFixed(2)}s); ${need === 'video' ? 'the last frame is held' : 'the rest is silent'}.`);
        pastEnd.push({ clip, media: m, track, srcEnd, mediaDur });
      }
    }
    clipSegs.push({
      kind: 'clip', clip, media: m,
      start: segStartAbs - startF, frames: segEndAbs - segStartAbs,
      srcStart,
      extBefore: 0, extAfter: 0, isImage: isImageMedia(m), speed, input: -1,
    });
    cursor = segEndAbs;
  }

  // Transitions (centered on cuts; handles taken from source media).
  const byId = new Map(clipSegs.map((s) => [s.clip.id, s] as const));
  /** Transitions laid out between two segments, by the incoming segment's clip id (for the overlap guard). */
  const into = new Map<ID, TransitionOutcome>();
  for (const tr of track.transitions) {
    const wantAudio = need === 'audio';
    const typeOk = wantAudio ? (tr.type === 'audioCrossfade' || tr.type === 'crossDissolve') : (tr.type === 'crossDissolve' || tr.type === 'dipToBlack');
    if (!typeOk) continue;
    const D = Math.max(0, Math.round(tr.duration));
    if (!Number.isFinite(D) || D <= 0) continue;
    const outSeg = tr.outClipId ? byId.get(tr.outClipId) : undefined;
    const inSeg = tr.inClipId ? byId.get(tr.inClipId) : undefined;
    if (tr.outClipId && tr.inClipId) {
      if (!outSeg || !inSeg) { continue; } // one side skipped/out of range -> hard cut (already warned if media problem)
      const cutAbs = clipEnd(outSeg.clip);
      const outcome = (to: number, reason: TransitionIssueReason | null): TransitionOutcome => ({ transition: tr, track, outClip: outSeg.clip, inClip: inSeg.clip, cut: cutAbs, from: D, to, reason });
      if (inSeg.clip.start !== cutAbs) {
        warnings.push(`Transition between "${outSeg.clip.name}" and "${inSeg.clip.name}" is not on an adjacent cut; ignored.`);
        transitions.push(outcome(0, 'notAdjacent'));
        continue;
      }
      const cut = cutAbs - startF;
      if (outSeg.start + outSeg.frames !== cut || inSeg.start !== cut) {
        warnings.push(`Transition at the edge of the export range is dropped (hard cut).`);
        transitions.push(outcome(0, 'rangeEdge'));
        continue;
      }
      if (tr.type === 'dipToBlack') {
        // The preview's dip (src/playback/planner.ts contribute): the outgoing clip fades to black over its last D / 2
        // frames, the incoming one from black over its first D / 2, each on frames it shows anyway. No handles, so
        // it is never shortened. The render graph multiplies these weights into the alpha (fadeWeights).
        transitions.push(outcome(D, null));
        outSeg.fadeOut = D / 2;
        inSeg.fadeIn = D / 2;
        continue;
      }
      const { h, hClips, hSource } = transitionHandles(D, outSeg, inSeg, fd);
      const names = `"${outSeg.clip.name}" and "${inSeg.clip.name}"`;
      if (h < 1) {
        warnings.push(`Transition between ${names} dropped: ${hSource < 1 ? 'not enough source handles' : 'too short to render'}.`);
        transitions.push(outcome(0, hSource < 1 ? 'handles' : 'tooShort'));
        continue;
      }
      const shortened = h < Math.floor(D / 2);
      if (shortened) {
        warnings.push(`Transition between ${names} shortened from ${D} to ${2 * h} frames (${hSource < hClips ? 'source handles' : 'the clips are shorter than the transition'}).`);
      }
      const laid = outcome(2 * h, shortened ? (hSource < hClips ? 'handles' : 'clips') : null);
      transitions.push(laid);
      const replaced = into.get(inSeg.clip.id);
      if (replaced) { replaced.to = 0; replaced.reason = 'replaced'; }
      into.set(inSeg.clip.id, laid);
      outSeg.extAfter = h;
      inSeg.extBefore = h;
      inSeg.transIn = { type: tr.type, frames: 2 * h };
    } else if (inSeg && !tr.outClipId) {
      if (inSeg.start + startF !== inSeg.clip.start) continue; // clip start is outside range
      inSeg.fadeIn = Math.min(D, inSeg.frames);
    } else if (outSeg && !tr.inClipId) {
      if (outSeg.start + outSeg.frames + startF !== clipEnd(outSeg.clip)) continue;
      outSeg.fadeOut = Math.min(D, outSeg.frames);
    }
  }
  // Guard: a clip cannot carry overlapping transitions on both ends.
  for (let i = 0; i < clipSegs.length; i++) {
    const s = clipSegs[i];
    if (s.extBefore + s.extAfter > s.frames) {
      const next = clipSegs[i + 1];
      warnings.push(`Transitions on both sides of "${s.clip.name}" overlap; the outgoing transition is dropped.`);
      s.extAfter = 0;
      if (next) {
        const laid = next.transIn ? into.get(next.clip.id) : undefined;
        if (laid) { laid.to = 0; laid.reason = 'overlap'; }
        next.extBefore = 0; next.transIn = undefined;
      }
    }
  }

  // Interleave gaps so the track covers the whole range.
  const total = endF - startF;
  const segs: Seg[] = [];
  let pos = 0;
  for (const s of clipSegs) {
    if (s.start > pos) segs.push({ kind: 'gap', frames: s.start - pos });
    segs.push(s);
    pos = s.start + s.frames;
  }
  if (pos < total) segs.push({ kind: 'gap', frames: total - pos });
  return { track, segs, transitions, pastEnd };
}

/**
 * Widens `[startF, endF)` so it never starts or ends inside a transition window (D2). A transition is laid out
 * on the full timeline (centered on its cut, its length limited by the clips and their handles); a range edge
 * inside it would shorten it, turn it into a hard cut or restart a fade. The render graph renders the widened range
 * and trims the composite back to `[startF, endF)`, so the frames are the full export's. Windows are the ones
 * electron/export/chunks.ts never puts a chunk boundary in (only the export range edges can be inside one).
 */
export function widenRangeForTransitions(seq: Sequence, startF: number, endF: number): { startF: number; endF: number } {
  const windows: [number, number][] = [];
  for (const t of [...activeTracks(seq.videoTracks), ...activeTracks(seq.audioTracks)]) {
    const byId = new Map(t.clips.filter((c) => c.enabled).map((c) => [c.id, c] as const));
    for (const tr of t.transitions) {
      const D = Math.max(0, Math.round(tr.duration));
      if (!Number.isFinite(D) || D <= 0) continue;
      const outC = tr.outClipId ? byId.get(tr.outClipId) : undefined;
      const inC = tr.inClipId ? byId.get(tr.inClipId) : undefined;
      const h = Math.ceil(D / 2);
      if (outC && inC) {
        const cut = clipEnd(outC);
        windows.push([cut - Math.min(h, outC.duration), cut + Math.min(h, inC.duration)]);
      } else if (inC && !tr.outClipId) {
        windows.push([inC.start, inC.start + Math.min(D, inC.duration)]);
      } else if (outC && !tr.inClipId) {
        windows.push([clipEnd(outC) - Math.min(D, outC.duration), clipEnd(outC)]);
      }
    }
  }
  let s = startF, e = endF, changed = true;
  while (changed) {
    changed = false;
    for (const [lo, hi] of windows) {
      if (lo < s && s < hi) { s = Math.max(0, lo); changed = true; }
      if (lo < e && e < hi) { e = hi; changed = true; }
    }
  }
  return { startF: s, endF: e };
}
