/**
 * #149: shot detection is a port of PySceneDetect's AdaptiveDetector (shared/shotDetect.ts). A cut is a frame whose
 * change stands out from its neighbours', so steady camera motion (a pan, a handheld shake) is one shot, where the old
 * fixed FFmpeg `scene` threshold cut it into pieces (#142).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-shot-test-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { startSceneDetectJob } from '../../electron/media/sceneDetect';
import { adaptiveCuts, adaptiveThresholdFor, ContentScorer, meanPixelDistance, rgbToHsv } from '../../shared/shotDetect';

const FF = getFfmpegPath() ?? 'ffmpeg';
afterAll(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

const hsv = (r: number, g: number, b: number) => { const o = rgbToHsv(Uint8Array.of(r, g, b), 1); return [o.h[0], o.s[0], o.v[0]]; };

describe('rgbToHsv (OpenCV 8-bit convention)', () => {
  it('matches OpenCV COLOR_BGR2HSV for known pixels', () => {
    expect(hsv(255, 0, 0)).toEqual([0, 255, 255]);     // red
    expect(hsv(0, 255, 0)).toEqual([60, 255, 255]);    // green
    expect(hsv(0, 0, 255)).toEqual([120, 255, 255]);   // blue
    expect(hsv(128, 128, 128)).toEqual([0, 0, 128]);   // grey
    expect(hsv(0, 0, 0)).toEqual([0, 0, 0]);
    expect(hsv(20, 40, 100)).toEqual([113, 204, 100]); // dark blue: cv2 gives [113 204 100]
    expect(hsv(255, 0, 1)).toEqual([0, 255, 255]);     // hue 359.8 deg wraps to 0
  });

  it('meanPixelDistance and the frame score', () => {
    expect(meanPixelDistance(Uint8Array.of(0, 10, 200), Uint8Array.of(10, 0, 100))).toBe(40);
    const scorer = new ContentScorer(1);
    expect(scorer.score(Uint8Array.of(255, 0, 0))).toBe(0); // first frame
    expect(scorer.score(Uint8Array.of(0, 0, 255))).toBe(40); // hue 0 -> 120, s and v unchanged
  });
});

describe('adaptive cut rule', () => {
  const flat = (n: number, v: number) => Array.from({ length: n }, () => v);
  it('no cuts in still footage or steady motion', () => {
    expect(adaptiveCuts(flat(100, 0))).toEqual([]);
    expect(adaptiveCuts(flat(100, 2))).toEqual([]);
    expect(adaptiveCuts(flat(100, 40))).toEqual([]);  // a fast pan: every frame changes a lot, none stands out
  });
  it('a spike above its neighbours is a cut', () => {
    const s = flat(60, 3); s[30] = 50;
    expect(adaptiveCuts(s)).toEqual([30]);
  });
  it('a spike that is too small on its own is not (minContentVal)', () => {
    const s = flat(60, 1); s[30] = 12;
    expect(adaptiveCuts(s)).toEqual([]);
  });
  it('cuts closer than minShotFrames keep the first', () => {
    const s = flat(80, 3); s[30] = 50; s[38] = 50; s[60] = 50;
    expect(adaptiveCuts(s)).toEqual([30, 60]);
  });
  it('the threshold setting maps 0.35 to the PySceneDetect default', () => {
    expect(adaptiveThresholdFor(0.35)).toBeCloseTo(3, 6);
    expect(adaptiveThresholdFor(0.7)).toBeCloseTo(6, 6);
    expect(adaptiveThresholdFor(0)).toBe(1.2);
  });
});

function ff(args: string[]): void {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
}

async function detect(file: string, mediaId: string, duration: number): Promise<number[]> {
  const q = new JobQueue();
  const job = startSceneDetectJob(q, { mediaId, path: file, threshold: 0.35, duration });
  const final = await q.waitFor(job.id);
  expect(final.error ?? null).toBeNull();
  expect(final.status).toBe('done');
  return (final.result as { boundaries: number[] }).boundaries;
}

describe('detection on generated media', () => {
  it('three hard-cut segments give exactly the two cuts, on the right frames', async () => {
    const file = path.join(tmp, 'cuts.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=2', '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=24', '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=24:d=2',
      '-filter_complex', '[1:v]trim=duration=2,setpts=PTS-STARTPTS[m];[0:v][m][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
    const b = await detect(file, 'cuts', 6);
    expect(b.map((t) => Math.round(t * 24))).toEqual([48, 96]);
  }, 120_000);

  it('a shaky handheld shot with changing exposure is one shot', async () => {
    // A detailed picture swung around fast while the brightness pumps: big frame-to-frame changes, no cut. The old
    // FFmpeg `scene` > 0.35 detector found 22 cuts in this clip.
    const file = path.join(tmp, 'shaky.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=24:d=8',
      '-vf', "crop=480:270:x='700+500*sin(t*9)':y='400+300*sin(t*13)',eq=brightness='0.25*sin(t*7)'",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
    expect(await detect(file, 'shaky', 8)).toEqual([]);
  }, 120_000);
});
