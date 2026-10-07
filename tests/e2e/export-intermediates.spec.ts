/**
 * Intermediate and audio-only export through the Export dialog (ROADMAP §6): real Electron app, real ffmpeg.
 *  1. MOV / ProRes 422: the format picker sets the extension, the codec and profile pickers drive the command, and the
 *     file is ProRes 422 yuv422p10le with PCM audio and the exact frame count.
 *  2. WAV, one file per audio track: the dialog lists the files, the export writes one WAV per track (A1 and the
 *     renamed A2 "Music"), every file the same length as the sequence.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo } from '../../shared/model';
import { launchApp, makeTestMedia, importMedia, ffprobeJson, MEDIA, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let outDir: string;

test.beforeAll(async () => {
  ctx = await launchApp();
  const mediaDir = makeTestMedia(ctx.tmp, 'short');
  outDir = path.join(ctx.tmp, 'export-out');
  fs.mkdirSync(outDir, { recursive: true });
  const [id] = await importMedia(ctx.page, [path.join(mediaDir, MEDIA.movie1)]);
  // 24 fps sequence, 48 frames: V1 + A1 from source 2–4 s; A2 "Music" from source 6–8 s (audio only).
  await ctx.page.evaluate((mediaId) => {
    const w = window as unknown as { __recut: { store: { getState(): any } } };
    const st = () => w.__recut.store.getState();
    const seqId = st().project.activeSequenceId as string;
    st().updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } });
    st().insertFromSource(seqId, { mediaId, in: 2, out: 4, atFrame: 0, mode: 'insert' });
    const a2 = st().project.sequences[seqId].audioTracks[1].id as string;
    st().setTrackFlags(seqId, a2, { name: 'Music' });
    st().insertFromSource(seqId, { mediaId, in: 6, out: 8, atFrame: 0, mode: 'overwrite', includeVideo: false, audioTrackId: a2 });
  }, id);
});

test.afterAll(async () => { await ctx?.app.close(); });

/** Waits for the n-th export job to settle and returns it. */
async function waitForExport(n: number): Promise<JobInfo> {
  const { page } = ctx;
  await page.waitForFunction((count) => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    const jobs = w.__recut.jobsStore.getState().jobs.filter((j) => j.kind === 'export');
    return jobs.length >= count && jobs.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'canceled');
  }, n, { timeout: 150_000 });
  return page.evaluate((count) => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.filter((j) => j.kind === 'export')[count - 1];
  }, n);
}

test('exports ProRes 422 in MOV from the dialog', async () => {
  const { page } = ctx;
  await page.evaluate(() => (window as unknown as { __recut: { store: { getState(): any } } }).__recut.store.getState().openDialog('export'));
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill('pro.mp4');
  await page.getByTestId('export-format').selectOption('mov');
  await expect(page.getByTestId('export-filename')).toHaveValue('pro.mov');
  await page.getByTestId('export-intermediate-codec').selectOption('prores');
  await page.getByTestId('export-profile').selectOption('standard');
  await page.getByTestId('export-bit-depth').selectOption('24');
  await expect(dialog.locator('.xd-summary')).toContainText('ProRes 422');
  await expect(dialog.locator('.xd-summary')).toContainText('PCM 24-bit');
  await expect(page.getByTestId('export-checklist')).toContainText('Ready to export');

  await page.getByTestId('export-show-command').click();
  await expect(page.getByTestId('export-command')).toContainText('prores_ks');
  await expect(page.getByTestId('export-command')).toContainText('yuv422p10le');
  await expect(page.getByTestId('export-command')).toContainText('pro.mov');

  await page.getByTestId('export-start').click();
  const job = await waitForExport(1);
  expect(job.status, job.error ?? '').toBe('done');
  await expect(page.getByTestId('export-done')).toBeVisible();

  const out = path.join(outDir, 'pro.mov');
  const info = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', out]);
  const streams = JSON.parse(info.toString()).streams as { codec_type: string; codec_name: string; profile?: string; pix_fmt?: string; nb_read_frames?: string; channel_layout?: string }[];
  const v = streams.find((s) => s.codec_type === 'video')!;
  const a = streams.find((s) => s.codec_type === 'audio')!;
  expect([v.codec_name, v.profile, v.pix_fmt, Number(v.nb_read_frames)]).toEqual(['prores', 'Standard', 'yuv422p10le', 48]);
  expect([a.codec_name, a.channel_layout]).toEqual(['pcm_s24le', 'stereo']);
});

test('exports one WAV per audio track from the dialog', async () => {
  const { page } = ctx;
  await page.getByTestId('export-another').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-format').selectOption('wav');
  await expect(page.getByTestId('export-filename')).toHaveValue('pro.wav');
  await expect(page.getByTestId('export-audio-only-note')).toBeVisible();
  await page.getByTestId('export-filename').fill('stems');
  await page.getByTestId('export-audio-files').selectOption('tracks');
  const files = page.getByTestId('export-files');
  await expect(files).toContainText('stems - A1.wav');
  await expect(files).toContainText('stems - A2 Music.wav');
  await expect(page.getByTestId('export-checklist')).toContainText('2 files, one per audio track');
  await expect(page.getByTestId('export-checklist')).toContainText('No file for A3 (no clips in the range).');

  await page.getByTestId('export-start').click();
  const job = await waitForExport(2);
  expect(job.status, job.error ?? '').toBe('done');
  await expect(page.getByTestId('export-done-files')).toContainText('stems - A2 Music.wav');

  const paths = ['stems - A1.wav', 'stems - A2 Music.wav'].map((f) => path.join(outDir, f));
  for (const p of paths) {
    expect(fs.existsSync(p), p).toBe(true);
    const j = ffprobeJson(p) as unknown as { streams: { codec_type: string; codec_name: string; channel_layout: string; duration_ts: number; sample_rate: string }[] };
    expect(j.streams.map((s) => s.codec_type)).toEqual(['audio']);
    expect([j.streams[0].codec_name, j.streams[0].channel_layout, Number(j.streams[0].sample_rate)]).toEqual(['pcm_s24le', 'stereo', 48000]);
    expect(Number(j.streams[0].duration_ts)).toBe(96000); // 2 s at 48 kHz: the sequence, sample for sample
  }
  expect(fs.existsSync(path.join(outDir, 'stems.wav'))).toBe(false);
  await page.keyboard.press('Escape');
});
