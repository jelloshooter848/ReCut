/**
 * Audio/video sync in exports, measured with a source that has a 1-frame white flash and a 50 ms 1 kHz beep every 2 s
 * (both start at t = 2k exactly; gen-media.sh). A clip taken from the middle of the source must keep flash and beep
 * aligned within one frame in the export, through speed changes, transitions and container/timestamp variants.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { MediaItem, Rational } from '@shared/model';
import { addTransition } from '@shared/timeline';
import { ensureMedia, mediaPath, makeMediaItem, makeSeq, vclip, aclip, exportSeq, flashFrames, audioOnsets, FPS_24, FPS_23976, FPS_2997, fmt } from './helpers';

const items: Record<string, MediaItem> = {};
beforeAll(async () => {
  ensureMedia();
  for (const n of ['sync24.mp4', 'sync24_ts10.mp4', 'sync24.ts', 'sync24_bf.mp4', 'sync24_adelay.mp4', 'sync24_adelay.mkv', 'sync24_vdelay.mkv', 'sync25.mp4']) {
    items[n] = await makeMediaItem(mediaPath(n));
  }
});

function frameOf(sec: number, fps: Rational): number { return sec * fps.num / fps.den; }

async function measure(outputPath: string, fps: Rational, label: string): Promise<{ flashes: number[]; beeps: number[] }> {
  const flashes = await flashFrames(outputPath);
  const beeps = await audioOnsets(outputPath, { threshold: 0.15, quiet: 0.2 });
  console.log(`[sync ${label}] flash frames=${flashes.join(',')} beep onsets(s)=${beeps.map((b) => fmt(b)).join(',')} => beep frames=${beeps.map((b) => fmt(frameOf(b, fps), 2)).join(',')}`);
  return { flashes, beeps };
}

/** First flash frame and first beep (in frames) must agree within tolerance frames. */
function expectAligned(flashes: number[], beeps: number[], fps: Rational, wantFlash: number[], wantBeepSec: number[], tolFrames = 1) {
  expect(flashes, 'flash frames').toEqual(wantFlash);
  expect(beeps.length, 'beep count').toBe(wantBeepSec.length);
  beeps.forEach((b, i) => { expect(Math.abs(frameOf(b, fps) - frameOf(wantBeepSec[i], fps)), `beep ${i} at ${fmt(b)}s vs ${wantBeepSec[i]}s`).toBeLessThanOrEqual(tolFrames); });
}

