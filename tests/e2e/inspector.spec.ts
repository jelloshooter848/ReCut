/**
 * Inspector panel e2e: context switching (sequence → clip → audio clip → transition → media), the original-source
 * timecode block, transform/audio edits through the scrubbable fields (one undo step each) and media identity batch edits.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, ROOT, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let page: Page;
let mediaDir: string;
let movieId: string;
let videoClipId: string;
let audioClipId: string;

const evalStore = <T,>(p: Page, fn: string, arg?: unknown): Promise<T> =>
  p.evaluate(({ src, arg }) => {
    const w = window as unknown as { __recut: { store: { getState(): unknown } } };
    // eslint-disable-next-line no-new-func
    return new Function('st', 'arg', `return (${src})(st, arg)`)(w.__recut.store.getState(), arg);
  }, { src: fn, arg }) as Promise<T>;

/** Click a scrubbable NumberField (enters edit mode), type a value and press Enter. */
async function typeNumber(p: Page, selector: string, value: string) {
  const field = p.locator(selector).first();
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await expect(field.locator('input')).toBeVisible();
  await p.keyboard.press('Control+A');
  await p.keyboard.type(value);
  await p.keyboard.press('Enter');
}

test.beforeAll(async () => {
  ctx = await launchApp();
  page = ctx.page;
  mediaDir = makeTestMedia(ctx.tmp, 'short');
  const ids = await importMedia(page, [path.join(mediaDir, MEDIA.movie1), path.join(mediaDir, MEDIA.ep1)]);
  movieId = ids[0];
});

test.afterAll(async () => { await ctx?.app.close(); });

test('shows the sequence inspector when nothing is selected', async () => {
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toHaveAttribute('data-mode', 'sequence');
  await expect(page.getByTestId('sequence-header')).toBeVisible();
  const name = page.locator('[data-prop="sequence-name"]');
  await name.fill('Inspector Cut');
  await name.press('Enter');
  expect(await getState<string>(page, 's => s.project.sequences[s.project.activeSequenceId].name')).toBe('Inspector Cut');
  await page.getByTestId('take-snapshot').click();
  await page.getByTestId('inline-form').getByRole('button', { name: 'Save' }).click();
  expect(await getState<number>(page, 's => s.project.sequences[s.project.activeSequenceId].snapshots.length')).toBe(1);
  await expect(page.getByTestId('snapshot')).toHaveCount(1);
});

test('clip inspector shows the original source timecode and filename', async () => {
  const clipIds = await evalStore<string[]>(page, `(st, mediaId) => st.insertFromSource(st.project.activeSequenceId, { mediaId, in: 2, out: 6, atFrame: 0, mode: 'insert' })`, movieId);
  expect(clipIds.length).toBe(2);
  const kinds = await evalStore<Record<string, string>>(page, `(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; const out = {}; for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) out[c.id] = c.kind; return out; }`);
  videoClipId = clipIds.find((id) => kinds[id] === 'video')!;
  audioClipId = clipIds.find((id) => kinds[id] === 'audio')!;
  expect(videoClipId).toBeTruthy();
  expect(audioClipId).toBeTruthy();

  await evalStore(page, `(st, id) => st.select([id])`, videoClipId);
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-mode', 'clip');
  // source in = 2s at the media's 24 fps → 00:00:02:00; playhead (frame 0) is inside the clip, so "at playhead" == clip start
  await expect(page.getByTestId('source-tc')).toHaveText('00:00:02:00');
  await expect(page.getByTestId('source-file')).toContainText('Galaxy Saga 1 - A New Dawn.mp4');
  await expect(page.getByTestId('source-range')).toContainText('00:00:02:00');
  await expect(page.getByTestId('source-range')).toContainText('00:00:06:00');

  // move the playhead 24 sequence frames in (23.976 fps → ~1.001s) and check the timecode follows
  await evalStore(page, `(st) => st.setView(st.project.activeSequenceId, { playhead: 24 })`);
  await expect(page.getByTestId('source-tc')).toHaveText('00:00:03:00');
  await expect(page.getByTestId('source-card')).toContainText('at playhead');
});

test('typing a Scale value updates the transform and undo reverts it in one step', async () => {
  await typeNumber(page, '[data-prop="scale"] .numfield', '150');
  const scale = () => evalStore<number>(page, `(st, id) => { const seq = st.project.sequences[st.project.activeSequenceId]; for (const t of seq.videoTracks) for (const c of t.clips) if (c.id === id) return c.transform.scale; }`, videoClipId);
  expect(await scale()).toBeCloseTo(1.5, 5);
  const label = await getState<string>(page, 's => s.history.pastLabels[s.history.pastLabels.length - 1]');
  expect(label).toBe('Transform');
  await evalStore(page, `(st) => st.undo()`);
  expect(await scale()).toBe(1);
  await expect(page.locator('[data-prop="scale"] .numfield')).toContainText('100');

  await typeNumber(page, '[data-prop="opacity"] .numfield', '50');
  const opacity = await evalStore<number>(page, `(st, id) => { const seq = st.project.sequences[st.project.activeSequenceId]; for (const t of seq.videoTracks) for (const c of t.clips) if (c.id === id) return c.transform.opacity; }`, videoClipId);
  expect(opacity).toBeCloseTo(0.5, 5);
  // reset button on the row restores the default
  await page.locator('[data-prop="opacity"]').hover();
  await page.locator('[data-prop="opacity"] .insp-reset').click();
  const reset = await evalStore<number>(page, `(st, id) => { const seq = st.project.sequences[st.project.activeSequenceId]; for (const t of seq.videoTracks) for (const c of t.clips) if (c.id === id) return c.transform.opacity; }`, videoClipId);
  expect(reset).toBe(1);
});

