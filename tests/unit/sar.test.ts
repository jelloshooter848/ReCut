/**
 * Anamorphic (non-square pixel) sources: the probe records the stream's sample aspect ratio, the export keeps a
 * cropped region where it was on screen using the DISPLAY size (the filter graph un-squeezes before the crop,
 * fitFilters), and the preview compositor's probe fallback uses the display size like Chromium's videoWidth.
 * Real ffmpeg: a 720x480 SAR 32:27 file (DVD 16:9) whose left half is white and right half gray.
 *
 * Also: renderGraph's output-vs-source check reads only the request's own media entries ("constructor" etc.).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, VideoStreamInfo } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createMediaItem, createProject, createSequence, normalizeProject, serializeProject } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { adaptFfmpegArgs, ffmpegMajorVersionSync, getFfmpegPath } from '../../electron/media/ffmpeg';
import { probeFromFfprobe, probeMedia } from '../../electron/media/probe';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { runExport } from '../../electron/export/exporter';
import { buildExportRequest } from '../../src/panels/export/request';
import { probedDisplaySize } from '../../src/playback/sequencePlayer';

const exec = promisify(execFile);
const FF = getFfmpegPath() ?? 'ffmpeg';
const FPS = { num: 24, den: 1 };
const SEQ_W = 1280, SEQ_H = 480;

let root: string;
let anamorphic: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-sar-'));
  anamorphic = path.join(root, 'dvd 16x9.mp4');
  // 720x480 storage, SAR 32:27 (display 853.3x480): storage columns 0..359 white, 360..719 gray.
  await exec(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs([
    '-f', 'lavfi', '-i', 'color=c=white:s=720x480:r=24:d=1',
    '-vf', 'drawbox=x=360:y=0:w=360:h=480:color=0x808080:t=fill,setsar=32/27',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', anamorphic,
  ], ffmpegMajorVersionSync(FF))]);
}, 60_000);

afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('probe records the sample aspect ratio', () => {
  it('720x480 SAR 32:27 -> sar 32/27 (storage width/height unchanged)', async () => {
    const p = await probeMedia(anamorphic);
    expect(p.video?.width).toBe(720);
    expect(p.video?.height).toBe(480);
    expect(p.video?.sar).toEqual({ num: 32, den: 27 });
  });

  it('parses ffprobe sample_aspect_ratio; unknown / 0:1 / garbage -> square', () => {
    const v = (sar: string | undefined) => probeFromFfprobe({
      streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 720, height: 576, r_frame_rate: '25/1', sample_aspect_ratio: sar }],
      format: { format_name: 'mp4', duration: '1' },
    }, '/x/a.mp4').video?.sar;
    expect(v('64:45')).toEqual({ num: 64, den: 45 });
    expect(v('16:15')).toEqual({ num: 16, den: 15 });
    expect(v('10:20')).toEqual({ num: 1, den: 2 });
    for (const s of [undefined, '0:1', '1:0', 'N/A', 'x', '-4:3', '1:1']) expect(v(s), String(s)).toEqual({ num: 1, den: 1 });
  });

  it('a stored sar survives project normalize / save', () => {
    const project = createProject('P');
    const m = { ...createMediaItem('/m/a.mp4', 'a.mp4'), id: 'm' };
    m.probe = {
      container: 'mp4', duration: 1, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'h264', width: 720, height: 480, fps: FPS, avgFps: FPS, isVfr: false, sar: { num: 32, den: 27 } },
    };
    project.media.m = m;
    const back = normalizeProject(JSON.parse(serializeProject(project)));
    expect(back.media.m.probe?.video?.sar).toEqual({ num: 32, den: 27 });
  });
});

describe('preview compositor fallback size (probe) is the display size, like videoWidth/videoHeight', () => {
  const base: VideoStreamInfo = { index: 0, codec: 'h264', width: 720, height: 480, fps: FPS, avgFps: FPS, isVfr: false };
  it('applies SAR the way Chromium sizes the element', () => {
    expect(probedDisplaySize({ ...base, sar: { num: 32, den: 27 } })).toEqual({ width: 853, height: 480 });
    expect(probedDisplaySize({ ...base, sar: { num: 8, den: 9 } })).toEqual({ width: 720, height: 540 });
    expect(probedDisplaySize({ ...base, sar: { num: 1, den: 1 } })).toEqual({ width: 720, height: 480 });
    expect(probedDisplaySize(base)).toEqual({ width: 720, height: 480 });
    // 90/270 rotation: width/height are already the rotated axes; SAR stretches the storage x axis (now vertical).
    expect(probedDisplaySize({ ...base, width: 480, height: 720, rotation: 90, sar: { num: 32, den: 27 } })).toEqual({ width: 480, height: 853 });
  });
  it('hostile stored SAR values are ignored', () => {
    for (const sar of [{ num: 0, den: 1 }, { num: -32, den: 27 }, { num: 32, den: 0 }, { num: Infinity, den: 1 }, { num: 1e9, den: 1 }, 'x', null]) {
      expect(probedDisplaySize({ ...base, sar: sar as never }), JSON.stringify(sar)).toEqual({ width: 720, height: 480 });
    }
    expect(probedDisplaySize(undefined)).toBeNull();
    expect(probedDisplaySize({ ...base, width: 0 })).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------

function settings(outputDir: string, fileName: string): ExportSettings {
  return {
    outputDir, fileName, width: SEQ_W, height: SEQ_H, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 0, videoBitrateKbps: 1000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
  };
}

async function exportWithCrop(media: MediaItem, crop: { left: number; right: number }, fileName: string): Promise<string> {
  const project = createProject('SAR');
  project.media[media.id] = media;
  const seq = createSequence('Edit', FPS, SEQ_W, SEQ_H);
  const clip = makeClip({ mediaId: media.id, name: 'dvd', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 0);
  clip.transform.crop = { left: crop.left, right: crop.right, top: 0, bottom: 0 };
  seq.videoTracks[0].clips.push(clip);
  project.sequences = { [seq.id]: seq };
  project.activeSequenceId = seq.id;
  const res = await runExport(buildExportRequest(project, seq, settings(root, fileName)));
  return res.outputPath;
}

/** Runs of the middle row of frame 6 as [class, start, end): 'k' black background, 'w' white, 'g' gray. */
async function middleRowRuns(file: string): Promise<[string, number, number][]> {
  const { stdout } = await exec(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'select=eq(n\\,6)', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 16 << 20 });
  const buf = stdout as unknown as Buffer;
  expect(buf.length).toBe(SEQ_W * SEQ_H);
  const row = buf.subarray((SEQ_H / 2) * SEQ_W, (SEQ_H / 2 + 1) * SEQ_W);
  const cls = (y: number) => (y < 50 ? 'k' : y > 200 ? 'w' : y > 90 && y < 170 ? 'g' : '?');
  const runs: [string, number, number][] = [];
  for (let x = 0; x < SEQ_W; x++) {
    const c = cls(row[x]);
    const last = runs[runs.length - 1];
    if (last && last[0] === c) last[2] = x + 1; else runs.push([c, x, x + 1]);
  }
  return runs.filter((r) => r[2] - r[1] > 2); // drop 1-2 px edge blends
}

