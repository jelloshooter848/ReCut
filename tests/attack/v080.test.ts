/**
 * 0.8.0 features against real files (added in the 8 October re-run, docs/attack/README.md): a Matroska file with a
 * huge track list, and per-clip channel selection with absurd or impossible channels, including a stored probe that
 * no longer matches the file. Contract: the right stream / channel is exported, an impossible selection falls back to
 * the stream's normal mix with a warning, and a stale probe gives a valid file or an error, never a hang.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { runExport } from '../../electron/export/exporter';
import { ensureMedia, mediaPath, makeMediaItem, makeSeq, vclip, aclip, request, audioRms, ffprobeJson, ff, FPS_24 } from './helpers';

const TRACKS = 40;

beforeAll(async () => {
  ensureMedia();
  // 1 video + TRACKS audio + TRACKS subtitle streams; only the LAST audio stream has a tone, the others are silent.
  const many = mediaPath('many_tracks.mkv');
  if (!fs.existsSync(many)) {
    const args = ['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=24:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-i', mediaPath('tiny.srt'), '-map', '0:v'];
    for (let i = 0; i < TRACKS - 1; i++) args.push('-map', '1:a');
    args.push('-map', '2:a');
    for (let i = 0; i < TRACKS; i++) args.push('-map', '3:s');
    for (let i = 0; i < TRACKS; i++) args.push(`-metadata:s:a:${i}`, `title=Track ${i + 1}`);
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt', '-t', '2', many);
    await ff(args);
  }
  // 5.1 where only the centre channel carries a tone (dialogue-only centre), the rest silent: FLAC (Matroska stores
  // the 5.1 layout) and PCM (Matroska stores no layout: the probe guesses it, channels are numbered c0..c5).
  for (const [name, codec] of [['centre_only51.mkv', 'flac'], ['centre_only51_pcm.mkv', 'pcm_s16le']]) {
    if (fs.existsSync(mediaPath(name))) continue;
    await ff(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=24:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3',
      '-af', 'pan=5.1|FL=0*c0|FR=0*c0|FC=c0|LFE=0*c0|BL=0*c0|BR=0*c0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', codec, '-t', '3', mediaPath(name)]);
  }
}, 300_000);

describe('Matroska with a huge track list', () => {
  it(`probe lists all ${TRACKS} audio and ${TRACKS} subtitle streams with absolute indices`, async () => {
    const m = await makeMediaItem(mediaPath('many_tracks.mkv'));
    expect(m.probe!.audio.map((a) => a.index)).toEqual(Array.from({ length: TRACKS }, (_, i) => 1 + i));
    expect(m.probe!.subtitles.length).toBe(TRACKS);
    expect(m.probe!.audio[TRACKS - 1].title).toBe(`Track ${TRACKS}`);
  });

  it('a clip on the last audio stream exports that stream (tone); a clip on the first exports silence', async () => {
    const m = await makeMediaItem(mediaPath('many_tracks.mkv'));
    const last = m.probe!.audio[TRACKS - 1].index, first = m.probe!.audio[0].index;
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 24, 0);
    aclip(seq, m, 0, 24, 0, 1, 0, last);
    aclip(seq, m, 24, 24, 0, 1, 0, first);
    vclip(seq, m, 24, 24, 0);
    const r = await runExport(request(seq, [m]));
    const loud = await audioRms(r.outputPath, 0.1, 0.9);
    const quiet = await audioRms(r.outputPath, 1.1, 1.9);
    console.log(`[many tracks] last stream rms=${loud.toFixed(4)} first stream rms=${quiet.toFixed(4)}`);
    expect(loud).toBeGreaterThan(0.03);
    expect(quiet).toBeLessThan(0.01);
  });
});

describe('channel selection on real 5.1', () => {
  it('Centre (FC) exports the tone, Front left exports silence, an absent channel falls back to the normal mix with a warning', async () => {
    const m = await makeMediaItem(mediaPath('centre_only51.mkv'));
    expect(m.probe!.audio[0].channels).toBe(6);
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 72, 0);
    const fc = aclip(seq, m, 0, 24, 0); fc.audio.channelSelection = { mode: 'channel', channel: 'FC' };
    const fl = aclip(seq, m, 24, 24, 0); fl.audio.channelSelection = { mode: 'channel', channel: 'FL' };
    const bad = aclip(seq, m, 48, 24, 0); bad.audio.channelSelection = { mode: 'channel', channel: 'c40' };
    const r = await runExport(request(seq, [m]));
    const rms = [await audioRms(r.outputPath, 0.1, 0.9), await audioRms(r.outputPath, 1.1, 1.9), await audioRms(r.outputPath, 2.1, 2.9)];
    console.log(`[channel sel] FC=${rms[0].toFixed(4)} FL=${rms[1].toFixed(4)} c40=${rms[2].toFixed(4)} warnings=${JSON.stringify(r.warnings)}`);
    expect(rms[0]).toBeGreaterThan(0.03);
    expect(rms[1]).toBeLessThan(0.005);
    expect(rms[2], 'impossible channel: the normal mix (stereo downmix of the centre tone)').toBeGreaterThan(0.03);
    expect(r.warnings.filter((w) => /cannot be used/.test(w))).toEqual([expect.stringMatching(/Channel 41 cannot be used/)]);
  });

  it('PCM 5.1 in Matroska (no stored layout): channels are numbered; c2 exports the centre, a named channel falls back with an honest reason', async () => {
    const m = await makeMediaItem(mediaPath('centre_only51_pcm.mkv'));
    expect(m.probe!.audio[0]).toMatchObject({ channels: 6, layoutGuessed: true });
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 48, 0);
    const c2 = aclip(seq, m, 0, 24, 0); c2.audio.channelSelection = { mode: 'channel', channel: 'c2' };
    const fc = aclip(seq, m, 24, 24, 0); fc.audio.channelSelection = { mode: 'channel', channel: 'FC' };
    const r = await runExport(request(seq, [m]));
    const rms = [await audioRms(r.outputPath, 0.1, 0.9), await audioRms(r.outputPath, 1.1, 1.9)];
    console.log(`[channel sel pcm] c2=${rms[0].toFixed(4)} FC=${rms[1].toFixed(4)} warnings=${JSON.stringify(r.warnings)}`);
    expect(rms[0]).toBeGreaterThan(0.03);
    expect(rms[1], 'falls back to the normal mix').toBeGreaterThan(0.03);
    const w = r.warnings.filter((x) => /cannot be used/.test(x));
    expect(w.length).toBe(1);
    expect(w[0], 'the reason must not present the guessed 5.1 as the stream layout').toMatch(/unknown layout/);
  });

  it('a stored probe that claims 7.1 for what is now a mono file: selecting Side right gives a valid file or an error, never a hang', async () => {
    const m = await makeMediaItem(mediaPath('mono.mp4'));
    m.probe!.audio[0] = { ...m.probe!.audio[0], channels: 8, layout: '7.1' };
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 24, 0);
    const c = aclip(seq, m, 0, 24, 0); c.audio.channelSelection = { mode: 'channel', channel: 'SR' };
    const t0 = Date.now();
    let err: unknown = null; let out: string | null = null;
    try { out = (await runExport(request(seq, [m]))).outputPath; } catch (e) { err = e; }
    console.log(`[stale probe] ${err ? `error: ${String(err).slice(0, 200)}` : `exported ${out}`} in ${Date.now() - t0} ms`);
    expect(Date.now() - t0).toBeLessThan(60_000);
    if (!err) {
      // If FFmpeg accepted it, the output must at least be a valid file with one audio stream.
      const pj = await ffprobeJson(out!);
      expect(pj.streams.filter((s) => s.codec_type === 'audio').length).toBe(1);
    }
  });
});
