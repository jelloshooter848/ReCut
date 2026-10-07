/**
 * Per-clip audio streams in the preview (Roadmap §2 A): the preview plays the stream the export renders
 * (renderGraph.ts audioStreamIndex: clip.audioStream ?? media.preferredAudioStream, the first stream when missing).
 *
 * Covers the absolute index -> audio track ordinal mapping (originals and proxies, old and new proxy names), proxy
 * staleness, the planner's track choice, the player's per-track element roles and select-before-seek order (with a
 * fake DOM), the setClipAudioStream store action and the per-stream waveform cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip, MediaItem, Sequence } from '../../shared/model';
import { createMediaItem, createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform, findClip, setClipAudioStream } from '../../shared/timeline';
import {
  audioTrackOrdinal, proxyAudioStreams, proxyStreamStale, resolveAudioStream, waveformStream,
} from '../../src/playback/mediaSource';
import { planFrame } from '../../src/playback/planner';
import { selectAudioTrack, enabledAudioTrack } from '../../src/playback/audioTracks';
import { MediaElementPool } from '../../src/playback/elementPool';
import { SequencePlayer, slotBase } from '../../src/playback/sequencePlayer';
import { WaveformCache } from '../../src/playback/thumbnails';
import { useStore, resetStore, getUndoLabels } from '../../src/state/store';
import { activeSequence } from '../../src/state/selectors';

const FPS = { num: 24, den: 1 };

/** subsfirst.mp4-like: video #0, subtitles #1, AAC 440 Hz #2, AAC 880 Hz #3 (+ an extra stream #5 for gaps). */
function multi(over: Partial<MediaItem> = {}, streams = [2, 3, 5]): MediaItem {
  return {
    ...createMediaItem('/media/multi.mp4', 'multi.mp4'),
    id: 'M', kind: 'video',
    probe: {
      container: 'mp4', duration: 600, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      audio: streams.map((index) => ({ index, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 })),
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    },
    ...over,
  };
}

function aclip(id: string, mediaId: string, start: number, duration: number, audioStream?: number): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn: 1, speed: 1, linkId: null, enabled: true, kind: 'audio', audioStream,
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
  };
}

// ------------------------------------------------------------------ mapping

