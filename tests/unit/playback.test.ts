import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Clip, MediaItem, Sequence, Track, Transition } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { resolvePlaybackPath, mediaFps, mediaTimeOffset, toElementTime, fromElementTime, clampElementTime } from '../../src/playback/mediaSource';
import { PlaybackClock } from '../../src/playback/clock';
import { planFrame, fadeEnvelope, contributionsAt } from '../../src/playback/planner';
import { peaksForRange, ThumbnailCache, WaveformCache } from '../../src/playback/thumbnails';

// ------------------------------------------------------------------ fixtures

const FPS = { num: 24, den: 1 };

function mediaItem(id: string, over: Partial<MediaItem> = {}): MediaItem {
  return {
    id, name: id, path: `/media/${id}.mkv`, kind: 'video', category: 'Movie', identity: {}, binId: null,
    probe: {
      container: 'matroska', duration: 600, size: 1, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
      subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: { num: 24000, den: 1001 }, avgFps: { num: 24000, den: 1001 }, isVfr: false },
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
    ...over,
  };
}

function clip(id: string, mediaId: string, start: number, duration: number, over: Partial<Clip> = {}): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn: 10, speed: 1, linkId: null, enabled: true, kind: 'video',
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
    ...over,
  };
}

function seq(): Sequence {
  const s = createSequence('t', FPS, 1920, 1080);
  return s;
}

function tr(id: string, type: Transition['type'], duration: number, outClipId: string | null, inClipId: string | null): Transition {
  return { id, type, duration, outClipId, inClipId };
}

const MEDIA: Record<string, MediaItem> = { A: mediaItem('A'), B: mediaItem('B') };

// ------------------------------------------------------------------ resolvePlaybackPath

describe('resolvePlaybackPath', () => {
  const proxyReady = { status: 'ready' as const, path: '/cache/A.proxy.mp4' };

  it('returns null for offline media', () => {
    const r = resolvePlaybackPath(mediaItem('A', { offline: true, proxy: proxyReady }), true);
    expect(r.path).toBeNull();
    expect(r.reason).toMatch(/offline/);
  });

  it('prefers the proxy when proxies are enabled and ready', () => {
    const r = resolvePlaybackPath(mediaItem('A', { proxy: proxyReady }), true);
    expect(r).toMatchObject({ path: '/cache/A.proxy.mp4', usingProxy: true });
  });

  it('uses the original when proxies are disabled and the original is decodable', () => {
    const r = resolvePlaybackPath(mediaItem('A', { proxy: proxyReady }), false);
    expect(r).toMatchObject({ path: '/media/A.mkv', usingProxy: false });
  });

  it('uses the original when proxies are enabled but no proxy exists', () => {
    const r = resolvePlaybackPath(mediaItem('A'), true);
    expect(r).toMatchObject({ path: '/media/A.mkv', usingProxy: false });
  });

  it('falls back to the proxy when the original is not decodable even with proxies disabled', () => {
    const m = mediaItem('A', { proxy: proxyReady });
    m.probe!.browserPlayable = false;
    const r = resolvePlaybackPath(m, false);
    expect(r).toMatchObject({ path: '/cache/A.proxy.mp4', usingProxy: true, reason: 'original not decodable; using proxy' });
  });

  it('returns null with a reason when nothing is decodable', () => {
    const m = mediaItem('A', { proxy: { status: 'running', progress: 0.3 } });
    m.probe!.browserPlayable = false;
    m.probe!.playabilityReason = 'hevc not supported';
    const r = resolvePlaybackPath(m, true);
    expect(r.path).toBeNull();
    expect(r.usingProxy).toBe(false);
    expect(r.reason).toContain('hevc not supported');
    expect(r.reason).toContain('proxy in progress');
  });

  it('ignores a proxy that is not ready', () => {
    const r = resolvePlaybackPath(mediaItem('A', { proxy: { status: 'failed', error: 'boom' } }), true);
    expect(r).toMatchObject({ path: '/media/A.mkv', usingProxy: false });
  });

  it('reports unprobed media as not playable', () => {
    const r = resolvePlaybackPath(mediaItem('A', { probe: undefined }), true);
    expect(r.path).toBeNull();
    expect(r.reason).toMatch(/not probed/);
  });
});

