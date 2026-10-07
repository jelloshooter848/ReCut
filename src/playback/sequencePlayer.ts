/**
 * Program Monitor compositor.
 *
 * Every rendered frame: planFrame() -> acquire pooled <video> elements for the active clips ->
 * keep them at the right source time (native playback at forward rates <= 4, seek-stepping
 * otherwise) -> composite onto the canvas bottom to top with clip transforms and transition
 * alphas -> mix audio through WebAudio gain nodes.
 *
 * Scrubbing (paused, the playhead moved less than SCRUB_REST_MS ago) does only what can be shown: it seeks just the
 * video layers composited at the playhead (not occluded layers, not the silent audio), never queues a seek behind a
 * pending one (a scrub "round" waits for its seeks, draws the frame they landed on, then seeks on to the latest
 * playhead), and draws only when the picture changes. Once the playhead rests, every element is parked at the
 * playhead as before, so the picture is exactly the playhead frame and playback starts from the same state.
 *
 * The canvas internal resolution is the sequence size scaled by `playbackResolution`; CSS sizing
 * is the caller's responsibility.
 */
import type { ID, MediaItem, Rational, Sequence, VideoStreamInfo } from '../../shared/model';
import { secondsToFramesFloor, framesToSeconds, fpsValue } from '../../shared/time';
import { sequenceDuration, resolveSubtitleCues, type ResolvedCue } from '../../shared/timeline';
import { PlaybackClock } from './clock';
import { MediaElementPool, poolKey } from './elementPool';
import { planFrame, type FramePlan, type LayerPlan, type AudioPlan, type MissingMedia } from './planner';
import { clampElementTime, toElementTime } from './mediaSource';
import { selectAudioTrack } from './audioTracks';
import { pathToMediaUrl } from '../../shared/ipc';
import { videoDisplaySize } from '../../shared/media';

/**
 * Display size of a probed video stream, as Chromium reports it in videoWidth / videoHeight: the storage size
 * stretched by the sample aspect ratio (wider for SAR > 1, taller for SAR < 1; width / height are already the
 * rotated axes, and SAR stretches the storage x axis). A missing or insane stored SAR counts as square.
 * Null when the size is unknown. (shared/media.ts videoDisplaySize, 'element' mode.)
 */
export function probedDisplaySize(v: VideoStreamInfo | undefined): { width: number; height: number } | null {
  return videoDisplaySize(v, 'element');
}

/** Decoded still images shared by every player, keyed by file path (LRU-capped). */
const IMAGE_CACHE_CAP = 64;
const imageCache = new Map<string, { img: HTMLImageElement; error: string | null; waiters: Set<() => void> }>();

/** Get (or start loading) the cached <img> for a still-image path; `onReady` fires once when it loads or fails. */
export function getStillImage(path: string, onReady?: () => void): { img: HTMLImageElement; error: string | null } {
  let entry = imageCache.get(path);
  if (entry) {
    imageCache.delete(path); imageCache.set(path, entry); // LRU bump
  } else {
    const img = new Image();
    img.decoding = 'async';
    const e: { img: HTMLImageElement; error: string | null; waiters: Set<() => void> } = { img, error: null, waiters: new Set() };
    const flush = () => { const w = [...e.waiters]; e.waiters.clear(); for (const cb of w) cb(); };
    img.onload = flush;
    img.onerror = () => { e.error = 'image could not be decoded'; flush(); };
    img.src = pathToMediaUrl(path);
    imageCache.set(path, e);
    entry = e;
    while (imageCache.size > IMAGE_CACHE_CAP) imageCache.delete(imageCache.keys().next().value as string);
  }
  if (onReady && !entry.img.complete && !entry.error) entry.waiters.add(onReady);
  return entry;
}

/** Drop a cached still image (relink / file replaced). */
export function forgetStillImage(path: string): void { imageCache.delete(path); }

export interface SequencePlayerSettings {
  useProxies: boolean;
  playbackResolution: 'full' | '1/2' | '1/4';
}

export interface SequencePlayerOptions {
  /** Draw subtitle cues on the canvas (white text, black outline, bottom-center). Default true. */
  drawSubtitles?: boolean;
  /** Share a clock with another player (see SyncGroup). */
  clock?: PlaybackClock;
  /** Distinguishes element roles when two players share a pool. Defaults to a unique counter. */
  id?: string;
}

export interface SequencePlayerState {
  playing: boolean;
  rate: number;
  frame: number;
  durationFrames: number;
  loop: { inF: number; outF: number } | null;
}

/** Native element playback is used for forward rates up to this; beyond it (and in reverse) we seek-step. */
export const MAX_NATIVE_RATE = 4;
/** Re-seek a playing element when it drifts further than this from its target (seconds). */
export const DRIFT_TOLERANCE = 0.08;
/** While paused, a playhead move less than this long ago (ms) means the user is scrubbing (see scrubTick). */
export const SCRUB_REST_MS = 150;
/** Look-ahead of the gain ramp of a clip with level keyframes (seconds of wall time; re-anchored every tick). */
export const KEYFRAME_RAMP_SEC = 0.05;

const RESOLUTION_FACTOR: Record<SequencePlayerSettings['playbackResolution'], number> = { full: 1, '1/2': 0.5, '1/4': 0.25 };

let playerCounter = 0;

/**
 * Role prefix of a pooled element: the kind, plus the audio track for an element that plays a chosen track of a
 * multi-stream file (`audio:s<N>`). An element is dedicated to its track: a clip on another stream of the same file
 * gets another element rather than switching this one mid-play (see audioTracks.ts).
 */
export function slotBase(kind: 'video' | 'audio', audioTrack?: number): string {
  return kind === 'audio' && audioTrack !== undefined && audioTrack >= 0 ? `audio:s${audioTrack}` : kind;
}

/**
 * A pooled element lent to one clip. Elements are pooled per (path, kind, slot), not per clip: when a clip leaves the
 * plan its slot is free, and the next clip on the same file reuses the already-loaded element (one seek instead of a
 * new <video>, a new decoder and, for audio, a new MediaElementAudioSourceNode). Slot `k` is the k-th element of that
 * file in use at one frame (two clips of one file overlap only in transitions or on stacked tracks).
 */
