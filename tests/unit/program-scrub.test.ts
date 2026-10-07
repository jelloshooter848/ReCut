/**
 * SequencePlayer while scrubbing (paused, playhead moving): seeks are coalesced, only layers composited at the
 * playhead are sought, redundant draws are skipped, and the picture left when the scrub stops is exactly the
 * playhead frame. Fake DOM / WebAudio as in playback-pool.test.ts; the fake <video> behaves like Chromium's: a seek
 * drops readyState to HAVE_METADATA until it lands (nothing can be drawn meanwhile).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip, MediaItem, Sequence } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { MediaElementPool } from '../../src/playback/elementPool';
import { SCRUB_REST_MS, SequencePlayer } from '../../src/playback/sequencePlayer';

// ------------------------------------------------------------------ fake DOM

class FakeMedia {
  constructor(public tag: 'video' | 'audio' = 'video') {
    // Opt-in (withVfc): the tests above model an element without requestVideoFrameCallback.
    if (withVfc && tag === 'video') this.requestVideoFrameCallback = (cb) => { this.vfcs.push(cb); return this.vfcs.length; };
  }
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback(): void { this.vfcs = []; }
  vfcs: (() => void)[] = [];
  /** Source time of the frame the element's compositor holds: what drawImage paints (Chromium updates it off-thread). */
  shown = 0;
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  preload = ''; playsInline = false; muted = false; defaultMuted = false; loop = false; controls = false; disableRemotePlayback = false;
  paused = true; seeking = false; readyState = 0; duration = 600; playbackRate = 1; videoWidth = 1920; videoHeight = 1080;
  error = null; parentNode = null;
  /** currentTime sets, and those made while a previous seek was still pending (queued seeks). */
  seeks = 0; queuedSeeks = 0;
  private t = 0;
  get currentTime(): number { return this.t; }
  set currentTime(v: number) {
    if (this.seeking) this.queuedSeeks++;
    this.t = v; this.seeking = true; this.seeks++;
    if (this.readyState > 1) this.readyState = 1;
  }
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
  /**
   * Complete a pending seek / load: data available at currentTime, 'seeked' fires. `present: false` models the race
   * seen in Chromium under load: 'seeked' fires before the landed frame reaches the compositor (present() later).
   */
  land(present = true): void {
    if (!this.attrs.has('src')) return;
    const was = this.seeking || this.readyState < 2;
    this.seeking = false; this.readyState = 4;
    if (present) this.present();
    if (was) for (const cb of [...(this.listeners.get('seeked') ?? [])]) cb();
  }
  /** The frame at currentTime reaches the compositor; video frame callbacks run in the next rendering step. */
  present(): void {
    this.shown = this.t;
    const cbs = this.vfcs; this.vfcs = [];
    for (const cb of cbs) rafs.push(cb);
  }
}

let media: FakeMedia[] = [];
let withVfc = false;
/** Every drawImage of a video: the element, its currentTime and the source time of the frame it painted. */
let drawn: { el: FakeMedia; t: number; shown: number }[] = [];
let fills = 0;
let rafs: (() => void)[] = [];
let now = 1000;

class FakeParam { value = 0; setTargetAtTime(v: number): void { this.value = v; } }
class FakeNode { connect(n: FakeNode): FakeNode { return n; } disconnect(): void { /* */ } }
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeAudioContext {
  destination = new FakeNode(); currentTime = 0; state = 'running';
  createGain(): FakeGain { return new FakeGain(); }
  createMediaElementSource(): FakeNode { const n = new FakeNode(); (n as unknown as { context: unknown }).context = this; return n; }
  resume(): Promise<void> { return Promise.resolve(); }
}