describe('mediaFps', () => {
  it('returns the video stream fps', () => {
    expect(mediaFps(mediaItem('A'))).toEqual({ num: 24000, den: 1001 });
  });
  it('falls back to 24 for audio-only / unknown', () => {
    const m = mediaItem('A');
    delete m.probe!.video;
    expect(mediaFps(m)).toEqual({ num: 24, den: 1 });
    expect(mediaFps(undefined)).toEqual({ num: 24, den: 1 });
  });
});

// ------------------------------------------------------------------ PlaybackClock

describe('PlaybackClock', () => {
  let t = 0;
  afterEach(() => vi.restoreAllMocks());

  function fakeNow() {
    t = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
  }

  it('advances with wall time at rate 1', () => {
    fakeNow();
    const c = new PlaybackClock();
    c.start(5);
    t += 2000;
    expect(c.now()).toBeCloseTo(7, 6);
    expect(c.isRunning).toBe(true);
  });

  it('is frozen when stopped and resumes from the stop position', () => {
    fakeNow();
    const c = new PlaybackClock();
    c.start(0);
    t += 1000;
    c.stop();
    t += 5000;
    expect(c.now()).toBeCloseTo(1, 6);
    c.start();
    t += 500;
    expect(c.now()).toBeCloseTo(1.5, 6);
  });

  it('supports JKL rates and preserves position on rate change', () => {
    fakeNow();
    const c = new PlaybackClock();
    c.start(10);
    t += 1000;                     // 11
    c.setRate(4);
    expect(c.now()).toBeCloseTo(11, 6);
    t += 1000;                     // 15
    expect(c.now()).toBeCloseTo(15, 6);
    c.setRate(-2);
    t += 2000;                     // 11
    expect(c.now()).toBeCloseTo(11, 6);
    c.setRate(0);
    t += 1000;
    expect(c.now()).toBeCloseTo(11, 6);
    c.setRate(-8);
    t += 1000;                     // 3
    expect(c.now()).toBeCloseTo(3, 6);
  });

  it('clamps rates to -8..8', () => {
    const c = new PlaybackClock();
    c.setRate(32);
    expect(c.rate).toBe(8);
    c.setRate(-100);
    expect(c.rate).toBe(-8);
  });

  it('seeks while running or stopped', () => {
    fakeNow();
    const c = new PlaybackClock();
    c.seek(42);
    expect(c.now()).toBe(42);
    c.start();
    t += 1000;
    c.seek(3);
    t += 1000;
    expect(c.now()).toBeCloseTo(4, 6);
  });
});

// ------------------------------------------------------------------ planFrame

