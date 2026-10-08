/**
 * The Program monitor's Cross Dissolve (bugs/closed/2026-10-08-two-sided-transition-preview-mismatch.md): the two
 * layers of a dissolve are added in a scratch canvas (`lighter`, a premultiplied add) and the sum goes over what is
 * below, so the picture is the linear mix (1 − t)·(out over below) + t·(in over below), like the export. Drawn one
 * over the other, as before, the picture dimmed mid-dissolve.
 *
 * The canvas here is a one-pixel model of the 2D context's compositing (premultiplied colour and alpha, globalAlpha,
 * source-over, lighter, save / restore): every layer covers the pixel, so geometry does not matter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip, MediaItem, Sequence } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { MediaElementPool } from '../../src/playback/elementPool';
import { SequencePlayer } from '../../src/playback/sequencePlayer';

/** A video element whose every pixel is `value` (0..1, opaque). */
class FakeVideo {
  constructor(public tag: 'video' | 'audio' = 'video') {}
  value = 0;
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  preload = ''; playsInline = false; muted = false; defaultMuted = false; loop = false; controls = false; disableRemotePlayback = false;
  paused = true; seeking = false; readyState = 0; duration = 600; playbackRate = 1; videoWidth = 1920; videoHeight = 1080;
  error = null; parentNode = null;
  private t = 0;
  get currentTime(): number { return this.t; }
  set currentTime(v: number) { this.t = v; this.seeking = true; }
  set src(v: string) { this.attrs.set('src', v); }
  get src(): string { return this.attrs.get('src') ?? ''; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  addEventListener(type: string, cb: () => void): void { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(cb); }
  removeEventListener(type: string, cb: () => void): void { this.listeners.get(type)?.delete(cb); }
  load(): void { this.readyState = this.attrs.has('src') ? 1 : 0; }
  pause(): void { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  land(): void { if (!this.attrs.has('src')) return; this.seeking = false; this.readyState = 4; for (const cb of this.listeners.get('seeked') ?? []) cb(); }
}

/** One pixel of a 2D canvas: premultiplied value `c` and alpha `a`. */
class PixelCtx {
  c = 0; a = 0;
  globalAlpha = 1;
  globalCompositeOperation: 'source-over' | 'lighter' = 'source-over';
  fillStyle = '#000';
  ops: string[] = [];
  private stack: { globalAlpha: number; op: PixelCtx['globalCompositeOperation'] }[] = [];
  constructor(readonly canvas: { width: number; height: number }) {}
  save(): void { this.stack.push({ globalAlpha: this.globalAlpha, op: this.globalCompositeOperation }); }
  restore(): void { const s = this.stack.pop(); if (s) { this.globalAlpha = s.globalAlpha; this.globalCompositeOperation = s.op; } }
  private put(c: number, a: number): void {
    if (this.globalCompositeOperation === 'lighter') { this.c = Math.min(1, this.c + c); this.a = Math.min(1, this.a + a); }
    else { this.c = c + (1 - a) * this.c; this.a = a + (1 - a) * this.a; }
  }
  fillRect(): void { this.put(0, this.globalAlpha); } // black
  clearRect(): void { this.c = 0; this.a = 0; }
  drawImage(src: FakeVideo | { pixel: PixelCtx }): void {
    const g = this.globalAlpha;
    if (src instanceof FakeVideo) { this.ops.push(`${this.globalCompositeOperation}@${g.toFixed(3)}`); this.put(src.value * g, g); }
    else { this.ops.push(`scratch@${g.toFixed(3)}`); this.put(src.pixel.c * g, src.pixel.a * g); }
  }
  setTransform(): void {} scale(): void {} translate(): void {} rotate(): void {}
  strokeText(): void {} fillText(): void {}
}

let scratch: PixelCtx | null = null;
class FakeOffscreen {
  readonly pixel: PixelCtx;
  constructor(public width: number, public height: number) { this.pixel = new PixelCtx(this); scratch = this.pixel; }
  getContext(): PixelCtx { return this.pixel; }
}

let videos: FakeVideo[] = [];
let rafs: (() => void)[] = [];
let main: PixelCtx;
const runRaf = () => { const cbs = rafs; rafs = []; for (const cb of cbs) cb(); };

beforeEach(() => {
  videos = []; rafs = [];
  vi.stubGlobal('document', { createElement: (tag: string) => { const v = new FakeVideo(tag as 'video'); videos.push(v); return v; } });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafs.push(cb); return rafs.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const FPS = { num: 24, den: 1 };
function mediaItem(id: string): MediaItem {
  return {
    id, name: id, path: `/media/${id}.mp4`, kind: 'video', category: 'Movie', identity: {}, binId: null,
    probe: {
      container: 'mp4', duration: 600, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}
const MEDIA: Record<string, MediaItem> = { A: mediaItem('A'), B: mediaItem('B'), G: mediaItem('G') };
const VALUE: Record<string, number> = { A: 1, B: 0.25, G: 0.5 };
function clip(id: string, mediaId: string, start: number, duration: number, opacity = 1): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn: 1, speed: 1, linkId: null, enabled: true, kind: 'video',
    transform: { ...defaultTransform(), opacity }, audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
  };
}

/** The picture (premultiplied value over the opaque canvas) the player paints at `frame`, playing. */
function paintAt(s: Sequence, frame: number): number {
  const canvas = { width: 0, height: 0, getContext: () => main } as unknown as HTMLCanvasElement;
  main = new PixelCtx(canvas as unknown as { width: number; height: number });
  const player = new SequencePlayer(canvas, new MediaElementPool(8), undefined, { id: 'program' });
  player.setSequence(s, MEDIA, { useProxies: false, playbackResolution: 'full' });
  player.renderFrame(frame);
  for (const v of videos) { v.value = VALUE[Object.keys(VALUE).find((k) => decodeURIComponent(v.src).includes(`/${k}.mp4`))!]; v.land(); }
  player.renderFrame(frame);
  runRaf();
  player.play();
  runRaf();
  player.destroy();
  expect(main.a).toBeCloseTo(1, 9);
  return main.c;
}

describe('Program monitor: a Cross Dissolve is the linear mix of its two clips', () => {
  function dissolve(over?: { opA?: number; opB?: number; below?: boolean }): Sequence {
    const s = createSequence('x', FPS, 1920, 1080);
    const t = over?.below ? 1 : 0;
    if (over?.below) s.videoTracks[0].clips.push(clip('g', 'G', 0, 96));
    s.videoTracks[t].clips.push(clip('o', 'A', 0, 48, over?.opA ?? 1), clip('i', 'B', 48, 48, over?.opB ?? 1));
    s.videoTracks[t].transitions.push({ id: 't', type: 'crossDissolve', duration: 12, outClipId: 'o', inClipId: 'i' });
    return s;
  }

  it('on V1: (1 − t)·out + t·in on every frame of the window, no dimming', () => {
    const s = dissolve();
    for (let f = 42; f < 54; f++) {
      const t = (f - 42) / 12;
      expect(paintAt(s, f), `frame ${f}`).toBeCloseTo((1 - t) * VALUE.A + t * VALUE.B, 9);
    }
    // The pair goes through the scratch canvas: the outgoing layer drawn normally, the incoming one added, the sum over.
    scratch = null;
    paintAt(s, 48);
    expect(new Set(main.ops)).toEqual(new Set(['scratch@1.000']));
    expect(new Set(scratch!.ops)).toEqual(new Set(['source-over@0.500', 'lighter@0.500']));
  });

  it('over a lower track and with opacity: (1 − t)·(out over below) + t·(in over below)', () => {
    const s = dissolve({ opA: 0.6, opB: 0.3, below: true });
    for (const f of [42, 45, 48, 51, 53]) {
      const t = (f - 42) / 12;
      const over = (v: number, op: number) => op * v + (1 - op) * VALUE.G;
      expect(paintAt(s, f), `frame ${f}`).toBeCloseTo((1 - t) * over(VALUE.A, 0.6) + t * over(VALUE.B, 0.3), 9);
    }
  });

  it('a Dip to Black still draws each clip over what is below', () => {
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('o', 'A', 0, 48), clip('i', 'B', 48, 48));
    s.videoTracks[0].transitions.push({ id: 't', type: 'dipToBlack', duration: 12, outClipId: 'o', inClipId: 'i' });
    expect(paintAt(s, 45)).toBeCloseTo(0.5 * VALUE.A, 9);
    expect(paintAt(s, 51)).toBeCloseTo(0.5 * VALUE.B, 9);
    expect(main.ops.some((o) => o.startsWith('scratch') || o.startsWith('lighter'))).toBe(false);
  });

  it('without a scratch canvas the pair is drawn one over the other (the old picture), not lost', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const s = dissolve();
    expect(paintAt(s, 48)).toBeCloseTo(0.5 * VALUE.B + 0.5 * (0.5 * VALUE.A), 9);
  });
});
