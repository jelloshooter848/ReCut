/**
 * Pure frame-composition planner for the Program Monitor.
 *
 * Given a sequence, its media and a timeline frame, returns the list of video layers to draw
 * (bottom -> top) and audio sources to mix, with transition alphas/gains already applied.
 * No DOM, no side effects: it is unit tested in node and drives SequencePlayer every frame.
 *
 * Transition model (matches the editor's "centered on the cut" convention):
 *  - crossDissolve between two clips: 2h = 2 * floor(D / 2) frames centered on the cut (an odd length renders one
 *    frame less, as the export does); t = k / 2h on frame k of the window. The outgoing clip has weight (1 - t) and is
 *    extended past its out point by h (handle frames); the incoming has weight t, is extended before its in point by
 *    h and carries `mixWith` (the outgoing clip): the compositor adds the pair, so the picture is the linear mix
 *    (1 - t) * out + t * in over what is below (see LayerPlan.mixWith), like the export's dissolve.
 *  - dipToBlack between two clips: outgoing fades to black over the first half (before the cut),
 *    incoming fades from black over the second half (after the cut), D / 2 frames each, weights
 *    (end - frame) / (D / 2) and (frame - start) / (D / 2). No handles needed.
 *  - Single-sided transitions (outClipId or inClipId null) fade from/to black over D frames that lie
 *    entirely inside the clip (there is nothing to extend into on the other side).
 *  - audioCrossfade follows the crossDissolve geometry with gains instead of alphas.
 */
import type { Clip, ClipTransform, ID, MediaItem, Rational, Sequence, Track, Transition } from '../../shared/model';
import { clipEnd, sourceTimeAt } from '../../shared/timeline';
import { envelopeAt } from '../../shared/nest';
import { evaluateClipProperty, hasTransformKeyframes, hasVolumeKeyframes, transformAt } from '../../shared/keyframes';
import { audioTrackOrdinal, channelProxyPendingReason, clipChannelProxy, mediaFps, mediaSize, mediaTimeOffset, previewUpmixGain, proxyAudioStreams, resolveAudioStream, resolvePlaybackPath, previewPlayable } from './mediaSource';

export interface LayerPlan {
  clipId: ID;
  mediaId: ID;
  path: string;
  usingProxy: boolean;
  /** Source time in media seconds (not yet frame-centered). */
  sourceTime: number;
  /** Final alpha including clip opacity and transition ramp (0..1). */
  alpha: number;
  /** The clip's transform at this frame: keyframed position / scale / opacity already evaluated (shared/keyframes.ts). */
  transform: ClipTransform;
  /** Position, scale or opacity is keyframed: the picture can change from frame to frame with the same media frame. */
  animated?: boolean;
  /**
   * Cross Dissolve: set on the incoming clip's layer while the outgoing clip (this id, on the same track) is in the
   * window too. The two layers are composited as a pair: their pictures, weighted by their alphas, are added (in
   * premultiplied terms, `lighter`) and the sum is drawn over what is below. With alphas (1 - t) * a and t * b that
   * is the linear mix (1 - t) * (out over below) + t * (in over below), with no dip in brightness mid-dissolve; the
   * export mixes the same way (premultiply, xfade, unpremultiply). See `mixesWith`.
   */
  mixWith?: ID;
  /** Index into seq.videoTracks (0 = bottom). */
  trackIndex: number;
  /** Seconds added to sourceTime to get the element's currentTime (container start of an original; 0 for proxies). */
  timeOffset: number;
  /** Media frame rate, for frame-centering seeks. */
  mediaFps: Rational;
  /** Probed media size (null when unknown; the player falls back to the element's videoWidth/Height). */
  mediaSize: { width: number; height: number } | null;
  /** Playback speed multiplier of the clip (source seconds per timeline second). */
  speed: number;
  /** True when the frame lies outside the clip's own range (transition handle). */
  handle: boolean;
  /** Still image: draw `path` with an <img> (sourceTime / speed are irrelevant). */
  isImage: boolean;
}

export interface AudioPlan {
  clipId: ID;
  mediaId: ID;
  trackId: ID;
  path: string;
  usingProxy: boolean;
  sourceTime: number;
  /** Seconds added to sourceTime to get the element's currentTime (container start of an original; 0 for proxies). */
  timeOffset: number;
  /**
   * Linear gain: 10^(gain/20) * volume * fade envelope * transition gain * previewUpmixGain (1/sqrt(2) for a mono
   * stream played directly, as the export up-mixes it) (track volume NOT included).
   */
  gain: number;
  /** Track volume (linear) so the player can keep a per-track GainNode. */
  trackVolume: number;
  /**
   * Only for a clip with level keyframes: the same gain at any (fractional) timeline frame, with this frame's
   * transition gain, so the player can ramp between frames like the export's per-sample-block evaluation.
   */
  gainAt?: (frame: number) => number;
  speed: number;
  /** Absolute index of the source audio stream played: the one the export renders (clip's, else the media's). */
  audioStream?: number;
  /**
   * Index into the element's audioTracks of that stream (see audioTrackOrdinal); -1 = keep the default track (the
   * file has one audio track, or nothing is known).
   */
  audioTrack: number;
  handle: boolean;
}

