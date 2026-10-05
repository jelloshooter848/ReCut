/**
 * Program Monitor e2e: renders the active sequence, plays, seeks via the transport and marks in/out.
 * Run: npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/program.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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

    // Empty sequence → hint instead of a silent black rectangle (UX-04).
    await expect(page.getByTestId('program-empty-hint')).toBeVisible();

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
    await expect(page.getByTestId('program-empty-hint')).toHaveCount(0);

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

    // Home via the panel's keyboard fallback. Focusing the monitor makes it the visible transport owner (UX-03).
    await page.focus('[data-testid="program-panel"]');
    await expect(page.getByTestId('program-panel')).toHaveAttribute('data-transport-active', 'true');
    await expect(page.getByTestId('program-meter')).toBeVisible();
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

  test('Play In to Out stops at Out when Loop is off (E-15)', async () => {
    const { page } = launched;
    test.setTimeout(60_000);
    const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.evaluate(({ seqId }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: 0, inPoint: 24, outPoint: 48 }); }, { seqId });
    if ((await page.getByTestId('program-loop-toggle').getAttribute('aria-pressed')) === 'true') await page.click('[data-testid="program-loop-toggle"]');
    await page.focus('[data-testid="program-panel"]');
    await page.keyboard.press('Control+Shift+Space');
    await expect.poll(() => getState<boolean>(page, '(s) => s.playback.playing')).toBe(true);
    await expect.poll(() => getState<boolean>(page, '(s) => s.playback.playing'), { timeout: 10_000 }).toBe(false);
    const ph = await playhead(page);
    expect(ph).toBeGreaterThanOrEqual(40);
    expect(ph).toBeLessThanOrEqual(48);
    await page.waitForTimeout(500);
    expect(await getState<boolean>(page, '(s) => s.playback.playing')).toBe(false);
  });

  test('draws a still image on V2 over video (no Needs proxy)', async () => {
    const { page, tmp } = launched;
    test.setTimeout(90_000);
    const png = path.join(tmp, 'still-magenta.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=magenta:s=320x180:d=1', '-frames:v', '1', png]);
    const [imgId] = await importMedia(page, [png]);
    expect(await getState<string>(page, `(s) => s.project.media[${JSON.stringify(imgId)}].kind`)).toBe('image');
    const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clipId = await page.evaluate(({ seqId, imgId }) => {
      const st = (window as any).__recut.store.getState();
      const seq = st.project.sequences[seqId];
      const ids = st.insertFromSource(seqId, { mediaId: imgId, in: 0, out: 4, atFrame: 0, mode: 'overwrite', videoTrackId: seq.videoTracks[1].id, includeAudio: false });
      // Half size, in the top-left quarter of the frame: video stays visible around it.
      st.setClipTransform(seqId, ids[0], { scale: 0.5, x: -seq.width / 4, y: -seq.height / 4 });
      st.setView(seqId, { playhead: 30, inPoint: null, outPoint: null });
      return ids[0];
    }, { seqId, imgId });
    expect(clipId).toBeTruthy();
    // The image layer is drawn: the top-left quarter turns magenta, the bottom-right still shows video.
    const sample = (fx: number, fy: number) => page.evaluate(({ sel, fx, fy }) => {
      const c = document.querySelector(sel) as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    }, { sel: CANVAS, fx, fy });
    await expect.poll(async () => {
      const [r, g, b] = await sample(0.25, 0.25);
      return r > 200 && g < 60 && b > 200;
    }, { timeout: 20_000, intervals: [250] }).toBe(true);
    const [r2, g2, b2] = await sample(0.75, 0.75);
    expect(r2 > 200 && g2 < 60 && b2 > 200).toBe(false);
    await expect(page.getByTestId('program-needs-proxy')).toHaveCount(0);
    await expect(page.getByTestId('program-missing')).toHaveCount(0);
    // The timeline clip carries no PROXY badge.
    await expect(page.locator(`[data-clip-id="${clipId}"] .tl-badge.needs-proxy`)).toHaveCount(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ROOT, 'docs/screenshots/program-still.png') });
  });
});

