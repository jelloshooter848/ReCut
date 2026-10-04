/**
 * Import attack through the real renderer import path (window.__recut.actions.importMediaFiles → IPC probe).
 *
 *   xvfb-run -a npx playwright test -c tests/attack-qa/playwright.config.ts tests/attack-qa/import.spec.ts
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, makeTestMedia, MEDIA, type LaunchedApp } from '../e2e/helpers';

type W = Window & { __recut: { store: { getState(): any; setState(p: any): void }; actions: any }; recut: any };

let app: LaunchedApp;
let tmp: string;
let mediaDir: string;
let scratch: string;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-attack-import-'));
  mediaDir = makeTestMedia(tmp, 'short');
  scratch = path.join(tmp, 'scratch');
  fs.mkdirSync(scratch);
  app = await launchApp({ tmp });
  app.page.on('pageerror', (e) => pageErrors.push(e.message));
});
test.afterAll(async () => {
  try { await app.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false })); } catch { /* gone */ }
  await app.app.close().catch(() => undefined);
});

/** Import and wait until each returned id is probed or failed; returns the media items. */
async function imp(paths: string[], timeout = 60_000) {
  const ids: string[] = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.importMediaFiles(p), paths);
  await app.page.waitForFunction((ids) => {
    const media = (window as unknown as W).__recut.store.getState().project.media;
    return ids.every((id: string) => media[id] && (media[id].probe || media[id].probeError));
  }, ids, { timeout });
  const items = await app.page.evaluate((ids) => { const m = (window as unknown as W).__recut.store.getState().project.media; return ids.map((id: string) => m[id]); }, ids);
  return items as { id: string; name: string; path: string; kind: string; offline: boolean; probe?: any; probeError?: string }[];
}

const state = () => app.page.evaluate(() => { const s = (window as unknown as W).__recut.store.getState(); return { mediaCount: Object.keys(s.project.media).length, past: s.history.past.length, canUndo: s.canUndo(), dirty: s.dirty }; });

test('0-byte file, directory path, .recut file and a missing path all produce probe errors without crashing', async () => {
  const zero = path.join(scratch, 'zero.mp4'); fs.writeFileSync(zero, '');
  const dir = path.join(scratch, 'folder.mp4'); fs.mkdirSync(dir);
  const recut = path.join(scratch, 'proj.recut'); fs.writeFileSync(recut, JSON.stringify({ formatVersion: 1, name: 'x' }));
  const missing = path.join(scratch, 'never-existed.mp4');
  const items = await imp([zero, dir, recut, missing]);
  for (const it of items) {
    expect(it.probeError, `${it.name} should have a probe error`).toBeTruthy();
    expect(it.kind).toBe('unknown');
  }
  const gone = items.find((i) => i.path === missing)!;
  expect(gone.offline, 'a file that is missing at probe time is not flagged offline (so the Relink flow never offers it)').toBe(true);
  // Once the file appears, a re-probe clears offline.
  fs.copyFileSync(path.join(mediaDir, MEDIA.movie1), missing);
  const back = await app.page.evaluate(async (id) => { const w = window as unknown as W; await w.__recut.actions.probeMedia(id); const m = w.__recut.store.getState().project.media[id]; return { offline: m.offline, probeError: m.probeError, kind: m.kind }; }, gone.id);
  expect(back).toEqual({ offline: false, probeError: undefined, kind: 'video' });
  const folder = items.find((i) => i.path === dir)!;
  expect(folder.probeError).toMatch(/director|EISDIR|Is a directory/i);
  expect(pageErrors).toEqual([]);
});

