/**
 * SequencePlayer element pooling and audio graph lifetime, with a fake DOM / WebAudio (node has neither).
 *
 * Regression for the 2,500-clip perf report (bugs/open/2026-10-05-perf-budgets-2500-clips.md, "Also recorded"):
 * elements were pooled per clip, so every clip boundary crossed while scrubbing or playing created a new <video>,
 * a new MediaElementAudioSourceNode and a new GainNode (7,471 elements after 10 s of playback, sources and gains
 * growing on every sequence switch; P-12). Elements are now lent per (file, kind, slot) and reused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip, MediaItem, Sequence } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { MediaElementPool } from '../../src/playback/elementPool';
import { SequencePlayer } from '../../src/playback/sequencePlayer';

// ------------------------------------------------------------------ fake DOM

class FakeVideo {
  constructor(public tag: 'video' | 'audio' = 'video') {}
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  preload = ''; playsInline = false; muted = false; defaultMuted = false; loop = false; controls = false; disableRemotePlayback = false;
  paused = true; seeking = false; readyState = 0; duration = 600; playbackRate = 1; videoWidth = 1920; videoHeight = 1080;
  error = null; parentNode = null;
  private t = 0;
  get currentTime(): number { return this.t; }
  set currentTime(v: number) { this.t = v; this.seeking = true; seeks++; }
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
  /** Complete a pending seek / load: data available at currentTime. */
  land(): void {
    if (!this.attrs.has('src')) return;
    const was = this.seeking;
    this.seeking = false; this.readyState = 4;
    if (was) for (const cb of this.listeners.get('seeked') ?? []) cb();
  }
}

let videos: FakeVideo[] = [];
let seeks = 0;
const claimed = new WeakSet<object>(); // an element can feed only one MediaElementAudioSourceNode, ever

class FakeParam { value = 0; setTargetAtTime(v: number): void { this.value = v; } }
class FakeNode {
  out = new Set<FakeNode>();
  connect(n: FakeNode): FakeNode { this.out.add(n); return n; }
  disconnect(): void { this.out.clear(); }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeSource extends FakeNode { constructor(public mediaElement: FakeVideo, public context: FakeAudioContext) { super(); } }
class FakeAudioContext {
  destination = new FakeNode(); currentTime = 0; state = 'running';
  gains: FakeGain[] = []; sources: FakeSource[] = [];
  createGain(): FakeGain { const g = new FakeGain(); this.gains.push(g); return g; }
  createMediaElementSource(el: FakeVideo): FakeSource {
    if (claimed.has(el)) throw new Error('InvalidStateError: already connected to a source node');
    claimed.add(el);
    const s = new FakeSource(el, this); this.sources.push(s); return s;
  }
  resume(): Promise<void> { return Promise.resolve(); }
}

let drawn: unknown[] = [];
function fakeCanvas(): HTMLCanvasElement {
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'drawImage' ? (el: unknown) => { drawn.push(el); } : () => {}),
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  videos = []; seeks = 0; drawn = [];
  vi.stubGlobal('document', { createElement: (tag: string) => { if (tag !== 'video' && tag !== 'audio') throw new Error(tag); const v = new FakeVideo(tag); videos.push(v); return v; } });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

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
const MEDIA: Record<string, MediaItem> = { A: mediaItem('A'), B: mediaItem('B'), C: mediaItem('C') };
function clip(id: string, mediaId: string, start: number, duration: number, sourceIn: number, kind: Clip['kind'], scale = 1): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn, speed: 1, linkId: null, enabled: true, kind,
    transform: { ...defaultTransform(), scale }, audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
  };
}
/** 120 back-to-back 24-frame clips cycling over three files, on V1 and A1. */
function cutSequence(tag: string): Sequence {
  const s = createSequence(tag, FPS, 1920, 1080);
  for (let i = 0; i < 120; i++) {
    const m = 'ABC'[i % 3];
    s.videoTracks[0].clips.push(clip(`${tag}v${i}`, m, i * 24, 24, 5 + i, 'video'));
    s.audioTracks[0].clips.push(clip(`${tag}a${i}`, m, i * 24, 24, 5 + i, 'audio'));
  }
  return s;
}
const SETTINGS = { useProxies: false, playbackResolution: 'full' as const };
const landAll = () => { for (const v of videos) v.land(); };

function setup(capacity = 16, id: string | null = 'program') {
  const pool = new MediaElementPool(capacity);
  const ac = new FakeAudioContext();
  const player = new SequencePlayer(fakeCanvas(), pool, ac as unknown as AudioContext, id === null ? {} : { id });
  return { pool, ac, player };
}

// ------------------------------------------------------------------ tests

