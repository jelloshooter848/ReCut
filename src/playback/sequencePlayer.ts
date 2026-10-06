/**
 * Program Monitor compositor.
 *
 * Every rendered frame: planFrame() -> acquire pooled <video> elements for the active clips ->
 * keep them at the right source time (native playback at forward rates <= 4, seek-stepping
 * otherwise) -> composite onto the canvas bottom to top with clip transforms and transition
 * alphas -> mix audio through WebAudio gain nodes.
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

const RESOLUTION_FACTOR: Record<SequencePlayerSettings['playbackResolution'], number> = { full: 1, '1/2': 0.5, '1/4': 0.25 };

let playerCounter = 0;

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
  /**
   * False from the moment the element is lent to a clip until it has landed on that clip's source time. A reused
   * element still shows (and plays) the previous clip's position meanwhile, so it is not drawn and stays silent.
   */
  settled: boolean;
  /** A seek was issued since the element was lent. */
  sought: boolean;
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
  /** drawKey of the last draw while playing ('' = the last draw was not a playing draw). */
  private lastDrawKey = '';
  /** Device-pixel size of the canvas on screen (setDisplaySize); caps the canvas resolution. */
  private displaySize: { w: number; h: number } | null = null;
  /** clipId -> element lent to it for the current plan. */
  private activeVideo = new Map<ID, Slot<HTMLVideoElement>>();
  /** Audio slots hold <audio> elements: they play the sound without a second video decoder per clip. */
  private activeAudio = new Map<ID, Slot>();
  /** Audio graph per pooled element (created once per element, dropped when the pool disposes the element). */
  private audioNodes = new Map<HTMLMediaElement, AudioNodes>();
  private master: GainNode | null = null;
  /** Pool keys this player acquired (released on destroy when the player's role id is not reusable). */
  private acquired = new Map<string, { path: string; role: string }>();
  private readonly ownsRoles: boolean;
  private offPoolDispose: (() => void) | null = null;
  /** Removes this player's listeners from an element (elements outlive a player with a reusable id). */
  private listenerOffs = new Map<HTMLMediaElement, () => void>();
  private subtitleCache = new WeakMap<Sequence, ResolvedCue[]>();
  private frameCbs = new Set<(frame: number) => void>();
  private stateCbs = new Set<(s: SequencePlayerState) => void>();
  private drawSubtitles: boolean;
  private readonly id: string;
  private destroyed = false;
  private offPoolRelease: (() => void) | null = null;
  private ctx: CanvasRenderingContext2D | null;
  /** Redraw when a still image finishes loading (paused display would otherwise stay black). */
  private readonly imageRedraw = () => { if (!this.destroyed) { this.lastFrame = -1; this.requestTick(); } };

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
      this.lastFrame = -1;
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
    this.lastFrame = -1; // force re-plan + redraw
    this.requestTick();
  }

  // ---------------------------------------------------------------- transport

  get isPlaying(): boolean { return this.playing; }
  get playbackRate(): number { return this.rate; }
  get sequenceDurationFrames(): number { return this.durationFrames; }

  currentFrame(): number {
    const f = secondsToFramesFloor(this.clock.now(), this.fps) + this.frameOffset;
    return Math.max(0, Math.min(this.durationFrames, f));
  }

  seek(frame: number): void {
    const f = Math.max(0, Math.min(this.durationFrames, Math.round(frame)));
    this.clock.seek(framesToSeconds(f - this.frameOffset, this.fps) + 1e-6);
    this.lastFrame = -1;
    this.requestTick();
  }

  play(): void {
    if (this.destroyed || this.playing || !this.seq) return;
    if (this.rate === 0) this.rate = 1;
    const f = this.currentFrame();
    if (this.rate > 0 && f >= (this.loop ? this.loop.outF : this.durationFrames)) this.seek(this.loop ? this.loop.inF : 0);
    if (this.rate < 0 && f <= (this.loop ? this.loop.inF : 0)) this.seek(this.loop ? this.loop.outF - 1 : this.durationFrames - 1);
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
    this.seek(this.loop ? this.loop.inF : 0);
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
    this.lastFrame = -1;
    this.requestTick();
  }

  setDrawSubtitles(on: boolean): void { this.drawSubtitles = on; this.lastFrame = -1; this.requestTick(); }

  /** Synchronously seek to `frame`, update elements and draw once (scrubbing / thumbnails). */
  renderFrame(frame: number): void {
    this.seek(frame);
    this.tick(true);
  }

  // ---------------------------------------------------------------- sync support

  /** Replace the clock (used by SyncGroup to drive two players from one clock). */
  useClock(clock: PlaybackClock): void {
    const pos = this.clock.now();
    this.clock = clock;
    if (!clock.isRunning && !this.playing) clock.seek(pos);
    this.lastFrame = -1;
    this.requestTick();
  }
  getClock(): PlaybackClock { return this.clock; }

  /** Frames added to the clock-derived frame (second player in Compare mode). */
  setFrameOffset(frames: number): void { this.frameOffset = Math.round(frames); this.lastFrame = -1; this.requestTick(); }
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
        if (this.loop) { this.seek(startF); frame = this.currentFrame(); }
        else { this.playing = false; this.clock.stop(); this.seek(this.durationFrames); frame = this.durationFrames; this.pauseAllElements(); this.emitState(); }
      } else if (this.rate < 0 && frame <= startF) {
        if (this.loop) { this.seek(endF - 1); frame = this.currentFrame(); }
        else { this.playing = false; this.clock.stop(); this.seek(0); frame = 0; this.pauseAllElements(); this.emitState(); }
      }
    }

    const invalidated = force || this.lastFrame === -1; // seek, new sequence / media / settings, element event
    const needPlan = invalidated || this.playing || frame !== this.lastFrame || this.lastPlan === null;
    if (needPlan) {
      const plan = planFrame(this.seq, this.media, frame, this.settings.useProxies);
      this.lastPlan = plan;
      this.updateVideoElements(plan);
      this.updateAudio(plan);
    }
    // While playing, rAF runs at the display rate (60 Hz) but the picture only changes when the timeline frame or the
    // frame an element shows changes (24–30 Hz): skip the redundant redraws, each of which re-uploads the canvas.
    const key = this.playing ? this.drawKey(this.lastPlan!, frame) : '';
    if (invalidated || !key || key !== this.lastDrawKey) this.draw(this.lastPlan!, frame);
    this.lastDrawKey = key;

    if (frame !== this.lastFrame || this.playing) {
      this.lastFrame = frame;
      for (const cb of this.frameCbs) cb(frame);
    }
    if (this.playing) this.requestTick();
  }

  /** What the canvas would show for `plan` at `frame`: the timeline frame plus each video layer's media frame. */
  private drawKey(plan: FramePlan, frame: number): string {
    let key = String(frame);
    for (const layer of plan.layers) {
      if (layer.isImage) { key += `|i${getStillImage(layer.path).img.complete ? 1 : 0}`; continue; }
      const slot = this.activeVideo.get(layer.clipId);
      if (!slot) { key += '|-'; continue; }
      const el = slot.el;
      key += `|${slot.settled && el.readyState >= 2 ? Math.floor(el.currentTime * fpsValue(layer.mediaFps) + 1e-6) : 'x'}`;
    }
    return key;
  }

  private ensureListeners(el: HTMLMediaElement): void {
    if (this.listenerOffs.has(el)) return;
    const redraw = () => { if (!this.playing) { this.lastFrame = -1; this.requestTick(); } };
    el.addEventListener('seeked', redraw);
    el.addEventListener('loadeddata', redraw);
    this.listenerOffs.set(el, () => { el.removeEventListener('seeked', redraw); el.removeEventListener('loadeddata', redraw); });
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
  private assignSlots<E extends HTMLMediaElement>(kind: 'video' | 'audio', items: readonly { clipId: ID; path: string }[], active: Map<ID, Slot<E>>,
    acquire: (path: string, role: string) => E, onFree: (slot: Slot<E>) => void): void {
    const wanted = new Map<ID, string>();
    for (const it of items) wanted.set(it.clipId, it.path);
    const claimed = new Set<string>();
    for (const [clipId, slot] of active) {
      if (wanted.get(clipId) === slot.path && this.pool.has(slot.path, slot.role)) {
        claimed.add(poolKey(slot.path, slot.role));
        this.pool.touch(slot.path, slot.role);
        continue;
      }
      this.releaseSlot(active, clipId, slot);
      onFree(slot);
    }
    for (const it of items) {
      if (active.has(it.clipId)) continue;
      let k = 0;
      let role = `${kind}:${k}#${this.id}`;
      while (claimed.has(poolKey(it.path, role))) role = `${kind}:${++k}#${this.id}`;
      claimed.add(poolKey(it.path, role));
      const el = acquire(it.path, role);
      this.pool.pin(it.path, role); // never evicted while lent, even with more files in view than the pool holds
      this.acquired.set(poolKey(it.path, role), { path: it.path, role });
      this.ensureListeners(el);
      active.set(it.clipId, { el, path: it.path, role, settled: false, sought: false });
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
      this.audioNodes.get(slot.el)?.gain.gain.setTargetAtTime(0, now, 0.01);
      if (!slot.el.paused) slot.el.pause();
    });
    for (const a of items) {
      const slot = this.activeAudio.get(a.clipId);
      if (!slot) continue;
      if (slot.el.muted) slot.el.muted = false;
      const nodes = this.audioNodesFor(slot.el);
      if (!nodes) continue;
      // Scrubbing / reverse / fast shuttle (not native): silent, but keep the element parked near the frame.
      this.syncElement(slot, this.clampToMedia(slot.el, a.sourceTime, a.timeOffset), a.speed, native, native ? DRIFT_TOLERANCE : 0.25);
      // Track volume is folded into the element's gain: one GainNode per pooled element, none per track (P-12).
      nodes.gain.gain.setTargetAtTime(slot.settled ? a.gain * a.trackVolume : 0, now, 0.01);
    }
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

  private draw(plan: FramePlan, frame: number): void {
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

    // Resolve what each layer would draw, then start at the top-most layer that covers the whole frame opaquely:
    // everything below it is invisible, and drawImage of a video frame is the most expensive call of a tick
    // (software compositing). With four full-frame video tracks this draws one layer instead of four.
    const drawable: { layer: LayerPlan; el: HTMLVideoElement | HTMLImageElement; vw: number; vh: number }[] = [];
    let first = 0;
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
