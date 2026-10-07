/**
 * Codec / container assumptions: probe fields, playability reasons, proxy stream selection, export stream mapping.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { MediaItem } from '@shared/model';
import { probeMedia, classifyKind, evaluatePlayability } from '../../electron/media/probe';
import { buildProxyArgs } from '../../electron/media/proxy';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { ensureMedia, mediaPath, makeMediaItem, makeSeq, vclip, aclip, exportSeq, request, audioRms, ffprobeJson, FPS_24 } from './helpers';

beforeAll(() => { ensureMedia(); });

describe('probe fields per codec/container', () => {
  it('10-bit HEVC: codec hevc, pix_fmt yuv420p10le, not browser playable (reason names the codec)', async () => {
    const p = await probeMedia(mediaPath('hevc10.mp4'));
    expect(p.video?.codec).toBe('hevc');
    expect(p.video?.pixFmt).toBe('yuv420p10le');
    expect(p.browserPlayable).toBe(false);
    expect(p.playabilityReason).toMatch(/hevc/);
  });
  it('H.264 High 4:2:2: flagged not playable with a 4:2:2 reason', async () => {
    const p = await probeMedia(mediaPath('h264_422.mp4'));
    expect(p.video?.pixFmt).toBe('yuv422p');
    expect(p.browserPlayable).toBe(false);
    expect(p.playabilityReason).toMatch(/4:2:2/);
  });
  it('MKV with 2 audio streams + attached cover art: video is the real stream, audio indexes are absolute, cover art ignored', async () => {
    const p = await probeMedia(mediaPath('multi.mkv'));
    expect(p.container).toBe('matroska');
    expect(p.video?.index).toBe(0);
    expect(p.video?.codec).toBe('h264');
    expect(p.audio.map((a) => a.index)).toEqual([1, 2]);
    expect(p.audio[0].language).toBe('eng');
    expect(p.audio[1].language).toBe('jpn');
    expect(p.audio[1].title).toBe('Surround');
    expect(p.audio[1].channels).toBe(6);
    expect(p.duration).toBeGreaterThan(5.9);
    // attached picture must not be mistaken for the video stream or make the file an image
    expect(classifyKind(p, mediaPath('multi.mkv'))).toBe('video');
    console.log(`[codecs multi.mkv] startTime=${p.startTime} playable=${p.browserPlayable} reason=${p.playabilityReason}`);
  });
  it('MKV negative container start_time (AAC priming) is clamped to 0 in probe.startTime', async () => {
    const raw = await ffprobeJson(mediaPath('multi.mkv'));
    const p = await probeMedia(mediaPath('multi.mkv'));
    console.log(`[codecs] multi.mkv format.start_time=${raw.format.start_time} probe.startTime=${p.startTime}`);
    // FFmpeg <= 6 reports the AAC priming as a negative container start; newer ffprobe reports 0. Either way the
    // app must not expose a negative start.
    expect(Number(raw.format.start_time)).toBeLessThanOrEqual(0);
    expect(p.startTime).toBe(0);
  });
  it('MP4 with two video streams: audio stream index is 2 (absolute)', async () => {
    const p = await probeMedia(mediaPath('twovideo.mp4'));
    expect(p.video?.index).toBe(0);
    expect(p.audio.map((a) => a.index)).toEqual([2]);
  });
  it('MP4 with subtitle stream before two audio streams: audio indexes 2 and 3', async () => {
    const p = await probeMedia(mediaPath('subsfirst.mp4'));
    expect(p.subtitles.map((s) => s.index)).toEqual([1]);
    expect(p.audio.map((a) => a.index)).toEqual([2, 3]);
    expect(p.audio[1].channels).toBe(1);
  });
  it('audio-only m4a, PNG, JPEG, 24-bit WAV, 5.1 AC3, 7.1 PCM, mono', async () => {
    const m4a = await probeMedia(mediaPath('audio.m4a'));
    expect(m4a.video).toBeUndefined();
    expect(classifyKind(m4a, mediaPath('audio.m4a'))).toBe('audio');
    expect(m4a.browserPlayable).toBe(true);

    const png = await probeMedia(mediaPath('image.png'));
    expect(classifyKind(png, mediaPath('image.png'))).toBe('image');
    expect(png.duration).toBe(0);
    const jpg = await probeMedia(mediaPath('image.jpg'));
    expect(classifyKind(jpg, mediaPath('image.jpg'))).toBe('image');

    const wav = await probeMedia(mediaPath('wav24.wav'));
    expect(wav.audio[0].codec).toBe('pcm_s24le');
    expect(wav.browserPlayable).toBe(true);

    const ac3 = await probeMedia(mediaPath('ac3_51.mp4'));
    expect(ac3.audio[0].channels).toBe(6);
    expect(ac3.audio[0].layout).toMatch(/5\.1/);
    expect(ac3.browserPlayable).toBe(false);
    expect(ac3.playabilityReason).toMatch(/ac3/);

    const pcm = await probeMedia(mediaPath('pcm71.mkv'));
    expect(pcm.audio[0].channels).toBe(8);
    expect(pcm.audio[0].layout).toMatch(/7\.1/);
    console.log(`[codecs pcm71.mkv] playable=${pcm.browserPlayable} reason=${pcm.playabilityReason} layout=${pcm.audio[0].layout}`);

    const mono = await probeMedia(mediaPath('mono.mp4'));
    expect(mono.audio[0].channels).toBe(1);
    expect(mono.audio[0].layout).toBe('mono');
  });
  it('rotated source (display matrix rotation=90): probe reports the DISPLAY size (portrait), not the coded size', async () => {
    const p = await probeMedia(mediaPath('rotated.mp4'));
    const raw = await ffprobeJson(mediaPath('rotated.mp4'));
    const sd = raw.streams[0].side_data_list?.[0] as { rotation?: number } | undefined;
    console.log(`[codecs rotated.mp4] ffprobe side_data rotation=${sd?.rotation} coded=${raw.streams[0].width}x${raw.streams[0].height} probe=${p.video?.width}x${p.video?.height}`);
    expect(sd?.rotation).toBe(90);
    // What the editor (Chromium videoWidth/Height) and ffmpeg (autorotate) both produce is 240x320.
    expect([p.video?.width, p.video?.height]).toEqual([240, 320]);
  });
  it('evaluatePlayability: 10-bit h264 flagged, yuvj420p (full-range jpeg) h264 allowed', () => {
    expect(evaluatePlayability({ container: 'mp4', video: { index: 0, codec: 'h264', width: 1, height: 1, fps: FPS_24, avgFps: FPS_24, pixFmt: 'yuv420p10le', isVfr: false }, audio: [] }).ok).toBe(false);
    expect(evaluatePlayability({ container: 'mp4', video: { index: 0, codec: 'h264', width: 1, height: 1, fps: FPS_24, avgFps: FPS_24, pixFmt: 'yuvj420p', isVfr: false }, audio: [] }).ok).toBe(true);
  });
});

describe('proxy stream selection', () => {
  it('proxy args map every audio stream, whatever stream is requested, so any clip stream can be previewed', () => {
    for (const audioStream of [undefined, 1, 2]) {
      const args = buildProxyArgs({ mediaId: 'x', path: mediaPath('multi.mkv'), height: 540, audioStream }, { targetHeight: 240, hasVideo: true, hasAudio: true, outPart: '/tmp/x.part' });
      console.log(`[proxy args] ${args.join(' ')}`);
      expect(args.filter((a, i) => args[i - 1] === '-map')).toEqual(['0:v:0', '0:a?']);
      expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    }
  });
  it('cover art: mkv attachment and mp3 APIC are skipped by the probe; the proxy/thumbnail 0:v:0 mapping is then consistent', async () => {
    const mkv = await probeMedia(mediaPath('attach.mkv'));
    expect(mkv.video?.index).toBe(0);
    expect(mkv.video?.codec).toBe('h264');
    expect(classifyKind(mkv, mediaPath('attach.mkv'))).toBe('video');
    const mp3 = await probeMedia(mediaPath('cover.mp3'));
    expect(mp3.video).toBeUndefined();
    expect(classifyKind(mp3, mediaPath('cover.mp3'))).toBe('audio');
    const args = buildProxyArgs({ mediaId: 'x', path: mediaPath('cover.mp3'), height: 540 }, { targetHeight: 540, hasVideo: false, hasAudio: true, outPart: '/tmp/x.part' });
    expect(args).toContain('-vn');
  });
});

describe('export audio stream mapping', () => {
  it('clip.audioStream = 3 (second audio stream of subsfirst.mp4, 880 Hz mono) is what gets exported', async () => {
    const m = await makeMediaItem(mediaPath('subsfirst.mp4'));
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 48, 0); aclip(seq, m, 0, 48, 0, 1, 0, 3);
    const g = buildRenderGraph(request(seq, [m]));
    // The linked V+A pair now shares one input (M-09), so only the absolute stream index is pinned.
    expect(g.filterGraph).toMatch(/\[\d+:3\]atrim/);
    const { outputPath } = await exportSeq(seq, [m]);
    // 880 Hz vs 440 Hz: check the dominant frequency by zero-crossing rate
    const { ff } = await import('./helpers');
    const { stdout } = await ff(['-i', outputPath, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-af', 'atrim=0.5:1.5', '-']);
    let zc = 0; for (let i = 2; i + 1 < stdout.length; i += 2) if ((stdout.readInt16LE(i) >= 0) !== (stdout.readInt16LE(i - 2) >= 0)) zc++;
    const hz = zc / 2 / 1.0;
    console.log(`[export stream map] dominant ~${hz.toFixed(0)} Hz (want 880)`);
    expect(Math.abs(hz - 880)).toBeLessThan(40);
  });
  it('MKV second audio stream (jpn 5.1 ac3, absolute index 2) exports and is audible', async () => {
    const m = await makeMediaItem(mediaPath('multi.mkv'));
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 48, 1); aclip(seq, m, 0, 48, 1, 1, 0, 2);
    const { outputPath } = await exportSeq(seq, [m], { audioChannels: 6, audioCodec: 'ac3' });
    const rms = await audioRms(outputPath, 0.2, 1.8);
    const p = await probeMedia(outputPath);
    console.log(`[export mkv a:2] rms=${rms.toFixed(3)} channels=${p.audio[0].channels}`);
    expect(p.audio[0].channels).toBe(6);
    expect(rms).toBeGreaterThan(0.02);
  });
});
