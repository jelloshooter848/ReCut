/**
 * SequencePlayer draws while playing only when the picture changes: a painted layer's element presents a new frame,
 * a transition ramps its alpha, a subtitle cue appears or goes. Not on every rAF tick, not on a timeline frame alone,
 * and not when an occluded layer (still decoding below an opaque top layer) advances. Keying on those redrew the same
 * picture two to three times per media frame (about 55 draws/s instead of 24 with three video tracks in the perf
 * bench), each a drawImage plus the canvas paint, layerization and raster of a frame: part of the long tasks of the
 * bench's "long tasks after 20 switches + 10 maximize cycles" playback row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip, MediaItem, Sequence } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { MediaElementPool } from '../../src/playback/elementPool';
import { SequencePlayer } from '../../src/playback/sequencePlayer';

class FakeVideo {
  constructor(public tag: 'video' | 'audio' = 'video') {}
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  preload = ''; playsInline = false; muted = false; defaultMuted = false; loop = false; controls = false; disableRemotePlayback = false;
  paused = true; seeking = false; readyState = 0; duration = 600; playbackRate = 1; videoWidth = 1920; videoHeight = 1080;
  error = null; parentNode = null;
  private t = 0;
  get currentTime(): number { return this.t; }
  set currentTime(v: number) { this.t = v; this.seeking = true; }
  /** Native playback moving on: the element presents `frames` more frames (no seek). */
  advance(frames: number): void { this.t += frames / 24; }
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
  land(): void { if (!this.attrs.has('src')) return; const was = this.seeking; this.seeking = false; this.readyState = 4; if (was) for (const cb of this.listeners.get('seeked') ?? []) cb(); }
}

let videos: FakeVideo[] = [];
let drawn: FakeVideo[] = [];
let texts: string[] = [];
let rafs: (() => void)[] = [];
let now = 1000;
const runRaf = () => { const cbs = rafs; rafs = []; for (const cb of cbs) cb(); };

/** Width of one character in the fake canvas's measureText. */
const CHAR_PX = 40;

function fakeCanvas(): HTMLCanvasElement {
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'drawImage' ? (el: FakeVideo) => { drawn.push(el); } : k === 'fillText' ? (t: string) => { texts.push(t); }
      : k === 'measureText' ? (t: string) => ({ width: t.length * CHAR_PX }) : () => {}),
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  videos = []; drawn = []; texts = []; rafs = []; now = 1000;
  vi.stubGlobal('document', { createElement: (tag: string) => { const v = new FakeVideo(tag as 'video'); videos.push(v); return v; } });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafs.push(cb); return rafs.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now);
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
const MEDIA: Record<string, MediaItem> = { A: mediaItem('A'), B: mediaItem('B'), C: mediaItem('C') };
function clip(id: string, mediaId: string, start: number, duration: number, sourceIn: number): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn, speed: 1, linkId: null, enabled: true, kind: 'video',
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
  };
}
const SETTINGS = { useProxies: false, playbackResolution: 'full' as const };
const byFile = (f: string) => videos.find((v) => v.src.includes(`${f}.mp4`))!;

/** Start playing `s` at `frame` with every element landed; returns the player with the draw log cleared. */
function playing(s: Sequence, frame: number): SequencePlayer {
  const player = new SequencePlayer(fakeCanvas(), new MediaElementPool(8), undefined, { id: 'program' });
  player.setSequence(s, MEDIA, SETTINGS);
  player.renderFrame(frame); for (const v of videos) v.land(); player.renderFrame(frame);
  runRaf();
  player.play();
  runRaf(); // the first playing tick draws
  drawn = []; texts = [];
  return player;
}
/** One timeline frame later (24 fps), with these elements having presented their next frame. */
const nextFrame = (...advanced: FakeVideo[]) => { now += 1000 / 24; for (const v of advanced) v.advance(1); runRaf(); };

