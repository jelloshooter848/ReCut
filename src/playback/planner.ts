/**
 * Pure frame-composition planner for the Program Monitor.
 *
 * Given a sequence, its media and a timeline frame, returns the list of video layers to draw
 * (bottom -> top) and audio sources to mix, with transition alphas/gains already applied.
 * No DOM, no side effects: it is unit tested in node and drives SequencePlayer every frame.
 *
 * Transition model (matches the editor's "centered on the cut" convention):
 *  - crossDissolve between two clips: D frames centered on the cut; t goes 0 -> 1 across D.
 *    Outgoing drawn at alpha (1 - t) and extended past its out point by D/2 (handle frames);
 *    incoming drawn at alpha t and extended before its in point by D/2.
 *  - dipToBlack between two clips: outgoing fades to black over the first half (before the cut),
 *    incoming fades from black over the second half (after the cut). No handles needed.
 *  - Single-sided transitions (outClipId or inClipId null) fade from/to black over D frames that lie
 *    entirely inside the clip (there is nothing to extend into on the other side).
 *  - audioCrossfade follows the crossDissolve geometry with gains instead of alphas.
 */
import type { Clip, ClipTransform, ID, MediaItem, Rational, Sequence, Track, Transition } from '../../shared/model';
import { clipEnd, sourceTimeAt, transitionsForClip } from '../../shared/timeline';
import { resolvePlaybackPath, mediaFps, mediaSize } from './mediaSource';

export interface LayerPlan {
  clipId: ID;
  mediaId: ID;
  path: string;
  usingProxy: boolean;
  /** Source time in media seconds (not yet frame-centered). */
  sourceTime: number;
  /** Final alpha including clip opacity and transition ramp (0..1). */
  alpha: number;
  transform: ClipTransform;
  /** Index into seq.videoTracks (0 = bottom). */
  trackIndex: number;
  /** Media frame rate, for frame-centering seeks. */
  mediaFps: Rational;
  /** Probed media size (null when unknown; the player falls back to the element's videoWidth/Height). */
  mediaSize: { width: number; height: number } | null;
  /** Playback speed multiplier of the clip (source seconds per timeline second). */
  speed: number;
  /** True when the frame lies outside the clip's own range (transition handle). */
  handle: boolean;
}

export interface AudioPlan {
  clipId: ID;
  mediaId: ID;
  trackId: ID;
  path: string;
  usingProxy: boolean;
  sourceTime: number;
  /** Linear gain: 10^(gain/20) * volume * fade envelope * transition gain (track volume NOT included). */
  gain: number;
  /** Track volume (linear) so the player can keep a per-track GainNode. */
  trackVolume: number;
  speed: number;
  audioStream?: number;
  handle: boolean;
}

export interface MissingMedia { clipId: ID; mediaId: ID; reason: string }

export interface FramePlan {
  frame: number;
  layers: LayerPlan[];
  audio: AudioPlan[];
  missing: MissingMedia[];
}

/** Tracks that are audible/visible: solo wins over mute; otherwise every unmuted track. */
export function activeTracks(tracks: Track[]): { track: Track; index: number }[] {
  const anySolo = tracks.some((t) => t.solo);
  const out: { track: Track; index: number }[] = [];
  tracks.forEach((track, index) => {
    if (anySolo ? track.solo : !track.muted) out.push({ track, index });
  });
  return out;
}

export function dbToLinear(db: number): number { return Math.pow(10, db / 20); }

