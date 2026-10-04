/**
 * Missing media / proxies / export-through-IPC attack, against the real Electron app.
 *
 *   xvfb-run -a npx playwright test -c tests/attack-qa/playwright.config.ts tests/attack-qa/media-proxy-export.spec.ts
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, MEDIA, ffprobeJson, type LaunchedApp } from '../e2e/helpers';

type W = Window & { __recut: { store: { getState(): any; setState(p: any): void }; actions: any; jobsStore: { getState(): { jobs: any[] } } }; recut: any };

let app: LaunchedApp;
let tmp: string;
let mediaDir: string;
let scratch: string;
let longSrc: string;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-attack-media-'));
  mediaDir = makeTestMedia(tmp, 'short');
  scratch = path.join(tmp, 'scratch'); fs.mkdirSync(scratch);
  longSrc = path.join(scratch, 'long-90s.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=90', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', longSrc]);
  app = await launchApp({ tmp });
  app.page.on('pageerror', (e) => pageErrors.push(e.message));
});
test.afterAll(async () => {
  try { await app.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false })); } catch { /* gone */ }
  await app.app.close().catch(() => undefined);
});

const jobsOf = () => app.page.evaluate(() => (window as unknown as W).__recut.jobsStore.getState().jobs as any[]);
const terminal = (j: any) => j && ['done', 'failed', 'canceled'].includes(j.status);
async function waitJob(id: string, timeout = 120_000) {
  await expect.poll(async () => (await jobsOf()).find((j) => j.id === id)?.status, { timeout }).toMatch(/done|failed|canceled/);
  return (await jobsOf()).find((j) => j.id === id);
}
const media = (id: string) => app.page.evaluate((id) => (window as unknown as W).__recut.store.getState().project.media[id], id);
const startProxy = (id: string) => app.page.evaluate(async (id) => {
  const w = window as unknown as W; const m = w.__recut.store.getState().project.media[id];
  return w.recut.startProxy({ mediaId: id, path: m.path, height: 540 });
}, id);

function exportSettings(out: string, name: string, over: Record<string, unknown> = {}) {
  return { outputDir: out, fileName: name, width: 64, height: 36, videoCodec: 'libx264', qualityMode: 'crf', crf: 30, videoBitrateKbps: 0, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 64, audioChannels: 2, sampleRate: 48000, rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over };
}
/** Start an export of the active sequence through the real IPC (what the dialog does after validation). */
const startExport = (settings: Record<string, unknown>) => app.page.evaluate(async (settings) => {
  const w = window as unknown as W; const s = w.__recut.store.getState(); const seq = s.project.sequences[s.project.activeSequenceId];
  return w.recut.startExport({ sequence: seq, media: s.project.media, settings: { ...settings, fps: seq.fps } });
}, settings);

// ------------------------------------------------------------------ proxies

test('starting the same proxy twice must not run two ffmpeg jobs on the same .part file', async () => {
  const [id] = await importMedia(app.page, [path.join(mediaDir, MEDIA.movie1)]);
  const [j1, j2] = await Promise.all([startProxy(id), startProxy(id)]);
  const a = await waitJob(j1.id); const b = await waitJob(j2.id);
  console.log(`[attack] double proxy start: j1=${a.status} ${a.error ?? ''} | j2=${b.status} ${b.error ?? ''} | same job=${j1.id === j2.id}`);
  expect(a.status === 'done' || b.status === 'done', `both jobs failed: ${a.error} / ${b.error}`).toBe(true);
  const proxyJobs = (await jobsOf()).filter((j) => j.kind === 'proxy' && j.mediaId === id);
  expect(j2.id === j1.id || proxyJobs.length === 1, `two concurrent proxy jobs (${proxyJobs.map((j) => j.status).join(',')}) for one media; both wrote ${a.result?.path}.part`).toBe(true);
  const m = await media(id);
  await expect.poll(async () => (await media(id)).proxy.status, { timeout: 10_000 }).toBe('ready');
  const p = (await media(id)).proxy.path as string;
  expect(fs.existsSync(p)).toBe(true);
  const info = ffprobeJson(p);
  expect(Math.abs(Number(info.format.duration) - 12)).toBeLessThan(0.5);
  void m; void b;
});

test('cancel a running proxy, then start it again: no .part left behind and the retry completes', async () => {
  const [id] = await importMedia(app.page, [longSrc]);
  const j = await startProxy(id);
  await expect.poll(async () => (await jobsOf()).find((x) => x.id === j.id)?.status, { timeout: 30_000 }).toBe('running');
  await app.page.waitForTimeout(500);
  await app.page.evaluate((jid) => (window as unknown as W).recut.cancelJob(jid), j.id);
  const done = await waitJob(j.id);
  expect(done.status).toBe('canceled');
  await expect.poll(async () => (await media(id)).proxy.status, { timeout: 10_000 }).toMatch(/none|failed/);
  const proxiesDir = path.join(app.cacheDir, 'proxies');
  await expect.poll(() => fs.readdirSync(proxiesDir).filter((f) => f.endsWith('.part')), { timeout: 10_000 }).toEqual([]);
  const j2 = await startProxy(id);
  const d2 = await waitJob(j2.id, 180_000);
  expect(d2.status).toBe('done');
});

