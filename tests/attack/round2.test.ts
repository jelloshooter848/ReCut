/**
 * Round 2 of the media attack: single-clip-track frame drops, 50 consecutive inserts (A/V sync after accumulated
 * rounding), codec-zoo exports (audio-first MP4, mono, 7.1 PCM, 24-bit WAV, 10-bit HEVC, 4:2:2) and the proxy's
 * audio stream choice. Every assertion is measured on real ffmpeg output.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem, Rational, Sequence } from '@shared/model';
import { makeClip, placeClips, sourceTimeAt, clipEnd, sequenceDuration } from '@shared/timeline';
import { framesToSeconds } from '@shared/time';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { startProxyJob } from '../../electron/media/proxy';
import { probeMedia } from '../../electron/media/probe';
import {
  ensureMedia, mediaPath, makeMediaItem, makeSeq, vclip, aclip, exportSeq, exportPatched, request, readCounters, editorMediaFrame,
  flashFrames, audioOnsets, audioRms, countFrames, ff, ffprobeJson, SCRATCH, FPS_23976, FPS_24, FPS_25, FPS_2997, fmt,
} from './helpers';

beforeAll(() => { ensureMedia(); });

async function zeroCrossHz(file: string, t0: number, t1: number, map = '0:a:0'): Promise<number> {
  const { stdout } = await ff(['-i', file, '-map', map, '-ac', '1', '-ar', '48000', '-af', `atrim=${t0}:${t1}`, '-f', 's16le', '-']);
  let zc = 0; for (let i = 2; i + 1 < stdout.length; i += 2) if ((stdout.readInt16LE(i) >= 0) !== (stdout.readInt16LE(i - 2) >= 0)) zc++;
  return zc / 2 / (t1 - t0);
}

async function channelRms(file: string, channels: number, t0: number, t1: number): Promise<number[]> {
  const { stdout } = await ff(['-i', file, '-map', '0:a:0', '-af', `atrim=${t0}:${t1}`, '-f', 's16le', '-acodec', 'pcm_s16le', '-']);
  const acc = new Array(channels).fill(0); let n = 0;
  for (let i = 0; i + 2 * channels <= stdout.length; i += 2 * channels, n++) for (let c = 0; c < channels; c++) { const v = stdout.readInt16LE(i + 2 * c) / 32768; acc[c] += v * v; }
  return acc.map((a) => Math.sqrt(a / Math.max(1, n)));
}

function dropDupEvents(c: number[]): number {
  let k = 0;
  for (let i = 1; i + 1 < c.length; i++) if (c[i] >= 0 && c[i] === c[i + 1] && c[i] === c[i - 1] + 2) k++;
  return k;
}

// -----------------------------------------------------------------------------------------------------------------
describe('single-clip track: setpts=N*den/num/TB truncation (renderGraph.ts track assembly, parts.length === 1)', () => {
  const cases: [string, string, Rational, number][] = [
    ['24 (control)', 'counter24.mp4', FPS_24, 460],
    ['25', 'counter25.mp4', FPS_25, 460],
    ['29.97', 'counter2997.mp4', FPS_2997, 560],
    ['23.976', 'counter23976.mp4', FPS_23976, 460],
  ];
  for (const [label, file, fps, n] of cases) {
    it(`${label} source in a ${label.split(' ')[0]} sequence, ONE clip on V1: every output frame is source frame 12+j (no drop/dup)`, async () => {
      const m = await makeMediaItem(mediaPath(file));
      const seq = makeSeq(fps);
      const clip = vclip(seq, m, 0, n, framesToSeconds(12, fps));
      const { outputPath } = await exportSeq(seq, [m]);
      const c = await readCounters(outputPath);
      const bad: string[] = [];
      for (let j = 0; j < n; j++) { const want = editorMediaFrame(sourceTimeAt(clip, j, fps), m.probe!.video!.fps); if (c[j] !== want) bad.push(`j=${j} want=${want} got=${c[j]}`); }
      console.log(`[single-clip ${label}] frames=${c.length}/${n} mismatches=${bad.length} dropDup=${dropDupEvents(c)} ${bad.slice(0, 6).join('; ')}`);
      expect(c.length).toBe(n);
      expect(bad).toEqual([]);
    });
  }
  it('29.97: the same single clip with a 1-frame gap in front (concat path) has no drop/dup -> only the 1-part path is broken', async () => {
    const m = await makeMediaItem(mediaPath('counter2997.mp4'));
    const seq = makeSeq(FPS_2997);
    const clip = vclip(seq, m, 1, 559, framesToSeconds(12, FPS_2997));
    const { outputPath } = await exportSeq(seq, [m]);
    const c = await readCounters(outputPath);
    let bad = 0;
    for (let f = 1; f < 560; f++) if (c[f] !== editorMediaFrame(sourceTimeAt(clip, f, FPS_2997), m.probe!.video!.fps)) bad++;
    console.log(`[single-clip 29.97 + gap (concat path)] mismatches=${bad} dropDup=${dropDupEvents(c)}`);
    expect(bad).toBe(0);
  });
  it('ROOT CAUSE 29.97: replacing setpts=N*1001/30000/TB with settb=1001/30000,setpts=N removes every mismatch', async () => {
    const m = await makeMediaItem(mediaPath('counter2997.mp4'));
    const seq = makeSeq(FPS_2997);
    const clip = vclip(seq, m, 0, 560, framesToSeconds(12, FPS_2997));
    const { outputPath } = await exportPatched(request(seq, [m]), { filter: (g) => g.replace(/setpts=N\*1001\/30000\/TB/g, 'settb=1001/30000,setpts=N') });
    const c = await readCounters(outputPath);
    let bad = 0;
    for (let j = 0; j < 560; j++) if (c[j] !== editorMediaFrame(sourceTimeAt(clip, j, FPS_2997), m.probe!.video!.fps)) bad++;
    console.log(`[single-clip 29.97 patched] mismatches=${bad} dropDup=${dropDupEvents(c)}`);
    expect(bad).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------------------------
describe('50 consecutive inserts (shared placeClips insert at the head, linked V+A) of a 25 fps source into 23.976', () => {
  for (const subFrame of [false, true]) it(`every clip keeps flash and beep within 1 frame and shows what the editor shows; total length exact (${subFrame ? 'sourceIn = 2j-0.5 s + 0/13/26 ms' : 'sourceIn = 2j-0.5 s, i.e. mid-way between two 25 fps frames'})`, async () => {
    const m = await makeMediaItem(mediaPath('sync25.mp4'));
    const seq: Sequence = makeSeq(FPS_23976);
    const N = 50;
    for (let k = 0; k < N; k++) {
      const dur = 29 + (k % 7); // 1.21 .. 1.46 s
      // flash/beep at source t = 2*(k%13+1); clip starts 0.5 s before it (k%13 keeps sourceIn inside the 30 s file)
      const sourceIn = 2 * ((k % 13) + 1) - 0.5 + (subFrame ? (k % 3) * 0.013 : 0); // optional sub-frame offsets (slip/trim in another-rate sequence)
      const v = makeClip({ mediaId: m.id, name: `v${k}`, sourceIn, duration: dur, kind: 'video' }, 0);
      const a = makeClip({ mediaId: m.id, name: `a${k}`, sourceIn, duration: dur, kind: 'audio', audioStream: m.probe!.audio[0].index }, 0);
      v.linkId = a.linkId = `L${k}`;
      expect(placeClips(seq, [{ trackId: seq.videoTracks[0].id, clip: v }, { trackId: seq.audioTracks[0].id, clip: a }], 'insert')).toBe(true);
    }
    const vc = seq.videoTracks[0].clips, ac = seq.audioTracks[0].clips;
    expect(vc.length).toBe(N); expect(ac.length).toBe(N);
    for (let i = 0; i < N; i++) { expect(vc[i].start).toBe(ac[i].start); expect(Number.isInteger(vc[i].start)).toBe(true); if (i) expect(vc[i].start).toBe(clipEnd(vc[i - 1])); }
    const total = sequenceDuration(seq);
    const { outputPath } = await exportSeq(seq, [m]);
    const frames = await countFrames(outputPath);
    const fl = await flashFrames(outputPath);
    const beeps = (await audioOnsets(outputPath, { threshold: 0.15, quiet: 0.2 })).map((b) => b * 24000 / 1001);
    // Video model = what the editor shows: media frame floor(sourceTime*25 + 0.5); the flash is media frame N%50==0.
    // (A 25->23.976 conversion legitimately skips some 1-frame flashes; the editor skips the same ones.)
    const mfps = m.probe!.video!.fps;
    const modelFlash: number[] = [];
    for (const c of vc) for (let f = c.start; f < clipEnd(c); f++) { const mf = editorMediaFrame(sourceTimeAt(c, f, FPS_23976), mfps); if (mf % 50 === 0) modelFlash.push(f); }
    // Audio model: beep at source t = 2j inside each clip.
    const wantBeep = vc.map((c) => { const tf = 2 * Math.round((c.sourceIn + 0.5) / 2); return c.start + (tf - c.sourceIn) * 24000 / 1001; });
    const worstBeep = Math.max(...beeps.map((b, i) => Math.abs(b - wantBeep[i])));
    const flashOnlyExport = fl.filter((f) => !modelFlash.includes(f)), flashOnlyModel = modelFlash.filter((f) => !fl.includes(f));
    // A/V: for every exported flash, the nearest beep must be within 1 frame + the 0.5 frame quantisation of the flash.
    const worstAV = Math.max(...fl.map((f) => Math.min(...beeps.map((b) => Math.abs(b - f)))));
    console.log(`[50 inserts subFrame=${subFrame}] total=${total} frames=${frames} exported flashes=${fl.length} model flashes=${modelFlash.length} beeps=${beeps.length} worst |beep-model|=${fmt(worstBeep, 2)} worst |flash-beep|=${fmt(worstAV, 2)} frames; flash only in export: ${flashOnlyExport.slice(0, 8)} only in model: ${flashOnlyModel.slice(0, 8)}`);
    expect(frames).toBe(total);
    expect(beeps.length).toBe(N);
    expect(worstBeep).toBeLessThanOrEqual(1);
    expect(worstAV).toBeLessThanOrEqual(1.5);
    expect({ flashOnlyExport, flashOnlyModel }).toEqual({ flashOnlyExport: [], flashOnlyModel: [] });
  });

  for (const variant of ['phase', 'phase+halfFrame'] as const) it(`ROOT CAUSE (${variant}): same 50-insert grid sequence with setpts=PTS-P/TB instead of PTS-STARTPTS${variant === 'phase+halfFrame' ? ' and trim start - 0.5/mediaFps' : ''}`, async () => {
    const m = await makeMediaItem(mediaPath('sync25.mp4'));
    const seq: Sequence = makeSeq(FPS_23976);
    for (let k = 0; k < 50; k++) {
      const v = makeClip({ mediaId: m.id, name: `v${k}`, sourceIn: 2 * ((k % 13) + 1) - 0.5, duration: 29 + (k % 7), kind: 'video' }, 0);
      placeClips(seq, [{ trackId: seq.videoTracks[0].id, clip: v }], 'insert');
    }
    const half = 0.5 / 25;
    const { outputPath, filterGraph } = await exportPatched(request(seq, [m]), {
      filter: (g) => g.replace(/(\[\d+:v:0\])trim=start=([\d.]+):duration=([\d.]+),setpts=PTS-STARTPTS/g, (_x, l, st, d) =>
        variant === 'phase' ? `${l}trim=start=${st}:duration=${d},setpts=PTS-${st}/TB` : `${l}trim=start=${Math.max(0, Number(st) - half)}:duration=${d},setpts=PTS-${st}/TB`),
    });
    expect(filterGraph).toMatch(/setpts=PTS-[\d.]+\/TB/);
    const fl = await flashFrames(outputPath);
    const vc = seq.videoTracks[0].clips; const modelFlash: number[] = [];
    for (const c of vc) for (let f = c.start; f < clipEnd(c); f++) if (editorMediaFrame(sourceTimeAt(c, f, FPS_23976), m.probe!.video!.fps) % 50 === 0) modelFlash.push(f);
    const counters = await readCounters(outputPath);
    console.log(`[50 inserts patched ${variant}] exported flashes=${fl.length} model=${modelFlash.length} missing=${modelFlash.filter((f) => !fl.includes(f)).length} extra=${fl.filter((f) => !modelFlash.includes(f)).length} frames=${counters.length}`);
    expect(modelFlash.filter((f) => !fl.includes(f))).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------------------------
describe('codec zoo through the real exporter', () => {
  it('MP4 whose first stream is AUDIO (a:0 = #0, v = #1): probe indexes, export picture and sound are correct', async () => {
    const m = await makeMediaItem(mediaPath('audiofirst.mp4'));
    expect(m.probe!.video!.index).toBe(1);
    expect(m.probe!.audio[0].index).toBe(0);
    const seq = makeSeq(FPS_24);
    const clip = vclip(seq, m, 0, 48, 1.0); aclip(seq, m, 0, 48, 1.0);
    const { outputPath } = await exportSeq(seq, [m]);
    const c = await readCounters(outputPath);
    const hz = await zeroCrossHz(outputPath, 0.2, 1.8);
    console.log(`[audiofirst] counters[0..2]=${c.slice(0, 3)} want ${editorMediaFrame(sourceTimeAt(clip, 0, FPS_24), FPS_24)} tone=${hz.toFixed(0)} Hz`);
    expect(c[0]).toBe(24);
    expect(Math.abs(hz - 440)).toBeLessThan(20);
  });
  it('mono source -> stereo export: both channels carry the signal at equal level', async () => {
    const m = await makeMediaItem(mediaPath('mono.mp4'));
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 72, 0.5); aclip(seq, m, 0, 72, 0.5);
    const { outputPath } = await exportSeq(seq, [m]);
    const src = await channelRms(mediaPath('mono.mp4'), 1, 1, 2);
    const [l, r] = await channelRms(outputPath, 2, 1, 2);
    console.log(`[mono->stereo] src rms=${src[0].toFixed(4)} L=${l.toFixed(4)} R=${r.toFixed(4)} (L/src=${(l / src[0]).toFixed(3)})`);
    expect(l).toBeGreaterThan(0.02); expect(Math.abs(l - r)).toBeLessThan(0.002);
  });
  it('7.1 PCM (mkv) and 24-bit WAV -> stereo AAC export: audible, exact length', async () => {
    for (const f of ['pcm71.mkv', 'wav24.wav']) {
      const m = await makeMediaItem(mediaPath(f));
      const seq = makeSeq(FPS_24);
      if (m.probe!.video) vclip(seq, m, 0, 48, 0.5);
      aclip(seq, m, 0, 48, 0.5);
      const { outputPath } = await exportSeq(seq, [m]);
      const p = await ffprobeJson(outputPath);
      const a = p.streams.find((s) => s.codec_type === 'audio')!;
      const rms = await audioRms(outputPath, 0.3, 1.7);
      console.log(`[${f}] kind=${m.kind} src ch=${m.probe!.audio[0].channels} out ch=${a.channels} rms=${rms.toFixed(3)} dur=${p.format.duration} streams=${p.streams.map((s) => s.codec_type).join('+')}`);
      expect(a.channels).toBe(2);
      expect(rms).toBeGreaterThan(0.05);
    }
  });
  it('10-bit HEVC and H.264 4:2:2 sources export to yuv420p 8-bit with exact frame count', async () => {
    for (const f of ['hevc10.mp4', 'h264_422.mp4']) {
      const m = await makeMediaItem(mediaPath(f));
      const seq = makeSeq(FPS_24);
      vclip(seq, m, 0, 60, 0.5);
      const { outputPath } = await exportSeq(seq, [m]);
      const p = await ffprobeJson(outputPath);
      const frames = await countFrames(outputPath);
      console.log(`[${f}] playable=${m.probe!.browserPlayable} reason=${m.probe!.playabilityReason} out pix=${p.streams[0].pix_fmt} profile=${p.streams[0].profile} frames=${frames}`);
      expect(p.streams[0].pix_fmt).toBe('yuv420p');
      expect(frames).toBe(60);
      expect(m.probe!.browserPlayable).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------------------------------------------
describe('proxy audio stream choice', () => {
  const cacheDir = path.join(SCRATCH, 'cache');
  process.env.RECUT_CACHE_DIR = cacheDir;
  it('multi.mkv with preferredAudioStream = 2 (jpn 5.1, 880 Hz): the proxy carries every stream, track k = the k-th source stream, and the stream the export plays is in it', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const m = await makeMediaItem(mediaPath('multi.mkv'), { preferredAudioStream: 2 });
    expect(m.probe!.browserPlayable).toBe(false); // ac3 => preview MUST use the proxy
    const q = new JobQueue();
    const { job, outputPath } = await startProxyJob(q, { mediaId: 'multi', path: m.path, height: 240 });
    const final = await q.waitFor(job.id);
    expect(final.status).toBe('done');
    expect(outputPath).toMatch(/_240p_all\.mp4$/);
    expect((final.result as { audioStreams: number[] }).audioStreams).toEqual(m.probe!.audio.map((a) => a.index));
    const pp = await probeMedia(outputPath);
    expect(pp.audio.length).toBe(m.probe!.audio.length);
    expect(pp.audio.every((a) => a.codec === 'aac')).toBe(true);
    // Each proxy track has its source stream's tone: #1 440 Hz, #2 880 Hz.
    const tones = await Promise.all(pp.audio.map((_, k) => zeroCrossHz(outputPath, 0.5, 2.5, `0:a:${k}`)));
    console.log(`[proxy streams] source ${m.probe!.audio.map((a) => `#${a.index} ${a.codec}`).join(', ')} -> proxy tones ${tones.map((t) => t.toFixed(0)).join(', ')} Hz`);
    expect(Math.abs(tones[0] - 440)).toBeLessThan(40);
    expect(Math.abs(tones[1] - 880)).toBeLessThan(40);
    // The renderer plays audio track ordinal(preferred) of the proxy (src/playback/mediaSource.ts audioTrackOrdinal).
    const ordinal = m.probe!.audio.findIndex((a) => a.index === 2);
    const proxyHz = tones[ordinal];
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 48, 1); aclip(seq, m, 0, 48, 1).audioStream = undefined; // falls back to media.preferredAudioStream
    const { outputPath: ex } = await exportSeq(seq, [m]);
    const exportHz = await zeroCrossHz(ex, 0.2, 1.8);
    console.log(`[proxy stream] proxy audio streams=${pp.audio.length} proxy tone=${proxyHz.toFixed(0)} Hz | export (preferredAudioStream=2) tone=${exportHz.toFixed(0)} Hz`);
    expect(Math.abs(exportHz - 880)).toBeLessThan(40);
    expect(Math.abs(proxyHz - exportHz)).toBeLessThan(40);
  });

  it('multi.mkv with its AC-3 stream made undecodable (CodecID A_AC3 -> A_XC3): the proxy falls back to the AAC stream, records it, and the preview plays what the export plays', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const broken = path.join(SCRATCH, 'multi-undecodable.mkv');
    const bytes = fs.readFileSync(mediaPath('multi.mkv'));
    const at = bytes.indexOf('A_AC3');
    expect(at).toBeGreaterThan(0);
    bytes.write('A_XC3', at, 'latin1'); // same length: the Matroska element sizes stay valid
    fs.writeFileSync(broken, bytes);
    const m = await makeMediaItem(broken, { preferredAudioStream: 1 });
    expect(m.probe!.audio.map((a) => [a.index, a.codec])).toEqual([[1, 'aac'], [2, 'unknown']]);
    // Mapping every stream fails outright (what the proxy did before the fallback).
    await expect(ff(['-i', broken, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '1', '-f', 'mp4', path.join(SCRATCH, 'all-streams.mp4')]))
      .rejects.toThrow(/decoder/i);
    const q = new JobQueue();
    const { job } = await startProxyJob(q, { mediaId: 'broken', path: broken, height: 240, audioStream: 2 });
    const final = await q.waitFor(job.id);
    expect(final.error).toBeUndefined();
    expect(final.status).toBe('done');
    const r = final.result as { path: string; audioStreams: number[] };
    expect(r.path).toMatch(/_240p_a1\.mp4$/);
    expect(r.audioStreams).toEqual([1]); // the wanted #2 cannot be decoded: the decodable streams
    const pp = await probeMedia(r.path);
    expect(pp.audio.map((a) => a.codec)).toEqual(['aac']);
    expect(pp.video?.codec).toBe('h264');
    const proxyHz = await zeroCrossHz(r.path, 0.5, 2.5);
    // The renderer records the streams and maps tracks through them (src/playback/mediaSource.ts).
    const { audioTrackOrdinal, proxyAudioStreams, proxyStreamStale } = await import('../../src/playback/mediaSource');
    const withProxy: MediaItem = { ...m, proxy: { status: 'ready', path: r.path, audioStreams: r.audioStreams } };
    expect(proxyAudioStreams(withProxy)).toEqual([1]);
    expect(audioTrackOrdinal(withProxy, true, 1)).toBe(-1); // one track: its default track, stream #1
    expect(proxyStreamStale(withProxy, [1, 2])).toBe(false); // a rebuild would make the same file: never requeued
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 48, 1); aclip(seq, m, 0, 48, 1).audioStream = 1;
    const { outputPath: ex } = await exportSeq(seq, [m]);
    const exportHz = await zeroCrossHz(ex, 0.2, 1.8);
    console.log(`[proxy fallback] source ${m.probe!.audio.map((a) => `#${a.index} ${a.codec}`).join(', ')} -> proxy ${path.basename(r.path)} streams=${r.audioStreams} tone=${proxyHz.toFixed(0)} Hz | export #1 tone=${exportHz.toFixed(0)} Hz`);
    expect(Math.abs(proxyHz - 440)).toBeLessThan(40);
    expect(Math.abs(proxyHz - exportHz)).toBeLessThan(40);
  });
});

// -----------------------------------------------------------------------------------------------------------------
describe('ROOT CAUSE: video segment trim/setpts vs the editor frame model (patched graphs, same sequences as framemap.test.ts)', () => {
  /**
   * Patch every video segment: keep the frame the editor shows (trim from P - 0.5/mediaFps) and keep the sub-frame phase,
   * biased so that fps=<seq> (which takes the LAST input frame whose pts rounds to the slot) picks the frame covering
   * t + 0.5/mediaFps like Chromium: setpts=PTS-(P + c)/TB with c = 0.5/mediaFps - 0.5/seqFps.
   */
  function phasePatch(mediaFps: Rational, seqFps: Rational) {
    const half = 0.5 * mediaFps.den / mediaFps.num;
    const c = half - 0.5 * seqFps.den / seqFps.num;
    return (g: string) => g.replace(/(\[\d+:v:0\])trim=start=([\d.]+):duration=([\d.]+),setpts=PTS-STARTPTS/g, (_x, l, st, d) => `${l}trim=start=${Math.max(0, Number(st) - half)}:duration=${d},setpts=PTS-${(Number(st) + c).toFixed(6)}/TB`);
  }
  async function mism(seq: Sequence, m: MediaItem, patched: boolean): Promise<number> {
    const req = request(seq, [m]);
    const out = patched ? (await exportPatched(req, { filter: phasePatch(m.probe!.video!.fps, seq.fps) })).outputPath : (await exportSeq(seq, [m])).outputPath;
    const c = await readCounters(out);
    let bad = 0;
    for (const clip of seq.videoTracks[0].clips) for (let f = clip.start; f < clipEnd(clip); f++) if (c[f] !== editorMediaFrame(sourceTimeAt(clip, f, seq.fps), m.probe!.video!.fps)) bad++;
    return bad;
  }
  it('24 fps source, 24 fps sequence, sourceIn = k/25 (off grid): mismatches drop to 0 with the phase+half-frame patch', async () => {
    const m = await makeMediaItem(mediaPath('counter24.mp4'));
    const seq = makeSeq(FPS_24);
    for (let k = 0; k < 40; k++) vclip(seq, m, k * 6, 6, (50 + k * 7) / 25);
    const before = await mism(seq, m, false), after = await mism(seq, m, true);
    console.log(`[root cause off-grid 24] mismatches current=${before} patched=${after} of 240`);
    expect(after).toBe(0);
  });
  it('25 fps source, 29.97 sequence (grid sourceIn): patched mismatches', async () => {
    const m = await makeMediaItem(mediaPath('counter25.mp4'));
    const seq = makeSeq(FPS_2997);
    for (let k = 0; k < 12; k++) vclip(seq, m, k * 30, 30, (10 + k * 40) / 25);
    const before = await mism(seq, m, false), after = await mism(seq, m, true);
    console.log(`[root cause 25->29.97] mismatches current=${before} patched=${after} of 360`);
    expect(after).toBe(0);
  });
  it('regression guard: the patch keeps 25->23.976 and 23.976->23.976 (grid) at 0 mismatches', async () => {
    for (const [file, fps, start, stride] of [['counter25.mp4', FPS_23976, 10, 40], ['counter23976.mp4', FPS_23976, 10, 37]] as [string, Rational, number, number][]) {
      const m = await makeMediaItem(mediaPath(file));
      const seq = makeSeq(fps);
      const mf = m.probe!.video!.fps;
      for (let k = 0; k < 12; k++) vclip(seq, m, k * 25, 25, (start + k * stride) * mf.den / mf.num);
      const after = await mism(seq, m, true);
      console.log(`[root cause guard ${file} -> ${fps.num}/${fps.den}] patched mismatches=${after} of 300`);
      expect(after).toBe(0);
    }
  });
});

