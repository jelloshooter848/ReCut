/**
 * Derived-media cache behaviour when a source file is moved, renamed or copied.
 *
 * Regression test for bugs/closed/2026-10-05-moved-media-cache-miss.md. Cache keys used to hash the absolute path
 * (electron/media/cache.ts cacheKeyForFile), so after a move every thumbnail, waveform, proxy and scene lookup for the
 * new path missed and the work was redone. They are now content keys (size + sampled fingerprint, cacheKeyForPath),
 * and entries written under the old path-based key are still found (legacy fallback, adopted under the content key).
 *
 * The first version of this file pinned the bug ("misses (regenerates) at the new path"); its assertions are inverted
 * here, and the move is made harder: the file is renamed too and its mtime is NOT preserved.
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
import {
  cacheKeyForFile, cacheKeyForPath, cacheKeysForPath, getCacheDir, identityStats, resetContentKeyMemo,
} from '../../electron/media/cache';
import { getFilmstrip, getThumbnail } from '../../electron/media/thumbs';
import { getWaveform, waveformCachePaths } from '../../electron/media/waveform';
import { proxyOutputPath, startProxyJob } from '../../electron/media/proxy';
import { sceneCachePath, startSceneDetectJob } from '../../electron/media/sceneDetect';
import { JobQueue } from '../../electron/jobs/jobQueue';
import type { JobInfo } from '../../shared/model';

const FF = getFfmpegPath() ?? 'ffmpeg';
const oldDir = path.join(tmp, 'driveA', 'Movies');
const newDir = path.join(tmp, 'driveB', 'Archive', 'Renamed');
const oldPath = path.join(oldDir, 'feature.mp4');
const newPath = path.join(newDir, 'Feature (2001) remux.mp4');
const MTIME = new Date(1_700_000_000_000);
const NEW_MTIME = new Date(1_750_000_000_000);

/** Every file in the cache except the content-key index (`ids/`), which grows by one entry per path seen. */
function derivedFiles(): string[] {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !path.relative(dir, f).startsWith(`ids${path.sep}`))
    .sort();
}