describe('stream resolution matches export (renderGraph audioStreamIndex)', () => {
  it('wanted stream when the probe has it, else the first audio stream; null without audio', () => {
    const m = multi();
    expect(resolveAudioStream(m, 3)).toBe(3);
    expect(resolveAudioStream(m, undefined)).toBe(2);
    expect(resolveAudioStream(m, 1)).toBe(2); // the subtitle stream is not audio: first audio stream (export warns)
    expect(resolveAudioStream(m, 9)).toBe(2);
    expect(resolveAudioStream(multi({}, []), 3)).toBeNull();
    expect(resolveAudioStream(multi({ probe: undefined }), 3)).toBe(3); // unprobed: as export, `want`
    expect(resolveAudioStream(multi({ probe: undefined }), undefined)).toBeNull();
  });

  it('absolute index -> ordinal among probe.audio for direct play; -1 when there is nothing to choose', () => {
    const m = multi();
    expect(audioTrackOrdinal(m, false, 2)).toBe(0);
    expect(audioTrackOrdinal(m, false, 3)).toBe(1);
    expect(audioTrackOrdinal(m, false, 5)).toBe(2);
    expect(audioTrackOrdinal(m, false, 4)).toBe(0); // missing: first stream, like export
    expect(audioTrackOrdinal(multi({}, [1]), false, 1)).toBe(-1); // one audio track: leave the default
    expect(audioTrackOrdinal(multi({}, []), false, 1)).toBe(-1);
    expect(audioTrackOrdinal(multi({ probe: undefined }), false, 3)).toBe(-1);
  });

  it('proxy streams: _all carries every stream; older names carry one', () => {
    expect(proxyAudioStreams(multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p_all.mp4' } }))).toEqual([2, 3, 5]);
    expect(proxyAudioStreams(multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p_a3.mp4' } }))).toEqual([3]);
    expect(proxyAudioStreams(multi({ proxy: { status: 'ready', path: '/c/p.mp4', audioStream: 5 } }))).toEqual([5]);
    expect(proxyAudioStreams(multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p.mp4' } }))).toEqual([2]); // pre-M-05: first
    expect(proxyAudioStreams(multi({ proxy: { status: 'failed', audioStream: 3 } }))).toEqual([3]);
  });

  it('absolute index -> ordinal among the proxy streams (same order as the source)', () => {
    const all = multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p_all.mp4' } });
    expect(audioTrackOrdinal(all, true, 3)).toBe(1);
    expect(audioTrackOrdinal(all, true, 5)).toBe(2);
    const one = multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p_a3.mp4' } });
    expect(audioTrackOrdinal(one, true, 3)).toBe(-1); // a one-track proxy: nothing to choose
    expect(audioTrackOrdinal(one, true, 5)).toBe(-1);
  });

  it('proxyStreamStale: the proxy lacks a wanted stream (old names stay valid for their stream)', () => {
    const old = multi({ preferredAudioStream: 3, proxy: { status: 'ready', path: '/c/proxies/k_540p_a3.mp4' } });
    expect(proxyStreamStale(old)).toBe(false);
    expect(proxyStreamStale(old, [3, 3])).toBe(false);
    expect(proxyStreamStale(old, [undefined])).toBe(true); // a want of undefined is export's: the first stream (#2)
    expect(proxyStreamStale(old, [5])).toBe(true);
    expect(proxyStreamStale({ ...old, preferredAudioStream: 2 })).toBe(true);
    // saved project with a recorded stream and a plain name
    expect(proxyStreamStale(multi({ preferredAudioStream: 5, proxy: { status: 'ready', path: '/c/p.mp4', audioStream: 5 } }))).toBe(false);
    // pre-M-05 proxy (first stream)
    const first = multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p.mp4' } });
    expect(proxyStreamStale(first)).toBe(false);
    expect(proxyStreamStale(first, [3])).toBe(true);
    expect(proxyStreamStale(first, [4])).toBe(false); // 4 is not an audio stream: export plays the first
    // new all-stream proxies are never stale; nothing to be stale without a proxy
    expect(proxyStreamStale(multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p_all.mp4' } }), [2, 3, 5])).toBe(false);
    expect(proxyStreamStale(multi({ proxy: { status: 'none' } }), [5])).toBe(false);
  });

  it('waveformStream: undefined for the first stream (old cache key), the absolute index otherwise', () => {
    const m = multi();
    expect(waveformStream(m, undefined)).toBeUndefined();
    expect(waveformStream(m, 2)).toBeUndefined();
    expect(waveformStream(m, 3)).toBe(3);
    expect(waveformStream(m, 7)).toBeUndefined();
    expect(waveformStream(multi({}, [1]), 1)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ planner

describe('planner audio track', () => {
  function seqWith(...clips: Clip[]): Sequence {
    const s = createSequence('t', FPS, 1920, 1080);
    s.audioTracks[0].clips.push(...clips);
    return s;
  }

  it('clip stream, else the media preferred stream, as an ordinal of the played file', () => {
    const m = multi({ preferredAudioStream: 5 });
    const s = seqWith(aclip('a', 'M', 0, 48, 3));
    expect(planFrame(s, { M: m }, 10, false).audio[0]).toMatchObject({ audioStream: 3, audioTrack: 1, usingProxy: false });
    const s2 = seqWith(aclip('a', 'M', 0, 48));
    expect(planFrame(s2, { M: m }, 10, false).audio[0]).toMatchObject({ audioStream: 5, audioTrack: 2 });
    const s3 = seqWith(aclip('a', 'M', 0, 48, 9));
    expect(planFrame(s3, { M: m }, 10, false).audio[0]).toMatchObject({ audioStream: 2, audioTrack: 0 });
  });

  it('an all-stream proxy plays the clip stream from the proxy', () => {
    const m = multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p_all.mp4' } });
    const a = planFrame(seqWith(aclip('a', 'M', 0, 48, 3)), { M: m }, 10, true).audio[0];
    expect(a).toMatchObject({ path: '/c/proxies/k_540p_all.mp4', usingProxy: true, audioTrack: 1 });
  });

  it('an older proxy without the clip stream: the original when it plays directly, else the proxy track', () => {
    const m = multi({ proxy: { status: 'ready', path: '/c/proxies/k_540p_a2.mp4' } });
    const direct = planFrame(seqWith(aclip('a', 'M', 0, 48, 3)), { M: m }, 10, true).audio[0];
    expect(direct).toMatchObject({ path: '/media/multi.mp4', usingProxy: false, audioTrack: 1 });
    const has = planFrame(seqWith(aclip('a', 'M', 0, 48, 2)), { M: m }, 10, true).audio[0];
    expect(has).toMatchObject({ path: '/c/proxies/k_540p_a2.mp4', usingProxy: true, audioTrack: -1 });
    const undecodable = { ...m, probe: { ...m.probe!, browserPlayable: false } };
    const p = planFrame(seqWith(aclip('a', 'M', 0, 48, 3)), { M: undecodable }, 10, true).audio[0];
    expect(p).toMatchObject({ path: '/c/proxies/k_540p_a2.mp4', usingProxy: true, audioTrack: -1 });
  });

  it('role base: per-track for a chosen track, unchanged otherwise', () => {
    expect(slotBase('audio', 1)).toBe('audio:s1');
    expect(slotBase('audio', 0)).toBe('audio:s0');
    expect(slotBase('audio', -1)).toBe('audio');
    expect(slotBase('audio')).toBe('audio');
    expect(slotBase('video', 2)).toBe('video');
  });
});

// ------------------------------------------------------------------ audio track selection (fake DOM)

interface FakeTrack { enabled: boolean }
class FakeEl {
  constructor(public tag: 'video' | 'audio' = 'video', nTracks = 3) { this.audioTracks = Array.from({ length: nTracks }, (_, i) => ({ enabled: i === 0 })); }
  audioTracks: FakeTrack[] | undefined;
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  preload = ''; playsInline = false; muted = false; defaultMuted = false; loop = false; controls = false; disableRemotePlayback = false;
  paused = true; seeking = false; readyState = 0; duration = 600; playbackRate = 1; videoWidth = 1920; videoHeight = 1080;
  error: unknown = null; parentNode = null;
  seekLog: { t: number; tracks: string }[] = [];
  private t = 0;
  get currentTime(): number { return this.t; }
  set currentTime(v: number) { this.t = v; this.seeking = true; this.seekLog.push({ t: v, tracks: this.trackState() }); }
  trackState(): string { return (this.audioTracks ?? []).map((x) => (x.enabled ? 1 : 0)).join(''); }
  set src(v: string) { this.attrs.set('src', v); }
  get src(): string { return this.attrs.get('src') ?? ''; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  addEventListener(type: string, cb: () => void): void { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(cb); }
  removeEventListener(type: string, cb: () => void): void { this.listeners.get(type)?.delete(cb); }
  load(): void { /* not used */ }
  pause(): void { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  land(): void { if (!this.attrs.has('src')) return; this.seeking = false; this.readyState = 4; }
}

describe('selectAudioTrack', () => {
  it('waits for metadata, switches once, then reports ready', () => {
    const el = new FakeEl();
    const asEl = el as unknown as HTMLMediaElement;
    expect(selectAudioTrack(asEl, 1)).toBe('waiting');
    expect(el.trackState()).toBe('100');
    el.readyState = 1;
    expect(selectAudioTrack(asEl, 1)).toBe('switched');
    expect(el.trackState()).toBe('010');
    expect(enabledAudioTrack(asEl)).toBe(1);
    expect(selectAudioTrack(asEl, 1)).toBe('ready');
  });
  it('default track, no track list, fewer tracks or a load error: ready without touching the tracks', () => {
    const el = new FakeEl();
    expect(selectAudioTrack(el as unknown as HTMLMediaElement, -1)).toBe('ready');
    el.readyState = 1;
    expect(selectAudioTrack(el as unknown as HTMLMediaElement, 0)).toBe('ready');
    expect(selectAudioTrack(el as unknown as HTMLMediaElement, 7)).toBe('ready');
    expect(el.trackState()).toBe('100');
    const bare = new FakeEl(); bare.audioTracks = undefined;
    expect(selectAudioTrack(bare as unknown as HTMLMediaElement, 1)).toBe('ready');
    const broken = new FakeEl(); broken.error = { code: 4 };
    expect(selectAudioTrack(broken as unknown as HTMLMediaElement, 1)).toBe('ready');
  });
});

describe('SequencePlayer per-clip audio stream', () => {
  let els: FakeEl[] = [];
  class Param { value = 0; setTargetAtTime(v: number): void { this.value = v; } }
  class Node { out = new Set<Node>(); connect(n: Node): Node { this.out.add(n); return n; } disconnect(): void { this.out.clear(); } }
  class Gain extends Node { gain = new Param(); }
  class Source extends Node { constructor(public el: FakeEl) { super(); } }
  class Ctx {
    destination = new Node(); currentTime = 0; state = 'running'; sources: Source[] = [];
    createGain(): Gain { return new Gain(); }
    createMediaElementSource(el: FakeEl): Source { const s = new Source(el); this.sources.push(s); return s; }
    resume(): Promise<void> { return Promise.resolve(); }
  }
  const canvas = () => {
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  };
  beforeEach(() => {
    els = [];
    vi.stubGlobal('document', { createElement: (tag: 'video' | 'audio') => { const e = new FakeEl(tag); els.push(e); return e; } });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup(...clips: Clip[]) {
    const pool = new MediaElementPool(16);
    const ac = new Ctx();
    const player = new SequencePlayer(canvas(), pool, ac as unknown as AudioContext, { id: 'program' });
    const s = createSequence('t', FPS, 1920, 1080);
    s.audioTracks[0].clips.push(...clips);
    const media = { M: multi() };
    player.setSequence(s, media, { useProxies: false, playbackResolution: 'full' });
    return { pool, ac, player, s, media };
  }
  const gainOf = (ac: Ctx, el: FakeEl) => ([...ac.sources.find((x) => x.el === el)!.out][0] as Gain).gain.value;

  it('chooses the clip track before the first seek and stays silent until it has landed', () => {
    const { pool, ac, player } = setup(aclip('a', 'M', 0, 48, 3));
    player.renderFrame(10);
    const audio = els.filter((e) => e.tag === 'audio');
    expect(audio).toHaveLength(1);
    const el = audio[0];
    expect(pool.entriesSnapshot().map((e) => e.role)).toEqual(['audio:s1:0#program']);
    expect(el.seekLog).toEqual([]); // no metadata yet: neither sought nor played
    expect(el.paused).toBe(true);
    el.readyState = 1; // metadata
    player.renderFrame(10);
    expect(el.trackState()).toBe('010');
    expect(el.seekLog).toHaveLength(1);
    expect(el.seekLog[0].tracks).toBe('010'); // the seek came after the switch
    expect(el.seekLog[0].t).toBeCloseTo(1 + 10 / 24, 9);
    expect(gainOf(ac, el)).toBe(0);
    el.land();
    player.renderFrame(10);
    expect(gainOf(ac, el)).toBeCloseTo(1, 9);
    player.destroy();
  });

  it('two clips of one file on different streams get two elements; changing a clip stream moves it to another element', () => {
    const { pool, player, s, media } = setup(aclip('a', 'M', 0, 48, 2), aclip('b', 'M', 48, 48, 3));
    player.renderFrame(10);
    for (const e of els) { e.readyState = 1; }
    player.renderFrame(10); for (const e of els) e.land();
    player.renderFrame(60); for (const e of els) { e.readyState = Math.max(e.readyState, 1); }
    player.renderFrame(60); for (const e of els) e.land();
    expect(pool.entriesSnapshot().map((e) => e.role).sort()).toEqual(['audio:s0:0#program', 'audio:s1:0#program']);
    const byRole = new Map(pool.entriesSnapshot().map((e) => [e.role, e.el as unknown as FakeEl]));
    expect(byRole.get('audio:s0:0#program')!.trackState()).toBe('100');
    expect(byRole.get('audio:s1:0#program')!.trackState()).toBe('010');
    // switch clip b to stream #5 (track 2): a new element, never a switch of the playing one
    const s2 = { ...s, audioTracks: [{ ...s.audioTracks[0], clips: [s.audioTracks[0].clips[0], { ...s.audioTracks[0].clips[1], audioStream: 5 }] }, ...s.audioTracks.slice(1)] };
    player.setSequence(s2, media, { useProxies: false, playbackResolution: 'full' });
    player.renderFrame(60);
    const fresh = pool.entriesSnapshot().find((e) => e.role === 'audio:s2:0#program')!.el as unknown as FakeEl;
    expect(fresh).toBeDefined();
    expect(byRole.get('audio:s1:0#program')!.trackState()).toBe('010'); // untouched
    fresh.readyState = 1; player.renderFrame(60);
    expect(fresh.trackState()).toBe('001');
    player.destroy();
  });

  it('single-stream files keep the plain audio role and are sought right away', () => {
    const pool = new MediaElementPool(16);
    const player = new SequencePlayer(canvas(), pool, new Ctx() as unknown as AudioContext, { id: 'program' });
    const s = createSequence('t', FPS, 1920, 1080);
    s.audioTracks[0].clips.push(aclip('a', 'M', 0, 48, 2));
    player.setSequence(s, { M: multi({}, [2]) }, { useProxies: false, playbackResolution: 'full' });
    player.renderFrame(10);
    expect(pool.entriesSnapshot().map((e) => e.role)).toEqual(['audio:0#program']);
    expect(els[0].seekLog).toHaveLength(1);
    player.destroy();
  });
});

// ------------------------------------------------------------------ shared op + store action

describe('setClipAudioStream', () => {
  const S = () => useStore.getState();
  let seqId = '';
  beforeEach(() => {
    resetStore();
    const s = createSequence('t', FPS);
    S().addSequence(s);
    seqId = s.id;
    S().clearHistory();
  });
  function insert(m: MediaItem): { v: string; a: string } {
    S().addMedia([m]);
    const [v, a] = S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 2, atFrame: 0, mode: 'insert' });
    S().clearHistory();
    return { v, a };
  }
  const clipById = (id: string) => findClip(activeSequence(S())!, id)!.clip;
  const media = (over: Partial<MediaItem> = {}) => ({ ...multi(over), id: `m${Math.random().toString(36).slice(2)}`, preferredAudioStream: 2 });

  it('shared op: audio clips only, skips locked tracks and invalid indexes', () => {
    const s = createSequence('x', FPS);
    s.audioTracks[0].clips.push(aclip('a', 'M', 0, 10, 2));
    s.audioTracks[1].clips.push(aclip('b', 'M', 0, 10, 2));
    s.videoTracks[0].clips.push({ ...aclip('v', 'M', 0, 10), kind: 'video' });
    s.audioTracks[1].locked = true;
    expect(setClipAudioStream(s, ['a', 'b', 'v'], 3).map((c) => c.id)).toEqual(['a']);
    expect(s.audioTracks[0].clips[0].audioStream).toBe(3);
    expect(s.audioTracks[1].clips[0].audioStream).toBe(2);
    expect(s.videoTracks[0].clips[0].audioStream).toBeUndefined();
    expect(setClipAudioStream(s, ['a'], -1)).toEqual([]);
    expect(setClipAudioStream(s, ['a'], 2.5)).toEqual([]);
    expect(setClipAudioStream(s, ['a'], 3)).toEqual([]); // unchanged
  });

  it('store action: one undo step; linked video untouched; undefined follows the media', () => {
    const { v, a } = insert(media());
    expect(clipById(a).audioStream).toBe(2);
    S().setClipAudioStream(seqId, [v, a], 3);
    expect(clipById(a).audioStream).toBe(3);
    expect(clipById(v).audioStream).toBeUndefined();
    expect(getUndoLabels(S()).undo).toBe('Audio stream');
    S().undo();
    expect(clipById(a).audioStream).toBe(2);
    S().redo();
    expect(clipById(a).audioStream).toBe(3);
    S().setClipAudioStream(seqId, [a], undefined);
    expect('audioStream' in clipById(a)).toBe(false);
    const before = S().project;
    S().setClipAudioStream(seqId, [a], undefined);
    expect(S().project).toBe(before);
  });

  it('an older single-stream proxy without the new stream goes stale; an all-stream proxy stays ready', () => {
    const old = media({ proxy: { status: 'ready', path: '/cache/proxies/k_540p_a2.mp4' } });
    const { a } = insert(old);
    S().setClipAudioStream(seqId, [a], 3);
    expect(S().project.media[old.id].proxy).toEqual({ status: 'none' });
    S().undo(); // proxy state is a job mirror: not undone (as for updateMedia)
    expect(S().project.media[old.id].proxy).toEqual({ status: 'none' });
    expect(clipById(a).audioStream).toBe(2);
    const all = media({ proxy: { status: 'ready', path: '/cache/proxies/k2_540p_all.mp4' } });
    const ids = insert(all);
    S().setClipAudioStream(seqId, [ids.a], 3);
    expect(S().project.media[all.id].proxy.status).toBe('ready');
  });

  it('setClipsAudioStream requeues a stale proxy of media that needs one; requeueStaleProxy counts clip streams', async () => {
    const { setClipsAudioStream, requeueStaleProxy, wantedAudioStreams } = await import('../../src/state/mediaActions');
    const g = globalThis as { window?: unknown };
    const prev = g.window;
    const reqs: { mediaId: string; audioStream?: number }[] = [];
    g.window = { recut: { startProxy: async (r: { mediaId: string }) => { reqs.push(r); return { id: 'j' }; } } };
    try {
      const m = media({ proxy: { status: 'ready', path: '/cache/proxies/k_540p_a2.mp4' } });
      m.probe = { ...m.probe!, browserPlayable: false };
      const { a } = insert(m);
      expect(wantedAudioStreams(S().project, m.id)).toEqual([2]);
      expect(requeueStaleProxy(m.id)).toBe(false);
      setClipsAudioStream(seqId, [a], 3);
      await Promise.resolve();
      // The request names the preferred stream: the one a fallback proxy keeps when FFmpeg cannot proxy every stream.
      expect(reqs).toEqual([{ mediaId: m.id, path: m.path, height: S().project.settings.proxyHeight, audioStream: 2 }]);
      expect(S().project.media[m.id].proxy.status).toBe('queued');
      expect(wantedAudioStreams(S().project, m.id)).toEqual([2, 3]);
      S().setProxy(m.id, { status: 'ready', path: '/cache/proxies/k_540p_a2.mp4' });
      expect(requeueStaleProxy(m.id)).toBe(true);
      S().setProxy(m.id, { status: 'ready', path: '/cache/proxies/k_540p_all.mp4' });
      expect(requeueStaleProxy(m.id)).toBe(false);
    } finally {
      g.window = prev;
    }
  });
});

// ------------------------------------------------------------------ waveforms

describe('WaveformCache per stream', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('keys on (path, stream), passes the stream over IPC only when set, and invalidates every stream of a path', async () => {
    const calls: unknown[][] = [];
    vi.stubGlobal('window', { recut: { waveform: async (...args: unknown[]) => { calls.push(args); return { rate: 50, duration: 1, peaks: new Uint8Array([args.length]) }; } } });
    const c = new WaveformCache();
    const first = await c.get('/m.mp4', 'M');
    const third = await c.get('/m.mp4', 'M', 3);
    expect(calls).toEqual([['/m.mp4', 'M'], ['/m.mp4', 'M', 3]]);
    expect(first).not.toBe(third);
    expect(c.peek('/m.mp4')).toBe(first);
    expect(c.peek('/m.mp4', 3)).toBe(third);
    expect(c.peek('/m.mp4', 2)).toBeUndefined();
    c.invalidate('/m.mp4');
    expect(c.peek('/m.mp4')).toBeUndefined();
    expect(c.peek('/m.mp4', 3)).toBeUndefined();
  });
});