describe('planFrame', () => {
  it('single clip: one layer with the clip source time', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('c1', 'A', 24, 48));
    const p = planFrame(s, MEDIA, 36, false);
    expect(p.layers).toHaveLength(1);
    expect(p.layers[0]).toMatchObject({ clipId: 'c1', path: '/media/A.mkv', usingProxy: false, alpha: 1, trackIndex: 0, handle: false });
    expect(p.layers[0].sourceTime).toBeCloseTo(10 + 12 / 24, 9);
    expect(p.layers[0].mediaFps).toEqual({ num: 24000, den: 1001 });
    expect(p.audio).toHaveLength(0);
    expect(p.missing).toHaveLength(0);
  });

  it('gaps produce an empty plan', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('c1', 'A', 24, 48));
    expect(planFrame(s, MEDIA, 10, false).layers).toHaveLength(0);
    expect(planFrame(s, MEDIA, 72, false).layers).toHaveLength(0);   // end is exclusive
    expect(planFrame(s, MEDIA, 71, false).layers).toHaveLength(1);
  });

  it('two tracks are ordered bottom -> top with track indices', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('bottom', 'A', 0, 100));
    s.videoTracks[1].clips.push(clip('top', 'B', 0, 100));
    const p = planFrame(s, MEDIA, 50, false);
    expect(p.layers.map((l) => l.clipId)).toEqual(['bottom', 'top']);
    expect(p.layers.map((l) => l.trackIndex)).toEqual([0, 1]);
  });

  it('skips disabled clips', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('c1', 'A', 0, 100, { enabled: false }));
    expect(planFrame(s, MEDIA, 50, false).layers).toHaveLength(0);
  });

  it('respects muted and solo video tracks', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('v1', 'A', 0, 100));
    s.videoTracks[1].clips.push(clip('v2', 'B', 0, 100));
    s.videoTracks[1].muted = true;
    expect(planFrame(s, MEDIA, 50, false).layers.map((l) => l.clipId)).toEqual(['v1']);
    s.videoTracks[1].muted = false;
    s.videoTracks[1].solo = true;
    expect(planFrame(s, MEDIA, 50, false).layers.map((l) => l.clipId)).toEqual(['v2']);
  });

  it('respects muted and solo audio tracks and clip mute', () => {
    const s = seq();
    s.audioTracks[0].clips.push(clip('a1', 'A', 0, 100, { kind: 'audio' }));
    s.audioTracks[1].clips.push(clip('a2', 'B', 0, 100, { kind: 'audio' }));
    expect(planFrame(s, MEDIA, 50, false).audio.map((a) => a.clipId)).toEqual(['a1', 'a2']);
    s.audioTracks[0].muted = true;
    expect(planFrame(s, MEDIA, 50, false).audio.map((a) => a.clipId)).toEqual(['a2']);
    s.audioTracks[0].muted = false;
    s.audioTracks[0].solo = true;
    expect(planFrame(s, MEDIA, 50, false).audio.map((a) => a.clipId)).toEqual(['a1']);
    s.audioTracks[0].solo = false;
    s.audioTracks[0].clips[0].audio.muted = true;
    expect(planFrame(s, MEDIA, 50, false).audio.map((a) => a.clipId)).toEqual(['a2']);
  });

  it('applies clip opacity to alpha', () => {
    const s = seq();
    const c = clip('c1', 'A', 0, 100);
    c.transform.opacity = 0.25;
    s.videoTracks[0].clips.push(c);
    expect(planFrame(s, MEDIA, 50, false).layers[0].alpha).toBeCloseTo(0.25, 9);
  });

  it('speed 2 doubles source time progression', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('c1', 'A', 0, 48, { speed: 2, sourceIn: 5 }));
    const p = planFrame(s, MEDIA, 24, false);
    expect(p.layers[0].sourceTime).toBeCloseTo(5 + 2 * 1, 9);
    expect(p.layers[0].speed).toBe(2);
  });

  it('crossDissolve ramps the incoming clip 0 -> 0.5 -> 1 across cut-D/2, cut, cut+D/2 with handles', () => {
    const s = seq();
    const D = 12;
    const out = clip('out', 'A', 0, 48);
    const inc = clip('in', 'B', 48, 48, { sourceIn: 100 });
    s.videoTracks[0].clips.push(out, inc);
    s.videoTracks[0].transitions.push(tr('t1', 'crossDissolve', D, 'out', 'in'));

    const at = (f: number) => {
      const p = planFrame(s, MEDIA, f, false);
      const m = new Map(p.layers.map((l) => [l.clipId, l]));
      return m;
    };
    // cut - D/2 = 42: incoming starts at 0 (handle frame before its in point), outgoing at 1
    let m = at(42);
    expect(m.get('in')!.alpha).toBeCloseTo(0, 9);
    expect(m.get('in')!.handle).toBe(true);
    expect(m.get('in')!.sourceTime).toBeCloseTo(100 - 6 / 24, 9);
    expect(m.get('out')!.alpha).toBeCloseTo(1, 9);
    // cut = 48: 0.5 / 0.5, outgoing is now a handle beyond its out point
    m = at(48);
    expect(m.get('in')!.alpha).toBeCloseTo(0.5, 9);
    expect(m.get('out')!.alpha).toBeCloseTo(0.5, 9);
    expect(m.get('out')!.handle).toBe(true);
    expect(m.get('out')!.sourceTime).toBeCloseTo(10 + 48 / 24, 9);
    // cut + D/2 = 54: transition over
    m = at(54);
    expect(m.get('in')!.alpha).toBeCloseTo(1, 9);
    expect(m.has('out')).toBe(false);
    // just before cut+D/2
    m = at(53);
    expect(m.get('in')!.alpha).toBeCloseTo(11 / 12, 9);
    expect(m.get('out')!.alpha).toBeCloseTo(1 / 12, 9);
    // well before the transition: outgoing only
    m = at(30);
    expect(m.get('out')!.alpha).toBe(1);
    expect(m.has('in')).toBe(false);
    // layers are ordered outgoing then incoming (track order) and both on the same track
    const p = planFrame(s, MEDIA, 48, false);
    expect(p.layers.map((l) => l.clipId)).toEqual(['out', 'in']);
  });

  it('dipToBlack fades the outgoing clip over the first half and the incoming over the second', () => {
    const s = seq();
    const D = 12;
    s.videoTracks[0].clips.push(clip('out', 'A', 0, 48), clip('in', 'B', 48, 48));
    s.videoTracks[0].transitions.push(tr('t1', 'dipToBlack', D, 'out', 'in'));
    const alpha = (f: number, id: string) => planFrame(s, MEDIA, f, false).layers.find((l) => l.clipId === id)?.alpha;
    expect(alpha(42, 'out')).toBeCloseTo(1, 9);
    expect(alpha(45, 'out')).toBeCloseTo(0.5, 9);
    expect(alpha(47, 'out')).toBeCloseTo(1 / 6, 9);
    expect(alpha(45, 'in')).toBeUndefined();     // incoming not yet started, no handles
    expect(alpha(48, 'out')).toBeUndefined();
    expect(alpha(48, 'in')).toBeCloseTo(0, 9);
    expect(alpha(51, 'in')).toBeCloseTo(0.5, 9);
    expect(alpha(54, 'in')).toBeCloseTo(1, 9);
  });

  it('transition at a clip start (from black) ramps over D frames inside the clip', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('c1', 'A', 24, 96));
    s.videoTracks[0].transitions.push(tr('t1', 'crossDissolve', 24, null, 'c1'));
    const alpha = (f: number) => planFrame(s, MEDIA, f, false).layers.find((l) => l.clipId === 'c1')?.alpha;
    expect(alpha(20)).toBeUndefined();            // nothing before the clip
    expect(alpha(24)).toBeCloseTo(0, 9);
    expect(alpha(36)).toBeCloseTo(0.5, 9);
    expect(alpha(48)).toBeCloseTo(1, 9);
    expect(alpha(100)).toBeCloseTo(1, 9);
  });

  it('transition at the sequence end (to black) ramps down over the last D frames', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('c1', 'A', 0, 96));
    s.videoTracks[0].transitions.push(tr('t1', 'dipToBlack', 24, 'c1', null));
    const alpha = (f: number) => planFrame(s, MEDIA, f, false).layers.find((l) => l.clipId === 'c1')?.alpha;
    expect(alpha(71)).toBeCloseTo(1, 9);
    expect(alpha(72)).toBeCloseTo(1, 9);
    expect(alpha(84)).toBeCloseTo(0.5, 9);
    expect(alpha(95)).toBeCloseTo(1 / 24, 9);
    expect(alpha(96)).toBeUndefined();            // past the end: empty plan
    expect(planFrame(s, MEDIA, 96, false).layers).toHaveLength(0);
  });

  it('audio fade envelope and gain/volume combine linearly', () => {
    const s = seq();
    const a = clip('a1', 'A', 0, 100, { kind: 'audio' });
    a.audio.fadeIn = 10;
    a.audio.fadeOut = 20;
    a.audio.gain = -6;
    a.audio.volume = 0.5;
    s.audioTracks[0].clips.push(a);
    s.audioTracks[0].volume = 0.8;
    const base = Math.pow(10, -6 / 20) * 0.5;
    const gainAt = (f: number) => planFrame(s, MEDIA, f, false).audio[0].gain;
    expect(fadeEnvelope(a, 0)).toBe(0);
    expect(fadeEnvelope(a, 5)).toBeCloseTo(0.5, 9);
    expect(fadeEnvelope(a, 10)).toBe(1);
    expect(fadeEnvelope(a, 50)).toBe(1);
    expect(fadeEnvelope(a, 90)).toBeCloseTo(0.5, 9);
    expect(fadeEnvelope(a, 99)).toBeCloseTo(0.05, 9);
    expect(gainAt(5)).toBeCloseTo(base * 0.5, 9);
    expect(gainAt(50)).toBeCloseTo(base, 9);
    const p = planFrame(s, MEDIA, 50, false);
    expect(p.audio[0]).toMatchObject({ clipId: 'a1', trackId: s.audioTracks[0].id, trackVolume: 0.8, path: '/media/A.mkv' });
    expect(p.audio[0].sourceTime).toBeCloseTo(10 + 50 / 24, 9);
  });

  it('audioCrossfade uses the centered model with handles', () => {
    const s = seq();
    s.audioTracks[0].clips.push(clip('out', 'A', 0, 48, { kind: 'audio' }), clip('in', 'B', 48, 48, { kind: 'audio' }));
    s.audioTracks[0].transitions.push(tr('t1', 'audioCrossfade', 12, 'out', 'in'));
    const p = planFrame(s, MEDIA, 48, false);
    const g = new Map(p.audio.map((a) => [a.clipId, a.gain]));
    expect(g.get('out')).toBeCloseTo(0.5, 9);
    expect(g.get('in')).toBeCloseTo(0.5, 9);
    const p2 = planFrame(s, MEDIA, 45, false);
    expect(p2.audio.find((a) => a.clipId === 'in')!.handle).toBe(true);
    expect(p2.audio.find((a) => a.clipId === 'in')!.gain).toBeCloseTo(0.25, 9);
  });

  it('reports missing / unplayable media and still renders the rest', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('ok', 'A', 0, 100));
    s.videoTracks[1].clips.push(clip('gone', 'Z', 0, 100));
    s.videoTracks[2].clips.push(clip('off', 'B', 0, 100));
    const media = { ...MEDIA, B: mediaItem('B', { offline: true }) };
    const p = planFrame(s, media, 10, true);
    expect(p.layers.map((l) => l.clipId)).toEqual(['ok']);
    expect(p.missing).toEqual([
      { clipId: 'gone', mediaId: 'Z', reason: 'media not in project' },
      { clipId: 'off', mediaId: 'B', reason: 'media offline' },
    ]);
  });

  it('uses proxies when enabled', () => {
    const s = seq();
    s.videoTracks[0].clips.push(clip('c1', 'A', 0, 100));
    const media = { A: mediaItem('A', { proxy: { status: 'ready', path: '/cache/A.mp4' } }) };
    expect(planFrame(s, media, 1, true).layers[0]).toMatchObject({ path: '/cache/A.mp4', usingProxy: true });
    expect(planFrame(s, media, 1, false).layers[0]).toMatchObject({ path: '/media/A.mkv', usingProxy: false });
  });

  it('contributionsAt ignores disabled clips even inside transitions', () => {
    const t: Track = { ...seq().videoTracks[0], clips: [clip('out', 'A', 0, 48, { enabled: false }), clip('in', 'B', 48, 48)] };
    t.transitions.push(tr('t1', 'crossDissolve', 12, 'out', 'in'));
    expect(contributionsAt(t, 48).map((c) => c.clip.id)).toEqual(['in']);
  });
});

