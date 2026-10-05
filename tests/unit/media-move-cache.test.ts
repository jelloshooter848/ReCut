/**
 * Derived-media cache behaviour when a source file is moved (same bytes, same mtime, new folder).
 *
 * Pins the CURRENT behaviour described in bugs/open/2026-10-05-moved-media-cache-miss.md: cache keys hash the
 * absolute path (electron/media/cache.ts cacheKeyForFile), so after a move every thumbnail, waveform and proxy lookup
 * for the new path misses and the work is redone. A fix for that report should invert the "misses" assertions below
 * (and say so in its Resolution); the same-path control must keep hitting either way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-move-cache-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { cacheKeyForPath, getCacheDir } from '../../electron/media/cache';
import { getThumbnail } from '../../electron/media/thumbs';
import { getWaveform } from '../../electron/media/waveform';
import { startProxyJob } from '../../electron/media/proxy';
import { JobQueue } from '../../electron/jobs/jobQueue';

const FF = getFfmpegPath() ?? 'ffmpeg';
const oldDir = path.join(tmp, 'driveA', 'Movies');
const newDir = path.join(tmp, 'driveB', 'Archive', 'Movies');
const oldPath = path.join(oldDir, 'feature.mp4');
const newPath = path.join(newDir, 'feature.mp4');

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort();
}

beforeAll(() => {
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', oldPath],
  { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
}, 120_000);

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('derived media after moving a source file (same bytes, same mtime)', () => {
  it('hits the cache at the same path, and misses (regenerates) at the new path', async () => {
    const q = new JobQueue({ throttleMs: 10 });

    // 1. Generate thumbnail, waveform and proxy at the original location.
    const thumbA = await getThumbnail({ path: oldPath, time: 1, width: 160 });
    const keyA = await cacheKeyForPath(oldPath);
    await getWaveform(oldPath, keyA);
    const proxyA = await startProxyJob(q, { mediaId: 'm1', path: oldPath, height: 120 });
    const proxyAFinal = await q.waitFor(proxyA.job.id);
    expect(proxyAFinal.status).toBe('done');
    expect((proxyAFinal.result as { cached: boolean }).cached).toBe(false);

    // Control: a second request at the same path is served from the cache (no new files).
    const before = listFiles(getCacheDir());
    expect(await getThumbnail({ path: oldPath, time: 1, width: 160 })).toBe(thumbA);
    const proxyA2 = await startProxyJob(q, { mediaId: 'm1', path: oldPath, height: 120 });
    expect(((await q.waitFor(proxyA2.job.id)).result as { cached: boolean }).cached).toBe(true);
    expect(listFiles(getCacheDir())).toEqual(before);

    // 2. Move the file to another folder the way a cross-drive move does (copy + delete), keeping its mtime.
    const st = fs.statSync(oldPath);
    fs.copyFileSync(oldPath, newPath);
    fs.utimesSync(newPath, st.atime, st.mtime);
    fs.unlinkSync(oldPath);
    const moved = fs.statSync(newPath);
    expect(moved.size).toBe(st.size);
    expect(Math.floor(moved.mtimeMs)).toBe(Math.floor(st.mtimeMs));

    // 3. Same bytes, same size, same mtime: the key still changes because it hashes the absolute path.
    const keyB = await cacheKeyForPath(newPath);
    expect(keyB).not.toBe(keyA);

    // Thumbnail: a different cache file that did not exist before the request, so the frame was extracted again.
    const thumbB = await getThumbnail({ path: newPath, time: 1, width: 160 });
    expect(thumbB).not.toBe(thumbA);
    expect(before).not.toContain(thumbB);
    expect(fs.existsSync(thumbB)).toBe(true);

    // Waveform: no cached peaks for the new key before the call; decoded again and written under the new key.
    const wavesDir = path.join(getCacheDir(), 'waves');
    expect(fs.existsSync(path.join(wavesDir, `${keyB}.pk`))).toBe(false);
    await getWaveform(newPath, keyB);
    expect(fs.existsSync(path.join(wavesDir, `${keyB}.pk`))).toBe(true);

    // Proxy: a full re-encode (cached: false) to a new output file.
    const proxyB = await startProxyJob(q, { mediaId: 'm1', path: newPath, height: 120 });
    const proxyBFinal = await q.waitFor(proxyB.job.id);
    expect(proxyBFinal.status).toBe('done');
    expect((proxyBFinal.result as { cached: boolean }).cached).toBe(false);
    expect(proxyB.outputPath).not.toBe(proxyA.outputPath);

    // Every derived file (thumbnail, waveform .pk + .json, proxy) now exists twice: once per path.
    expect(before).toHaveLength(4);
    const after = listFiles(getCacheDir());
    expect(after).toHaveLength(2 * before.length);
    expect(after.filter((f) => !before.includes(f))).toHaveLength(before.length);
    q.flush();
  }, 120_000);
});
