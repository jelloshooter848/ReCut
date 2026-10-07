/**
 * OCR Languages dialog end to end: install English from a local mirror (RECUT_OCR_LANG_URL) with visible progress,
 * see it in Preferences, remove it, and a corrupt mirror that must install nothing and show an error.
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, ROOT, type LaunchedApp } from './helpers';

const ENG = fs.readFileSync(path.join(ROOT, 'tests/fixtures/ocr/eng.traineddata'));
const SHOT_DIR = process.env.RECUT_OCR_SHOT_DIR; // optional: where to save screenshots of the dialog

let launched: LaunchedApp;
let page: Page;
let server: http.Server;
let corrupt = false;
let requests = 0;

/** Serves eng.traineddata in 16 slow chunks (so progress is visible); a flipped byte when `corrupt`. */
function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  requests++;
  if (req.url !== '/tessdata/eng.traineddata') { res.writeHead(404); res.end(); return; }
  const body = Buffer.from(ENG);
  if (corrupt) body[body.length >> 1] ^= 0xff;
  res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' });
  const step = Math.ceil(body.length / 16);
  let off = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (off >= body.length) { res.end(); return; }
    res.write(body.subarray(off, off + step));
    off += step;
    setTimeout(tick, 120);
  };
  tick();
}

const row = (code: string) => page.locator(`[data-ocr-lang="${code}"]`);
const engFile = () => path.join(launched.userData, 'ocr', 'tessdata', 'eng.traineddata');

test.beforeAll(async () => {
  server = http.createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  launched = await launchApp({
    tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'recut-e2e-ocr-')),
    env: { RECUT_OCR_LANG_URL: `http://127.0.0.1:${port}/tessdata/` },
  });
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.app.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function openLanguages(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __recut: { runCommand(id: string): boolean } };
    w.__recut.runCommand('app.ocrLanguages');
  });
  await expect(page.locator('[data-testid="ocr-languages-dialog"]')).toBeVisible();
}

test('installs English with progress, shows it in Preferences, and removes it', async () => {
  await openLanguages();
  const dialog = page.locator('[data-testid="ocr-languages-dialog"]');
  await expect(dialog).toContainText('Language data from the Tesseract project (tessdata_fast, Apache-2.0).');
  await expect(row('eng')).toHaveAttribute('data-state', 'available');
  await expect(row('eng')).toContainText('4.1 MB');
  expect(await page.locator('[data-ocr-lang]').count()).toBeGreaterThan(30);

  // Search narrows the list.
  await dialog.getByLabel('Search languages').fill('engl');
  await expect(page.locator('[data-ocr-lang]')).toHaveCount(1);

  await row('eng').getByRole('button', { name: 'Install' }).click();
  await expect(row('eng')).toHaveAttribute('data-state', 'downloading');
  await expect(row('eng').getByRole('progressbar')).toBeVisible();
  await expect(row('eng').getByRole('button', { name: 'Cancel' })).toBeVisible();
  if (SHOT_DIR) await page.locator('.ocrl-dialog').screenshot({ path: path.join(SHOT_DIR, 'ocr-languages-downloading.png') });

  await expect(row('eng')).toHaveAttribute('data-state', 'installed', { timeout: 30_000 });
  await expect(row('eng')).toContainText('Installed');
  await expect(page.locator('.toast', { hasText: 'English OCR language installed' })).toBeVisible();
  expect(fs.statSync(engFile()).size).toBe(ENG.length);
  expect(fs.existsSync(`${engFile()}.part`)).toBe(false);

  // Preferences › Application lists it, and Manage… reopens the dialog.
  await dialog.getByLabel('Search languages').fill('');
  if (SHOT_DIR) await page.locator('.ocrl-dialog').screenshot({ path: path.join(SHOT_DIR, 'ocr-languages.png') });
  await page.locator('.ocrl-dialog').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('[data-testid="ocr-languages-dialog"]')).toBeHidden();
  await page.evaluate(() => {
    const w = window as unknown as { __recut: { runCommand(id: string): boolean } };
    w.__recut.runCommand('app.preferences');
  });
  const prefs = page.locator('[data-testid="preferences-dialog"]');
  await expect(prefs).toContainText('Tesseract (built in)');
  await expect(page.locator('[data-testid="prefs-ocr-languages"]')).toHaveText('English (4.1 MB)');
  if (SHOT_DIR) await page.locator('.dialog', { has: prefs }).screenshot({ path: path.join(SHOT_DIR, 'ocr-preferences.png') });
  await prefs.getByRole('button', { name: 'Manage…' }).click();
  await expect(page.locator('[data-testid="ocr-languages-dialog"]')).toBeVisible();

  await row('eng').getByRole('button', { name: 'Remove' }).click();
  await expect(row('eng')).toHaveAttribute('data-state', 'available');
  expect(fs.existsSync(engFile())).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="ocr-languages-dialog"]')).toBeHidden();
  await expect(page.locator('[data-testid="prefs-ocr-languages"]')).toHaveText('None');
  await page.keyboard.press('Escape');
  await expect(prefs).toBeHidden();
});

test('a corrupt download shows an error and installs nothing', async () => {
  corrupt = true;
  requests = 0;
  await openLanguages();
  await row('eng').getByRole('button', { name: 'Install' }).click();
  await expect(page.locator('.toast.error', { hasText: /Could not install English OCR data: checksum mismatch/ })).toBeVisible({ timeout: 30_000 });
  await expect(row('eng')).toHaveAttribute('data-state', 'available');
  expect(requests).toBe(1);
  const dir = path.dirname(engFile());
  expect(fs.readdirSync(dir)).toEqual([]);
});
