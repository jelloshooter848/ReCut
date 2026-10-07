/**
 * Collect Project end to end in the main-process code (electron/project/collect.ts): a small project with generated
 * media is collected into a temp folder; the result opens with every clip online, its proxy copied, and no derived
 * media rebuilt (the content-keyed cache recognises the copies). Also: preflight problems, cancellation, disk errors
 * (injected), verification failures and missing media.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-collect-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { cacheKeyForPath, getCacheDir } from '../../electron/media/cache';
import { getThumbnail } from '../../electron/media/thumbs';
import { startProxyJob } from '../../electron/media/proxy';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { collectPreflight, startCollectJob, streamCopy, type CollectDeps } from '../../electron/project/collect';
import { loadProjectFile } from '../../electron/project/io';
import { createMediaItem, createProject, serializeProject } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import { COLLECT_INCOMPLETE_MARKER, type CollectOptions, type CollectRequest, type CollectResult } from '../../shared/collect';
import type { JobInfo, MediaItem, Project } from '../../shared/model';

const FF = getFfmpegPath() ?? 'ffmpeg';
const src = path.join(tmp, 'sources');
const disc1 = path.join(src, 'Disc 1', 'title_t00.mp4');
const disc2 = path.join(src, 'Disc 2', 'title_t00.mp4');
const srt = path.join(src, 'subs', 'title.srt');
const offline = path.join(src, 'gone', 'lost.mp4');
const MTIME = new Date(1_700_000_000_000);
const ALL: CollectOptions = { scope: 'all', includeSubtitles: true, includeProxies: true };

function makeMedia(file: string, pattern: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `${pattern}=duration=2:size=160x120:rate=24`, '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
  { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  fs.utimesSync(file, MTIME, MTIME);
}

function derivedFiles(): string[] {
  const dir = getCacheDir();
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name)).filter((f) => !path.relative(dir, f).startsWith(`ids${path.sep}`)).sort();
}

let project: Project;
let mA: MediaItem, mB: MediaItem, mGone: MediaItem;
let thumbA = '';

beforeAll(async () => {
  makeMedia(disc1, 'testsrc');
  makeMedia(disc2, 'testsrc2');
  fs.mkdirSync(path.dirname(srt), { recursive: true });
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  project = createProject('Galaxy Saga: Fan Cut');
  mA = createMediaItem(disc1, 'Disc 1 main title');
  mB = createMediaItem(disc2, 'Disc 2 main title');
  mGone = createMediaItem(offline, 'Lost reel');
  mGone.offline = true;
  for (const m of [mA, mB, mGone]) project.media[m.id] = m;
  const seq = Object.values(project.sequences)[0];
  seq.videoTracks[0].clips.push(makeClip({ mediaId: mA.id, name: 'a', sourceIn: 0, duration: 24, kind: 'video' }, 0));
  seq.videoTracks[0].clips.push(makeClip({ mediaId: mB.id, name: 'b', sourceIn: 0, duration: 24, kind: 'video' }, 24));
  project.subtitleTracks.sub1 = { id: 'sub1', name: 'title.srt', language: 'eng', path: srt, mediaId: mA.id, cues: [{ id: 'c', start: 0, end: 1, text: 'Hello' }], origin: 'srt' };

  // Derived media for disc 1, as the app makes them while editing: a thumbnail and a ready proxy.
  thumbA = await getThumbnail({ path: disc1, time: 1, width: 160 });
  const q = new JobQueue({ throttleMs: 10 });
  const { job } = await startProxyJob(q, { mediaId: mA.id, path: disc1, height: 120 });
  const done = await q.waitFor(job.id);
  const r = done.result as { path: string; audioStreams: number[] };
  mA.proxy = { status: 'ready', path: r.path, audioStreams: r.audioStreams };
  q.flush();
}, 180_000);

afterAll(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

function request(dest: string, options: CollectOptions = ALL): CollectRequest {
  return { projectJson: serializeProject(project), destination: dest, options };
}

async function collect(dest: string, deps: CollectDeps = {}, options: CollectOptions = ALL, q = new JobQueue({ throttleMs: 5 })): Promise<{ job: JobInfo; q: JobQueue }> {
  fs.mkdirSync(dest, { recursive: true });
  const res = await startCollectJob(q, request(dest, options), deps);
  if (!res.ok) throw new Error(res.error);
  return { job: await q.waitFor(res.jobId), q };
}

describe('Collect Project', () => {
  it('preflight: sizes, free space, the folder it creates, and missing media', async () => {
    const dest = path.join(tmp, 'pre');
    fs.mkdirSync(dest);
    const s = await collectPreflight(request(dest));
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.folder).toBe(path.join(dest, 'Galaxy Saga_ Fan Cut'));
    expect(s.projectFile).toBe(path.join(dest, 'Galaxy Saga_ Fan Cut', 'Galaxy Saga_ Fan Cut.recut'));
    expect(s.byKind.media.files).toBe(2);
    expect(s.byKind.subtitle.files).toBe(1);
    expect(s.byKind.proxy.files).toBe(1);
    expect(s.totalBytes).toBe(fs.statSync(disc1).size + fs.statSync(disc2).size + fs.statSync(srt).size + fs.statSync(mA.proxy.path!).size);
    expect(s.freeBytes).toBeGreaterThan(0);
    expect(s.missing.map((m) => m.path)).toEqual([offline]);
    expect(s.problems).toEqual([]);
    expect(fs.readdirSync(dest)).toEqual([]); // a preflight writes nothing

    // Not enough space, a destination that does not exist, a non-empty target folder.
    const small = await collectPreflight(request(dest), { freeBytes: async () => 1000 });
    expect(small.ok && small.problems.join(' ')).toMatch(/Not enough free space/);
    const nowhere = await collectPreflight(request(path.join(tmp, 'does-not-exist')));
    expect(nowhere.ok && nowhere.problems.join(' ')).toMatch(/does not exist/);
    fs.mkdirSync(path.join(dest, 'Galaxy Saga_ Fan Cut'));
    fs.writeFileSync(path.join(dest, 'Galaxy Saga_ Fan Cut', 'something.txt'), 'x');
    const full = await collectPreflight(request(dest));
    expect(full.ok && full.problems.join(' ')).toMatch(/not empty/);
    const refused = await startCollectJob(new JobQueue(), request(dest));
    expect(refused.ok).toBe(false);
    // Bad requests are refused, never thrown.
    expect((await collectPreflight({ ...request(dest), destination: 'relative/dir' })).ok).toBe(false);
    expect((await collectPreflight({ ...request(dest), projectJson: '{nope' })).ok).toBe(false);
  });

  it('copies, verifies and rewrites; the result opens with every clip online and nothing is rebuilt', async () => {
    const before = derivedFiles();
    const originalJson = serializeProject(project);
    const dest = path.join(tmp, 'archive drive');
    const { job, q } = await collect(dest);
    expect(job.status, job.error).toBe('done');
    const r = job.result as CollectResult;
    const folder = path.join(dest, 'Galaxy Saga_ Fan Cut');
    expect(r.folder).toBe(folder);
    expect(r.files).toBe(4);
    expect(r.missing.map((m) => m.names)).toEqual([['Lost reel']]);

    // Layout: same-named files from different folders are kept apart by their folder names.
    const files = fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => path.relative(folder, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
    expect(files).toEqual([
      'Galaxy Saga_ Fan Cut.recut',
      'Media/Disc 1/title_t00.mp4',
      'Media/Disc 2/title_t00.mp4',
      'Proxies/Disc 1/title_t00.mp4_120p_all.mp4',
      'Subtitles/title.srt',
    ]);
    expect(fs.existsSync(path.join(folder, COLLECT_INCOMPLETE_MARKER))).toBe(false);
    // Copies are byte-identical and keep the original's modification time.
    expect(fs.readFileSync(path.join(folder, 'Media/Disc 2/title_t00.mp4')).equals(fs.readFileSync(disc2))).toBe(true);
    expect(Math.floor(fs.statSync(path.join(folder, 'Media/Disc 1/title_t00.mp4')).mtimeMs)).toBe(MTIME.getTime());

    // The collected project: absolute paths into the folder, every clip's media online.
    const loaded = await loadProjectFile(r.projectFile);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const p = loaded.project;
    expect(p.name).toBe('Galaxy Saga: Fan Cut');
    expect(p.media[mA.id].path).toBe(path.join(folder, 'Media', 'Disc 1', 'title_t00.mp4'));
    expect(p.media[mB.id].path).toBe(path.join(folder, 'Media', 'Disc 2', 'title_t00.mp4'));
    expect(path.isAbsolute(p.media[mA.id].path)).toBe(true);
    for (const seq of Object.values(p.sequences)) for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) {
      expect(fs.existsSync(p.media[c.mediaId].path), p.media[c.mediaId].path).toBe(true);
    }
    expect(p.media[mA.id].proxy).toMatchObject({ status: 'ready', path: path.join(folder, 'Proxies', 'Disc 1', 'title_t00.mp4_120p_all.mp4') });
    expect(fs.existsSync(p.media[mA.id].proxy.path!)).toBe(true);
    expect(p.subtitleTracks.sub1.path).toBe(path.join(folder, 'Subtitles', 'title.srt'));
    expect(p.media[mGone.id].path).toBe(offline); // skipped: unchanged, still offline

    // No cache rebuild: the copies have the originals' content keys, so their thumbnail and proxy are cache hits.
    expect(await cacheKeyForPath(p.media[mA.id].path)).toBe(await cacheKeyForPath(disc1));
    expect(await getThumbnail({ path: p.media[mA.id].path, time: 1, width: 160 })).toBe(thumbA);
    const px = await startProxyJob(q, { mediaId: mA.id, path: p.media[mA.id].path, height: 120 });
    expect(((await q.waitFor(px.job.id)).result as { cached: boolean }).cached).toBe(true);
    expect(derivedFiles()).toEqual(before);

    // The original project and media are untouched.
    expect(serializeProject(project)).toBe(originalJson);
    expect(fs.existsSync(disc1) && fs.existsSync(disc2) && fs.existsSync(srt)).toBe(true);
    expect(Math.floor(fs.statSync(disc1).mtimeMs)).toBe(MTIME.getTime());

    // A second collect into the same destination is refused (the folder is no longer empty).
    const again = await startCollectJob(q, request(dest));
    expect(again.ok).toBe(false);
    q.flush();
  }, 120_000);

  it("'sequences only' without subtitles or proxies copies just the media clips use", async () => {
    const p2 = JSON.parse(serializeProject(project)) as Project;
    const seq = Object.values(p2.sequences)[0];
    seq.videoTracks[0].clips = seq.videoTracks[0].clips.filter((c) => c.mediaId === mA.id);
    const dest = path.join(tmp, 'seq-only');
    fs.mkdirSync(dest);
    const q = new JobQueue({ throttleMs: 5 });
    const res = await startCollectJob(q, { projectJson: JSON.stringify(p2), destination: dest, options: { scope: 'sequences', includeSubtitles: false, includeProxies: false } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const job = await q.waitFor(res.jobId);
    expect(job.status, job.error).toBe('done');
    const loaded = await loadProjectFile(res.projectFile);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.project.media[mA.id].path).toBe(path.join(res.folder, 'Media', 'title_t00.mp4'));
    expect(loaded.project.media[mB.id].path).toBe(disc2); // unused: not copied, original path
    expect(loaded.project.media[mA.id].proxy.path).toBe(mA.proxy.path); // proxy not included: still the cache file
    expect(loaded.project.subtitleTracks.sub1.path).toBe(srt);
    expect(fs.readdirSync(res.folder).sort()).toEqual(['Galaxy Saga_ Fan Cut.recut', 'Media']);
  }, 60_000);

  it('cancel: stops mid-copy, leaves the folder marked incomplete without a project file', async () => {
    const dest = path.join(tmp, 'canceled');
    fs.mkdirSync(dest);
    const q = new JobQueue({ throttleMs: 5 });
    let started!: () => void;
    const copying = new Promise<void>((r) => { started = r; });
    const slowCopy: CollectDeps['copyFile'] = async (from, to, o) => {
      await fsp.writeFile(to, 'partial', { flag: 'wx' });
      o.onBytes(7);
      started();
      await new Promise((_r, reject) => { o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
    };
    const res = await startCollectJob(q, request(dest), { copyFile: slowCopy });
    if (!res.ok) throw new Error(res.error);
    await copying;
    expect(q.get(res.jobId)?.progress).toBeGreaterThan(0);
    q.cancel(res.jobId);
    const job = await q.waitFor(res.jobId);
    expect(job.status).toBe('canceled');
    const left = fs.readdirSync(res.folder, { recursive: true }).map(String);
    expect(left).toContain(COLLECT_INCOMPLETE_MARKER);
    expect(left.some((f) => f.endsWith('.part'))).toBe(false);
    expect(left.some((f) => f.endsWith('.recut'))).toBe(false);
    expect(fs.readFileSync(path.join(res.folder, COLLECT_INCOMPLETE_MARKER), 'utf8')).toMatch(/canceled/);
    expect(fs.existsSync(disc1)).toBe(true);
  });

  it('a disk error (disk full) fails the job with the folder marked incomplete; originals untouched', async () => {
    const dest = path.join(tmp, 'disk-full');
    fs.mkdirSync(dest);
    let calls = 0;
    const failing: CollectDeps['copyFile'] = async (from, to, o) => {
      if (++calls === 1) return streamCopy(from, to, o); // the first file copies fine
      await fsp.writeFile(to, Buffer.alloc(1000), { flag: 'wx' });
      o.onBytes(1000);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const { job } = await collect(dest, { copyFile: failing });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/ENOSPC/);
    expect(job.error).toMatch(/incomplete/);
    const folder = path.join(dest, 'Galaxy Saga_ Fan Cut');
    const left = fs.readdirSync(folder, { recursive: true }).map(String);
    expect(left).toContain(COLLECT_INCOMPLETE_MARKER);
    expect(left.some((f) => f.endsWith('.part'))).toBe(false);
    expect(left.some((f) => f.endsWith('.recut'))).toBe(false);
    expect(fs.readFileSync(path.join(folder, COLLECT_INCOMPLETE_MARKER), 'utf8')).toMatch(/failed: .*ENOSPC/);
    expect(fs.statSync(disc1).size).toBeGreaterThan(1000);
    expect(Math.floor(fs.statSync(disc2).mtimeMs)).toBe(MTIME.getTime());
  });

  it('a copy that does not match the original (fingerprint) fails verification', async () => {
    const dest = path.join(tmp, 'bad-copy');
    const { job } = await collect(dest, {
      fingerprint: async (f) => (f.endsWith('.part') ? 'corrupt' : 'original'),
    });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/does not match the original/);
    expect(fs.existsSync(path.join(dest, 'Galaxy Saga_ Fan Cut', COLLECT_INCOMPLETE_MARKER))).toBe(true);
    // a short copy (size check)
    const dest2 = path.join(tmp, 'short-copy');
    const { job: j2 } = await collect(dest2, { copyFile: async (from, to) => { await fsp.writeFile(to, 'short', { flag: 'wx' }); } });
    expect(j2.status).toBe('failed');
    expect(j2.error).toMatch(/is 5 bytes, the original/);
  });

  it('an unreadable source (vanished after the preflight) fails cleanly', async () => {
    const vanish = path.join(src, 'vanish', 'temp.mp4');
    fs.mkdirSync(path.dirname(vanish), { recursive: true });
    fs.copyFileSync(disc1, vanish);
    const p3 = JSON.parse(serializeProject(project)) as Project;
    const m = createMediaItem(vanish, 'Vanishing');
    p3.media = { [m.id]: m };
    const dest = path.join(tmp, 'vanish-dest');
    fs.mkdirSync(dest);
    const q = new JobQueue({ throttleMs: 5 });
    // Hold the queue's export lane so the source can disappear between the check and the copy.
    let release!: () => void;
    const blocker = q.add({ kind: 'export', title: 'blocker', run: () => new Promise<void>((r) => { release = r; }) });
    const res = await startCollectJob(q, { projectJson: JSON.stringify(p3), destination: dest, options: ALL });
    if (!res.ok) throw new Error(res.error);
    fs.rmSync(vanish);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await q.waitFor(blocker.id);
    const job = await q.waitFor(res.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/cannot read .*temp\.mp4/);
    expect(fs.existsSync(path.join(res.folder, COLLECT_INCOMPLETE_MARKER))).toBe(true);
  });
});