interface Slot<E extends HTMLMediaElement = HTMLMediaElement> {
  el: E;
  path: string;
  role: string;
  /** Role prefix: 'video', 'audio', or 'audio:s<N>' for an element dedicated to audio track N (see slotBase). */
  base: string;
  /**
   * False from the moment the element is lent to a clip until it has landed on that clip's source time. A reused
   * element still shows (and plays) the previous clip's position meanwhile, so it is not drawn and stays silent.
   */
  settled: boolean;
  /** A seek was issued since the element was lent. */
  sought: boolean;
}

/**
 * One scrub step in flight: the frame and plan whose visible layers were sent seeking. Nothing new is sought until
 * every one of `els` has landed; then the plan is drawn (unless the data changed meanwhile) and the next round
 * starts at the latest playhead.
 */
interface ScrubRound {
  frame: number;
  plan: FramePlan;
  visible: Set<LayerPlan>;
  els: HTMLVideoElement[];
  version: number;
}

/** Layers the canvas paints for a plan, bottom to top, from index `first` (everything below it is covered). */
interface Composite {
  drawable: { layer: LayerPlan; el: HTMLVideoElement | HTMLImageElement; vw: number; vh: number }[];
  first: number;
}

/** Audio nodes of one pooled element: its (only) MediaElementAudioSourceNode -> a gain into the master bus. */
interface AudioNodes {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

/**
 * MediaElementAudioSourceNode of each element, shared by every player: the node can be created only once per element,
 * so a player recreated on the same AudioContext (the Program monitor remounting) must reuse it.
 */
const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

export class SequencePlayer {
  private seq: Sequence | null = null;
  private media: Record<ID, MediaItem> = {};
  private settings: SequencePlayerSettings = { useProxies: true, playbackResolution: 'full' };
  private clock: PlaybackClock;
  private fps: Rational = { num: 24, den: 1 };
  private durationFrames = 0;
  private rate = 1;
  private playing = false;
  private loop: { inF: number; outF: number } | null = null;
  private frameOffset = 0;
  private rafId: number | null = null;
  private lastFrame = -1;
  private lastPlan: FramePlan | null = null;
  /** playingKey of the last draw while playing ('' = the last draw was not a playing draw). */
  private lastDrawKey = '';
  /** compositeKey of the last draw while paused ('' = none, or a playing draw since). */
  private pausedKey = '';
  /** The canvas must be redrawn even if compositeKey is unchanged (sequence, settings or size changed). */
  private drawPending = true;
  /** Frame of the last plan (paused or playing); -1 before the first. */
  private plannedFrame = -1;
  /** performance.now() of the last paused playhead move (seek); scrubbing while less than SCRUB_REST_MS ago. */
  private lastMoveAt = -Infinity;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  /** The playhead came to rest: run one full (non-scrub) update. */
  private restPending = false;
  /** An element event (seeked / loadeddata) arrived while paused: re-check the elements on the next tick. */
  private mediaDirty = false;
  private round: ScrubRound | null = null;
  /** Bumped by every data change; a scrub round planned under an older version is not drawn. */
  private version = 0;
  /** Device-pixel size of the canvas on screen (setDisplaySize); caps the canvas resolution. */
  private displaySize: { w: number; h: number } | null = null;
  /** clipId -> element lent to it for the current plan. */
  private activeVideo = new Map<ID, Slot<HTMLVideoElement>>();
  /** Audio slots hold <audio> elements: they play the sound without a second video decoder per clip. */
  private activeAudio = new Map<ID, Slot>();
  /** Audio graph per pooled element (created once per element, dropped when the pool disposes the element). */
  private audioNodes = new Map<HTMLMediaElement, AudioNodes>();
  private master: GainNode | null = null;
  /** Gains that carry a level-keyframe ramp (rampKeyframedGain). */
  private rampedParams = new WeakSet<AudioParam>();
  /** Pool keys this player acquired (released on destroy when the player's role id is not reusable). */
  private acquired = new Map<string, { path: string; role: string }>();
  private readonly ownsRoles: boolean;
  private offPoolDispose: (() => void) | null = null;
  /** Removes this player's listeners from an element (elements outlive a player with a reusable id). */
  private listenerOffs = new Map<HTMLMediaElement, () => void>();
  private subtitleCache = new WeakMap<Sequence, ResolvedCue[]>();
  /** playingKey's subtitle part for (sequence, frame). */
  private subtitleKey: { seq: Sequence | null; frame: number; key: string } = { seq: null, frame: -1, key: '' };
  private frameCbs = new Set<(frame: number) => void>();
  private stateCbs = new Set<(s: SequencePlayerState) => void>();
  private drawSubtitles: boolean;
  private readonly id: string;
  private destroyed = false;
  private offPoolRelease: (() => void) | null = null;
  private ctx: CanvasRenderingContext2D | null;
  /** Redraw when a still image finishes loading (paused display would otherwise stay black). */
  private readonly imageRedraw = () => { if (!this.destroyed) { this.invalidate(); this.requestTick(); } };

  constructor(
    public readonly canvas: HTMLCanvasElement,
    public readonly pool: MediaElementPool,
    public readonly audioContext?: AudioContext,
    options: SequencePlayerOptions = {},
  ) {
    this.clock = options.clock ?? new PlaybackClock();
    this.drawSubtitles = options.drawSubtitles ?? true;
    this.id = options.id ?? `p${++playerCounter}`;
    // A caller-chosen id (the Program monitor's 'program') is reused by the next player, which then reuses the pooled
    // elements; an auto id never comes back, so its elements are released on destroy.
    this.ownsRoles = options.id === undefined;
    this.ctx = canvas.getContext('2d', { alpha: false });
    // A released path (proxy ready, relink) disposes elements this player may still hold: re-acquire and redraw.
    this.offPoolRelease = pool.onPathReleased?.((path) => {
      if (this.destroyed) return;
      forgetStillImage(path);
      const plan = this.lastPlan;
      const uses = !plan || plan.layers.some((l) => l.path === path) || plan.audio.some((a) => a.path === path);
      if (!uses) return;
      this.invalidate();
      this.requestTick();
    }) ?? null;
    // The pool disposes an element (LRU eviction, relink, proxy ready): forget it and drop its audio nodes.
    this.offPoolDispose = pool.onDispose?.((el, path, role) => this.forgetElement(el, path, role)) ?? null;
    if (audioContext) {
      this.master = audioContext.createGain();
      this.master.connect(audioContext.destination);
    }
  }

  // ---------------------------------------------------------------- data

