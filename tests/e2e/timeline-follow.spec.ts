/**
 * #140: scrolling the timeline while it plays used to snap back to the playhead on the next frame. Now a scroll while
 * playing pauses auto-follow (the view stays put), and the toolbar's Follow playhead button resumes it.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, type LaunchedApp } from './helpers';

const view = (page: LaunchedApp['page']) => getState<{ playhead: number; scroll: number; zoom: number }>(page,
  '(s) => { const v = s.project.sequences[s.project.activeSequenceId].view; return { playhead: v.playhead, scroll: v.scroll, zoom: v.zoom }; }');
const playing = (page: LaunchedApp['page']) => getState<boolean>(page, '(s) => s.playback.playing');

test.describe('timeline follow during playback', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => { launched = await launchApp(); });
  test.afterAll(async () => { await launched?.app.close(); });

  test('scrolling while playing keeps the view where you put it; Follow playhead brings it back', async () => {
    test.setTimeout(180_000);
    const { app, page, tmp } = launched;
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 900); w.center(); });
    const [mediaId] = await importMedia(page, [path.join(makeTestMedia(tmp, 'short'), MEDIA.movie1)]);
    const ZOOM = 8; // ~1 000 px of tracks show ~125 frames of a 288-frame sequence
    await page.evaluate(({ mediaId, ZOOM }) => {
      const st = (window as unknown as { __recut: { store: { getState(): Record<string, (...a: unknown[]) => unknown> & { project: { activeSequenceId: string } } } } }).__recut.store.getState();
      const seqId = st.project.activeSequenceId;
      for (let i = 0; i < 3; i++) st.insertFromSource(seqId, { mediaId, in: i * 4, out: i * 4 + 4, atFrame: i * 96, mode: 'overwrite' });
      st.setView(seqId, { zoom: ZOOM, scroll: 0, playhead: 0 });
    }, { mediaId, ZOOM });

    await page.click('[data-testid="program-play"]');
    await expect.poll(() => playing(page)).toBe(true);
    await page.waitForTimeout(300);
    await expect(page.locator('[data-follow-playhead]')).toHaveCount(0);

    // Scroll right (a horizontal wheel / trackpad swipe over the tracks) so the playhead leaves the view.
    const r = (await page.locator('.tl-ruler').boundingBox())!;
    await page.mouse.move(r.x + 300, r.y + 120);
    await page.mouse.wheel(1600, 0); // 1 600 px / 8 px per frame = +200 frames
    await expect.poll(async () => (await view(page)).scroll, { timeout: 3_000 }).toBeGreaterThan(150);

    // Playback goes on, and the view stays where it was put (it used to snap back to the playhead at once).
    await page.waitForTimeout(800);
    const held = await view(page);
    expect(await playing(page)).toBe(true);
    expect(held.scroll).toBeGreaterThan(150);
    expect(held.playhead).toBeLessThan(held.scroll);
    await expect(page.locator('[data-follow-playhead]')).toBeVisible();

    // Follow playhead: back to the playhead, which is then followed again.
    await page.click('[data-follow-playhead]');
    const back = await view(page);
    expect(back.scroll).toBeLessThanOrEqual(back.playhead + 2);
    await expect(page.locator('[data-follow-playhead]')).toHaveCount(0);
    await page.waitForTimeout(1500);
    const followed = await view(page);
    expect(followed.playhead).toBeGreaterThanOrEqual(followed.scroll);

    await page.click('[data-testid="program-play"]');
    await expect.poll(() => playing(page)).toBe(false);
  });
});
