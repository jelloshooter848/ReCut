/**
 * #156: MPEG-TS / MPEG-PS input seeking is not frame-exact: thumbnails took the first decoded frame after `-ss`, which
 * on a long GOP was the NEXT keyframe (frames 75, 75, 150 instead of 56, 73, 136). They now seek a second earlier and
 * drop frames up to the target, as the export does. Frame numbers are a 12-bit gray code burned into the top half.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ts-thumb-'));
process.env.RECUT_CACHE_DIR = path.join(dir, 'cache');

import { getFilmstrip, getThumbnail } from '../../electron/media/thumbs';
import { getFfmpegPath } from '../../electron/media/ffmpeg';

const exec = promisify(execFile);
const FFMPEG = getFfmpegPath() ?? 'ffmpeg';
const W = 192, H = 64;
const G = '(bitor(N,floor(N/2))-bitand(N,floor(N/2)))';
const GRAY = `nullsrc=s=${W}x${H}:r=25,trim=end_frame=250,geq=lum='if(lt(Y,H/2),if(bitand(${G},pow(2,floor(X*12/W))),235,16),128)':cb=128:cr=128`;

async function ff(args: string[]): Promise<Buffer> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

async function frameIndex(image: string): Promise<number> {
  const b = await ff(['-i', image, '-vf', 'crop=iw:ih/2:0:0,scale=12:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  let g = 0;
  for (let k = 0; k < 12; k++) if (b[k] > 125) g |= 1 << k;
  let n = g;
  for (let s = g >> 1; s; s >>= 1) n ^= s;
  return n;
}

const ts = path.join(dir, 'gop25.ts');
const ps = path.join(dir, 'gop25.mpg');
const times = [2.3, 2.95, 5.5];
const want = [56, 73, 136]; // the frames covering those times: floor((t - 0.021 video start) * 25)

beforeAll(async () => {
  const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10.5'];
  await ff(['-f', 'lavfi', '-i', GRAY, ...audio, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-bf', '0', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', ts]);
  await ff(['-f', 'lavfi', '-i', GRAY, ...audio, '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg2video', '-q:v', '2', '-bf', '0', '-g', '25', '-c:a', 'mp2', '-f', 'mpeg', ps]);
}, 60_000);
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('thumbnails of a long-GOP MPEG-TS / MPEG-PS show the frame at the time (#156)', () => {
  it('MPEG-TS, one thumbnail at a time', async () => {
    const got = [];
    for (const t of times) got.push(await frameIndex(await getThumbnail({ path: ts, time: t, width: W })));
    expect(got).toEqual(want); // was [75, 75, 150]: the next keyframes
  }, 60_000);

  it('MPEG-TS filmstrip (one FFmpeg for the batch)', async () => {
    const frames = await getFilmstrip({ path: ts, times: [1.1, 3.62, 7.3], width: 160 });
    const got = [];
    for (const f of frames) got.push(await frameIndex(f));
    expect(got).toEqual([1.1, 3.62, 7.3].map((t) => Math.floor((t - 0.021) * 25 + 1e-6)));
  }, 60_000);

  it('MPEG-PS', async () => {
    const got = [];
    for (const t of times) got.push(await frameIndex(await getThumbnail({ path: ps, time: t, width: W })));
    expect(got.every((n, i) => Math.abs(n - want[i]) <= 1)).toBe(true);
  }, 60_000);
});
