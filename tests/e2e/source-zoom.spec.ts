/**
 * #150: opening a shot or scene in the Source monitor zooms its scrub bar to the shot's In..Out; a button and \ switch
 * to the full file; leaving the range switches to the full file; opening a whole file shows its full length.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, type LaunchedApp } from './helpers';

let launched: LaunchedApp;
let page: Page;
test.beforeAll(async () => { launched = await launchApp(); page = launched.page; });
test.afterAll(async () => { await launched?.app.close(); });

test('a shot opens with the scrub bar zoomed to it; toggle, scrub inside, leave the range', async () => {
  test.setTimeout(120_000);
  const [mediaId] = await importMedia(page, [path.join(makeTestMedia(launched.tmp, 'short'), MEDIA.movie1)]);
  const dur = await getState<number>(page, `(s) => s.project.media['${mediaId}'].probe.duration`);
  await page.evaluate(({ id, d }) => {
    const st = (window as unknown as { __recut: { store: { getState(): { setDetectedScenes(id: string, b: number[], d: number): void } } } }).__recut.store.getState();
    st.setDetectedScenes(id, [d / 4, d / 2], d);
  }, { id: mediaId, d: dur });
  const mediaRow = page.locator(`[data-row-kind="media"][data-media-id="${mediaId}"]`);
  await mediaRow.locator('.pp-chev[aria-expanded="false"]').click(); // shots are listed collapsed under the media
  const shots = page.locator(`[data-row-kind="scene"][data-media-id="${mediaId}"]`);
  await expect(shots).toHaveCount(3);
  const bar = page.locator('.source-scrub');
  const toggle = page.getByTestId('source-view-toggle');

  // Open the second shot: zoomed to it.
  await shots.nth(1).dblclick();
  await expect(bar).toHaveAttribute('data-zoomed', 'scene');
  await expect(toggle).toHaveText('Scene');

  // A click in the middle of the bar lands in the middle of the shot, not of the file.
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => getState<number>(page, '(s) => s.ui.sourceClip.time')).toBeGreaterThan(dur / 4);
  const t = await getState<number>(page, '(s) => s.ui.sourceClip.time');
  expect(Math.abs(t - (3 * dur) / 8)).toBeLessThan(0.5);

  // The button and \ switch between the scene and the full file.
  await toggle.click();
  await expect(bar).toHaveAttribute('data-zoomed', 'full');
  await expect(toggle).toHaveText('Full file');
  await page.locator('.source-panel').focus();
  await page.keyboard.press('Backslash');
  await expect(bar).toHaveAttribute('data-zoomed', 'scene');

  // Going outside the range (End) switches to the full file.
  await page.keyboard.press('End');
  await expect(bar).toHaveAttribute('data-zoomed', 'full');

  // Opening the whole file shows its full length, with no toggle.
  await mediaRow.dblclick();
  await expect(bar).toHaveAttribute('data-zoomed', 'full');
  await expect(toggle).toHaveCount(0);
});
