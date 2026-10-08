/**
 * Test teardown: the helpers' close() quits the app whatever the project's state when the quit request is handled
 * (bugs/closed/2026-10-08-e2e-close-hangs-on-quit-prompt.md).
 */
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

type W = Window & {
  recut: { onBeforeQuit(cb: () => void): () => void };
  __recut: { store: { setState(p: object): void } };
};

test('close() quits when a background job marks the project dirty while the quit request is handled', async () => {
  const { app, page } = await launchApp();
  // A job mirror landing while the renderer handles the quit request, as a proxy job finishing does (jobsRouter →
  // store.setProxy, a quiet change that marks the project dirty). Registered after the app's own before-quit handler,
  // this listener runs while that handler awaits quitAck (which drops main's 3 s fallback), so the handler then finds
  // the project dirty and asks Save / Don't Save / Cancel: nobody answers that box in a test.
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.recut.onBeforeQuit(() => w.__recut.store.setState({ dirty: true }));
  });
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    app.close().then(() => true),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), 30_000); }),
  ]);
  clearTimeout(timer);
  if (!closed) app.process().kill('SIGKILL'); // do not leave the hung app to the worker teardown
  expect(closed, 'close() returned within 30 s').toBe(true);
});
