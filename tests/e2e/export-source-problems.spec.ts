/**
 * Export of a damaged source through the Export dialog (bugs/closed/2026-10-09-export-silently-pads-truncated-sources.md @ 59eafc6):
 * real Electron app, real FFmpeg. A downloaded MP4 cut to half its bytes still probes as 10 s (its index is intact),
 * so the pre-export checks see nothing and FFmpeg exits 0 while the export pads the missing part. The export must
 * finish, and the done view and a toast must say that the file ends early.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo } from '../../shared/model';
import { launchApp, importMedia, ffprobeJson, type LaunchedApp } from './helpers';

let ctx: LaunchedApp;
let outDir: string;
let damaged: string;

test.beforeAll(async () => {
  ctx = await launchApp();
  const dir = path.join(ctx.tmp, 'damaged-media');
  outDir = path.join(ctx.tmp, 'export-out');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const full = path.join(dir, 'full.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2', '-shortest', '-movflags', '+faststart', full]);
  const bytes = fs.readFileSync(full);
  damaged = path.join(dir, 'Damaged Download.mp4');
  fs.writeFileSync(damaged, bytes.subarray(0, Math.floor(bytes.length / 2)));
});

test.afterAll(async () => { await ctx?.app.close(); });

test('a truncated source: the export finishes and warns that the file ends early', async () => {
  const { page } = ctx;
  const [id] = await importMedia(page, [damaged]);
  const probed = await page.evaluate((mediaId) => {
    const w = window as unknown as { __recut: { store: { getState(): any } } };
    const st = w.__recut.store.getState();
    const seqId = st.project.activeSequenceId as string;
    st.updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } });
    st.insertFromSource(seqId, { mediaId, in: 1, out: 9, atFrame: 0, mode: 'insert' });
    st.openDialog('export');
    return st.project.media[mediaId].probe.duration as number;
  }, id);
  expect(probed).toBeGreaterThan(9.9); // the cut file probes at full length

  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill('damaged.mp4');
  await page.getByTestId('export-start').click();

  await page.waitForFunction(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.some((j) => j.kind === 'export' && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled'));
  }, undefined, { timeout: 150_000 });
  const job = await page.evaluate(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.find((j) => j.kind === 'export')!;
  });
  expect(job.status, job.error ?? '').toBe('done');
  const result = job.result as { warnings: string[]; sourceWarnings: string[] };
  expect(result.sourceWarnings).toHaveLength(1);
  expect(result.sourceWarnings[0]).toMatch(/^Export finished, but "Damaged Download\.mp4" ends early: its data stops at about [45]\.\d\d s, but the export reads it up to 9\.\d\d s/);
  expect(result.warnings[0]).toBe(result.sourceWarnings[0]);

  // The done view lists it; a warning toast says it too.
  await expect(page.getByTestId('export-done')).toBeVisible();
  const listed = page.getByTestId('export-done-warnings');
  await expect(listed).toContainText('"Damaged Download.mp4" ends early');
  await expect(listed).toContainText('Check the file or relink it.');
  await expect(page.locator('.toast.warn', { hasText: '"Damaged Download.mp4" ends early' })).toBeVisible();

  // The file is still written at full length.
  const out = path.join(outDir, 'damaged.mp4');
  expect(fs.existsSync(out)).toBe(true);
  expect(Math.abs(Number(ffprobeJson(out).format.duration) - 8)).toBeLessThanOrEqual(0.1);
});
