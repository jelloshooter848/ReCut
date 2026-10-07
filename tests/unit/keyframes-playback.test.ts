/**
 * Keyframes in the preview (Roadmap §11): the planner evaluates keyframed position / scale / opacity / level per frame
 * (and nothing for clips without keyframes), the Program monitor redraws a keyframed still on every timeline frame,
 * and a keyframed level is ramped on its GainNode between ticks so it follows the curve the export evaluates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip, Keyframe, MediaItem, Sequence } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { evaluateClipProperty, evaluateKeyframes } from '../../shared/keyframes';
import { planFrame, fadeEnvelope } from '../../src/playback/planner';
import { MediaElementPool } from '../../src/playback/elementPool';
import { KEYFRAME_RAMP_SEC, SequencePlayer } from '../../src/playback/sequencePlayer';

const FPS = { num: 24, den: 1 };
const kf = (frame: number, value: number, interp?: 'ease'): Keyframe => (interp ? { frame, value, interp } : { frame, value });

function mediaItem(id: string, over: Partial<MediaItem> = {}): MediaItem {
  return {
    id, name: id, path: `/media/${id}.mp4`, kind: 'video', category: 'Movie', identity: {}, binId: null,
    probe: {
      container: 'mp4', duration: 600, size: 1, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
      subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
    ...over,
  };
}
function clip(id: string, mediaId: string, start: number, duration: number, over: Partial<Clip> = {}): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn: 1, speed: 1, linkId: null, enabled: true, kind: 'video',
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
    ...over,
  };
}
const STILL: MediaItem = mediaItem('P', {
  path: '/media/P.png', kind: 'image',
  probe: { container: 'png_pipe', duration: 0, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true, video: { index: 0, codec: 'png', width: 1000, height: 500, fps: { num: 25, den: 1 }, avgFps: { num: 25, den: 1 }, isVfr: false } },
});
const MEDIA: Record<string, MediaItem> = { A: mediaItem('A'), P: STILL };

describe('planner', () => {
  it('evaluates keyframed position, scale and opacity per frame; opacity times the transition weight', () => {
    const s = createSequence('s', FPS, 1920, 1080);
    const c = clip('c', 'A', 100, 48);
    c.transform.keyframes = { x: [kf(0, -200), kf(24, 200, 'ease')], scale: [kf(0, 1), kf(24, 2)], opacity: [kf(0, 0), kf(12, 1)] };
    c.transform.rotation = 10;
    s.videoTracks[0].clips.push(c);
    s.videoTracks[0].transitions.push({ id: 't', type: 'crossDissolve', duration: 8, outClipId: 'c', inClipId: null });
    for (const f of [100, 106, 112, 118, 124, 140, 145]) {
      const [layer] = planFrame(s, MEDIA, f, false).layers;
      expect(layer.animated).toBe(true);
      expect(layer.transform.x).toBe(evaluateKeyframes(c.transform.keyframes.x!, f - 100));
      expect(layer.transform.scale).toBe(evaluateKeyframes(c.transform.keyframes.scale!, f - 100));
      expect(layer.transform.rotation).toBe(10);
      const fadeOut = f >= 140 ? (148 - f) / 8 : 1; // single-sided transition at the clip end
      expect(layer.alpha).toBeCloseTo(Math.min(1, evaluateKeyframes(c.transform.keyframes.opacity!, f - 100)) * fadeOut, 12);
    }
  });

  it('a clip without keyframes keeps its own transform object and gets no gain curve (no cost)', () => {
    const s = createSequence('s', FPS, 1920, 1080);
    const v = clip('v', 'A', 0, 48);
    const a = clip('a', 'A', 0, 48, { kind: 'audio' });
    s.videoTracks[0].clips.push(v);
    s.audioTracks[0].clips.push(a);
    const plan = planFrame(s, MEDIA, 10, false);
    expect(plan.layers[0].transform).toBe(v.transform);
    expect('animated' in plan.layers[0]).toBe(false);
    expect('gainAt' in plan.audio[0]).toBe(false);
  });

  it('keyframed level: gain = clip gain × level × fade, gainAt follows it at fractional frames', () => {
    const s = createSequence('s', FPS, 1920, 1080);
    const a = clip('a', 'A', 48, 96, { kind: 'audio' });
    a.audio = { ...defaultAudio(), gain: -6, fadeIn: 12, keyframes: { volume: [kf(0, 1), kf(48, 0.25, 'ease'), kf(72, 2)] } };
    s.audioTracks[0].clips.push(a);
    for (const f of [48, 54, 60, 90, 110, 130, 143]) {
      const [p] = planFrame(s, MEDIA, f, false).audio;
      const expected = Math.pow(10, -6 / 20) * evaluateClipProperty('volume', a, f) * fadeEnvelope(a, f);
      expect(p.gain).toBeCloseTo(expected, 12);
      expect(p.gainAt!(f + 0.5)).toBeCloseTo(Math.pow(10, -6 / 20) * evaluateClipProperty('volume', a, f + 0.5) * fadeEnvelope(a, f + 0.5), 12);
    }
  });

  it('speed-changed clips: keyframes stay on timeline frames', () => {
    const s = createSequence('s', FPS, 1920, 1080);
    const c = clip('c', 'A', 0, 48, { speed: 2.5 });
    c.transform.keyframes = { y: [kf(0, 0), kf(48, 96)] };
    s.videoTracks[0].clips.push(c);
    expect(planFrame(s, MEDIA, 24, false).layers[0].transform.y).toBe(48);
    expect(planFrame(s, MEDIA, 24, false).layers[0].sourceTime).toBe(1 + 2.5);
  });
});

// ------------------------------------------------------------------ player (fake DOM and Web Audio)

class FakeEl {
  constructor(public tag: string) {}
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  preload = ''; playsInline = false; muted = false; defaultMuted = false; loop = false; controls = false; disableRemotePlayback = false;
  paused = true; seeking = false; readyState = 0; duration = 600; playbackRate = 1; videoWidth = 1920; videoHeight = 1080;
  naturalWidth = 1000; naturalHeight = 500; complete = true; onload: (() => void) | null = null; onerror: (() => void) | null = null;
  error = null; parentNode = null; decoding = '';
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

interface ParamCall { kind: string; value: number; time: number }
class FakeParam {
  value = 0;
  calls: ParamCall[] = [];
  setTargetAtTime(v: number, t: number) { this.calls.push({ kind: 'target', value: v, time: t }); this.value = v; }
  setValueAtTime(v: number, t: number) { this.calls.push({ kind: 'set', value: v, time: t }); this.value = v; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push({ kind: 'ramp', value: v, time: t }); }
  cancelScheduledValues(t: number) { this.calls.push({ kind: 'cancel', value: NaN, time: t }); }
}
class FakeNode { connect() {} disconnect() {} }
class FakeGain extends FakeNode { gain = new FakeParam(); }
let gains: FakeGain[] = [];
const fakeAudio = () => ({
  currentTime: 5, destination: new FakeNode(),
  createGain: () => { const g = new FakeGain(); gains.push(g); return g; },
  createMediaElementSource: () => { const n = new FakeNode() as FakeNode & { context?: unknown }; return n; },
}) as unknown as AudioContext;

let els: FakeEl[] = [];
let drawn: unknown[] = [];
let rafs: (() => void)[] = [];
let now = 1000;
const runRaf = () => { const cbs = rafs; rafs = []; for (const cb of cbs) cb(); };
function fakeCanvas(): HTMLCanvasElement {
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'drawImage' ? (el: unknown) => { drawn.push(el); } : () => {}), set: () => true });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  els = []; drawn = []; rafs = []; now = 1000; gains = [];
  vi.stubGlobal('document', { createElement: (tag: string) => { const v = new FakeEl(tag); els.push(v); return v; } });
  vi.stubGlobal('Image', class extends FakeEl { constructor() { super('img'); els.push(this); } });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafs.push(cb); return rafs.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const SETTINGS = { useProxies: false, playbackResolution: 'full' as const };

describe('SequencePlayer with keyframes', () => {
  it('redraws a keyframed still on every timeline frame while playing (a static still draws once)', () => {
    const s = createSequence('x', FPS, 1920, 1080);
    const moving = clip('m', 'P', 0, 240);
    moving.transform.keyframes = { x: [kf(0, 0), kf(240, 480)] };
    s.videoTracks[0].clips.push(moving);
    const player = new SequencePlayer(fakeCanvas(), new MediaElementPool(8), undefined, { id: 'program' });
    player.setSequence(s, MEDIA, SETTINGS);
    player.renderFrame(10); runRaf();
    player.play(); runRaf();
    drawn = [];
    for (let i = 0; i < 6; i++) { now += 1000 / 24; runRaf(); }
    expect(drawn.length).toBe(6);
    player.destroy();

    const s2 = createSequence('y', FPS, 1920, 1080);
    s2.videoTracks[0].clips.push(clip('still', 'P', 0, 240));
    const p2 = new SequencePlayer(fakeCanvas(), new MediaElementPool(8), undefined, { id: 'program2' });
    p2.setSequence(s2, MEDIA, SETTINGS);
    p2.renderFrame(10); runRaf();
    p2.play(); runRaf();
    drawn = [];
    for (let i = 0; i < 6; i++) { now += 1000 / 24; runRaf(); }
    expect(drawn.length).toBe(0);
    p2.destroy();
  });

  it('ramps a keyframed level to the curve value one look-ahead past the exact clock position; a static level uses a target', () => {
    const s = createSequence('x', FPS, 1920, 1080);
    const ramp = clip('r', 'A', 0, 240, { kind: 'audio' });
    ramp.audio = { ...defaultAudio(), keyframes: { volume: [kf(0, 0), kf(48, 1, 'ease')] } };
    s.audioTracks[0].clips.push(ramp);
    s.audioTracks[0].volume = 0.5;
    const ctx = fakeAudio();
    const player = new SequencePlayer(fakeCanvas(), new MediaElementPool(8), ctx, { id: 'program' });
    player.setSequence(s, MEDIA, SETTINGS);
    player.renderFrame(12); for (const e of els) e.land(); player.renderFrame(12); runRaf();
    player.play(); runRaf();
    for (const e of els) e.land();
    now += 10; runRaf(); // settled: this tick ramps
    const g = gains.find((x) => x.gain.calls.some((c) => c.kind === 'ramp'));
    expect(g).toBeDefined();
    const calls = g!.gain.calls;
    const last = calls[calls.length - 1];
    expect(last.kind).toBe('ramp');
    expect(last.time).toBeCloseTo(5 + KEYFRAME_RAMP_SEC, 9);
    // the playhead is 10 ms past frame 12 (+ the 1 µs seek bias); the ramp aims KEYFRAME_RAMP_SEC further
    const f = 12 + (0.010 + 1e-6 + KEYFRAME_RAMP_SEC) * 24;
    expect(last.value).toBeCloseTo(0.5 * evaluateKeyframes(ramp.audio.keyframes!.volume!, f), 6);
    expect(calls[calls.length - 3].kind).toBe('cancel');
    player.pause(); runRaf();
    player.destroy();
  });
});
