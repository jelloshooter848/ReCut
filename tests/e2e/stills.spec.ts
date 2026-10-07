/**
 * Still images Chromium cannot draw (TIFF, TGA) show in the Program and Source monitors through the PNG proxy built on
 * import, with proxies off; so does an AVIF (Chromium decodes it, but applies its irot orientation where FFmpeg 6.1
 * does not); an EXIF-rotated JPEG is upright (as the export draws it).
 * Run: npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/stills.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, importMedia, getState, type LaunchedApp } from './helpers';
import { writeJpegWithOrientation } from '../attack/stillfiles';

const CANVAS = '[data-testid="program-canvas"]';
type RGB = [number, number, number];

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

/** Pixel of the Program canvas at a fraction of its size. */
async function canvasPixel(page: Page, fx: number, fy: number): Promise<RGB> {
  return page.evaluate(({ sel, fx, fy }) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  }, { sel: CANVAS, fx, fy });
}

/** Centre pixel of the Source monitor's <img>, drawn at its natural size. */
async function sourceImagePixel(page: Page): Promise<{ rgb: RGB; src: string; w: number; h: number } | null> {
  return page.evaluate(() => {
    const img = document.querySelector('.source-panel img[data-testid="source-image"]') as HTMLImageElement | null;
    if (!img || !img.complete || !img.naturalWidth) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { rgb: [d[0], d[1], d[2]] as RGB, src: img.src, w: img.naturalWidth, h: img.naturalHeight };
  });
}

const near = (a: RGB, b: RGB, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** A fresh project with proxies OFF (a still's PNG proxy is built and used anyway); returns the sequence id. */
async function freshProject(page: Page): Promise<string> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__recut.store;
    store.setState({ dirty: false });
    store.getState().newProject();
    store.getState().setSettings({ useProxies: false });
  });
  return getState<string>(page, '(s) => s.project.activeSequenceId');
}

/** Put `mediaId` on V1 at frames 0..96 and park the playhead at 10. */
async function placeStill(page: Page, seqId: string, mediaId: string): Promise<void> {
  await page.evaluate(({ seqId, mediaId }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (window as any).__recut.store.getState();
    st.insertFromSource(seqId, { mediaId, in: 0, out: 4, atFrame: 0, mode: 'overwrite', includeAudio: false });
    st.setView(seqId, { playhead: 10, inPoint: null, outPoint: null });
  }, { seqId, mediaId });
}

