/**
 * Export dialog + Jobs/Proxies panel e2e: real Electron app, real ffmpeg.
 *  1. Import "Galaxy Saga 1", cut [2,4]s at 0 and [6,8]s at 48 (24 fps), export with the 720p Preview preset,
 *     then verify the file with ffprobe/ffmpeg (duration, size, audio, frame colors red → orange).
 *  2. Pre-export warnings: a 25 fps sequence cut from 24 fps media with a dissolve short of source handles shows
 *     the frame-rate and transition warnings, Export stays enabled, and "Show" selects the transition.
 *  3. Proxies tab: generate missing proxies, wait for 'ready' + file; start and cancel a proxy job.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo, ProxyInfo } from '../../shared/model';
import { launchApp, makeTestMedia, importMedia, getState, ffprobeJson, frameColor, MEDIA, ROOT, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let mediaDir: string;
let outDir: string;
let movie1Id: string;
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

test.beforeAll(async () => {
  ctx = await launchApp();
  mediaDir = makeTestMedia(ctx.tmp, 'short');
  outDir = path.join(ctx.tmp, 'export-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => { await ctx?.app.close(); });

test('exports the active sequence with the 720p Preview preset', async () => {
  const { page } = ctx;
  [movie1Id] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);

  await page.evaluate((id) => {
    const w = window as unknown as { __recut: { store: { getState(): any } } };
    const st = w.__recut.store.getState();
    const seqId = st.project.activeSequenceId as string;
    st.updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } });
    st.insertFromSource(seqId, { mediaId: id, in: 2, out: 4, atFrame: 0, mode: 'insert' });
    st.insertFromSource(seqId, { mediaId: id, in: 6, out: 8, atFrame: 48, mode: 'insert' });
    st.openDialog('export');
  }, movie1Id);

  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  // Sequence summary: 2 video + 2 audio clips, 96 frames
  await expect(dialog.locator('.xd-summary')).toContainText('00:00:04:00');

  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill('out.mp4');
  await page.getByTestId('export-preset').selectOption('720p Preview');
  await expect(dialog.locator('.xd-summary')).toContainText('1280×720');
  await expect(page.getByTestId('export-checklist')).toContainText('Ready to export');

  // FFmpeg command preview works (dry run through the main process).
  await page.getByTestId('export-show-command').click();
  await expect(page.getByTestId('export-command')).toContainText('libx264');
  await expect(page.getByTestId('export-command')).toContainText('out.mp4');

  await page.screenshot({ path: path.join(SHOTS, 'export.png') });

  const start = page.getByTestId('export-start');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByTestId('export-progress')).toBeVisible();

  // Poll the jobs store until the export job settles.
  await page.waitForFunction(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.some((j) => j.kind === 'export' && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled'));
  }, undefined, { timeout: 150_000 });
  const job = await page.evaluate(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.find((j) => j.kind === 'export')!;
  });
  expect(job.status, job.error ?? '').toBe('done');
  await expect(page.getByTestId('export-done')).toBeVisible();
  await expect(page.getByTestId('export-reveal')).toBeVisible();

  const out = path.join(outDir, 'out.mp4');
  expect(fs.existsSync(out)).toBe(true);
  const info = ffprobeJson(out);
  expect(Math.abs(Number(info.format.duration) - 4.0)).toBeLessThanOrEqual(0.1);
  const video = info.streams.find((s) => s.codec_type === 'video')!;
  expect(video.width).toBe(1280);
  expect(video.height).toBe(720);
  expect(video.r_frame_rate).toBe('24/1');
  expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);

  // Source scenes (short mode, 4 s each): red 0–4, orange 4–8 → timeline 0–2 s red, 2–4 s orange.
  const c1 = frameColor(out, 1), c3 = frameColor(out, 3);
  expect(c1.r, JSON.stringify(c1)).toBeGreaterThan(180); expect(c1.g).toBeLessThan(70); expect(c1.b).toBeLessThan(70);
  expect(c3.r, JSON.stringify(c3)).toBeGreaterThan(180); expect(c3.g).toBeGreaterThan(110); expect(c3.g).toBeLessThan(210); expect(c3.b).toBeLessThan(70);

  // Settings persisted for the project; the last export dir went to prefs.
  const prefs = await page.evaluate(() => window.recut.getPrefs());
  expect(prefs.lastExportDir).toBe(outDir);

  // "Export another" returns to the settings view; close the dialog.
  await page.getByTestId('export-another').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
});

test('pre-export warnings: another source frame rate and a short-handle transition warn but do not block', async () => {
  const { page } = ctx;
  const ids = await page.evaluate((mediaId) => {
    const w = window as unknown as { __recut: { store: { getState(): any } } };
    const st = () => w.__recut.store.getState();
    const seqId = st().project.activeSequenceId as string;
    const all = (s: any) => [...s.videoTracks, ...s.audioTracks].flatMap((t: any) => t.clips.map((c: any) => c.id));
    st().select(all(st().project.sequences[seqId]));
    st().deleteSelected(seqId);
    // A 25 fps sequence cut from 24 fps media: A = source 2–4 s at 0, B = source 0.2–2.2 s at 50 (5 frames of
    // source before B, so a 24-frame dissolve renders 10 frames).
    st().updateSequenceSettings(seqId, { fps: { num: 25, den: 1 } });
    st().insertFromSource(seqId, { mediaId, in: 2, out: 4, atFrame: 0, mode: 'insert' });
    st().insertFromSource(seqId, { mediaId, in: 0.2, out: 2.2, atFrame: 50, mode: 'insert' });
    const trackId = st().project.sequences[seqId].videoTracks[0].id;
    const tr = st().addTransitionAtCut(seqId, trackId, 50, 'crossDissolve', 24);
    st().setView(seqId, { playhead: 0 });
    st().openDialog('export');
    return { seqId, transitionId: tr?.id as string };
  }, movie1Id);
  expect(ids.transitionId).toBeTruthy();

  const checklist = page.getByTestId('export-checklist');
  await expect(checklist).toContainText('Source frame rate differs from the sequence (25 fps): Galaxy Saga 1 - A New Dawn.mp4 (24 fps).');
  await expect(checklist).toContainText('Transitions shortened: "Galaxy Saga 1 - A New Dawn.mp4" → "Galaxy Saga 1 - A New Dawn.mp4" (24 → 10 frames, not enough source media past the cut).');
  await expect(checklist.locator('[data-level="warning"]')).toHaveCount(2);
  await expect(checklist.locator('[data-level="error"]')).toHaveCount(0);
  await expect(page.getByTestId('export-start')).toBeEnabled();
  await expect(page.getByTestId('export-preset')).toBeFocused(); // not the first "Show" link

  // "Show" on the transition warning selects it on the timeline and moves the playhead to its cut.
  await checklist.locator('[data-level="warning"]', { hasText: 'Transitions shortened' }).getByTestId('export-check-show').click();
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  const after = await page.evaluate((seqId) => {
    const w = window as unknown as { __recut: { store: { getState(): any } } };
    const st = w.__recut.store.getState();
    return { selected: st.ui.selectedTransitionId as string | null, playhead: st.project.sequences[seqId].view.playhead as number };
  }, ids.seqId);
  expect(after).toEqual({ selected: ids.transitionId, playhead: 50 });
});

test('Jobs panel lists the finished export', async () => {
  const { page } = ctx;
  await page.locator('.zone-tab[data-panel="jobs"]').first().click();
  await expect(page.getByTestId('jobs-panel')).toBeVisible();
  await page.getByTestId('jobs-panel').getByRole('tab', { name: 'Jobs', exact: true }).click();
  const row = page.locator('[data-testid="job-row"][data-kind="export"]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', 'done');
  await expect(row.getByLabel('Reveal in folder')).toBeVisible();
});

test('Proxies tab generates missing proxies', async () => {
  const { page } = ctx;
  await page.getByTestId('jobs-panel').getByRole('tab', { name: 'Proxies' }).click();
  const row = page.locator(`[data-testid="proxy-row"][data-media-id="${movie1Id}"]`);
  await expect(row).toHaveAttribute('data-proxy-status', 'none');
  await page.getByTestId('proxies-generate-missing').click();

  await page.waitForFunction((id) => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { media: Record<string, { proxy: ProxyInfo }> } } } } };
    const p = w.__recut.store.getState().project.media[id].proxy;
    return p.status === 'ready' || p.status === 'failed';
  }, movie1Id, { timeout: 120_000 });
  const proxy = await getState<ProxyInfo>(page, `(s) => s.project.media['${movie1Id}'].proxy`);
  expect(proxy.status, proxy.error ?? '').toBe('ready');
  expect(proxy.path && fs.existsSync(proxy.path)).toBe(true);
  expect(proxy.path!.startsWith(ctx.cacheDir)).toBe(true);
  expect(proxy.height).toBe(360); // source is 640x360; proxies never upscale
  await expect(row).toHaveAttribute('data-proxy-status', 'ready');
  await expect(row.getByLabel('Reveal proxy file')).toBeVisible();

  // Jobs tab shows the proxy job as done; back to Proxies for the screenshot.
  await page.getByTestId('jobs-panel').getByRole('tab', { name: 'Jobs', exact: true }).click();
  await expect(page.locator('[data-testid="job-row"][data-kind="proxy"][data-status="done"]')).toHaveCount(1);
  await page.getByTestId('jobs-panel').getByRole('tab', { name: 'Proxies' }).click();
  await page.screenshot({ path: path.join(SHOTS, 'jobs.png') });
});

test('a proxy job can be canceled from its row', async () => {
  const { page } = ctx;
  const [id2] = await importMedia(page, [path.join(mediaDir, MEDIA.movie2ac3)]);
  const row = page.locator(`[data-testid="proxy-row"][data-media-id="${id2}"]`);
  await expect(row).toBeVisible();
  // Undecodable media (AC-3) now gets a proxy automatically on import; start one only if it didn't.
  const cancel = row.getByTestId('proxy-cancel');
  if (!(await cancel.isVisible().catch(() => false))) await row.getByTestId('proxy-generate').click();
  await cancel.click();

  await page.waitForFunction((id) => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { media: Record<string, { proxy: ProxyInfo }> } } }; jobsStore: { getState(): { jobs: JobInfo[] } } } };
    const p = w.__recut.store.getState().project.media[id].proxy;
    const active = w.__recut.jobsStore.getState().jobs.some((j) => j.kind === 'proxy' && j.mediaId === id && (j.status === 'queued' || j.status === 'running'));
    return !active && p.status !== 'queued' && p.status !== 'running';
  }, id2, { timeout: 60_000 });
  const proxy = await getState<ProxyInfo>(page, `(s) => s.project.media['${id2}'].proxy`);
  expect(proxy.status).not.toBe('ready');
  expect(proxy.status).toBe('none');
  const canceled = await page.evaluate((id) => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.find((j) => j.kind === 'proxy' && j.mediaId === id)?.status;
  }, id2);
  expect(canceled).toBe('canceled');
  // Clear finished removes the done/canceled jobs from the list.
  await page.getByTestId('jobs-panel').getByRole('tab', { name: 'Jobs', exact: true }).click();
  await page.getByTestId('jobs-clear').click();
  await expect(page.locator('[data-testid="job-row"]')).toHaveCount(0);
});
