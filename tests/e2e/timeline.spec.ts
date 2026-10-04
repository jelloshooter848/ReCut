/**
 * Timeline panel e2e: drives the real UI with the mouse/keyboard and asserts frame-exact results against the store.
 *
 *   npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/timeline.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, MEDIA, ROOT, type LaunchedApp } from './helpers';

interface ClipLite { id: string; start: number; duration: number; sourceIn: number; linkId: string | null }
interface TrackLite { id: string; name: string; clips: ClipLite[]; transitions: { id: string; type: string; duration: number }[] }
interface SeqLite { id: string; fps: { num: number; den: number }; videoTracks: TrackLite[]; audioTracks: TrackLite[]; view: { playhead: number; zoom: number; scroll: number } }

const seqState = (page: Page) => page.evaluate((): SeqLite => {
  const s = (window as unknown as { __recut: { store: { getState(): { project: { activeSequenceId: string; sequences: Record<string, SeqLite> } } } } }).__recut.store.getState();
  const q = s.project.sequences[s.project.activeSequenceId];
  return JSON.parse(JSON.stringify({ id: q.id, fps: q.fps, videoTracks: q.videoTracks, audioTracks: q.audioTracks, view: q.view }));
});
const uiState = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __recut: { store: { getState(): { ui: { selectedClipIds: string[]; selectedTransitionId: string | null; tool: string } } } } }).__recut.store.getState();
  return JSON.parse(JSON.stringify(s.ui)) as { selectedClipIds: string[]; selectedTransitionId: string | null; tool: string };
});

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { steps?: number; modifiers?: string[] } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(to.x - from.x) * 4, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 10 });
  await page.mouse.up();
}

test.describe('timeline panel', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => { launched = await launchApp(); });
  test.afterAll(async () => { await launched?.app.close(); });

  test('edits clips with the real mouse and keyboard', async () => {
    test.setTimeout(240_000);
    const { app, page, tmp } = launched;
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 900); w.center(); });
    const mediaDir = makeTestMedia(tmp, 'short');
    const [mediaId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);

    // Make the timeline big and deterministic: maximize its zone, zoom 2 px/frame, snapping off.
    await page.evaluate(() => {
      document.querySelector('[data-zone="center-bottom"] .zone-tab[data-panel="timeline"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await page.evaluate((mediaId) => {
      const st = (window as unknown as { __recut: { store: { getState(): Record<string, (...a: unknown[]) => unknown> & { project: { activeSequenceId: string } } } } }).__recut.store.getState();
      const seqId = st.project.activeSequenceId;
      st.setSettings({ snapping: false });
      for (let i = 0; i < 3; i++) st.insertFromSource(seqId, { mediaId, in: i * 4, out: i * 4 + 4, atFrame: i * 96, mode: 'overwrite' });
      st.setView(seqId, { zoom: 2, scroll: 0, playhead: 0 });
    }, mediaId);

    const ZOOM = 2;
    let seq = await seqState(page);
    expect(seq.videoTracks[0].clips).toHaveLength(3);
    expect(seq.audioTracks[0].clips).toHaveLength(3);
    expect(seq.videoTracks[0].clips.map((c) => [c.start, c.duration])).toEqual([[0, 96], [96, 96], [192, 96]]);
    await expect(page.locator('[data-clip-id]')).toHaveCount(6);

    const clipBox = async (id: string) => { const b = await page.locator(`[data-clip-id="${id}"]`).boundingBox(); expect(b, `clip ${id} visible`).not.toBeNull(); return b!; };
    const v1 = () => seq.videoTracks[0];

    await test.step('click selects the clip and its linked audio', async () => {
      const c = v1().clips[0];
      const b = await clipBox(c.id);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      const ui = await uiState(page);
      expect(ui.selectedClipIds).toContain(c.id);
      expect(ui.selectedClipIds).toHaveLength(2); // linked selection on by default
      await expect(page.locator(`[data-clip-id="${c.id}"]`)).toHaveClass(/selected/);
    });

    await test.step('screenshot', async () => {
      // give thumbnails/waveforms a moment to arrive (best effort — never fail the test on them)
      await page.waitForFunction(() => document.querySelectorAll('.tl-thumb').length > 0, null, { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      const out = path.join(ROOT, 'docs/screenshots/timeline.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out });
    });

    await test.step('razor tool splits the clip under the pointer', async () => {
      await page.locator('[data-tool="razor"]').click();
      expect((await uiState(page)).tool).toBe('razor');
      const c = v1().clips[1];
      const b = await clipBox(c.id);
      const x = b.x + b.width / 2;
      await page.mouse.click(x, b.y + b.height / 2);
      seq = await seqState(page);
      expect(v1().clips).toHaveLength(4);
      // the cut lands exactly on the frame under the pointer
      const trackBox = (await page.locator('.tl-ruler').boundingBox())!;
      const expectedCut = Math.round(seq.view.scroll + (x - trackBox.x) / ZOOM);
      expect(v1().clips[2].start).toBe(expectedCut);
      expect(v1().clips[1].start + v1().clips[1].duration).toBe(expectedCut);
      expect(seq.audioTracks[0].clips).toHaveLength(4); // linked audio split too
      await page.locator('[data-tool="select"]').click();
    });

    await test.step('dragging on the ruler scrubs the playhead', async () => {
      const r = (await page.locator('.tl-ruler').boundingBox())!;
      const before = seq.view.playhead;
      await drag(page, { x: r.x + 40, y: r.y + 10 }, { x: r.x + 100, y: r.y + 10 });
      seq = await seqState(page);
      expect(seq.view.playhead).not.toBe(before);
      expect(seq.view.playhead).toBe(Math.round(seq.view.scroll + 100 / ZOOM));
      await expect(page.locator('[data-playhead]')).toBeVisible();
    });

    await test.step('selection tool trims the right edge frame-exactly', async () => {
      const c = v1().clips[3];
      const b = await clipBox(c.id);
      const dx = 40; // px → 20 frames at 2 px/frame
      await drag(page, { x: b.x + b.width - 2, y: b.y + b.height / 2 }, { x: b.x + b.width - 2 - dx, y: b.y + b.height / 2 });
      seq = await seqState(page);
      const after = v1().clips.find((x) => x.id === c.id)!;
      expect(after.start).toBe(c.start);
      expect(after.duration).toBe(c.duration - dx / ZOOM);
      // linked audio trimmed with it
      const a = seq.audioTracks[0].clips.find((x) => x.start === c.start)!;
      expect(a.duration).toBe(c.duration - dx / ZOOM);
    });

    await test.step('dragging a clip moves it later', async () => {
      const c = v1().clips[3];
      const b = await clipBox(c.id);
      const dx = 60; // 30 frames
      await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 });
      seq = await seqState(page);
      const after = v1().clips.find((x) => x.id === c.id)!;
      expect(after.start).toBe(c.start + dx / ZOOM);
      expect(after.duration).toBe(c.duration);
      expect(seq.audioTracks[0].clips.find((x) => x.linkId === c.linkId)!.start).toBe(c.start + dx / ZOOM);
    });

    await test.step('Delete removes the selected clip', async () => {
      const c = v1().clips[3];
      const b = await clipBox(c.id);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      expect((await uiState(page)).selectedClipIds).toContain(c.id);
      await page.keyboard.press('Delete');
      seq = await seqState(page);
      expect(v1().clips.map((x) => x.id)).not.toContain(c.id);
      expect(v1().clips).toHaveLength(3);
      expect(seq.audioTracks[0].clips).toHaveLength(3);
    });

    await test.step('Shift+Delete ripple-deletes and closes the gap', async () => {
      const c = v1().clips[0];
      const next = v1().clips[1];
      const b = await clipBox(c.id);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await page.keyboard.press('Shift+Delete');
      seq = await seqState(page);
      expect(v1().clips).toHaveLength(2);
      expect(v1().clips[0].id).toBe(next.id);
      expect(v1().clips[0].start).toBe(0);
      expect(v1().clips[1].start).toBe(v1().clips[0].duration);
    });

    await test.step('context menu at a cut adds a cross dissolve', async () => {
      const a = v1().clips[0];
      const b = await clipBox(a.id);
      await page.mouse.click(b.x + b.width - 3, b.y + b.height / 2, { button: 'right' });
      const item = page.locator('.menu-item', { hasText: 'Add Cross Dissolve' });
      await expect(item).toBeVisible();
      await item.click();
      seq = await seqState(page);
      expect(v1().transitions).toHaveLength(1);
      expect(v1().transitions[0].type).toBe('crossDissolve');
      await expect(page.locator('[data-transition-id]')).toHaveCount(1);
      // clicking the transition selects it; Delete removes it
      const tb = (await page.locator('[data-transition-id]').boundingBox())!;
      await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
      expect((await uiState(page)).selectedTransitionId).toBe(v1().transitions[0].id);
      await page.screenshot({ path: path.join(tmp, 'timeline-final.png') });
      await page.keyboard.press('Delete');
      seq = await seqState(page);
      expect(v1().transitions).toHaveLength(0);
    });

    await test.step('Ctrl+wheel zooms around the pointer; Escape clears selection', async () => {
      const r = (await page.locator('.tl-ruler').boundingBox())!;
      const before = seq.view.zoom;
      await page.mouse.move(r.x + 200, r.y + 60);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -200);
      await page.keyboard.up('Control');
      await page.waitForTimeout(100);
      seq = await seqState(page);
      expect(seq.view.zoom).toBeGreaterThan(before);
      await page.keyboard.press('Escape');
      expect((await uiState(page)).selectedClipIds).toHaveLength(0);
    });
  });
});