// ------------------------------------------------------------------ thumbnails / waveforms

describe('peaksForRange', () => {
  const data = { rate: 10, duration: 2, peaks: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110]) };

  it('takes the max of each bucket', () => {
    expect(Array.from(peaksForRange(data, 0, 2, 4))).toEqual([5, 10, 60, 110]);
  });
  it('handles sub-sample buckets by widening to one sample', () => {
    expect(Array.from(peaksForRange(data, 0, 0.2, 4))).toEqual([1, 1, 2, 2]);
  });
  it('returns zeros outside the data and empty for zero buckets', () => {
    expect(Array.from(peaksForRange(data, 5, 6, 3))).toEqual([0, 0, 0]);
    expect(peaksForRange(data, 0, 1, 0)).toHaveLength(0);
    expect(Array.from(peaksForRange(data, 1, 0, 2))).toEqual([0, 0]);
  });
});

describe('ThumbnailCache / WaveformCache without window.recut', () => {
  it('resolve to empty values', async () => {
    const tc = new ThumbnailCache(10);
    await expect(tc.get('/x.mkv', 1, 100)).resolves.toBe('');
    await expect(tc.filmstrip('/x.mkv', [0, 1, 2], 100)).resolves.toEqual(['', '', '']);
    const wc = new WaveformCache();
    await expect(wc.get('/x.mkv')).resolves.toBeNull();
  });

  it('dedupes in-flight requests and caches results when an api is present', async () => {
    const thumbnail = vi.fn(async (req: { time: number }) => `recut-media://thumb/${req.time}`);
    const filmstrip = vi.fn(async (req: { times: number[] }) => req.times.map((t) => `recut-media://strip/${t}`));
    (globalThis as any).window = { recut: { thumbnail, filmstrip } };
    try {
      const tc = new ThumbnailCache(10);
      const [a, b] = await Promise.all([tc.get('/x.mkv', 1, 100), tc.get('/x.mkv', 1, 100)]);
      expect(a).toBe('recut-media://thumb/1');
      expect(b).toBe(a);
      expect(thumbnail).toHaveBeenCalledTimes(1);
      await tc.get('/x.mkv', 1, 100);
      expect(thumbnail).toHaveBeenCalledTimes(1);
      expect(tc.peek('/x.mkv', 1, 100)).toBe(a);
      const strip = await tc.filmstrip('/x.mkv', [1, 2, 3], 100);
      expect(strip).toEqual(['recut-media://thumb/1', 'recut-media://strip/2', 'recut-media://strip/3']);
      expect(filmstrip).toHaveBeenCalledWith({ path: '/x.mkv', times: [2, 3], width: 100, mediaId: undefined });
      expect(tc.size).toBe(3);
    } finally {
      delete (globalThis as any).window;
    }
  });

  it('evicts least recently used entries beyond capacity', async () => {
    const thumbnail = vi.fn(async (req: { time: number }) => `t${req.time}`);
    (globalThis as any).window = { recut: { thumbnail } };
    try {
      const tc = new ThumbnailCache(2);
      await tc.get('/x', 1, 1);
      await tc.get('/x', 2, 1);
      await tc.get('/x', 1, 1);      // touch 1
      await tc.get('/x', 3, 1);      // evicts 2
      expect(tc.peek('/x', 1, 1)).toBe('t1');
      expect(tc.peek('/x', 2, 1)).toBeUndefined();
      expect(tc.peek('/x', 3, 1)).toBe('t3');
    } finally {
      delete (globalThis as any).window;
    }
  });
});

