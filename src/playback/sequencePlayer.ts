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
import { MediaElementPool } from './elementPool';
import { planFrame, type FramePlan, type LayerPlan, type AudioPlan, type MissingMedia } from './planner';
import { clampElementTime, toElementTime } from './mediaSource';
import { pathToMediaUrl } from '../../shared/ipc';

/**
 * Display size of a probed video stream, as Chromium reports it in videoWidth / videoHeight: the storage size
 * stretched by the sample aspect ratio (wider for SAR > 1, taller for SAR < 1; width / height are already the
 * rotated axes, and SAR stretches the storage x axis). A missing or insane stored SAR counts as square.
 * Null when the size is unknown.
 */
export function probedDisplaySize(v: VideoStreamInfo | undefined): { width: number; height: number } | null {
  if (!v || !(v.width > 0) || !(v.height > 0)) return null;
  const s = v.sar as unknown as { num?: unknown; den?: unknown } | null | undefined;
  let sar = 1;
  if (s && typeof s === 'object' && Number.isSafeInteger(s.num) && Number.isSafeInteger(s.den) && (s.num as number) > 0 && (s.den as number) > 0) {
    const r = (s.num as number) / (s.den as number);
    if (r >= 1 / 16 && r <= 16) sar = r;
  }
  const swap = v.rotation === 90 || v.rotation === 270;
  let w = swap ? v.height : v.width, h = swap ? v.width : v.height; // storage axes
  if (sar > 1) w = Math.round(w * sar); else if (sar < 1) h = Math.round(h / sar);
  return swap ? { width: h, height: w } : { width: w, height: h };
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

interface AudioRoute {
  el: HTMLVideoElement;
  source: MediaElementAudioSourceNode;
  clipGain: GainNode;
  trackId: ID;
}

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
  private activeVideo = new Map<ID, HTMLVideoElement>();
  private activeAudio = new Map<ID, AudioRoute>();
  private trackGains = new Map<ID, GainNode>();
  private master: GainNode | null = null;
  private sourceNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private listened = new WeakSet<HTMLMediaElement>();
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
    this.ctx = canvas.getContext('2d', { alpha: false });
    // A released path (proxy ready, relink) disposes elements this player may still hold: re-acquire and redraw.
    this.offPoolRelease = pool.onPathReleased?.((path) => {
      if (this.destroyed) return;
      forgetStillImage(path);
      const plan = this.lastPlan;
      const uses = !plan || plan.layers.some((l) => l.path === path) || plan.audio.some((a) => a.path === path);
      if (!uses) return;
      for (const [clipId, el] of this.activeVideo) if (!el.getAttribute('src')) this.activeVideo.delete(clipId);
      this.lastFrame = -1;
      this.requestTick();
    }) ?? null;
    if (audioContext) {
      this.master = audioContext.createGain();
      this.master.connect(audioContext.destination);
    }
  }

  // ---------------------------------------------------------------- data

  /** Cheap to call on every store change: stores refs and schedules one redraw. */
  setSequence(seq: Sequence, media: Record<ID, MediaItem>, settings: SequencePlayerSettings): void {
    if (seq !== this.seq) this.pruneAudio(seq);
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
    this.playing = false;
    this.clock.stop();
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.pauseAllElements();
    for (const route of this.activeAudio.values()) {
      try { route.source.disconnect(); route.clipGain.disconnect(); } catch { /* ignore */ }
    }
    this.activeAudio.clear();
    for (const g of this.trackGains.values()) { try { g.disconnect(); } catch { /* ignore */ } }
    this.trackGains.clear();
    if (this.master) { try { this.master.disconnect(); } catch { /* ignore */ } }
    this.activeVideo.clear();
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

    const needPlan = force || this.playing || frame !== this.lastFrame || this.lastPlan === null;
    if (needPlan) {
      const plan = planFrame(this.seq, this.media, frame, this.settings.useProxies);
      this.lastPlan = plan;
      this.updateVideoElements(plan);
      this.updateAudio(plan);
    }
    this.draw(this.lastPlan!, frame);

    if (frame !== this.lastFrame || this.playing) {
      this.lastFrame = frame;
      for (const cb of this.frameCbs) cb(frame);
    }
    if (this.playing) this.requestTick();
  }

  private ensureListeners(el: HTMLMediaElement): void {
    if (this.listened.has(el)) return;
    this.listened.add(el);
    const redraw = () => { if (!this.playing) { this.lastFrame = -1; this.requestTick(); } };
    el.addEventListener('seeked', redraw);
    el.addEventListener('loadeddata', redraw);
  }

  /** Source time -> clamped element currentTime (originals with a container start offset are absolute-pts based). */
  private clampToMedia(el: HTMLMediaElement, sourceTime: number, offset: number): number {
    return clampElementTime(toElementTime(sourceTime, offset), el.duration, offset);
  }

  private updateVideoElements(plan: FramePlan): void {
    const native = this.isNative();
    const seen = new Set<ID>();
    for (const layer of plan.layers) {
      if (layer.isImage) { getStillImage(layer.path, this.imageRedraw); continue; }
      seen.add(layer.clipId);
      if (this.pool.getError(layer.path)) continue;
      const role = `video:${layer.clipId}#${this.id}`;
      const el = this.pool.acquire(layer.path, role);
      this.ensureListeners(el);
      this.activeVideo.set(layer.clipId, el);
      const target = this.clampToMedia(el, layer.sourceTime + 0.5 / fpsValue(layer.mediaFps), layer.timeOffset);
      if (native) {
        const wanted = Math.max(0.0625, Math.min(16, layer.speed * this.rate));
        if (Math.abs(el.playbackRate - wanted) > 1e-3) el.playbackRate = wanted;
        if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE && !el.seeking) el.currentTime = target;
        if (el.paused) void el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        const tol = 1 / (2 * fpsValue(layer.mediaFps));
        if (Math.abs(el.currentTime - target) > tol && !el.seeking) el.currentTime = target;
      }
    }
    for (const [clipId, el] of this.activeVideo) {
      if (!seen.has(clipId)) {
        if (!el.paused) el.pause();
        this.activeVideo.delete(clipId);
      }
    }
  }

  private updateAudio(plan: FramePlan): void {
    const ctx = this.audioContext;
    if (!ctx || !this.master) return;
    const native = this.isNative();
    const now = ctx.currentTime;
    const seen = new Set<ID>();
    for (const a of plan.audio) {
      seen.add(a.clipId);
      if (this.pool.getError(a.path)) continue;
      const role = `audio:${a.clipId}#${this.id}`;
      const el = this.pool.acquire(a.path, role);
      this.ensureListeners(el);
      if (el.muted) el.muted = false;
      let route = this.activeAudio.get(a.clipId);
      if (!route || route.el !== el) {
        if (route) { try { route.source.disconnect(); } catch { /* ignore */ } }
        let source = this.sourceNodes.get(el);
        if (!source) {
          try { source = ctx.createMediaElementSource(el); } catch { continue; }
          this.sourceNodes.set(el, source);
        } else {
          try { source.disconnect(); } catch { /* ignore */ }
        }
        const clipGain = route?.clipGain ?? ctx.createGain();
        clipGain.gain.value = 0;
        source.connect(clipGain);
        route = { el, source, clipGain, trackId: a.trackId };
        this.activeAudio.set(a.clipId, route);
        clipGain.connect(this.trackGain(a.trackId));
      } else if (route.trackId !== a.trackId) {
        try { route.clipGain.disconnect(); } catch { /* ignore */ }
        route.clipGain.connect(this.trackGain(a.trackId));
        route.trackId = a.trackId;
      }
      route.clipGain.gain.setTargetAtTime(a.gain, now, 0.01);
      this.trackGain(a.trackId).gain.setTargetAtTime(a.trackVolume, now, 0.01);

      const target = this.clampToMedia(el, a.sourceTime, a.timeOffset);
      if (native) {
        const wanted = Math.max(0.0625, Math.min(16, a.speed * this.rate));
        if (Math.abs(el.playbackRate - wanted) > 1e-3) el.playbackRate = wanted;
        if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE && !el.seeking) el.currentTime = target;
        if (el.paused) void el.play().catch(() => {});
      } else {
        // Scrubbing / reverse / fast shuttle: silent, but keep the element parked near the frame.
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - target) > 0.25 && !el.seeking) el.currentTime = target;
      }
    }
    for (const [clipId, route] of this.activeAudio) {
      if (seen.has(clipId)) continue;
      route.clipGain.gain.setTargetAtTime(0, now, 0.01);
      if (!route.el.paused) route.el.pause();
      // Keep the route (the clip may come back next frame) unless the pool evicted the element,
      // which clears its src.
      if (!route.el.getAttribute('src')) {
        try { route.source.disconnect(); route.clipGain.disconnect(); } catch { /* ignore */ }
        this.activeAudio.delete(clipId);
      }
    }
  }

  /**
   * Disconnect audio routes whose clip is no longer in `seq` and track gains whose track is gone (sequence switch,
   * deleted clips / tracks). Without this, GainNodes accumulate across sequence switches (P-12).
   */
  private pruneAudio(seq: Sequence): void {
    if (!this.activeAudio.size && !this.trackGains.size) return;
    const trackIds = new Set<ID>();
    const clipIds = new Set<ID>();
    for (const t of seq.audioTracks) {
      trackIds.add(t.id);
      if (this.activeAudio.size) for (const c of t.clips) clipIds.add(c.id);
    }
    for (const [clipId, route] of this.activeAudio) {
      if (clipIds.has(clipId) && trackIds.has(route.trackId)) continue;
      try { route.clipGain.gain.value = 0; } catch { /* ignore */ }
      if (!route.el.paused) route.el.pause();
      try { route.source.disconnect(); route.clipGain.disconnect(); } catch { /* ignore */ }
      this.activeAudio.delete(clipId);
    }
    for (const [trackId, g] of this.trackGains) {
      if (trackIds.has(trackId)) continue;
      try { g.disconnect(); } catch { /* ignore */ }
      this.trackGains.delete(trackId);
    }
  }

  private trackGain(trackId: ID): GainNode {
    let g = this.trackGains.get(trackId);
    if (!g) {
      g = this.audioContext!.createGain();
      g.connect(this.master!);
      this.trackGains.set(trackId, g);
    }
    return g;
  }

  private pauseAllElements(): void {
    for (const el of this.activeVideo.values()) { if (!el.paused) el.pause(); }
    for (const r of this.activeAudio.values()) { if (!r.el.paused) r.el.pause(); }
  }

  // ---------------------------------------------------------------- drawing

  private resizeCanvas(): void {
    if (!this.seq) return;
    const factor = RESOLUTION_FACTOR[this.settings.playbackResolution] ?? 1;
    const w = Math.max(2, Math.round(this.seq.width * factor));
    const h = Math.max(2, Math.round(this.seq.height * factor));
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

    for (const layer of plan.layers) {
      if (layer.alpha <= 0) continue;
      let el: HTMLVideoElement | HTMLImageElement | undefined;
      let vw = 0, vh = 0;
      if (layer.isImage) {
        const img = getStillImage(layer.path).img;
        if (!img.complete || !img.naturalWidth) continue;
        el = img; vw = img.naturalWidth; vh = img.naturalHeight;
      } else {
        const v = this.activeVideo.get(layer.clipId);
        if (!v || v.readyState < 2) continue;
        el = v;
        // videoWidth / videoHeight are the display size (SAR applied); the probe fallback must match it.
        const m = Object.hasOwn(this.media, layer.mediaId) ? this.media[layer.mediaId] : undefined;
        const fallback = probedDisplaySize(m?.probe?.video) ?? layer.mediaSize;
        vw = v.videoWidth || fallback?.width || 0;
        vh = v.videoHeight || fallback?.height || 0;
      }
      if (!vw || !vh) continue;
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
