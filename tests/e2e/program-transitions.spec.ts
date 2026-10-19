/**
 * Program Monitor transitions in the real renderer (bugs/closed/2026-10-08-two-sided-transition-preview-mismatch.md @ 59eafc6):
 * a Cross Dissolve is the linear mix of its two clips (the canvas adds the pair with `lighter` in a scratch canvas,
 * then draws the sum over what is below), a Dip to Black fades each clip over half its length. Flat-colour stills, so
 * every pixel value is known: white 255, gray 128, dark 64.
 * Run: npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/program-transitions.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchApp, importMedia, getState, type LaunchedApp } from './helpers';

const CANVAS = '[data-testid="program-canvas"]';
const WHITE = 255, GRAY = 128, DARK = 64;
/** Allowed error per channel (8-bit canvas rounding in the scratch canvas and the final draw). */
const TOL = 3;

/** Mean RGB (as one value) of a 5x5 block at (fx, fy) of the canvas. */
function sample(page: Page, fx: number, fy: number): Promise<number> {
  return page.evaluate(({ sel, fx, fy }) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(Math.floor(c.width * fx) - 2, Math.floor(c.height * fy) - 2, 5, 5).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return s / (d.length / 4);
  }, { sel: CANVAS, fx, fy });
}

/** Waits until the canvas at (fx, fy) shows `want` (within TOL); the message names the frame and the last value. */
async function expectPixel(page: Page, frame: number, fx: number, fy: number, want: number, label: string): Promise<void> {
  await page.evaluate((f) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (window as any).__recut.store.getState();
    st.setView(st.project.activeSequenceId, { playhead: f, inPoint: null, outPoint: null });
  }, frame);
  let last = -1;
  await expect.poll(async () => { last = await sample(page, fx, fy); return Math.abs(last - want) <= TOL; },
    { message: `${label}: frame ${frame} at (${fx}, ${fy}) wants ${want.toFixed(1)}`, timeout: 20_000, intervals: [100, 250] }).toBe(true);
  console.log(`[program transitions] ${label}: frame ${frame} (${fx}, ${fy}) = ${last.toFixed(1)}, expected ${want.toFixed(1)}`);
}

interface Setup { seqId: string; v1: string; v2: string; ids: Record<'white' | 'gray' | 'dark', string> }

/** A fresh project with three flat-colour stills imported (320x180, the sequence's 16:9 shape). */
async function freshProject(launched: LaunchedApp): Promise<Setup> {
  const { page, tmp } = launched;
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__recut.store;
    store.setState({ dirty: false });
    store.getState().newProject();
  });
  const files = { white: 'ffffff', gray: '808080', dark: '404040' } as const;
  const paths = Object.entries(files).map(([name, hex]) => {
    const png = path.join(tmp, `still-${name}.png`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=320x180:d=1`, '-frames:v', '1', png]);
    return png;
  });
  const [white, gray, dark] = await importMedia(page, paths);
  const seqId = await getState<string>(page, '(s) => s.project.activeSequenceId');
  const [v1, v2] = await getState<string[]>(page, `(s) => s.project.sequences[${JSON.stringify(seqId)}].videoTracks.map((t) => t.id)`);
  return { seqId, v1, v2, ids: { white, gray, dark } };
}

/** Puts a still on a track over [atFrame, atFrame + 48) and returns its clip id. */
async function put(page: Page, s: Setup, mediaId: string, trackId: string, atFrame: number): Promise<string> {
  const placed = await page.evaluate(({ seqId, mediaId, trackId, atFrame }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (window as any).__recut.store.getState();
    const fps = st.project.sequences[seqId].fps;
    const id: string = st.insertFromSource(seqId, { mediaId, in: 0, out: (48 * fps.den) / fps.num, atFrame, mode: 'overwrite', videoTrackId: trackId, includeAudio: false })[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (window as any).__recut.store.getState().project.sequences[seqId].videoTracks.flatMap((t: any) => t.clips).find((x: any) => x.id === id);
    return { id, start: c?.start, duration: c?.duration };
  }, { seqId: s.seqId, mediaId, trackId, atFrame });
  expect([placed.start, placed.duration]).toEqual([atFrame, 48]);
  return placed.id;
}

test.describe('Program Monitor transitions', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => { launched = await launchApp(); });
  test.afterAll(async () => { await launched?.app.close(); });

  test('a Cross Dissolve is the linear mix; a Dip to Black fades over each half', async () => {
    const { page } = launched;
    test.setTimeout(90_000);
    const s = await freshProject(launched);
    await put(page, s, s.ids.white, s.v1, 0);
    await put(page, s, s.ids.gray, s.v1, 48);
    await put(page, s, s.ids.dark, s.v1, 96);
    const made = await page.evaluate(({ seqId, v1 }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (window as any).__recut.store.getState();
      return [st.addTransitionAtCut(seqId, v1, 48, 'crossDissolve', 12), st.addTransitionAtCut(seqId, v1, 96, 'dipToBlack', 12)].map((t) => t && t.duration);
    }, s);
    expect(made).toEqual([12, 12]);
    // Dissolve 42..54: t = (f − 42) / 12. Drawn one over the other (before), frame 48 showed 127.8, not 191.5.
    await expectPixel(page, 48, 0.5, 0.5, (WHITE + GRAY) / 2, 'dissolve mid');
    await expectPixel(page, 45, 0.5, 0.5, 0.75 * WHITE + 0.25 * GRAY, 'dissolve quarter');
    await expectPixel(page, 51, 0.5, 0.5, 0.25 * WHITE + 0.75 * GRAY, 'dissolve three quarters');
    // Dip 90..102: gray to black over 90..96 (weight (96 − f) / 6), dark from black over 96..102.
    await expectPixel(page, 93, 0.5, 0.5, 0.5 * GRAY, 'dip out');
    await expectPixel(page, 96, 0.5, 0.5, 0, 'dip black');
    await expectPixel(page, 99, 0.5, 0.5, 0.5 * DARK, 'dip in');
  });

  test('a dissolve on V2 mixes over V1, with opacity and a picture that does not cover the frame', async () => {
    const { page } = launched;
    test.setTimeout(90_000);
    const s = await freshProject(launched);
    await put(page, s, s.ids.gray, s.v1, 0);
    await put(page, s, s.ids.gray, s.v1, 48);
    const a = await put(page, s, s.ids.white, s.v2, 0);
    const b = await put(page, s, s.ids.dark, s.v2, 48);
    await page.evaluate(({ seqId, v2, a, b }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (window as any).__recut.store.getState();
      st.setClipTransform(seqId, a, { opacity: 0.6 });
      st.setClipTransform(seqId, b, { scale: 0.5 }); // the centre quarter of the frame only
      st.addTransitionAtCut(seqId, v2, 48, 'crossDissolve', 12);
    }, { seqId: s.seqId, v2: s.v2, a, b });
    const overGray = (v: number, op: number) => op * v + (1 - op) * GRAY;
    // Centre, t = 1/2: (white at 0.6 over gray + dark over gray) / 2. Drawn one over the other (before): 115.
    await expectPixel(page, 48, 0.5, 0.5, 0.5 * overGray(WHITE, 0.6) + 0.5 * DARK, 'V2 centre');
    // Outside the small picture only the outgoing clip fades, over V1.
    await expectPixel(page, 48, 0.1, 0.1, 0.5 * overGray(WHITE, 0.6) + 0.5 * GRAY, 'V2 corner');
    await expectPixel(page, 45, 0.5, 0.5, 0.75 * overGray(WHITE, 0.6) + 0.25 * DARK, 'V2 centre quarter');
  });
});
