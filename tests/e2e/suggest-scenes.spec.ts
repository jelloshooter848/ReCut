/**
 * #147: Suggest Scenes on a clip with known scenes: red, red, blue, blue, green (five 2 s shots, three places). The
 * suggestions group them 2 + 2 + 1; accepting creates three scenes covering those ranges.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchApp, importMedia, getState, type LaunchedApp } from './helpers';

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => { launched = await launchApp(); page = launched.page; });
test.afterAll(async () => { await launched?.app.close(); });

test('suggests scenes from the shots and creates the accepted ones', async () => {
  test.setTimeout(120_000);
  const file = path.join(launched.tmp, 'places.mp4');
  const colors = ['0xC82020', '0xB42A26', '0x2028C8', '0x2A34B4', '0x28BE32'];
  const inputs = colors.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=24:d=2`]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${colors.map((_, i) => `[${i}:v]`).join('')}concat=n=${colors.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  const [mediaId] = await importMedia(page, [file]);
  await page.evaluate((id) => {
    const st = (window as unknown as { __recut: { store: { getState(): { setDetectedScenes(id: string, b: number[], d: number): void } } } }).__recut.store.getState();
    st.setDetectedScenes(id, [2, 4, 6, 8], 10);
  }, mediaId);

  const row = page.locator(`[data-row-kind="media"][data-media-id="${mediaId}"]`);
  await row.click();
  await row.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Suggest Scenes' }).click();
  await expect(page.getByTestId('suggest-list')).toBeVisible({ timeout: 60_000 });
  const rows = page.getByTestId('suggest-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByTestId('suggest-shots')).toHaveText('2 shots');
  await expect(rows.nth(1).getByTestId('suggest-shots')).toHaveText('2 shots');
  await expect(rows.nth(2).getByTestId('suggest-shots')).toHaveText('1 shot');

  await page.getByTestId('suggest-create').click();
  const scenes = await getState<{ in: number; out: number }[]>(page, '(s) => Object.values(s.project.scenes).map((x) => ({ in: x.in, out: x.out })).sort((a, b) => a.in - b.in)');
  expect(scenes).toEqual([{ in: 0, out: 4 }, { in: 4, out: 8 }, { in: 8, out: 10 }]);
  // One undo step removes them all.
  await page.evaluate(() => (window as unknown as { __recut: { store: { getState(): { undo(): void } } } }).__recut.store.getState().undo());
  expect(await getState<number>(page, '(s) => Object.keys(s.project.scenes).length')).toBe(0);
});