// ------------------------------------------------------------------ M-11: element time of originals with a container start offset

describe('element time mapping (container start_time)', () => {
  const withStart = (startTime: number, over: Partial<MediaItem> = {}) => {
    const m = mediaItem('ts10', over);
    m.probe = { ...m.probe!, startTime };
    return m;
  };

  it('originals are offset by probe.startTime; proxies and zero-start files are not', () => {
    expect(resolvePlaybackPath(withStart(9.978), false).timeOffset).toBe(9.978);
    expect(resolvePlaybackPath(withStart(0), false).timeOffset).toBe(0);
    const proxied = withStart(9.978, { proxy: { status: 'ready', path: '/proxies/ts10.mp4' } });
    expect(resolvePlaybackPath(proxied, true)).toMatchObject({ usingProxy: true, timeOffset: 0 });
    const notPlayable = withStart(1.462, { proxy: { status: 'ready', path: '/proxies/ts.mp4' } });
    notPlayable.probe = { ...notPlayable.probe!, browserPlayable: false };
    expect(resolvePlaybackPath(notPlayable, false)).toMatchObject({ usingProxy: true, timeOffset: 0 });
    expect(mediaTimeOffset(withStart(-0.021), false)).toBe(0);
    expect(mediaTimeOffset(withStart(9.978), true)).toBe(0);
  });

  it('source time <-> element time round-trips and clamps to the playable span', () => {
    // counter24_ts10.mp4: frame 100 centre (4.1875 s) must be written as 9.978 + 4.1875
    expect(toElementTime(4.1875, 9.978)).toBeCloseTo(14.1655, 9);
    expect(fromElementTime(toElementTime(4.1875, 9.978), 9.978)).toBeCloseTo(4.1875, 9);
    expect(toElementTime(1, undefined)).toBe(1);
    // zero offset: [0, duration)
    expect(clampElementTime(25, 20, 0)).toBeCloseTo(19.999, 9);
    expect(clampElementTime(-1, 20, 0)).toBe(0);
    // offset: never before the first pts; Chromium's duration (22.458 for a 20 s file at 9.978) is not an end bound
    expect(clampElementTime(9, 22.458, 9.978)).toBe(9.978);
    expect(clampElementTime(25, 22.458, 9.978)).toBe(25);
  });

  it('planFrame carries the offset on video layers and audio sources', () => {
    const s = seq();
    const m = withStart(9.978);
    s.videoTracks[0].clips.push(clip('v', m.id, 0, 48));
    s.audioTracks[0].clips.push(clip('a', m.id, 0, 48, { kind: 'audio' }));
    const plan = planFrame(s, { [m.id]: m }, 10, false);
    expect(plan.layers[0].timeOffset).toBe(9.978);
    expect(plan.audio[0].timeOffset).toBe(9.978);
    const proxied = withStart(9.978, { proxy: { status: 'ready', path: '/p.mp4' } });
    const plan2 = planFrame(s, { [m.id]: proxied }, 10, true);
    expect(plan2.layers[0].timeOffset).toBe(0);
    expect(plan2.audio[0].timeOffset).toBe(0);
  });
});

