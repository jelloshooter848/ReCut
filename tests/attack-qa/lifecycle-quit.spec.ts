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
  // A quit prompt the test left unanswered (stubbed to never resolve) keeps the app open by design
  // (QA-01): close() would wait forever, so fall back to killing the process.
  const closed = app.app.close().then(() => 'closed', () => 'closed');
  const timedOut = new Promise((r) => setTimeout(() => r('timeout'), 5000));
  if ((await Promise.race([closed, timedOut])) === 'timeout') {
    try { app.app.process().kill('SIGKILL'); } catch { /* gone */ }
  }
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

async function spawnSecondInstance(args: string[], label: string): Promise<{ exitCode: number | null; forwardedArgv: string | null }> {
  // Hook the main process so we can see exactly what Chromium hands to the 'second-instance' event.
  const argvPromise = app.app.evaluate(({ app: a }) => new Promise<string | null>((r) => {
    const t = setTimeout(() => r(null), 15_000);
    a.once('second-instance', (_e, argv) => { clearTimeout(t); r(JSON.stringify(argv)); });
  }));
  const electronBin = require('electron') as unknown as string;
  const child = spawn(electronBin, [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox', ...args], {
    cwd: ROOT, env: { ...process.env, RECUT_USER_DATA: app.userData, RECUT_CACHE_DIR: app.cacheDir, RECUT_DISABLE_GPU: '1' }, stdio: 'ignore',
  });
  const exitCode = await Promise.race([
    new Promise<number | null>((r) => child.on('exit', (c) => r(c))),
    new Promise<number | null>((r) => setTimeout(() => { child.kill('SIGKILL'); r(-1); }, 15_000)),
  ]);
  const forwardedArgv = await argvPromise;
  console.log(`[attack] ${label}: second instance exit=${exitCode} forwarded argv=${forwardedArgv}`);
  return { exitCode, forwardedArgv };
}

test('second instance launched with "--project <path>" forwards the project to the running instance', async () => {
  const projectPath = path.join(tmp, 'second.recut');
  expect((await app.page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath)).ok).toBe(true);
  await app.page.evaluate(() => { (window as unknown as W).__recut.store.getState().newProject('Scratch'); });
  const r = await spawnSecondInstance(['--project', projectPath], '--project <path>');
  expect(r.exitCode, 'second instance did not exit (single-instance lock)').toBe(0);
  expect(r.forwardedArgv).not.toBeNull();
  // Chromium re-orders argv for 'second-instance' (switches first, positionals last), so projectPathFromArgv()
  // sees "--project --allow-file-access-from-files" and resolves a bogus path; the real .recut is never reached.
  await expect.poll(() => app.page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath), { timeout: 8_000 }).toBe(projectPath);
});

test('second instance launched with a bare .recut path (OS double-click) forwards the project', async () => {
  const projectPath = path.join(tmp, 'bare.recut');
  expect((await app.page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath)).ok).toBe(true);
  await app.page.evaluate(() => { (window as unknown as W).__recut.store.getState().newProject('Scratch'); });
  const r = await spawnSecondInstance([projectPath], 'bare path');
  expect(r.exitCode).toBe(0);
  await expect.poll(() => app.page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath), { timeout: 8_000 }).toBe(projectPath);
});