test('deleting a ready proxy file externally: the app must notice (fall back / mark not ready), not keep serving 404s', async () => {
  const [id] = await importMedia(app.page, [path.join(mediaDir, MEDIA.ep1)]);
  const j = await startProxy(id);
  expect((await waitJob(j.id)).status).toBe('done');
  await expect.poll(async () => (await media(id)).proxy.status, { timeout: 10_000 }).toBe('ready');
  const p = (await media(id)).proxy.path as string;
  fs.rmSync(p);
  // insert and "play" (seek the program monitor) so the player resolves the playback path
  await app.page.evaluate((id) => { const st = (window as unknown as W).__recut.store.getState(); st.insertFromSource(st.project.activeSequenceId, { mediaId: id, in: 0, out: 4, atFrame: 0, mode: 'overwrite' }); st.setView(st.project.activeSequenceId, { playhead: 10 }); st.setPlaying(true); }, id);
  await app.page.waitForTimeout(2500);
  await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().setPlaying(false));
  const status = await app.page.evaluate(async (p) => { const r = await fetch((window as unknown as W).recut.mediaUrl(p)); return r.status; }, p);
  expect(status).toBe(404);
  const m = await media(id);
  expect(m.proxy.status === 'ready' && m.proxy.path === p, 'proxy still marked ready although its file is gone; with useProxies on, playback points at a 404').toBe(false);
});

test('proxy requests for an image and an audio-only file settle (fail with a reason / succeed) and never hang', async () => {
  const [img, aud] = await importMedia(app.page, [path.join(mediaDir, MEDIA.title), path.join(mediaDir, MEDIA.score)]);
  const ji = await startProxy(img); const ja = await startProxy(aud);
  const ri = await waitJob(ji.id); const ra = await waitJob(ja.id);
  expect(ri.status).toBe('failed');
  expect(ri.error).toMatch(/neither video nor audio|image/i);
  expect(ra.status).toBe('done');
  const am = await media(aud);
  await expect.poll(async () => (await media(aud)).proxy.status, { timeout: 10_000 }).toBe('ready');
  void am;
});

// ------------------------------------------------------------------ missing media + export

test('source file deleted while in the timeline: export via IPC fails with an error (no hang); checklist only blocks after verify', async () => {
  const copy = path.join(scratch, 'doomed.mp4');
  fs.copyFileSync(path.join(mediaDir, MEDIA.ep2), copy);
  const [id] = await importMedia(app.page, [copy]);
  await app.page.evaluate((id) => { const st = (window as unknown as W).__recut.store.getState(); const seqId = st.project.activeSequenceId; for (const t of [...st.project.sequences[seqId].videoTracks, ...st.project.sequences[seqId].audioTracks]) for (const c of t.clips) { st.select([c.id]); st.deleteSelected(seqId); } st.insertFromSource(seqId, { mediaId: id, in: 0, out: 3, atFrame: 0, mode: 'overwrite' }); }, id);
  fs.rmSync(copy);
  const res = await startExport(exportSettings(scratch, 'doomed-out.mp4'));
  expect(res.ok, JSON.stringify(res)).toBe(true);
  const job = await waitJob(res.jobId, 60_000);
  expect(job.status).toBe('failed');
  expect(job.error).toMatch(/No such file|not found|does not exist|Invalid/i);
  expect(fs.existsSync(path.join(scratch, 'doomed-out.part.mp4'))).toBe(false);
  // after the explicit check, the media is offline and the UI checklist would block
  const missing: string[] = await app.page.evaluate(() => (window as unknown as W).__recut.actions.verifyMediaOnline());
  expect(missing).toContain(id);
  expect((await media(id)).offline).toBe(true);
});