describe('SequencePlayer element pooling', () => {
  it('scrubbing across 120 cuts reuses one element per file and kind instead of one per clip', () => {
    const { pool, ac, player } = setup();
    const s = cutSequence('s');
    player.setSequence(s, MEDIA, SETTINGS);
    for (let i = 0; i < 120; i++) { player.renderFrame(i * 24 + 12); landAll(); }
    // 3 files x (video + audio); per-clip pooling created 240 elements, 120 source nodes and 120 + tracks gains.
    expect(pool.stats.created).toBe(6);
    expect(videos.map((v) => v.tag).sort()).toEqual(['audio', 'audio', 'audio', 'video', 'video', 'video']); // sound: no 2nd video decoder
    expect(ac.sources).toHaveLength(3);
    expect(ac.gains).toHaveLength(1 + 3); // master + one per audio element (no per-clip, no per-track gains)
    player.destroy();
  });

  it('a reused element lands on the new clip\'s source time and is not drawn until its seek completes', () => {
    const { player } = setup();
    const s = cutSequence('s');
    player.setSequence(s, MEDIA, SETTINGS);
    player.renderFrame(12); landAll(); player.renderFrame(12);
    const elA = drawn[drawn.length - 1] as FakeVideo;
    expect(elA).toBeInstanceOf(FakeVideo);
    // clip 3 is file A again, 4 s later in the source: same element, one seek.
    drawn = [];
    player.renderFrame(3 * 24 + 12);
    expect(elA.seeking).toBe(true);
    expect(drawn).not.toContain(elA); // still shows clip 0's frame
    landAll(); player.renderFrame(3 * 24 + 12);
    expect(drawn).toContain(elA);
    // frame-centered source time of clip 3 at its 12th frame: sourceIn 8 s + 12/24 + half a frame
    expect(elA.currentTime).toBeCloseTo(8 + 12 / 24 + 0.5 / 24, 9);
    player.destroy();
  });

  it('two clips of one file at the same frame (stacked tracks) get two elements', () => {
    const { pool, player } = setup();
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('lo', 'A', 0, 48, 1, 'video'));
    s.videoTracks[1].clips.push(clip('hi', 'A', 0, 48, 20, 'video', 0.5)); // picture in picture
    player.setSequence(s, MEDIA, SETTINGS);
    player.renderFrame(10); landAll(); player.renderFrame(10);
    expect(pool.stats.created).toBe(2);
    expect(new Set(drawn).size).toBe(2);
    player.destroy();
  });

  it('20 sequence switches create no elements, source nodes or gains after the first visit', () => {
    const { pool, ac, player } = setup();
    const a = cutSequence('a'), b = cutSequence('b');
    for (const s of [a, b]) { player.setSequence(s, MEDIA, SETTINGS); for (const f of [12, 36, 60]) { player.renderFrame(f); landAll(); } }
    const before = { el: pool.stats.created, src: ac.sources.length, gains: ac.gains.length };
    for (let i = 0; i < 20; i++) { const s = i % 2 ? a : b; player.setSequence(s, MEDIA, SETTINGS); player.renderFrame(100 + i * 97); landAll(); }
    expect({ el: pool.stats.created, src: ac.sources.length, gains: ac.gains.length }).toEqual(before);
    player.destroy();
  });

  it('track volume is folded into the element gain; clips that leave the plan go silent', () => {
    const { ac, player } = setup();
    const s = cutSequence('s');
    s.audioTracks[0].volume = 0.5;
    player.setSequence(s, MEDIA, SETTINGS);
    player.renderFrame(12); landAll(); player.renderFrame(12);
    const src = ac.sources[0];
    const g = [...src.out][0] as FakeGain;
    expect(g.gain.value).toBeCloseTo(0.5, 9);
    expect(g.out.size).toBe(1); // -> master
    player.renderFrame(24 + 12); landAll(); player.renderFrame(24 + 12); // clip 1 is file B: A's element is idle
    expect(g.gain.value).toBe(0);
    player.destroy();
  });

  it('a recreated player with the same id reuses the elements and their source nodes (no InvalidStateError)', () => {
    const pool = new MediaElementPool(16);
    const ac = new FakeAudioContext();
    const s = cutSequence('s');
    const p1 = new SequencePlayer(fakeCanvas(), pool, ac as unknown as AudioContext, { id: 'program' });
    p1.setSequence(s, MEDIA, SETTINGS); p1.renderFrame(12); landAll(); p1.renderFrame(12);
    p1.destroy();
    expect(ac.sources.every((x) => x.out.size === 0)).toBe(true); // p1's graph is disconnected
    const p2 = new SequencePlayer(fakeCanvas(), pool, ac as unknown as AudioContext, { id: 'program' });
    p2.setSequence(s, MEDIA, SETTINGS); p2.renderFrame(12); landAll(); p2.renderFrame(12);
    expect(pool.stats.created).toBe(2);
    expect(ac.sources).toHaveLength(1);
    const g = [...ac.sources[0].out][0] as FakeGain;
    expect(g.gain.value).toBe(1);
    p2.destroy();
  });

  it('a player with an auto id releases its elements on destroy', () => {
    const { pool, player } = setup(16, null);
    player.setSequence(cutSequence('s'), MEDIA, SETTINGS);
    for (let i = 0; i < 6; i++) { player.renderFrame(i * 24 + 12); landAll(); }
    expect(pool.size).toBe(6);
    player.destroy();
    expect(pool.size).toBe(0);
    expect(pool.stats.disposed).toBe(6);
  });

  it('elements evicted by the pool drop their source and gain from the graph', () => {
    const { pool, ac, player } = setup(2);
    const s = cutSequence('s');
    player.setSequence(s, MEDIA, SETTINGS);
    for (let i = 0; i < 30; i++) { player.renderFrame(i * 24 + 12); landAll(); }
    expect(pool.size).toBeLessThanOrEqual(2);
    const live = new Set(pool.entriesSnapshot().map((e) => e.el as unknown as FakeVideo));
    for (const src of ac.sources) {
      if (live.has(src.mediaElement)) continue;
      expect(src.out.size).toBe(0);
      expect(src.mediaElement.getAttribute('src')).toBeNull();
    }
    player.destroy();
  });

  it('elements lent to the current frame are pinned: eviction never disposes them', () => {
    const { pool, player } = setup(1);
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('v1', 'A', 0, 48, 1, 'video'));
    s.videoTracks[1].clips.push(clip('v2', 'B', 0, 48, 1, 'video', 0.5));
    s.videoTracks[2].clips.push(clip('v3', 'C', 0, 48, 1, 'video', 0.25));
    player.setSequence(s, MEDIA, SETTINGS);
    player.renderFrame(10); landAll(); player.renderFrame(10);
    expect(pool.size).toBe(3);
    expect(new Set(drawn).size).toBe(3);
    player.destroy();
    expect(pool.size).toBe(3); // id 'program': kept for the next player, unpinned
  });
  it('a destroyed player removes its listeners from elements it leaves in the pool', () => {
    const { player } = setup();
    player.setSequence(cutSequence('s'), MEDIA, SETTINGS);
    player.renderFrame(12); landAll();
    expect(videos.every((v) => (v.listeners.get('seeked')?.size ?? 0) === 1)).toBe(true);
    player.destroy();
    expect(videos.every((v) => (v.listeners.get('seeked')?.size ?? 0) === 0 && (v.listeners.get('loadeddata')?.size ?? 0) === 0)).toBe(true);
  });
});

