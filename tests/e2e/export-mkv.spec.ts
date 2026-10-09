/**
 * MKV packaging export through the Export dialog (ROADMAP §7): real Electron app, real ffmpeg.
 * A 48-frame sequence with A1 (the movie's sound), A2 "Commentary" (other movie audio), two subtitle tracks and two
 * chapter markers. In the dialog: Format MKV, audio preset "Main + commentary", the commentary's language and title,
 * the main track switched to FLAC 5.1, both subtitle tracks (English default, French forced). The file is checked
 * with ffprobe: 2 audio tracks (codecs, channels, languages, titles, default flags, sample-exact lengths), 2 SubRip
 * streams (languages, titles, flags), chapters, and the video frame count.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo } from '../../shared/model';
import { launchApp, makeTestMedia, importMedia, MEDIA, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let outDir: string;

test.beforeAll(async () => {
  ctx = await launchApp();
  const mediaDir = makeTestMedia(ctx.tmp, 'short');
  outDir = path.join(ctx.tmp, 'export-mkv');
  fs.mkdirSync(outDir, { recursive: true });
  const [id] = await importMedia(ctx.page, [path.join(mediaDir, MEDIA.movie1)]);
  // 24 fps, 48 frames: V1 + A1 from source 2–4 s; A2 "Commentary" from source 6–8 s (audio only); subtitles; chapters.
  await ctx.page.evaluate((mediaId) => {
    const w = window as unknown as { __recut: { store: { getState(): any } } };
    const st = () => w.__recut.store.getState();
    const seqId = st().project.activeSequenceId as string;
    st().updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } });
    st().insertFromSource(seqId, { mediaId, in: 2, out: 4, atFrame: 0, mode: 'insert' });
    const a2 = st().project.sequences[seqId].audioTracks[1].id as string;
    st().setTrackFlags(seqId, a2, { name: 'Commentary' });
    st().insertFromSource(seqId, { mediaId, in: 6, out: 8, atFrame: 0, mode: 'overwrite', includeVideo: false, audioTrackId: a2 });
    const en = st().addSequenceSubtitleTrack(seqId, { name: 'English', language: 'eng' });
    st().addManualCue(seqId, en, { start: 12, duration: 12, text: 'Hello' });
    const fr = st().addSequenceSubtitleTrack(seqId, { name: 'Français', language: 'fre' });
    st().addManualCue(seqId, fr, { start: 30, duration: 6, text: 'Bonjour' });
    st().addMarker(seqId, { time: 0, name: 'Start', kind: 'chapter' });
    st().addMarker(seqId, { time: 24, name: 'Middle', kind: 'chapter' });
  }, id);
});

test.afterAll(async () => { await ctx?.app.close(); });

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

function probe(file: string, extra: string[] = []): any {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...extra, '-print_format', 'json', '-show_streams', '-show_chapters', file]).toString());
}

/** Decoded sample frames of audio stream `i`. */
function sampleFrames(file: string, i: number, channels: number): number {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:a:${i}`, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return raw.length / 4 / channels;
}

test('exports an MKV with two audio tracks, two soft subtitle tracks and chapters from the dialog', async () => {
  const { page } = ctx;
  await page.evaluate(() => (window as unknown as { __recut: { store: { getState(): any } } }).__recut.store.getState().openDialog('export'));
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill('package.mp4');
  await page.getByTestId('export-format').selectOption('mkv');
  await expect(page.getByTestId('export-filename')).toHaveValue('package.mkv');
  await expect(page.getByTestId('export-summary-format')).toHaveText('MKV');

  // Audio: the commentary preset (A1 main, A2 commentary), then edit both tracks.
  await page.getByTestId('export-audio-preset').selectOption('commentary');
  await expect(page.getByTestId('export-audio-output-1')).toBeVisible();
  await expect(page.getByTestId('export-audio-title-1')).toHaveValue('Commentary');
  await expect(page.getByTestId('export-audio-source-1-2')).toBeChecked();
  await expect(page.getByTestId('export-audio-source-1-1')).not.toBeChecked();
  await page.getByTestId('export-audio-lang-1').fill('eng');
  await page.getByTestId('export-audio-title-0').fill('Main mix');
  await page.getByTestId('export-audio-lang-0').fill('eng');
  await page.getByTestId('export-audio-layout-0').selectOption('5.1');
  await page.getByTestId('export-audio-codec-0').selectOption('flac');
  await expect(page.getByTestId('export-audio-preset')).toHaveValue('custom');
  await expect(page.getByTestId('export-bit-depth')).toBeVisible();
  await expect(page.getByTestId('export-summary-audio')).toContainText('2 tracks: FLAC 24-bit 5.1, AAC 192 kbps stereo');

  // Add a third track, move it up, then remove it again.
  await page.getByTestId('export-audio-add').click();
  await expect(page.getByTestId('export-audio-output-2')).toBeVisible();
  await page.getByTestId('export-audio-title-2').fill('Spare');
  await page.getByTestId('export-audio-up-2').click();
  await expect(page.getByTestId('export-audio-title-1')).toHaveValue('Spare');
  // A track with no sources blocks the export.
  await page.getByTestId('export-audio-source-1-all').uncheck();
  await expect(page.getByTestId('export-checklist')).toContainText('choose at least one source track');
  await expect(page.getByTestId('export-start')).toBeDisabled();
  await page.getByTestId('export-audio-remove-1').click();
  await expect(page.getByTestId('export-audio-output-2')).toHaveCount(0);
  await expect(page.getByTestId('export-audio-title-1')).toHaveValue('Commentary');

  // Subtitles: both tracks as soft subtitles.
  await page.getByTestId('export-sub-include-1').check();
  await page.getByTestId('export-sub-include-2').check();
  await page.getByTestId('export-sub-default-1').check();
  await page.getByTestId('export-sub-forced-2').check();
  await expect(page.getByTestId('export-summary-subtitles')).toHaveText('2 tracks (soft)');
  await expect(page.getByTestId('export-checklist')).not.toContainText('source track');

  await page.getByTestId('export-show-command').click();
  const cmd = page.getByTestId('export-command');
  await expect(cmd).toContainText('matroska');
  await expect(cmd).toContainText('-c:a:0 flac');
  await expect(cmd).toContainText('title=Commentary');
  await expect(cmd).toContainText('-c:s subrip');

  await page.getByTestId('export-start').click();
  const job = await waitForExport(1);
  expect(job.status, job.error ?? '').toBe('done');
  expect((job.result as { sourceWarnings?: string[] }).sourceWarnings).toEqual([]); // clean sources: nothing from FFmpeg
  await expect(page.getByTestId('export-done')).toBeVisible();

  const out = path.join(outDir, 'package.mkv');
  const j = probe(out);
  expect(j.streams.map((s: any) => s.codec_type)).toEqual(['video', 'audio', 'audio', 'subtitle', 'subtitle']);
  const [, a0, a1, s0, s1] = j.streams;
  expect([a0.codec_name, a0.channels, a0.tags?.language, a0.tags?.title, a0.disposition.default]).toEqual(['flac', 6, 'eng', 'Main mix', 1]);
  expect([a1.codec_name, a1.channels, a1.tags?.language, a1.tags?.title, a1.disposition.default]).toEqual(['aac', 2, 'eng', 'Commentary', 0]);
  expect([s0.codec_name, s0.tags?.language, s0.tags?.title, s0.disposition.default, s0.disposition.forced]).toEqual(['subrip', 'eng', 'English', 1, 0]);
  expect([s1.codec_name, s1.tags?.language, s1.tags?.title, s1.disposition.default, s1.disposition.forced]).toEqual(['subrip', 'fre', 'Français', 0, 1]);
  expect(j.chapters.map((c: any) => [c.tags?.title, Number(c.start_time), Number(c.end_time)])).toEqual([['Start', 0, 1], ['Middle', 1, 2]]);
  const frames = probe(out, ['-count_frames', '-select_streams', 'v:0']).streams[0].nb_read_frames;
  expect(Number(frames)).toBe(48);
  // FLAC is sample exact: 2 s at 48 kHz. AAC is padded to whole 1024-sample frames.
  expect(sampleFrames(out, 0, 6)).toBe(96000);
  expect(Math.abs(sampleFrames(out, 1, 2) - 96000)).toBeLessThanOrEqual(2048);
  await page.keyboard.press('Escape');
});
