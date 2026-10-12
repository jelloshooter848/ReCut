/**
 * #154: a file whose audio starts before its video at 0 has a negative container start. The probe clamps the container
 * start to 0 (source time t is file time t, as Chromium plays it) but measured the video's start from the unclamped
 * start, so the video was placed late by the audio's lead: thumbnails showed the previous frame and an export from
 * the first frame began with black.
 *
 * Checked on real FFmpeg output (12-bit gray code of the frame number burned into the top half), plus the re-probe of
 * stored probes an older build made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-neg-start-'));
process.env.RECUT_CACHE_DIR = path.join(dir, 'cache');

import type { ExportSettings, MediaItem, MediaProbe, Rational } from '@shared/model';
import { createMediaItem, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { PROBE_REVISION } from '@shared/media';
import { runExport } from '../../electron/export/exporter';
import { probeMedia } from '../../electron/media/probe';
import { getThumbnail } from '../../electron/media/thumbs';
import { getFfmpegPath, getFfprobePath } from '../../electron/media/ffmpeg';
import { useStore, resetStore } from '../../src/state/store';
import { refreshStaleProbes } from '../../src/state/mediaActions';

const exec = promisify(execFile);
const FFMPEG = getFfmpegPath() ?? 'ffmpeg';
const FFPROBE = getFfprobePath() ?? 'ffprobe';
const F25: Rational = { num: 25, den: 1 };
const W = 192, H = 64;
const file = path.join(dir, 'audio-first.mkv');

async function ff(args: string[]): Promise<Buffer> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

/** Gray-coded frame index of every frame of an image or video's first video stream. */
async function frameIndices(input: string): Promise<number[]> {
  const b = await ff(['-i', input, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', 'crop=iw:ih/2:0:0,scale=12:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const out: number[] = [];
  for (let i = 0; i + 12 <= b.length; i += 12) {
    let g = 0;
    for (let k = 0; k < 12; k++) if (b[i + k] > 125) g |= 1 << k;
    let n = g;
    for (let s = g >> 1; s; s >>= 1) n ^= s;
    out.push(n);
  }
  return out;
}

/** Mean luma of the flat grey bottom half of each frame (128 in the source; black is about 16). */
async function bottomLuma(input: string): Promise<number[]> {
  const b = await ff(['-i', input, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', 'crop=iw:ih/2:0:ih/2,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  return [...b];
}

const G = '(bitor(N,floor(N/2))-bitand(N,floor(N/2)))';

beforeAll(async () => {
  // Video from 0; its AAC audio moved 0.5 s earlier and kept there: the container starts at about -0.52 s.
  await ff(['-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=25,trim=end_frame=200,geq=lum='if(lt(Y,H/2),if(bitand(${G},pow(2,floor(X*12/W))),235,16),128)':cb=128:cr=128`,
    '-itsoffset', '-0.5', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=9', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-avoid_negative_ts', 'disabled', file]);
}, 60_000);
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('negative container start (#154)', () => {
  it('the fixture really starts before 0, with its video at 0', async () => {
    const { stdout } = await exec(FFPROBE, ['-v', 'error', '-show_entries', 'format=start_time:stream=codec_type,start_time', '-of', 'json', file]);
    const j = JSON.parse(stdout) as { format: { start_time: string }; streams: { codec_type: string; start_time: string }[] };
    expect(Number(j.format.start_time)).toBeLessThan(-0.4);
    expect(Number(j.streams.find((s) => s.codec_type === 'video')!.start_time)).toBe(0);
  });

  it('probe: container start 0, no video start offset, the current probe revision', async () => {
    const p = await probeMedia(file);
    expect(p.startTime).toBe(0);
    expect(p.video?.startTime ?? 0).toBe(0); // was 0.52: measured from the negative start
    expect(p.audio[0].startTime ?? 0).toBe(0);
    expect(p.probeRev).toBe(PROBE_REVISION);
    expect(p.startLead).toBeGreaterThan(0.4); // FFmpeg's -ss / -t count from the raw start, this far before 0
    expect(p.startLead).toBeLessThan(0.6);
  });

  it('thumbnails show the frame at the time asked for', async () => {
    for (const k of [10, 48, 101]) {
      const thumb = await getThumbnail({ path: file, time: (k + 0.5) / 25, width: W });
      expect(await frameIndices(thumb), `frame ${k}`).toEqual([k]);
    }
  }, 60_000);

  it('an export from the first frame starts with that frame, not black', async () => {
    const probe = await probeMedia(file);
    const m: MediaItem = { ...createMediaItem(file, 'audio-first.mkv'), id: 'm', kind: 'video', probe };
    const s = createSequence('S', F25, W, H);
    s.videoTracks[0].clips.push(makeClip({ mediaId: 'm', name: 'v', sourceIn: 0, duration: 5, kind: 'video', linkId: null }, 0));
    const settings: ExportSettings = {
      outputDir: dir, fileName: 'out.mp4', width: W, height: H, fps: F25, videoCodec: 'libx264', qualityMode: 'crf', crf: 10,
      videoBitrateKbps: 2000, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
      rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
    };
    const res = await runExport({ sequence: s, media: { m }, settings }, undefined, undefined, { chunked: false });
    expect(await frameIndices(res.outputPath)).toEqual([0, 1, 2, 3, 4]);
    for (const l of await bottomLuma(res.outputPath)) expect(l).toBeGreaterThan(100); // the first frame used to be black
  }, 120_000);

  it('an export from later in the file (an input seek) has every frame, in place', async () => {
    const probe = await probeMedia(file);
    const m: MediaItem = { ...createMediaItem(file, 'audio-first.mkv'), id: 'm', kind: 'video', probe };
    const s = createSequence('S', F25, W, H);
    s.videoTracks[0].clips.push(makeClip({ mediaId: 'm', name: 'v', sourceIn: 4, duration: 50, kind: 'video', linkId: null }, 0));
    const settings: ExportSettings = {
      outputDir: dir, fileName: 'later.mp4', width: W, height: H, fps: F25, videoCodec: 'libx264', qualityMode: 'crf', crf: 10,
      videoBitrateKbps: 2000, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
      rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
    };
    const res = await runExport({ sequence: s, media: { m }, settings }, undefined, undefined, { chunked: false });
    expect(await frameIndices(res.outputPath)).toEqual(Array.from({ length: 50 }, (_, i) => 100 + i));
  }, 120_000);
});

describe('stored probes from before the fix are probed again after opening (#154)', () => {
  const g = globalThis as unknown as { window?: unknown; recut?: unknown };
  const probe = (over: Partial<MediaProbe>, videoStart?: number): MediaProbe => ({
    container: 'matroska', duration: 8, size: 1, startTime: 0, browserPlayable: true, subtitles: [], audio: [],
    video: { index: 0, codec: 'h264', width: W, height: H, fps: F25, avgFps: F25, isVfr: false, ...(videoStart ? { startTime: videoStart } : {}) },
    ...over,
  });

  it('only online media whose old probe has a video start offset', async () => {
    resetStore();
    const asked: string[] = [];
    g.window = globalThis;
    g.recut = { probe: async (p: string) => { asked.push(path.basename(p)); return probe({ probeRev: PROBE_REVISION }); }, stat: async () => ({ exists: true }) };
    try {
      const media = (name: string, pr: MediaProbe, offline = false): MediaItem => ({ ...createMediaItem(`/m/${name}`, name), kind: 'video', probe: pr, offline });
      const stale = media('stale.mkv', probe({}, 0.521));
      useStore.getState().addMedia([
        stale, media('zero.mkv', probe({})), media('current.mkv', probe({ probeRev: PROBE_REVISION }, 0.5)), media('offline.mkv', probe({}, 0.5), true),
      ]);
      expect(await refreshStaleProbes()).toEqual([stale.id]);
      expect(asked).toEqual(['stale.mkv']);
      const now = useStore.getState().project.media[stale.id].probe!;
      expect(now.video?.startTime ?? 0).toBe(0);
      expect(now.probeRev).toBe(PROBE_REVISION);
    } finally { delete g.recut; delete g.window; }
  });
});