describe('SequencePlayer redraws while playing', () => {
  it('skips rAF ticks where neither the timeline frame nor a layer\'s media frame changed', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const rafs: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafs.push(cb); return rafs.length; });
    const runRaf = () => { const cb = rafs.shift(); cb?.(); };
    const { player } = setup();
    player.setSequence(cutSequence('s'), MEDIA, SETTINGS);
    player.renderFrame(12); landAll(); player.renderFrame(12);
    while (rafs.length) runRaf();   // flush the paused redraw scheduled by setSequence
    player.play();
    drawn = [];
    runRaf();                       // first playing tick draws
    expect(drawn).toHaveLength(1);
    runRaf(); runRaf();             // same instant: same frame, same media frame -> no redraw
    expect(drawn).toHaveLength(1);
    now += 1000 / 24;               // next timeline frame
    runRaf();
    expect(drawn).toHaveLength(2);
    const v = videos.find((x) => x.tag === 'video')!;
    v.currentTime += 1 / 24; v.land(); // the element presents its next frame within the same timeline frame
    runRaf();
    expect(drawn).toHaveLength(3);
    player.pause();
    runRaf();                       // pausing always redraws (lands exactly on a frame)
    expect(drawn).toHaveLength(4);
    player.destroy();
    vi.restoreAllMocks();
  });
});

describe('SequencePlayer canvas size', () => {
  it('caps the canvas resolution to the size shown on screen, keeping the sequence aspect', () => {
    const canvas = fakeCanvas();
    const player = new SequencePlayer(canvas, new MediaElementPool(4), undefined, { id: 'x' });
    player.setSequence(cutSequence('s'), MEDIA, SETTINGS);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    player.setDisplaySize(700, 500);
    expect([canvas.width, canvas.height]).toEqual([700, 394]);
    player.setSequence(cutSequence('t'), MEDIA, { ...SETTINGS, playbackResolution: '1/4' });
    expect([canvas.width, canvas.height]).toEqual([480, 270]); // already below the cap
    player.setDisplaySize(0, 0); // unknown: no cap
    expect([canvas.width, canvas.height]).toEqual([480, 270]);
    player.setSequence(cutSequence('u'), MEDIA, SETTINGS);
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    player.destroy();
  });
});

