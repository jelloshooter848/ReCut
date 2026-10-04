/**
 * App lifecycle attack: the quit confirmation round-trip and opening a project while a modal is open.
 * Each test launches its own app because the P0 case kills it.
 *
 *   xvfb-run -a npx playwright test -c tests/attack-qa/playwright.config.ts tests/attack-qa/lifecycle-quit.spec.ts
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, type LaunchedApp, ROOT } from '../e2e/helpers';

type W = Window & { __recut: { store: { getState(): any; setState(p: any): void }; actions: any }; recut: any };

let app: LaunchedApp;
let tmp: string;


test.beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-attack-quit-'));
  app = await launchApp({ tmp });
});
test.afterEach(async () => {
  try { await app.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false })); } catch { /* gone */ }
  await app.app.close().catch(() => undefined);
});

const makeDirty = () => app.page.evaluate(() => {
  const store = (window as unknown as W).__recut.store;
  const st = store.getState();
  st.addMarker(st.project.activeSequenceId, { time: 3, name: 'unsaved work' });
  return store.getState().dirty;
});

/** Replace the native message box in the main process. `response` null = never answers (user is thinking). */
const stubMessageBox = (response: number | null) => app.app.evaluate(({ dialog }, r) => {
  (dialog as unknown as { showMessageBox: unknown }).showMessageBox = () => (r === null ? new Promise(() => {}) : Promise.resolve({ response: r, checkboxChecked: false }));
}, response);

const alive = async () => {
  try { return app.app.process().exitCode === null && !app.page.isClosed(); } catch { return false; }
};

test('P0: quit with a dirty project while the user has not answered the Save dialog yet must not kill the app after 3 s', async () => {
  expect(await makeDirty()).toBe(true);
  await stubMessageBox(null);
  await app.page.evaluate(() => { void (window as unknown as W).recut.quit(false); });
  await app.page.waitForTimeout(4500).catch(() => undefined);
  expect(await alive(), 'app quit on its own (QUIT_FALLBACK_MS) while the Save/Don\'t Save/Cancel dialog was still open').toBe(true);
});

test('P0: choosing Cancel in the quit prompt must keep the app open (no delayed force-quit)', async () => {
  expect(await makeDirty()).toBe(true);
  await stubMessageBox(2); // Cancel
  await app.page.evaluate(() => { void (window as unknown as W).recut.quit(false); });
  await app.page.waitForTimeout(4500).catch(() => undefined);
  expect(await alive(), 'app quit ~3 s after the user pressed Cancel').toBe(true);
});

test('control: "Don\'t Save" quits promptly', async () => {
  expect(await makeDirty()).toBe(true);
  await stubMessageBox(1);
  await app.page.evaluate(() => { void (window as unknown as W).recut.quit(false); });
  await expect.poll(async () => alive(), { timeout: 10_000 }).toBe(false);
});

test('opening a project while the Export dialog is open: dialog state survives the load (no crash, but stale)', async () => {
  const errors: string[] = [];
  app.page.on('pageerror', (e) => errors.push(e.message));
  const projectPath = path.join(tmp, 'p.recut');
  const saved = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
  expect(saved.ok).toBe(true);
  await app.page.evaluate(() => { (window as unknown as W).__recut.store.getState().openDialog('export'); });
  await app.page.evaluate(() => { (window as unknown as W).__recut.store.getState().newProject('Other'); });
  const res = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectPath);
  expect(res.ok).toBe(true);
  await app.page.waitForTimeout(500);
  const dialogs = await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().ui.dialogs);
  expect(errors).toEqual([]);
  // Desired: modal dialogs are closed when a different project is loaded underneath them.
  expect(dialogs.export, 'export dialog stayed open across a project load').toBe(false);
});

test('second instance with a project path forwards it to the running instance', async () => {
  const projectPath = path.join(tmp, 'second.recut');
  const saved = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
  expect(saved.ok).toBe(true);
  await app.page.evaluate(() => { (window as unknown as W).__recut.store.getState().newProject('Scratch'); });
  const electronBin = require('electron') as unknown as string;
  const childLog = fs.openSync(path.join(tmp, 'second-instance.log'), 'w');
  const child = spawn(electronBin, [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox', '--project', projectPath], {
    cwd: ROOT, env: { ...process.env, RECUT_USER_DATA: app.userData, RECUT_CACHE_DIR: app.cacheDir, RECUT_DISABLE_GPU: '1' }, stdio: ['ignore', childLog, childLog],
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (c) => { fs.closeSync(childLog); r(c); }));
  exited.then(() => console.log('[attack] second instance output:\n' + fs.readFileSync(path.join(tmp, 'second-instance.log'), 'utf8').slice(0, 2000))).catch(() => undefined);
  await expect.poll(() => app.page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath), { timeout: 20_000 }).toBe(projectPath);
  const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('still running'), 10_000))]);
  expect(code, 'second instance did not exit').not.toBe('still running');
  child.kill('SIGKILL');
});
