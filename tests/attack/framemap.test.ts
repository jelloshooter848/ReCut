/**
 * Frame mapping: does the exported frame at timeline frame j show the same media frame the editor shows?
 * Editor model (src/playback/sequencePlayer.ts updateVideoElements): element.currentTime = sourceTimeAt(clip, j) + 0.5/mediaFps,
 * Chromium displays the frame covering that time => media frame floor(sourceTime*mediaFps + 0.5).
 * Export (electron/export/renderGraph.ts): -ss/trim keep frames with pts >= sourceTime, then fps=<seq fps>.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sourceTimeAt, clipEnd } from '@shared/timeline';
import { framesToSeconds } from '@shared/time';
import type { MediaItem, Rational, Sequence } from '@shared/model';
import { ensureMedia, mediaPath, makeMediaItem, makeSeq, vclip, exportSeq, exportPatched, request, readCounters, editorMediaFrame, FPS_23976, FPS_24, FPS_25, FPS_2997, countFrames } from './helpers';

let c24: MediaItem, c25: MediaItem, c23976: MediaItem, c24ts: MediaItem;

beforeAll(async () => {
  ensureMedia();
  c24 = await makeMediaItem(mediaPath('counter24.mp4'));
  c25 = await makeMediaItem(mediaPath('counter25.mp4'));
  c23976 = await makeMediaItem(mediaPath('counter23976.mp4'));
  c24ts = await makeMediaItem(mediaPath('counter24.ts'));
});

interface Mismatch { clip: number; j: number; got: number; want: number; sourceTime: number }

/** Export a sequence of short clips and compare every output frame's counter with the editor model. */
async function compare(seq: Sequence, media: MediaItem, label: string): Promise<{ mismatches: Mismatch[]; frames: number; expectedFrames: number }> {
  const { outputPath } = await exportSeq(seq, [media]);
  const counters = await readCounters(outputPath);
  const mfps = media.probe!.video!.fps;
  const mismatches: Mismatch[] = [];
  let expectedFrames = 0;
  seq.videoTracks[0].clips.forEach((clip, ci) => {
    expectedFrames += clip.duration;
    for (let f = clip.start; f < clip.start + clip.duration; f++) {
      const st = sourceTimeAt(clip, f, seq.fps);
      const want = editorMediaFrame(st, mfps);
      const got = counters[f] ?? -2;
      if (got !== want) mismatches.push({ clip: ci, j: f - clip.start, got, want, sourceTime: st });
    }
  });
  // classify: a 'drop+dup' is frame k missing while k+1 (or the previous) is shown twice in a row
  let dropDup = 0;
  for (let i = 1; i + 1 < counters.length; i++) if (counters[i] === counters[i + 1] && counters[i] >= 0 && counters[i] !== counters[i - 1] + 1 && counters[i] === counters[i - 1] + 2) dropDup++;
  if (dropDup) console.log(`[framemap ${label}] drop+dup events (frame skipped, next frame doubled): ${dropDup}`);
  const summary = mismatches.slice(0, 12).map((m) => `clip${m.clip} j=${m.j} src=${m.sourceTime.toFixed(5)} want=${m.want} got=${m.got}`).join('\n  ');
  console.log(`[framemap ${label}] frames=${counters.length} expected=${expectedFrames} mismatches=${mismatches.length}${mismatches.length ? '\n  ' + summary : ''}`);
  return { mismatches, frames: counters.length, expectedFrames };
}

/** N clips of `len` frames; clip k starts at media frame-aligned sourceIn = (startFrame + k*stride)/mediaFps (+ offset seconds). */
function manyClips(seq: Sequence, media: MediaItem, n: number, len: number, startFrame: number, stride: number, offsetSec = 0): void {
  const mfps = media.probe!.video!.fps;
  for (let k = 0; k < n; k++) {
    const sourceIn = (startFrame + k * stride) * mfps.den / mfps.num + offsetSec;
    vclip(seq, media, k * len, len, sourceIn);
  }
}

