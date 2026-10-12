/**
 * #162: choose a subtitle file as a video's transcript in the Media Inspector; the T lane switches to its lines.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, type LaunchedApp } from './helpers';

let launched: LaunchedApp;
let page: Page;
test.beforeAll(async () => { launched = await launchApp(); page = launched.page; });
test.afterAll(async () => { await launched?.app.close(); });

test('Media Inspector › Transcript: a subtitle track becomes the transcript', async () => {
  test.setTimeout(120_000);
  const [mediaId] = await importMedia(page, [path.join(makeTestMedia(launched.tmp, 'short'), MEDIA.movie1)]);
  await page.evaluate((id) => {
    const st = (window as unknown as { __recut: { store: { getState(): Record<string, (...a: unknown[]) => unknown> & { project: { activeSequenceId: string; media: Record<string, { probe: { audio: { index: number }[] } }> } } } } }).__recut.store.getState();
    const stream = st.project.media[id].probe.audio[0].index;
    st.addMediaSubtitleTrack({ id: 'wh', name: 'English (Whisper)', language: 'en', mediaId: id, origin: 'whisper', streamIndex: stream, cues: [{ id: 'w1', start: 1, end: 3, text: 'from whisper' }] });
    st.addMediaSubtitleTrack({ id: 'srt', name: 'English', language: 'en', mediaId: id, origin: 'srt', cues: [{ id: 's1', start: 1, end: 3, text: '<i>from the subtitle file</i>' }] });
    const seqId = st.project.activeSequenceId;
    st.insertFromSource(seqId, { mediaId: id, in: 0, out: 6, atFrame: 0, mode: 'overwrite' });
    st.setView(seqId, { zoom: 8, scroll: 0, playhead: 0 });
    st.selectMedia([id], 'set');
  }, mediaId);
  const line = page.locator('[data-transcript-cue]').first();
  await expect(line).toHaveText('from whisper');

  const select = page.getByTestId('transcript-source');
  await expect(select).toBeVisible();
  await select.selectOption('srt');
  await expect(line).toHaveText('from the subtitle file'); // markup removed
  expect(await getState<string>(page, `(s) => s.project.media['${mediaId}'].transcriptTrackId`)).toBe('srt');

  await select.selectOption('');
  await expect(line).toHaveText('from whisper');
});
