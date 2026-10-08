/**
 * Thumbnail cache files and filmstrip cancellation (perf M):
 * - recut-media:// serves finished thumbnail / filmstrip JPEGs (content-keyed names) as cacheable, everything else
 *   (source media, `.part` files, other cache files) `no-cache`; a source that changed gets a new thumbnail URL.
 * - A filmstrip batch every requester of which canceled has its RUNNING ffmpeg killed (not only dropped while
 *   queued); finished frames are kept, cut-short ones never reach the cache under a final name; a batch another
 *   requester still wants keeps running; a request arriving right behind the kill takes the frames over in one batch.
 *
 * The kill tests use a fake ffmpeg (a Node script, POSIX only) that writes the batch's `.part` outputs and then hangs
 * like a slow decode, so they are deterministic and fast. They cancel only after the fake has logged that its frames
 * are written (`spawned`), never on its spawn line alone: a kill landing between the two would leave no finished frame.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recut-thumbs-cc-')));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { getFfmpegPath, setFfmpegPaths } from '../../electron/media/ffmpeg';
import { getCacheDir } from '../../electron/media/cache';
import { cancelThumbRequests, getFilmstrip, getThumbnail, isThumbnailCacheFile, thumbQueueDepth } from '../../electron/media/thumbs';
import { cacheControlFor, handleMediaRequest } from '../../electron/media/protocol';
import { pathToMediaUrl } from '../../shared/ipc';

const FF = getFfmpegPath() ?? 'ffmpeg';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const src = path.join(tmp, 'clip.mp4');
const changing = path.join(tmp, 'changing.mp4');
const jpgFixture = path.join(tmp, 'fixture.jpg');

function ff(args: string[]): void {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
}

beforeAll(() => {
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=8:size=160x120:rate=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=96x72:rate=1', '-frames:v', '1', '-q:v', '4', '-f', 'mjpeg', jpgFixture]);
}, 60_000);
afterAll(async () => {
  setFfmpegPaths({ ffmpeg: null });
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

// ------------------------------------------------------------------
describe('recut-media:// cache headers for thumbnail files', () => {
  const get = async (p: string, range?: string) => {
    const res = await handleMediaRequest(new Request(pathToMediaUrl(p), range ? { headers: { range } } : undefined));
    await res.body?.cancel();
    return res;
  };

  it('serves a finished thumbnail as immutable, source media and other files as no-cache', async () => {
    const thumb = await getThumbnail({ path: src, time: 2, width: 96 });
    expect(isThumbnailCacheFile(thumb)).toBe(true);
    const res = await get(thumb);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect((await get(thumb, 'bytes=0-9')).headers.get('cache-control')).toBe(IMMUTABLE);

    expect((await get(src)).headers.get('cache-control')).toBe('no-cache');
    expect(isThumbnailCacheFile(src)).toBe(false);
    // A `.part` beside it, a JPEG elsewhere in the cache, a JPEG outside the cache: no-cache.
    const part = `${thumb}.part`;
    fs.writeFileSync(part, 'x');
    const other = path.join(getCacheDir(), 'proxies', '1000_96.jpg');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.copyFileSync(thumb, other);
    const outside = path.join(tmp, path.basename(path.dirname(thumb)), '1000_96.jpg');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.copyFileSync(thumb, outside);
    for (const p of [part, other, outside, jpgFixture]) {
      expect(isThumbnailCacheFile(p)).toBe(false);
      expect((await get(p)).headers.get('cache-control')).toBe('no-cache');
    }
    // `..` cannot walk a matching-looking path out of the thumbs directory.
    const sneaky = path.join(getCacheDir(), 'thumbs', path.basename(path.dirname(thumb)), '..', '..', path.basename(path.dirname(thumb)), '1000_96.jpg');
    expect(cacheControlFor(sneaky)).toBe('no-cache');
    fs.rmSync(part);
  });

  it('a thumbnail re-generated after the source changed has a new URL and the new image', async () => {
    ff(['-f', 'lavfi', '-i', 'color=c=red:size=160x120:rate=24:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', changing]);
    fs.utimesSync(changing, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const before = await getThumbnail({ path: changing, time: 1, width: 96 });
    const beforeBytes = fs.readFileSync(before);
    // The editor re-renders the source (same path, new content and mtime).
    ff(['-f', 'lavfi', '-i', 'color=c=blue:size=160x120:rate=24:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', changing]);
    fs.utimesSync(changing, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
    const after = await getThumbnail({ path: changing, time: 1, width: 96 });
    expect(after).not.toBe(before);
    expect(pathToMediaUrl(after)).not.toBe(pathToMediaUrl(before));
    expect(isThumbnailCacheFile(after)).toBe(true);
    expect(fs.readFileSync(after).equals(beforeBytes)).toBe(false);
    // The old name still holds the old image: a cached copy of it is never wrong.
    expect(fs.readFileSync(before).equals(beforeBytes)).toBe(true);
  });
});

// ------------------------------------------------------------------
describe.skipIf(process.platform === 'win32')('killing canceled filmstrip batches', () => {
  const fake = path.join(tmp, 'fake-ffmpeg.js');
  const log = path.join(tmp, 'fake-ffmpeg.log');
  type Entry = { pid: number; outs?: number; wrote?: boolean; finished?: boolean };
  const entries = (): Entry[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry) : []);
  const spawns = () => entries().filter((e) => e.outs !== undefined);
  /** Pid of the `n`th fake ffmpeg (1-based), once it has written its frames and hangs: only then is a kill deterministic. */
  const spawned = async (n: number): Promise<number> => {
    await waitFor(() => spawns().length === n);
    const { pid } = spawns()[n - 1];
    await waitFor(() => entries().some((e) => e.pid === pid && e.wrote));
    return pid;
  };
  const mode = (m: 'ok' | 'hang', opts: { firstComplete?: boolean; hangMs?: number } = {}) => {
    process.env.FAKE_FF_MODE = m;
    process.env.FAKE_FF_FIRST_COMPLETE = opts.firstComplete === false ? '0' : '1';
    process.env.FAKE_FF_HANG_MS = String(opts.hangMs ?? 20_000);
  };
  const thumbsDir = () => path.join(getCacheDir(), 'thumbs');
  let seq = 0;
  const id = () => `t${++seq}`;

  beforeAll(() => {
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const outs = process.argv.slice(2).filter((a) => a.endsWith('.part')).map((a) => a.replace(/^file:/, ''));
const jpg = fs.readFileSync(${JSON.stringify(jpgFixture)});
const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n');
log({ pid: process.pid, outs: outs.length });
const all = () => { for (const o of outs) fs.writeFileSync(o, jpg); };
if (process.env.FAKE_FF_MODE === 'ok') { all(); process.exit(0); }
// hang: like a slow decode, the first frame is written (complete) and the next one cut short, then nothing for a while
outs.forEach((o, i) => { if (i === 0 && process.env.FAKE_FF_FIRST_COMPLETE !== '0') fs.writeFileSync(o, jpg); else if (i <= 1) fs.writeFileSync(o, jpg.subarray(0, jpg.length >> 1)); });
log({ pid: process.pid, wrote: true });
setTimeout(() => { all(); log({ pid: process.pid, finished: true }); process.exit(0); }, Number(process.env.FAKE_FF_HANG_MS || 20000));
`, { mode: 0o755 });
    setFfmpegPaths({ ffmpeg: fake });
    expect(getFfmpegPath()).toBe(fake);
  });

  it('kills the running batch when its only requester cancels; keeps finished frames, never a partial one', async () => {
    mode('hang');
    const times = [3, 3.5, 4];
    const rid = id();
    const t0 = Date.now();
    const p = getFilmstrip({ path: src, times, width: 64, requestId: rid });
    const pid = await spawned(1);
    expect(alive(pid)).toBe(true);
    cancelThumbRequests([rid]);
    const out = await p;
    expect(Date.now() - t0).toBeLessThan(5000);
    await waitFor(() => !alive(pid), 2000);
    expect(entries().some((e) => e.finished)).toBe(false);
    // Frame 0 was complete when killed: kept. Frame 1 was cut short, frame 2 never written: neither is cached.
    expect(out[0]).toMatch(/3000_64\.jpg$/);
    expect(fs.readFileSync(out[0]).equals(fs.readFileSync(jpgFixture))).toBe(true);
    expect(out.slice(1)).toEqual(['', '']);
    const files = filesUnder(thumbsDir()).filter((f) => /_64\.jpg/.test(f));
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['3000_64.jpg']);
    expect(thumbQueueDepth()).toEqual({ active: 0, waiting: 0 });
    expect(spawns()).toHaveLength(1); // no per-frame fallback after the kill
  });

  it('a request after the kill extracts the missing frames in one batch', async () => {
    mode('ok');
    const n0 = spawns().length;
    const out = await getFilmstrip({ path: src, times: [3, 3.5, 4], width: 64 });
    expect(out.every((p) => p && fs.existsSync(p))).toBe(true);
    expect(spawns().length - n0).toBe(1);
    expect(spawns().at(-1)!.outs).toBe(2); // 3.5 and 4; 3 was kept from the killed batch
  });

  it('a single-frame batch is killed without trying its fallback times', async () => {
    mode('hang', { firstComplete: false });
    const n0 = spawns().length;
    const rid = id();
    const p = getFilmstrip({ path: src, times: [5], width: 66, requestId: rid });
    const pid = await spawned(n0 + 1);
    cancelThumbRequests([rid]);
    expect(await p).toEqual(['']);
    await waitFor(() => !alive(pid), 2000);
    await sleep(200);
    expect(spawns().length).toBe(n0 + 1); // not T-0.5, not 0
    expect(filesUnder(thumbsDir()).filter((f) => /_66\.jpg/.test(f))).toEqual([]);
  });

  it('a batch shared by two requesters is killed only when both have canceled', async () => {
    mode('hang');
    const n0 = spawns().length;
    const a = id(), b = id();
    const pa = getFilmstrip({ path: src, times: [6, 6.5], width: 68, requestId: a });
    const pid = await spawned(n0 + 1);
    const pb = getFilmstrip({ path: src, times: [6, 6.5], width: 68, requestId: b }); // joins the running batch
    await sleep(100);
    expect(spawns().length).toBe(n0 + 1);
    cancelThumbRequests([a]);
    await sleep(300);
    expect(alive(pid)).toBe(true); // b still wants it
    cancelThumbRequests([b]);
    await Promise.all([pa, pb]);
    await waitFor(() => !alive(pid), 2000);
    expect(entries().some((e) => e.finished)).toBe(false);
    expect(filesUnder(thumbsDir()).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('an uncancellable requester pins the batch: it runs to the end', async () => {
    mode('hang', { hangMs: 800 });
    const n0 = spawns().length;
    const a = id();
    const pa = getFilmstrip({ path: src, times: [7, 7.25], width: 70, requestId: a });
    const pid = await spawned(n0 + 1);
    const pb = getFilmstrip({ path: src, times: [7, 7.25], width: 70 }); // no requestId: cannot be canceled
    await sleep(50);
    cancelThumbRequests([a]);
    await sleep(200);
    expect(alive(pid)).toBe(true);
    const [, out] = await Promise.all([pa, pb]);
    expect(out.every((p) => p && fs.existsSync(p))).toBe(true);
    expect(entries().some((e) => e.pid === pid && e.finished)).toBe(true);
    expect(spawns().length).toBe(n0 + 1);
  });

  it('a request arriving right behind the kill takes the frames over in one new batch', async () => {
    mode('hang');
    const n0 = spawns().length;
    const a = id();
    const times = [1, 1.5, 2.5];
    const pa = getFilmstrip({ path: src, times, width: 72, requestId: a });
    const pid = await spawned(n0 + 1);
    cancelThumbRequests([a]);
    mode('ok');
    const pb = getFilmstrip({ path: src, times, width: 72 }); // same tick as the cancel: the killed batch is still in flight
    const [outA, outB] = await Promise.all([pa, pb]);
    await waitFor(() => !alive(pid), 2000);
    expect(outA[0]).toMatch(/1000_72\.jpg$/);
    expect(outB.every((p) => p && fs.existsSync(p))).toBe(true);
    expect(spawns().length - n0).toBe(2); // the killed batch + one batch for the two frames it did not finish
    expect(spawns().at(-1)!.outs).toBe(2);
    expect(filesUnder(thumbsDir()).filter((f) => f.endsWith('.part'))).toEqual([]);
  });
});
