import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, getState, MEDIA, ROOT, type LaunchedApp } from './helpers';

type Clip = { id: string; kind: 'video' | 'audio'; start: number; duration: number; linkId: string | null; mediaId: string; sourceIn: number };
type Seq = { id: string; fps: { num: number; den: number }; view: { playhead: number }; videoTracks: { clips: Clip[] }[]; audioTracks: { clips: Clip[] }[] };

const MEDIA_FPS = 24;

async function videoTime(page: Page): Promise<number> {
  return page.evaluate(() => (document.querySelector('.source-panel video') as HTMLVideoElement).currentTime);
}

async function waitForVideoReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const v = document.querySelector('.source-panel video') as HTMLVideoElement | null;
    return !!v && v.readyState >= 2;
  }, undefined, { timeout: 60_000 });
}

/** Seek through the store (as the Transcript panel would) and wait for the monitor to land on that frame. */
async function seekViaStore(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => {
    const w = window as unknown as { __recut: { store: { getState(): { setSourceTime(s: number): void } } } };
    w.__recut.store.getState().setSourceTime(t);
  }, seconds);
  await page.waitForFunction((t) => {
    const v = document.querySelector('.source-panel video') as HTMLVideoElement | null;
    return !!v && !v.seeking && Math.abs(v.currentTime - t) < 0.1;
  }, seconds, { timeout: 10_000 });
}

