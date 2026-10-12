/**
 * #135: edit a transcript line from the timeline (double-click it in its T lane). The media's own cue changes, so the
 * T lane and the Source monitor's overlay show the new text, and the line still follows its clip.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, type LaunchedApp } from './helpers';

let launched: LaunchedApp;
let page: Page;
test.beforeAll(async () => { launched = await launchApp(); page = launched.page; });
test.afterAll(async () => { await launched?.app.close(); });

test('edit a transcript line on the timeline; the monitor and the T lane follow', async () => {
  test.setTimeout(120_000);
  const [mediaId] = await importMedia(page, [path.join(makeTestMedia(launched.tmp, 'short'), MEDIA.movie1)]);
  await page.evaluate((id) => {
    const st = (window as unknown as { __recut: { store: { getState(): Record<string, (...a: unknown[]) => unknown> & { project: { activeSequenceId: string; media: Record<string, { probe: { audio: { index: number }[] } }> } } } } }).__recut.store.getState();
    const stream = st.project.media[id].probe.audio[0].index;
    st.addMediaSubtitleTrack({ id: 'wh', name: 'English (Whisper)', language: 'en', mediaId: id, origin: 'whisper', streamIndex: stream,
      cues: [{ id: 'c1', start: 1, end: 3, text: 'Jason Bourn', words: [{ start: 1, end: 2, text: 'Jason' }, { start: 2, end: 3, text: 'Bourn' }] }] });
    const seqId = st.project.activeSequenceId;
    st.insertFromSource(seqId, { mediaId: id, in: 0, out: 6, atFrame: 0, mode: 'overwrite' });
    st.setView(seqId, { zoom: 8, scroll: 0, playhead: 0 });
  }, mediaId);

  const lineEl = page.locator('[data-transcript-cue]').first();
  await expect(lineEl).toHaveText('Jason Bourn');
  await lineEl.dblclick();
  const dialog = page.getByTestId('cue-edit-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('cue-edit-note')).toContainText('every timeline that uses this part of it');
  await page.getByTestId('cue-edit-text').fill('Jason Bourne');
  await page.getByTestId('cue-edit-save').click();
  await expect(dialog).toBeHidden();

  // The media's cue changed (word timing kept), the T lane shows it, and so does the Source monitor's overlay.
  const cue = () => getState<{ text: string; words: { text: string }[] }>(page, "(s) => s.project.subtitleTracks.wh.cues[0]");
  await expect.poll(async () => (await cue()).text).toBe('Jason Bourne');
  expect((await cue()).words.map((w) => w.text)).toEqual(['Jason', 'Bourne']);
  expect(await getState<boolean>(page, '(s) => s.project.subtitleTracks.wh.edited')).toBe(true);
  await expect(lineEl).toHaveText('Jason Bourne');
  await page.evaluate((id) => (window as unknown as { __recut: { store: { getState(): { setSourceClip(id: string, t: number): void } } } }).__recut.store.getState().setSourceClip(id, 2.2), mediaId);
  await expect(page.getByTestId('source-subtitle')).toHaveText('Jason Bourne', { timeout: 15_000 });

  // Right-click › Delete Line removes it; Undo brings it back.
  await lineEl.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Delete Line' }).click();
  await expect(page.locator('[data-transcript-cue]')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __recut: { store: { getState(): { undo(): void } } } }).__recut.store.getState().undo());
  await expect(page.locator('[data-transcript-cue]').first()).toHaveText('Jason Bourne');
});
