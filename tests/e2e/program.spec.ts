/**
 * Program Monitor e2e: renders the active sequence, plays, seeks via the transport and marks in/out.
 * Run: npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/program.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, ROOT, type LaunchedApp } from './helpers';

const CANVAS = '[data-testid="program-canvas"]';

/** Average brightness (0..255) of the canvas pixels. */
async function canvasBrightness(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0;
    const step = 4 * 7; // sample every 7th pixel
    let n = 0;
    for (let i = 0; i < data.length; i += step) { sum += (data[i] + data[i + 1] + data[i + 2]) / 3; n++; }
    return n ? sum / n : -1;
  }, CANVAS);
}

async function playhead(page: Page): Promise<number> {
  return getState<number>(page, '(s) => s.project.sequences[s.project.activeSequenceId].view.playhead');
}

test.describe('Program Monitor', () => {
  let launched: LaunchedApp;

  test.beforeAll(async () => {
    launched = await launchApp();
  });
  test.afterAll(async () => {
    await launched?.app.close();
  });

  test('renders, plays, seeks and marks in/out', async () => {
    const { app, page, tmp } = launched;
    page.on('pageerror', (e) => console.log('[renderer:pageerror]', e.message));
    // A realistic editing window so the monitor gets a usable width (xvfb defaults are small).
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.center(); });
    await page.waitForTimeout(300);

    const mediaDir = makeTestMedia(tmp, 'short');
    const movie = path.join(mediaDir, MEDIA.movie1);
    expect(fs.existsSync(movie)).toBeTruthy();

    // Import + probe.
    const [mediaId] = await importMedia(page, [movie]);
    const probed = await getState<boolean>(page, `(s) => !!s.project.media[${JSON.stringify(mediaId)}].probe?.video`);
    expect(probed).toBeTruthy();

    // Two ranges into the active sequence: 1–3 s at frame 0 and 5–7 s at frame 48.
    const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
    expect(seqId).toBeTruthy();
    await page.evaluate(({ seqId, mediaId }) => {
      const w = window as unknown as { __recut: { store: { getState(): any } } };
      const st = w.__recut.store.getState();
      st.insertFromSource(seqId, { mediaId, in: 1, out: 3, atFrame: 0, mode: 'insert' });
      st.insertFromSource(seqId, { mediaId, in: 5, out: 7, atFrame: 48, mode: 'insert' });
    }, { seqId, mediaId });
    const duration = await page.evaluate(() => {
      const w = window as unknown as { __recut: { store: { getState(): any } } };
      const s = w.__recut.store.getState();
      const seq = s.project.sequences[s.project.activeSequenceId];
      let end = 0;
      for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
      return end;
    });
    expect(duration).toBe(96);

    // Program panel is mounted with its canvas sized to the sequence.
    await page.waitForSelector(CANVAS, { timeout: 30_000 });
    await page.waitForSelector('[data-testid="program-panel"]');
    await expect.poll(() => page.evaluate((sel) => (document.querySelector(sel) as HTMLCanvasElement).width, CANVAS)).toBeGreaterThan(100);

    // renderFrame(10) through the store playhead (paused: store is the source of truth) yields a non-black frame.
    await page.evaluate(({ seqId }) => {
      const w = window as unknown as { __recut: { store: { getState(): any } } };
      w.__recut.store.getState().setView(seqId, { playhead: 10 });
    }, { seqId });
    await expect.poll(() => canvasBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
    const tcText = await page.locator('[data-testid="program-timecode"]').innerText();
    expect(tcText).toContain('00:00:00:10');

    // Play: the store playhead advances and stays inside the sequence.
    await page.click('[data-testid="program-play"]');
    await expect.poll(() => getState<boolean>(page, '(s) => s.playback.playing')).toBe(true);
    await page.waitForTimeout(1500);
    const during = await playhead(page);
    expect(during).toBeGreaterThan(10);
    expect(during).toBeLessThan(96);

    // Pause.
    await page.click('[data-testid="program-play"]');
    await expect.poll(() => getState<boolean>(page, '(s) => s.playback.playing')).toBe(false);
    const paused = await playhead(page);
    await page.waitForTimeout(300);
    expect(await playhead(page)).toBe(paused);

    // End via the transport button → playhead == sequence duration.
    await page.click('[data-testid="program-go-end"]');
    await expect.poll(() => playhead(page)).toBe(96);

    // Home via the panel's keyboard fallback.
    await page.focus('[data-testid="program-panel"]');
    await page.keyboard.press('Home');
    await expect.poll(() => playhead(page)).toBe(0);

    // Mark In at 12, Mark Out at 60 via the buttons.
    await page.evaluate(({ seqId }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: 12 }); }, { seqId });
    await page.click('[data-testid="program-mark-in"]');
    await page.evaluate(({ seqId }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: 60 }); }, { seqId });
    await page.click('[data-testid="program-mark-out"]');
    const view = await getState<{ inPoint: number | null; outPoint: number | null }>(page, '(s) => s.project.sequences[s.project.activeSequenceId].view');
    expect(view.inPoint).toBe(12);
    expect(view.outPoint).toBe(60);

    // Loop toggle shows the indicator; clear in/out removes it.
    await page.click('[data-testid="program-loop-toggle"]');
    await expect(page.locator('[data-testid="program-loop"]')).toBeVisible();
    await page.click('[data-testid="program-clear-inout"]');
    const cleared = await getState<{ inPoint: number | null; outPoint: number | null }>(page, '(s) => s.project.sequences[s.project.activeSequenceId].view');
    expect(cleared.inPoint).toBeNull();
    expect(cleared.outPoint).toBeNull();

    // Scrub bar click seeks.
    const scrub = page.locator('[data-testid="program-scrub"]');
    const sb = await scrub.boundingBox();
    expect(sb).toBeTruthy();
    await page.mouse.click(sb!.x + sb!.width * 0.5, sb!.y + sb!.height / 2);
    const scrubbed = await playhead(page);
    expect(Math.abs(scrubbed - 48)).toBeLessThanOrEqual(2);

    // Screenshot for docs.
    await page.evaluate(({ seqId }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: 60, inPoint: 24, outPoint: 72 }); }, { seqId });
    await page.waitForTimeout(600);
    const out = path.join(ROOT, 'docs/screenshots/program.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });

    // Maximized monitor: wide transport bar (in/out readouts, volume, resolution, toggles).
    // Maximize must not remount the panel: the canvas element stays the same node and playback keeps running.
    await page.evaluate((sel) => { (window as any).__programCanvas = document.querySelector(sel); }, CANVAS);
    await page.click('[data-testid="program-play"]');
    await expect.poll(() => getState<boolean>(page, '(s) => s.playback.playing')).toBe(true);
    await page.click('[data-testid="program-maximize"]');
    await page.waitForTimeout(400);
    expect(await page.evaluate((sel) => document.querySelector(sel) === (window as any).__programCanvas, CANVAS)).toBe(true);
    expect(await getState<boolean>(page, '(s) => s.playback.playing')).toBe(true);
    await page.click('[data-testid="program-play"]');
    await expect.poll(() => getState<boolean>(page, '(s) => s.playback.playing')).toBe(false);
    await page.evaluate(({ seqId }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: 60 }); }, { seqId });
    await expect(page.locator('[data-testid="program-resolution"]')).toBeVisible();
    await page.click('[data-testid="program-safe-margins"]');
    await page.selectOption('[data-testid="program-resolution"]', '1/2');
    await expect.poll(() => getState<string>(page, '(s) => s.project.settings.playbackResolution')).toBe('1/2');
    await expect.poll(() => page.evaluate((sel) => (document.querySelector(sel) as HTMLCanvasElement).width, CANVAS)).toBe(960);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ROOT, 'docs/screenshots/program-maximized.png') });
    await page.click('[data-testid="program-maximize"]');
    await page.waitForTimeout(200);
    expect(await page.evaluate((sel) => document.querySelector(sel) === (window as any).__programCanvas, CANVAS)).toBe(true);
  });
});
