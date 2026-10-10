/**
 * #136: proxies were lost after closing and reopening a project. A proxy that finished after the last save is not in
 * the file (job mirrors don't make the project dirty) and queued / running proxies load as 'none', but the finished
 * file is still in the content-keyed cache. lookupCachedProxy finds it without rendering; restoreCachedProxies (run
 * after a project opens) marks such media ready again.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { lookupCachedProxy, startProxyJob, type ProxyResult } from '../../electron/media/proxy';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { createMediaItem } from '../../shared/project';
import { useStore, resetStore } from '../../src/state/store';
import { restoreCachedProxies } from '../../src/state/mediaActions';
import type { MediaItem, MediaProbe } from '../../shared/model';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-proxy-reopen-'));
const FF = getFfmpegPath() ?? 'ffmpeg';
const src = path.join(tmp, 'clip.mkv');
const proxiesDir = () => path.join(tmp, 'cache', 'proxies');

beforeAll(() => {
  process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.RECUT_CACHE_DIR; });

describe('lookupCachedProxy (main)', () => {
  it('finds a finished proxy in the cache, and never renders one', async () => {
    expect(await lookupCachedProxy(src, 540)).toBeNull();
    const made = fs.existsSync(proxiesDir()) ? fs.readdirSync(proxiesDir()) : [];
    expect(made.filter((f) => f.endsWith('.mp4'))).toEqual([]); // the lookup created nothing

    const q = new JobQueue({ throttleMs: 0 });
    const { job } = await startProxyJob(q, { mediaId: 'm', path: src, height: 540 });
    const done = await q.waitFor(job.id);
    expect(done.status, done.error).toBe('done');
    const rendered = done.result as ProxyResult;

    const hit = await lookupCachedProxy(src, 540);
    expect(hit?.path).toBe(rendered.path);
    expect(hit?.audioStreams).toEqual([1]);
    expect(await lookupCachedProxy(src, 720)).toBeNull(); // another proxy height is another file
    expect(await lookupCachedProxy(path.join(tmp, 'missing.mkv'), 540)).toBeNull();
  }, 60000);
});

describe('restoreCachedProxies (after a project opens)', () => {
  const g = globalThis as unknown as { window?: unknown; recut?: unknown };
  let asked: string[];
  const probe = (playable: boolean): MediaProbe => ({
    container: 'mp4', duration: 10, size: 1, startTime: 0, browserPlayable: playable, subtitles: [],
    video: { index: 0, codec: playable ? 'h264' : 'hevc', width: 3840, height: 2160, fps: { num: 24, den: 1 }, avgFps: { num: 24, den: 1 }, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
  });
  const media = (name: string, playable: boolean, proxy: MediaItem['proxy'] = { status: 'none' }): MediaItem =>
    ({ ...createMediaItem(`/m/${name}`, name), kind: 'video', probe: probe(playable), proxy });

  beforeEach(() => {
    resetStore();
    asked = [];
    g.window = globalThis;
    g.recut = {
      lookupProxy: async (req: { path: string }) => { asked.push(path.basename(req.path)); return path.basename(req.path) === 'cached.mp4' ? { path: '/cache/proxies/k_540p_all.mp4', width: 960, height: 540, audioStreams: [1] } : null; },
    };
  });
  afterEach(() => { delete g.recut; delete g.window; });

  it('marks media that need a proxy and have one cached as ready; leaves the rest; the project stays clean', async () => {
    const cached = media('cached.mp4', false);
    const uncached = media('nocache.mp4', false);
    const playable = media('h264.mp4', true);
    const ready = media('ready.mp4', false, { status: 'ready', path: '/cache/proxies/other.mp4' });
    useStore.getState().addMedia([cached, uncached, playable, ready]);
    useStore.setState({ dirty: false });

    const restored = await restoreCachedProxies();
    expect(restored).toEqual([cached.id]);
    expect(asked.sort()).toEqual(['cached.mp4', 'nocache.mp4']); // nothing asked for playable or already-ready media
    const m = useStore.getState().project.media;
    expect(m[cached.id].proxy).toMatchObject({ status: 'ready', path: '/cache/proxies/k_540p_all.mp4', height: 540, audioStreams: [1] });
    expect(m[uncached.id].proxy.status).toBe('none');
    expect(m[ready.id].proxy.path).toBe('/cache/proxies/other.mp4');
    expect(useStore.getState().dirty).toBe(false);
  });
});