describe('export crop on an anamorphic source uses the display width', () => {
  let media: MediaItem;
  beforeAll(async () => {
    media = { ...createMediaItem(anamorphic, 'dvd.mp4'), id: 'm-dvd', kind: 'video', probe: await probeMedia(anamorphic) };
  });

  // Display width 854 (853.3 rounded even) x 480, pillarboxed in 1280x480 at x = 213: white 213..640, gray 640..1067.
  it('uncropped: the un-squeezed picture fills 854 columns, white/gray boundary at the frame centre', async () => {
    const runs = await middleRowRuns(await exportWithCrop(media, { left: 0, right: 0 }, 'full.mp4'));
    expect(runs.map((r) => r[0]).join('')).toBe('kwgk');
    const [, w, g] = runs;
    expect(Math.abs(w[1] - 213)).toBeLessThanOrEqual(2);
    expect(Math.abs(w[2] - 640)).toBeLessThanOrEqual(2);
    expect(Math.abs(g[2] - 1067)).toBeLessThanOrEqual(2);
  }, 60_000);

  // Crop left 25% of the DISPLAY width (213.5 px): the rest keeps its on-screen position, 427..1067.
  it('crop left=0.25 removes 25% of the display width and the rest stays in place', async () => {
    const runs = await middleRowRuns(await exportWithCrop(media, { left: 0.25, right: 0 }, 'crop.mp4'));
    expect(runs.map((r) => r[0]).join('')).toBe('kwgk');
    const [, w, g] = runs;
    expect(Math.abs(w[1] - (213 + 0.25 * 854))).toBeLessThanOrEqual(2); // storage-width offset put it at ~410
    expect(Math.abs(w[2] - 640)).toBeLessThanOrEqual(2); // the white/gray boundary does not move
    expect(Math.abs(g[2] - 1067)).toBeLessThanOrEqual(2); // nor does the uncropped right edge
    expect(Math.abs((w[2] - w[1]) - 0.25 * 854)).toBeLessThanOrEqual(3);
  }, 60_000);

  it('crop right=0.25 likewise (left edge stays at 213)', async () => {
    const runs = await middleRowRuns(await exportWithCrop(media, { left: 0, right: 0.25 }, 'cropr.mp4'));
    expect(runs.map((r) => r[0]).join('')).toBe('kwgk');
    const [, w, g] = runs;
    expect(Math.abs(w[1] - 213)).toBeLessThanOrEqual(2);
    expect(Math.abs(w[2] - 640)).toBeLessThanOrEqual(2);
    expect(Math.abs(g[2] - (213 + 0.75 * 854))).toBeLessThanOrEqual(2);
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------

describe('renderGraph output-vs-source check reads only own media entries', () => {
  it('a clip with mediaId "constructor" is missing media (no inherited lookup)', () => {
    const project = createProject('P');
    const seq = createSequence('Edit', FPS, 320, 240);
    seq.videoTracks[0].clips.push(makeClip({ mediaId: 'constructor', name: 'ghost', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 0));
    seq.videoTracks[0].clips.push(makeClip({ mediaId: '__proto__', name: 'ghost2', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 12));
    project.sequences = { [seq.id]: seq };
    project.activeSequenceId = seq.id;
    const req: ExportRequest = buildExportRequest(project, seq, { ...settings(root, 'ghost.mp4'), width: 320, height: 240 });
    const inherited: string[] = [];
    const own = req.media;
    req.media = new Proxy(own, {
      get(target, key, recv) {
        if (typeof key === 'string' && !Object.hasOwn(target, key)) inherited.push(key);
        return Reflect.get(target, key, recv);
      },
    });
    const g = buildRenderGraph(req);
    expect(inherited).toEqual([]);
    expect(g.warnings.join('\n')).toMatch(/Clip "ghost" on .*media is missing/);
  });
});
