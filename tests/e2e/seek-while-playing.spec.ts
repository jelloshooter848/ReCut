/**
 * #139: clicking the timeline ruler while the sequence plays moves the playhead there and playback continues from
 * that point (it used to be ignored: the player wrote its own frame back over the click).
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, type LaunchedApp } from './helpers';

const playhead = (page: LaunchedApp['page']) => getState<number>(page, '(s) => s.project.sequences[s.project.activeSequenceId].view.playhead');
const playing = (page: LaunchedApp['page']) => getState<boolean>(page, '(s) => s.playback.playing');

test.describe('seek while playing', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => { launched = await launchApp(); });
  test.afterAll(async () => { await launched?.app.close(); });

  test('a click on the ruler while playing jumps there and keeps playing', async () => {
    test.setTimeout(180_000);
    const { app, page, tmp } = launched;
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 900); w.center(); });
    const [mediaId] = await importMedia(page, [path.join(makeTestMedia(tmp, 'short'), MEDIA.movie1)]);
    const ZOOM = 2;
    await page.evaluate(({ mediaId, ZOOM }) => {
      const st = (window as unknown as { __recut: { store: { getState(): Record<string, (...a: unknown[]) => unknown> & { project: { activeSequenceId: string } } } } }).__recut.store.getState();
      const seqId = st.project.activeSequenceId;
      for (let i = 0; i < 3; i++) st.insertFromSource(seqId, { mediaId, in: i * 4, out: i * 4 + 4, atFrame: i * 96, mode: 'overwrite' });
      st.setView(seqId, { zoom: ZOOM, scroll: 0, playhead: 0 });
    }, { mediaId, ZOOM });

    await page.click('[data-testid="program-play"]');
    await expect.poll(() => playing(page)).toBe(true);
    await page.waitForTimeout(400);
    expect(await playhead(page)).toBeLessThan(60);

    // Click frame 200 on the ruler while playing.
    const r = (await page.locator('.tl-ruler').boundingBox())!;
    const target = 200;
    await page.mouse.click(r.x + target * ZOOM, r.y + 10);

    // The playhead jumps there (not back to where the player was), and playback goes on from it.
    await expect.poll(() => playhead(page), { timeout: 5_000, intervals: [50] }).toBeGreaterThanOrEqual(target);
    const after = await playhead(page);
    expect(after).toBeLessThan(target + 30);
    expect(await playing(page)).toBe(true);
    await page.waitForTimeout(600);
    const later = await playhead(page);
    expect(later).toBeGreaterThan(after);
    expect(await playing(page)).toBe(true);

    await page.click('[data-testid="program-play"]');
    await expect.poll(() => playing(page)).toBe(false);
  });
});