function makeMedia(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
  { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
}

async function proxy(q: JobQueue, p: string): Promise<{ final: JobInfo; outputPath: string }> {
  const r = await startProxyJob(q, { mediaId: 'm1', path: p, height: 120 });
  return { final: await q.waitFor(r.job.id), outputPath: r.outputPath };
}

async function scenes(q: JobQueue, p: string, mediaId: string): Promise<JobInfo> {
  const job = startSceneDetectJob(q, { mediaId, path: p, threshold: 0.4, duration: 4 });
  return q.waitFor(job.id);
}

beforeAll(() => {
  makeMedia(oldPath);
  fs.utimesSync(oldPath, MTIME, MTIME);
}, 120_000);

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('derived media after moving a source file', () => {
  it('reuses thumbnails, filmstrip, waveform, proxy and scene cuts after a move + rename that changes the mtime', async () => {
    const q = new JobQueue({ throttleMs: 10 });

    // 1. Generate every kind of derived media at the original location.
    const thumbA = await getThumbnail({ path: oldPath, time: 1, width: 160 });
    const stripA = await getFilmstrip({ path: oldPath, times: [0, 2, 3], width: 96 });
    const keysA = await cacheKeysForPath(oldPath);
    const waveA = await getWaveform(oldPath, keysA.key, { legacyKey: keysA.legacyKey });
    const proxyA = await proxy(q, oldPath);
    expect(proxyA.final.status).toBe('done');
    expect((proxyA.final.result as { cached: boolean }).cached).toBe(false);
    const scenesA = await scenes(q, oldPath, 'm1');
    expect(scenesA.status).toBe('done');
    expect(fs.existsSync(sceneCachePath(keysA.key, 0.4))).toBe(true);
    const before = derivedFiles();
    const stamps = () => before.map((f) => `${f}@${fs.statSync(f).mtimeMs}`);
    const stampsBefore = stamps();
    // thumbnail + 3 filmstrip frames + waveform (.pk + .json) + proxy + scenes
    expect(before).toHaveLength(8);

    // 2. Move it across "drives" (copy + delete), rename it, and do not keep the mtime (cp without -p).
    fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(oldPath, newPath);
    fs.utimesSync(newPath, NEW_MTIME, NEW_MTIME);
    fs.unlinkSync(oldPath);
    const moved = fs.statSync(newPath);
    expect(Math.floor(moved.mtimeMs)).not.toBe(MTIME.getTime());

    // 3. Same bytes: the same content key, although path, name and mtime all changed (the legacy key does change).
    const fpBefore = identityStats.fingerprinted;
    const keysB = await cacheKeysForPath(newPath);
    expect(keysB.key).toBe(keysA.key);
    expect(keysB.legacyKey).not.toBe(keysA.legacyKey);
    expect(keysB.legacyKey).toBe(cacheKeyForFile(newPath, moved.size, moved.mtimeMs));
    expect(identityStats.fingerprinted).toBe(fpBefore + 1); // read once for the new path...
    await cacheKeyForPath(newPath);
    expect(identityStats.fingerprinted).toBe(fpBefore + 1); // ...and remembered

    // 4. Every lookup at the new path is a cache hit: the same files, nothing regenerated.
    expect(await getThumbnail({ path: newPath, time: 1, width: 160 })).toBe(thumbA);
    expect(await getFilmstrip({ path: newPath, times: [0, 2, 3], width: 96 })).toEqual(stripA);
    const waveB = await getWaveform(newPath, keysB.key, { legacyKey: keysB.legacyKey });
    expect(Array.from(waveB.peaks)).toEqual(Array.from(waveA.peaks));
    const proxyB = await proxy(q, newPath);
    expect(proxyB.final.status).toBe('done');
    expect((proxyB.final.result as { cached: boolean; path: string }).cached).toBe(true);
    expect((proxyB.final.result as { path: string }).path).toBe((proxyA.final.result as { path: string }).path);
    expect(proxyB.outputPath).toBe(proxyA.outputPath);
    const scenesB = await scenes(q, newPath, 'm2');
    expect(scenesB.status).toBe('done');
    expect(scenesB.result).toEqual(scenesA.result);
    // The same files, none rewritten (a recomputed entry is written to a .part and renamed over its name).
    expect(derivedFiles()).toEqual(before);
    expect(stamps()).toEqual(stampsBefore);

    // Control: a change to the content (a different file at the same path) is a different key and a miss.
    fs.copyFileSync(newPath, `${newPath}.bak`);
    const fh = fs.openSync(newPath, 'r+');
    fs.writeSync(fh, Buffer.from('XXXX'), 0, 4, 8); // inside the first sampled block
    fs.closeSync(fh);
    fs.utimesSync(newPath, NEW_MTIME, NEW_MTIME); // even with the same size and mtime... (legacy key unchanged)
    resetContentKeyMemo();
    fs.rmSync(path.join(getCacheDir(), 'ids'), { recursive: true, force: true });
    expect(await cacheKeyForPath(newPath)).not.toBe(keysA.key);
    fs.renameSync(`${newPath}.bak`, newPath);
    q.flush();
  }, 180_000);

  it('reuses entries written under the pre-0.10 path-based key (no invalidation on upgrade) and adopts them', async () => {
    const q = new JobQueue({ throttleMs: 10 });
    const file = path.join(tmp, 'legacy', 'episode.mp4');
    makeMedia(file);
    const keys = await cacheKeysForPath(file);
    const thumb = await getThumbnail({ path: file, time: 1, width: 160 });
    await getWaveform(file, keys.key, { legacyKey: keys.legacyKey });
    const p = await proxy(q, file);
    expect(p.final.status).toBe('done');

    // Turn the entries into what an older version left behind: the same files, named by the legacy key.
    const thumbsRoot = path.dirname(path.dirname(thumb));
    const contentThumbDir = path.dirname(thumb);
    const { createHash } = await import('node:crypto');
    const legacyThumbDir = path.join(thumbsRoot, createHash('sha1').update(`${keys.legacyKey}|covering-frame-display-shape-v4`).digest('hex'));
    fs.renameSync(contentThumbDir, legacyThumbDir);
    const wc = waveformCachePaths(keys.key), wl = waveformCachePaths(keys.legacyKey);
    fs.renameSync(wc.pk, wl.pk);
    fs.renameSync(wc.json, wl.json);
    fs.renameSync(proxyOutputPath(keys.key, 120), proxyOutputPath(keys.legacyKey, 120));
    const legacyFiles = derivedFiles();

    // Fresh process state: nothing remembered in memory.
    resetContentKeyMemo();
    const thumb2 = await getThumbnail({ path: file, time: 1, width: 160 });
    expect(thumb2).toBe(thumb); // served from the legacy entry, now linked under the content key
    const wave = await getWaveform(file, keys.key, { legacyKey: keys.legacyKey });
    expect(wave.peaks.length).toBeGreaterThan(0);
    const p2 = await proxy(q, file);
    expect((p2.final.result as { cached: boolean }).cached).toBe(true);
    expect((p2.final.result as { path: string }).path).toBe(proxyOutputPath(keys.key, 120));

    // Nothing was regenerated: every new file is a hard link of a legacy one (same inode, no extra bytes).
    const after = derivedFiles();
    const added = after.filter((f) => !legacyFiles.includes(f));
    expect(added.sort()).toEqual([thumb, wc.json, wc.pk, proxyOutputPath(keys.key, 120)].sort());
    const legacyInodes = new Set(legacyFiles.map((f) => fs.statSync(f).ino));
    for (const f of added) expect(legacyInodes.has(fs.statSync(f).ino)).toBe(true);
    q.flush();
  }, 180_000);
});