  /** Cheap to call on every store change: stores refs and schedules one redraw. */
  setSequence(seq: Sequence, media: Record<ID, MediaItem>, settings: SequencePlayerSettings): void {
    const fpsChanged = !this.seq || this.seq.fps.num !== seq.fps.num || this.seq.fps.den !== seq.fps.den;
    const resChanged = settings.playbackResolution !== this.settings.playbackResolution;
    const sizeChanged = !this.seq || this.seq.width !== seq.width || this.seq.height !== seq.height;
    this.seq = seq;
    this.media = media;
    this.settings = settings;
    this.fps = seq.fps;
    this.durationFrames = sequenceDuration(seq);
    if (fpsChanged || resChanged || sizeChanged) this.resizeCanvas();
    this.invalidate(); // force re-plan + redraw
    this.requestTick();
  }

  /** Data changed: re-plan and redraw on the next tick; a scrub round planned before it is not drawn. */
  private invalidate(): void {
    this.lastFrame = -1;
    this.version++;
  }

  // ---------------------------------------------------------------- transport

  get isPlaying(): boolean { return this.playing; }
  get playbackRate(): number { return this.rate; }
  get sequenceDurationFrames(): number { return this.durationFrames; }

  currentFrame(): number {
    const f = secondsToFramesFloor(this.clock.now(), this.fps) + this.frameOffset;
    return Math.max(0, Math.min(this.durationFrames, f));
  }

  /** Move the playhead. While paused, seeks in quick succession are a scrub (see SCRUB_REST_MS). */
  seek(frame: number): void { this.seekTo(frame, true); }

  private seekTo(frame: number, scrub: boolean): void {
    const f = Math.max(0, Math.min(this.durationFrames, Math.round(frame)));
    this.clock.seek(framesToSeconds(f - this.frameOffset, this.fps) + 1e-6);
    if (scrub && !this.playing && this.plannedFrame !== -1 && f !== this.plannedFrame) this.noteMove();
    this.lastFrame = -1;
    this.requestTick();
  }

  private noteMove(): void {
    this.lastMoveAt = performance.now();
    if (this.restTimer === null) this.armRest(SCRUB_REST_MS);
  }