/** Linear fade in/out envelope of a clip at a frame (1 when outside any fade). */
export function fadeEnvelope(clip: Clip, frame: number): number {
  let env = 1;
  const { fadeIn, fadeOut } = clip.audio;
  if (fadeIn > 0) env *= clamp01((frame - clip.start) / fadeIn);
  if (fadeOut > 0) env *= clamp01((clipEnd(clip) - frame) / fadeOut);
  return env;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

interface Contribution { clip: Clip; weight: number; handle: boolean }

/**
 * For one track, compute which clips contribute at `frame` and with what transition weight (0..1).
 * A clip may contribute while the frame is outside its range (crossDissolve handles).
 */
export function contributionsAt(track: Track, frame: number): Contribution[] {
  const out: Contribution[] = [];
  for (const clip of track.clips) {
    if (!clip.enabled) continue;
    const start = clip.start;
    const end = clipEnd(clip);
    const { in: trIn, out: trOut } = transitionsForClip(track, clip.id);
    let weight = 1;
    let inside = frame >= start && frame < end;
    let handle = false;

    // Transition at the clip's start (this clip is the incoming side).
    if (trIn) {
      const D = Math.max(1, trIn.duration);
      if (trIn.outClipId === null) {
        // from black over D frames inside the clip
        if (inside && frame < start + D) weight *= (frame - start) / D;
      } else if (trIn.type === 'dipToBlack') {
        const half = D / 2;
        if (inside && frame < start + half) weight *= (frame - start) / half;
      } else {
        // crossDissolve / audioCrossfade: centered, t = 0 at start - D/2, 1 at start + D/2
        const half = D / 2;
        if (frame >= start - half && frame < start + half) {
          const t = (frame - (start - half)) / D;
          weight *= t;
          if (!inside) { inside = true; handle = true; }
        }
      }
    }
    // Transition at the clip's end (this clip is the outgoing side).
    if (trOut) {
      const D = Math.max(1, trOut.duration);
      if (trOut.inClipId === null) {
        if (inside && frame >= end - D) weight *= (end - frame) / D;
      } else if (trOut.type === 'dipToBlack') {
        const half = D / 2;
        if (inside && frame >= end - half) weight *= (end - frame) / half;
      } else {
        const half = D / 2;
        if (frame >= end - half && frame < end + half) {
          const t = (frame - (end - half)) / D;
          weight *= 1 - t;
          if (!inside) { inside = true; handle = true; }
        }
      }
    }
    if (!inside) continue;
    out.push({ clip, weight: clamp01(weight), handle });
  }
  return out;
}

/** Build the composition plan for one timeline frame. */
export function planFrame(seq: Sequence, media: Record<ID, MediaItem>, frame: number, useProxies: boolean): FramePlan {
  const fps = seq.fps;
  const layers: LayerPlan[] = [];
  const audio: AudioPlan[] = [];
  const missing: MissingMedia[] = [];
  const reported = new Set<ID>();
  const report = (clip: Clip, reason: string) => {
    if (reported.has(clip.id)) return;
    reported.add(clip.id);
    missing.push({ clipId: clip.id, mediaId: clip.mediaId, reason });
  };

  for (const { track, index } of activeTracks(seq.videoTracks)) {
    for (const { clip, weight, handle } of contributionsAt(track, frame)) {
      const m = media[clip.mediaId];
      if (!m) { report(clip, 'media not in project'); continue; }
      const res = resolvePlaybackPath(m, useProxies);
      if (!res.path) { report(clip, res.reason ?? 'not playable'); continue; }
      // Zero-alpha layers are kept so the element is acquired and pre-rolled before it fades in.
      const alpha = clamp01(clip.transform.opacity) * weight;
      layers.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        path: res.path,
        usingProxy: res.usingProxy,
        sourceTime: sourceTimeAt(clip, frame, fps),
        alpha,
        transform: clip.transform,
        trackIndex: index,
        mediaFps: mediaFps(m),
        mediaSize: mediaSize(m),
        speed: clip.speed,
        handle,
      });
    }
  }

  for (const { track } of activeTracks(seq.audioTracks)) {
    for (const { clip, weight, handle } of contributionsAt(track, frame)) {
      if (clip.audio.muted) continue;
      const m = media[clip.mediaId];
      if (!m) { report(clip, 'media not in project'); continue; }
      const res = resolvePlaybackPath(m, useProxies);
      if (!res.path) { report(clip, res.reason ?? 'not playable'); continue; }
      const gain = dbToLinear(clip.audio.gain) * Math.max(0, clip.audio.volume) * fadeEnvelope(clip, frame) * weight;
      audio.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        trackId: track.id,
        path: res.path,
        usingProxy: res.usingProxy,
        sourceTime: sourceTimeAt(clip, frame, fps),
        gain,
        trackVolume: Math.max(0, track.volume),
        speed: clip.speed,
        audioStream: clip.audioStream,
        handle,
      });
    }
  }

  return { frame, layers, audio, missing };
}

/** Convenience: transitions relevant to a track at a frame (used by the UI for overlays). */
export function transitionAt(track: Track, frame: number): Transition | undefined {
  for (const tr of track.transitions) {
    const outClip = tr.outClipId ? track.clips.find((c) => c.id === tr.outClipId) : undefined;
    const inClip = tr.inClipId ? track.clips.find((c) => c.id === tr.inClipId) : undefined;
    const cut = outClip ? clipEnd(outClip) : inClip ? inClip.start : null;
    if (cut === null) continue;
    const half = tr.duration / 2;
    if (frame >= cut - half && frame < cut + half) return tr;
  }
  return undefined;
}