function fakeCanvas(): HTMLCanvasElement {
  const ctx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'drawImage') return (el: FakeMedia) => { drawn.push({ el, t: el.currentTime, shown: el.shown }); };
      if (k === 'fillRect') return () => { fills++; };
      return () => {};
    },
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  media = []; drawn = []; fills = 0; rafs = []; now = 1000; withVfc = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('document', { createElement: (tag: string) => { if (tag !== 'video' && tag !== 'audio') throw new Error(tag); const v = new FakeMedia(tag); media.push(v); return v; } });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafs.push(cb); return rafs.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Run the pending animation frame (one display frame, 16 ms later). */
function frame(): void { now += 16; const cbs = rafs; rafs = []; for (const cb of cbs) cb(); }
/** Let the playhead rest: past SCRUB_REST_MS, then the rAF the rest timer asks for. */
function rest(): void { now += SCRUB_REST_MS + 10; vi.advanceTimersByTime(SCRUB_REST_MS + 10); frame(); }
const videos = () => media.filter((m) => m.tag === 'video');
const audios = () => media.filter((m) => m.tag === 'audio');
const byFile = (name: string, tag: 'video' | 'audio' = 'video') => media.find((m) => m.tag === tag && m.src.endsWith(`%2F${name}.mp4`))!;
const landAll = () => { for (const m of media) m.land(); };

// ------------------------------------------------------------------ fixtures

const FPS = { num: 24, den: 1 };
function mediaItem(id: string): MediaItem {
  return {
    id, name: id, path: `/media/${id}.mp4`, kind: 'video', category: 'Movie', identity: {}, binId: null,
    probe: {
      container: 'mp4', duration: 600, size: 1, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
      subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}
const MEDIA: Record<string, MediaItem> = { A: mediaItem('A'), B: mediaItem('B'), C: mediaItem('C'), D: mediaItem('D') };
function clip(id: string, mediaId: string, start: number, duration: number, sourceIn: number, kind: Clip['kind']): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn, speed: 1, linkId: null, enabled: true, kind,
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
  };
}
/** Three stacked full-frame video tracks (A under B under C) and linked audio, 4,800 frames long, from source 10 s. */
function stackSequence(): Sequence {
  const s = createSequence('stack', FPS, 1920, 1080);
  ['A', 'B', 'C'].forEach((m, i) => {
    s.videoTracks[i].clips.push(clip(`v${m}`, m, 0, 4800, 10, 'video'));
    s.audioTracks[i].clips.push(clip(`a${m}`, m, 0, 4800, 10, 'audio'));
  });
  return s;
}
/** Element time the player targets for a timeline frame of the stack: frame-centered source time. */
const target = (f: number) => 10 + f / 24 + 0.5 / 24;
const SETTINGS = { useProxies: false, playbackResolution: 'full' as const };

function setup(seq = stackSequence()) {
  const pool = new MediaElementPool(16);
  const player = new SequencePlayer(fakeCanvas(), pool, new FakeAudioContext() as unknown as AudioContext, { id: 'program' });
  player.setSequence(seq, MEDIA, SETTINGS);
  player.renderFrame(0); landAll(); frame();
  for (const m of media) { m.seeks = 0; m.queuedSeeks = 0; }
  drawn = []; fills = 0;
  return { pool, player };
}

// ------------------------------------------------------------------ tests

