/**
 * MPEG-TS / MPEG-PS sources whose video (or audio) stream starts after the container start
 * (bugs/closed/2026-10-09-ts-late-video-export-early.md).
 *
 * For formats with discontinuous timestamps (MPEG-TS, MPEG-PS, FLV) FFmpeg recomputes the input's start time from the
 * streams the command maps (fftools correct_input_start_times), and `-copyts -start_at_zero` (or no `-copyts`) uses
 * that as zero. An export input that mapped only a late video stream was rebased to the video start: the clip came out
 * early by the offset (12-14 frames at 25 fps for a 0.5 s delay). Linked picture + sound sharing one input, and an MKV
 * of the same streams, were exact. The same zero moved scene-detection cuts, thumbnails (one frame early, FFmpeg 6.1),
 * channel proxies (one audio stream) and media proxies that leave out the file's earliest stream.
 *
 * The export now opens inputs with `-copyts` alone and subtracts the probed container start (clamped at 0, the preview's
 * zero) in its filters. That also moved sources with a negative container start (an MKV whose audio starts before
 * its video, as AAC priming does in FFmpeg 6.1's MKVs), which `-start_at_zero` had shifted by that lead: they exported
 * early by it (one frame for the 0.021 s of AAC priming at 24-30 fps).
 *
 * Checked here on real FFmpeg output: exported frame indices (12-bit gray code burned into the top half) for a TS with
 * late video, its MKV remux, a start-0 MP4 and a negative-start MKV, video-only and linked; an audio-only clip and a
 * channel proxy of a TS with late audio, scene cuts and thumbnails of a TS with late video against their MKV remux,
 * and a media proxy that maps only some of a TS's streams.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ts-start-'));
process.env.RECUT_CACHE_DIR = path.join(dir, 'cache');

import type { AudioChannelSelection, ExportSettings, MediaItem, Rational, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { runExport } from '../../electron/export/exporter';
import { probeMedia } from '../../electron/media/probe';
import { getFfmpegPath, getFfprobePath } from '../../electron/media/ffmpeg';
import { buildChannelProxyArgs, startChannelProxyJob } from '../../electron/media/channelProxy';
import { buildProxyArgs } from '../../electron/media/proxy';
import { startSceneDetectJob } from '../../electron/media/sceneDetect';
import { getThumbnail } from '../../electron/media/thumbs';
import { JobQueue } from '../../electron/jobs/jobQueue';

const exec = promisify(execFile);
const FFMPEG = getFfmpegPath() ?? 'ffmpeg';
const FFPROBE = getFfprobePath() ?? 'ffprobe';
const F25: Rational = { num: 25, den: 1 };
const W = 192, H = 64;

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

async function ff(args: string[]): Promise<Buffer> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

function item(id: string, file: string, probe: MediaItem['probe']): MediaItem {
  return {
    id, name: path.basename(file), path: file, kind: 'video', category: 'Other', identity: {}, binId: null, probe,
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}

async function probed(id: string, file: string): Promise<MediaItem> { return item(id, file, await probeMedia(file)); }

let outN = 0;
function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `out${outN++}.mp4`, width: W, height: H, fps: F25,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 10, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

/** A clip of `frames` frames from source second `srcIn`: picture only, picture + linked sound, or sound only. */
function sequenceOf(m: MediaItem, srcIn: number, frames: number, mode: 'video' | 'linked' | 'audio'): Sequence {
  const s = createSequence('S', F25, W, H);
  const linkId = mode === 'linked' ? 'L1' : null;
  if (mode !== 'audio') s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'v', sourceIn: srcIn, duration: frames, kind: 'video', linkId }, 0));
  if (mode !== 'video') s.audioTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'a', sourceIn: srcIn, duration: frames, kind: 'audio', linkId, audioStream: m.probe!.audio[0].index }, 0));
  return s;
}

function request(m: MediaItem, s: Sequence): ExportRequest {
  return { sequence: s, media: { [m.id]: m }, settings: settings() };
}

/** 12-bit gray code of the frame number N in 12 blocks across the top half; the bottom half is flat grey. */
const G = '(bitor(N,floor(N/2))-bitand(N,floor(N/2)))';
const GRAY_VIDEO = `nullsrc=s=${W}x${H}:r=25,trim=end_frame=300,geq=lum='if(lt(Y,H/2),if(bitand(${G},pow(2,floor(X*12/W))),235,16),128)':cb=128:cr=128`;
const VIDEO_ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-g', '25', '-pix_fmt', 'yuv420p'];

