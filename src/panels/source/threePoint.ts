/**
 * Three-point editing: resolve where (sequence frame) and what (source seconds) an Insert / Overwrite edit
 * places, from the sequence In/Out (frames), the playhead and the source In/Out (seconds). Pure, no store.
 *
 * Rules (Premiere):
 *  - target = sequence In when set, else the playhead;
 *  - sequence In + Out and the source lacks an Out → the sequence range sets the duration (source In, or
 *    back-timed from a source Out-only mark);
 *  - sequence Out only (no In) → the edit is back-timed so the material ends at the sequence Out;
 *  - all four points set → source In/Out win at the sequence In; the sequence Out is ignored (note).
 */
import type { Rational } from '@shared/model';
import { framesToSeconds, secondsToFrames } from '@shared/time';
import { maxDurationFrom } from '@shared/timeline';

export interface ThreePointInput {
  /** Sequence frame rate. */
  fps: Rational;
  playhead: number;
  /** Sequence marks (frames, Out exclusive). */
  seqIn: number | null;
  seqOut: number | null;
  /** Source marks (seconds, Out exclusive). */
  srcIn: number | null;
  srcOut: number | null;
  /** Source media length in seconds (Infinity for stills / unknown). */
  mediaDuration: number;
  /** Length (seconds) used when the media has no finite length and no source Out is set (default 5). */
  defaultLength?: number;
}

export type ThreePointNote = 'seqOutIgnored' | 'sourceTooShort' | 'backtimed';

export type ThreePointResult =
  | { ok: true; atFrame: number; inS: number; outS: number; frames: number; notes: ThreePointNote[] }
  | { ok: false; reason: string };

const EPS = 1e-6;

export function resolveThreePointEdit(p: ThreePointInput): ThreePointResult {
  const notes: ThreePointNote[] = [];
  const mediaEnd = Number.isFinite(p.mediaDuration) && p.mediaDuration > 0 ? p.mediaDuration : Infinity;
  const seqRange = p.seqIn !== null && p.seqOut !== null && p.seqOut > p.seqIn ? p.seqOut - p.seqIn : null;
  let inS: number;
  let outS: number;

  if (seqRange !== null && p.srcOut === null) {
    // Sequence range drives the duration.
    const len = framesToSeconds(seqRange, p.fps);
    inS = p.srcIn ?? 0;
    outS = inS + len;
    if (outS > mediaEnd + EPS) { outS = mediaEnd; notes.push('sourceTooShort'); }
  } else if (seqRange !== null && p.srcIn === null && p.srcOut !== null) {
    // Back-time from the source Out over the sequence range.
    const len = framesToSeconds(seqRange, p.fps);
    outS = Math.min(p.srcOut, mediaEnd);
    inS = Math.max(0, outS - len);
    if (outS - inS < len - EPS) notes.push('sourceTooShort');
  } else {
    inS = p.srcIn ?? 0;
    outS = p.srcOut ?? (Number.isFinite(mediaEnd) ? mediaEnd : inS + (p.defaultLength ?? 5));
    if (seqRange !== null) {
      const srcFrames = secondsToFrames(outS - inS, p.fps);
      if (srcFrames !== seqRange) notes.push('seqOutIgnored');
    }
  }
  if (!(outS > inS + EPS)) return { ok: false, reason: 'In/Out range is empty' };
  let frames = Math.max(1, secondsToFrames(outS - inS, p.fps));
  // Rounding may add a frame the media does not have (e.g. the whole clip: 36.7 frames -> 37). The trim
  // limits use whole frames available (floor), so cap there, and snap the Out to that frame so the store,
  // which turns In/Out back into frames, places exactly `frames` and never runs past the media end.
  const fit = maxDurationFrom(inS, 1, mediaEnd, p.fps);
  if (frames > fit) {
    if (fit < 1) return { ok: false, reason: 'In/Out range is shorter than one frame' };
    frames = fit;
    outS = inS + framesToSeconds(frames, p.fps);
  }

  let atFrame: number;
  if (p.seqIn !== null) atFrame = p.seqIn;
  else if (p.seqOut !== null) { atFrame = Math.max(0, p.seqOut - frames); notes.push('backtimed'); }
  else atFrame = p.playhead;
  return { ok: true, atFrame: Math.max(0, Math.round(atFrame)), inS, outS, frames, notes };
}
