/**
 * Follow-ups to the anamorphic / media-input-safety work (commit cfc1455), kept consistent across processes:
 *
 * - a stored `VideoStreamInfo.sar` is validated on project load (positive safe integers, ratio 1/16..16) and a
 *   garbage one is dropped and reported as a repair;
 * - the SAR validation + display-size math lives once in shared/media.ts, used by the export graph (crop offset,
 *   fitFilters' un-squeeze) and the preview compositor's probe fallback (Chromium's videoWidth / videoHeight);
 * - the exporter builds its ffmpeg file arguments with ffmpegFileArg, so a relative media path is refused
 *   instead of being read relative to the main process's working directory;
 * - thumbnails and filmstrips of an anamorphic source have its display shape, not the stored (squeezed) one.
 *
 * Real ffmpeg for the exporter and thumbnail cases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-sar-consistency-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import type { ExportSettings, MediaItem, MediaProbe, VideoStreamInfo } from '@shared/model';
import { createMediaItem, createProject, createSequence, normalizeProjectWithReport, serializeProject } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { MAX_SAR, MIN_SAR, sampleAspectRatio, saneSar, videoDisplaySize } from '@shared/media';
import { adaptFfmpegArgs, ffmpegMajorVersionSync, getFfmpegPath, getFfprobePath } from '../../electron/media/ffmpeg';
import { getFilmstrip, getThumbnail } from '../../electron/media/thumbs';
import { runExport } from '../../electron/export/exporter';
import { buildExportRequest } from '../../src/panels/export/request';
import { probedDisplaySize } from '../../src/playback/sequencePlayer';

const exec = promisify(execFile);
const FF = getFfmpegPath() ?? 'ffmpeg';
const FFPROBE = getFfprobePath() ?? 'ffprobe';
const FPS = { num: 24, den: 1 };

const files = {
  wide: path.join(tmp, 'dvd 16x9.mp4'), // 720x480 SAR 32:27 -> display 853x480
  narrow: path.join(tmp, 'dvd 4x3.mp4'), // 720x480 SAR 8:9 -> display 720x540
  square: path.join(tmp, 'square.mp4'), // 320x240 SAR 1:1
  odd: path.join(tmp, 'odd.mp4'), // 321x241 SAR 1:1 (yuv444p allows odd sizes)
  png: path.join(tmp, 'still.png'), // 64x48, no SAR recorded (ffprobe 0:1 / N/A)
  red: path.join(tmp, 'red.mp4'),
};

async function ff(args: string[]): Promise<void> {
  await exec(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...adaptFfmpegArgs(args, ffmpegMajorVersionSync(FF))]);
}

beforeAll(async () => {
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=720x480:rate=24:duration=2', '-vf', 'setsar=32/27', ...enc, files.wide]);
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=720x480:rate=24:duration=2', '-vf', 'setsar=8/9', ...enc, files.narrow]);
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2', '-vf', 'setsar=1', ...enc, files.square]);
  await ff(['-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=24:d=1', ...enc, files.red]);
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=321x241:rate=24:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p', files.odd]);
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=1', '-frames:v', '1', files.png]);
}, 60_000);

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

/** Width / height / SAR of an image or video file, per ffprobe. */
async function dims(file: string): Promise<{ w: number; h: number; sar: string | undefined }> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'json', file]);
  const s = JSON.parse(stdout).streams[0] as { width: number; height: number; sample_aspect_ratio?: string };
  return { w: s.width, h: s.height, sar: s.sample_aspect_ratio };
}

// -------------------------------------------------------------------------------------------------

