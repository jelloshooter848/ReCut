/**
 * Source Monitor player: a single <video> element with JKL-style transport.
 *
 * Forward rates in (0, 4] use native element playback (audio audible). Reverse rates and rates
 * above 4 are "stepped": the element stays paused and is seeked to frame centers driven by the
 * PlaybackClock, because HTMLMediaElement cannot play backwards.
 */
import type { MediaItem, Rational } from '../../shared/model';
import { frameCenterSeconds, secondsToFramesFloor } from '../../shared/time';
import { pathToMediaUrl } from '../../shared/ipc';
import { PlaybackClock } from './clock';
import { resolvePlaybackPath, mediaFps, mediaDurationSeconds, toElementTime, fromElementTime, type PlaybackPathResolution } from './mediaSource';

const loadErrorListeners = new Set<(path: string) => void>();
/** Subscribe to load/decode errors of any SourcePlayer element (path = the file that failed). */
export function onSourceLoadError(cb: (path: string) => void): () => void {
  loadErrorListeners.add(cb);
  return () => { loadErrorListeners.delete(cb); };
}

export type SourcePlayerState = 'empty' | 'loading' | 'ready' | 'playing' | 'error';

export interface SourcePlayerStatus {
  state: SourcePlayerState;
  rate: number;
  usingProxy: boolean;
  reason?: string;
  mediaId: string | null;
}

type TimeCb = (seconds: number, frame: number) => void;

/** Native element playback works well up to this rate; beyond it we step via seeks. */
export const MAX_NATIVE_RATE = 4;

export class SourcePlayer {
  readonly el: HTMLVideoElement;
  private clock = new PlaybackClock();
  private fps: Rational = { num: 24, den: 1 };
  private media: MediaItem | null = null;
  private resolution: PlaybackPathResolution = { path: null, usingProxy: false };
  private probedDuration = 0;
  private state: SourcePlayerState = 'empty';
  private rate = 1;
  private playing = false;
  private rafId: number | null = null;
  private vfcId: number | null = null;
  private seekPending = false;
  private lastSteppedFrame = -1;
  private destroyed = false;
  private timeCbs = new Set<TimeCb>();
  private endedCbs = new Set<() => void>();
  private stateCbs = new Set<(s: SourcePlayerStatus) => void>();
  private disposers: (() => void)[] = [];

