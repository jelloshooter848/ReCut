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

    await test.step('waveform canvases sit inside their clips, sized in device pixels', async () => {
      // Waveforms are filled device-pixel bars (A4 rendering trade-off): the canvas backing store is its CSS box times
      // devicePixelRatio, its columns line up with the clip's timeline pixels (column 0 at the clip's left edge, the body
      // clipping it at the borders), its height is the clip body's, and drawn bars stay inside it. Strict geometry.
      const audioIds = seq.audioTracks[0].clips.map((c) => c.id);
      await page.waitForFunction(() => [...document.querySelectorAll('canvas.tl-wave')].some((c) => {
        const cv = c as HTMLCanvasElement; const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false;
      }), null, { timeout: 30_000 }).catch(() => undefined);
      const waves = await page.evaluate((ids) => ids.map((id) => {
        const clip = document.querySelector(`[data-clip-id="${id}"]`)!; const cv = clip.querySelector('canvas.tl-wave') as HTMLCanvasElement | null;
        if (!cv) return null;
        const body = clip.querySelector('.tl-clip-body')!.getBoundingClientRect(); const box = clip.getBoundingClientRect(); const r = cv.getBoundingClientRect(); const dpr = window.devicePixelRatio;
        const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
        let inked = 0;
        for (let x = 0; x < cv.width; x++) { for (let y = 0; y < cv.height; y++) if (d[(y * cv.width + x) * 4 + 3]) { inked++; break; } }
        return { dpr, bw: cv.width, bh: cv.height, w: r.width, h: r.height, dl: r.left - box.left, dt: r.top - body.top, clipW: box.width, bodyH: body.height, inked };
      }), audioIds);
      expect(waves.every(Boolean)).toBe(true);
      for (const w of waves) {
        expect(Math.abs(w!.w * w!.dpr - w!.bw)).toBeLessThan(0.01);
        expect(Math.abs(w!.h * w!.dpr - w!.bh)).toBeLessThan(0.01);
        expect(Math.abs(w!.dl)).toBeLessThan(0.01);
        expect(Math.abs(w!.dt)).toBeLessThan(0.01);
        expect(Math.abs(w!.w - w!.clipW)).toBeLessThanOrEqual(0.5 / w!.dpr + 0.01);
        expect(Math.abs(w!.h - w!.bodyH)).toBeLessThanOrEqual(0.5 / w!.dpr + 0.01);
        // Once drawn, every device column has a bar (the silent baseline is at least 1 device px).
        if (w!.inked) expect(w!.inked).toBe(w!.bw);
      }
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
      // The playhead line (a composited layer moved by transform, A4) sits exactly on frameToX(playhead), snapped to the
      // window's device pixel grid (the nearest device pixel; at dpr 1 with the lane on a whole pixel, the former
      // Math.round(x)). Strict geometry, no tolerance.
      const g = await page.evaluate(() => {
        const l = document.querySelector('[data-playhead]')!.getBoundingClientRect(); const h = document.querySelector('.tl-playhead-head')!.getBoundingClientRect();
        const col = document.querySelector('.tl-tracks-col')!.getBoundingClientRect();
        return { lx: l.left, lw: l.width, hx: h.left, hw: h.width, colX: col.left, dpr: window.devicePixelRatio };
      });
      expect(g.colX).toBeCloseTo(r.x, 6); // the ruler starts at the lane's left edge, where frameToX is 0
      const exactX = g.colX + (seq.view.playhead - seq.view.scroll) * ZOOM;
      // Within one layout unit (1/64 device px): a lane at a fractional device offset is compensated by a layout
      // offset (playheadLayerPos), which layout stores in 1/64 px units.
      const lu = 1 / (64 * g.dpr) + 1e-6;
      expect(Math.abs(g.lx - Math.round(exactX * g.dpr) / g.dpr)).toBeLessThanOrEqual(lu);
      expect(Math.abs(g.lx - exactX)).toBeLessThanOrEqual(0.5 / g.dpr + lu);
      // 1 CSS px at dpr 1; at other ratios whole device pixels, like a 1px border (1 device px at 1.5, 2 at 2).
      expect(g.lw).toBeCloseTo(Math.max(1, Math.floor(g.dpr)) / g.dpr, 6);
      // The head is centred on the line (13 px wide, from x - 6).
      expect(g.hx - g.lx).toBeCloseTo(-6, 6);
      expect(g.hw).toBe(13);
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

// ------------------------------------------------------------------ keyboard target + dialogs (E-01, UX-01, UX-02)

type AnyStore = { getState(): any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const seqView = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState();
  const q = s.project.sequences[s.project.activeSequenceId];
  return { playhead: q.view.playhead as number, inPoint: q.view.inPoint as number | null, outPoint: q.view.outPoint as number | null, playing: s.playback.playing as boolean };
});

test.describe('timeline keyboard target and dialogs', () => {
  let launched: LaunchedApp;
  let mediaId: string;
  test.beforeAll(async () => {
    launched = await launchApp();
    const { app, page, tmp } = launched;
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1400, 900); w.center(); });
    const mediaDir = makeTestMedia(tmp, 'short');
    [mediaId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
    await page.evaluate((mediaId) => {
      const st = (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState();
      const seqId = st.project.activeSequenceId;
      for (let i = 0; i < 3; i++) st.insertFromSource(seqId, { mediaId, in: i * 4, out: i * 4 + 4, atFrame: i * 96, mode: 'overwrite' });
      st.setView(seqId, { zoom: 2, scroll: 0, playhead: 10 });
    }, mediaId);
  });
  test.afterAll(async () => { await launched?.app.close(); });

  test('clicking the Timeline hands Space/JKL/Home/End/Up/Down/I/O to the sequence after using the Source (E-01)', async () => {
    test.setTimeout(120_000);
    const { page } = launched;
    await page.evaluate((id) => (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState().setSourceClip(id, 1), mediaId);
    const source = page.locator('.source-panel');
    await source.locator('.source-stage').click();
    await expect(source).toHaveAttribute('data-transport-active', 'true');
    await page.keyboard.press('ArrowRight'); // drives the Source
    expect((await seqView(page)).playhead).toBe(10);

    // Click an empty part of the timeline (status strip): the Program side owns the keys now.
    await page.locator('.tl-root .tl-status').click();
    await expect(page.getByTestId('program-panel')).toHaveAttribute('data-transport-active', 'true');
    await expect(source).toHaveAttribute('data-transport-active', 'false');

    await page.keyboard.press('Home');
    await expect.poll(async () => (await seqView(page)).playhead).toBe(0);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await seqView(page)).playhead).toBe(96);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await seqView(page)).playhead).toBe(192);
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await seqView(page)).playhead).toBe(96);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await seqView(page)).playhead).toBe(97);
    await page.keyboard.press('i');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('o');
    await expect.poll(async () => { const v = await seqView(page); return [v.inPoint, v.outPoint]; }).toEqual([97, 99]);
    await page.keyboard.press('End');
    await expect.poll(async () => (await seqView(page)).playhead).toBe(288);
    await page.keyboard.press('Home');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await seqView(page)).playing).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await seqView(page)).playing).toBe(false);
    await page.keyboard.press('l');
    await expect.poll(async () => (await seqView(page)).playhead, { timeout: 10_000 }).toBeGreaterThan(2);
    await page.keyboard.press('k');
    await expect.poll(async () => (await seqView(page)).playing).toBe(false);
    // J shuttles backwards from the end.
    await page.keyboard.press('End');
    await expect.poll(async () => (await seqView(page)).playhead).toBe(288);
    await page.keyboard.press('j');
    await expect.poll(async () => (await seqView(page)).playhead, { timeout: 10_000 }).toBeLessThan(285);
    await page.keyboard.press('k');
    await expect.poll(async () => (await seqView(page)).playing).toBe(false);
    // The Source monitor never moved while the timeline had the keys.
    await expect(source).toHaveAttribute('data-transport-active', 'false');
    await page.screenshot({ path: path.join(launched.tmp, 'timeline-keyboard.png') });
  });

  test('dialogs: focus starts in the body, Enter applies, global shortcuts stay out (UX-01, UX-02)', async () => {
    test.setTimeout(120_000);
    const { page } = launched;
    const clipId = await page.evaluate(() => {
      const s = (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState();
      const q = s.project.sequences[s.project.activeSequenceId];
      s.select([], 'clear');
      s.setView(q.id, { scroll: 0, zoom: 2, playhead: 0 });
      return q.videoTracks[0].clips[0].id as string;
    });
    const clip = page.locator(`.tl-clip[data-clip-id="${clipId}"]`);
    await clip.click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Rename…' }).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }));
    expect(focused.tag).toBe('INPUT');
    // Ctrl+A inside the field selects text, not every clip on the timeline.
    const before = await page.evaluate(() => (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState().ui.selectedClipIds.length);
    await page.keyboard.press('ControlOrMeta+a');
    const after = await page.evaluate(() => (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState().ui.selectedClipIds.length);
    expect(after).toBe(before);
    await page.keyboard.type('Hero shot');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate((id) => {
      const s = (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState();
      const q = s.project.sequences[s.project.activeSequenceId];
      return q.videoTracks[0].clips.find((c: { id: string }) => c.id === id)?.name;
    }, clipId)).toBe('Hero shot');

    // Speed dialog: type the number straight away and press Enter → applied.
    await clip.click();
    await page.keyboard.press('ControlOrMeta+r');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).not.toBe('Close');
    await page.keyboard.type('200');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate((id) => {
      const s = (window as unknown as { __recut: { store: AnyStore } }).__recut.store.getState();
      const q = s.project.sequences[s.project.activeSequenceId];
      return q.videoTracks[0].clips.find((c: { id: string }) => c.id === id)?.speed;
    }, clipId)).toBe(2);
  });
});