test('audio clip: gain and fade in', async () => {
  await evalStore(page, `(st, id) => st.select([id])`, audioClipId);
  await expect(page.getByTestId('clip-header')).toContainText('audio');
  await typeNumber(page, '[data-prop="gain"] .numfield', '-6');
  await typeNumber(page, '[data-prop="fade-in"] .numfield', '12');
  const audio = await evalStore<{ gain: number; fadeIn: number }>(page, `(st, id) => { const seq = st.project.sequences[st.project.activeSequenceId]; for (const t of seq.audioTracks) for (const c of t.clips) if (c.id === id) return c.audio; }`, audioClipId);
  expect(audio.gain).toBe(-6);
  expect(audio.fadeIn).toBe(12);
  await expect(page.locator('[data-prop="fade-in"]')).toContainText('00:00:00:12');
  // the video clip's inspector edits its linked audio: mute through the linked clip
  await evalStore(page, `(st, id) => st.select([id])`, videoClipId);
  await expect(page.locator('[data-section="audio"]')).toContainText('linked audio');
  await expect(page.locator('[data-prop="gain"] .numfield')).toContainText('-6.0');
});

test('transition: add from the clip, inspect, change duration, remove', async () => {
  await page.getByTestId('add-transition-start').click();
  const trId = await evalStore<string | null>(page, `(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; for (const t of seq.videoTracks) if (t.transitions.length) return t.transitions[0].id; return null; }`);
  expect(trId).toBeTruthy();
  await expect(page.getByTestId('transition-start')).toBeVisible();
  await page.getByTestId('transition-start').locator('.insp-tr-name').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-mode', 'transition');
  await expect(page.getByTestId('transition-header')).toContainText('Cross Dissolve');
  await typeNumber(page, '[data-prop="transition-duration"] .numfield', '12');
  const dur = await evalStore<number>(page, `(st, id) => { const seq = st.project.sequences[st.project.activeSequenceId]; for (const t of seq.videoTracks) for (const tr of t.transitions) if (tr.id === id) return tr.duration; }`, trId);
  expect(dur).toBe(12);
  await page.selectOption('[data-prop="transition-type"] select', 'dipToBlack');
  const type = await evalStore<string>(page, `(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; for (const t of seq.videoTracks) if (t.transitions.length) return t.transitions[0].type; }`);
  expect(type).toBe('dipToBlack');
  await page.getByTestId('remove-transition').click();
  const count = await evalStore<number>(page, `(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; return seq.videoTracks.reduce((n, t) => n + t.transitions.length, 0); }`);
  expect(count).toBe(0);
});

test('media inspector: category and identity', async () => {
  await evalStore(page, `(st) => { st.selectTransition(null); st.select([], 'clear'); }`);
  await evalStore(page, `(st, id) => st.selectMedia([id])`, movieId);
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-mode', 'media');
  await expect(page.getByTestId('media-header')).toContainText('video');
  await page.selectOption('[data-prop="category"] select', 'Episode');
  const series = page.locator('[data-prop="series"] input');
  await series.fill('Station Eleven');
  await series.press('Enter');
  const season = page.locator('input[data-prop="season"]');
  await season.fill('1');
  await season.press('Enter');
  const episode = page.locator('input[data-prop="episode"]');
  await episode.fill('3');
  await episode.press('Enter');
  const m = await getState<{ category: string; identity: { series?: string; season?: number; episode?: number } }>(page, `s => s.project.media['${movieId}']`);
  expect(m.category).toBe('Episode');
  expect(m.identity).toMatchObject({ series: 'Station Eleven', season: 1, episode: 3 });
  await expect(page.getByTestId('media-header')).toContainText('Station Eleven S01E03');
  // probe summary is rendered
  await expect(page.locator('[data-section="media-probe"]')).toContainText('640×360');
  await expect(page.locator('[data-section="media-probe"]')).toContainText('24 fps');

  // multi-select batch: season for both items
  const allIds = await getState<string[]>(page, 's => Object.keys(s.project.media)');
  await evalStore(page, `(st, ids) => st.selectMedia(ids)`, allIds);
  await expect(page.getByTestId('media-header')).toContainText(`${allIds.length} media items`);
  const batchSeason = page.locator('input[data-prop="season"]');
  await batchSeason.fill('2');
  await batchSeason.press('Enter');
  const seasons = await getState<number[]>(page, 's => Object.values(s.project.media).map(m => m.identity.season)');
  expect(seasons.every((n) => n === 2)).toBe(true);
});

test('screenshot', async () => {
  await evalStore(page, `(st, id) => { st.selectMedia([], 'clear'); st.select([id]); st.setView(st.project.activeSequenceId, { playhead: 30 }); }`, videoClipId);
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-mode', 'clip');
  await page.waitForTimeout(300);
  const out = path.join(ROOT, 'docs/screenshots/inspector.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  expect(fs.existsSync(out)).toBe(true);
});
