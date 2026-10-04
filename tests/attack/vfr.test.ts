/**
 * Variable frame rate sources: probe.isVfr, export fps/duration, and whether the exported frames follow the
 * editor's time->frame mapping (frame covering sourceTime + 0.5/mediaFps) when the source frame grid is irregular.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { MediaItem } from '@shared/model';
import { sourceTimeAt } from '@shared/timeline';
import { ensureMedia, mediaPath, makeMediaItem, makeSeq, vclip, exportSeq, readCounters, framePts, countFrames, ffprobeJson, FPS_24, FPS_2997, FPS_25, fmt } from './helpers';

let vfr: MediaItem;
let srcPts: number[];
let srcCounters: number[];
beforeAll(async () => {
  ensureMedia();
  vfr = await makeMediaItem(mediaPath('vfr.mp4'));
  srcPts = await framePts(mediaPath('vfr.mp4'));
  srcCounters = await readCounters(mediaPath('vfr.mp4'));
});

/** Editor model for an arbitrary frame grid: the frame covering t = sourceTime + 0.5/mediaFps. */
function editorFrameOnGrid(sourceTime: number): number {
  const mf = vfr.probe!.video!.fps;
  const t = sourceTime + 0.5 * mf.den / mf.num;
  let k = 0;
  for (let i = 0; i < srcPts.length; i++) { if (srcPts[i] <= t + 1e-9) k = i; else break; }
  return srcCounters[k];
}

describe('VFR source', () => {
  it('probe flags the file as VFR (r_frame_rate 24 vs avg 26.96) and reports both rates', () => {
    const v = vfr.probe!.video!;
    console.log(`[vfr] fps=${v.fps.num}/${v.fps.den} avgFps=${v.avgFps.num}/${v.avgFps.den} isVfr=${v.isVfr} duration=${vfr.probe!.duration} frames=${srcPts.length} first pts: ${srcPts.slice(0, 3).map((p) => fmt(p, 4))} ... ${srcPts.slice(118, 124).map((p) => fmt(p, 4))}`);
    expect(v.isVfr).toBe(true);
    expect(srcPts.length).toBe(120 + 150);
  });

  for (const [label, fps] of [['24', FPS_24], ['29.97', FPS_2997], ['25', FPS_25]] as const) {
    it(`export to a ${label} sequence: constant fps, exact frame count, frames follow the editor mapping`, async () => {
      const seq = makeSeq(fps);
      const n = Math.round(9.5 * fps.num / fps.den);
      const clip = vclip(seq, vfr, 0, n, 0.25);
      const { outputPath } = await exportSeq(seq, [vfr]);
      const raw = await ffprobeJson(outputPath);
      const frames = await countFrames(outputPath);
      const out = await readCounters(outputPath);
      const pts = await framePts(outputPath);
      const gaps = new Set(pts.slice(1).map((p, i) => Math.round((p - pts[i]) * 1e5)));
      let mism = 0; const examples: string[] = [];
      for (let j = 0; j < n; j++) {
        const want = editorFrameOnGrid(sourceTimeAt(clip, j, fps));
        if (out[j] !== want) { mism++; if (examples.length < 8) examples.push(`j=${j} src=${fmt(sourceTimeAt(clip, j, fps))} want=${want} got=${out[j]}`); }
      }
      console.log(`[vfr -> ${label}] r_frame_rate=${raw.streams[0].r_frame_rate} avg=${raw.streams[0].avg_frame_rate} frames=${frames}/${n} distinct pts gaps=${[...gaps].join(',')} mismatches=${mism}${examples.length ? '\n  ' + examples.join('\n  ') : ''}`);
      expect(raw.streams[0].r_frame_rate).toBe(`${fps.num}/${fps.den}`);
      expect(raw.streams[0].avg_frame_rate).toBe(`${fps.num}/${fps.den}`);
      expect(frames).toBe(n);
      expect(gaps.size).toBe(1);
      expect(mism).toBe(0);
    });
  }
});
