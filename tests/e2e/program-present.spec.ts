/**
 * Program Monitor: a paused draw never paints a frame other than the one at the playhead, not even for one display
 * frame (bugs/closed/2026-10-07-program-transient-stale-frame-before-present.md @ 59eafc6).
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

interface Draw { target: number; sig: string; ct: number; held: number | null }

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

    // Log every Program draw of a video: the playhead it was meant for, a 32x18 signature of the canvas after it and
    // the element's currentTime. A wrong draw (once the right pictures are known) also logs the timestamp of the frame
    // the element holds (WebCodecs: the frame drawImage paints); right draws skip it so as not to change the timing.
    await page.evaluate((sel) => {
      const w = window as unknown as { __draws: Draw[]; __target: number; __want: Record<number, string> };
      w.__draws = [];
      w.__want = {};
      w.__target = -1;
      const small = document.createElement('canvas');
      small.width = 32; small.height = 18;
      const sctx = small.getContext('2d', { willReadFrequently: true })!;
      // The player's own VideoFrame checks (SequencePlayer.framesShown): count them, check every one is closed, and
      // time each new VideoFrame(el) + close().
      const RealFrame = VideoFrame;
      const v = window as unknown as { __vf: { made: number; closed: number; ms: number[] }; VideoFrame: typeof VideoFrame };
      v.__vf = { made: 0, closed: 0, ms: [] };
      class TimedFrame extends RealFrame {
        private readonly made: number;
        constructor(...a: ConstructorParameters<typeof VideoFrame>) {
          const t0 = performance.now();
          super(...a);
          this.made = performance.now() - t0;
          v.__vf.made++; // constructed (a constructor that throws holds no frame)
        }
        close(): void {
          const t0 = performance.now();
          super.close();
          v.__vf.closed++;
          v.__vf.ms.push(this.made + performance.now() - t0);
        }
      }
      v.VideoFrame = TimedFrame;
      const proto = CanvasRenderingContext2D.prototype;
      const draw = proto.drawImage as (...a: unknown[]) => void;
      proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        draw.apply(this, args);
        const program = document.querySelector(sel);
        const video = args[0];
        if (this.canvas !== program || !(video instanceof HTMLVideoElement)) return;
        const ct = video.currentTime;
        draw.call(sctx, program, 0, 0, program.width, program.height, 0, 0, 32, 18);
        const d = sctx.getImageData(0, 0, 32, 18).data;
        let s = '';
        for (let i = 0; i < d.length; i += 4) s += String.fromCharCode(65 + (((d[i] + d[i + 1] + d[i + 2]) / 3) >> 3));
        let held: number | null = null;
        if (w.__want[w.__target] !== undefined && w.__want[w.__target] !== s) {
          try { const f = new RealFrame(video); held = f.timestamp / 1e6; f.close(); } catch { /* no frame */ }
        }
        w.__draws.push({ target: w.__target, sig: s, ct, held });
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
    await page.evaluate((want) => { (window as unknown as { __want: Record<number, string> }).__want = want; }, { 10: sig10, 70: sig70 });
    await page.evaluate(() => {
      const w = window as unknown as { __draws: unknown[]; __vf: { made: number; closed: number; ms: number[] } };
      w.__draws = [];
      w.__vf = { made: 0, closed: 0, ms: [] };
    });
    for (let i = 0; i < CYCLES; i++) {
      expect(await rested(await seekTo(10))).toBe(sig10);
      expect(await rested(await seekTo(70))).toBe(sig70);
    }
    const draws = await page.evaluate(() => (window as unknown as { __draws: Draw[] }).__draws);
    const want: Record<number, string> = { 10: sig10, 70: sig70 };
    const name = (sig: string) => (sig === sig10 ? 'frame 10' : sig === sig70 ? 'frame 70' : 'other');
    const wrong = draws.filter((d) => d.sig !== want[d.target]).map((d) => `at ${d.target}: ${name(d.sig)}`);
    console.log(`[program-present] ${draws.length} draws over ${2 * CYCLES} cut-back seeks, ${wrong.length} wrong`);
    for (const d of draws.filter((x) => x.sig !== want[x.target])) console.log(`[program-present] wrong draw at ${d.target}: currentTime ${d.ct}, frame held ${d.held}`);
    // Cost of the player's frame check (none before the fix): per call, and calls per draw.
    const vf = await page.evaluate(() => (window as unknown as { __vf: { made: number; closed: number; ms: number[] } }).__vf);
    const ms = [...vf.ms].sort((a, b) => a - b);
    const q = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(3) : '-');
    console.log(`[program-present] VideoFrame checks: ${vf.made} made, ${vf.closed} closed, ${(vf.made / Math.max(1, draws.length)).toFixed(2)} per draw; new + close ms median ${q(0.5)}, p95 ${q(0.95)}, max ${q(1)}`);
    expect(vf.closed).toBe(vf.made);
    expect(wrong).toEqual([]);
  });
});