export interface MissingMedia {
  clipId: ID; mediaId: ID; reason: string;
  /** The clip's channel selection waits for its preview audio (a channel proxy, Roadmap §9). */
  channelProxy?: boolean;
}

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

/**
 * A clip's linear gain at a (possibly fractional) timeline frame: clip gain (dB) × level (keyframed or static) × fade
 * envelope × transition weight × `extra` (the preview's mono up-mix). The export multiplies the same factors.
 */
export function clipGain(clip: Clip, frame: number, weight: number, extra: number): number {
  const level = clip.audio.keyframes ? evaluateClipProperty('volume', clip, frame) : clip.audio.volume;
  return dbToLinear(clip.audio.gain) * Math.max(0, level) * fadeEnvelope(clip, frame) * weight * extra;
}

const NO_CURVE: { gainAt?: (frame: number) => number } = Object.freeze({});
/** `{ gainAt }` for a clip with level keyframes (see AudioPlan.gainAt), else nothing. */
function gainCurve(clip: Clip, weight: number, extra: number): { gainAt?: (frame: number) => number } {
  if (!clip.audio.keyframes || !hasVolumeKeyframes(clip)) return NO_CURVE;
  return { gainAt: (f: number) => clipGain(clip, f, weight, extra) };
}

interface Contribution { clip: Clip; weight: number; handle: boolean; mixWith?: ID }

/**
 * Whether `next` is the incoming layer of a Cross Dissolve whose outgoing layer is `prev` (drawn just before it): the
 * compositor then adds the two (LayerPlan.mixWith) instead of drawing `next` over `prev`.
 */
export function mixesWith(prev: LayerPlan, next: LayerPlan): boolean {
  return next.mixWith !== undefined && next.mixWith === prev.clipId && next.trackIndex === prev.trackIndex;
}

interface TrackIndex {
  /** Clips are sorted by start (the normal case); otherwise fall back to a linear scan. */
  sorted: boolean;
  starts: number[];
  /** maxEnd[i] = max clipEnd over clips[0..i] (non-decreasing; handles overlapping clips). */
  maxEnd: number[];
  /** How far (frames) a transition can make a clip contribute outside its own range. */
  reach: number;
  trIn: Map<ID, Transition>;
  trOut: Map<ID, Transition>;
}

/** Per-track lookup structures, cached per (immutable) track object. */
const trackIndexCache = new WeakMap<Track, TrackIndex>();

function trackIndex(track: Track): TrackIndex {
  let idx = trackIndexCache.get(track);
  if (idx) return idx;
  const clips = track.clips;
  const starts = new Array<number>(clips.length);
  const maxEnd = new Array<number>(clips.length);
  let sorted = true, m = -Infinity;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    starts[i] = c.start;
    if (i > 0 && c.start < starts[i - 1]) sorted = false;
    m = Math.max(m, clipEnd(c));
    maxEnd[i] = m;
  }
  const trIn = new Map<ID, Transition>(), trOut = new Map<ID, Transition>();
  let reach = 0;
  for (const t of track.transitions) {
    // First match wins, like Array.find in transitionsForClip.
    if (t.inClipId && !trIn.has(t.inClipId)) trIn.set(t.inClipId, t);
    if (t.outClipId && !trOut.has(t.outClipId)) trOut.set(t.outClipId, t);
    reach = Math.max(reach, Math.ceil(Math.max(1, t.duration)));
  }
  idx = { sorted, starts, maxEnd, reach, trIn, trOut };
  trackIndexCache.set(track, idx);
  return idx;
}

/** Index of the first element of sorted `a` greater than `v`. */
function upperBound(a: number[], v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] <= v) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * For one track, compute which clips contribute at `frame` and with what transition weight (0..1).
 * A clip may contribute while the frame is outside its range (crossDissolve handles).
 * Binary-searches the (sorted) clips instead of scanning the whole track every frame.
 */
export function contributionsAt(track: Track, frame: number): Contribution[] {
  const out: Contribution[] = [];
  const idx = trackIndex(track);
  const clips = track.clips;
  if (!idx.sorted) {
    for (const clip of clips) contribute(idx, clip, frame, out);
    return out;
  }
  // Candidates: start <= frame + reach, and (some clip up to here) end + reach > frame.
  const hi = upperBound(idx.starts, frame + idx.reach) - 1;
  let lo = hi;
  while (lo >= 0 && idx.maxEnd[lo] + idx.reach > frame) lo--;
  for (let i = lo + 1; i <= hi; i++) contribute(idx, clips[i], frame, out);
  return out;
}