test('relink to a shorter file: clips that now extend past the media must be flagged', async () => {
  const short = path.join(scratch, 'short-3s.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=640x360:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', short]);
  const copy = path.join(scratch, 'relinkme.mp4');
  fs.copyFileSync(path.join(mediaDir, MEDIA.ep3), copy);
  const [id] = await importMedia(app.page, [copy]);
  await app.page.evaluate((id) => { const st = (window as unknown as W).__recut.store.getState(); const seqId = st.project.activeSequenceId; st.insertFromSource(seqId, { mediaId: id, in: 2, out: 12, atFrame: 500, mode: 'overwrite' }); }, id);
  await app.page.evaluate(async ({ id, short }) => { const w = window as unknown as W; w.__recut.store.getState().relinkMedia(id, short); await w.__recut.actions.probeMedia(id); }, { id, short });
  const m = await media(id);
  expect(m.probe.duration).toBeCloseTo(3, 0);
  const over = await app.page.evaluate((id) => {
    const st = (window as unknown as W).__recut.store.getState(); const seq = st.project.sequences[st.project.activeSequenceId];
    const fps = seq.fps.num / seq.fps.den; const dur = st.project.media[id].probe.duration;
    return [...seq.videoTracks, ...seq.audioTracks].flatMap((t: any) => t.clips).filter((c: any) => c.mediaId === id && c.sourceIn + c.duration / fps * c.speed > dur + 1e-6).map((c: any) => ({ id: c.id, sourceIn: c.sourceIn, duration: c.duration }));
  }, id);
  // Clips referencing 2 s..12 s of a 3 s file: nothing warns, playback freezes and export clones the last frame.
  expect(over.length, 'expected the relink to trim/flag clips exceeding the new media duration').toBe(0);
});

test('two exports started back to back both complete (serialized by the queue)', async () => {
  const r1 = await startExport(exportSettings(scratch, 'two-a.mp4'));
  const r2 = await startExport(exportSettings(scratch, 'two-b.mp4'));
  expect(r1.ok && r2.ok).toBe(true);
  const a = await waitJob(r1.jobId); const b = await waitJob(r2.jobId);
  expect([a.status, b.status], `${a.error ?? ''} ${b.error ?? ''}`).toEqual(['done', 'done']);
  expect(fs.existsSync(path.join(scratch, 'two-a.mp4')) && fs.existsSync(path.join(scratch, 'two-b.mp4'))).toBe(true);
});

test('cancel an export at ~1%: job canceled, no output and no .part', async () => {
  const r = await startExport(exportSettings(scratch, 'cancel-me.mp4', { width: 1920, height: 1080, preset: 'veryslow', crf: 12 }));
  expect(r.ok).toBe(true);
  await expect.poll(async () => (await jobsOf()).find((j) => j.id === r.jobId)?.progress ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  await app.page.evaluate((jid) => (window as unknown as W).recut.cancelExport(jid), r.jobId);
  const j = await waitJob(r.jobId, 30_000);
  expect(j.status).toBe('canceled');
  await app.page.waitForTimeout(500);
  expect(fs.existsSync(path.join(scratch, 'cancel-me.mp4'))).toBe(false);
  expect(fs.existsSync(path.join(scratch, 'cancel-me.part.mp4'))).toBe(false);
});

test('export with a path-traversal file name through IPC lands outside the chosen folder', async () => {
  const r = await startExport(exportSettings(scratch, '../escaped.mp4'));
  expect(r.ok).toBe(true);
  const j = await waitJob(r.jobId);
  expect(j.status).toBe('done');
  expect(path.resolve(r.outputPath).startsWith(scratch + path.sep), `wrote ${r.outputPath}`).toBe(true);
});

test('kill the app mid-proxy: no finished proxy is left behind, relaunch shows status none, .part is cleaned on retry', async () => {
  const [id] = await importMedia(app.page, [longSrc]);
  const projectPath = path.join(tmp, 'kill.recut');
  // make the project reference the long file, save, then start the proxy and kill the process
  await app.page.evaluate(async (p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
  const j = await startProxy(id);
  await expect.poll(async () => (await jobsOf()).find((x) => x.id === j.id)?.status, { timeout: 30_000 }).toBe('running');
  const proxiesDir = path.join(app.cacheDir, 'proxies');
  await expect.poll(() => fs.readdirSync(proxiesDir).some((f) => f.endsWith('.part')), { timeout: 20_000 }).toBe(true);
  await app.page.evaluate(async (p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath); // persist 'running' status
  app.app.process().kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 1500));
  const files = fs.readdirSync(proxiesDir);
  const finals = files.filter((f) => f.endsWith('.mp4') && !f.endsWith('.part'));
  const parts = files.filter((f) => f.endsWith('.part'));
  // earlier tests produced finished proxies for other media; the killed one must only exist as .part
  const key = parts[0]?.replace(/\.part$/, '');
  expect(parts.length).toBeGreaterThan(0);
  expect(finals, `a finished proxy exists for the killed job (${key})`).not.toContain(key);
  // relaunch, open, check normalized status and that a retry succeeds
  app = await launchApp({ tmp });
  const res = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectPath);
  expect(res.ok).toBe(true);
  expect((await media(id)).proxy.status).toBe('none');
  const j2 = await startProxy(id);
  expect((await waitJob(j2.id, 180_000)).status).toBe('done');
  expect(fs.readdirSync(proxiesDir).filter((f) => f.endsWith('.part'))).toEqual([]);
  expect(pageErrors).toEqual([]);
});