describe('ROOT CAUSE: per-stream PTS-STARTPTS at the head of a file whose audio starts late', () => {
  it('sync24_adelay.mkv, clip at sourceIn 0: patched asetpts=PTS-P/TB + aresample=async=1:first_pts=0 keeps the 0.5 s offset', async () => {
    const m = await makeMediaItem(mediaPath('sync24_adelay.mkv'));
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 96, 0); aclip(seq, m, 0, 96, 0);
    const cur = await audioOnsets((await exportSeq(seq, [m])).outputPath, { threshold: 0.15, quiet: 0.2 });
    const { outputPath, filterGraph } = await exportPatched(request(seq, [m]), {
      filter: (g) => g.replace(/(\[\d+:\d+\])atrim=start=([\d.]+):duration=([\d.]+),asetpts=PTS-STARTPTS/g, (_x, l, st, d) => `${l}atrim=start=${st}:duration=${d},asetpts=PTS-${st}/TB,aresample=async=1:first_pts=0`),
    });
    expect(filterGraph).toContain('first_pts=0');
    const fixed = await audioOnsets(outputPath, { threshold: 0.15, quiet: 0.2 });
    const fl = await flashFrames(outputPath);
    console.log(`[adelay head root cause] flashes=${fl} current beeps=${cur.map((b) => fmt(b, 3))} patched beeps=${fixed.map((b) => fmt(b, 3))} (want 0.5, 2.5)`);
    expect(Math.abs(fixed[0] - 0.5)).toBeLessThan(1 / 24);
  });
});