function contribute(idx: TrackIndex, clip: Clip, frame: number, out: Contribution[]): void {
  if (!clip.enabled) return;
  const start = clip.start;
  const end = clipEnd(clip);
  const trIn = idx.trIn.get(clip.id);
  const trOut = idx.trOut.get(clip.id);
  let weight = 1;
  let inside = frame >= start && frame < end;
  let handle = false;
  let mixWith: ID | undefined;

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
      // crossDissolve / audioCrossfade: centered, 2h frames (h = floor(D / 2), as the export), t = 0 at start - h
      const h = Math.floor(D / 2);
      if (h >= 1 && frame >= start - h && frame < start + h) {
        const t = (frame - (start - h)) / (2 * h);
        weight *= t;
        mixWith = trIn.outClipId;
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
      const h = Math.floor(D / 2);
      if (h >= 1 && frame >= end - h && frame < end + h) {
        const t = (frame - (end - h)) / (2 * h);
        weight *= 1 - t;
        if (!inside) { inside = true; handle = true; }
      }
    }
  }
  if (!inside) return;
  // Ramps of a flattened nested sequence (shared/nest.ts): transitions at a nested clip's edges, moved fades.
  weight *= envelopeAt(clip, frame);
  out.push(mixWith === undefined ? { clip, weight: clamp01(weight), handle } : { clip, weight: clamp01(weight), handle, mixWith });
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
    for (const { clip, weight, handle, mixWith } of contributionsAt(track, frame)) {
      const m = media[clip.mediaId];
      if (!m) { report(clip, 'media not in project'); continue; }
      const res = resolvePlaybackPath(m, useProxies);
      if (!res.path) { report(clip, res.reason ?? 'not playable'); continue; }
      // Keyframes (Roadmap §11): only a clip that has them pays for the evaluation.
      const animated = clip.transform.keyframes !== undefined && hasTransformKeyframes(clip);
      const transform = animated ? transformAt(clip, frame) : clip.transform;
      // Zero-alpha layers are kept so the element is acquired and pre-rolled before it fades in.
      const alpha = clamp01(transform.opacity) * weight;
      layers.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        path: res.path,
        usingProxy: res.usingProxy,
        sourceTime: sourceTimeAt(clip, frame, fps),
        timeOffset: res.timeOffset ?? 0,
        alpha,
        transform,
        ...(animated ? { animated } : null),
        ...(mixWith !== undefined ? { mixWith } : null),
        trackIndex: index,
        mediaFps: mediaFps(m),
        mediaSize: mediaSize(m),
        speed: clip.speed,
        handle,
        isImage: res.isImage === true,
      });
    }
  }

  for (const { track } of activeTracks(seq.audioTracks)) {
    for (const { clip, weight, handle } of contributionsAt(track, frame)) {
      if (clip.audio.muted) continue;
      const m = media[clip.mediaId];
      if (!m) { report(clip, 'media not in project'); continue; }
      // A channel selection (one channel, or a controlled downmix) plays its channel proxy, made from the original
      // with the export's pan filter, whatever the media proxy is; silent until it is ready, like a pending proxy.
      const ch = clip.audio.channelSelection ? clipChannelProxy(m, clip) : null;
      if (ch) {
        if (m.offline) { report(clip, 'media offline'); continue; }
        if (ch.info?.status !== 'ready' || !ch.info.path) {
          if (!reported.has(clip.id)) { reported.add(clip.id); missing.push({ clipId: clip.id, mediaId: clip.mediaId, reason: channelProxyPendingReason(ch), channelProxy: true }); }
          continue;
        }
        audio.push({
          clipId: clip.id, mediaId: clip.mediaId, trackId: track.id, path: ch.info.path, usingProxy: true,
          sourceTime: sourceTimeAt(clip, frame, fps), timeOffset: 0,
          gain: clipGain(clip, frame, weight, 1),
          trackVolume: Math.max(0, track.volume), speed: clip.speed, audioStream: ch.stream, audioTrack: -1, handle,
          ...gainCurve(clip, weight, 1),
        });
        continue;
      }
      const res = resolvePlaybackPath(m, useProxies);
      if (res.isImage) continue; // still images are silent
      if (!res.path) { report(clip, res.reason ?? 'not playable'); continue; }
      const stream = resolveAudioStream(m, clip.audioStream ?? m.preferredAudioStream);
      let { path, usingProxy } = res;
      let timeOffset = res.timeOffset ?? 0;
      // An older single-stream proxy without the clip's stream: play the original when the browser can decode it.
      if (usingProxy && stream !== null && previewPlayable(m) && m.probe && m.probe.audio.length > 1 && !proxyAudioStreams(m).includes(stream)) {
        path = m.path; usingProxy = false; timeOffset = mediaTimeOffset(m, false);
      }
      // A mono stream played directly is up-mixed to stereo at unity by Web Audio, at -3 dB by the export: match it.
      const upmix = previewUpmixGain(m, usingProxy, stream);
      const gain = clipGain(clip, frame, weight, upmix);
      audio.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        trackId: track.id,
        path,
        usingProxy,
        sourceTime: sourceTimeAt(clip, frame, fps),
        timeOffset,
        gain,
        trackVolume: Math.max(0, track.volume),
        speed: clip.speed,
        audioStream: stream ?? undefined,
        audioTrack: audioTrackOrdinal(m, usingProxy, stream ?? undefined),
        handle,
        ...gainCurve(clip, weight, upmix),
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
