/**
 * Nested sequences and compound clips (Roadmap §8): real Electron app, real ffmpeg.
 *  1. A 24 fps sequence: "Galaxy Saga 1" 2–4 s (red) at 0 and 6–8 s (orange) at 48. Select both picture clips,
 *     right-click → Make Compound Clip: the four clips become one linked nested video + audio pair (NEST badge), in
 *     one undo step. Double-click the nested clip: its sequence opens in the timeline. Inside, overwrite the second
 *     clip with 8–10 s (yellow). Back on the outer sequence the Inspector shows the nested sequence, and the export
 *     shows the edit: 0–2 s red, 2–4 s yellow.
 *  2. A sequence dragged from the Project panel and dropped on the timeline is nested there; dropping a sequence on
 *     itself is refused.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { JobInfo } from '../../shared/model';
import { launchApp, makeTestMedia, importMedia, ffprobeJson, frameColor, MEDIA, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

type W = { __recut: { store: { getState(): any }; runCommand(id: string): boolean; jobsStore: { getState(): { jobs: JobInfo[] } } } };

let ctx: LaunchedApp;
let page: Page;
let outDir: string;
let movieId: string;
let outerId: string;
let innerId: string;

const st = <T,>(fn: string, arg?: unknown): Promise<T> =>
  page.evaluate(({ src, arg }) => {
    const w = window as unknown as W;
    // eslint-disable-next-line no-new-func
    return new Function('st', 'arg', `return (${src})(st, arg)`)(w.__recut.store.getState(), arg);
  }, { src: fn, arg }) as Promise<T>;

const run = (id: string) => page.evaluate((c) => (window as unknown as W).__recut.runCommand(c), id);

/** [start, duration, sequenceId] of the clips on a track of a sequence. */
const clipsOf = (seqId: string, kind: 'video' | 'audio', i = 0) =>
  st<[number, number, string | null][]>(`(s, a) => (a.kind === 'video' ? s.project.sequences[a.seqId].videoTracks : s.project.sequences[a.seqId].audioTracks)[a.i].clips
    .map((c) => [c.start, c.duration, c.sequenceId ?? null])`, { seqId, kind, i });