  /** Once the playhead has not moved for SCRUB_REST_MS, run one full update (pausedTick). */
  private armRest(ms: number): void {
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      if (this.destroyed || this.playing) return;
      const left = this.lastMoveAt + SCRUB_REST_MS - performance.now();
      if (left > 0) { this.armRest(left + 1); return; }
      this.restPending = true;
      this.requestTick();
    }, ms);
  }

  private isScrubbing(): boolean { return !this.playing && performance.now() - this.lastMoveAt < SCRUB_REST_MS; }

  play(): void {
    if (this.destroyed || this.playing || !this.seq) return;
    if (this.rate === 0) this.rate = 1;
    const f = this.currentFrame();
    if (this.rate > 0 && f >= (this.loop ? this.loop.outF : this.durationFrames)) this.seekTo(this.loop ? this.loop.inF : 0, false);
    if (this.rate < 0 && f <= (this.loop ? this.loop.inF : 0)) this.seekTo(this.loop ? this.loop.outF - 1 : this.durationFrames - 1, false);
    this.playing = true;
    this.clock.setRate(this.rate);
    if (!this.clock.isRunning) this.clock.start(this.clock.now());
    if (this.audioContext && this.audioContext.state === 'suspended') void this.audioContext.resume().catch(() => {});
    this.lastFrame = -1;
    this.emitState();
    this.requestTick();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.clock.stop();
    // Land exactly on the current frame so paused display is deterministic.
    this.clock.seek(framesToSeconds(this.currentFrame() - this.frameOffset, this.fps) + 1e-6);
    this.pauseAllElements();
    this.lastFrame = -1;
    this.emitState();
    this.requestTick();
  }

  /** Pause and return to the loop in-point (or frame 0). */
  stop(): void {
    this.pause();
    this.seekTo(this.loop ? this.loop.inF : 0, false);
  }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  /** JKL shuttle: 0 pauses; otherwise plays at the rate (-8..8). */
  setRate(rate: number): void {
    const r = Math.max(-8, Math.min(8, rate));
    if (r === 0) { this.rate = 0; this.pause(); return; }
    const wasNative = this.isNative();
    this.rate = r;
    if (this.playing) {
      this.clock.setRate(r);
      if (wasNative !== this.isNative()) this.pauseAllElements();
    } else {
      this.play();
    }
    this.emitState();
  }

  setLoopRange(inF: number, outF: number | null): void {
    if (outF === null || outF <= inF) this.loop = null;
    else this.loop = { inF: Math.max(0, inF), outF };
    this.emitState();
  }

  /**
   * The master output node (all tracks are mixed into it before the destination), or null without an
   * AudioContext. Attach an AnalyserNode to it for metering: `getMasterGain()?.connect(analyser)`.
   * Do not disconnect it from the destination.
   */
  getMasterGain(): GainNode | null { return this.master; }

  setMasterVolume(v: number): void {
    if (!this.master || !this.audioContext) return;
    this.master.gain.setTargetAtTime(Math.max(0, v), this.audioContext.currentTime, 0.01);
  }

  /**
   * Size of the canvas on screen in device pixels (null = unknown). The canvas resolution (sequence size x playback
   * resolution) is capped to it, keeping the sequence aspect ratio.
   */
  setDisplaySize(width: number, height: number): void {
    const next = width > 0 && height > 0 ? { w: Math.round(width), h: Math.round(height) } : null;
    if (next?.w === this.displaySize?.w && next?.h === this.displaySize?.h) return;
    this.displaySize = next;
    this.resizeCanvas();
    this.invalidate();
    this.requestTick();
  }

  setDrawSubtitles(on: boolean): void { this.drawSubtitles = on; this.invalidate(); this.requestTick(); }

  /** Synchronously seek to `frame`, update every element (as at rest, not as a scrub step) and draw once. */
  renderFrame(frame: number): void {
    this.seekTo(frame, false);
    this.tick(true);
  }

  // ---------------------------------------------------------------- sync support

  /** Replace the clock (used by SyncGroup to drive two players from one clock). */
  useClock(clock: PlaybackClock): void {
    const pos = this.clock.now();
    this.clock = clock;
    if (!clock.isRunning && !this.playing) clock.seek(pos);
    this.invalidate();
    this.requestTick();
  }
  getClock(): PlaybackClock { return this.clock; }

  /** Frames added to the clock-derived frame (second player in Compare mode). */
  setFrameOffset(frames: number): void { this.frameOffset = Math.round(frames); this.invalidate(); this.requestTick(); }
  getFrameOffset(): number { return this.frameOffset; }

  // ---------------------------------------------------------------- queries

  /** Clips whose media could not be used for the last rendered frame (and why). */
  getMissing(): MissingMedia[] {
    const out: MissingMedia[] = [...(this.lastPlan?.missing ?? [])];
    const seen = new Set(out.map((m) => m.clipId));
    const check = (items: (LayerPlan | AudioPlan)[]) => {
      for (const it of items) {
        if (seen.has(it.clipId)) continue;
        if ('isImage' in it && it.isImage) {
          const imgErr = getStillImage(it.path).error;
          if (imgErr) { seen.add(it.clipId); out.push({ clipId: it.clipId, mediaId: it.mediaId, reason: imgErr }); }
          continue;
        }
        const err = this.pool.getError(it.path);
        if (err) { seen.add(it.clipId); out.push({ clipId: it.clipId, mediaId: it.mediaId, reason: err.message }); }
      }
    };
    if (this.lastPlan) { check(this.lastPlan.layers); check(this.lastPlan.audio); }
    return out;
  }

  /** Subtitle cues visible at a frame (from enabled sequence subtitle tracks). */
  getSubtitleAt(frame: number): ResolvedCue[] {
    if (!this.seq) return [];
    let cues = this.subtitleCache.get(this.seq);
    if (!cues) { cues = resolveSubtitleCues(this.seq); this.subtitleCache.set(this.seq, cues); }
    const out: ResolvedCue[] = [];
    for (const c of cues) {
      if (c.start > frame) break;
      if (frame < c.end) out.push(c);
    }
    return out;
  }

  getState(): SequencePlayerState {
    return { playing: this.playing, rate: this.rate, frame: this.currentFrame(), durationFrames: this.durationFrames, loop: this.loop };
  }

  onFrame(cb: (frame: number) => void): () => void { this.frameCbs.add(cb); return () => { this.frameCbs.delete(cb); }; }
  onStateChange(cb: (s: SequencePlayerState) => void): () => void { this.stateCbs.add(cb); return () => { this.stateCbs.delete(cb); }; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offPoolRelease?.(); this.offPoolRelease = null;
    this.offPoolDispose?.(); this.offPoolDispose = null;
    this.playing = false;
    this.clock.stop();
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.restTimer !== null) { clearTimeout(this.restTimer); this.restTimer = null; }
    this.round = null;
    this.pauseAllElements();
    for (const [clipId, slot] of this.activeVideo) this.releaseSlot(this.activeVideo, clipId, slot);
    for (const [clipId, slot] of this.activeAudio) this.releaseSlot(this.activeAudio, clipId, slot);
    // Disconnect this player's audio graph. The source nodes stay attached to their elements (elementSources) so a
    // later player on the same AudioContext can reconnect them.
    for (const nodes of this.audioNodes.values()) {
      try { nodes.source.disconnect(); } catch { /* ignore */ }
      try { nodes.gain.disconnect(); } catch { /* ignore */ }
    }
    this.audioNodes.clear();
    for (const off of this.listenerOffs.values()) off();
    this.listenerOffs.clear();
    if (this.master) { try { this.master.disconnect(); } catch { /* ignore */ } }
    if (this.ownsRoles) for (const { path, role } of this.acquired.values()) this.pool.release(path, role);
    this.acquired.clear();
    this.frameCbs.clear();
    this.stateCbs.clear();
  }

  // ---------------------------------------------------------------- frame loop

  private isNative(): boolean { return this.playing && this.rate > 0 && this.rate <= MAX_NATIVE_RATE; }

  private requestTick(): void {
    if (this.destroyed || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => { this.rafId = null; this.tick(false); });
  }

  private tick(force: boolean): void {
    if (this.destroyed || !this.seq) return;
    let frame = this.currentFrame();

    if (this.playing) {
      const endF = this.loop ? this.loop.outF : this.durationFrames;
      const startF = this.loop ? this.loop.inF : 0;
      if (this.rate > 0 && frame >= endF) {
        if (this.loop) { this.seekTo(startF, false); frame = this.currentFrame(); }
        else { this.playing = false; this.clock.stop(); this.seekTo(this.durationFrames, false); frame = this.durationFrames; this.pauseAllElements(); this.emitState(); }
      } else if (this.rate < 0 && frame <= startF) {
        if (this.loop) { this.seekTo(endF - 1, false); frame = this.currentFrame(); }
        else { this.playing = false; this.clock.stop(); this.seekTo(0, false); frame = 0; this.pauseAllElements(); this.emitState(); }
      }
    }

    const invalidated = force || this.lastFrame === -1; // seek, new sequence / media / settings
    if (this.playing) {
      this.round = null;
      const plan = planFrame(this.seq, this.media, frame, this.settings.useProxies);
      this.lastPlan = plan;
      this.plannedFrame = frame;
      this.updateVideoElements(plan);
      this.updateAudio(plan);
      // While playing, rAF runs at the display rate (60 Hz) but the picture only changes when a painted layer's
      // element presents its next frame (24–30 Hz): skip the redundant redraws, each of which is a drawImage plus the
      // canvas paint, layerization and raster of a frame (see playingKey).
      const comp = this.composite(plan);
      const key = this.playingKey(comp, frame);
      if (invalidated || key !== this.lastDrawKey) { this.paint(comp, frame); this.pausedKey = ''; }
      this.lastDrawKey = key;
    } else {
      this.lastDrawKey = '';
      this.pausedTick(frame, force, invalidated);
    }

    if (frame !== this.lastFrame || this.playing) {
      this.lastFrame = frame;
      for (const cb of this.frameCbs) cb(frame);
    }
    if (this.playing) this.requestTick();
  }

  /**
   * Paused: a scrub step while the playhead is moving (scrubTick); otherwise the full update, as before scrub mode
   * existed: every element of the plan (occluded layers and audio included) is parked at the playhead, and the
   * canvas is redrawn if its picture changed.
   */
  private pausedTick(frame: number, force: boolean, invalidated: boolean): void {
    const mediaDirty = this.mediaDirty, rest = this.restPending;
    this.mediaDirty = false;
    this.restPending = false;
    if (invalidated) this.drawPending = true;
    if (!force && this.isScrubbing()) { this.scrubTick(frame); return; }
    if (!invalidated && !mediaDirty && !rest && frame === this.plannedFrame && this.lastPlan !== null) return;
    this.round = null;
    const plan = planFrame(this.seq!, this.media, frame, this.settings.useProxies);
    this.lastPlan = plan;
    this.plannedFrame = frame;
    this.updateVideoElements(plan);
    this.updateAudio(plan);
    this.paintIfChanged(plan, frame);
  }

  /**
   * One scrub step, coalesced like a professional NLE: while the last round's seeks are pending nothing is sought
   * (the playhead just moves on); once they have all landed, that round's frame is drawn and the visible layers are
   * sought to the latest playhead. Only layers composited at the playhead are touched: occluded video layers and the
   * (silent while paused) audio wait for the playhead to rest, when pausedTick parks them.
   */
  private scrubTick(frame: number): void {
    const r = this.round;
    if (r) {
      if (r.els.some((el) => this.seekInFlight(el))) return;
      this.round = null;
      if (r.version === this.version && this.syncVisible(r.plan, r.visible, false).ready) this.paintIfChanged(r.plan, r.frame);
    }
    const seq = this.seq!;
    const plan = planFrame(seq, this.media, frame, this.settings.useProxies);
    this.lastPlan = plan;
    this.plannedFrame = frame;
    const visible = this.visibleLayers(plan, seq);
    const items: LayerPlan[] = [];
    for (const layer of plan.layers) {
      if (layer.isImage) { getStillImage(layer.path, this.imageRedraw); continue; }
      if (this.pool.getError(layer.path)) continue;
      // A hidden layer keeps the element it already has (no churn) but is not lent a new one, nor sought.
      if (visible.has(layer) || this.activeVideo.has(layer.clipId)) items.push(layer);
    }
    this.assignSlots('video', items, this.activeVideo, (path, role) => this.pool.acquireVideo(path, role), (slot) => { if (!slot.el.paused) slot.el.pause(); });
    const { ready, els } = this.syncVisible(plan, visible, true);
    if (ready) this.paintIfChanged(plan, frame);
    else this.round = { frame, plan, visible, els, version: this.version };
  }

  /** A seek (or the first load) of `el` has not completed yet. */
  private seekInFlight(el: HTMLMediaElement): boolean {
    if (el.error || !el.getAttribute('src')) return false;
    return el.seeking || el.readyState < 2;
  }

  /**
   * The layers of `plan` that are composited: top-down until a video layer covers the whole frame opaquely (layers
   * with alpha 0 and failed files never are). Sizes come from the element when it has one, else from the probe, as
   * in composite().
   */
  private visibleLayers(plan: FramePlan, seq: Sequence): Set<LayerPlan> {
    const out = new Set<LayerPlan>();
    for (let i = plan.layers.length - 1; i >= 0; i--) {
      const layer = plan.layers[i];
      if (layer.alpha <= 0) continue;
      if (layer.isImage) { out.add(layer); continue; }
      if (this.pool.getError(layer.path)) continue;
      out.add(layer);
      const slot = this.activeVideo.get(layer.clipId);
      const m = Object.hasOwn(this.media, layer.mediaId) ? this.media[layer.mediaId] : undefined;
      const fallback = probedDisplaySize(m?.probe?.video) ?? layer.mediaSize;
      const vw = slot?.el.videoWidth || fallback?.width || 0;
      const vh = slot?.el.videoHeight || fallback?.height || 0;
      if (vw && vh && this.coversFrameOpaquely(layer, vw, vh, seq)) break;
    }
    return out;
  }

  /**
   * Bring the visible video layers of `plan` to their frame-centered source time (with `seek`; never behind a pending
   * seek) and update their settled flags. `ready`: every visible layer has landed and can be drawn.
   */
  private syncVisible(plan: FramePlan, visible: Set<LayerPlan>, seek: boolean): { ready: boolean; els: HTMLVideoElement[] } {
    let ready = true;
    const els: HTMLVideoElement[] = [];
    for (const layer of plan.layers) {
      if (!visible.has(layer)) continue;
      if (layer.isImage) { const im = getStillImage(layer.path); if (!im.img.complete && !im.error) ready = false; continue; }
      const slot = this.activeVideo.get(layer.clipId);
      if (!slot) continue;
      const el = slot.el;
      if (!el.paused) el.pause();
      const fps = fpsValue(layer.mediaFps);
      const target = this.clampToMedia(el, layer.sourceTime + 0.5 / fps, layer.timeOffset);
      const tol = 1 / (2 * fps);
      if (seek && !el.seeking && Math.abs(el.currentTime - target) > tol) { el.currentTime = target; slot.sought = true; }
      if (!slot.settled && !el.seeking && el.readyState >= 2 && (slot.sought || Math.abs(el.currentTime - target) <= tol)) slot.settled = true;
      if (el.seeking || !slot.settled || el.readyState < 2) ready = false;
      els.push(el);
    }
    return { ready, els };
  }

  /** Paused draw: only when the picture differs from what the canvas shows, or a data change requires it. */
  private paintIfChanged(plan: FramePlan, frame: number): void {
    const comp = this.composite(plan);
    const key = this.compositeKey(frame, comp);
    if (!this.drawPending && key === this.pausedKey) return;
    this.paint(comp, frame);
    this.pausedKey = key;
    this.drawPending = false;
  }

  /** What a paused draw of `comp` at `frame` shows: the timeline frame plus each painted layer's media frame. */
  private compositeKey(frame: number, comp: Composite): string {
    let key = String(frame);
    for (let i = comp.first; i < comp.drawable.length; i++) {
      const { layer, el, vw, vh } = comp.drawable[i];
      key += layer.isImage ? `|${layer.clipId}:i` : `|${layer.clipId}:${Math.floor((el as HTMLVideoElement).currentTime * fpsValue(layer.mediaFps) + 1e-6)}:${vw}x${vh}`;
    }
    return key;
  }

  /**
   * What a playing draw of `comp` shows: each painted layer (from the top opaque one up) with the media frame its
   * element is on and its alpha, plus the subtitle cues at `frame`. Neither the timeline frame itself nor occluded
   * layers: their frame counters tick out of phase with the painted layer's (the timeline at 24 Hz, every playing
   * element at its own 24 Hz), so keying on them redrew the same picture two to three times (about 55 draws/s instead
   * of 24 with three video tracks playing in the perf bench).
   */
  private playingKey(comp: Composite, frame: number): string {
    let key = '';
    for (let i = comp.first; i < comp.drawable.length; i++) {
      const { layer, el, vw, vh } = comp.drawable[i];
      key += layer.isImage ? `|${layer.clipId}:i` : `|${layer.clipId}:${Math.floor((el as HTMLVideoElement).currentTime * fpsValue(layer.mediaFps) + 1e-6)}:${vw}x${vh}`;
      if (layer.alpha < 1) key += `@${Math.round(layer.alpha * 1024)}`;
      // Keyframed motion changes the picture with the timeline frame even when the media frame does not (a still).
      if (layer.animated) { const t = layer.transform; key += `~${t.x.toFixed(2)},${t.y.toFixed(2)},${t.scale.toFixed(5)}`; }
    }
    if (this.drawSubtitles) {
      const sk = this.subtitleKey; // the cue scan runs once per timeline frame, not on every rAF tick
      if (sk.seq !== this.seq || sk.frame !== frame) { sk.seq = this.seq; sk.frame = frame; sk.key = this.getSubtitleAt(frame).map((c) => `|s${c.id}`).join(''); }
      key += sk.key;
    }
    return key;
  }

  private ensureListeners(el: HTMLMediaElement): void {
    if (this.listenerOffs.has(el)) return;
    const redraw = () => {
      if (this.playing || this.destroyed) return;
      this.mediaDirty = true;
      // A scrub seek landed: draw it and seek on to the latest playhead now rather than a frame later.
      if (this.round && this.isScrubbing()) this.tick(false);
      else this.requestTick();
    };
    el.addEventListener('seeked', redraw);
    el.addEventListener('loadeddata', redraw);
    // 'seeked' does not mean the landed frame is drawable yet: Chromium fires it from the main thread while the frame
    // reaches the element's compositor from the media thread, so under load a draw at 'seeked' (or in the rAF after
    // it) can still get the previous frame, which compositeKey (built from currentTime) then never replaces. The
    // landed frame is drawable once the element presents it (requestVideoFrameCallback): redraw then, while paused.
    const v = el as HTMLMediaElement & { requestVideoFrameCallback?(cb: () => void): number; cancelVideoFrameCallback?(id: number): void };
    let vfc: number | null = null;
    const presented = () => {
      vfc = null;
      if (this.destroyed) return;
      vfc = v.requestVideoFrameCallback!(presented);
      if (this.playing) return;
      for (const slot of this.activeVideo.values()) {
        if (slot.el !== el) continue;
        this.drawPending = true;
        redraw();
        break;
      }
    };
    if (typeof v.requestVideoFrameCallback === 'function') vfc = v.requestVideoFrameCallback(presented);
    this.listenerOffs.set(el, () => {
      el.removeEventListener('seeked', redraw); el.removeEventListener('loadeddata', redraw);
      if (vfc !== null) v.cancelVideoFrameCallback?.(vfc);
      vfc = null;
    });
  }

  /** Source time -> clamped element currentTime (originals with a container start offset are absolute-pts based). */
  private clampToMedia(el: HTMLMediaElement, sourceTime: number, offset: number): number {
    return clampElementTime(toElementTime(sourceTime, offset), el.duration, offset);
  }

  /**
   * Lend a pooled element to every clip in `items` (one per clip): a clip keeps the element it had, the others take
   * the lowest free slot of their file (reusing a loaded element when one is idle). Slots of clips that left the plan
   * (or whose file changed) are unpinned and passed to `onFree` (pause / silence); their elements stay pooled for the
   * next clip on that file.
   */
  private assignSlots<E extends HTMLMediaElement>(kind: 'video' | 'audio', items: readonly { clipId: ID; path: string; audioTrack?: number }[], active: Map<ID, Slot<E>>,
    acquire: (path: string, role: string) => E, onFree: (slot: Slot<E>) => void): void {
    const wanted = new Map<ID, { path: string; base: string }>();
    for (const it of items) wanted.set(it.clipId, { path: it.path, base: slotBase(kind, it.audioTrack) });
    const claimed = new Set<string>();
    for (const [clipId, slot] of active) {
      const w = wanted.get(clipId);
      if (w && w.path === slot.path && w.base === slot.base && this.pool.has(slot.path, slot.role)) {
        claimed.add(poolKey(slot.path, slot.role));
        this.pool.touch(slot.path, slot.role);
        continue;
      }
      this.releaseSlot(active, clipId, slot);
      onFree(slot);
    }
    for (const it of items) {
      if (active.has(it.clipId)) continue;
      const base = slotBase(kind, it.audioTrack);
      let k = 0;
      let role = `${base}:${k}#${this.id}`;
      while (claimed.has(poolKey(it.path, role))) role = `${base}:${++k}#${this.id}`;
      claimed.add(poolKey(it.path, role));
      const el = acquire(it.path, role);
      this.pool.pin(it.path, role); // never evicted while lent, even with more files in view than the pool holds
      this.acquired.set(poolKey(it.path, role), { path: it.path, role });
      this.ensureListeners(el);
      active.set(it.clipId, { el, path: it.path, role, base, settled: false, sought: false });
    }
  }

  private releaseSlot<E extends HTMLMediaElement>(active: Map<ID, Slot<E>>, clipId: ID, slot: Slot<E>): void {
    active.delete(clipId);
    this.pool.unpin(slot.path, slot.role);
  }

  /** The pool disposed `el`: drop every reference to it (slots, audio nodes) so it and its decoder can be collected. */
  private forgetElement(el: HTMLMediaElement, path: string, role: string): void {
    this.acquired.delete(poolKey(path, role));
    this.listenerOffs.get(el)?.();
    this.listenerOffs.delete(el);
    for (const [clipId, slot] of this.activeVideo) if (slot.el === el) this.activeVideo.delete(clipId);
    if (this.round?.els.includes(el as HTMLVideoElement)) this.round = null;
    for (const [clipId, slot] of this.activeAudio) if (slot.el === el) this.activeAudio.delete(clipId);
    const nodes = this.audioNodes.get(el);
    if (nodes) {
      try { nodes.source.disconnect(); } catch { /* ignore */ }
      try { nodes.gain.disconnect(); } catch { /* ignore */ }
      this.audioNodes.delete(el);
    }
    elementSources.delete(el);
  }

  /**
   * Keep a lent element at its clip's source time (native playback at forward rates <= MAX_NATIVE_RATE, parked and
   * seeked otherwise). The slot is settled once the element has data at that time: it is within `tol`, or the seek
   * issued since it was lent has completed (an element clamps a seek past its end, so it may never come within `tol`).
   */
  private syncElement(slot: Slot, target: number, speed: number, native: boolean, tol: number): void {
    const el = slot.el;
    if (native) {
      const wanted = Math.max(0.0625, Math.min(16, speed * this.rate));
      if (Math.abs(el.playbackRate - wanted) > 1e-3) el.playbackRate = wanted;
    } else if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > tol && !el.seeking) { el.currentTime = target; slot.sought = true; }
    if (native && el.paused) void el.play().catch(() => {});
    if (!slot.settled && !el.seeking && el.readyState >= 2 && (slot.sought || Math.abs(el.currentTime - target) <= tol)) slot.settled = true;
  }

  private updateVideoElements(plan: FramePlan): void {
    const native = this.isNative();
    const items: LayerPlan[] = [];
    for (const layer of plan.layers) {
      if (layer.isImage) { getStillImage(layer.path, this.imageRedraw); continue; }
      if (this.pool.getError(layer.path)) continue;
      items.push(layer);
    }
    this.assignSlots('video', items, this.activeVideo, (path, role) => this.pool.acquireVideo(path, role), (slot) => { if (!slot.el.paused) slot.el.pause(); });
    for (const layer of items) {
      const slot = this.activeVideo.get(layer.clipId);
      if (!slot) continue;
      const target = this.clampToMedia(slot.el, layer.sourceTime + 0.5 / fpsValue(layer.mediaFps), layer.timeOffset);
      this.syncElement(slot, target, layer.speed, native, native ? DRIFT_TOLERANCE : 1 / (2 * fpsValue(layer.mediaFps)));
    }
  }

  private updateAudio(plan: FramePlan): void {
    const ctx = this.audioContext;
    if (!ctx || !this.master) return;
    const native = this.isNative();
    const now = ctx.currentTime;
    const items = plan.audio.filter((a) => !this.pool.getError(a.path));
    this.assignSlots('audio', items, this.activeAudio, (path, role) => this.pool.acquire(path, role), (slot) => {
      const param = this.audioNodes.get(slot.el)?.gain.gain;
      if (param) this.endRamp(param, now);
      param?.setTargetAtTime(0, now, 0.01);
      if (!slot.el.paused) slot.el.pause();
    });
    for (const a of items) {
      const slot = this.activeAudio.get(a.clipId);
      if (!slot) continue;
      if (slot.el.muted) slot.el.muted = false;
      // The clip's audio stream (the one export renders): chosen once per element, before its first seek (a switch
      // after a seek stalls Chromium; see audioTracks.ts). Until then the element is neither sought nor played.
      const track = selectAudioTrack(slot.el, a.audioTrack);
      if (track === 'waiting') { slot.settled = false; this.audioNodes.get(slot.el)?.gain.gain.setTargetAtTime(0, now, 0.01); continue; }
      const nodes = this.audioNodesFor(slot.el);
      if (!nodes) continue;
      const target = this.clampToMedia(slot.el, a.sourceTime, a.timeOffset);
      if (track === 'switched') {
        // Silent until it has landed on the new track: seek now (select -> seek -> play is the clean order).
        slot.settled = false;
        if (!slot.el.paused) slot.el.pause();
        slot.el.currentTime = target;
        slot.sought = true;
      }
      // Scrubbing / reverse / fast shuttle (not native): silent, but keep the element parked near the frame.
      this.syncElement(slot, target, a.speed, native, native ? DRIFT_TOLERANCE : 0.25);
      // Track volume is folded into the element's gain: one GainNode per pooled element, none per track (P-12).
      if (a.gainAt && slot.settled && native) this.rampKeyframedGain(nodes.gain.gain, a, now);
      else { this.endRamp(nodes.gain.gain, now); nodes.gain.gain.setTargetAtTime(slot.settled ? a.gain * a.trackVolume : 0, now, 0.01); }
    }
  }

  /** A keyframe ramp scheduled on `param` (rampKeyframedGain) is dropped before a plain level is set. */
  private endRamp(param: AudioParam, now: number): void {
    if (!this.rampedParams.delete(param)) return;
    const cur = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(cur, now);
  }

  /**
   * Level keyframes (Roadmap §11) while playing: ramp the gain linearly from where it is now to the curve's value
   * KEYFRAME_RAMP_SEC ahead of the exact clock position (not the whole frame), re-anchored on every tick. Between
   * ticks the level follows the keyframe curve (a chord of it) instead of stepping once per frame, as the export
   * evaluates it every 256 samples; starting from the current value keeps it click-free when the clip comes in.
   */
  private rampKeyframedGain(param: AudioParam, a: AudioPlan, now: number): void {
    const fpsV = fpsValue(this.fps);
    const f1 = this.clock.now() * fpsV + this.frameOffset + KEYFRAME_RAMP_SEC * this.rate * fpsV;
    const cur = param.value;
    this.rampedParams.add(param);
    param.cancelScheduledValues(now);
    param.setValueAtTime(cur, now);
    param.linearRampToValueAtTime(a.gainAt!(f1) * a.trackVolume, now + KEYFRAME_RAMP_SEC);
  }

  /** The element's source -> gain -> master chain, created on first use (null if the element cannot be routed). */
  private audioNodesFor(el: HTMLMediaElement): AudioNodes | null {
    const existing = this.audioNodes.get(el);
    if (existing) return existing;
    const ctx = this.audioContext!;
    let source = elementSources.get(el);
    if (source && source.context !== ctx) return null; // routed into another AudioContext for good
    if (!source) {
      try { source = ctx.createMediaElementSource(el); } catch { return null; }
      elementSources.set(el, source);
    } else {
      try { source.disconnect(); } catch { /* ignore */ }
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(this.master!);
    const nodes = { source, gain };
    this.audioNodes.set(el, nodes);
    return nodes;
  }

  private pauseAllElements(): void {
    for (const s of this.activeVideo.values()) { if (!s.el.paused) s.el.pause(); }
    for (const s of this.activeAudio.values()) { if (!s.el.paused) s.el.pause(); }
  }

  // ---------------------------------------------------------------- drawing

  private resizeCanvas(): void {
    if (!this.seq) return;
    const factor = RESOLUTION_FACTOR[this.settings.playbackResolution] ?? 1;
    let w = this.seq.width * factor, h = this.seq.height * factor;
    // Never render more pixels than the monitor shows: the canvas is scaled down to its box on screen anyway, and
    // drawImage of a video frame costs in proportion to the pixels written (a 1080p canvas in a 700 px monitor spent
    // 25-45 ms per draw in software compositing, the long tasks of Program playback).
    const cap = this.displaySize;
    if (cap) { const s = Math.min(1, cap.w / w, cap.h / h); w *= s; h *= s; }
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /**
   * Resolve what each layer would draw, then start at the top-most layer that covers the whole frame opaquely:
   * everything below it is invisible, and drawImage of a video frame is the most expensive call of a tick
   * (software compositing). With four full-frame video tracks this draws one layer instead of four.
   */
  private composite(plan: FramePlan): Composite {
    const seq = this.seq;
    const drawable: Composite['drawable'] = [];
    let first = 0;
    if (!seq) return { drawable, first };
    for (const layer of plan.layers) {
      if (layer.alpha <= 0) continue;
      let el: HTMLVideoElement | HTMLImageElement | undefined;
      let vw = 0, vh = 0;
      if (layer.isImage) {
        const img = getStillImage(layer.path).img;
        if (!img.complete || !img.naturalWidth) continue;
        el = img; vw = img.naturalWidth; vh = img.naturalHeight;
      } else {
        const slot = this.activeVideo.get(layer.clipId);
        // A reused element still shows the previous clip's frame until its seek lands: draw nothing rather than that.
        if (!slot || !slot.settled || slot.el.readyState < 2) continue;
        const v = slot.el;
        el = v;
        // videoWidth / videoHeight are the display size (SAR applied); the probe fallback must match it.
        const m = Object.hasOwn(this.media, layer.mediaId) ? this.media[layer.mediaId] : undefined;
        const fallback = probedDisplaySize(m?.probe?.video) ?? layer.mediaSize;
        vw = v.videoWidth || fallback?.width || 0;
        vh = v.videoHeight || fallback?.height || 0;
      }
      if (!vw || !vh) continue;
      if (!layer.isImage && this.coversFrameOpaquely(layer, vw, vh, seq)) first = drawable.length;
      drawable.push({ layer, el, vw, vh });
    }
    return { drawable, first };
  }

  private paint({ drawable, first }: Composite, frame: number): void {
    const ctx = this.ctx;
    const seq = this.seq;
    if (!ctx || !seq) return;
    const W = this.canvas.width, H = this.canvas.height;
    const sx = W / seq.width, sy = H / seq.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.scale(sx, sy);

    for (let i = first; i < drawable.length; i++) {
      const { layer, el, vw, vh } = drawable[i];
      const fit = Math.min(seq.width / vw, seq.height / vh);
      const tr = layer.transform;
      const c = tr.crop;
      const cx = Math.max(0, Math.min(1, c.left)) * vw;
      const cy = Math.max(0, Math.min(1, c.top)) * vh;
      const cw = Math.max(0, 1 - c.left - c.right) * vw;
      const ch = Math.max(0, 1 - c.top - c.bottom) * vh;
      if (cw <= 0 || ch <= 0) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.alpha));
      ctx.translate(seq.width / 2 + tr.x, seq.height / 2 + tr.y);
      if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
      if (tr.scale !== 1) ctx.scale(tr.scale, tr.scale);
      try {
        ctx.drawImage(el, cx, cy, cw, ch, (cx - vw / 2) * fit, (cy - vh / 2) * fit, cw * fit, ch * fit);
      } catch { /* element not decodable yet */ }
      ctx.restore();
    }

    if (this.drawSubtitles) this.drawSubtitleOverlay(ctx, seq, frame);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Whether a video layer paints every pixel of the frame with full opacity (so layers below it cannot show): alpha 1,
   * not rotated, and its cropped, scaled, offset rectangle contains the whole frame. Media that may carry an alpha
   * channel (VP8 / VP9 originals, alpha pixel formats) never counts; proxies are H.264.
   */
  private coversFrameOpaquely(layer: LayerPlan, vw: number, vh: number, seq: Sequence): boolean {
    const tr = layer.transform;
    if (layer.alpha < 1 || (tr.rotation || 0) % 360 !== 0) return false;
    if (!layer.usingProxy) {
      const v = Object.hasOwn(this.media, layer.mediaId) ? this.media[layer.mediaId].probe?.video : undefined;
      if (!v || /^vp[89]$/i.test(v.codec) || /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/i.test(v.pixFmt ?? '')) return false;
    }
    const fit = Math.min(seq.width / vw, seq.height / vh);
    const c = tr.crop;
    const x0 = Math.max(0, Math.min(1, c.left)) * vw, x1 = Math.max(0, Math.min(1, 1 - c.right)) * vw;
    const y0 = Math.max(0, Math.min(1, c.top)) * vh, y1 = Math.max(0, Math.min(1, 1 - c.bottom)) * vh;
    if (x1 <= x0 || y1 <= y0) return false;
    const k = fit * tr.scale;
    const xa = seq.width / 2 + tr.x + (x0 - vw / 2) * k, xb = seq.width / 2 + tr.x + (x1 - vw / 2) * k;
    const ya = seq.height / 2 + tr.y + (y0 - vh / 2) * k, yb = seq.height / 2 + tr.y + (y1 - vh / 2) * k;
    const eps = 1e-6;
    return Math.min(xa, xb) <= eps && Math.max(xa, xb) >= seq.width - eps && Math.min(ya, yb) <= eps && Math.max(ya, yb) >= seq.height - eps;
  }

  private drawSubtitleOverlay(ctx: CanvasRenderingContext2D, seq: Sequence, frame: number): void {
    const cues = this.getSubtitleAt(frame);
    if (!cues.length) return;
    const lines = cues.flatMap((c) => c.text.split(/\r?\n/)).filter((l) => l.length > 0);
    if (!lines.length) return;
    const size = Math.round(seq.height * 0.052);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = `600 ${size}px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.fillStyle = '#fff';
    const lineH = size * 1.2;
    let y = seq.height * 0.93;
    for (let i = lines.length - 1; i >= 0; i--) {
      ctx.strokeText(lines[i], seq.width / 2, y);
      ctx.fillText(lines[i], seq.width / 2, y);
      y -= lineH;
    }
    ctx.restore();
  }

  private emitState(): void {
    const s = this.getState();
    for (const cb of this.stateCbs) cb(s);
  }
}
