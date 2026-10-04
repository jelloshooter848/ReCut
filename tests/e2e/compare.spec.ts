/**
 * Compare + Storyline panels e2e: structural diff between a cut and its duplicate, synced playback, story blocks,
 * tag filters and what-if clip disabling.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, ROOT, type LaunchedApp } from './helpers';

interface ClipLite { id: string; kind: string; start: number; sourceIn: number; duration: number; enabled: boolean; characters: string[]; linkId: string | null }
interface SeqLite { id: string; name: string; parentSequenceId?: string; storyBlocks: { id: string; name: string; start: number; end: number }[]; video: ClipLite[]; audio: ClipLite[] }

const SCREENSHOTS = path.join(ROOT, 'docs', 'screenshots');

async function seqLite(page: Page, id: string): Promise<SeqLite> {
  return getState<SeqLite>(page, `(s) => { const q = s.project.sequences[${JSON.stringify(id)}];
    const lite = (c) => ({ id: c.id, kind: c.kind, start: c.start, sourceIn: c.sourceIn, duration: c.duration, enabled: c.enabled, characters: c.characters, linkId: c.linkId });
    return { id: q.id, name: q.name, parentSequenceId: q.parentSequenceId, storyBlocks: q.storyBlocks.map((b) => ({ id: b.id, name: b.name, start: b.start, end: b.end })),
      video: q.videoTracks.flatMap((t) => t.clips.map(lite)), audio: q.audioTracks.flatMap((t) => t.clips.map(lite)) }; }`);
}

async function clickTab(page: Page, panelId: string) {
  const tab = page.locator(`.zone-tab[data-panel="${panelId}"]`).first();
  await expect(tab).toBeVisible();
  await tab.click();
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
});
test.afterAll(async () => { await launched?.app.close(); });

test('compare two cuts, play in sync, build storyline blocks and run what-if filters', async () => {
  const { page, tmp } = launched;
  const mediaDir = makeTestMedia(tmp, 'short');
  const [movieId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
  expect(movieId).toBeTruthy();

  // ---- build the original cut: three 4s ranges, Luke / Han / Luke ----
  const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
  const fps = await getState<{ num: number; den: number }>(page, `(s) => s.project.sequences[${JSON.stringify(seqId)}].fps`);
  const created: string[][] = await page.evaluate(({ seqId, movieId }) => {
    const w = window as unknown as { __recut: { store: { getState(): any } } };
    const st = w.__recut.store.getState();
    const out: string[][] = [];
    let at = 0;
    for (const [inS, outS] of [[0, 4], [4, 8], [8, 12]] as const) {
      const ids: string[] = st.insertFromSource(seqId, { mediaId: movieId, in: inS, out: outS, atFrame: at, mode: 'insert' });
      out.push(ids);
      const seq = w.__recut.store.getState().project.sequences[seqId];
      at = Math.max(...seq.videoTracks.flatMap((t: any) => t.clips.map((c: any) => c.start + c.duration)));
    }
    return out;
  }, { seqId, movieId });
  expect(created).toHaveLength(3);
  await page.evaluate(({ seqId, created }) => {
    const st = (window as any).__recut.store.getState();
    const tag = (ids: string[], characters: string[]) => ids.forEach((id) => st.setClipTags(seqId, id, { characters }));
    tag(created[0], ['Luke']); tag(created[1], ['Han']); tag(created[2], ['Luke']);
  }, { seqId, created });

  let original = await seqLite(page, seqId);
  expect(original.video).toHaveLength(3);
  const middle = original.video.find((c) => c.sourceIn === 4)!;
  expect(middle).toBeTruthy();
  const middleFrames = middle.duration;

  // ---- duplicate and ripple-delete the middle clip (video + linked audio) in the copy ----
  const copyId = await page.evaluate(({ seqId }) => {
    const w = window as any;
    const st = w.__recut.store.getState();
    const id: string = st.duplicateSequence(seqId, 'Alt cut');
    const copy = w.__recut.store.getState().project.sequences[id];
    const all = [...copy.videoTracks, ...copy.audioTracks].flatMap((t: any) => t.clips);
    const mid = all.find((c: any) => c.kind === 'video' && c.sourceIn === 4);
    const ids = all.filter((c: any) => c.id === mid.id || (mid.linkId && c.linkId === mid.linkId)).map((c: any) => c.id);
    st.select(ids);
    w.__recut.store.getState().rippleDeleteSelected(id);
    return id;
  }, { seqId });
  const copy = await seqLite(page, copyId);
  expect(copy.parentSequenceId).toBe(seqId);
  expect(copy.video).toHaveLength(2);

  // ---- Compare panel: switch to the Compare workspace (compare sits in the wide monitor-left zone) ----
  await page.locator('.ws-tab', { hasText: 'Compare' }).click();
  await clickTab(page, 'compare');
  const panel = page.getByTestId('compare-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('compare-select-a').selectOption(seqId);
  await page.getByTestId('compare-select-b').selectOption(copyId);
  await expect(page.getByTestId('compare-select-a')).toHaveValue(seqId);
  await expect(page.getByTestId('compare-select-b')).toHaveValue(copyId);

  // Structural diff: exactly one clip only in A, the other two are same / moved.
  const onlyA = page.locator('[data-testid="diff-row"][data-kind="onlyA"]');
  await expect(onlyA).toHaveCount(1);
  await expect(page.locator('[data-testid="diff-row"][data-kind="onlyB"]')).toHaveCount(0);
  await expect(page.getByTestId('diff-summary')).toContainText('1 only in A');
  const durA = Number(await page.getByTestId('duration-a').getAttribute('data-frames'));
  const durB = Number(await page.getByTestId('duration-b').getAttribute('data-frames'));
  const delta = Number(await page.getByTestId('duration-delta').getAttribute('data-frames'));
  expect(durA - durB).toBe(middleFrames);
  expect(delta).toBe(-middleFrames);
  expect(middleFrames).toBe(Math.round(4 * fps.num / fps.den));

  // Clicking the onlyA row seeks both players to that clip.
  await onlyA.click();
  await expect.poll(async () => Number(await page.getByTestId('compare-tc-a').getAttribute('data-frame'))).toBe(middle.start);

  // ---- synced playback: both playheads advance ----
  await page.getByTestId('compare-start').click();
  await expect.poll(async () => Number(await page.getByTestId('compare-tc-a').getAttribute('data-frame'))).toBe(0);
  await page.getByTestId('compare-play').click();
  await page.waitForTimeout(900);
  const fa = Number(await page.getByTestId('compare-tc-a').getAttribute('data-frame'));
  const fb = Number(await page.getByTestId('compare-tc-b').getAttribute('data-frame'));
  expect(fa).toBeGreaterThan(0);
  expect(fb).toBeGreaterThan(0);
  await page.getByTestId('compare-play').click();
  const paused = Number(await page.getByTestId('compare-tc-a').getAttribute('data-frame'));
  await page.waitForTimeout(300);
  expect(Number(await page.getByTestId('compare-tc-a').getAttribute('data-frame'))).toBe(paused);

  // Lineage list shows the copy under the original.
  await expect(page.locator('[data-testid="cut-row"]')).toHaveCount(2);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'compare.png') });

  // ---- Storyline: block from In/Out on the original ----
  await page.evaluate(({ seqId, outF }) => {
    const st = (window as any).__recut.store.getState();
    st.setActiveSequence(seqId);
    st.setView(seqId, { inPoint: 0, outPoint: outF });
  }, { seqId, outF: middleFrames });
  await clickTab(page, 'storyline');
  const storyline = page.getByTestId('storyline-panel');
  await expect(storyline).toBeVisible();
  await page.getByTestId('block-from-inout').click();
  await page.getByTestId('block-name').fill('Opening');
  await page.getByTestId('block-dialog-submit').click();
  original = await seqLite(page, seqId);
  expect(original.storyBlocks).toHaveLength(1);
  expect(original.storyBlocks[0]).toMatchObject({ name: 'Opening', start: 0, end: middleFrames });
  await expect(page.locator('[data-testid="story-block"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="story-block-row"]')).toHaveCount(1);

  // ---- filters: Solo + Han ----
  await page.getByTestId('filter-mode-solo').click();
  await page.getByTestId('filter-characters-Han').check();
  const filters = await getState<{ characters: string[]; mode: string }>(page, '(s) => s.ui.filters');
  expect(filters.mode).toBe('solo');
  expect(filters.characters).toEqual(['Han']);
  await expect(page.getByTestId('whatif-readout')).toContainText('Runtime if removed');

  // ---- what-if: disable everything that is not Han, then undo ----
  await page.getByTestId('disable-non-matching').click();
  original = await seqLite(page, seqId);
  const all = [...original.video, ...original.audio];
  for (const c of all) expect(c.enabled, `${c.kind} clip sourceIn=${c.sourceIn}`).toBe(c.characters.includes('Han'));
  expect(all.filter((c) => !c.enabled)).toHaveLength(4);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'storyline.png') });

  const undone = await page.evaluate(() => (window as any).__recut.store.getState().undo());
  expect(undone).toBe(true);
  original = await seqLite(page, seqId);
  expect([...original.video, ...original.audio].every((c) => c.enabled)).toBe(true);
  await page.getByTestId('filter-clear').click();
  expect(await getState<string[]>(page, '(s) => s.ui.filters.characters')).toEqual([]);
});
