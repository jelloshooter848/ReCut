/**
 * Read with OCR end to end: a PGS subtitle stream in an MKV (generated: tests/helpers/bitmapSubs.ts), English not
 * installed. Transcript › Import › Embedded › "Read with OCR…" → the dialog offers to install English from a local
 * mirror (RECUT_OCR_LANG_URL) → Start → the job finishes → the media has an "English (OCR #1)" track that Transcript
 * search finds. A second run reads from the cache and replaces the track instead of adding another.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, importMedia, getState, ROOT, type LaunchedApp } from './helpers';
import { bitmapFixtureUnavailable, makeBitmapSubsFixture } from '../helpers/bitmapSubs';

const SHOT_DIR = process.env.RECUT_OCR_SHOT_DIR; // optional: where to save screenshots of the dialog
const ENG = fs.readFileSync(path.join(ROOT, 'tests/fixtures/ocr/eng.traineddata'));
const LINES = [
  'Where were you last night?',
  'I told you, I was at the station.',
  'Nobody leaves this room until I get an answer.',
  'Keep your voice down, they can hear us.',
];

let launched: LaunchedApp;
let page: Page;
let server: http.Server;
let mediaPath = '';
let mediaId = '';

interface Track { id: string; name: string; origin: string; streamIndex?: number; language: string; cues: { text: string }[] }
const tracks = () => getState<Track[]>(page, `(s) => Object.values(s.project.subtitleTracks)`);

test.beforeAll(async () => {
  const why = bitmapFixtureUnavailable('hdmv_pgs_subtitle');
  test.skip(!!why, why ?? '');
  server = http.createServer((req, res) => {
    if (req.url !== '/tessdata/eng.traineddata') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': ENG.length, 'content-type': 'application/octet-stream' });
    res.end(ENG);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-e2e-ocrjob-'));
  const fx = await makeBitmapSubsFixture(path.join(tmp, 'fixture'), {
    codec: 'hdmv_pgs_subtitle', name: 'Night Shift', events: LINES.map((text, i) => ({ start: 1 + i * 2, end: 2.5 + i * 2, text })),
  });
  // Tag the subtitle stream as English, as a disc rip would be.
  mediaPath = path.join(tmp, 'Night Shift.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', fx.path, '-map', '0', '-c', 'copy', '-metadata:s:s:0', 'language=eng', mediaPath]);
  launched = await launchApp({ tmp, env: { RECUT_OCR_LANG_URL: `http://127.0.0.1:${port}/tessdata/` } });
  page = launched.page;
  [mediaId] = await importMedia(page, [mediaPath]);
  await page.evaluate((id) => (window as unknown as { __recut: { store: { getState(): { selectMedia(ids: string[]): void } } } }).__recut.store.getState().selectMedia([id]), mediaId);
});

test.afterAll(async () => {
  await launched?.app.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

async function openTranscript(): Promise<void> {
  await page.locator('.zone-tab', { hasText: 'Transcript' }).first().click();
  await expect(page.getByTestId('transcript-panel')).toBeVisible();
}

async function importMenu(path: string[]): Promise<void> {
  await page.getByTestId('transcript-panel').getByRole('button', { name: 'Import' }).click();
  for (const label of path.slice(0, -1)) await page.locator('.menu-item', { hasText: label }).first().hover();
  await page.locator('.menu-item', { hasText: path[path.length - 1] }).first().click();
}

test('reads a PGS stream after installing English, and the track is searchable', async () => {
  await openTranscript();
  await importMenu(['Embedded…', '#1 eng (PGS) — Read with OCR…']);

  const dialog = page.getByTestId('ocr-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('ocr-stream-summary')).toContainText('Stream #1 · PGS image subtitles · language tag “eng”');
  await expect(page.getByTestId('ocr-no-languages')).toHaveText('No OCR language installed');
  await expect(page.getByTestId('ocr-start')).toBeDisabled();
  await expect(page.getByTestId('ocr-install-guess')).toContainText('English is not installed.');
  if (SHOT_DIR) await page.locator('.ocr-dialog').screenshot({ path: path.join(SHOT_DIR, 'ocr-dialog-install.png') });

  await page.getByTestId('ocr-install').click();
  await expect(page.getByTestId('ocr-language')).toHaveValue('eng', { timeout: 30_000 });
  await expect(page.getByTestId('ocr-install-guess')).toBeHidden();
  await expect(page.getByTestId('ocr-start')).toBeEnabled();
  if (SHOT_DIR) await page.locator('.ocr-dialog').screenshot({ path: path.join(SHOT_DIR, 'ocr-dialog.png') });
  await page.getByTestId('ocr-start').click();
  await expect(dialog).toBeHidden();

  await expect(page.locator('.toast', { hasText: `${LINES.length} subtitle lines read from #1 (English)` })).toBeVisible({ timeout: 60_000 });
  const t = await tracks();
  expect(t).toHaveLength(1);
  expect(t[0]).toMatchObject({ name: 'English (OCR #1)', origin: 'ocr', streamIndex: 1, language: 'eng' });
  expect(t[0].cues.map((c) => c.text)).toEqual(LINES);

  // Media Inspector lists the track.
  await expect(page.getByTestId('inspector').getByTestId('media-subtitle')).toContainText('English (OCR #1)');

  // Transcript search finds a line.
  await page.getByTestId('transcript-search').fill('voice down');
  await expect(page.getByTestId('transcript-result-text')).toHaveText(['Keep your voice down, they can hear us.']);
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'ocr-result.png') });
});

test('a second run comes from the cache and replaces the track', async () => {
  await openTranscript();
  const before = await tracks();
  await importMenu(['Transcribe…', 'Read bitmap subtitles (OCR)…']);
  await expect(page.getByTestId('ocr-language')).toHaveValue('eng');
  await expect(page.getByTestId('ocr-install-guess')).toBeHidden();
  await page.getByTestId('ocr-start').click();
  await expect(page.locator('.toast', { hasText: `${LINES.length} subtitle lines read from #1 (English) (from cache)` })).toBeVisible({ timeout: 30_000 });
  const after = await tracks();
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(before[0].id);
  expect(after[0].cues.map((c) => c.text)).toEqual(LINES);
});