describe('project load validates a stored sample aspect ratio', () => {
  const projectWith = (sar: unknown) => {
    const project = createProject('P');
    const m = { ...createMediaItem('/m/a.mp4', 'a.mp4'), id: 'm' };
    m.probe = {
      container: 'mp4', duration: 1, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 720, height: 480, fps: FPS, avgFps: FPS, isVfr: false, sar: sar as never },
    };
    project.media.m = m;
    return JSON.parse(serializeProject(project)) as unknown;
  };

  it('keeps a sane SAR (positive safe integers, ratio 1/16..16) without a repair', () => {
    for (const sar of [{ num: 32, den: 27 }, { num: 8, den: 9 }, { num: 1, den: 1 }, { num: 16, den: 1 }, { num: 1, den: 16 }, { num: 64, den: 4 }]) {
      const r = normalizeProjectWithReport(projectWith(sar));
      expect(r.project.media.m.probe?.video?.sar, JSON.stringify(sar)).toEqual(sar);
      expect(r.repairs, JSON.stringify(sar)).toEqual([]);
    }
  });

  it('drops a garbage SAR and reports it; the result normalizes cleanly', () => {
    const bad: unknown[] = [
      { num: 0, den: 1 }, { num: -32, den: 27 }, { num: 32, den: 0 }, { num: 32, den: -27 }, { num: 1.5, den: 1 },
      { num: 17, den: 1 }, { num: 1, den: 17 }, { num: 1e9, den: 1 }, { num: 2 ** 53, den: 2 ** 53 }, { num: '32', den: 27 },
      { num: 32 }, {}, 'x', 1, null, [32, 27],
    ];
    for (const sar of bad) {
      const r = normalizeProjectWithReport(projectWith(sar));
      const v = r.project.media.m.probe?.video;
      expect(v, JSON.stringify(sar)).toBeDefined();
      expect(v && 'sar' in v, JSON.stringify(sar)).toBe(false);
      expect(v?.width).toBe(720);
      expect(r.repairs, JSON.stringify(sar)).toEqual(['wrongly typed or out-of-range value reset to its default']);
      expect(normalizeProjectWithReport(JSON.parse(serializeProject(r.project))).repairs).toEqual([]);
    }
  });

  it('an absent SAR (older probe) is not a repair', () => {
    const raw = projectWith(undefined) as { media: { m: { probe: { video: Record<string, unknown> } } } };
    delete raw.media.m.probe.video.sar;
    const r = normalizeProjectWithReport(raw);
    expect(r.repairs).toEqual([]);
    expect(r.project.media.m.probe?.video && 'sar' in r.project.media.m.probe.video).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------

describe('shared/media.ts: one SAR rule and display-size helper for export and preview', () => {
  const base: VideoStreamInfo = { index: 0, codec: 'h264', width: 720, height: 480, fps: FPS, avgFps: FPS, isVfr: false };

  it('saneSar / sampleAspectRatio', () => {
    expect(MIN_SAR).toBe(1 / 16);
    expect(MAX_SAR).toBe(16);
    expect(saneSar({ num: 32, den: 27 })).toEqual({ num: 32, den: 27 });
    expect(sampleAspectRatio({ num: 32, den: 27 })).toBeCloseTo(32 / 27, 12);
    for (const s of [{ num: 0, den: 1 }, { num: 1, den: 0 }, { num: -1, den: 1 }, { num: 0.5, den: 1 }, { num: 17, den: 1 }, { num: 1, den: 17 },
      { num: Infinity, den: 1 }, { num: NaN, den: 1 }, 'x', null, undefined, 3]) {
      expect(saneSar(s), JSON.stringify(s)).toBeNull();
      expect(sampleAspectRatio(s), JSON.stringify(s)).toBe(1);
    }
  });

  it("'element' mode is the preview fallback (probedDisplaySize) and rounds like Chromium", () => {
    const cases: VideoStreamInfo[] = [
      base, { ...base, sar: { num: 32, den: 27 } }, { ...base, sar: { num: 8, den: 9 } },
      { ...base, width: 480, height: 720, rotation: 90, sar: { num: 32, den: 27 } },
      { ...base, width: 480, height: 720, rotation: 270, sar: { num: 8, den: 9 } },
      { ...base, width: 27, height: 31, rotation: 90, sar: { num: 3, den: 13 } },
    ];
    for (const v of cases) expect(probedDisplaySize(v)).toEqual(videoDisplaySize(v, 'element'));
    expect(videoDisplaySize({ ...base, sar: { num: 32, den: 27 } }, 'element')).toEqual({ width: 853, height: 480 });
    expect(videoDisplaySize({ ...base, sar: { num: 8, den: 9 } }, 'element')).toEqual({ width: 720, height: 540 });
    expect(videoDisplaySize({ ...base, width: 480, height: 720, rotation: 90, sar: { num: 32, den: 27 } }, 'element')).toEqual({ width: 480, height: 853 });
  });

  it("'filter' mode is the export fit input: even sizes, SAR inverted by autorotate on a 90/270 stream", () => {
    expect(videoDisplaySize({ ...base, sar: { num: 32, den: 27 } }, 'filter')).toEqual({ width: 854, height: 480 });
    expect(videoDisplaySize({ ...base, sar: { num: 8, den: 9 } }, 'filter')).toEqual({ width: 720, height: 540 });
    expect(videoDisplaySize({ ...base, width: 480, height: 720, rotation: 90, sar: { num: 32, den: 27 } }, 'filter')).toEqual({ width: 480, height: 854 });
    expect(videoDisplaySize({ ...base, sar: { num: 1000001, den: 1000000 } }, 'filter')).toEqual({ width: 720, height: 480 }); // within 1e-6
    expect(videoDisplaySize({ ...base, width: 1, height: 1, sar: { num: 1, den: 16 } }, 'filter')).toEqual({ width: 1, height: 16 });
    expect(videoDisplaySize({ ...base, width: 1, height: 1, sar: { num: 16, den: 17 } }, 'filter')).toEqual({ width: 1, height: 2 });
  });

  it('unknown size -> null; hostile SAR -> square in both modes', () => {
    for (const mode of ['element', 'filter'] as const) {
      expect(videoDisplaySize(undefined, mode)).toBeNull();
      expect(videoDisplaySize({ ...base, width: 0 }, mode)).toBeNull();
      expect(videoDisplaySize({ ...base, height: NaN }, mode)).toBeNull();
      for (const sar of [{ num: 0, den: 1 }, { num: 1e9, den: 1 }, 'x', null]) {
        expect(videoDisplaySize({ ...base, sar: sar as never }, mode)).toEqual({ width: 720, height: 480 });
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------

describe('exporter file arguments go through ffmpegFileArg', () => {
  const settings = (outputDir: string): ExportSettings => ({
    outputDir, fileName: 'out.mp4', width: 160, height: 120, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 35, videoBitrateKbps: 1000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
  });
  const probe = (): MediaProbe => ({
    container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 1, size: fs.statSync(files.red).size,
    video: { index: 0, codec: 'h264', width: 160, height: 120, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [], subtitles: [], startTime: 0, browserPlayable: true,
  });
  function request(mediaPath: string, outputDir: string) {
    const project = createProject('Args');
    const media: MediaItem = { ...createMediaItem(mediaPath, 'red.mp4'), id: 'm-red', kind: 'video', probe: probe() };
    project.media[media.id] = media;
    const seq = createSequence('Edit', FPS, 160, 120);
    seq.videoTracks[0].clips.push(makeClip({ mediaId: media.id, name: 'red', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 0));
    project.sequences = { [seq.id]: seq };
    project.activeSequenceId = seq.id;
    return buildExportRequest(project, seq, settings(outputDir));
  }

  it('an absolute media path still exports (single pass and chunked)', async () => {
    for (const chunked of [false, true]) {
      const out = fs.mkdtempSync(path.join(tmp, 'abs-'));
      const res = await runExport(request(files.red, out), undefined, undefined, { chunked });
      expect((await dims(res.outputPath)).w, String(chunked)).toBe(160);
      expect(fs.readdirSync(out), String(chunked)).toEqual(['out.mp4']);
    }
  }, 60_000);

  it('a relative media path is refused, not read relative to the main process cwd (single pass and chunked)', async () => {
    // The media lives in a folder under the cwd, so the relative path is genuinely relative on every platform
    // (on Windows the OS temp dir and the checkout can be on different drives, where path.relative is absolute).
    const local = fs.mkdtempSync(path.join(process.cwd(), '.tmp-relmedia-'));
    try {
      fs.copyFileSync(files.red, path.join(local, 'red.mp4'));
      const rel = path.relative(process.cwd(), path.join(local, 'red.mp4'));
      expect(path.isAbsolute(rel)).toBe(false);
      expect(rel.startsWith('..')).toBe(false);
      expect(fs.existsSync(path.resolve(rel))).toBe(true); // ffmpeg would find it relative to the cwd
      for (const chunked of [false, true]) {
        const out = fs.mkdtempSync(path.join(tmp, 'rel-'));
        await expect(runExport(request(rel, out), undefined, undefined, { chunked }), String(chunked)).rejects.toThrow(/absolute path/);
        expect(fs.readdirSync(out), String(chunked)).toEqual([]); // no output, no reserved temp left behind
      }
    } finally {
      fs.rmSync(local, { recursive: true, force: true });
    }
    expect(fs.existsSync(local)).toBe(false);
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------

describe('thumbnails and filmstrips have the display shape of an anamorphic source', () => {
  it('720x480 SAR 32:27 (16:9) -> 160x90, square pixels', async () => {
    expect(await dims(files.wide)).toMatchObject({ w: 720, h: 480, sar: '32:27' });
    const t = await dims(await getThumbnail({ path: files.wide, time: 1, width: 160 }));
    expect({ w: t.w, h: t.h }).toEqual({ w: 160, h: 90 });
    expect([undefined, '1:1', '0:1', 'N/A'], String(t.sar)).toContain(t.sar);
  });

  it('720x480 SAR 8:9 (4:3) -> 160x120', async () => {
    const t = await dims(await getThumbnail({ path: files.narrow, time: 1, width: 160 }));
    expect({ w: t.w, h: t.h }).toEqual({ w: 160, h: 120 });
  });

  it('a square-pixel source is unchanged (320x240 -> 160x120)', async () => {
    const t = await dims(await getThumbnail({ path: files.square, time: 1, width: 160 }));
    expect({ w: t.w, h: t.h }).toEqual({ w: 160, h: 120 });
  });

  it('an odd-sized square-pixel source and a still without a SAR keep their shape', async () => {
    const odd = await dims(await getThumbnail({ path: files.odd, time: 1, width: 160 }));
    expect({ w: odd.w, h: odd.h }).toEqual({ w: 160, h: 120 });
    const still = await dims(await getThumbnail({ path: files.png, time: 0, width: 32 }));
    expect({ w: still.w, h: still.h }).toEqual({ w: 32, h: 24 });
  });

  it('a batched filmstrip uses the display shape too', async () => {
    const paths = await getFilmstrip({ path: files.wide, times: [0, 0.5, 1, 1.5], width: 96 });
    for (const p of paths) {
      const d = await dims(p);
      expect({ w: d.w, h: d.h }, p).toEqual({ w: 96, h: 54 });
    }
  });
});
