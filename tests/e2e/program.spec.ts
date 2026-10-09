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

interface Size { w: number; h: number }
interface CanvasSizes { actual: Size; expected: Size; uncapped: Size; seq: Size; box: Size; dpr: number; capped: boolean }

/**
 * The Program canvas size next to the size the app should produce for the monitor as it is laid out right now: the
 * sequence size x playback resolution, capped to the monitor's on-screen box in device pixels, keeping the sequence
 * aspect ratio. Mirrors ProgramPanel (fitBox of the .pm-video rect, setDisplaySize(box x devicePixelRatio)) and
 * SequencePlayer.resizeCanvas, rounding included. Read live, so it holds whatever room the screen size, the window
 * frame and menu bar, and the other panels leave for the monitor, which differs between xvfb and a Windows runner.
 */
async function canvasSizes(page: Page): Promise<CanvasSizes> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement;
    const video = canvas.closest('.pm-video') as HTMLElement;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__recut.store.getState();
    const q = s.project.sequences[s.project.activeSequenceId];
    const factor = ({ full: 1, '1/2': 0.5, '1/4': 0.25 } as Record<string, number>)[s.project.settings.playbackResolution] ?? 1;
    const r = video.getBoundingClientRect();
    const fit = Math.min(r.width / q.width, r.height / q.height);
    const box = r.width > 0 && r.height > 0 ? { w: Math.max(2, Math.floor(q.width * fit)), h: Math.max(2, Math.floor(q.height * fit)) } : { w: 0, h: 0 };
    const dpr = window.devicePixelRatio || 1;
    const cap = box.w > 0 ? { w: Math.round(box.w * dpr), h: Math.round(box.h * dpr) } : null;
    const w = q.width * factor, h = q.height * factor;
    const k = cap ? Math.min(1, cap.w / w, cap.h / h) : 1;
    return {
      actual: { w: canvas.width, h: canvas.height },
      expected: { w: Math.max(2, Math.round(w * k)), h: Math.max(2, Math.round(h * k)) },
      uncapped: { w: Math.max(2, Math.round(w)), h: Math.max(2, Math.round(h)) },
      seq: { w: q.width, h: q.height }, box, dpr, capped: k < 1,
    };
  }, CANVAS);
}

/**
 * Waits until the canvas has exactly the size canvasSizes computes, then checks that it keeps the sequence aspect
 * ratio (width and height are rounded separately, so each is within half a pixel of it). Returns the sizes.
 */
async function expectCanvasSize(page: Page, label: string): Promise<CanvasSizes> {
  // Received on failure: every input of the computation, as last sampled.
  await expect.poll(async () => { const c = await canvasSizes(page); return c.actual.w === c.expected.w && c.actual.h === c.expected.h ? 'match' : JSON.stringify(c); },
    { message: `${label}: canvas size` }).toBe('match');
  const c = await canvasSizes(page);
  console.log(`[program canvas] ${label}: ${c.actual.w}x${c.actual.h} (box ${c.box.w}x${c.box.h} @${c.dpr}x, uncapped ${c.uncapped.w}x${c.uncapped.h}, capped ${c.capped})`);
  expect(c.actual).toEqual(c.expected);
  expect(Math.abs(c.actual.h - (c.actual.w * c.seq.h) / c.seq.w)).toBeLessThan(1);
  return c;
}

/** A fresh, empty project (no save prompt) with movie 1 imported. Every test starts here: none reuses another's state. */
async function freshProjectWithMovie(launched: LaunchedApp): Promise<{ seqId: string; mediaId: string }> {
  const { page, tmp } = launched;
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__recut.store;
    store.setState({ dirty: false });
    store.getState().newProject();
  });
  const movie = path.join(makeTestMedia(tmp, 'short'), MEDIA.movie1);
  expect(fs.existsSync(movie)).toBeTruthy();
  const [mediaId] = await importMedia(page, [movie]);
  expect(await getState<boolean>(page, `(s) => !!s.project.media[${JSON.stringify(mediaId)}].probe?.video`)).toBeTruthy();
  const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
  expect(seqId).toBeTruthy();
  return { seqId, mediaId };
}