describe('SequencePlayer occlusion', () => {
  /** Three stacked full-frame clips (A bottom, B, C top) at frame 10; returns the elements drawn, bottom to top. */
  function drawStack(edit: (s: Sequence, media: Record<string, MediaItem>) => void = () => {}, landTop = true): { drawn: FakeVideo[]; byClip: (id: string) => FakeVideo } {
    const { player } = setup();
    const s = createSequence('x', FPS, 1920, 1080);
    s.videoTracks[0].clips.push(clip('v1', 'A', 0, 48, 1, 'video'));
    s.videoTracks[1].clips.push(clip('v2', 'B', 0, 48, 1, 'video'));
    s.videoTracks[2].clips.push(clip('v3', 'C', 0, 48, 1, 'video'));
    const media = structuredClone(MEDIA);
    edit(s, media);
    player.setSequence(s, media, SETTINGS);
    player.renderFrame(10);
    for (const v of videos) if (landTop || !v.src.includes('C.mp4')) v.land();
    drawn = [];
    player.renderFrame(10);
    const byClip = (path: string) => videos.find((v) => v.src.includes(path))!;
    player.destroy();
    return { drawn: drawn as FakeVideo[], byClip };
  }

  it('draws only the top layer when it covers the frame opaquely (decoding continues below)', () => {
    const { drawn, byClip } = drawStack();
    expect(drawn).toEqual([byClip('C.mp4')]);
    expect(videos).toHaveLength(3); // the hidden layers keep their elements, parked at their source time
  });

  it('draws the layers below a top layer that is translucent, scaled down, rotated, cropped or VP9', () => {
    const cases: ((s: Sequence, m: Record<string, MediaItem>) => void)[] = [
      (s) => { s.videoTracks[2].clips[0].transform.opacity = 0.5; },
      (s) => { s.videoTracks[2].clips[0].transform.scale = 0.9; },
      (s) => { s.videoTracks[2].clips[0].transform.rotation = 10; },
      (s) => { s.videoTracks[2].clips[0].transform.crop.left = 0.1; },
      (s) => { s.videoTracks[2].clips[0].transform.x = 4; },
      (_s, m) => { m.C.probe!.video!.codec = 'vp9'; },
      (_s, m) => { m.C.probe!.video!.pixFmt = 'yuva420p'; },
    ];
    for (const edit of cases) {
      videos = [];
      const { drawn, byClip } = drawStack(edit);
      expect(drawn).toEqual([byClip('B.mp4'), byClip('C.mp4')]);
    }
  });

  it('a scaled-up top layer still covers; a top layer that has no frame yet does not hide the one below', () => {
    expect(drawStack((s) => { s.videoTracks[2].clips[0].transform.scale = 1.5; s.videoTracks[2].clips[0].transform.x = 100; }).drawn).toHaveLength(1);
    videos = [];
    const { drawn, byClip } = drawStack(() => {}, false);
    expect(drawn).toEqual([byClip('B.mp4')]);
  });
});

describe('MediaElementPool', () => {
  it('acquire on a full pool evicts the least recently used entry, never the element it returns', () => {
    const pool = new MediaElementPool(2);
    pool.acquire('/a', 'r'); pool.acquire('/b', 'r');
    const c = pool.acquire('/c', 'r') as unknown as FakeVideo;
    // Before the fix the new entry had lastUsed 0, so it was its own victim: returned without src, never pooled,
    // and recreated on every later acquire (one new <video> per active clip per frame once the pool was full).
    expect(c.getAttribute('src')).not.toBeNull();
    expect(pool.has('/c', 'r')).toBe(true);
    expect(pool.has('/a', 'r')).toBe(false);
    expect(pool.acquire('/c', 'r')).toBe(c as unknown as HTMLVideoElement);
    expect(pool.stats.created).toBe(3);
  });

  it('notifies dispose listeners on eviction, release, releasePath and destroy, and counts', () => {
    const pool = new MediaElementPool(1);
    const seen: string[] = [];
    pool.onDispose((_el, path, role) => seen.push(`${role}@${path}`));
    pool.acquire('/a', 'r1');
    pool.acquire('/b', 'r1'); // evicts /a
    pool.acquire('/c', 'r1'); pool.release('/c', 'r1'); // evicts /b, then release /c
    pool.acquire('/d', 'r1'); pool.releasePath('/d');
    pool.acquire('/e', 'r1'); pool.destroy();
    expect(seen).toEqual(['r1@/a', 'r1@/b', 'r1@/c', 'r1@/d', 'r1@/e']);
    expect(pool.stats).toEqual({ created: 5, disposed: 5, live: 0 });
  });
});