describe('export frame mapping vs editor model', () => {
  it('24 fps source in a 24 fps sequence, frame-aligned sourceIn (control)', async () => {
    const seq = makeSeq(FPS_24);
    manyClips(seq, c24, 40, 6, 7, 11);
    const r = await compare(seq, c24, '24->24 aligned');
    expect(r.frames).toBe(r.expectedFrames);
    expect(r.mismatches).toEqual([]);
  });

  it('23.976 source in a 23.976 sequence, frame-aligned sourceIn (pts rounding at -ss/trim)', async () => {
    const seq = makeSeq(FPS_23976);
    manyClips(seq, c23976, 60, 5, 3, 7);
    const r = await compare(seq, c23976, '23.976->23.976 aligned');
    expect(r.frames).toBe(r.expectedFrames);
    expect(r.mismatches).toEqual([]);
  });

  it('25 fps source in a 23.976 sequence (rate conversion: fps filter vs frame-centered seek)', async () => {
    const seq = makeSeq(FPS_23976);
    manyClips(seq, c25, 12, 24, 10, 40);
    const r = await compare(seq, c25, '25->23.976');
    expect(r.frames).toBe(r.expectedFrames);
    expect(r.mismatches).toEqual([]);
  });

  it('25 fps source in a 29.97 sequence', async () => {
    const seq = makeSeq(FPS_2997);
    manyClips(seq, c25, 12, 30, 10, 40);
    const r = await compare(seq, c25, '25->29.97');
    expect(r.frames).toBe(r.expectedFrames);
    expect(r.mismatches).toEqual([]);
  });

  it('ATTRIBUTION: 25 -> 29.97 with exact setpts: remaining mismatches are the fps-filter policy, not truncation', async () => {
    const seq = makeSeq(FPS_2997);
    manyClips(seq, c25, 12, 30, 10, 40);
    const re = /setpts=N\*1001\/30000\/TB/g;
    const { outputPath } = await exportPatched(request(seq, [c25]), { filter: (g) => g.replace(re, 'settb=1001/30000,setpts=N') });
    const counters = await readCounters(outputPath);
    let mism = 0; const ex: string[] = [];
    for (const clip of seq.videoTracks[0].clips) for (let f = clip.start; f < clipEnd(clip); f++) {
      const want = editorMediaFrame(sourceTimeAt(clip, f, seq.fps), c25.probe!.video!.fps);
      if (counters[f] !== want) { mism++; if (ex.length < 6) ex.push(`j=${f - clip.start} src=${sourceTimeAt(clip, f, seq.fps).toFixed(4)} want=${want} got=${counters[f]}`); }
    }
    console.log(`[framemap 25->29.97 exact setpts] frames=${counters.length} mismatches=${mism} ${ex.join('; ')}`);
    expect(counters.length).toBe(360);
  });

  it('24 fps source in a 24 fps sequence with sourceIn OFF the media frame grid (after slip/trim in a 25 fps sequence)', async () => {
    // sourceIn values that are k/25 (set in a 25 fps sequence, then the clip is reused in a 24 fps sequence)
    const seq = makeSeq(FPS_24);
    for (let k = 0; k < 40; k++) vclip(seq, c24, k * 6, 6, (50 + k * 7) / 25);
    const r = await compare(seq, c24, '24->24 off-grid (k/25)');
    expect(r.frames).toBe(r.expectedFrames);
    expect(r.mismatches).toEqual([]);
  });

  it('a single long 23.976 clip does not drift over 20 s', async () => {
    const seq = makeSeq(FPS_23976);
    vclip(seq, c23976, 0, 460, 12 * 1001 / 24000); // start at media frame 12, ends at 19.69 s (< 20 s media)
    const r = await compare(seq, c23976, '23.976 long clip');
    expect(r.frames).toBe(460);
    expect(r.mismatches).toEqual([]);
  });

  it('ROOT CAUSE: the same 23.976 clip with setpts=N*den/num/TB replaced by settb+setpts=N has no drop/dup', async () => {
    const seq = makeSeq(FPS_23976);
    const clip = vclip(seq, c23976, 0, 460, 12 * 1001 / 24000);
    const req = request(seq, [c23976]);
    const re = /setpts=N\*1001\/24000\/TB/g;
    const { outputPath, filterGraph } = await exportPatched(req, { filter: (g) => g.replace(re, 'settb=1001/24000,setpts=N') });
    expect(filterGraph).toContain('settb=1001/24000,setpts=N');
    const counters = await readCounters(outputPath);
    let mism = 0;
    for (let f = 0; f < clip.duration; f++) if (counters[f] !== editorMediaFrame(sourceTimeAt(clip, f, seq.fps), c23976.probe!.video!.fps)) mism++;
    console.log(`[framemap 23.976 long clip, exact setpts] frames=${counters.length} mismatches=${mism}`);
    expect(counters.length).toBe(460);
    expect(mism).toBe(0);
  });

  it('MPEG-TS source: a clip from sourceIn 5.0 s starts on the frame the editor shows (119/120), not 20 frames earlier', async () => {
    const seq = makeSeq(FPS_24);
    const clip = vclip(seq, c24ts, 0, 48, 5.0);
    const { outputPath, warnings } = await exportSeq(seq, [c24ts]);
    const counters = await readCounters(outputPath);
    const want = editorMediaFrame(sourceTimeAt(clip, 0, FPS_24), FPS_24); // = 120 (container start 1.462, video start 1.483: frame 120 at 6.483 covers 5.0208+1.462)
    console.log(`[framemap TS] warnings=${warnings.join('|')} first counters=${counters.slice(0, 6).join(',')} ... [24..27]=${counters.slice(24, 28).join(',')} editor shows ${want - 1}/${want}`);
    expect(Math.abs(counters[0] - want)).toBeLessThanOrEqual(1);
    expect(counters[24] - counters[0]).toBe(24);
  });

  it('exported frame count equals the frame count of the range at every fps (no -t off-by-one)', async () => {
    for (const fps of [FPS_23976, FPS_24, FPS_25, FPS_2997] as Rational[]) {
      const seq = makeSeq(fps);
      const n = 97;
      vclip(seq, c25, 0, n, 1.0);
      const { outputPath, durationSec } = await exportSeq(seq, [c25]);
      const frames = await countFrames(outputPath);
      console.log(`[framecount] fps=${fps.num}/${fps.den} want=${n} got=${frames} durationSec=${durationSec.toFixed(6)} expected=${framesToSeconds(n, fps).toFixed(6)}`);
      expect(frames).toBe(n);
    }
  });
});
