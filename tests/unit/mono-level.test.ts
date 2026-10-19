/**
 * Mono sources: the preview level matches the export level (bugs/closed/2026-10-07-mono-preview-level.md @ 59eafc6).
 *
 * Export side, measured on real exports (runExport) of the same 1 kHz tone (peak 0.25, -15.05 dBFS RMS):
 * a stereo export puts a mono stream on both channels at -3.01 dB (FFmpeg's equal-power up-mix), a stereo stream at
 * its own level. Proxies are stereo-encoded by FFmpeg (buildProxyArgs, `-ac 2`): the same -3.01 dB is baked in.
 *
 * Preview side: the Web Audio destination up-mixes a mono master bus to L and R at unity ("speakers", Web Audio spec
 * 6.2 up-mixing; measured in tests/e2e/mono-level.spec.ts), so the level heard per channel is
 * played-file level x planFrame gain. That prediction must equal the export's level for every path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Sequence } from '@shared/model';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { runExport } from '../../electron/export/exporter';
import { buildProxyArgs } from '../../electron/media/proxy';
import { planFrame } from '../../src/playback/planner';
import { previewUpmixGain } from '../../src/playback/mediaSource';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const FPS = { num: 24, den: 1 };
const TONE = 'sine=f=1000:r=48000:d=4,volume=2'; // peak 0.25: -15.05 dBFS RMS
const TONE2 = `${TONE},pan=stereo|c0=c0|c1=c0`; // the same tone at unity on both channels
const TONE_DB = 20 * Math.log10(0.25 / Math.SQRT2);
const UPMIX_DB = 20 * Math.log10(Math.SQRT1_2); // -3.01

let dir: string;
let n = 0;
const files: Record<string, string> = {};
const items: Record<string, MediaItem> = {};

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

async function probe(file: string): Promise<MediaProbe> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const rat = (r: string) => { const [a, b] = r.split('/').map(Number); return { num: a, den: b || 1 }; };
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio: j.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => ({
      index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
    })),
    subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: !/ac3/.test(j.streams.map((s: any) => s.codec_name).join()),
  };
}

/** RMS level (dBFS) of each channel of a file's audio stream `map` between 0.5 s and 2.5 s. */
async function channelRms(file: string, map = '0:a:0'): Promise<number[]> {
  const { stderr } = await exec(FFMPEG, ['-hide_banner', '-i', file, '-map', map, '-af', 'atrim=0.5:2.5,astats=measure_overall=none:measure_perchannel=RMS_level', '-f', 'null', '-']);
  return [...stderr.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].map((m) => Number(m[1]));
}

function seqFor(mediaId: string, stream?: number): Sequence {
  const s = createSequence('S', FPS, 64, 36);
  s.audioTracks[0].clips.push(makeClip({ mediaId, name: 'a', sourceIn: 0, duration: 72, kind: 'audio', ...(stream !== undefined ? { audioStream: stream } : {}) }, 0));
  return s;
}

function exportSettings(): ExportSettings {
  return {
    outputDir: dir, fileName: `mono${n++}.mp4`, width: 64, height: 36, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 30, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 256, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
  };
}

async function exportLevels(key: string, stream?: number): Promise<number[]> {
  const m = items[key];
  const res = await runExport({ sequence: seqFor(m.id, stream), media: { [m.id]: m }, settings: exportSettings() }, undefined, undefined, { chunked: false });
  return channelRms(res.outputPath);
}

