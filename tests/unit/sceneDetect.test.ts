/**
 * Scene-detect timestamp precision (bugs/closed/2026-10-07-scene-detect-pts-precision.md): showinfo's `pts_time`
 * text has 6 significant digits on FFmpeg 6.1, so cuts past 10,000 s were off by frames. Boundaries now come from
 * the integer `pts` after `settb=AVTB`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-scene-test-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { cacheKeyForPath } from '../../electron/media/cache';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { parseShowinfoPts, shotFilter, sceneCachePath, startSceneDetectJob, SCENE_VERSION } from '../../electron/media/sceneDetect';

const FF = getFfmpegPath() ?? 'ffmpeg';

/**
 * 1 s of red then 1 s of blue at `fps`, with the blue frames' timestamps moved so the first blue frame is frame
 * `cutFrame`: a cut far into the timeline without decoding hours of video. Kept under FFmpeg's default
 * dts_error_threshold (108000 s), above which the CLI treats the timestamp jump as an error.
 */
function makeLateCut(file: string, fps: number, cutFrame: number): void {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=red:size=64x64:rate=${fps}:duration=1`,
    '-f', 'lavfi', '-i', `color=c=blue:size=64x64:rate=${fps}:duration=1`,
    '-filter_complex', `[0:v][1:v]concat=n=2:v=1:a=0,setpts='if(lt(N,${fps}),N,N+${cutFrame - fps})/(${fps}*TB)'[v]`,
    '-map', '[v]', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
}

// FFmpeg 6.1 showed these cuts as pts_time 12345 (1 frame early at 24 fps) and 12345.1 (3 frames late at 60 fps).
const clips = [
  { name: 'late24.mp4', fps: 24, cutFrame: 296_281 }, // 12345.041667 s
  { name: 'late60.mp4', fps: 60, cutFrame: 740_703 }, // 12345.05 s
].map((c) => ({ ...c, file: path.join(tmp, c.name), cut: c.cutFrame / c.fps }));

beforeAll(() => {
  for (const c of clips) makeLateCut(c.file, c.fps, c.cutFrame);
}, 120_000);

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function detect(file: string, mediaId: string): Promise<number[]> {
  const q = new JobQueue();
  const job = startSceneDetectJob(q, { mediaId, path: file, threshold: 0.3, duration: 12346 });
  const final = await q.waitFor(job.id);
  expect(final.error ?? null).toBeNull();
  expect(final.status).toBe('done');
  return (final.result as { boundaries: number[] }).boundaries;
}

describe('parseShowinfoPts', () => {
  it('reads the integer pts in AV_TIME_BASE units, not the 6-digit pts_time', () => {
    // FFmpeg 6.1.1 output after settb=AVTB (copied from the repro in the bug report).
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x5581c0a0e9c0] n:   0 pts:12345041667 pts_time:12345   duration:  41667 duration_time:0.041667 fmt:yuv420p cl:left sar:1/1 s:320x320 i:P iskey:1 type:I checksum:5C1E5A5F plane_checksum:[1F7C6A7E 9FB8F0F7 E2B1D5D9] mean:[41 240 110] stdev:[0.0 0.0 0.0]'))
      .toBe(12345.041667);
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1] n:   0 pts:12345133333 pts_time:12345.1 duration:  33333')).toBe(12345.133333);
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1] n:   0 pts:123450500000 pts_time:123450')).toBe(123450.5);
    // exponent form of pts_time: the old parser read this as 4.32 s
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1] n:   0 pts:4320000500000 pts_time:4.32e+06')).toBe(4320000.5);
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1] n:   3 pts:      0 pts_time:0       duration:  41667')).toBe(0);
  });

  it('takes an explicit time base', () => {
    expect(parseShowinfoPts('[Parsed_showinfo_2 @ 0x1] n:   0 pts:  73728 pts_time:3.00000 duration: 512', { num: 1, den: 24576 })).toBe(3);
  });

  it('ignores lines that are not frame lines', () => {
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1] n:   0 pts:NOPTS pts_time:NOPTS duration:NOPTS')).toBeNull();
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1] config in time_base: 1/1000000, frame_rate: 24/1')).toBeNull();
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1] config out time_base: 0/0, frame_rate: 0/0')).toBeNull();
    expect(parseShowinfoPts('frame=   10 fps=0.0 q=-0.0 size=N/A time=00:00:00.41 bitrate=N/A speed=N/A')).toBeNull();
    expect(parseShowinfoPts('[Parsed_showinfo_3 @ 0x1]   side data - spherical: equirectangular')).toBeNull();
  });

  it('the filter chain sets the time base right before showinfo', () => {
    expect(shotFilter()).toBe('scale=256:144:flags=area,format=rgb24,settb=AVTB,showinfo');
  });
});

describe('scene detection past 10,000 s', () => {
  it.each(clips)('finds the cut at frame $cutFrame ($fps fps) on the right frame', async (c) => {
    const b = await detect(c.file, `late-${c.fps}`);
    expect(b).toHaveLength(1);
    expect(Math.abs(b[0] - c.cut)).toBeLessThan(0.001);
    expect(Math.round(b[0] * c.fps)).toBe(c.cutFrame);
  }, 60_000);

  it('recomputes a cache entry written before SCENE_VERSION and stamps the new one', async () => {
    const c = clips[0];
    const key = await cacheKeyForPath(c.file);
    const cachePath = sceneCachePath(key, 0.3);
    // what the v1 code cached for this clip: the rounded pts_time
    await fsp.writeFile(cachePath, JSON.stringify({ boundaries: [12345], duration: 12346 }));
    const b = await detect(c.file, 'stale');
    expect(Math.round(b[0] * c.fps)).toBe(c.cutFrame);
    const stored = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as { boundaries: number[]; version: number };
    expect(stored.version).toBe(SCENE_VERSION);
    expect(stored.boundaries).toEqual(b);
    // a current-version entry is used as is
    await fsp.writeFile(cachePath, JSON.stringify({ boundaries: [42], duration: 12346, version: SCENE_VERSION }));
    expect(await detect(c.file, 'cached')).toEqual([42]);
  }, 60_000);
});
