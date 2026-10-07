/**
 * Proxy robustness (Roadmap §2): a proxy maps every audio stream, so one stream FFmpeg cannot decode or encode used to
 * fail the whole proxy. runProxy now falls back to the streams FFmpeg can decode, then to the wanted stream alone, and
 * records what the proxy carries (ProxyResult.audioStreams -> ProxyInfo.audioStreams) so the renderer maps tracks.
 *
 * The broken source is real: a Matroska file whose AC-3 track has its CodecID patched to an unknown one ("A_XC3"), so
 * ffprobe lists it as an audio stream of codec "unknown" and ffmpeg refuses to decode it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaItem } from '../../shared/model';
import { createMediaItem, normalizeProject, createProject } from '../../shared/project';

const decoders = vi.hoisted(() => ({ override: null as null | (() => Promise<ReadonlySet<string> | null>) }));
vi.mock('../../electron/media/ffmpeg', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../electron/media/ffmpeg')>();
  return { ...real, ffmpegAudioDecoders: () => (decoders.override ? decoders.override() : real.ffmpegAudioDecoders()) };
});

import { getFfmpegPath, parseAudioDecoders, ffmpegAudioDecoders } from '../../electron/media/ffmpeg';
import { probeMedia } from '../../electron/media/probe';
import { buildProxyArgs, proxyAudioPlans, startProxyJob, streamsProxyOutputPath, type ProxyResult } from '../../electron/media/proxy';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { audioTrackOrdinal, proxyAudioStreams, proxyStreamStale } from '../../src/playback/mediaSource';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-proxy-fallback-'));
const FF = getFfmpegPath() ?? 'ffmpeg';
const good = path.join(tmp, 'three.mkv');
const bad = path.join(tmp, 'broken-stream.mkv');

beforeAll(() => {
  process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');
  // video #0, AAC 440 Hz #1, AC-3 880 Hz #2, PCM 660 Hz #3
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=160x120:r=24:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3',
    '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=3', '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=3',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:a:2', 'pcm_s16le', good]);
  const bytes = fs.readFileSync(good);
  const at = bytes.indexOf('A_AC3');
  expect(at).toBeGreaterThan(0);
  bytes.write('A_XC3', at, 'latin1'); // same length: the EBML sizes stay valid
  fs.writeFileSync(bad, bytes);
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { decoders.override = null; });

function zeroCrossHz(file: string, map: string): number {
  const pcm = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', map, '-ac', '1', '-ar', '48000', '-af', 'atrim=0.5:2.5', '-f', 's16le', '-'], { maxBuffer: 64 << 20 });
  let zc = 0;
  for (let i = 2; i + 1 < pcm.length; i += 2) if ((pcm.readInt16LE(i) >= 0) !== (pcm.readInt16LE(i - 2) >= 0)) zc++;
  return zc / 2 / 2;
}

async function proxy(file: string, req: { height: number; audioStream?: number }): Promise<{ status: string; result: ProxyResult; error?: string }> {
  const q = new JobQueue();
  const { job } = await startProxyJob(q, { mediaId: 'm', path: file, ...req });
  const final = await q.waitFor(job.id);
  return { status: final.status, result: final.result as ProxyResult, error: final.error };
}

function parts(): string[] {
  const dir = path.join(tmp, 'cache', 'proxies');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('.part')) : [];
}

// ------------------------------------------------------------------ pure parts

describe('fallback plans', () => {
  const probe = { audio: [{ index: 1, codec: 'aac' }, { index: 2, codec: 'unknown' }, { index: 3, codec: 'pcm_s16le' }] } as Parameters<typeof proxyAudioPlans>[0];
  const dec = new Set(['aac', 'pcm_s16le', 'ac3']);

  it('every stream, then the decodable ones, then the wanted stream alone (resolved as the export does)', () => {
    expect(proxyAudioPlans(probe, dec, 3)).toEqual([[1, 2, 3], [1, 3], [3]]);
    expect(proxyAudioPlans(probe, dec, undefined)).toEqual([[1, 2, 3], [1, 3], [1]]);
    expect(proxyAudioPlans(probe, dec, 9)).toEqual([[1, 2, 3], [1, 3], [1]]); // not an audio stream: the first
    // The wanted stream itself cannot be decoded: the first decodable one.
    expect(proxyAudioPlans(probe, dec, 2)).toEqual([[1, 2, 3], [1, 3], [1]]);
  });

  it('skips repeated and unknown plans; no audio is one silent plan', () => {
    expect(proxyAudioPlans(probe, new Set(['aac', 'unknown', 'pcm_s16le']), 3)).toEqual([[1, 2, 3], [3]]); // all decodable
    expect(proxyAudioPlans(probe, null, 2)).toEqual([[1, 2, 3], [2]]); // decoder list unknown
    expect(proxyAudioPlans(probe, new Set(['opus']), 3)).toEqual([[1, 2, 3], [3]]); // nothing decodable: no empty plan
    expect(proxyAudioPlans({ audio: [{ index: 1, codec: 'aac' }] } as Parameters<typeof proxyAudioPlans>[0], dec, 1)).toEqual([[1]]);
    expect(proxyAudioPlans({ audio: [] }, dec, 1)).toEqual([[]]);
  });

  it('parses `ffmpeg -codecs` (decodable audio codecs only), and the local ffmpeg lists the usual ones', async () => {
    const listing = [
      'Codecs:', ' D..... = Decoding supported', ' ..A... = Audio codec', ' -------',
      ' DEAIL. aac                  AAC (Advanced Audio Coding) (decoders: aac aac_fixed)',
      ' D.AIL. aac_latm             AAC LATM', ' .EAIL. libfdk_aac           encoder only',
      ' DEA..S truehd               TrueHD', ' DEVI.S png                  PNG', ' DES... ass                  ASS',
    ].join('\r\n');
    expect([...parseAudioDecoders(listing)].sort()).toEqual(['aac', 'aac_latm', 'truehd']);
    const local = await ffmpegAudioDecoders();
    for (const c of ['aac', 'ac3', 'pcm_s16le', 'mp3', 'flac', 'opus']) expect(local?.has(c)).toBe(true);
    expect(local?.has('unknown')).toBe(false);
  });

  it('fallback cache names list the streams (one stream is the older `_a<N>` name); a fallback maps only its streams', () => {
    expect(streamsProxyOutputPath('k', 540, [1, 3])).toMatch(/k_540p_a1_a3\.mp4$/);
    expect(streamsProxyOutputPath('k', 541, [3])).toMatch(/k_540p_a3\.mp4$/);
    const opts = { targetHeight: 240, hasVideo: true, hasAudio: true, outPart: '/tmp/x.part' };
    const args = buildProxyArgs({ mediaId: 'm', path: '/x/a.mkv', height: 240 }, { ...opts, audioStreams: [1, 3] });
    expect(args.filter((_, i) => args[i - 1] === '-map')).toEqual(['0:v:0', '0:1', '0:3']);
    expect(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 6)).toEqual(['-c:a', 'aac', '-b:a', '160k', '-ac', '2']);
  });
});

// ------------------------------------------------------------------ real ffmpeg

describe('runProxy with an audio stream ffmpeg cannot decode', () => {
  it('the source: ffprobe lists the broken stream as audio "unknown"; the all-streams proxy of the intact file works', async () => {
    const p = await probeMedia(bad);
    expect(p.audio.map((a) => [a.index, a.codec])).toEqual([[1, 'aac'], [2, 'unknown'], [3, 'pcm_s16le']]);
    const ok = await proxy(good, { height: 120 });
    expect(ok.status).toBe('done');
    expect(ok.result.path).toMatch(/_120p_all\.mp4$/);
    expect(ok.result.audioStreams).toEqual([1, 2, 3]);
  }, 60_000);

  it('keeps every decodable stream (`_a1_a3`), records them, and each track has its source tone; a rerun reuses it', async () => {
    const r = await proxy(bad, { height: 144, audioStream: 3 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('done');
    expect(r.result.path).toMatch(/_144p_a1_a3\.mp4$/);
    expect(r.result.audioStreams).toEqual([1, 3]);
    expect(r.result.cached).toBe(false);
    const pp = await probeMedia(r.result.path);
    expect(pp.video?.height).toBe(120); // never above the source
    expect(pp.audio.map((a) => a.codec)).toEqual(['aac', 'aac']);
    expect(Math.abs(zeroCrossHz(r.result.path, '0:a:0') - 440)).toBeLessThan(30);
    expect(Math.abs(zeroCrossHz(r.result.path, '0:a:1') - 660)).toBeLessThan(30);
    expect(fs.existsSync(r.result.path.replace(/_a1_a3\.mp4$/, '_all.mp4'))).toBe(false);
    expect(parts()).toEqual([]);
    const again = await proxy(bad, { height: 144, audioStream: 3 });
    expect(again.result).toMatchObject({ path: r.result.path, cached: true, audioStreams: [1, 3] });
  }, 90_000);

  it('last resort: when the decodable-streams run fails too, the wanted stream alone (`_a<N>`)', async () => {
    // A decoder list that wrongly claims the broken stream: plan 2 equals plan 1 and is skipped, so the wanted stream
    // alone is next.
    decoders.override = async () => new Set(['aac', 'unknown', 'pcm_s16le']);
    const r = await proxy(bad, { height: 160, audioStream: 3 });
    expect(r.status).toBe('done');
    expect(r.result.path).toMatch(/_160p_a3\.mp4$/); // named by the requested height, as `_all` is
    expect(r.result.audioStreams).toEqual([3]);
    const pp = await probeMedia(r.result.path);
    expect(pp.audio).toHaveLength(1);
    expect(Math.abs(zeroCrossHz(r.result.path, '0:a:0') - 660)).toBeLessThan(30);
    // No decoder list at all: straight to the wanted stream (the first when unset).
    decoders.override = async () => null;
    const first = await proxy(bad, { height: 180 });
    expect(first.status).toBe('done');
    expect(first.result.audioStreams).toEqual([1]);
    expect(Math.abs(zeroCrossHz(first.result.path, '0:a:0') - 440)).toBeLessThan(30);
    expect(parts()).toEqual([]);
  }, 90_000);

  it('fails with the first error when no plan works (the wanted stream is the broken one), leaving nothing behind', async () => {
    decoders.override = async () => new Set(['aac', 'unknown', 'pcm_s16le']);
    const r = await proxy(bad, { height: 200, audioStream: 2 });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/decoder|ffmpeg/i);
    const dir = path.join(tmp, 'cache', 'proxies');
    expect(fs.readdirSync(dir).filter((f) => f.includes('_200p'))).toEqual([]);
    expect(parts()).toEqual([]);
  }, 90_000);
});

// ------------------------------------------------------------------ renderer side

describe('the renderer maps tracks through what the proxy carries', () => {
  const FPS = { num: 24, den: 1 };
  function media(proxy: MediaItem['proxy'], over: Partial<MediaItem> = {}): MediaItem {
    return {
      ...createMediaItem(bad, 'broken-stream.mkv'), id: 'M', kind: 'video', proxy,
      probe: {
        container: 'matroska', duration: 3, size: 1, startTime: 0, browserPlayable: false, subtitles: [],
        audio: [[1, 'aac'], [2, 'unknown'], [3, 'pcm_s16le']].map(([index, codec]) => ({ index: index as number, codec: codec as string, channels: 1, layout: 'mono', sampleRate: 48000 })),
        video: { index: 0, codec: 'h264', width: 160, height: 120, fps: FPS, avgFps: FPS, isVfr: false },
      },
      ...over,
    };
  }

  it('recorded list first, else the `_a<N>_a<M>` name; stream 3 is track 1 of a [1, 3] proxy', () => {
    const rec = media({ status: 'ready', path: '/c/proxies/k_540p_a1_a3.mp4', audioStreams: [1, 3] });
    expect(proxyAudioStreams(rec)).toEqual([1, 3]);
    expect(proxyAudioStreams(media({ status: 'ready', path: '/c/proxies/k_540p_a1_a3.mp4' }))).toEqual([1, 3]);
    expect(proxyAudioStreams(media({ status: 'ready', path: '/c/proxies/k_540p_a3.mp4' }))).toEqual([3]);
    expect(audioTrackOrdinal(rec, true, 3)).toBe(1);
    expect(audioTrackOrdinal(rec, true, 1)).toBe(0);
    expect(audioTrackOrdinal(rec, true, 2)).toBe(0); // not in the proxy: its first track
  });

  it('a recorded proxy is never stale (a rebuild gives the same streams), so it is not requeued in a loop', async () => {
    const rec = media({ status: 'ready', path: '/c/proxies/k_540p_a3.mp4', audioStreams: [3] }, { preferredAudioStream: 3 });
    expect(proxyStreamStale(rec, [1, 2, 3])).toBe(false);
    // Without the record the same file is an older single-stream proxy: stale for stream 1.
    expect(proxyStreamStale({ ...rec, proxy: { status: 'ready', path: '/c/proxies/k_540p_a3.mp4' } }, [1])).toBe(true);

    const { useStore, resetStore } = await import('../../src/state/store');
    const { requeueStaleProxy } = await import('../../src/state/mediaActions');
    resetStore();
    useStore.getState().addMedia([rec]);
    expect(requeueStaleProxy('M')).toBe(false);
    useStore.getState().updateMedia('M', { preferredAudioStream: 1 });
    expect(useStore.getState().project.media.M.proxy).toEqual(rec.proxy);
  });

  it('the project loader keeps a valid audioStreams record and drops an invalid one', () => {
    const p = createProject('x');
    p.media.M = media({ status: 'ready', path: '/c/p_a1_a3.mp4', audioStreams: [1, 3] });
    p.media.N = { ...media({ status: 'ready', path: '/c/p_all.mp4', audioStreams: [1, -2] as number[] }), id: 'N' };
    const out = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(out.media.M.proxy.audioStreams).toEqual([1, 3]);
    expect(out.media.N.proxy.status).toBe('ready');
    expect('audioStreams' in out.media.N.proxy).toBe(false);
  });
});