test.describe('Still images in the monitors', () => {
  let launched: LaunchedApp;

  test.beforeAll(async () => {
    launched = await launchApp();
    await launched.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1600, 1000); w.center(); });
    await launched.page.waitForTimeout(300);
  });
  test.afterAll(async () => { await launched?.app.close(); });

  for (const { ext, color, rgb } of [
    { ext: 'tiff', color: '0xFF8000', rgb: [255, 128, 0] as RGB },
    { ext: 'tga', color: '0x00C8C8', rgb: [0, 200, 200] as RGB },
  ]) {
    test(`a ${ext.toUpperCase()} shows in Program and Source through its PNG proxy (proxies off)`, async () => {
      const { page, tmp } = launched;
      test.setTimeout(90_000);
      const seqId = await freshProject(page);
      expect(await getState<boolean>(page, '(s) => s.project.settings.useProxies')).toBe(false);
      const file = path.join(tmp, `still.${ext}`);
      ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=1`, '-frames:v', '1', file]);
      const [id] = await importMedia(page, [file]);
      expect(await getState<string>(page, `(s) => s.project.media[${JSON.stringify(id)}].kind`)).toBe('image');
      // The import queued the still proxy although proxies are off.
      await expect.poll(() => getState<string>(page, `(s) => { const p = s.project.media[${JSON.stringify(id)}].proxy; return p.status + ':' + (p.path ?? ''); }`),
        { timeout: 30_000 }).toMatch(/^ready:.*_still\.png$/);

      await placeStill(page, seqId, id);
      await expect.poll(async () => near(await canvasPixel(page, 0.5, 0.5), rgb), { timeout: 20_000, intervals: [250] }).toBe(true);
      await expect(page.getByTestId('program-needs-proxy')).toHaveCount(0);
      await expect(page.getByTestId('program-missing')).toHaveCount(0);
      await expect(page.locator('.tl-badge.needs-proxy')).toHaveCount(0);

      await page.evaluate((id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__recut.store.getState().setSourceClip(id, 0);
      }, id);
      await expect.poll(async () => { const p = await sourceImagePixel(page); return p ? near(p.rgb, rgb) && /_still\.png$/.test(decodeURIComponent(p.src)) : false; },
        { timeout: 20_000, intervals: [250] }).toBe(true);
      await expect(page.locator('.source-panel .source-error-card')).toHaveCount(0);
    });
  }

  test('a still whose proxy is missing shows the needs-proxy state in Source and Program', async () => {
    const { page, tmp } = launched;
    const seqId = await freshProject(page);
    const file = path.join(tmp, 'pending.tiff');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-frames:v', '1', file]);
    const [id] = await importMedia(page, [file]);
    await expect.poll(() => getState<string>(page, `(s) => s.project.media[${JSON.stringify(id)}].proxy.status`), { timeout: 30_000 }).toBe('ready');
    // Forget the proxy (as when its file is deleted): the monitors ask for one instead of drawing nothing.
    await page.evaluate((id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (window as any).__recut.store.getState();
      st.invalidateProxy(id);
      st.setSourceClip(id, 0);
    }, id);
    await placeStill(page, seqId, id);
    const card = page.locator('.source-panel .source-error-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(/TIFF image needs a preview proxy/);
    await expect(card.getByRole('button', { name: /Generate proxy/i })).toBeVisible();
    await expect(page.getByTestId('program-needs-proxy')).toBeVisible();
    await expect(page.locator('.tl-badge.needs-proxy').first()).toBeVisible();
    await page.getByTestId('program-generate-proxies').click();
    await expect.poll(() => getState<string>(page, `(s) => s.project.media[${JSON.stringify(id)}].proxy.status`), { timeout: 30_000 }).toBe('ready');
    await expect(page.locator('.source-panel img[data-testid="source-image"]')).toBeVisible();
    await expect(page.getByTestId('program-needs-proxy')).toHaveCount(0);
  });

  test('an AVIF is previewed through its PNG proxy, like the export decodes it', async () => {
    const { page, tmp } = launched;
    const seqId = await freshProject(page);
    const file = path.join(tmp, 'still.avif');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x2040E0:s=320x240:d=1', '-frames:v', '1', file]);
    const [id] = await importMedia(page, [file]);
    expect(await getState<string>(page, `(s) => s.project.media[${JSON.stringify(id)}].kind`)).toBe('image');
    await expect.poll(() => getState<string>(page, `(s) => { const p = s.project.media[${JSON.stringify(id)}].proxy; return p.status + ':' + (p.path ?? ''); }`),
      { timeout: 30_000 }).toMatch(/^ready:.*_still\.png$/);
    await placeStill(page, seqId, id);
    await expect.poll(async () => near(await canvasPixel(page, 0.5, 0.5), [32, 64, 224]), { timeout: 20_000, intervals: [250] }).toBe(true);
    await expect(page.getByTestId('program-needs-proxy')).toHaveCount(0);
  });

  test('an EXIF-rotated JPEG (Orientation=6) is upright in the Program monitor, as in the export', async () => {
    const { page, tmp } = launched;
    const seqId = await freshProject(page);
    const plain = path.join(tmp, 'quad.jpg');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=1,format=rgb24,drawbox=x=0:y=0:w=160:h=120:c=red:t=fill,drawbox=x=160:y=0:w=160:h=120:c=lime:t=fill,drawbox=x=0:y=120:w=160:h=120:c=blue:t=fill',
      '-frames:v', '1', '-q:v', '2', plain]);
    const rot = path.join(tmp, 'rot6.jpg');
    writeJpegWithOrientation(plain, rot, 6);
    const [id] = await importMedia(page, [rot]);
    const size = await getState<[number, number]>(page, `(s) => { const v = s.project.media[${JSON.stringify(id)}].probe.video; return [v.width, v.height]; }`);
    expect(size).toEqual([240, 320]);
    await placeStill(page, seqId, id);
    const seq = await getState<[number, number]>(page, `(s) => { const q = s.project.sequences[${JSON.stringify(seqId)}]; return [q.width, q.height]; }`);
    // The portrait picture fills the height; quadrants after a 90 degree clockwise turn: blue TL, red TR, white BL, lime BR.
    const picW = (seq[1] * 240 / 320) / seq[0];
    const x0 = (1 - picW) / 2;
    const at = (qx: number, qy: number) => canvasPixel(page, x0 + picW * qx, qy);
    await expect.poll(async () => near(await at(0.75, 0.25), [255, 0, 0], 60), { timeout: 20_000, intervals: [250] }).toBe(true);
    expect(near(await at(0.25, 0.25), [0, 0, 255], 60)).toBe(true);
    expect(near(await at(0.25, 0.75), [255, 255, 255], 60)).toBe(true);
    expect(near(await at(0.75, 0.75), [0, 255, 0], 60)).toBe(true);
  });
});
