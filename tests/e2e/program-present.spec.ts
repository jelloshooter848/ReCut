/**
 * Program Monitor: a paused draw never paints a frame other than the one at the playhead, not even for one display
 * frame (bugs/closed/2026-10-07-program-transient-stale-frame-before-present.md).
 *
 * Every Program draw is logged with a signature of the canvas right after it. The sequence cuts between two ranges of
 * one file, so both clips share one pooled <video> and every cut-back is a seek of that element. Under load Chromium
 * can report the seek landed ('seeked', readyState 4) before the landed frame reaches the element's compositor; a
 * draw then paints the other clip's picture until the presented frame is repainted. Most likely to show with
 * `--workers=4 --repeat-each N` (four Electron instances loading the CPUs).
 * Run: npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/program-present.spec.ts
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, type LaunchedApp } from './helpers';

const CANVAS = '[data-testid="program-canvas"]';
/** Cut-back seeks per test (10 <-> 70, across the cut at 48). */
const CYCLES = 20;

test.describe('Program Monitor: paused draws', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => {
    launched = await launchApp();
    await launched.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1600, 1000); w.center(); });
  });
  test.afterAll(async () => { await launched?.app.close(); });

  test('a cut back to a reused element never draws the other clip\'s frame first', async () => {
    const { page, tmp } = launched;
    test.setTimeout(120_000);
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__recut.store;
      store.setState({ dirty: false });
      store.getState().newProject();
    });
    const [mediaId] = await importMedia(page, [path.join(makeTestMedia(tmp, 'short'), MEDIA.movie1)]);
    const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
    await page.evaluate(({ seqId, mediaId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (window as any).__recut.store.getState();
      st.insertFromSource(seqId, { mediaId, in: 1, out: 3, atFrame: 0, mode: 'insert' });
      st.insertFromSource(seqId, { mediaId, in: 5, out: 7, atFrame: 48, mode: 'insert' });
    }, { seqId, mediaId });

    // Log every Program draw of a video: the playhead it was meant for and a 32x18 signature of the canvas after it.
    await page.evaluate((sel) => {
      const w = window as unknown as { __draws: { target: number; sig: string }[]; __target: number };
      w.__draws = [];
      w.__target = -1;
      const small = document.createElement('canvas');
      small.width = 32; small.height = 18;
      const sctx = small.getContext('2d', { willReadFrequently: true })!;
      const proto = CanvasRenderingContext2D.prototype;
      const draw = proto.drawImage as (...a: unknown[]) => void;
      proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        draw.apply(this, args);
        const program = document.querySelector(sel);
        if (this.canvas !== program || !(args[0] instanceof HTMLVideoElement)) return;
        draw.call(sctx, program, 0, 0, program.width, program.height, 0, 0, 32, 18);
        const d = sctx.getImageData(0, 0, 32, 18).data;
        let s = '';
        for (let i = 0; i < d.length; i += 4) s += String.fromCharCode(65 + (((d[i] + d[i + 1] + d[i + 2]) / 3) >> 3));
        w.__draws.push({ target: w.__target, sig: s });
      } as typeof proto.drawImage;
    }, CANVAS);

    const seekTo = (frame: number) => page.evaluate(({ seqId, frame }) => {
      const w = window as unknown as { __target: number; __recut: { store: { getState(): { setView(id: string, v: object): void } } } };
      w.__target = frame;
      w.__recut.store.getState().setView(seqId, { playhead: frame });
      return (w as unknown as { __draws: unknown[] }).__draws.length;
    }, { seqId, frame });
    /** Signature of the canvas as it rests (drawn since the seek, then no draw for 300 ms). */
    const rested = async (before: number): Promise<string> => {
      let n = -1;
      await expect.poll(async () => {
        const prev = n;
        n = await page.evaluate(() => (window as unknown as { __draws: unknown[] }).__draws.length);
        return n === prev && n > before;
      }, { timeout: 20_000, intervals: [300] }).toBe(true);
      return page.evaluate(() => { const d = (window as unknown as { __draws: { sig: string }[] }).__draws; return d[d.length - 1].sig; });
    };

    const sig10 = await rested(await seekTo(10));
    const sig70 = await rested(await seekTo(70));
    expect(sig10).not.toBe(sig70);
    await page.evaluate(() => { (window as unknown as { __draws: unknown[] }).__draws = []; });
    for (let i = 0; i < CYCLES; i++) {
      expect(await rested(await seekTo(10))).toBe(sig10);
      expect(await rested(await seekTo(70))).toBe(sig70);
    }
    const draws = await page.evaluate(() => (window as unknown as { __draws: { target: number; sig: string }[] }).__draws);
    const want: Record<number, string> = { 10: sig10, 70: sig70 };
    const wrong = draws.filter((d) => d.sig !== want[d.target]).map((d) => `at ${d.target}: ${d.sig === sig10 ? 'frame 10' : d.sig === sig70 ? 'frame 70' : 'other'}`);
    console.log(`[program-present] ${draws.length} draws over ${2 * CYCLES} cut-back seeks, ${wrong.length} wrong`);
    expect(wrong).toEqual([]);
  });
});