describe('ROOT CAUSE: input -ss on MPEG-TS does not rebase timestamps to the seek point', () => {
  it('counter24.ts, clip at sourceIn 5.0: -copyts + trim on absolute pts (container start + sourceIn) lands on frame 120', async () => {
    const m = await makeMediaItem(mediaPath('counter24.ts'));
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 48, 5.0);
    const cur = await readCounters((await exportSeq(seq, [m])).outputPath);
    const abs = m.probe!.startTime + 5.0; // probe.startTime = format start_time (1.462)
    const { outputPath } = await exportPatched(request(seq, [m]), {
      args: (a) => { const i = a.indexOf(m.path); return [...a.slice(0, i - 1), '-copyts', ...a.slice(i - 1)]; },
      filter: (g) => g.replace(/(\[\d+:v:0\])trim=start=([\d.]+):duration=([\d.]+),setpts=PTS-STARTPTS/, (_x, l, _st, d) => `${l}trim=start=${abs}:duration=${d},setpts=PTS-${abs}/TB`),
    });
    const fixed = await readCounters(outputPath);
    console.log(`[TS root cause] startTime=${m.probe!.startTime} current first counters=${cur.slice(0, 3)} patched=${fixed.slice(0, 3)} (editor/proxy: 120)`);
    expect(Math.abs(fixed[0] - 120)).toBeLessThanOrEqual(1);
    expect(fixed[24] - fixed[0]).toBe(24);
  });
});

