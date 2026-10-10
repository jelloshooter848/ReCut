/**
 * #146: scenes → sequence → timeline. Select scenes in the Scenes tab, Make Sequence, find it in the Sequences tab,
 * edit it, and make a timeline from it.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, type LaunchedApp } from './helpers';

let launched: LaunchedApp;
let page: Page;

async function showPanel(p: Page, id: string) {
  await p.evaluate((panelId) => {
    const w = window as unknown as { __recut: { store: { getState(): { setActivePanel(p: string): void } } } };
    w.__recut.store.getState().setActivePanel(panelId);
  }, id);
  const tab = p.locator(`.zone-tab[data-panel="${id}"]`).first();
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
  await expect(p.locator(`[data-testid="${id}-panel"]`)).toBeVisible();
}

test.beforeAll(async () => { launched = await launchApp(); page = launched.page; });
test.afterAll(async () => { await launched?.app.close(); });

test('make a sequence from scenes, edit it in the Sequences tab, and make a timeline from it', async () => {
  test.setTimeout(120_000);
  const [mediaId] = await importMedia(page, [path.join(makeTestMedia(launched.tmp, 'short'), MEDIA.movie1)]);
  // Three library scenes (their in points tell them apart on the timeline).
  await page.evaluate((mediaId) => {
    const st = (window as unknown as { __recut: { store: { getState(): { addScene(r: unknown): void } } } }).__recut.store.getState();
    const mk = (id: string, a: number) => ({ id, name: `Scene ${id}`, mediaId, in: a, out: a + 1, characters: [], location: '', arc: '', tags: [], notes: '', rating: 0, color: '#4d7cfe', createdAt: 0 });
    for (const [id, a] of [['s1', 1], ['s2', 3], ['s3', 5]] as const) st.addScene(mk(id, a));
  }, mediaId);

  // Scenes tab: select all three, right-click, Make Sequence.
  await showPanel(page, 'scenes');
  const rows = page.locator('[data-testid="scenes-panel"] [data-scene-id]');
  await expect(rows).toHaveCount(3);
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await rows.nth(1).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Make Sequence from 3 Scenes' }).click();
  await expect(page.getByTestId('name-prompt-input')).toHaveValue('Sequence 01');
  await page.getByTestId('name-prompt-input').fill('Act One');
  await page.getByTestId('name-prompt-confirm').click();
  const seqs = () => getState<{ name: string; sceneIds: string[] }[]>(page, '(s) => Object.values(s.project.sceneSequences)');
  await expect.poll(seqs).toEqual([expect.objectContaining({ name: 'Act One', sceneIds: ['s1', 's2', 's3'] })]);

  // Sequences tab: listed with its scene count; expand, move the last scene up, remove the first.
  await showPanel(page, 'sequences');
  const row = page.getByTestId('sequence-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('sequence-name')).toHaveText('Act One');
  await expect(row.getByTestId('sequence-meta')).toContainText('3 scenes');
  await row.dblclick();
  const sceneRows = page.getByTestId('sequence-scene-row');
  await expect(sceneRows).toHaveCount(3);
  await sceneRows.nth(2).locator('button[title="Move up"]').click();
  await expect.poll(async () => (await seqs())[0].sceneIds).toEqual(['s1', 's3', 's2']);
  await sceneRows.nth(0).getByTestId('sequence-scene-remove').click();
  await expect.poll(async () => (await seqs())[0].sceneIds).toEqual(['s3', 's2']);
  await expect(row.getByTestId('sequence-meta')).toContainText('2 scenes');

  // New Timeline from Sequence: a timeline named after it, the scenes in sequence order from frame 0.
  await row.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'New Timeline from Sequence' }).click();
  await expect.poll(() => getState<string>(page, '(s) => s.project.sequences[s.project.activeSequenceId].name')).toBe('Act One');
  const ins = await getState<number[]>(page, '(s) => { const q = s.project.sequences[s.project.activeSequenceId]; return q.videoTracks.flatMap((t) => t.clips).sort((a, b) => a.start - b.start).map((c) => c.sourceIn); }');
  expect(ins).toEqual([5, 3]);

  // Deleting the sequence keeps the scenes.
  await row.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Delete Sequence' }).click();
  await expect(page.getByTestId('sequence-row')).toHaveCount(0);
  expect(await getState<number>(page, '(s) => Object.keys(s.project.scenes).length')).toBe(3);
});
