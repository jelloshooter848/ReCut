/**
 * Quitting through the real quit path (main before-quit -> ev:beforeQuit -> renderer handleBeforeQuit), with the
 * main-process message box stubbed so a prompt is recorded instead of shown.
 *  - bugs/closed/2026-10-08-job-mirror-marks-saved-project-dirty.md @ 59eafc6: a background job finishing after a clean save
 *    does not make the quit ask "Save changes?".
 *  - bugs/closed/2026-10-08-quit-stuck-after-renderer-dies.md @ 59eafc6: a renderer that dies after it acked the quit request
 *    no longer leaves the app running for ever; a live renderer's prompt is never quit behind.
 */
import { test, expect, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, MEDIA } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = Window & {
  __recut: {
    store: { getState(): any; setState(p: any): void };
    actions: { saveProject(p: string): Promise<any>; startProxy(id: string): Promise<any> };
  };
};

let tmp: string;
let mediaDir: string;
test.beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-quit-'));
  mediaDir = makeTestMedia(tmp, 'short');
});

/** Record every quit prompt in main (globalThis.__prompts); answer it with `answer`, or never when null. */
async function stubQuitPrompt(app: ElectronApplication, answer: number | null): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    type Box = (...args: unknown[]) => Promise<unknown>;
    const g = globalThis as unknown as { __prompts: string[]; __answer?: (n: number) => void };
    g.__prompts = [];
    const d = dialog as unknown as { showMessageBox: Box };
    const prev = d.showMessageBox.bind(dialog) as Box;
    d.showMessageBox = (...args: unknown[]) => {
      const opts = args.find((a) => !!a && typeof a === 'object' && Array.isArray((a as { buttons?: unknown }).buttons)) as { message: string; buttons: string[] } | undefined;
      if (!opts || !opts.buttons.includes("Don't Save")) return prev(...args);
      g.__prompts.push(opts.message);
      if (answer !== null) return Promise.resolve({ response: answer, checkboxChecked: false });
      return new Promise((r) => { g.__answer = (n) => r({ response: n, checkboxChecked: false }); });
    };
  }, answer);
}
const prompts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __prompts: string[] }).__prompts);
/** The app's main process, captured at launch: Playwright's app.process() is unusable once the app has closed. */
const procs = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>();
const proc = (app: ElectronApplication) => { let p = procs.get(app); if (!p) { p = app.process(); procs.set(app, p); } return p; };
const alive = (app: ElectronApplication) => proc(app).exitCode === null && proc(app).signalCode === null;
const exited = (app: ElectronApplication) => new Promise<void>((r) => {
  if (!alive(app)) r(); else proc(app).once('exit', () => r());
});
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<T>((_r, rej) => { t = setTimeout(() => rej(new Error(what)), ms); })]); }
  finally { clearTimeout(t); }
}

test('a proxy job finishing after a clean save: quit asks nothing and exits', async () => {
  const launched = await launchApp({ tmp: fs.mkdtempSync(path.join(tmp, 'mirror-')) });
  const { app, page } = launched;
  proc(app);
  try {
    const [id] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
    await page.evaluate((mid) => {
      const st = (window as unknown as W).__recut.store.getState();
      st.insertFromSource(st.project.activeSequenceId, { mediaId: mid, in: 0, out: 2, atFrame: 0, mode: 'insert' });
    }, id);
    const projectPath = path.join(tmp, 'mirror.recut');
    const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty)).toBe(false);

    // A background job finishes after the save: queued -> running -> ready mirrored into media.proxy.
    await page.evaluate((mid) => (window as unknown as W).__recut.actions.startProxy(mid), id);
    await page.waitForFunction((mid) => (window as unknown as W).__recut.store.getState().project.media[mid].proxy.status === 'ready', id, { timeout: 60_000 });
    const dirty = await page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty);
    const title = await page.title();

    // Quit for real. A prompt would be answered Cancel and keep the app open.
    await stubQuitPrompt(app, 2);
    const gone = exited(app);
    await app.evaluate(({ app: a }) => { a.quit(); }).catch(() => undefined);
    const quit = await within(gone, 15_000, 'timeout').then(() => true, () => false);
    const asked = quit ? [] : await prompts(app);
    expect(asked, 'no Save changes? prompt').toEqual([]);
    expect(quit, 'the app quit').toBe(true);
    expect(dirty, 'not dirty after the proxy job').toBe(false);
    expect(title).not.toContain('*');
  } finally {
    if (alive(app)) await app.close().catch(() => undefined);
  }
});

/** A launched app with an unsaved edit and the quit prompt stubbed to stay open until __answer(n). */
async function dirtyAppWithPromptUp() {
  const launched = await launchApp({ tmp: fs.mkdtempSync(path.join(tmp, 'prompt-')) });
  const { app, page } = launched;
  proc(app);
  await page.evaluate(() => {
    const st = (window as unknown as W).__recut.store.getState();
    st.addMarker(st.project.activeSequenceId, { time: 1, name: 'unsaved' });
  });
  expect(await page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty)).toBe(true);
  await stubQuitPrompt(app, null);
  await app.evaluate(({ app: a }) => { a.quit(); }).catch(() => undefined);
  // The renderer acked (main dropped its fallback) and its Save / Don't Save / Cancel prompt is up.
  await expect.poll(() => prompts(app)).toHaveLength(1);
  return launched;
}

test('the renderer crashes while its quit prompt is up: the app exits', async () => {
  const { app } = await dirtyAppWithPromptUp();
  try {
    const gone = exited(app);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); }).catch(() => undefined);
    await within(gone, 15_000, 'the app did not quit after its renderer crashed');
  } finally {
    if (alive(app)) proc(app).kill('SIGKILL');
  }
});

test('a second quit request while a live renderer shows its prompt does not quit behind it', async () => {
  const { app, page } = await dirtyAppWithPromptUp();
  try {
    await app.evaluate(({ app: a }) => { a.quit(); }).catch(() => undefined);
    await page.waitForTimeout(4000); // past the 3 s fallback of a renderer that never acked
    expect(alive(app)).toBe(true);
    expect(await prompts(app)).toHaveLength(1); // not asked twice
    expect(await page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty)).toBe(true);
    // The user answers Don't Save: the app quits.
    const gone = exited(app);
    await app.evaluate(() => { (globalThis as unknown as { __answer(n: number): void }).__answer(1); }).catch(() => undefined);
    await within(gone, 15_000, "the app did not quit after Don't Save");
  } finally {
    if (alive(app)) proc(app).kill('SIGKILL');
  }
});