describe('ATTRIBUTION: VFR -> 29.97 / 25 mismatches (vfr.test.ts)', () => {
  it('vfr.mp4 single clip at sourceIn 0.25: mismatches current vs track setpts fix vs track fix + phase-biased trim', async () => {
    const { framePts } = await import('./helpers');
    const m = await makeMediaItem(mediaPath('vfr.mp4'));
    const pts = await framePts(m.path); const cnt = await readCounters(m.path);
    const mf = m.probe!.video!.fps; // r_frame_rate 24 (what the editor uses for its half-frame bias)
    const model = (t: number) => { const tt = t + 0.5 * mf.den / mf.num; let k = 0; for (let i = 0; i < pts.length; i++) { if (pts[i] <= tt + 1e-9) k = i; else break; } return cnt[k]; };
    for (const fps of [FPS_2997, FPS_25]) {
      const seq = makeSeq(fps);
      const n = Math.round(9.5 * fps.num / fps.den);
      const clip = vclip(seq, m, 0, n, 0.25);
      const half = 0.5 * mf.den / mf.num, c = half - 0.5 * fps.den / fps.num;
      const track = (g: string) => g.replace(new RegExp(`setpts=N\\*${fps.den}/${fps.num}/TB`, 'g'), `settb=${fps.den}/${fps.num},setpts=N`);
      const phase = (g: string) => g.replace(/(\[\d+:v:0\])trim=start=([\d.]+):duration=([\d.]+),setpts=PTS-STARTPTS/g, (_x, l, st, d) => `${l}trim=start=${Math.max(0, Number(st) - half)}:duration=${d},setpts=PTS-${(Number(st) + c).toFixed(6)}/TB`);
      const count = async (file: string) => { const out = await readCounters(file); let bad = 0; for (let j = 0; j < n; j++) if (out[j] !== model(sourceTimeAt(clip, j, fps))) bad++; return bad; };
      const cur = await count((await exportSeq(seq, [m])).outputPath);
      const t1 = await count((await exportPatched(request(seq, [m]), { filter: track })).outputPath);
      const t2 = await count((await exportPatched(request(seq, [m]), { filter: (g) => phase(track(g)) })).outputPath);
      console.log(`[vfr attribution ${fps.num}/${fps.den}] mismatches of ${n}: current=${cur} trackSetptsFix=${t1} trackFix+phaseTrim=${t2}`);
      expect(Math.min(t1, t2)).toBeLessThanOrEqual(cur);
    }
  });
});