test.describe('Source Monitor', () => {
  let launched: LaunchedApp;
  let mediaDir: string;

  test.beforeAll(async () => {
    launched = await launchApp();
    mediaDir = makeTestMedia(launched.tmp, 'short');
  });
  test.afterAll(async () => { await launched?.app.close(); });

  test('loads a clip, plays, steps, marks in/out and inserts into the sequence', async () => {
    const { page } = launched;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // Empty state before anything is loaded.
    await expect(page.locator('.source-panel .empty')).toBeVisible();

    const [mediaId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
    expect(mediaId).toBeTruthy();
    const probe = await getState<{ duration: number; browserPlayable: boolean } | undefined>(page, `(s) => s.project.media[${JSON.stringify(mediaId)}].probe`);
    expect(probe?.browserPlayable).toBe(true);

    await page.evaluate((id) => {
      const w = window as unknown as { __recut: { store: { getState(): { setSourceClip(id: string, t: number): void } } } };
      w.__recut.store.getState().setSourceClip(id, 0);
    }, mediaId);

    await expect(page.locator('.source-panel video')).toHaveCount(1);
    await waitForVideoReady(page);
    await expect(page.locator('.source-panel .source-label .name')).toContainText('Galaxy Saga 1');

    // ---- play / pause
    const playBtn = page.locator('.source-panel .source-transport .btn-icon.play');
    await expect(playBtn).toBeEnabled();
    const t0 = await videoTime(page);
    await playBtn.click();
    await page.waitForTimeout(1000);
    const t1 = await videoTime(page);
    expect(t1).toBeGreaterThan(t0 + 0.4);
    await expect(playBtn).toHaveAttribute('aria-label', 'Pause');
    await playBtn.click();
    await expect(playBtn).toHaveAttribute('aria-label', 'Play');
    await page.waitForTimeout(150);
    const paused1 = await videoTime(page);
    await page.waitForTimeout(300);
    const paused2 = await videoTime(page);
    expect(Math.abs(paused2 - paused1)).toBeLessThan(1e-3);

    // While playing the store time should have been reported (<= 30 Hz throttle; just check it advanced).
    const storeTime = await getState<number>(page, '(s) => s.ui.sourceClip.time');
    expect(storeTime).toBeGreaterThan(0.3);

    // ---- step forward 5 frames
    const stepFwd = page.locator('.source-panel .source-transport [aria-label^="Step Forward"]');
    const before = await videoTime(page);
    for (let i = 0; i < 5; i++) await stepFwd.click();
    await page.waitForFunction((b) => {
      const v = document.querySelector('.source-panel video') as HTMLVideoElement;
      return !v.seeking && v.currentTime > b + 4 / 24;
    }, before, { timeout: 10_000 });
    const after = await videoTime(page);
    expect(Math.abs(after - before - 5 / MEDIA_FPS)).toBeLessThan(0.5 / MEDIA_FPS);

    // ---- mark in at 1s, out at 3s (seek through the store, like the Transcript panel does)
    await seekViaStore(page, 1);
    await page.locator('.source-panel .source-transport [aria-label^="Mark In"]').click();
    await seekViaStore(page, 3);
    await page.locator('.source-panel .source-transport [aria-label^="Mark Out"]').click();
    const sc = await getState<{ inPoint: number; outPoint: number }>(page, '(s) => s.ui.sourceClip');
    expect(sc.inPoint).toBeCloseTo(1, 3);
    // Out is exclusive: end of the frame at 3s.
    expect(sc.outPoint).toBeCloseTo(3 + 1 / MEDIA_FPS, 3);
    await expect(page.locator('.source-panel .source-scrub .scrub-range')).toBeVisible();

    // Duration field shows in→out (49 frames at 24fps: frames 24..72 inclusive).
    await expect(page.locator('.source-panel .tc-dur')).toHaveText('00:00:02:01');

    // ---- insert into the active sequence at its playhead (0)
    const seqBefore = await getState<Seq>(page, '(s) => s.project.sequences[s.project.activeSequenceId]');
    expect(seqBefore.view.playhead).toBe(0);
    await page.locator('.source-panel .source-transport [aria-label^="Insert"]').click();

    const seq = await getState<Seq>(page, '(s) => s.project.sequences[s.project.activeSequenceId]');
    const vclips = seq.videoTracks.flatMap((t) => t.clips);
    const aclips = seq.audioTracks.flatMap((t) => t.clips);
    expect(vclips).toHaveLength(1);
    expect(aclips).toHaveLength(1);
    const v = vclips[0]; const a = aclips[0];
    expect(v.mediaId).toBe(mediaId);
    expect(v.sourceIn).toBeCloseTo(1, 3);
    // (3 + 1/24 - 1) s at 23.976 fps = 48.95 → 49 frames; both linked clips share duration and linkId.
    const expected = Math.round((sc.outPoint - sc.inPoint) * seq.fps.num / seq.fps.den);
    expect(v.duration).toBe(expected);
    expect(a.duration).toBe(expected);
    expect(v.linkId).toBeTruthy();
    expect(a.linkId).toBe(v.linkId);
    // Playhead advanced to the end of the inserted range, like Premiere.
    expect(seq.view.playhead).toBe(v.start + v.duration);

    // ---- a second insert with an exact 2s range (1s → 3s) yields 48 frames at 23.976.
    await page.evaluate(() => {
      const w = window as unknown as { __recut: { store: { getState(): { setSourceOut(s: number): void } } } };
      w.__recut.store.getState().setSourceOut(3);
    });
    await page.locator('.source-panel .source-transport [aria-label^="Insert"]').click();
    const seq2 = await getState<Seq>(page, '(s) => s.project.sequences[s.project.activeSequenceId]');
    const v2 = seq2.videoTracks.flatMap((t) => t.clips).sort((x, y) => x.start - y.start);
    const a2 = seq2.audioTracks.flatMap((t) => t.clips).sort((x, y) => x.start - y.start);
    expect(v2).toHaveLength(2);
    expect(a2).toHaveLength(2);
    expect(v2[1].duration).toBe(48);
    expect(a2[1].duration).toBe(48);
    expect(a2[1].linkId).toBe(v2[1].linkId);
    expect(v2[1].start).toBe(v2[0].start + v2[0].duration);
    expect(seq2.view.playhead).toBe(v2[1].start + 48);

    // ---- transport registered + keyboard fallback on the focused panel element
    await page.locator('.source-panel').focus();
    const f0 = await videoTime(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((b) => {
      const v = document.querySelector('.source-panel video') as HTMLVideoElement;
      return !v.seeking && v.currentTime > b + 0.5 / 24;
    }, f0, { timeout: 10_000 });
    const f1 = await videoTime(page);
    expect(Math.abs(f1 - f0 - 1 / MEDIA_FPS)).toBeLessThan(0.5 / MEDIA_FPS);

    // ---- screenshot for docs
    await seekViaStore(page, 2);
    await page.waitForTimeout(300);
    const out = path.join(ROOT, 'docs/screenshots/source.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });

    expect(errors).toEqual([]);
  });

  test('shows the decode error card with a proxy action for HEVC media', async () => {
    const { page } = launched;
    const [hevcId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie0hevc)]);
    const playable = await getState<boolean | undefined>(page, `(s) => s.project.media[${JSON.stringify(hevcId)}].probe?.browserPlayable`);
    test.skip(playable !== false, 'HEVC decodes natively in this Chromium build');
    await page.evaluate((id) => {
      const w = window as unknown as { __recut: { store: { getState(): { setSourceClip(id: string, t: number): void } } } };
      w.__recut.store.getState().setSourceClip(id, 0);
    }, hevcId);
    const card = page.locator('.source-panel .source-error-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(/Cannot decode/i);
    await expect(card.getByRole('button', { name: /Generate proxy/i })).toBeVisible();
  });

  test('shows a waveform for audio-only media and the image for stills', async () => {
    const { page } = launched;
    const [audioId, imageId] = await importMedia(page, [path.join(mediaDir, MEDIA.score), path.join(mediaDir, MEDIA.title)]);
    await page.evaluate((id) => {
      const w = window as unknown as { __recut: { store: { getState(): { setSourceClip(id: string, t: number): void } } } };
      w.__recut.store.getState().setSourceClip(id, 0);
    }, audioId);
    await expect(page.locator('.source-panel .source-waveform canvas')).toBeVisible();
    await page.evaluate((id) => {
      const w = window as unknown as { __recut: { store: { getState(): { setSourceClip(id: string, t: number): void } } } };
      w.__recut.store.getState().setSourceClip(id, 0);
    }, imageId);
    await expect(page.locator('.source-panel img.source-image')).toBeVisible();
  });
});
