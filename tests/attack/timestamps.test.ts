/**
 * Timestamp handling of the derived-media pipeline: thumbnails (-ss semantics vs the editor's frame), waveform bucket
 * alignment vs the media time base used by <video>, and start_time variants.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { framesToSeconds, frameCenterSeconds } from '@shared/time';
import { ensureMedia, mediaPath, SCRATCH, ff, ffprobeJson, FPS_23976, FPS_24, fmt } from './helpers';

process.env.RECUT_CACHE_DIR = path.join(SCRATCH, 'cache');
import { getThumbnail } from '../../electron/media/thumbs';
import { computeWaveform, WAVEFORM_RATE } from '../../electron/media/waveform';
import { probeMedia } from '../../electron/media/probe';

beforeAll(() => { ensureMedia(); fs.mkdirSync(path.join(SCRATCH, 'cache'), { recursive: true }); });

/** Decode the counter of a JPEG thumbnail (same encoding as the sources). */
async function jpegCounter(file: string): Promise<number> {
  const { stdout } = await ff(['-i', file, '-vf', 'scale=2:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  const top = (stdout[0] + stdout[1]) / 2, bot = (stdout[2] + stdout[3]) / 2;
  return Math.round((bot - 16) / 4) * 50 + Math.round((top - 16) / 4);
}
async function jpegLuma(file: string): Promise<number> {
  const { stdout } = await ff(['-i', file, '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  return stdout[0];
}

describe('thumbnails', () => {
  it('thumbnail at a frame START time shows that frame for every k (23.976 source, -ss rounds to microseconds)', async () => {
    const file = mediaPath('counter23976.mp4');
    const bad: string[] = [];
    const ks = [1, 2, 5, 7, 11, 13, 17, 19, 23, 100, 101, 239, 240, 241, 400, 401, 402, 403];
    for (const k of ks) {
      const t = framesToSeconds(k, FPS_23976);
      const p = await getThumbnail({ path: file, time: t, width: 64 });
      const got = await jpegCounter(p);
      if (got !== k) bad.push(`k=${k} t=${t} -> frame ${got}`);
    }
    console.log(`[thumbs frame-start 23.976] ${ks.length} probes, wrong frame: ${bad.length}${bad.length ? '\n  ' + bad.join('\n  ') : ''}`);
    expect(bad).toEqual([]);
  });

  it('thumbnail at a frame CENTER time shows the covering frame (what <video> shows), not the next one', async () => {
    const file = mediaPath('counter24.mp4');
    const bad: string[] = [];
    for (const k of [0, 1, 2, 10, 47, 48, 100]) {
      const t = frameCenterSeconds(k, FPS_24);
      const p = await getThumbnail({ path: file, time: t, width: 64 });
      const got = await jpegCounter(p);
      if (got !== k) bad.push(`k=${k} t=${t} -> frame ${got}`);
    }
    console.log(`[thumbs frame-center 24] wrong: ${bad.length} ${bad.join('; ')}`);
    expect(bad).toEqual([]);
  });

  it('thumbnail time base follows the container start (ts10 / TS / bframes): flash visible at t=6.0 exactly like <video>', async () => {
    const rows: string[] = [];
    for (const f of ['sync24.mp4', 'sync24_ts10.mp4', 'sync24.ts', 'sync24_bf.mp4']) {
      const p6 = await getThumbnail({ path: mediaPath(f), time: 6.0, width: 64 });
      const p6c = await getThumbnail({ path: mediaPath(f), time: frameCenterSeconds(144, FPS_24), width: 64 });
      const l6 = await jpegLuma(p6), l6c = await jpegLuma(p6c);
      rows.push(`${f}: luma@6.0=${l6} luma@center(144)=${l6c}`);
    }
    console.log(`[thumbs start_time]\n  ${rows.join('\n  ')}`);
  });
});

describe('waveform alignment', () => {
  it('audio that starts 0.5 s after the container start: first loud bucket must be at 0.5 s (bucket 25), as <video> plays it', async () => {
    for (const f of ['sync24_adelay.mkv', 'sync24_adelay.mp4']) {
      const w = await computeWaveform(mediaPath(f));
      const first = w.peaks.findIndex((v) => v > 40);
      const p = await probeMedia(mediaPath(f));
      const raw = await ffprobeJson(mediaPath(f));
      const aStart = Number(raw.streams.find((s) => s.codec_type === 'audio')?.start_time);
      console.log(`[waveform ${f}] audio stream start=${aStart} probe.startTime=${p.startTime} peaks=${w.peaks.length} duration=${w.duration} first loud bucket=${first} (=${fmt(first / WAVEFORM_RATE, 2)} s), want ${Math.round(0.5 * WAVEFORM_RATE)}`);
      expect(Math.abs(first - 0.5 * WAVEFORM_RATE)).toBeLessThanOrEqual(1);
    }
  });
  it('plain / ts10 / TS sources: beep buckets match (audio start - container start) + 2k s, i.e. <video> time', async () => {
    for (const f of ['sync24.mp4', 'sync24_ts10.mp4', 'sync24.ts', 'sync24_bf.mp4']) {
      const w = await computeWaveform(mediaPath(f));
      const raw = await ffprobeJson(mediaPath(f));
      const aStart = Number(raw.streams.find((s) => s.codec_type === 'audio')?.start_time ?? 0) - Number(raw.format.start_time ?? 0);
      const loud: number[] = [];
      for (let i = 0; i < w.peaks.length; i++) if (w.peaks[i] > 40 && (i === 0 || w.peaks[i - 1] <= 40)) loud.push(i);
      const want = [0, 1, 2, 3].map((k) => Math.floor((aStart + 2 * k) * WAVEFORM_RATE + 1e-6));
      console.log(`[waveform ${f}] audio offset=${fmt(aStart, 3)} onsets buckets=${loud.slice(0, 5)} want=${want} duration=${w.duration} peaks=${w.peaks.length}`);
      for (let k = 0; k < 4; k++) expect(Math.abs(loud[k] - want[k]), `${f} beep ${k}`).toBeLessThanOrEqual(1);
    }
  });
});
