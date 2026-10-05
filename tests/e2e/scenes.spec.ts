/**
 * Scene Library + Continuity panels, end to end against the real Electron app.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, ROOT, type LaunchedApp } from './helpers';
import type { SceneRecord, Marker, Clip, Project } from '../../shared/model';

let launched: LaunchedApp;
let page: Page;
let mediaId: string;

const SHOTS = path.join(ROOT, 'docs/screenshots');

async function showPanel(p: Page, id: string) {
  // Tabs activate on mousedown; make sure the panel is in a zone (focusPanel adds it to its default zone if needed).
  await p.evaluate((panelId) => {
    const w = window as unknown as { __recut: { store: { getState(): { setActivePanel(p: string): void } } } };
    w.__recut.store.getState().setActivePanel(panelId);
  }, id);
  const tab = p.locator(`.zone-tab[data-panel="${id}"]`).first();
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
  await expect(p.locator(`[data-testid="${id}-panel"]`)).toBeVisible();
}

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
  const dir = makeTestMedia(launched.tmp, 'short');
  const [id] = await importMedia(page, [path.join(dir, MEDIA.movie1)]);
  mediaId = id;
  await page.evaluate(() => { localStorage.removeItem('recut.layout.v1'); });
});

test.afterAll(async () => { await launched?.app.close(); });

test('creates a scene record from the Source In/Out range through the name prompt', async () => {
  await showPanel(page, 'scenes');
  await expect(page.locator('[data-testid="scenes-count"]')).toHaveText(/0 scenes/);
  const newBtn = page.locator('[data-testid="scene-new-from-source"]');
  await expect(newBtn).toBeDisabled();

  await page.evaluate((id) => {
    const w = window as unknown as { __recut: { store: { getState(): { setSourceClip(m: string, t: number): void; setSourceIn(s: number): void; setSourceOut(s: number): void } } } };
    const s = w.__recut.store.getState();
    s.setSourceClip(id, 1); s.setSourceIn(1); s.setSourceOut(3);
  }, mediaId);
  await expect(newBtn).toBeEnabled();
  await newBtn.click();

  const input = page.locator('[data-testid="name-prompt-input"]');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(/Scene 1/);
  await input.fill('Cantina');
  await page.locator('[data-testid="name-prompt-confirm"]').click();

  await expect.poll(() => getState<number>(page, '(s) => Object.keys(s.project.scenes).length')).toBe(1);
  const scene = await getState<SceneRecord>(page, '(s) => Object.values(s.project.scenes)[0]');
  expect(scene.name).toBe('Cantina');
  expect(scene.mediaId).toBe(mediaId);
  expect(scene.in).toBeCloseTo(1, 5);
  expect(scene.out).toBeCloseTo(3, 5);
  await expect(page.locator(`[data-scene-id="${scene.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-scene-id="${scene.id}"]`)).toHaveClass(/selected/);
  await expect(page.locator('[data-testid="scenes-count"]')).toHaveText(/1 scene$/);
});

test('edits characters through the TagInput and registers the vocabulary', async () => {
  const editor = page.locator('[data-testid="scene-editor"]');
  await expect(editor).toBeVisible();
  const tagInput = page.locator('[data-testid="scene-characters"] input');
  await tagInput.click();
  await tagInput.fill('Luke');
  await tagInput.press('Enter');

  await expect.poll(() => getState<string[]>(page, '(s) => Object.values(s.project.scenes)[0].characters')).toEqual(['Luke']);
  const chars = await getState<string[]>(page, '(s) => s.project.tags.characters');
  expect(chars).toContain('Luke');
  await expect(page.locator('[data-testid="scene-characters"] .tag', { hasText: 'Luke' })).toBeVisible();

  // Location + rating round-trip
  await page.locator('[data-testid="scene-location"]').fill('Mos Eisley');
  await page.locator('[data-testid="scene-location"]').press('Enter');
  await editor.locator('.scn-stars.editable .scn-star').nth(3).click();
  await expect.poll(() => getState<SceneRecord>(page, '(s) => Object.values(s.project.scenes)[0]')).toMatchObject({ location: 'Mos Eisley', rating: 4 });
  const locs = await getState<string[]>(page, '(s) => s.project.tags.locations');
  expect(locs).toContain('Mos Eisley');
});

test('inserts the scene at the playhead from the context menu, carrying characters and sceneRecordId', async () => {
  const scene = await getState<SceneRecord>(page, '(s) => Object.values(s.project.scenes)[0]');
  await page.locator(`[data-scene-id="${scene.id}"]`).click({ button: 'right' });
  const item = page.locator('.menu .menu-item', { hasText: 'Insert at playhead' });
  await expect(item).toBeVisible();
  await item.click();

  await expect.poll(() => getState<number>(page, '(s) => { const seq = s.project.sequences[s.project.activeSequenceId]; return seq.videoTracks.flatMap(t => t.clips).length; }')).toBe(1);
  const clip = await getState<Clip>(page, '(s) => s.project.sequences[s.project.activeSequenceId].videoTracks.flatMap(t => t.clips)[0]');
  expect(clip.characters).toEqual(['Luke']);
  expect(clip.sceneRecordId).toBe(scene.id);
  expect(clip.originLabel).toBe('library');
  expect(clip.locations).toEqual(['Mos Eisley']);
  expect(clip.sourceIn).toBeCloseTo(1, 5);
  expect(clip.start).toBe(0);
  const vocab = await getState<Project['tags']>(page, '(s) => s.project.tags');
  expect(vocab.characters).toContain('Luke');
});

test('double-click loads the scene into the Source monitor with In/Out', async () => {
  const scene = await getState<SceneRecord>(page, '(s) => Object.values(s.project.scenes)[0]');
  await page.evaluate(() => { (window as unknown as { __recut: { store: { getState(): { setSourceClip(m: string | null): void } } } }).__recut.store.getState().setSourceClip(null); });
  await showPanel(page, 'scenes');
  await page.locator(`[data-scene-id="${scene.id}"]`).dblclick();
  await expect.poll(() => getState<unknown>(page, '(s) => s.ui.sourceClip')).toMatchObject({ mediaId, inPoint: 1, outPoint: 3 });
  expect(await getState<string>(page, '(s) => s.ui.activePanel')).toBe('source');
});

test('filters, grouping and the detected-scenes import helper', async () => {
  await showPanel(page, 'scenes');
  // Detected scenes: seed via the store (scene detection itself is covered elsewhere) and select the media.
  await page.evaluate((id) => {
    const w = window as unknown as { __recut: { store: { getState(): { setDetectedScenes(id: string, b: number[], d: number): void; selectMedia(ids: string[]): void } } } };
    const s = w.__recut.store.getState();
    s.setDetectedScenes(id, [4, 8, 12, 16, 20], 24);
    s.selectMedia([id]);
  }, mediaId);
  const helper = page.locator('[data-testid="scene-import-detected"]');
  await expect(helper).toBeVisible();
  await expect(helper).toContainText('6 detected scenes');
  await helper.locator('button', { hasText: 'Import as records' }).click();
  await expect.poll(() => getState<number>(page, '(s) => Object.keys(s.project.scenes).length')).toBe(7);
  await expect(helper).toBeHidden();
  await expect(page.locator('[data-testid="scenes-count"]')).toHaveText(/7 scenes/);

  // Search narrows to the Cantina record.
  await page.locator('[data-testid="scenes-search"]').fill('luke');
  await expect(page.locator('[data-scene-id]')).toHaveCount(1);
  await expect(page.locator('[data-testid="scenes-count"]')).toHaveText(/1 of 7 scenes/);
  await page.locator('[data-testid="scenes-search"]').fill('');
  await expect(page.locator('[data-scene-id]')).toHaveCount(7);

  // Group by character → "Luke" group with 1 and "No character" with 6.
  await page.locator('select[aria-label="Group by"]').selectOption('character');
  const heads = page.locator('.scn-group-head');
  await expect(heads).toHaveCount(2);
  await expect(heads.nth(0)).toContainText('Luke');
  await expect(heads.nth(0).locator('.badge')).toHaveText('1');
  await expect(heads.nth(1)).toContainText('No character');
  await heads.nth(1).click(); // collapse
  await expect(page.locator('[data-scene-id]')).toHaveCount(1);
  await heads.nth(1).click();
  await page.locator('select[aria-label="Group by"]').selectOption('none');

  // Grid view renders cards.
  await page.locator('button[aria-label="Grid view"]').click();
  await expect(page.locator('.scn-card')).toHaveCount(7);
  await page.locator('button[aria-label="List view"]').click();
  await expect(page.locator('.scn-row')).toHaveCount(7);
});

test('adds a continuity note at the playhead, jumps to it on click and toggles resolved', async () => {
  // Place the playhead and select the inserted clip so the note links to it.
  const clipId = await getState<string>(page, '(s) => s.project.sequences[s.project.activeSequenceId].videoTracks.flatMap(t => t.clips)[0].id');
  await page.evaluate((cid) => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { activeSequenceId: string }; setView(id: string, p: { playhead: number }): void; select(ids: string[]): void } } } };
    const s = w.__recut.store.getState();
    s.setView(s.project.activeSequenceId, { playhead: 24 });
    s.select([cid]);
  }, clipId);

  await showPanel(page, 'continuity');
  await expect(page.locator('[data-testid="continuity-counts"]')).toContainText('0 open');
  await page.locator('[data-testid="continuity-add"]').click();
  await page.locator('[data-testid="continuity-name"]').fill('Jacket zipped');
  await page.locator('[data-testid="continuity-category"]').selectOption('wardrobe');
  await page.locator('[data-testid="continuity-note"]').fill('Zipped in the wide shot, open in the close-up. Check source 00:01:12.');
  await expect(page.locator('[data-testid="continuity-link-clip"]')).toBeChecked();
  await page.locator('[data-testid="continuity-dialog-add"]').click();

  await expect.poll(() => getState<number>(page, '(s) => s.project.sequences[s.project.activeSequenceId].markers.length')).toBe(1);
  const marker = await getState<Marker>(page, '(s) => s.project.sequences[s.project.activeSequenceId].markers[0]');
  expect(marker.kind).toBe('continuity');
  expect(marker.category).toBe('wardrobe');
  expect(marker.time).toBe(24);
  expect(marker.name).toBe('Jacket zipped');
  expect(marker.clipId).toBe(clipId);
  expect(marker.resolved).toBe(false);

  const row = page.locator(`.cty-row[data-marker-id="${marker.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.cty-cat')).toHaveText('wardrobe');
  await expect(row.locator('.cty-clip')).toBeVisible();
  await expect(page.locator('[data-testid="continuity-counts"]')).toContainText('1 open');

  // Click → playhead jumps to the marker, marker + linked clip get selected.
  await page.evaluate(() => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { activeSequenceId: string }; setView(id: string, p: { playhead: number }): void; select(ids: string[]): void; selectMarker(id: string | null): void } } } };
    const s = w.__recut.store.getState();
    s.setView(s.project.activeSequenceId, { playhead: 0 }); s.select([]); s.selectMarker(null);
  });
  expect(await getState<number>(page, '(s) => s.project.sequences[s.project.activeSequenceId].view.playhead')).toBe(0);
  await row.click();
  await expect.poll(() => getState<number>(page, '(s) => s.project.sequences[s.project.activeSequenceId].view.playhead')).toBe(24);
  expect(await getState<string | null>(page, '(s) => s.ui.selectedMarkerId')).toBe(marker.id);
  expect(await getState<string[]>(page, '(s) => s.ui.selectedClipIds')).toEqual([clipId]);

  // Toggle resolved via the checkbox, then back via Space.
  await row.locator('.cty-check').check();
  await expect.poll(() => getState<boolean>(page, '(s) => s.project.sequences[s.project.activeSequenceId].markers[0].resolved')).toBe(true);
  await expect(page.locator('[data-testid="continuity-counts"]')).toContainText('0 open');
  await expect(page.locator('[data-testid="continuity-counts"]')).toContainText('1 resolved');
  await page.locator('[data-testid="continuity-panel"]').focus();
  await page.keyboard.press('Space');
  await expect.poll(() => getState<boolean>(page, '(s) => s.project.sequences[s.project.activeSequenceId].markers[0].resolved')).toBe(false);

  // Inline edit via double-click.
  await row.dblclick();
  const edit = page.locator('[data-testid="continuity-inline-edit"]');
  await expect(edit).toBeVisible();
  await edit.locator('input[aria-label="Issue name"]').fill('Jacket zipped (wide)');
  await edit.locator('select[aria-label="Category"]').selectOption('prop');
  await edit.locator('button', { hasText: 'Save' }).click();
  await expect.poll(() => getState<Marker>(page, '(s) => s.project.sequences[s.project.activeSequenceId].markers[0]')).toMatchObject({ name: 'Jacket zipped (wide)', category: 'prop' });

  // Hide resolved filter hides resolved rows.
  await page.locator('[data-testid="continuity-add"]').click();
  await page.locator('[data-testid="continuity-name"]').fill('Score jumps');
  await page.locator('[data-testid="continuity-category"]').selectOption('music');
  await page.locator('[data-testid="continuity-dialog-add"]').click();
  await expect(page.locator('.cty-row[data-marker-id]')).toHaveCount(2);
  await row.locator('.cty-check').check();
  await page.locator('.cty-panel .toggle').click();
  await expect(page.locator('.cty-row[data-marker-id]')).toHaveCount(1);
  await page.locator('.cty-panel .toggle').click();
  await expect(page.locator('.cty-row[data-marker-id]')).toHaveCount(2);
});

test('screenshots', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await showPanel(page, 'scenes');
  await page.locator('[data-testid="scenes-search"]').fill('');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, 'scenes.png') });
  await showPanel(page, 'continuity');
  await page.locator('.cty-row[data-marker-id]').first().locator('.cty-expand').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'continuity.png') });
});
