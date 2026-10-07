/**
 * Local Whisper end to end, with the bundled engine (resources/whisper, built by scripts/linux/get-whisper.sh) and a
 * generated test model served by a local model server (RECUT_WHISPER_MODEL_URL + RECUT_WHISPER_TEST_MODEL, honoured only
 * by an unpackaged app): File › Transcription Models… installs the model with progress → Transcript › Import ›
 * Transcribe… › Local Whisper… → the Transcribe dialog → the job runs → the media has an "… (Whisper Test (tiny))" track
 * that Transcript search finds. A second run comes from the cache and replaces the track. The test model's "speech" is
 * nonsense; tests/unit/whisper-job.test.ts checks real recognition with the tiny model when it is available.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, importMedia, getState, ROOT, type LaunchedApp } from './helpers';
import { buildTestWhisperModel } from '../helpers/whisperModel';
import crypto from 'node:crypto';

const ENGINE = path.join(ROOT, 'resources', 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
const SHOT_DIR = process.env.RECUT_WHISPER_SHOT_DIR; // optional: where to save screenshots of the dialogs

let launched: LaunchedApp;
let page: Page;
let server: http.Server;
let mediaId = '';
let requests = 0;

interface Track { id: string; name: string; origin: string; streamIndex?: number; language: string; cues: { text: string }[] }
const tracks = () => getState<Track[]>(page, `(s) => Object.values(s.project.subtitleTracks)`);

test.beforeAll(async () => {
  test.skip(!fs.existsSync(ENGINE), 'the speech-to-text engine is not built (scripts/linux/get-whisper.sh)');
  const model = buildTestWhisperModel();
  const sha = crypto.createHash('sha256').update(model).digest('hex');
  // Serves the model in 12 slow chunks, so the download's progress is visible.
  server = http.createServer((req, res) => {
    requests++;
    if (req.url !== '/models/ggml-test-tiny.bin') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': model.length, 'content-type': 'application/octet-stream' });
    const step = Math.ceil(model.length / 12);
    let off = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (off >= model.length) { res.end(); return; }
      res.write(model.subarray(off, off + step));
      off += step;
      setTimeout(tick, 100);
    };
    tick();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-e2e-whisper-'));
  const mediaPath = path.join(tmp, 'Interview.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-metadata:s:a:0', 'language=eng', mediaPath]);
  launched = await launchApp({
    tmp,
    env: { RECUT_WHISPER_MODEL_URL: `http://127.0.0.1:${port}/models/`, RECUT_WHISPER_TEST_MODEL: `${model.length}:${sha}` },
  });
  page = launched.page;
  [mediaId] = await importMedia(page, [mediaPath]);
  await page.evaluate((id) => (window as unknown as { __recut: { store: { getState(): { selectMedia(ids: string[]): void } } } }).__recut.store.getState().selectMedia([id]), mediaId);
});

test.afterAll(async () => {
  await launched?.app.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

const row = (id: string) => page.locator(`[data-whisper-model="${id}"]`);

async function openTranscript(): Promise<void> {
  await page.locator('.zone-tab', { hasText: 'Transcript' }).first().click();
  await expect(page.getByTestId('transcript-panel')).toBeVisible();
}

async function importMenu(labels: string[]): Promise<void> {
  await page.getByTestId('transcript-panel').getByRole('button', { name: 'Import' }).click();
  for (const label of labels.slice(0, -1)) await page.locator('.menu-item', { hasText: label }).first().hover();
  await page.locator('.menu-item', { hasText: labels[labels.length - 1] }).first().click();
}

test('installs a model from Transcription Models with progress', async () => {
  await page.evaluate(() => (window as unknown as { __recut: { runCommand(id: string): boolean } }).__recut.runCommand('app.whisperModels'));
  const dialog = page.getByTestId('whisper-models-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('ReCut downloads a model only when you click Install');
  await expect(row('small')).toHaveAttribute('data-state', 'available');
  await expect(row('small')).toContainText('488 MB');
  await expect(row('large-v3-turbo')).toContainText('1.6 GB');
  await expect(row('test-tiny')).toHaveAttribute('data-state', 'available');
  await expect(page.getByTestId('whisper-disk-usage')).toHaveText('0 installed · 0 MB on disk');

  await row('test-tiny').getByRole('button', { name: 'Install' }).click();
  await expect(row('test-tiny')).toHaveAttribute('data-state', 'downloading');
  if (SHOT_DIR) await page.locator('.wm-dialog').screenshot({ path: path.join(SHOT_DIR, 'whisper-models-downloading.png') });
  await expect(row('test-tiny')).toHaveAttribute('data-state', 'installed', { timeout: 30_000 });
  await expect(page.getByTestId('whisper-disk-usage')).toHaveText('1 installed · 8 MB on disk');
  expect(fs.existsSync(path.join(launched.userData, 'whisper', 'models', 'ggml-test-tiny.bin'))).toBe(true);
  expect(requests).toBe(1);
  if (SHOT_DIR) await page.locator('.wm-dialog').screenshot({ path: path.join(SHOT_DIR, 'whisper-models.png') });
  await page.locator('.wm-dialog').getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
});

test('transcribes the media into a searchable Whisper track', async () => {
  await openTranscript();
  await importMenu(['Transcribe…', 'Local Whisper…']);
  const dialog = page.getByTestId('transcribe-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId(`transcribe-check-${mediaId}`)).toBeChecked();
  await expect(page.getByTestId('transcribe-model')).toHaveValue('test-tiny');
  // The audio stream is tagged English, so English is preselected; translation is off.
  await expect(page.getByTestId('transcribe-language')).toHaveValue('en');
  await expect(page.getByTestId('transcribe-translate')).not.toBeChecked();
  await expect(dialog).toContainText('nothing is uploaded');
  if (SHOT_DIR) await page.locator('.transcribe-dialog').screenshot({ path: path.join(SHOT_DIR, 'transcribe-dialog.png') });
  await page.getByTestId('transcribe-start').click();
  await expect(dialog).toBeHidden();

  await expect.poll(async () => (await tracks()).length, { timeout: 120_000 }).toBe(1);
  const [t] = await tracks();
  expect(t).toMatchObject({ name: 'English (Whisper Test (tiny))', origin: 'whisper', streamIndex: 1, language: 'eng' });
  expect(t.cues.length).toBeGreaterThan(0);
  await expect(page.getByTestId('inspector').getByTestId('media-subtitle')).toContainText('English (Whisper Test (tiny))');

  // Transcript search finds the (nonsense) text.
  const word = t.cues[0].text.trim().split(/\s+/)[0].slice(0, 8);
  await page.getByTestId('transcript-search').fill(word);
  await expect(page.getByTestId('transcript-result-text').first()).toContainText(word);
});

test('a second run comes from the cache and replaces the track', async () => {
  const before = await tracks();
  await openTranscript();
  await importMenu(['Transcribe…', 'Local Whisper…']);
  await page.getByTestId('transcribe-start').click();
  await expect(page.locator('.toast', { hasText: '(from cache)' })).toBeVisible({ timeout: 30_000 });
  const after = await tracks();
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(before[0].id);
  expect(after[0].cues.map((c) => c.text)).toEqual(before[0].cues.map((c) => c.text));
});