/** Puts 1–3 s of movie 1 at frames 0–47 and 5–7 s of the same file at frames 48–95 into the sequence. */
async function insertTwoRanges(page: Page, seqId: string, mediaId: string): Promise<void> {
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
}

/** freshProjectWithMovie + insertTwoRanges: the two-clip sequence the playback tests run on. */
async function twoClipProject(launched: LaunchedApp): Promise<{ seqId: string; mediaId: string }> {
  const ids = await freshProjectWithMovie(launched);
  await insertTwoRanges(launched.page, ids.seqId, ids.mediaId);
  return ids;
}

test.describe('Program Monitor', () => {
  let launched: LaunchedApp;

  test.beforeAll(async () => {
    launched = await launchApp();
    // A realistic editing window so the monitor gets a usable width (xvfb defaults are small). The content size, not
    // the outer size, which includes the frame and title bar on Windows. The OS still clamps the window to the
    // screen (xvfb-run's 1280x1024 gives 1279x996 here), so the canvas size checks do not rely on this size: they
    // compute the expected size from the monitor box as laid out.
    const win = await launched.app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1600, 1000);
      w.center();
      return { content: w.getContentSize(), outer: w.getSize(), workArea: screen.getPrimaryDisplay().workAreaSize };
    });
    // The OS may clamp the window to the screen (a small CI display): the size checks below adapt, this says why.
    console.log(`[program window] content ${win.content.join('x')}, outer ${win.outer.join('x')}, work area ${win.workArea.width}x${win.workArea.height}`);
    await launched.page.waitForTimeout(300);
  });
  test.afterAll(async () => {
    await launched?.app.close();
  });

  test('renders, plays, seeks and marks in/out', async () => {
    const { page } = launched;
    page.on('pageerror', (e) => console.log('[renderer:pageerror]', e.message));
    const { seqId, mediaId } = await freshProjectWithMovie(launched);

    // Empty sequence → hint instead of a silent black rectangle (UX-04).
    await expect(page.getByTestId('program-empty-hint')).toBeVisible();

    // Two ranges into the active sequence: 1–3 s at frame 0 and 5–7 s at frame 48.
    await insertTwoRanges(page, seqId, mediaId);
    await expect(page.getByTestId('program-empty-hint')).toHaveCount(0);

    // Program panel is mounted with its canvas sized to the sequence, capped to the monitor's on-screen size. The
    // docked monitor is far narrower than the 1920 px sequence, so this exercises the cap on every platform.
    await page.waitForSelector(CANVAS, { timeout: 30_000 });
    await page.waitForSelector('[data-testid="program-panel"]');
    await expect.poll(() => page.evaluate((sel) => (document.querySelector(sel) as HTMLCanvasElement).width, CANVAS)).toBeGreaterThan(100);
    const docked = await expectCanvasSize(page, 'docked, full resolution');
    expect(docked.capped).toBe(true);
    expect(docked.actual.w).toBeLessThan(docked.uncapped.w);

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
    // Half of 1920x1080 is 960x540, capped to the maximized monitor's box when that is smaller on screen (the
    // Windows runner's window leaves a box about 514 px tall: 913x514; xvfb leaves 1271x714, uncapped).
    const half = await expectCanvasSize(page, 'maximized, 1/2 resolution');
    expect(half.uncapped).toEqual({ w: 960, h: 540 });
    if (!half.capped) expect(half.actual).toEqual({ w: 960, h: 540 });
    else expect(half.actual.w).toBeLessThan(960);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ROOT, 'docs/screenshots/program-maximized.png') });
    await page.click('[data-testid="program-maximize"]');
    await page.waitForTimeout(200);
    expect(await page.evaluate((sel) => document.querySelector(sel) === (window as any).__programCanvas, CANVAS)).toBe(true);
    // Docked again, the canvas follows the smaller box.
    const restored = await expectCanvasSize(page, 'docked again, 1/2 resolution');
    expect(restored.actual.w).toBeLessThanOrEqual(half.actual.w);
  });

  test('Play In to Out stops at Out when Loop is off (E-15)', async () => {
    const { page } = launched;
    test.setTimeout(60_000);
    const { seqId } = await twoClipProject(launched);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.evaluate(({ seqId }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: 0, inPoint: 24, outPoint: 48 }); }, { seqId });
    if ((await page.getByTestId('program-loop-toggle').getAttribute('aria-pressed')) === 'true') await page.click('[data-testid="program-loop-toggle"]');
    await page.focus('[data-testid="program-panel"]');
    await page.keyboard.press('ControlOrMeta+Shift+Space');
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
    const { seqId } = await twoClipProject(launched); // video on V1 under the image
    const png = path.join(tmp, 'still-magenta.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=magenta:s=320x180:d=1', '-frames:v', '1', png]);
    const [imgId] = await importMedia(page, [png]);
    expect(await getState<string>(page, `(s) => s.project.media[${JSON.stringify(imgId)}].kind`)).toBe('image');
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

  test('a cut between two clips of one file reuses the pooled element and lands on the right frame', async () => {
    const { page } = launched;
    test.setTimeout(90_000);
    // V1 holds 1–3 s of movie 1 at frames 0–47 and 5–7 s of the same file at 48–95. Elements are pooled per
    // (file, kind, slot), so both clips use the same <video>: crossing the cut is a seek, not a new element.
    const { seqId } = await twoClipProject(launched);
    /** 8x8 grid of mean luma over the whole frame. */
    const signature = () => page.evaluate((sel) => {
      const c = document.querySelector(sel) as HTMLCanvasElement;
      const w = c.width, h = c.height;
      const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
      const out: number[] = [];
      for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
        let s = 0, n = 0;
        for (let y = Math.floor(gy * h / 8); y < Math.floor((gy + 1) * h / 8); y += 3) for (let x = Math.floor(gx * w / 8); x < Math.floor((gx + 1) * w / 8); x += 3) {
          const i = (y * w + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; n++;
        }
        out.push(Math.round(s / Math.max(1, n) / 3));
      }
      return out.join(',');
    }, CANVAS);
    /** Seek (paused) and wait until the drawn frame stops changing. */
    const settleAt = async (frame: number): Promise<string> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(({ seqId, frame }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: frame }); }, { seqId, frame });
      let prev = '';
      let sig = '';
      await expect.poll(async () => { prev = sig; await page.waitForTimeout(250); sig = await signature(); return sig === prev && sig.split(',').some((v) => Number(v) > 20); }, { timeout: 20_000, intervals: [0] }).toBe(true);
      return sig;
    };
    // The first clip loads its element; from here on, no <video> may be created (the second clip must reuse it).
    await settleAt(10);
    await page.evaluate(() => {
      const w = window as unknown as { __videosCreated: number; __restoreCreateElement(): void };
      w.__videosCreated = 0;
      const original = document.createElement;
      const ce = original.bind(document);
      document.createElement = ((tag: string, o?: ElementCreationOptions) => { if (tag.toLowerCase() === 'video') w.__videosCreated++; return ce(tag, o); }) as typeof document.createElement;
      w.__restoreCreateElement = () => { document.createElement = original; };
    });
    try {
      const at10: string[] = [];
      const at70: string[] = [];
      for (let i = 0; i < 4; i++) { at70.push(await settleAt(70)); at10.push(await settleAt(10)); }
      expect(new Set(at10).size).toBe(1);
      expect(new Set(at70).size).toBe(1);
      expect(at10[0]).not.toBe(at70[0]); // 1.4 s vs 5.9 s into the movie: different burned-in frame
      expect(await page.evaluate(() => (window as unknown as { __videosCreated: number }).__videosCreated)).toBe(0);
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreCreateElement(): void }).__restoreCreateElement());
    }
  });

  test('a seek that never completes does not freeze the monitor: it is issued again', async () => {
    // bugs/closed/2026-10-09-program-scrub-stalls-on-unready-element.md: Chromium left a pooled element's paused seek
    // pending for good (seeking, readyState HAVE_METADATA). The player waited for it for ever: no seek for the rest
    // of the scrub, and not even at rest. Here the first seek of the drag is made to look stalled (the element's
    // `seeking` / `readyState` report it in flight until the app seeks it again; the real seek underneath is normal).
    const { page } = launched;
    test.setTimeout(90_000);
    const { seqId } = await twoClipProject(launched);
    const signature = () => page.evaluate((sel) => {
      const c = document.querySelector(sel) as HTMLCanvasElement;
      const w = c.width, h = c.height;
      const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
      const out: number[] = [];
      for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
        let s = 0, n = 0;
        for (let y = Math.floor(gy * h / 8); y < Math.floor((gy + 1) * h / 8); y += 3) for (let x = Math.floor(gx * w / 8); x < Math.floor((gx + 1) * w / 8); x += 3) {
          const i = (y * w + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; n++;
        }
        out.push(Math.round(s / Math.max(1, n) / 3));
      }
      return out.join(',');
    }, CANVAS);
    const settleAt = async (frame: number): Promise<string> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.evaluate(({ seqId, frame }) => { (window as any).__recut.store.getState().setView(seqId, { playhead: frame }); }, { seqId, frame });
      let prev = '';
      let sig = '';
      await expect.poll(async () => { prev = sig; await page.waitForTimeout(250); sig = await signature(); return sig === prev && sig.split(',').some((v) => Number(v) > 20); }, { timeout: 20_000, intervals: [0] }).toBe(true);
      return sig;
    };
    const at70 = await settleAt(70);
    await settleAt(10);
    await page.evaluate(() => {
      const P = HTMLMediaElement.prototype;
      const ct = Object.getOwnPropertyDescriptor(P, 'currentTime')!;
      const sk = Object.getOwnPropertyDescriptor(P, 'seeking')!;
      const rs = Object.getOwnPropertyDescriptor(P, 'readyState')!;
      const S = { armed: true, stalled: null as HTMLMediaElement | null, resought: 0 };
      Object.defineProperty(P, 'currentTime', { configurable: true, get() { return ct.get!.call(this); }, set(v: number) {
        if (S.stalled === this) { S.stalled = null; S.resought++; } else if (S.armed && this instanceof HTMLVideoElement) { S.armed = false; S.stalled = this; }
        ct.set!.call(this, v);
      } });
      Object.defineProperty(P, 'seeking', { configurable: true, get() { return S.stalled === this || sk.get!.call(this); } });
      Object.defineProperty(P, 'readyState', { configurable: true, get() { return S.stalled === this ? 1 : rs.get!.call(this); } });
      const w = window as unknown as { __stallFake: typeof S; __restoreStallFake(): void };
      w.__stallFake = S;
      w.__restoreStallFake = () => { Object.defineProperty(P, 'currentTime', ct); Object.defineProperty(P, 'seeking', sk); Object.defineProperty(P, 'readyState', rs); };
    });
    try {
      // A 2.5 s drag over the two clips, one playhead move per display frame (as a mouse drag does).
      await page.evaluate(async (seqId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const st = (window as any).__recut.store;
        const t0 = performance.now();
        let f = 10;
        await new Promise<void>((done) => {
          const tick = () => { if (performance.now() - t0 > 2500) return done(); f = f >= 90 ? 10 : f + 2; st.getState().setView(seqId, { playhead: f }); requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
      }, seqId);
      const S = await page.evaluate(() => { const { armed, stalled, resought } = (window as unknown as { __stallFake: { armed: boolean; stalled: unknown; resought: number } }).__stallFake; return { armed, stalled: stalled !== null, resought }; });
      expect(S.armed).toBe(false); // the drag did seek the Program element, and that seek stalled
      expect(S.resought).toBe(1); // the player gave up on it during the drag and sought the element again
      expect(S.stalled).toBe(false);
      // At rest the monitor shows the playhead frame, as it does without a stall.
      expect(await settleAt(70)).toBe(at70);
    } finally {
      await page.evaluate(() => (window as unknown as { __restoreStallFake(): void }).__restoreStallFake());
    }
  });
});