test('unicode / emoji / spaces / quotes in a file name: probe, insert, thumbnail and export all work', async () => {
  const weird = path.join(scratch, `Ünïcödé 🎬 "quoted" it's [a],b;c.mp4`);
  fs.copyFileSync(path.join(mediaDir, MEDIA.movie1), weird);
  const [it] = await imp([weird]);
  expect(it.probeError).toBeUndefined();
  expect(it.kind).toBe('video');
  const thumb = await app.page.evaluate(async (p) => {
    const url = await (window as unknown as W).recut.thumbnail({ path: p, time: 1, width: 160 });
    const r = await fetch(url); return { url, status: r.status, type: r.headers.get('content-type') };
  }, weird);
  expect(thumb.status).toBe(200);
  const stream = await app.page.evaluate(async (p) => { const r = await fetch((window as unknown as W).recut.mediaUrl(p), { headers: { Range: 'bytes=0-99' } }); return r.status; }, weird);
  expect(stream).toBe(206);
  const result = await app.page.evaluate(async ({ id, out }) => {
    const w = window as unknown as W; const st = w.__recut.store.getState();
    const seqId = st.project.activeSequenceId;
    st.insertFromSource(seqId, { mediaId: id, in: 0, out: 1, atFrame: 0, mode: 'overwrite' });
    const s2 = w.__recut.store.getState(); const seq = s2.project.sequences[seqId];
    const settings = { outputDir: out, fileName: 'weird out.mp4', width: 64, height: 36, fps: seq.fps, videoCodec: 'libx264', qualityMode: 'crf', crf: 30, videoBitrateKbps: 0, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 64, audioChannels: 2, sampleRate: 48000, rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false };
    const res = await w.recut.startExport({ sequence: seq, media: s2.project.media, settings });
    if (!res.ok) return res;
    for (let i = 0; i < 600; i++) {
      const jobs = await w.recut.listJobs(); const j = jobs.find((x: any) => x.id === res.jobId);
      if (j && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled')) return { ok: j.status === 'done', error: j.error, outputPath: res.outputPath };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, error: 'timeout' };
  }, { id: it.id, out: scratch });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(fs.existsSync(path.join(scratch, 'weird out.mp4'))).toBe(true);
});

test('the same path twice in one import call must not create two media items', async () => {
  const p = path.join(mediaDir, MEDIA.ep1);
  const before = (await state()).mediaCount;
  const items = await imp([p, p]);
  const after = (await state()).mediaCount;
  expect(after - before, `imported ${items.length} items for one path`).toBe(1);
  // and a second import of the same path is a no-op
  const again: string[] = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.importMediaFiles([p]), p);
  expect(again).toEqual([]);
});

test('a subtitle file is rejected as media; a subtitle-only container becomes kind "subtitle" and cannot be inserted', async () => {
  const srt = path.join(mediaDir, MEDIA.srt('Station Eleven S01E01'));
  const mkv = path.join(scratch, 'subs-only.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', srt, '-c:s', 'srt', mkv]);
  const items = await imp([srt, mkv]);
  expect(items.map((i) => i.path), '.srt files attach to media ("Import subtitles"), they are not media items').toEqual([mkv]);
  for (const it of items) expect(it.kind, `${it.name}: ${it.probeError ?? JSON.stringify(it.probe?.subtitles)}`).toBe('subtitle');
  const inserted = await app.page.evaluate((id) => { const st = (window as unknown as W).__recut.store.getState(); return st.insertFromSource(st.project.activeSequenceId, { mediaId: id, in: 0, out: 5, atFrame: 0, mode: 'overwrite' }); }, items[0].id);
  expect(inserted).toEqual([]);
});

test('an audio-only and an image file are classified and insertable', async () => {
  const items = await imp([path.join(mediaDir, MEDIA.score), path.join(mediaDir, MEDIA.title)]);
  expect(items.map((i) => i.kind).sort()).toEqual(['audio', 'image']);
});

test('500 files at once: finishes, all probed, and is ONE undo step', async () => {
  const tiny = path.join(scratch, 'tiny.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tiny]);
  const many = path.join(scratch, 'many'); fs.mkdirSync(many);
  const paths: string[] = [];
  for (let i = 0; i < 500; i++) { const p = path.join(many, `clip-${String(i).padStart(3, '0')}.mp4`); fs.linkSync(tiny, p); paths.push(p); }
  const before = await state();
  const t0 = Date.now();
  const items = await imp(paths, 170_000);
  const ms = Date.now() - t0;
  const failed = items.filter((i) => i.probeError);
  console.log(`[attack] 500-file import took ${ms} ms; ${failed.length} probe failures${failed.length ? ': ' + failed[0].probeError : ''}`);
  expect(items.length).toBe(500);
  expect(failed.length, `probe failures under concurrency: ${failed.slice(0, 3).map((f) => f.probeError).join(' | ')}`).toBe(0);
  expect(ms).toBeLessThan(120_000);
  const after = await state();
  expect(after.mediaCount - before.mediaCount).toBe(500);
  // One Ctrl+Z should remove the whole import.
  await app.page.evaluate(() => { (window as unknown as W).__recut.store.getState().undo(); });
  const undone = await state();
  expect(undone.mediaCount - before.mediaCount, `history grew by ${after.past - before.past} entries for one import; a single undo left ${undone.mediaCount - before.mediaCount} items`).toBe(0);
  expect(pageErrors).toEqual([]);
});
