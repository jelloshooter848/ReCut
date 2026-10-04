/**
 * Export graph correctness under stress and at the edges: long sequences, transitions at the range edges,
 * overlapping transitions, compositing over gaps, upscales, codec/bitrate settings, odd and rotated sources.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem, Sequence } from '@shared/model';
import { addTransition, clipEnd } from '@shared/timeline';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { ensureMedia, mediaPath, makeMediaItem, makeSeq, vclip, aclip, exportSeq, exportPatched, request, readCounters, frameLuma, flashFrames, audioOnsets, audioRms, countFrames, ffprobeJson, framePts, FPS_24, FPS_23976, SCRATCH, fmt, ff } from './helpers';

let counter24: MediaItem, sync24: MediaItem, small360: MediaItem, odd853: MediaItem, rotated: MediaItem, image: MediaItem;
beforeAll(async () => {
  ensureMedia();
  counter24 = await makeMediaItem(mediaPath('counter24.mp4'));
  sync24 = await makeMediaItem(mediaPath('sync24.mp4'));
  small360 = await makeMediaItem(mediaPath('small360.mp4'));
  odd853 = await makeMediaItem(mediaPath('odd853.mp4'));
  rotated = await makeMediaItem(mediaPath('rotated.mp4'));
  image = await makeMediaItem(mediaPath('image.png'));
});

describe('scale: 300-clip sequence', () => {
  it('buildRenderGraph is fast and ffmpeg accepts a 300-input graph; frames are exact', async () => {
    const seq = makeSeq(FPS_24);
    for (let k = 0; k < 300; k++) { vclip(seq, counter24, k * 2, 2, (k % 200) / 24 * 2 + 1 / 24); aclip(seq, counter24, k * 2, 2, (k % 200) / 24 * 2 + 1 / 24); }
    const t0 = performance.now();
    const g = buildRenderGraph(request(seq, [counter24]));
    const buildMs = performance.now() - t0;
    console.log(`[300 clips] buildRenderGraph ${buildMs.toFixed(1)} ms, inputs=${g.inputCount}, args=${g.args.length}, filter graph ${(g.filterGraph.length / 1024).toFixed(1)} KB, chains=${g.filterGraph.split(';\n').length}`);
    expect(buildMs).toBeLessThan(2000);
    const t1 = performance.now();
    const { outputPath } = await exportSeq(seq, [counter24]);
    const runS = (performance.now() - t1) / 1000;
    const frames = await countFrames(outputPath);
    const counters = await readCounters(outputPath);
    let bad = 0;
    for (let k = 0; k < 300; k++) for (let j = 0; j < 2; j++) if (counters[k * 2 + j] !== (k % 200) * 2 + 1 + j) bad++;
    console.log(`[300 clips] ffmpeg ran ${runS.toFixed(1)} s for ${frames} frames (25 s of output); wrong frames=${bad}`);
    expect(frames).toBe(600);
    expect(bad).toBe(0);

    // PERF EXPERIMENT: the same graph with the 1 s decoder pre-roll removed (-ss moved to the exact start, trim=start=0).
    const t2 = performance.now();
    const patched = await exportPatched(request(seq, [counter24]), {
      args: (a) => a.map((x, i) => (a[i - 1] === '-ss' ? String(Number(x) + 1) : x)),
      filter: (g) => g.replace(/\btrim=start=1:/g, 'trim=start=0:').replace(/\batrim=start=1:/g, 'atrim=start=0:'),
    });
    const runS2 = (performance.now() - t2) / 1000;
    const c2 = await readCounters(patched.outputPath);
    let bad2 = 0;
    for (let k = 0; k < 300; k++) for (let j = 0; j < 2; j++) if (c2[k * 2 + j] !== (k % 200) * 2 + 1 + j) bad2++;
    console.log(`[300 clips, no pre-roll] ffmpeg ran ${runS2.toFixed(1)} s; wrong frames=${bad2} (speed-up ${(runS / runS2).toFixed(2)}x)`);
    expect(bad2).toBe(0);
  }, 900_000);
});

describe('transitions at the edges', () => {
  it('fade from black at sequence start and fade to black at the end (single-sided transitions)', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, sync24, 0, 48, 1.0); // source 1..3 s: flash at 2.0 => frame 24
    expect(addTransition(seq, seq.videoTracks[0].id, 0, 'dipToBlack', 12)).toBeTruthy();
    expect(addTransition(seq, seq.videoTracks[0].id, 48, 'dipToBlack', 12)).toBeTruthy();
    const { outputPath, warnings } = await exportSeq(seq, [sync24]);
    const l = await frameLuma(outputPath);
    console.log(`[edge fades] warnings=${warnings.length} luma[0..3]=${l.slice(0, 4).map((x) => x.toFixed(0))} luma[24]=${l[24]} luma[44..47]=${l.slice(44, 48).map((x) => x.toFixed(0))} frames=${l.length}`);
    expect(l.length).toBe(48);
    expect(l[0]).toBeLessThan(20);           // starts black
    expect(l[24]).toBeGreaterThan(200);      // flash intact in the middle
    expect(l[47]).toBeLessThan(20);          // ends black
  });

  it('crossDissolve on both ends of a 10-frame clip: the planner drops the second one with a warning, output length is exact', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, counter24, 0, 48, 2.0); vclip(seq, counter24, 48, 10, 8.0); vclip(seq, counter24, 58, 48, 12.0);
    expect(addTransition(seq, seq.videoTracks[0].id, 48, 'crossDissolve', 16)).toBeTruthy();
    expect(addTransition(seq, seq.videoTracks[0].id, 58, 'crossDissolve', 16)).toBeTruthy();
    const g = buildRenderGraph(request(seq, [counter24]));
    console.log(`[10-frame clip both sides] warnings: ${g.warnings.join(' | ')}`);
    const { outputPath } = await exportSeq(seq, [counter24]);
    expect(await countFrames(outputPath)).toBe(106);
    const c = await readCounters(outputPath);
    // outside the transitions the frames must be exact
    expect(c[0]).toBe(48); expect(c[30]).toBe(78); expect(c[105]).toBe(12 * 24 + 47);
  });

  it('dip to black + audio crossfade at the same cut: black at the cut, audio continuous, length exact', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, sync24, 0, 48, 1.0); vclip(seq, sync24, 48, 48, 11.0);
    aclip(seq, sync24, 0, 48, 1.0); aclip(seq, sync24, 48, 48, 11.0);
    expect(addTransition(seq, seq.videoTracks[0].id, 48, 'dipToBlack', 24)).toBeTruthy();
    expect(addTransition(seq, seq.audioTracks[0].id, 48, 'audioCrossfade', 24)).toBeTruthy();
    const { outputPath } = await exportSeq(seq, [sync24]);
    const l = await frameLuma(outputPath);
    const beeps = await audioOnsets(outputPath, { threshold: 0.15, quiet: 0.2 });
    console.log(`[dip+xfade] frames=${l.length} luma@47=${l[47]} luma@48=${l[48]} flashes=${(await flashFrames(outputPath)).join(',')} beeps=${beeps.map((b) => fmt(b, 3))}`);
    expect(l.length).toBe(96);
    expect(l[47]).toBeLessThan(40); expect(l[48]).toBeLessThan(40);
    // beeps at source 2.0 (A) => 1.0 s and source 12.0 (B) => 3.0 s
    expect(beeps.map((b) => Math.round(b * 24))).toEqual([24, 72]);
  });

  it('inOut range whose boundary falls inside a transition: hard cut with a warning, frames exact', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, counter24, 0, 48, 2.0); vclip(seq, counter24, 48, 48, 8.0);
    expect(addTransition(seq, seq.videoTracks[0].id, 48, 'crossDissolve', 24)).toBeTruthy();
    seq.view.inPoint = 40; seq.view.outPoint = 70; // straddles the cut at 48 but not the transition's full extent
    const g = buildRenderGraph(request(seq, [counter24], { rangeMode: 'inOut' }));
    console.log(`[inOut straddle] frameCount=${g.frameCount} warnings=${g.warnings.join(' | ')}`);
    const { outputPath } = await exportSeq(seq, [counter24], { rangeMode: 'inOut' });
    const c = await readCounters(outputPath);
    expect(c.length).toBe(30);
    // range starts at timeline 40 => clip A frame 40 => media 48+40 = 88; after the cut at range frame 8 => media 192
    expect(c[0]).toBe(88);
    expect(c[29]).toBe(8 * 24 + 21);
  });
});

describe('compositing and scaling', () => {
  it('V2 clip at 50% opacity over a V1 GAP renders half-intensity over black (not over transparent)', async () => {
    const seq = makeSeq(FPS_24);
    seq.videoTracks.push({ ...seq.videoTracks[0], id: 'v2', name: 'V2', clips: [], transitions: [] });
    const c = vclip(seq, sync24, 0, 24, 2.0, 1, 1); // flash at source 2.0 => frame 0 (luma 235)
    c.transform.opacity = 0.5;
    const { outputPath } = await exportSeq(seq, [sync24]);
    const l = await frameLuma(outputPath);
    console.log(`[V2 opacity over gap] luma[0]=${l[0]} luma[1]=${l[1]}`);
    expect(Math.abs(l[0] - (16 + (235 - 16) * 0.5))).toBeLessThan(8);
  });

  it('4K export from a 640x360 source upscales to 3840x2160 with full-frame coverage', async () => {
    const seq = makeSeq(FPS_24, 3840, 2160);
    vclip(seq, small360, 0, 12, 1.0);
    const { outputPath } = await exportSeq(seq, [small360], { width: 3840, height: 2160, preset: 'ultrafast' });
    const raw = await ffprobeJson(outputPath);
    expect([raw.streams[0].width, raw.streams[0].height]).toEqual([3840, 2160]);
    // the source centre (20x20 at 310,170) has luma ~126; the same region scaled 6x must have the same luma, and the
    // bottom-right corner region of testsrc (bright) must not be letterboxed away
    const { stdout } = await ff(['-i', outputPath, '-frames:v', '1', '-vf', 'crop=120:120:1860:1020,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    const { stdout: src } = await ff(['-i', small360.path, '-frames:v', '1', '-vf', 'crop=20:20:310:170,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    const { stdout: br } = await ff(['-i', outputPath, '-frames:v', '1', '-vf', 'crop=600:300:3240:1860,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    const { stdout: brSrc } = await ff(['-i', small360.path, '-frames:v', '1', '-vf', 'crop=100:50:540:310,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    console.log(`[4K upscale] centre luma out=${stdout[0]} src=${src[0]}; bottom-right out=${br[0]} src=${brSrc[0]}`);
    expect(Math.abs(stdout[0] - src[0])).toBeLessThan(12);
    expect(Math.abs(br[0] - brSrc[0])).toBeLessThan(12);
  }, 120_000);

  it('bitrate mode and libx265 produce valid files of exact length', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, counter24, 0, 24, 1.0); aclip(seq, counter24, 0, 24, 1.0);
    const a = await exportSeq(seq, [counter24], { qualityMode: 'bitrate', videoBitrateKbps: 800 });
    const b = await exportSeq(seq, [counter24], { videoCodec: 'libx265', preset: 'ultrafast' });
    const ra = await ffprobeJson(a.outputPath), rb = await ffprobeJson(b.outputPath);
    console.log(`[bitrate] ${ra.streams[0].codec_name} frames=${await countFrames(a.outputPath)} | [x265] ${rb.streams[0].codec_name} tag? frames=${await countFrames(b.outputPath)}`);
    expect(await countFrames(a.outputPath)).toBe(24);
    expect(rb.streams[0].codec_name).toBe('hevc');
    expect(await countFrames(b.outputPath)).toBe(24);
  }, 120_000);

  it('853x480 (odd width) source exports without error and keeps aspect (pillarboxed into 320x240 => 320x180 image)', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, odd853, 0, 12, 1.0);
    const { outputPath, warnings } = await exportSeq(seq, [odd853]);
    const { stdout } = await ff(['-i', outputPath, '-frames:v', '1', '-vf', 'crop=320:20:0:0,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    console.log(`[odd853] warnings=${warnings.join('|')} top-band luma=${stdout[0]} (letterbox => ~16)`);
    expect(stdout[0]).toBeLessThan(24);
  });

  it('rotated source (rotation=90): export honours the display rotation (portrait content, pillarboxed)', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, rotated, 0, 12, 1.0);
    const { outputPath } = await exportSeq(seq, [rotated]);
    // portrait 240x320 fitted into 320x240 => 180x240 centered: columns 0..69 black, center column has the counter grey
    const { stdout } = await ff(['-i', outputPath, '-frames:v', '1', '-vf', 'crop=60:240:0:0,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    const { stdout: mid } = await ff(['-i', outputPath, '-frames:v', '1', '-vf', 'crop=100:240:110:0,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    console.log(`[rotated] left band luma=${stdout[0]} center luma=${mid[0]} probe says ${rotated.probe!.video!.width}x${rotated.probe!.video!.height}`);
    expect(stdout[0]).toBeLessThan(24);
    expect(mid[0]).toBeGreaterThan(24);
  });

  it('still image clip renders for its whole duration (and the loop input does not run long)', async () => {
    const seq = makeSeq(FPS_24);
    vclip(seq, image, 0, 50, 0);
    const { outputPath } = await exportSeq(seq, [image]);
    expect(await countFrames(outputPath)).toBe(50);
  });
});

describe('-t clamp vs exact frames (AAC priming, 23.976)', () => {
  it('audio length equals the video length within one AAC frame and the mp4 duration equals frames/fps', async () => {
    const seq = makeSeq(FPS_23976);
    vclip(seq, counter24, 0, 241, 1.0); aclip(seq, counter24, 0, 241, 1.0);
    const { outputPath, durationSec } = await exportSeq(seq, [counter24]);
    const raw = await ffprobeJson(outputPath);
    const v = raw.streams.find((s) => s.codec_type === 'video')!, a = raw.streams.find((s) => s.codec_type === 'audio')!;
    const pts = await framePts(outputPath);
    console.log(`[t-clamp] want=${durationSec.toFixed(6)} format=${raw.format.duration} v=${v.duration} a=${a.duration} frames=${pts.length} last pts=${pts[pts.length - 1]}`);
    expect(pts.length).toBe(241);
    expect(Math.abs(Number(v.duration) - durationSec)).toBeLessThan(1e-3);
    expect(Math.abs(Number(a.duration) - durationSec)).toBeLessThan(1024 / 48000 + 1e-3);
  });
});
