/**
 * Update notice end to end, against a local stand-in for GitHub's releases API (RECUT_UPDATE_URL; nothing here
 * touches the network): the first-launch opt-in prompt, the notice after opting in (Release notes opens the
 * release page, Skip this version hides it), Preferences › Check for updates, and Help › Check for Updates… for a
 * newer version, an up-to-date one and a failed check.
 */
import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, type LaunchedApp } from './helpers';

const PAGE = (v: string) => `https://github.com/jelloshooter848/ReCut/releases/tag/v${v}`;

let launched: LaunchedApp;
let page: Page;
let server: http.Server;
let reply: { status: number; body: string } = { status: 200, body: '' };
const requests: { url?: string; method?: string; headers: http.IncomingHttpHeaders }[] = [];

const release = (v: string) => ({ status: 200, body: JSON.stringify({ tag_name: `v${v}`, html_url: PAGE(v), draft: false, prerelease: false, name: `ReCut ${v}` }) });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  reply = release('99.0.0');
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  launched = await launchApp({
    tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'recut-e2e-update-')),
    env: { RECUT_UPDATE_URL: `http://127.0.0.1:${port}/repos/jelloshooter848/ReCut/releases/latest`, RECUT_UPDATE_CHECK: '' },
  });
  page = launched.page;
  // Record what would open in the browser instead of opening it.
  await launched.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = async (url: string) => { g.__opened.push(url); };
  });
});

test.afterAll(async () => {
  await launched?.app.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const opened = () => launched.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
const prefs = () => JSON.parse(fs.readFileSync(path.join(launched.userData, 'prefs.json'), 'utf8')) as Record<string, unknown>;
const current = () => page.evaluate(async () => (await window.recut.updateStatus()).current);
const runCommand = (id: string) => page.evaluate((c) => (window as unknown as { __recut: { runCommand(id: string): boolean } }).__recut.runCommand(c), id);

test('asks before checking, then shows the notice; Release notes and Skip this version work', async () => {
  const prompt = page.locator('[data-testid="update-prompt"]');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Check for new ReCut versions on GitHub once a day?');
  // Nothing is sent before the user says yes (the automatic check would have run 5 s after startup).
  await page.waitForTimeout(6500);
  expect(requests).toHaveLength(0);

  await prompt.getByRole('button', { name: 'Yes' }).click();
  await expect(prompt).toBeHidden();
  const notice = page.locator('[data-testid="update-notice"]');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText('ReCut 99.0.0 is available');
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  expect(requests[0].headers['user-agent']).toBe(`ReCut/${await current()}`);
  expect(requests[0].headers.cookie).toBeUndefined();
  expect(prefs()).toMatchObject({ updateCheck: 'on', updateLastCheckOk: true, updateLatest: { version: '99.0.0', url: PAGE('99.0.0') } });

  await notice.getByRole('button', { name: 'Release notes' }).click();
  await expect.poll(opened).toEqual([PAGE('99.0.0')]);
  // Main opens nothing but the repository's releases pages.
  expect(await page.evaluate(() => window.recut.openReleasePage('https://evil.example/releases'))).toBe(false);
  expect(await opened()).toEqual([PAGE('99.0.0')]);

  await notice.getByRole('button', { name: 'Skip this version' }).click();
  await expect(notice).toBeHidden();
  expect(prefs().updateSkipVersion).toBe('99.0.0');

  // Preferences: the setting and the last check.
  await runCommand('app.preferences');
  const dialog = page.locator('[data-testid="preferences-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('select[data-testid="prefs-update-check"]')).toHaveValue('on');
  await expect(dialog.locator('[data-testid="prefs-update-last"]')).toContainText('Last checked');
  await dialog.locator('select[data-testid="prefs-update-check"]').selectOption('off');
  await expect.poll(() => prefs().updateCheck).toBe('off');
  await page.getByRole('button', { name: 'Done' }).click();
});

test('Help › Check for Updates… reports a new version, up to date, and a failed check', async () => {
  const result = page.locator('[data-testid="update-check-result"]');
  const before = requests.length;

  await runCommand('help.checkForUpdates');
  await expect(result).toContainText('ReCut 99.0.0 is available.');
  expect(requests.length).toBe(before + 1); // runs although the setting is now off
  await expect(page.getByTestId('confirm-button-0')).toHaveText('Release notes');
  await page.getByTestId('confirm-button-2').click(); // Close
  await expect(result).toBeHidden();

  reply = release(await current());
  await runCommand('help.checkForUpdates');
  await expect(result).toContainText('is up to date.');
  await page.getByTestId('confirm-button-0').click(); // OK
  await expect(result).toBeHidden();

  reply = { status: 500, body: 'oops' };
  await runCommand('help.checkForUpdates');
  await expect(result).toContainText("Couldn't check for updates.");
  await expect(result).toContainText('GitHub answered 500');
  await page.getByTestId('confirm-button-1').click(); // Close
  await expect(result).toBeHidden();
  expect(prefs()).toMatchObject({ updateCheck: 'off', updateLastCheckOk: false });
  await expect(page.locator('[data-testid="update-notice"]')).toBeHidden();
});