describe('contributionsAt index (P-08)', () => {
  /** Reference: the old linear scan semantics (every clip checked, transitions looked up by find). */
  function linear(track: Track, frame: number): string[] {
    const ids: string[] = [];
    for (const c of track.clips) {
      if (!c.enabled) continue;
      const end = c.start + c.duration;
      const tin = track.transitions.find((t) => t.inClipId === c.id);
      const tout = track.transitions.find((t) => t.outClipId === c.id);
      let inside = frame >= c.start && frame < end;
      if (tin && tin.outClipId !== null && tin.type !== 'dipToBlack') { const h = Math.max(1, tin.duration) / 2; if (frame >= c.start - h && frame < c.start + h) inside = true; }
      if (tout && tout.inClipId !== null && tout.type !== 'dipToBlack') { const h = Math.max(1, tout.duration) / 2; if (frame >= end - h && frame < end + h) inside = true; }
      if (inside) ids.push(c.id);
    }
    return ids;
  }
  it('matches a linear scan across cuts, dissolve handles, gaps and overlaps', () => {
    const clips: Clip[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) { const d = 5 + (i * 7) % 23; clips.push(clip(`c${i}`, 'm1', t, d, { enabled: i % 11 !== 5 })); t += d + (i % 5 === 0 ? 4 : 0); }
    clips.push(clip('long', 'm1', 3, 300)); // overlapping long clip (not normally possible on one track)
    clips.sort((a, b) => a.start - b.start);
    const transitions: Transition[] = [];
    for (let i = 1; i < clips.length; i++) {
      const a = clips[i - 1], b = clips[i];
      if (a.id !== 'long' && b.id !== 'long' && a.start + a.duration === b.start && i % 3 === 0) {
        transitions.push({ id: `t${i}`, type: i % 2 ? 'crossDissolve' : 'dipToBlack', duration: 2 + (i % 9), outClipId: a.id, inClipId: b.id } as Transition);
      }
    }
    const track = { id: 'v1', kind: 'video', name: 'V1', clips, transitions, muted: false, solo: false, locked: false, volume: 1 } as unknown as Track;
    for (let f = -5; f < t + 10; f++) expect(contributionsAt(track, f).map((x) => x.clip.id)).toEqual(linear(track, f));
  });
});