test.beforeAll(async () => {
  ctx = await launchApp();
  page = ctx.page;
  const mediaDir = makeTestMedia(ctx.tmp, 'short');
  outDir = path.join(ctx.tmp, 'export-nest');
  fs.mkdirSync(outDir, { recursive: true });
  [movieId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
  outerId = await st<string>(`(s, id) => {
    const seqId = s.project.activeSequenceId;
    s.updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } });
    s.renameSequence(seqId, 'Trilogy cut');
    s.insertFromSource(seqId, { mediaId: id, in: 2, out: 4, atFrame: 0, mode: 'insert' });
    s.insertFromSource(seqId, { mediaId: id, in: 6, out: 8, atFrame: 48, mode: 'insert' });
    s.selectMedia([]);
    return seqId;
  }`, movieId);
});

test.afterAll(async () => { await ctx?.app.close(); });

test('Make Compound Clip, Open in Timeline, edit inside: the outer timeline and the export follow', async () => {
  // Select both picture clips, then Make Compound Clip from the clip's context menu.
  const ids = await st<string[]>(`(s, id) => s.project.sequences[id].videoTracks[0].clips.map((c) => c.id)`, outerId);
  expect(ids).toHaveLength(2);
  await st(`(s, ids) => s.select(ids, 'set')`, ids);
  const first = page.locator(`.tl-clip[data-clip-id="${ids[0]}"]`);
  await expect(first).toBeVisible();
  const b = (await first.boundingBox())!;
  await page.mouse.click(b.x + Math.min(b.width / 2, 40), b.y + b.height / 2, { button: 'right' });
  await page.locator('.menu-item', { hasText: 'Make Compound Clip' }).click();

  const nestedV = await clipsOf(outerId, 'video');
  expect(nestedV).toHaveLength(1);
  innerId = nestedV[0][2]!;
  expect(nestedV[0]).toEqual([0, 96, innerId]);
  expect(await clipsOf(outerId, 'audio')).toEqual([[0, 96, innerId]]);
  expect(await st<string>(`(s, id) => s.project.sequences[id].name`, innerId)).toBe('Nested Sequence 01');
  expect(await clipsOf(innerId, 'video')).toEqual([[0, 48, null], [48, 48, null]]);
  await expect(page.locator('.tl-clip.nested')).toHaveCount(2);
  await expect(page.locator('.tl-clip.nested .tl-badge.nested').first()).toHaveText('NEST');

  // One undo step: undo puts the four clips back, redo nests them again.
  expect(await run('edit.undo')).toBe(true);
  expect(await clipsOf(outerId, 'video')).toEqual([[0, 48, null], [48, 48, null]]);
  expect(await st<boolean>(`(s, id) => !!s.project.sequences[id]`, innerId)).toBe(false);
  expect(await run('edit.redo')).toBe(true);
  expect(await clipsOf(outerId, 'video')).toEqual([[0, 96, innerId]]);

  // Double-click the nested clip: its sequence opens in the timeline.
  const nestedClipId = await st<string>(`(s, id) => s.project.sequences[id].videoTracks[0].clips[0].id`, outerId);
  await st(`(s, id) => s.setView(s.project.activeSequenceId, { playhead: 60 })`);
  const nb = (await page.locator(`.tl-clip[data-clip-id="${nestedClipId}"]`).boundingBox())!;
  await page.mouse.dblclick(nb.x + Math.min(nb.width / 2, 40), nb.y + nb.height / 2);
  await expect.poll(() => st<string>(`(s) => s.project.activeSequenceId`)).toBe(innerId);
  expect(await st<number>(`(s, id) => s.project.sequences[id].view.playhead`, innerId)).toBe(60);
  await expect(page.locator('.tl-clip.nested')).toHaveCount(0);

  // Edit inside: the second shot becomes 8–10 s (yellow).
  await st(`(s, a) => s.insertFromSource(a.inner, { mediaId: a.movie, in: 8, out: 10, atFrame: 48, mode: 'overwrite' })`, { inner: innerId, movie: movieId });
  expect(await clipsOf(innerId, 'video')).toEqual([[0, 48, null], [48, 48, null]]);

  // Back on the outer sequence: the nested clip is unchanged; the Inspector shows its sequence.
  await st(`(s, a) => { s.setActiveSequence(a.outer); s.select([a.clip], 'set'); }`, { outer: outerId, clip: nestedClipId });
  const insp = page.getByTestId('inspector');
  await expect(insp).toContainText('Sequence: Nested Sequence 01');
  await expect(insp.getByTestId('nested-range')).toBeVisible();
  await expect(insp.getByTestId('open-nested')).toBeVisible();

  // Export the outer sequence: the edit made inside shows.
  await st(`(s) => { s.select([], 'set'); s.openDialog('export'); }`);
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill('nested.mp4');
  await page.getByTestId('export-preset').selectOption('720p Preview');
  await expect(page.getByTestId('export-checklist')).not.toContainText('missing');
  const start = page.getByTestId('export-start');
  await expect(start).toBeEnabled();
  await start.click();
  await page.waitForFunction(() => (window as unknown as W).__recut.jobsStore.getState().jobs
    .some((j) => j.kind === 'export' && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled')), undefined, { timeout: 150_000 });
  const job = await page.evaluate(() => (window as unknown as W).__recut.jobsStore.getState().jobs.find((j) => j.kind === 'export')!);
  expect(job.status, job.error ?? '').toBe('done');
  await expect(page.getByTestId('export-done')).toBeVisible();
  await page.keyboard.press('Escape');

  const out = path.join(outDir, 'nested.mp4');
  const info = ffprobeJson(out);
  expect(Math.abs(Number(info.format.duration) - 4.0)).toBeLessThanOrEqual(0.1);
  expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  const c1 = frameColor(out, 1), c3 = frameColor(out, 3);
  expect(c1.r, JSON.stringify(c1)).toBeGreaterThan(180); expect(c1.g).toBeLessThan(70); expect(c1.b).toBeLessThan(70);
  expect(c3.r, JSON.stringify(c3)).toBeGreaterThan(180); expect(c3.g).toBeGreaterThan(180); expect(c3.b).toBeLessThan(70);
});

test('a sequence dropped on the timeline is nested there; a sequence cannot be nested in itself', async () => {
  /** Drop sequence `id` on the active timeline at `frame` on V1 (an HTML5 drop carrying the Project panel's type). */
  const drop = (id: string, frame: number) => page.evaluate(({ id, frame }) => {
    const w = window as unknown as W;
    const s = w.__recut.store.getState();
    const seq = s.project.sequences[s.project.activeSequenceId];
    const content = [...document.querySelectorAll<HTMLElement>('.tl-tracks-content')].find((el) => el.offsetParent !== null)!;
    const view = content.querySelector<HTMLElement>('.tl-tracks-view')!;
    const v1 = document.querySelector<HTMLElement>(`.tl-clip[data-track-id="${seq.videoTracks[0].id}"]`);
    const r = view.getBoundingClientRect();
    const y = v1 ? v1.getBoundingClientRect().top + 4 : r.top + 10;
    const x = r.left + (frame - seq.view.scroll) * seq.view.zoom;
    const dt = new DataTransfer();
    dt.setData('application/x-recut-sequence', id);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      content.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }
  }, { id, frame });

  await st(`(s, id) => s.setActiveSequence(id)`, outerId);
  await drop(innerId, 96);
  await expect.poll(() => clipsOf(outerId, 'video')).toEqual([[0, 96, innerId], [96, 96, innerId]]);
  expect(await clipsOf(outerId, 'audio')).toEqual([[0, 96, innerId], [96, 96, innerId]]);
  // One undo step.
  expect(await run('edit.undo')).toBe(true);
  expect(await clipsOf(outerId, 'video')).toEqual([[0, 96, innerId]]);

  // Inside the nested sequence, dropping the outer one (which contains it) is refused.
  await st(`(s, id) => s.setActiveSequence(id)`, innerId);
  await drop(outerId, 0);
  await expect.poll(() => st<string>(`(s) => s.ui.toasts.map((t) => t.text).join(' | ')`)).toContain('Cannot nest the sequence here');
  expect(await clipsOf(innerId, 'video')).toEqual([[0, 48, null], [48, 48, null]]);
});