describe('SequencePlayer scrubbing', () => {
  it('coalesces seeks: none is queued behind a pending one; when it lands the element goes to the latest playhead', () => {
    const { player } = setup();
    const top = byFile('C');
    for (let f = 10; f <= 300; f += 10) { player.seek(f); frame(); } // 30 scrub steps, the seek never lands
    expect(top.seeks).toBe(1);
    expect(top.queuedSeeks).toBe(0);
    expect(top.currentTime).toBeCloseTo(target(10), 9);
    top.land(); // 'seeked': the landed frame is drawn, then the element is sent on to the playhead without waiting a frame
    expect(drawn.map((d) => d.el)).toEqual([top]);
    expect(drawn[0].t).toBeCloseTo(target(10), 9);
    expect(top.seeks).toBe(2);
    expect(top.currentTime).toBeCloseTo(target(300), 9);
    for (const m of media) expect(m.queuedSeeks).toBe(0);
    player.destroy();
  });

  it('seeks only the layers composited at the playhead; occluded layers and audio are parked once it rests', () => {
    const { player } = setup();
    for (let f = 24; f <= 24 * 20; f += 24) { player.seek(f); frame(); byFile('C').land(); }
    expect(byFile('C').seeks).toBe(20);
    expect(byFile('A').seeks + byFile('B').seeks).toBe(0); // under C, which covers the frame
    expect(audios().reduce((n, a) => n + a.seeks, 0)).toBe(0); // silent while paused anyway
    rest();
    for (const m of [byFile('A'), byFile('B'), byFile('A', 'audio'), byFile('B', 'audio'), byFile('C', 'audio')]) {
      expect(m.seeks).toBe(1);
      expect(m.currentTime).toBeCloseTo(m.tag === 'video' ? target(480) : 10 + 480 / 24, 9);
    }
    player.destroy();
  });

  it('seeks every layer that shows (picture in picture) and draws them together once both landed', () => {
    const seq = stackSequence();
    seq.videoTracks[2].clips[0].transform.scale = 0.5; // C no longer covers: B shows around it, A stays hidden
    const { player } = setup(seq);
    player.seek(48); frame();
    expect([byFile('A').seeks, byFile('B').seeks, byFile('C').seeks]).toEqual([0, 1, 1]);
    byFile('C').land();
    player.seek(96); frame();
    expect(drawn).toHaveLength(0); // B is still seeking: no half-updated picture
    expect(byFile('C').seeks).toBe(1); // held for the round, not sent ahead alone
    byFile('B').land();
    expect(drawn.map((d) => d.el)).toEqual([byFile('B'), byFile('C')]);
    expect(drawn.every((d) => Math.abs(d.t - target(48)) < 1e-9)).toBe(true);
    expect([byFile('B').currentTime, byFile('C').currentTime].every((t) => Math.abs(t - target(96)) < 1e-9)).toBe(true);
    player.destroy();
  });

  it('keeps the last picture while a seek is pending and skips redundant draws', () => {
    const { player } = setup();
    player.seek(100); frame();
    expect(fills).toBe(0); // no black frame while the top layer seeks
    byFile('C').land();
    expect(fills).toBe(1);
    expect(drawn.map((d) => d.el)).toEqual([byFile('C')]);
    frame(); frame();
    rest(); // occluded layers and audio are parked; their 'seeked' events do not redraw the same picture
    landAll(); frame(); frame();
    expect(fills).toBe(1);
    player.destroy();
  });

  it('when the scrub stops, the picture is exactly the frame at the playhead', () => {
    // Pseudo-random scrub over a 3-clip cut sequence; seeks land late and out of step with the playhead.
    const seq = createSequence('cuts', FPS, 1920, 1080);
    for (let i = 0; i < 12; i++) seq.videoTracks[0].clips.push(clip(`c${i}`, 'ABD'[i % 3], i * 100, 100, 3 + i * 7, 'video'));
    const { player } = setup(seq);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let f = 0;
    for (let step = 0; step < 200; step++) {
      f = Math.floor(rnd() * 1200);
      player.seek(f); frame();
      for (const v of videos()) if (rnd() < 0.3) v.land();
    }
    // Stop: let every pending seek land, then the rest update.
    for (let i = 0; i < 5; i++) { landAll(); frame(); }
    rest(); landAll(); frame();
    const c = seq.videoTracks[0].clips[Math.floor(f / 100)];
    const want = c.sourceIn + (f - c.start) / 24 + 0.5 / 24;
    const last = drawn[drawn.length - 1];
    expect(last.el.src.endsWith(`%2F${c.mediaId}.mp4`)).toBe(true);
    expect(last.t).toBeCloseTo(want, 9);
    // Same as a direct (non-scrub) render of that frame in a fresh player.
    const fresh = new SequencePlayer(fakeCanvas(), new MediaElementPool(16), undefined, { id: 'x' });
    fresh.setSequence(seq, MEDIA, SETTINGS);
    drawn = [];
    fresh.renderFrame(f); landAll(); fresh.renderFrame(f);
    expect(drawn[drawn.length - 1].t).toBeCloseTo(last.t, 9);
    fresh.destroy();
    player.destroy();
  });

  it('a single seek (click, arrow key) shows the new frame as soon as its seek lands', () => {
    const { player } = setup();
    player.seek(240); frame();
    byFile('C').land();
    expect(drawn.map((d) => d.el)).toEqual([byFile('C')]);
    expect(drawn[0].t).toBeCloseTo(target(240), 9);
    player.destroy();
  });

  it('playback after a scrub syncs every element as before', () => {
    const { player } = setup();
    for (let f = 10; f <= 100; f += 10) { player.seek(f); frame(); }
    player.play();
    frame();
    // Native playback: every planned element (occluded ones and audio included) plays from the playhead.
    for (const m of media) expect(m.paused).toBe(false);
    player.pause();
    player.destroy();
  });
});