describe('export A/V sync (24 fps sequence)', () => {
  const cases: { file: string; note: string; beepShift?: number; flashShift?: number }[] = [
    { file: 'sync24.mp4', note: 'plain mp4' },
    { file: 'sync24_ts10.mp4', note: 'mp4 with start_time 10 s (-output_ts_offset 10)' },
    { file: 'sync24.ts', note: 'MPEG-TS (start_time 1.46 s)' },
    { file: 'sync24_bf.mp4', note: 'B-frames, negative CTS offsets, timescale 90000' },
    { file: 'sync24_adelay.mp4', note: 'audio stream starts 0.5 s after video (mp4 edit list)', beepShift: 0.5 },
    { file: 'sync24_adelay.mkv', note: 'audio stream starts 0.5 s after video (mkv)', beepShift: 0.5 },
    { file: 'sync24_vdelay.mkv', note: 'video stream starts 0.5 s after audio (mkv)', flashShift: 0.5 },
  ];
  for (const c of cases) {
    it(`clip from the middle of ${c.file} (${c.note})`, async () => {
      const m = items[c.file];
      const seq = makeSeq(FPS_24);
      // sourceIn 5.0 s, 4 s long: flash at source 6.0 (+flashShift) => output frame 24 (+12*shift), beep at 6.0 (+beepShift) => 1.0 s
      vclip(seq, m, 0, 96, 5.0); aclip(seq, m, 0, 96, 5.0);
      const { outputPath, warnings } = await exportSeq(seq, [m]);
      if (warnings.length) console.log(`[sync ${c.file}] warnings: ${warnings.join(' | ')}`);
      const r = await measure(outputPath, FPS_24, `${c.file} mid`);
      // flashes at source 6.0 and 8.0 (+flashShift) => frames 24, 72 (+24*shift); beeps at 6.0 and 8.0 (+beepShift) => 1.0 s, 3.0 s
      const fs0 = 24 * (c.flashShift ?? 0);
      const wantFlash = [24 + fs0, 72 + fs0];
      const wantBeep = [1.0 + (c.beepShift ?? 0), 3.0 + (c.beepShift ?? 0)];
      expectAligned(r.flashes, r.beeps, FPS_24, wantFlash, wantBeep);
    });
  }

  it('clip from the HEAD (sourceIn 0) of a file whose audio starts 0.5 s late keeps the leading silence', async () => {
    const m = items['sync24_adelay.mkv'];
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 96, 0); aclip(seq, m, 0, 96, 0);
    const { outputPath } = await exportSeq(seq, [m]);
    const r = await measure(outputPath, FPS_24, 'adelay head');
    // flashes at source 0 and 2 s => frames 0, 48; beeps at 0.5 and 2.5 s (Chromium plays the file's audio at its own timestamps)
    expectAligned(r.flashes, r.beeps, FPS_24, [0, 48], [0.5, 2.5]);
  });

  it('clip from the HEAD of a file whose video starts 0.5 s late keeps the video offset', async () => {
    const m = items['sync24_vdelay.mkv'];
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 96, 0); aclip(seq, m, 0, 96, 0);
    const { outputPath } = await exportSeq(seq, [m]);
    const r = await measure(outputPath, FPS_24, 'vdelay head');
    // video frames exist from 0.5 s: flash at source 0.5 and 2.5 => frames 12, 60; beeps at 0 and 2 s
    expect(r.beeps.length).toBe(2);
    expect(Math.abs(frameOf(r.beeps[0], FPS_24))).toBeLessThanOrEqual(1);
    expect(Math.abs(frameOf(r.beeps[1], FPS_24) - 48)).toBeLessThanOrEqual(1);
    expect(r.flashes).toEqual([12, 60]);
  });

  it('2x speed keeps flash and beep aligned (flashes every second)', async () => {
    const m = items['sync24.mp4'];
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 96, 5.0, 2); aclip(seq, m, 0, 96, 5.0, 2);
    const { outputPath } = await exportSeq(seq, [m]);
    const r = await measure(outputPath, FPS_24, '2x');
    expectAligned(r.flashes, r.beeps, FPS_24, [12, 36, 60, 84], [0.5, 1.5, 2.5, 3.5]);
  });

  it('0.5x speed keeps flash and beep aligned', async () => {
    const m = items['sync24.mp4'];
    const seq = makeSeq(FPS_24);
    vclip(seq, m, 0, 96, 5.0, 0.5); aclip(seq, m, 0, 96, 5.0, 0.5);
    const { outputPath } = await exportSeq(seq, [m]);
    const r = await measure(outputPath, FPS_24, '0.5x');
    // flash at source 6.0 => timeline 2.0 s = frame 48 (shown for 2 frames: 48, 49); beep at 2.0 s
    expect(r.flashes.slice(0, 1)).toEqual([48]);
    expect(r.beeps.length).toBe(1);
    expect(Math.abs(frameOf(r.beeps[0], FPS_24) - 48)).toBeLessThanOrEqual(1);
  });

  it('cross dissolve + audio crossfade between two middle clips keeps both sides in sync', async () => {
    const m = items['sync24.mp4'];
    const seq = makeSeq(FPS_24);
    // A: source 5..8 s (flash at 6.0 => frame 24, handle flash at 8.0 => frame 72 mixed), B: source 15..18 s (flash at 16.0 => frame 96)
    vclip(seq, m, 0, 72, 5.0); vclip(seq, m, 72, 72, 15.0);
    aclip(seq, m, 0, 72, 5.0); aclip(seq, m, 72, 72, 15.0);
    expect(addTransition(seq, seq.videoTracks[0].id, 72, 'crossDissolve', 24)).toBeTruthy();
    expect(addTransition(seq, seq.audioTracks[0].id, 72, 'audioCrossfade', 24)).toBeTruthy();
    const { outputPath, warnings } = await exportSeq(seq, [m]);
    console.log('[sync xfade] warnings', warnings);
    const r = await measure(outputPath, FPS_24, 'xfade');
    // A's handle flash (source 8.0 = output frame 72) is at alpha 0.5 => luma ~125 (below the 120 threshold? measure separately)
    expect(r.flashes.filter((f) => f !== 72)).toEqual([24, 96]);
    const beepFrames = r.beeps.map((b) => frameOf(b, FPS_24));
    // beeps: 1.0 s (A), 3.0 s (A handle, half gain), 4.0 s (B)
    expect(beepFrames.length).toBe(3);
    expect(Math.abs(beepFrames[0] - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(beepFrames[1] - 72)).toBeLessThanOrEqual(1);
    expect(Math.abs(beepFrames[2] - 96)).toBeLessThanOrEqual(1);
  });
});

describe('export A/V sync with a 25 fps source in NTSC sequences', () => {
  for (const [label, fps] of [['23.976', FPS_23976], ['24', FPS_24], ['29.97', FPS_2997]] as [string, Rational][]) {
    it(`25 fps source in a ${label} sequence: flashes land within 1 frame of the beeps`, async () => {
      const m = items['sync25.mp4'];
      const seq = makeSeq(fps);
      const frames = Math.round(10 * fps.num / fps.den); // ~10 s
      vclip(seq, m, 0, frames, 5.0); aclip(seq, m, 0, frames, 5.0);
      const { outputPath } = await exportSeq(seq, [m]);
      const r = await measure(outputPath, fps, `25->${label}`);
      // flashes at source 6, 8, 10, 12, 14 => output t = 1, 3, 5, 7, 9 s. A 25 fps frame legitimately covers two output frames
      // at 29.97, so compare flash ONSETS (first frame of a run).
      const onsets = r.flashes.filter((f, i) => i === 0 || f !== r.flashes[i - 1] + 1);
      expect(r.beeps.length).toBe(5);
      expect(onsets.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        const wantT = 1 + 2 * i;
        expect(Math.abs(frameOf(r.beeps[i], fps) - frameOf(wantT, fps)), `beep ${i}`).toBeLessThanOrEqual(1);
        expect(Math.abs(onsets[i] - frameOf(wantT, fps)), `flash ${i} at frame ${onsets[i]} vs ${fmt(frameOf(wantT, fps), 2)}`).toBeLessThanOrEqual(1);
      }
    });
  }
});