describe('SequencePlayer draws while playing', () => {
  it('draws once per new frame of the painted layer; occluded layers advancing and extra rAF ticks do not redraw', () => {
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('v1', 'A', 0, 240, 1));
    s.videoTracks[1].clips.push(clip('v2', 'B', 0, 240, 1));
    s.videoTracks[2].clips.push(clip('v3', 'C', 0, 240, 1));
    const player = playing(s, 10);
    const [a, b, c] = [byFile('A'), byFile('B'), byFile('C')];
    for (let i = 0; i < 24; i++) {
      // Out of phase like real decoders: the occluded layers present their frames on other rAF ticks.
      now += 1000 / 72; a.advance(1); runRaf();
      now += 1000 / 72; b.advance(1); runRaf();
      now += 1000 / 72; c.advance(1); runRaf();
    }
    expect(drawn.length).toBe(24); // one second: 24 pictures, all of the top layer
    expect(drawn.every((v) => v === c)).toBe(true);
    player.destroy();
  });

  it('a timeline frame without a new media frame is the same picture', () => {
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('v1', 'A', 0, 240, 1));
    const player = playing(s, 10);
    nextFrame();
    expect(drawn).toHaveLength(0);
    nextFrame(byFile('A'));
    expect(drawn).toHaveLength(1);
    player.destroy();
  });

  it('redraws every timeline frame of a cross dissolve (the alphas ramp) even when the media frames hold', () => {
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('o', 'A', 0, 48, 1), clip('i', 'B', 48, 48, 1));
    s.videoTracks[0].transitions.push({ id: 't', type: 'crossDissolve', duration: 12, outClipId: 'o', inClipId: 'i' });
    const player = playing(s, 44); // inside the transition (42..54)
    for (const v of videos) v.land();
    nextFrame(); nextFrame(); nextFrame();
    expect(drawn.length).toBeGreaterThanOrEqual(3 * 2); // both layers, each frame
    player.destroy();
  });

  it('redraws when a subtitle cue appears or goes, not in between', () => {
    // A 1 fps file: its element stays on one media frame across frames 10-16 (drift re-seeks included), so only the
    // cue can change the picture.
    const media = { ...MEDIA, S: { ...mediaItem('S'), probe: { ...mediaItem('S').probe!, video: { ...mediaItem('S').probe!.video!, fps: { num: 1, den: 1 }, avgFps: { num: 1, den: 1 } } } } };
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('v1', 'S', 0, 240, 2.1));
    s.subtitleTracks.push({ id: 'st', name: 'EN', language: 'en', enabled: true, cues: [{ id: 'c1', start: 13, duration: 3, offset: 0, text: 'Hello' }] });
    const player = new SequencePlayer(fakeCanvas(), new MediaElementPool(8), undefined, { id: 'program' });
    player.setSequence(s, media, SETTINGS);
    player.renderFrame(10); for (const v of videos) v.land(); player.renderFrame(10);
    runRaf(); player.play(); runRaf();
    drawn = []; texts = [];
    nextFrame(); nextFrame();         // frames 11, 12: no cue, same media frame
    expect(drawn).toHaveLength(0);
    nextFrame();                       // frame 13: the cue appears
    expect(drawn).toHaveLength(1);
    expect(texts).toContain('Hello');
    nextFrame(); nextFrame();         // 14, 15: same cue, same media frame
    expect(drawn).toHaveLength(1);
    nextFrame();                       // 16: the cue goes
    expect(drawn).toHaveLength(2);
    player.destroy();
  });

  it('wraps a long cue onto lines that fit the frame (#114)', () => {
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('v1', 'S', 0, 240, 2.1));
    const text = 'So you remember it used to be well if you saw the first video you remember it was mounted to a piece of plywood';
    s.subtitleTracks.push({ id: 'st', name: 'EN', language: 'en', enabled: true, cues: [{ id: 'c1', start: 0, duration: 100, offset: 0, text }] });
    const player = new SequencePlayer(fakeCanvas(), new MediaElementPool(8), undefined, { id: 'program' });
    player.setSequence(s, MEDIA, SETTINGS);
    texts = [];
    player.renderFrame(10); for (const v of videos) v.land(); player.renderFrame(10);
    const lines = [...new Set(texts)].reverse(); // drawn bottom line first
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text);
    for (const l of lines) expect(l.length * CHAR_PX).toBeLessThanOrEqual(1920 * 0.84);
    player.destroy();
  });
});