/** Per-channel level the Program monitor plays: the played file's channel level x planFrame gain, mono up-mixed at unity. */
async function previewLevels(key: string, useProxies: boolean, stream?: number): Promise<number[]> {
  const m = items[key];
  const a = planFrame(seqFor(m.id, stream), { [m.id]: m }, 24, useProxies).audio[0];
  const ordinal = a.usingProxy ? (a.audioTrack < 0 ? 0 : a.audioTrack) : m.probe!.audio.findIndex((x) => x.index === a.audioStream);
  const file = await channelRms(a.path, `0:a:${ordinal}`);
  const perChannel = file.length === 1 ? [file[0], file[0]] : file; // Web Audio "speakers" up-mix: mono -> L = R = M
  return perChannel.map((db) => db + 20 * Math.log10(a.gain * a.trackVolume));
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-mono-'));
  const f = (name: string) => (files[name] = path.join(dir, name));
  await ff(['-f', 'lavfi', '-i', TONE2, '-c:a', 'pcm_s16le', f('stereo.wav')]);
  await ff(['-f', 'lavfi', '-i', TONE, '-c:a', 'pcm_s16le', f('mono.wav')]);
  // Two-stream file: #1 stereo, #2 mono.
  await ff(['-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=24:d=4', '-f', 'lavfi', '-i', TONE2, '-f', 'lavfi', '-i', TONE,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-t', '4', f('multi.mp4')]);
  // A mono AC-3 file the preview cannot decode: played through its proxy.
  await ff(['-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=24:d=4', '-f', 'lavfi', '-i', TONE,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k', '-t', '4', f('proxied.mkv')]);
  for (const key of ['stereo.wav', 'mono.wav', 'multi.mp4', 'proxied.mkv']) {
    const file = files[key];
    const p = await probe(file);
    items[key] = {
      id: key, name: key, path: file, kind: p.video ? 'video' : 'audio', category: 'Other', identity: {}, binId: null,
      probe: p, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
      preferredAudioStream: p.audio[0].index,
    };
  }
  // The proxy, built with the app's own arguments.
  const proxyPath = path.join(dir, 'proxied_540p_all.mp4');
  await ff([...buildProxyArgs({ mediaId: 'proxied.mkv', path: files['proxied.mkv'], height: 540 }, { targetHeight: 36, hasVideo: true, hasAudio: true, outPart: proxyPath })]);
  items['proxied.mkv'].proxy = { status: 'ready', path: proxyPath };
}, 120_000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const close = (got: number[], want: number[], tol = 0.25) => {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => expect(Math.abs(g - want[i]), `channel ${i}: ${g.toFixed(2)} dB vs ${want[i].toFixed(2)} dB`).toBeLessThan(tol));
};

describe('mono sources: preview level == export level', () => {
  it('the export up-mixes a mono stream at -3.01 dB per channel; a stereo stream keeps its level', async () => {
    close(await exportLevels('stereo.wav'), [TONE_DB, TONE_DB]);
    close(await exportLevels('mono.wav'), [TONE_DB + UPMIX_DB, TONE_DB + UPMIX_DB]);
    close(await exportLevels('multi.mp4', 1), [TONE_DB, TONE_DB]);
    close(await exportLevels('multi.mp4', 2), [TONE_DB + UPMIX_DB, TONE_DB + UPMIX_DB]);
    close(await exportLevels('proxied.mkv'), [TONE_DB + UPMIX_DB, TONE_DB + UPMIX_DB]);
  }, 120_000);

  it('the proxy of a mono source is stereo, up-mixed at -3.01 dB like the export', async () => {
    close(await channelRms(items['proxied.mkv'].proxy.path!), [TONE_DB + UPMIX_DB, TONE_DB + UPMIX_DB]);
  }, 60_000);

  const cases: [string, boolean, number | undefined][] = [
    ['stereo.wav', false, undefined],
    ['mono.wav', false, undefined],
    ['mono.wav', true, undefined], // no proxy: plays directly either way
    ['multi.mp4', false, 1],
    ['multi.mp4', false, 2],
    ['proxied.mkv', true, undefined],
  ];
  for (const [key, useProxies, stream] of cases) {
    it(`${key}${stream !== undefined ? ` stream #${stream}` : ''}${useProxies ? ' (proxies on)' : ''}: the preview plays at the export level`, async () => {
      const exported = await exportLevels(key, stream);
      close(await previewLevels(key, useProxies, stream), exported, 0.3);
    }, 60_000);
  }
});

describe('previewUpmixGain', () => {
  const m = (channels: number[], proxy = false): MediaItem => ({
    id: 'M', name: 'm', path: '/m.mp4', kind: 'video', category: 'Other', identity: {}, binId: null,
    probe: { container: 'mp4', duration: 10, size: 1, audio: channels.map((c, i) => ({ index: i + 1, codec: 'aac', channels: c, layout: '', sampleRate: 48000 })), subtitles: [], startTime: 0, browserPlayable: true },
    offline: false, proxy: proxy ? { status: 'ready', path: '/c/m_540p_all.mp4' } : { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  });

  it('1/sqrt(2) for a mono stream played directly, 1 otherwise', () => {
    expect(previewUpmixGain(m([1]), false, 1)).toBe(Math.SQRT1_2);
    expect(previewUpmixGain(m([2, 1]), false, 2)).toBe(Math.SQRT1_2);
    expect(previewUpmixGain(m([2, 1]), false, 1)).toBe(1);
    expect(previewUpmixGain(m([6]), false, 1)).toBe(1);
    expect(previewUpmixGain(m([1]), true, 1)).toBe(1); // the proxy is already up-mixed by FFmpeg
    expect(previewUpmixGain(m([1]), false, null)).toBe(1);
    expect(previewUpmixGain(m([1]), false, 7)).toBe(1); // unknown stream
    expect(previewUpmixGain({ ...m([1]), probe: undefined }, false, 1)).toBe(1);
  });

  it('is folded into the planned gain, with the clip gain, volume and track volume left as they are', () => {
    const mono = m([1]);
    const s = seqFor('M');
    const c = s.audioTracks[0].clips[0];
    c.audio.gain = -6; c.audio.volume = 0.5;
    s.audioTracks[0].volume = 0.8;
    const a = planFrame(s, { M: mono }, 10, false).audio[0];
    expect(a.gain).toBeCloseTo(Math.pow(10, -6 / 20) * 0.5 * Math.SQRT1_2, 12);
    expect(a.trackVolume).toBe(0.8);
    expect(planFrame(s, { M: m([2]) }, 10, false).audio[0].gain).toBeCloseTo(Math.pow(10, -6 / 20) * 0.5, 12);
  });
});