describe("SequencePlayer: the landed frame reaches the compositor after 'seeked'", () => {
  // bugs/closed/2026-10-07-program-stale-frame-after-seek.md: under load Chromium fires 'seeked' (readyState 4, not
  // seeking) before the landed frame is in the element's compositor, so a draw at 'seeked' paints the previous frame.
  // The picture was keyed on currentTime, so that stale frame stayed on screen at rest.

  /** V1: 1-3 s of A at frames 0-47, 5-7 s of A at 48-95: both clips share one pooled element (program.spec.ts:327). */
  function cutSequence(): Sequence {
    const s = createSequence('cut', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('c0', 'A', 0, 48, 1, 'video'), clip('c1', 'A', 48, 48, 5, 'video'));
    return s;
  }
  const cutTarget = (f: number) => (f < 48 ? 1 + f / 24 : 5 + (f - 48) / 24) + 0.5 / 24;
  const lastShown = () => drawn[drawn.length - 1].shown;

  it('a cut back to the first clip of the same file repaints once the landed frame is presented', () => {
    withVfc = true;
    const { player } = setup(cutSequence());
    const el = videos()[0];
    expect(videos()).toHaveLength(1);
    player.seek(70); frame(); el.land(); frame(); rest();
    expect(lastShown()).toBeCloseTo(cutTarget(70), 9);
    player.seek(10); frame();
    el.land(false); // 'seeked' fires; the compositor still holds the 5.9 s frame
    expect(lastShown()).toBeCloseTo(cutTarget(70), 9); // the stale draw (what the e2e test caught)
    frame(); rest();
    el.present(); frame(); frame();
    expect(drawn[drawn.length - 1].t).toBeCloseTo(cutTarget(10), 9);
    expect(lastShown()).toBeCloseTo(cutTarget(10), 9);
    player.destroy();
  });

  it('a seek that lands after the playhead rests repaints once the landed frame is presented', () => {
    withVfc = true;
    const { player } = setup();
    const top = byFile('C');
    player.seek(240); frame(); rest();
    for (const m of media) if (m !== top) m.land(); // the occluded layers and audio, parked by the rest update
    top.land(false); frame();
    expect(lastShown()).toBeCloseTo(target(0), 9); // the stale draw: the frame shown before the seek
    top.present(); frame(); frame();
    expect(lastShown()).toBeCloseTo(target(240), 9);
    player.destroy();
  });

  it('stops asking for video frames when the player is destroyed', () => {
    withVfc = true;
    const { player } = setup();
    expect(videos().every((v) => v.vfcs.length === 1)).toBe(true);
    player.destroy();
    expect(videos().every((v) => v.vfcs.length === 0)).toBe(true);
  });
});
