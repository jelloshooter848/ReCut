/**
 * Keyframes e2e (Roadmap §11): add keyframes in the Inspector (diamond button, value fields at the playhead,
 * previous / next, ease), see them on the timeline clip, play through them, and export: the exported picture follows
 * the keyframed opacity.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, frameColor, MEDIA, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let page: Page;
let videoId: string;
let audioId: string;
let outDir: string;

const insp = () => page.getByTestId('inspector');
const store = <T,>(fn: string, arg?: unknown): Promise<T> =>
  page.evaluate(({ src, arg }) => {
    const w = window as unknown as { __recut: { store: { getState(): unknown } } };
    // eslint-disable-next-line no-new-func
    return new Function('st', 'arg', `return (${src})(st, arg)`)(w.__recut.store.getState(), arg);
  }, { src: fn, arg }) as Promise<T>;
const setPlayhead = (f: number) => store(`(st, f) => st.setView(st.project.activeSequenceId, { playhead: f })`, f);
const clipOf = <T,>(id: string, pick: string) => getState<T>(page, `s => { const q = s.project.sequences[s.project.activeSequenceId]; for (const t of [...q.videoTracks, ...q.audioTracks]) for (const c of t.clips) if (c.id === ${JSON.stringify(id)}) return (${pick})(c); return null; }`);

async function typeNumber(selector: string, value: string) {
  const field = insp().locator(selector).first();
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await expect(field.locator('input')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
}

test.beforeAll(async () => {
  ctx = await launchApp();
  page = ctx.page;
  const mediaDir = makeTestMedia(ctx.tmp, 'short');
  outDir = path.join(ctx.tmp, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const [movie] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
  const ids = await store<string[]>(`(st, id) => { const seqId = st.project.activeSequenceId; st.updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } }); return st.insertFromSource(seqId, { mediaId: id, in: 0, out: 3, atFrame: 0, mode: 'insert' }); }`, movie);
  const kinds = await getState<Record<string, string>>(page, `s => { const q = s.project.sequences[s.project.activeSequenceId]; const o = {}; for (const t of [...q.videoTracks, ...q.audioTracks]) for (const c of t.clips) o[c.id] = c.kind; return o; }`);
  videoId = ids.find((id) => kinds[id] === 'video')!;
  audioId = ids.find((id) => kinds[id] === 'audio')!;
});

test.afterAll(async () => { await ctx?.app.close(); });

test('opacity and position keyframes from the Inspector, one undo step each', async () => {
  await store(`(st, id) => st.select([id])`, videoId);
  await expect(insp()).toHaveAttribute('data-mode', 'clip');
  await setPlayhead(0);
  const past = () => getState<number>(page, 's => s.history.past.length');
  const before = await past();
  await insp().getByTestId('kf-opacity').click();
  expect(await past()).toBe(before + 1);
  expect(await clipOf(videoId, 'c => c.transform.keyframes.opacity')).toEqual([{ frame: 0, value: 1 }]);
  await expect(insp().getByTestId('kf-opacity')).toHaveAttribute('data-on', '1');

  // The value field at another playhead position adds a keyframe there.
  await setPlayhead(24);
  await expect(insp().getByTestId('kf-opacity')).toHaveAttribute('data-on', '0');
  await typeNumber('[data-prop="opacity"] .numfield', '20');
  expect(await clipOf(videoId, 'c => c.transform.keyframes.opacity')).toEqual([{ frame: 0, value: 1 }, { frame: 24, value: 0.2 }]);
  await expect(insp().locator('[data-prop="opacity-keyframes"]')).toContainText('2 keyframes');

  // Previous keyframe moves the playhead to 0; make the first segment ease; opacity 0 there.
  await insp().getByTestId('kf-opacity-prev').click();
  await expect.poll(() => getState<number>(page, 's => s.project.sequences[s.project.activeSequenceId].view.playhead')).toBe(0);
  await insp().getByTestId('kf-opacity-interp').selectOption('ease');
  await typeNumber('[data-prop="opacity"] .numfield', '0');
  expect(await clipOf(videoId, 'c => c.transform.keyframes.opacity')).toEqual([{ frame: 0, value: 0, interp: 'ease' }, { frame: 24, value: 0.2 }]);
  await insp().getByTestId('kf-opacity-next').click();
  await expect.poll(() => getState<number>(page, 's => s.project.sequences[s.project.activeSequenceId].view.playhead')).toBe(24);

  // Position: a keyframe at 0, then X = 200 at frame 47.
  await setPlayhead(0);
  await insp().getByTestId('kf-position').click();
  await setPlayhead(47);
  await typeNumber('[data-prop="position"] .numfield', '200');
  expect(await clipOf(videoId, 'c => c.transform.keyframes.x')).toEqual([{ frame: 0, value: 0 }, { frame: 47, value: 200 }]);
  expect(await clipOf(videoId, 'c => c.transform.keyframes.y')).toEqual([{ frame: 0, value: 0 }, { frame: 47, value: 0 }]);

  // Undo removes the last edit only.
  await store(`(st) => st.undo()`);
  expect(await clipOf(videoId, 'c => c.transform.keyframes.x')).toEqual([{ frame: 0, value: 0 }]);
  await store(`(st) => st.redo()`);

  // Read-only diamonds on the timeline clip: frames 0, 24 and 47.
  await expect(page.locator(`.tl-clip[data-clip-id="${videoId}"] .tl-keyframe`)).toHaveCount(3);
});

test('level keyframes on the audio clip', async () => {
  await store(`(st, id) => st.select([id])`, audioId);
  await setPlayhead(0);
  await insp().getByTestId('kf-volume').click();
  await setPlayhead(48);
  await typeNumber('[data-prop="volume"] .numfield', '10');
  expect(await clipOf(audioId, 'c => c.audio.keyframes.volume')).toEqual([{ frame: 0, value: 1 }, { frame: 48, value: 0.1 }]);
  await expect(page.locator(`.tl-clip[data-clip-id="${audioId}"] .tl-keyframe`)).toHaveCount(2);
});

test('plays through the keyframes', async () => {
  await setPlayhead(0);
  await page.getByTestId('program-play').click();
  await expect.poll(() => getState<number>(page, 's => s.project.sequences[s.project.activeSequenceId].view.playhead'), { timeout: 10_000 }).toBeGreaterThan(30);
  await page.getByTestId('program-play').click();
  await expect(page.getByTestId('program-missing')).toHaveCount(0);
});

test('exports the keyframed opacity', async () => {
  await store(`(st) => st.openDialog('export')`);
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill('keyframes.mp4');
  await page.getByTestId('export-preset').selectOption('720p Preview');
  await expect(page.getByTestId('export-checklist')).toContainText('Keyframes on 2 clips');
  await page.getByTestId('export-start').click();
  await page.waitForFunction(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: { kind: string; status: string }[] } } } };
    return w.__recut.jobsStore.getState().jobs.some((j) => j.kind === 'export' && ['done', 'failed', 'canceled'].includes(j.status));
  }, undefined, { timeout: 150_000 });
  const job = await page.evaluate(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: { kind: string; status: string; error?: string }[] } } } };
    return w.__recut.jobsStore.getState().jobs.find((j) => j.kind === 'export')!;
  });
  expect(job.status, job.error ?? '').toBe('done');
  const out = path.join(outDir, 'keyframes.mp4');
  // Red source: opacity 0 at frame 0 (black), 0.2 at frame 24 (dim red, the picture 102 px to the right), 0.2 at 60.
  const c0 = frameColor(out, 0.01), c1 = frameColor(out, 1.01), c2 = frameColor(out, 2.5);
  expect(c0.r, JSON.stringify(c0)).toBeLessThan(15);
  expect(c1.r, JSON.stringify(c1)).toBeGreaterThan(20);
  expect(c1.r, JSON.stringify(c1)).toBeLessThan(60);
  expect(c2.r, JSON.stringify(c2)).toBeGreaterThan(20);
  expect(c2.r, JSON.stringify(c2)).toBeLessThan(60);
});