/** Gray-coded source frame index of every frame of `file`'s first video stream. */
async function frameIndices(file: string): Promise<number[]> {
  const b = await ff(['-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', 'crop=iw:ih/2:0:0,scale=12:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
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

/** Seconds from the start of `file`'s first audio stream (decoded from 0) to the first sample above -26 dBFS. */
async function audioOnset(file: string): Promise<number> {
  const b = await ff(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  for (let i = 0; i + 4 <= b.length; i += 4) if (Math.abs(b.readFloatLE(i)) > 0.05) return i / 4 / 48000;
  return Infinity;
}

/**
 * The editor's frame choice (SequencePlayer / renderGraph M-03): timeline frame n of a clip with in-point `srcIn`
 * shows the media frame covering srcIn + n/fps + half a media frame, in container-relative seconds. The video stream
 * starts `vStart` seconds after the container start (MediaProbe video.startTime). Here media fps = sequence fps = 25.
 */
function expectedFrames(srcIn: number, frames: number, vStart: number): number[] {
  return Array.from({ length: frames }, (_, n) => Math.floor((srcIn + n / 25 + 0.5 / 25 - vStart) * 25 + 1e-6));
}

// ---------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------

describe('export inputs use the probed container start, not -start_at_zero', () => {
  // A broadcast-style TS: container (audio) start 1.4 s, video 0.541333 s later; 25 fps.
  const ts: MediaItem = item('ts', '/media/late.ts', {
    container: 'mpegts', duration: 10, size: 1, startTime: 1.4, browserPlayable: false, subtitles: [],
    video: { index: 0, codec: 'h264', width: W, height: H, fps: F25, avgFps: F25, isVfr: false, startTime: 0.541333 },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
  });

  it('a video-only clip: -copyts, and the trim / setpts add the container start', () => {
    const g = buildRenderGraph(request(ts, sequenceOf(ts, 2, 25, 'video')));
    expect(g.args).not.toContain('-start_at_zero');
    const i = g.args.indexOf('-copyts');
    // 1 s of pre-roll before the trim point for a non-exact container: seek 2 - 0.02 - 1, container-relative.
    expect(g.args.slice(i, i + 5)).toEqual(['-copyts', '-ss', '0.98', '-t', '2.27']);
    // trim from 1.4 + 2 - 1/50, rebase to 1.4 + 2 (+1 µs bias): container-relative 2 s is source frame time 0.
    expect(g.filterGraph).toContain('[0:v:0]trim=start=3.38:duration=1.27,settb=AVTB,setpts=PTS-3.400001/TB,fps=25/1:start_time=0');
  });

  it('a linked clip shares one input, and the audio chain adds the container start too', () => {
    const g = buildRenderGraph(request(ts, sequenceOf(ts, 2, 25, 'linked')));
    expect(g.inputCount).toBe(1);
    expect(g.args).not.toContain('-start_at_zero');
    expect(g.filterGraph).toContain('[0:v:0]trim=start=3.38:');
    expect(g.filterGraph).toMatch(/\[0:1\]atrim=start=3\.4:duration=1\.25,asetpts=PTS-3\.4\/TB,aresample=async=1:first_pts=0/);
  });

  it('a source starting at 0 keeps the filters it had', () => {
    const zero: MediaItem = { ...ts, id: 'z', path: '/media/z.mkv', probe: { ...ts.probe!, container: 'matroska', startTime: 0, video: { ...ts.probe!.video!, startTime: 0 } } };
    const g = buildRenderGraph(request(zero, sequenceOf(zero, 2, 25, 'linked')));
    expect(g.args).not.toContain('-start_at_zero');
    expect(g.filterGraph).toContain('[0:v:0]trim=start=1.98:duration=1.27,settb=AVTB,setpts=PTS-2.000001/TB,fps=25/1:start_time=0');
    expect(g.filterGraph).toMatch(/\[0:1\]atrim=start=2:duration=1\.25,asetpts=PTS-2\/TB,/);
  });

  it('media proxy: -copyts with -itsoffset of minus the container start, CFR as before', () => {
    const args = buildProxyArgs({ mediaId: 'ts', path: '/media/late.ts', height: 240 }, { targetHeight: 240, hasVideo: true, hasAudio: true, outPart: '/c/p.part', startTime: 1.4 });
    expect(args.slice(0, 5)).toEqual(['-copyts', '-itsoffset', '-1.4', '-i', 'file:/media/late.ts']);
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4)).toEqual(['-map', '0:v:0', '-fps_mode', 'cfr']);
    const zero = buildProxyArgs({ mediaId: 'z', path: '/media/z.mp4', height: 240 }, { targetHeight: 240, hasVideo: true, hasAudio: true, outPart: '/c/p.part', startTime: 0 });
    expect(zero.slice(0, 3)).toEqual(['-copyts', '-i', 'file:/media/z.mp4']);
  });

  it('channel proxy: -copyts, rebased by the container start before the pan', () => {
    const args = buildChannelProxyArgs('/media/late.ts', 1, 'pan=stereo|c0=c0|c1=c0', '/c/p.part', 1.4);
    expect(args.slice(0, 3)).toEqual(['-copyts', '-i', 'file:/media/late.ts']);
    expect(args[args.indexOf('-af') + 1]).toBe('asetpts=PTS-1.4/TB,pan=stereo|c0=c0|c1=c0,aresample=async=1:first_pts=0');
  });
});

// ---------------------------------------------------------------------------------------------------
// Real exports
// ---------------------------------------------------------------------------------------------------

describe('exported frames: a TS whose video starts 0.5 s after its audio, and sources that did not move', () => {
  let tsV: MediaItem, mkvV: MediaItem, mp4: MediaItem, negMkv: MediaItem;

  beforeAll(async () => {
    const tsFile = path.join(dir, 'vlate.ts'), mkvFile = path.join(dir, 'vlate.mkv'), mp4File = path.join(dir, 'zero.mp4');
    await ff(['-itsoffset', '0.5', '-f', 'lavfi', '-i', GRAY_VIDEO, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12.5',
      '-map', '0:v', '-map', '1:a', ...VIDEO_ENC, '-c:a', 'aac', '-ac', '2', '-f', 'mpegts', tsFile]);
    await ff(['-i', tsFile, '-map', '0', '-c', 'copy', mkvFile]);
    await ff(['-f', 'lavfi', '-i', GRAY_VIDEO, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
      '-map', '0:v', '-map', '1:a', ...VIDEO_ENC, '-c:a', 'aac', '-ac', '2', mp4File]);
    // An MKV whose audio starts 0.1 s before its video: a negative container start (-0.1 s). Set explicitly (PCM audio
    // moved by -itsoffset, FFmpeg's shift to non-negative timestamps turned off) rather than through AAC priming, which
    // only FFmpeg 6.1 writes into an MKV this way (-0.021 s; 8.1 and 9.0 start such a file at 0).
    const negFile = path.join(dir, 'negstart.mkv');
    await ff(['-f', 'lavfi', '-i', GRAY_VIDEO, '-itsoffset', '-0.1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
      '-map', '0:v', '-map', '1:a', ...VIDEO_ENC, '-c:a', 'pcm_s16le', '-ac', '2', '-avoid_negative_ts', 'disabled', negFile]);
    [tsV, mkvV, mp4, negMkv] = await Promise.all([probed('tsV', tsFile), probed('mkvV', mkvFile), probed('mp4', mp4File), probed('neg', negFile)]);
  }, 120_000);

  it('the fixtures: the TS starts at its audio, the video ~0.54 s later; the MKV keeps that offset; the MP4 starts at 0', () => {
    expect(tsV.probe!.startTime).toBeGreaterThan(0.5);
    expect(tsV.probe!.video!.startTime).toBeGreaterThan(0.5);
    expect(tsV.probe!.video!.startTime).toBeLessThan(0.6);
    expect(mkvV.probe!.startTime).toBe(0);
    expect(Math.abs(mkvV.probe!.video!.startTime! - tsV.probe!.video!.startTime!)).toBeLessThan(0.001);
    expect(mp4.probe!.startTime).toBe(0);
    expect(mp4.probe!.video!.startTime ?? 0).toBe(0);
  });

  // vStart: where the video starts on ReCut's source timeline (container-relative, the container start clamped at 0).
  const probedStart = (m: MediaItem) => m.probe!.video!.startTime ?? 0;
  const cases: { name: string; media: () => MediaItem; vStart: (m: MediaItem) => number }[] = [
    { name: 'TS, late video', media: () => tsV, vStart: probedStart },
    { name: 'MKV remux of the same streams', media: () => mkvV, vStart: probedStart },
    { name: 'MP4 starting at 0', media: () => mp4, vStart: probedStart },
    // The container start is clamped at 0, so source time t is file time t and the video's frame k is at k/25, as
    // Chromium plays it (requestVideoFrameCallback mediaTime N/24 for frame N of a 24 fps variant). The probe's
    // video.startTime (0.1, measured from the negative start) is not where the video is on that timeline
    // (bugs/open/2026-10-09-negative-start-video-start-offset.md).
    { name: 'MKV with a negative container start (audio from -0.1 s)', media: () => negMkv, vStart: () => 0 },
  ];

  it('the negative-start fixture: container start -0.1 s, video at 0', async () => {
    const { stdout } = await exec(FFPROBE, ['-v', 'error', '-show_entries', 'format=start_time:stream=codec_type,start_time', '-of', 'json', negMkv.path]);
    const j = JSON.parse(stdout) as { format: { start_time: string }; streams: { codec_type: string; start_time: string }[] };
    expect(Number(j.format.start_time)).toBeCloseTo(-0.1, 3);
    expect(Number(j.streams.find((x) => x.codec_type === 'video')!.start_time)).toBeCloseTo(0, 3);
    expect(Number(j.streams.find((x) => x.codec_type === 'audio')!.start_time)).toBeCloseTo(-0.1, 3);
    expect(negMkv.probe!.startTime).toBe(0);
    expect(negMkv.probe!.video!.startTime).toBeCloseTo(0.1, 3);
  });

  for (const c of cases) {
    for (const mode of ['video', 'linked'] as const) {
      it(`${c.name}: ${mode === 'video' ? 'video-only' : 'linked picture + sound'} clip shows the editor's frames`, async () => {
        const m = c.media();
        const vStart = c.vStart(m);
        const rows: string[] = [];
        for (const srcIn of [2, 7.013]) {
          const res = await runExport(request(m, sequenceOf(m, srcIn, 25, mode)), undefined, undefined, { chunked: false });
          const got = await frameIndices(res.outputPath);
          const want = expectedFrames(srcIn, 25, vStart);
          if (JSON.stringify(got) !== JSON.stringify(want)) rows.push(`in ${srcIn}: got ${got[0]}..${got[got.length - 1]} (${got.length}), want ${want[0]}..${want[want.length - 1]} (${want.length})`);
        }
        expect(rows).toEqual([]);
      }, 120_000);
    }
  }
});

describe('a TS whose audio starts 0.5 s after its video', () => {
  let tsA: MediaItem, mkvA: MediaItem;

  beforeAll(async () => {
    const tsFile = path.join(dir, 'alate.ts'), mkvFile = path.join(dir, 'alate.mkv');
    await ff(['-f', 'lavfi', '-i', GRAY_VIDEO, '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=11',
      '-map', '0:v', '-map', '1:a', ...VIDEO_ENC, '-c:a', 'mp2', '-ac', '2', '-f', 'mpegts', tsFile]);
    await ff(['-i', tsFile, '-map', '0', '-c', 'copy', mkvFile]);
    [tsA, mkvA] = await Promise.all([probed('tsA', tsFile), probed('mkvA', mkvFile)]);
    // The video defines the container start; the audio stream starts 0.5 s later (measured below via the MKV remux).
    expect(tsA.probe!.video!.startTime ?? 0).toBe(0);
  }, 120_000);

  it('an audio-only clip starts its sound where the MKV remux does (the late start stays silent)', async () => {
    const onsets: number[] = [];
    for (const m of [tsA, mkvA]) {
      const res = await runExport(request(m, sequenceOf(m, 0.2, 25, 'audio')), undefined, undefined, { chunked: false });
      onsets.push(await audioOnset(res.outputPath));
    }
    // 0.5 s late stream, in-point 0.2 s: sound from ~0.3 s (plus codec delays, the same for both sources).
    expect(onsets[0]).toBeGreaterThan(0.28);
    expect(onsets[0]).toBeLessThan(0.34);
    expect(Math.abs(onsets[0] - onsets[1])).toBeLessThan(0.003);
  }, 120_000);

  it('the channel proxy is padded to the container start, like the MKV remux', async () => {
    const sel: AudioChannelSelection = { mode: 'channel', channel: 'FL' };
    const onsets: number[] = [];
    for (const m of [tsA, mkvA]) {
      const q = new JobQueue({ throttleMs: 10 });
      const job = await startChannelProxyJob(q, { mediaId: m.id, path: m.path, stream: m.probe!.audio[0].index, selection: sel });
      const final = await q.waitFor(job.id);
      expect(final.status).toBe('done');
      onsets.push(await audioOnset((final.result as { path: string }).path));
    }
    expect(onsets[0]).toBeGreaterThan(0.48);
    expect(onsets[0]).toBeLessThan(0.54);
    expect(Math.abs(onsets[0] - onsets[1])).toBeLessThan(0.003);
  }, 120_000);
});

describe('scene detection of a TS whose video starts 0.5 s after its audio', () => {
  it('cuts are container-relative, as for the MKV remux', async () => {
    const tsFile = path.join(dir, 'scenes.ts'), mkvFile = path.join(dir, 'scenes.mkv');
    // A colour change every second of video: cuts at video start + 1, + 2, + 3.
    await ff(['-itsoffset', '0.5', '-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=25,trim=end_frame=100,geq=lum='if(mod(floor(N/25),2),235,16)':cb=128:cr='if(mod(floor(N/50),2),200,60)'`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4.5', '-map', '0:v', '-map', '1:a', ...VIDEO_ENC, '-c:a', 'aac', '-f', 'mpegts', tsFile]);
    await ff(['-i', tsFile, '-map', '0', '-c', 'copy', mkvFile]);
    const cuts: number[][] = [];
    let vStart = 0;
    for (const file of [tsFile, mkvFile]) {
      const p = await probeMedia(file);
      if (file === tsFile) vStart = p.video!.startTime!;
      const q = new JobQueue({ throttleMs: 10 });
      const job = startSceneDetectJob(q, { mediaId: path.basename(file), path: file, threshold: 0.3, duration: p.duration, minSceneSeconds: 0.5 });
      const final = await q.waitFor(job.id);
      expect(final.status).toBe('done');
      cuts.push((final.result as { boundaries: number[] }).boundaries);
    }
    expect(vStart).toBeGreaterThan(0.5);
    for (const b of cuts) {
      expect(b).toHaveLength(3);
      b.forEach((t, k) => expect(Math.abs(t - (vStart + k + 1))).toBeLessThan(0.002));
    }
  }, 120_000);
});

describe('thumbnails of a TS whose video starts 0.5 s after its audio', () => {
  it('show the frame covering the time (what <video> shows), as for the MKV remux', async () => {
    // All-intra, so the seek itself lands on any frame and only FFmpeg's drop of the frames before the seek point counts.
    // Without -copyts FFmpeg 6.1 showed the frame before (8.1 and 9.0 did not).
    const tsFile = path.join(dir, 'thumbs.ts'), mkvFile = path.join(dir, 'thumbs.mkv');
    await ff(['-itsoffset', '0.5', '-f', 'lavfi', '-i', GRAY_VIDEO, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12.5',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-g', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', tsFile]);
    await ff(['-i', tsFile, '-map', '0', '-c', 'copy', mkvFile]);
    const rows: string[] = [];
    for (const file of [tsFile, mkvFile]) {
      const vStart = (await probeMedia(file)).video!.startTime!;
      for (const t of [1.0, 2.3, 2.95, 5.5]) {
        const [got] = await frameIndices(await getThumbnail({ path: file, time: t, width: W }));
        const want = Math.floor((t - vStart) * 25 + 1e-6);
        if (got !== want) rows.push(`${path.basename(file)} at ${t}: frame ${got}, want ${want}`);
      }
    }
    expect(rows).toEqual([]);
  }, 120_000);
});

describe('a media proxy that maps only some streams of a TS', () => {
  it('stays on the container start (a fallback plan with the later of two audio streams)', async () => {
    // Audio 1 from the container start, audio 2 from 0.3 s, video from 0.5 s.
    const tsFile = path.join(dir, 'twoaudio.ts');
    await ff(['-itsoffset', '0.5', '-f', 'lavfi', '-i', GRAY_VIDEO, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12.5',
      '-itsoffset', '0.3', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=12', '-map', '0:v', '-map', '1:a', '-map', '2:a',
      ...VIDEO_ENC, '-c:a', 'mp2', '-f', 'mpegts', tsFile]);
    const m = await probed('two', tsFile);
    expect(m.probe!.audio.map((a) => a.index)).toEqual([1, 2]);
    const firstFrames: number[][] = [];
    for (const audioStreams of [undefined, [2]]) {
      const out = path.join(dir, `proxy-${audioStreams ? 'a2' : 'all'}.mp4`);
      await ff(buildProxyArgs({ mediaId: m.id, path: tsFile, height: H }, { targetHeight: H, hasVideo: true, hasAudio: true, outPart: out, audioStreams, startTime: m.probe!.startTime }));
      firstFrames.push((await frameIndices(out)).slice(0, 40));
    }
    // CFR from 0: the first frame repeats until the video starts (0.5 s + the encoder delay, 13-14 slots).
    const lead = firstFrames[0].findIndex((n) => n > 0);
    expect(lead).toBeGreaterThanOrEqual(13);
    expect(lead).toBeLessThanOrEqual(15);
    expect(firstFrames[1]).toEqual(firstFrames[0]);
  }, 120_000);
});