  constructor() {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.controls = false;
    el.muted = false;
    el.disableRemotePlayback = true;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.objectFit = 'contain';
    el.style.background = '#000';
    el.style.display = 'block';
    this.el = el;

    const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: (ev: HTMLMediaElementEventMap[K]) => void) => {
      el.addEventListener(type, fn);
      this.disposers.push(() => el.removeEventListener(type, fn));
    };
    on('seeked', () => {
      this.seekPending = false;
      this.emitTime();
    });
    on('loadedmetadata', () => {
      if (this.state === 'loading') this.setState('ready');
      this.emitTime();
    });
    on('error', () => {
      const msg = el.error?.message || 'media failed to load';
      const failedPath = this.resolution.path;
      if (failedPath) for (const cb of loadErrorListeners) { try { cb(failedPath); } catch { /* ignore listener failures */ } }
      this.resolution = { ...this.resolution, reason: msg };
      this.stopLoop();
      this.playing = false;
      this.clock.stop();
      this.setState('error');
    });
    on('ended', () => {
      if (this.isNative()) {
        this.playing = false;
        this.clock.stop();
        this.stopLoop();
        this.setState('ready');
        for (const cb of this.endedCbs) cb();
      }
    });
    on('timeupdate', () => { if (!this.isNative() || !this.playing) this.emitTime(); });
  }

  // ---------------------------------------------------------------- attach / load

  /** Append the video element to a container; the element fills it with object-fit: contain. */
  attach(container: HTMLElement): void {
    if (this.el.parentElement !== container) container.appendChild(this.el);
  }

  detach(): void {
    this.el.parentElement?.removeChild(this.el);
  }

  /** Load a media item. Returns the path resolution so the UI can explain why nothing plays. */
  load(media: MediaItem | null, opts: { useProxies: boolean }): PlaybackPathResolution {
    this.pause();
    this.media = media;
    this.lastSteppedFrame = -1;
    this.seekPending = false;
    if (!media) {
      this.resolution = { path: null, usingProxy: false };
      this.clearSrc();
      this.setState('empty');
      return this.resolution;
    }
    this.fps = mediaFps(media);
    this.probedDuration = mediaDurationSeconds(media);
    this.resolution = resolvePlaybackPath(media, opts.useProxies);
    if (!this.resolution.path) {
      this.clearSrc();
      this.setState('error');
      return this.resolution;
    }
    const url = pathToMediaUrl(this.resolution.path);
    if (this.el.src !== url) {
      this.el.src = url;
      this.el.load();
      this.setState('loading');
    } else {
      this.setState(this.el.readyState >= 1 ? 'ready' : 'loading');
    }
    this.clock.seek(0);
    return this.resolution;
  }

  get currentMedia(): MediaItem | null { return this.media; }
  get mediaFrameRate(): Rational { return this.fps; }
  status(): SourcePlayerStatus {
    return { state: this.state, rate: this.rate, usingProxy: this.resolution.usingProxy, reason: this.resolution.reason, mediaId: this.media?.id ?? null };
  }

  // ---------------------------------------------------------------- transport

  get isPlaying(): boolean { return this.playing; }
  get playbackRate(): number { return this.rate; }

  play(): void {
    if (this.destroyed || !this.resolution.path || this.state === 'error') return;
    if (this.playing) return;
    if (this.rate === 0) this.rate = 1;
    const t = this.currentTime();
    const dur = this.duration();
    // Restart from the start/end when at the boundary in the direction of travel.
    if (this.rate > 0 && dur > 0 && t >= dur - 1e-3) this.seekInternal(0);
    if (this.rate < 0 && t <= 1e-3) this.seekInternal(Math.max(0, dur - 1 / this.fpsValue()));
    this.playing = true;
    this.clock.setRate(this.rate);
    this.clock.start(this.currentTime());
    this.applyMode();
    this.startLoop();
    this.setState('playing');
  }

  pause(): void {
    if (!this.playing) return;
    const t = this.currentTime();
    this.playing = false;
    this.clock.stop();
    try { this.el.pause(); } catch { /* ignore */ }
    this.stopLoop();
    // Land on a frame center so the display is deterministic.
    this.seekInternal(this.snap(t));
    this.setState(this.state === 'error' ? 'error' : 'ready');
  }

  toggle(): void { this.playing ? this.pause() : this.play(); }

  /** JKL: 0 pauses; non-zero rates in -8..8 play (negative = reverse). */
  setRate(rate: number): void {
    const r = Math.max(-8, Math.min(8, rate));
    if (r === 0) { this.rate = 0; this.pause(); this.emitState(); return; }
    const wasPlaying = this.playing;
    const t = this.currentTime();
    this.rate = r;
    if (wasPlaying) {
      this.clock.setRate(r);
      this.clock.seek(t);
      this.applyMode();
    }
    this.emitState();
  }

  /** Seek to the frame containing `seconds` (snapped to the media frame center). */
  seek(seconds: number): void {
    const t = this.snap(seconds);
    this.seekInternal(t);
    if (this.playing) this.clock.seek(t);
    this.emitTime();
  }

  seekFrame(frame: number): void { this.seek(frameCenterSeconds(frame, this.fps)); }

  stepFrames(n: number): void {
    this.pause();
    this.seekFrame(this.currentFrame() + n);
  }

  currentTime(): number {
    if (this.playing && !this.isNative()) return this.clampTime(this.clock.now());
    return Math.max(0, this.elTime());
  }

  currentFrame(): number { return secondsToFramesFloor(this.currentTime(), this.fps); }

  duration(): number {
    // With a container start offset Chromium's duration is not the media length; trust the probe then.
    if (this.offset() > 0 && Number.isFinite(this.probedDuration) && this.probedDuration > 0) return this.probedDuration;
    const d = this.el.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return Number.isFinite(this.probedDuration) ? this.probedDuration : 0;
  }

  // ---------------------------------------------------------------- audio

  setVolume(v: number): void { this.el.volume = Math.max(0, Math.min(1, v)); }
  getVolume(): number { return this.el.volume; }
  setMuted(m: boolean): void { this.el.muted = m; }
  isMuted(): boolean { return this.el.muted; }

  // ---------------------------------------------------------------- events

  /** Fired every rendered frame while playing and after seeks. */
  onTime(cb: TimeCb): () => void { this.timeCbs.add(cb); return () => { this.timeCbs.delete(cb); }; }
  onEnded(cb: () => void): () => void { this.endedCbs.add(cb); return () => { this.endedCbs.delete(cb); }; }
  onStateChange(cb: (s: SourcePlayerStatus) => void): () => void { this.stateCbs.add(cb); return () => { this.stateCbs.delete(cb); }; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playing = false;
    this.clock.stop();
    this.stopLoop();
    for (const d of this.disposers) d();
    this.disposers = [];
    this.clearSrc();
    this.detach();
    this.timeCbs.clear();
    this.endedCbs.clear();
    this.stateCbs.clear();
  }

  // ---------------------------------------------------------------- internals

  private isNative(): boolean { return this.rate > 0 && this.rate <= MAX_NATIVE_RATE; }
  private fpsValue(): number { return this.fps.num / this.fps.den; }

  /**
   * Element time offset: Chromium's media timeline is the file's absolute pts, so an original with a
   * container start_time > 0 is played at sourceTime + startTime (M-11). Proxies are 0-based.
   */
  private offset(): number { return this.resolution.timeOffset ?? 0; }
  /** Element currentTime as a (container-relative) source time. */
  private elTime(): number { return fromElementTime(this.el.currentTime || 0, this.offset()); }

  private snap(seconds: number): number {
    const frame = secondsToFramesFloor(Math.max(0, seconds), this.fps);
    return this.clampTime(frameCenterSeconds(frame, this.fps));
  }

  private clampTime(t: number): number {
    const d = this.duration();
    if (d > 0) return Math.max(0, Math.min(d - 1e-3, t));
    return Math.max(0, t);
  }

  private seekInternal(t: number): void {
    if (!this.resolution.path) return;
    if (Math.abs(this.elTime() - t) < 1e-4) return;
    this.seekPending = true;
    try { this.el.currentTime = toElementTime(t, this.offset()); } catch { this.seekPending = false; }
  }

  /** Put the element into native or stepped mode according to the rate. */
  private applyMode(): void {
    if (!this.playing) return;
    if (this.isNative()) {
      this.el.playbackRate = this.rate;
      const t = this.clock.now();
      if (Math.abs(this.elTime() - t) > 0.05) this.seekInternal(t);
      void this.el.play().catch(() => { /* autoplay refused or load error; error event handles */ });
    } else {
      try { this.el.pause(); } catch { /* ignore */ }
      this.lastSteppedFrame = -1;
    }
  }

  private startLoop(): void {
    if (this.rafId !== null || this.vfcId !== null) return;
    this.scheduleTick();
  }

  private stopLoop(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.vfcId !== null && 'cancelVideoFrameCallback' in this.el) {
      (this.el as any).cancelVideoFrameCallback(this.vfcId);
      this.vfcId = null;
    }
  }

  private scheduleTick(): void {
    // rVFC fires when a new video frame is presented (native mode); rAF covers stepped mode and
    // browsers without rVFC. Both are requested; whichever fires first cancels the other.
    this.rafId = requestAnimationFrame(() => { this.rafId = null; this.tick(); });
    if (this.isNative() && typeof (this.el as any).requestVideoFrameCallback === 'function') {
      this.vfcId = (this.el as any).requestVideoFrameCallback(() => { this.vfcId = null; this.tick(); });
    }
  }

  private tick(): void {
    this.stopLoop();
    if (!this.playing || this.destroyed) return;
    if (this.isNative()) {
      // Element is the time authority; keep the clock in step for mode switches.
      this.clock.seek(Math.max(0, this.elTime()));
      this.emitTime();
    } else {
      const dur = this.duration();
      const t = this.clock.now();
      if (this.rate < 0 && t <= 0) {
        this.playing = false;
        this.clock.stop();
        this.seekInternal(this.snap(0));
        this.setState('ready');
        this.emitTime();
        return;
      }
      if (this.rate > 0 && dur > 0 && t >= dur) {
        this.playing = false;
        this.clock.stop();
        this.seekInternal(this.snap(dur));
        this.setState('ready');
        for (const cb of this.endedCbs) cb();
        return;
      }
      const frame = secondsToFramesFloor(Math.max(0, t), this.fps);
      if (frame !== this.lastSteppedFrame && !this.seekPending) {
        this.lastSteppedFrame = frame;
        this.seekInternal(this.snap(t));
      }
      this.emitTime();
    }
    this.scheduleTick();
  }

  private emitTime(): void {
    const t = this.currentTime();
    const f = secondsToFramesFloor(t, this.fps);
    for (const cb of this.timeCbs) cb(t, f);
  }

  private setState(s: SourcePlayerState): void {
    if (this.state === s) return;
    this.state = s;
    this.emitState();
  }

  private emitState(): void {
    const st = this.status();
    for (const cb of this.stateCbs) cb(st);
  }

  private clearSrc(): void {
    try {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    } catch { /* ignore */ }
  }
}
