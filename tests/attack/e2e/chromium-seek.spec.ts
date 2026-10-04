/**
 * Chromium seek semantics probe: which media frame does <video> display for a given currentTime?
 * This validates the "editor model" used by the vitest attack suite (frame-centered seek -> covering frame)
 * against the real renderer, through the app's recut-media:// protocol.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, type LaunchedApp } from '../../e2e/helpers';

const MEDIA_DIR = process.env.ATTACK_MEDIA_DIR || '/tmp/claude-0/-home-user-ReCut/db207bb1-8e4d-5534-84bf-420066a58686/scratchpad/attack-media/media';

interface SeekResult { t: number; currentTime: number; counter: number; mediaTime: number | null; r: number[] }

test.describe('Chromium <video> seek semantics', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => {
    execFileSync('bash', [path.resolve(__dirname, '..', 'gen-media.sh'), MEDIA_DIR], { stdio: 'ignore' });
    launched = await launchApp();
  });
  test.afterAll(async () => { await launched?.app.close(); });

  /** Seek to each time and decode the burned-in counter from the presented frame. */
  async function probe(file: string, times: number[]): Promise<{ duration: number; videoWidth: number; videoHeight: number; results: SeekResult[] }> {
    return launched.page.evaluate(async ({ file, times }) => {
      const url = `recut-media://local/${encodeURIComponent(file)}`;
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = url;
      document.body.appendChild(v);
      await new Promise<void>((res, rej) => { v.addEventListener('loadeddata', () => res(), { once: true }); v.addEventListener('error', () => rej(new Error('load error')), { once: true }); });
      const W = v.videoWidth, H = v.videoHeight;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      const results: SeekResult[] = [];
      for (const t of times) {
        let mediaTime: number | null = null;
        const vfc = new Promise<void>((res) => {
          const anyV = v as unknown as { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };
          if (!anyV.requestVideoFrameCallback) return res();
          anyV.requestVideoFrameCallback((_n, meta) => { mediaTime = meta.mediaTime; res(); });
          setTimeout(res, 1500);
        });
        await new Promise<void>((res) => { v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = t; });
        await vfc;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        ctx.drawImage(v, 0, 0, W, H);
        // average a 8x8 block in the middle of each half (grey frames: R=G=B)
        const avg = (x: number, y: number) => { const d = ctx.getImageData(x, y, 8, 8).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return s / (d.length / 4); };
        const top = avg(Math.floor(W / 2) - 4, Math.floor(H / 4) - 4), bot = avg(Math.floor(W / 2) - 4, Math.floor(3 * H / 4) - 4);
        // limited-range Y from R: Y = R*219/255 + 16; counter digit = (Y-16)/4 = R/4.657
        const lo = Math.round(top / (4 * 255 / 219)), hi = Math.round(bot / (4 * 255 / 219));
        results.push({ t, currentTime: v.currentTime, counter: hi * 50 + lo, mediaTime, r: [Math.round(top), Math.round(bot)] });
      }
      v.remove();
      return { duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight, results };
    }, { file, times });
  }

  test('24 fps: frame-center seeks show the covering frame; exact boundaries show frame k; just-before shows k-1', async () => {
    const file = path.join(MEDIA_DIR, 'counter24.mp4');
    const ks = [0, 1, 2, 10, 47, 48, 100, 239];
    const centers = ks.map((k) => (k + 0.5) / 24);
    const starts = ks.map((k) => k / 24);
    const before = ks.filter((k) => k > 0).map((k) => k / 24 - 0.0005);
    const r = await probe(file, [...centers, ...starts, ...before]);
    const lines = r.results.map((x) => `t=${x.t.toFixed(5)} currentTime=${x.currentTime.toFixed(6)} frame=${x.counter} rgb=${x.r} mediaTime=${x.mediaTime === null ? 'n/a' : x.mediaTime.toFixed(6)}`);
    console.log(`[chromium 24fps] duration=${r.duration} size=${r.videoWidth}x${r.videoHeight}\n  ${lines.join('\n  ')}`);
    const got = r.results.map((x) => x.counter);
    expect(got.slice(0, ks.length)).toEqual(ks);                       // centers -> k (covering frame)
    // exact starts: Chromium truncates currentTime to microseconds, so k/24 lands 0.3 µs BEFORE frame k and shows k-1
    // unless k/24 is exactly representable (k = 0, 48): seeking to frame starts is not frame-safe.
    const startGot = got.slice(ks.length, 2 * ks.length);
    console.log(`[chromium 24fps] exact-start seeks: ${startGot.map((f, i) => `${ks[i]}->${f}`).join(' ')}`);
    startGot.forEach((f, i) => expect([ks[i], ks[i] - 1]).toContain(f));
    expect(got.slice(2 * ks.length)).toEqual(ks.filter((k) => k > 0).map((k) => k - 1)); // 0.5 ms before -> k-1
    for (const x of r.results) if (x.mediaTime !== null) expect(Math.abs(x.mediaTime - x.counter / 24)).toBeLessThan(1e-4); // rVFC mediaTime = frame start
  });

  test('23.976 fps, hour-long file: frame-center seeks land on frame k for k = 0, 1, 1000, 86300', async () => {
    const file = path.join(MEDIA_DIR, 'counter23976_1h.mp4');
    const ks = [0, 1, 1000, 86300];
    const r = await probe(file, ks.map((k) => (k + 0.5) * 1001 / 24000));
    const lines = r.results.map((x) => `t=${x.t.toFixed(6)} currentTime=${x.currentTime.toFixed(6)} frame=${x.counter} mediaTime=${x.mediaTime === null ? 'n/a' : x.mediaTime.toFixed(6)} (frame start ${(Math.floor(x.t * 24000 / 1001) * 1001 / 24000).toFixed(6)})`);
    console.log(`[chromium 23.976 1h] duration=${r.duration}\n  ${lines.join('\n  ')}`);
    // the counter encodes N mod 2500
    expect(r.results.map((x) => x.counter)).toEqual(ks.map((k) => k % 2500));
    for (const x of r.results) {
      expect(Math.abs(x.currentTime - x.t)).toBeLessThan(1e-3);
      if (x.mediaTime !== null) expect(Math.abs(x.mediaTime - Math.floor(x.t * 24000 / 1001) * 1001 / 24000)).toBeLessThan(1e-3);
    }
  });

  for (const name of ['counter24_ts10.mp4', 'counter24_start.mkv']) {
    test(`${name} (container start_time != 0): the editor seeks with 0-based source time, Chromium's timeline is NOT 0-based`, async () => {
      const file = path.join(MEDIA_DIR, name);
      const start = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', file]).toString()).format.start_time);
      const r = await probe(file, [0, (100 + 0.5) / 24, start + (100 + 0.5) / 24, start + (300 + 0.5) / 24]);
      const lines = r.results.map((x) => `seek t=${x.t.toFixed(4)} -> currentTime=${x.currentTime.toFixed(4)} frame=${x.counter} mediaTime=${x.mediaTime === null ? 'n/a' : x.mediaTime.toFixed(4)}`);
      console.log(`[chromium ${name}] ffprobe start_time=${start} video.duration=${r.duration}\n  ${lines.join('\n  ')}`);
      // What SourcePlayer/SequencePlayer actually do (currentTime = 0-based source time, no start offset added) must show frame 100
      // (the export, which seeks relative to the container start, shows frame 100 there):
      expect(r.results[1].counter, `0-based seek to ${r.results[1].t} landed at currentTime ${r.results[1].currentTime}`).toBe(100);
      // With the container start added Chromium shows the intended frames (+-1: video starts 22 ms after the container):
      expect([99, 100]).toContain(r.results[2].counter);
      expect([299, 300]).toContain(r.results[3].counter);
    });
  }
});
