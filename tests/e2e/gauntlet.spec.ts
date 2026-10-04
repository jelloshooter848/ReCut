/**
 * ACCEPTANCE GAUNTLET — four end-to-end scenarios against the real Electron app (xvfb), real ffmpeg.
 *
 *   xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/gauntlet.spec.ts
 *
 * Each TEST is a serial describe block with its own Electron instance and tmp dir. Steps drive the real UI
 * (mouse / keyboard on the actual panels) wherever a UI path exists; the store / actions API is used only where
 * the UI needs a native dialog (file / folder pickers) or for deterministic setup (zoom, snapping). Every step
 * records UI vs API usage and its outcome (tests/e2e/gauntlet-helpers.ts → Gauntlet); a failed step is logged
 * as a bug and, where it would block the rest, worked around through the store API (marked WORKAROUND). The
 * step logs land in test-results/gauntlet/*.json and are summarised in docs/acceptance.md.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Gauntlet, MEDIA, ROOT, aclips, clipBox, closeApp, colorDistance, drag, evalStore, ffprobeJson, frameColor, framesToSec, importMedia,
  jobs, launchGauntlet, listFilesRecursive, mediaState, prepareMedia, programBrightness, seekSource, seqState, sequenceDurationFrames,
  setMaximized, showPanel, sourceVideoTime, vclips, waitForJob, waitSourceReady, type Launched, type SeqLite, type W,
} from './gauntlet-helpers';

const RESULTS = path.join(ROOT, 'test-results', 'gauntlet');
const SOURCE_FPS = 24;

/** Shape of a timeline we expect to survive save → quit → relaunch exactly. */
const timelineSnapshot = (seq: SeqLite) => ({
  video: seq.videoTracks.map((t) => t.clips.map((c) => [c.mediaId, c.start, c.duration, Number(c.sourceIn.toFixed(4)), c.linkId, c.characters])),
  audio: seq.audioTracks.map((t) => t.clips.map((c) => [c.mediaId, c.start, c.duration, Number(c.sourceIn.toFixed(4)), c.linkId])),
  transitions: [...seq.videoTracks, ...seq.audioTracks].map((t) => t.transitions.map((x) => [x.type, x.duration, x.inClipId, x.outClipId])),
  cues: seq.subtitleTracks.map((t) => t.cues.map((c) => [c.clipId, c.text, c.offset])),
});

async function focusSource(page: Page) { await page.locator('.source-panel').focus(); }

/** Mark In at `inS`, Out at `outS` with the I / O keys on the focused Source panel, then press ',' (insert). */
async function markAndInsert(page: Page, inS: number, outS: number): Promise<void> {
  const nVideo = async () => evalStore<number>(page, '(s) => { const q = s.project.sequences[s.project.activeSequenceId]; return q.videoTracks.reduce((n, t) => n + t.clips.length, 0); }');
  const before = await nVideo();
  await seekSource(page, inS);
  await focusSource(page);
  await page.keyboard.press('i');
  await expect.poll(async () => Math.abs(((await evalStore<number | null>(page, '(s) => s.ui.sourceClip?.inPoint ?? null')) ?? -99) - inS) < 0.03).toBe(true);
  await seekSource(page, outS);
  await focusSource(page);
  await page.keyboard.press('o');
  // Out is exclusive: the end of the frame under the playhead.
  await expect.poll(async () => Math.abs(((await evalStore<number | null>(page, '(s) => s.ui.sourceClip?.outPoint ?? null')) ?? -99) - (outS + 1 / SOURCE_FPS)) < 0.03).toBe(true);
  await page.keyboard.press(',');
  await expect.poll(nVideo).toBe(before + 1);
}

/** Open the Export dialog with the real shortcut; falls back to the store when the key does not reach the shell. */
async function openExportDialog(page: Page, g: Gauntlet): Promise<void> {
  await g.step('Open the Export dialog with Ctrl+M', 'UI', async () => {
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
    await page.keyboard.press('Control+M');
    await expect(page.getByTestId('export-dialog')).toBeVisible({ timeout: 5_000 });
  }, { fallback: async () => { await evalStore(page, '(s) => s.openDialog("export")'); await expect(page.getByTestId('export-dialog')).toBeVisible(); } });
}

async function runExport(page: Page, outDir: string, fileName: string, configure?: () => Promise<void>): Promise<{ status: string; error?: string; result?: unknown }> {
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill(fileName);
  if (configure) await configure();
  await expect(page.getByTestId('export-checklist')).toContainText('Ready to export');
  const before = (await jobs(page)).filter((j) => j.kind === 'export').map((j) => j.id);
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-progress')).toBeVisible({ timeout: 20_000 });
  const job = await waitForJob(page, { kind: 'export', exclude: before }, 240_000);
  return { status: job?.status ?? 'missing', error: job?.error, result: job?.result };
}

// =====================================================================================================
// TEST 1 — Basic Movie Edit
// =====================================================================================================
test.describe.serial('TEST 1 — Basic Movie Edit', () => {
  test.setTimeout(600_000);
  const g = new Gauntlet('TEST1-basic-movie-edit');
  let L: Launched; let tmp: string; let mediaDir: string; let projectPath: string;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-gauntlet-1-'));
    mediaDir = prepareMedia(tmp);
    projectPath = path.join(tmp, 'galaxy-cut.recut');
    L = await launchGauntlet(tmp);
  });
  test.afterAll(async () => { g.write(RESULTS, L?.errors ?? []); await closeApp(L); });

  test('import → source monitor → 3 inserts → trim → ripple delete → crossfade → save → relaunch → export → verify', async () => {
    let page = L.page;
    const movie = path.join(mediaDir, MEDIA.movie1);
    let mediaId = '';
    let seq!: SeqLite;

    await g.step('New project (file.new command — no dirty state, so no native prompt)', 'UI+API', async () => {
      expect(await page.evaluate(() => (window as unknown as W).__recut.runCommand('file.new'))).toBe(true);
      await expect.poll(() => evalStore<number>(page, '(s) => Object.keys(s.project.media).length')).toBe(0);
    });

    await g.step('Import "Galaxy Saga 1" (actions.importMediaFiles — the file picker is native)', 'API', async () => {
      [mediaId] = await importMedia(page, [movie]);
      const m = (await mediaState(page))[mediaId];
      expect(m.probeError, m.probeError).toBeUndefined();
      expect(m.probe?.browserPlayable).toBe(true);
      expect(Math.round(m.probe!.duration)).toBe(24);
    });

    await g.step('Double-click the item in the Project panel → Source monitor loads it', 'UI', async () => {
      const row = page.locator(`[data-row-kind="media"][data-media-id="${mediaId}"]`);
      await expect(row).toBeVisible();
      await row.dblclick();
      await expect.poll(() => evalStore<string | undefined>(page, '(s) => s.ui.sourceClip?.mediaId')).toBe(mediaId);
      await expect(page.locator('.source-panel video')).toHaveCount(1);
      await waitSourceReady(page);
      await expect(page.locator('.source-panel .source-label .name')).toContainText('Galaxy Saga 1');
    }, { fallback: async () => { await evalStore(page, '(s, id) => s.setSourceClip(id, 0)', mediaId); await waitSourceReady(page); } });

    await g.step('Space plays, Space pauses the Source monitor (keyboard on the focused panel)', 'UI', async () => {
      await focusSource(page);
      const play = page.locator('.source-panel .source-transport .play');
      const t0 = await sourceVideoTime(page);
      await page.keyboard.press('Space');
      await expect(play).toHaveAttribute('aria-label', 'Pause');
      await page.waitForTimeout(1200);
      await page.keyboard.press('Space');
      await expect(play).toHaveAttribute('aria-label', 'Play');
      const t1 = await sourceVideoTime(page);
      expect(t1, 'video advanced while playing').toBeGreaterThan(t0 + 0.5);
      await page.waitForTimeout(400);
      expect(Math.abs((await sourceVideoTime(page)) - t1), 'video stays put when paused').toBeLessThan(0.02);
      expect(await evalStore<boolean>(page, '(s) => s.playback.playing')).toBe(false);
    });

    await g.step('Clicking the Source scrub bar at 25 % / 50 % / 75 % seeks accordingly', 'UI', async () => {
      const bar = page.locator('.source-panel .source-scrub');
      const b = (await bar.boundingBox())!;
      const dur = (await mediaState(page))[mediaId].probe!.duration;
      const seen: number[] = [];
      for (const frac of [0.25, 0.5, 0.75]) {
        await page.mouse.click(b.x + b.width * frac, b.y + b.height / 2);
        await page.waitForFunction((want) => { const v = document.querySelector('.source-panel video') as HTMLVideoElement; return !v.seeking && Math.abs(v.currentTime - want) < 0.4; }, frac * dur, { timeout: 10_000 });
        const t = await sourceVideoTime(page);
        seen.push(t);
        expect(Math.abs(t - frac * dur), `click at ${frac * 100}% → ${t.toFixed(2)}s (want ${(frac * dur).toFixed(2)}s)`).toBeLessThan(0.4);
        // the store follows the player
        expect(Math.abs((await evalStore<number>(page, '(s) => s.ui.sourceClip.time')) - t)).toBeLessThan(0.15);
      }
      expect(seen[0]).toBeLessThan(seen[1]); expect(seen[1]).toBeLessThan(seen[2]);
    });

    await g.step('I / O / , on the focused Source panel ×3 → 3 video + 3 linked audio clips (seeks via store.setSourceTime)', 'UI+API', async () => {
      const ranges: [number, number][] = [[1, 3], [5, 7], [9, 11]];
      for (const [i, o] of ranges) await markAndInsert(page, i, o);
      seq = await seqState(page);
      const v = vclips(seq), a = aclips(seq);
      expect(v).toHaveLength(3); expect(a).toHaveLength(3);
      for (let k = 0; k < 3; k++) {
        expect(v[k].mediaId).toBe(mediaId);
        expect(Math.abs(v[k].sourceIn - ranges[k][0])).toBeLessThan(0.03);
        expect(a[k].linkId).toBe(v[k].linkId); expect(v[k].linkId).toBeTruthy();
        expect(a[k].start).toBe(v[k].start); expect(a[k].duration).toBe(v[k].duration);
        if (k) expect(v[k].start).toBe(v[k - 1].start + v[k - 1].duration);
      }
      expect(v[0].start).toBe(0);
    });

    await g.step('Mouse-trim the right edge of the last clip by 40 px (= 20 frames at 2 px/frame)', 'UI+API', async () => {
      await setMaximized(page, 'timeline', true);
      // deterministic geometry: 2 px/frame, snapping off (store API — view/settings only)
      await evalStore(page, '(s) => { s.setSettings({ snapping: false }); s.setView(s.project.activeSequenceId, { zoom: 2, scroll: 0, playhead: 0 }); }');
      seq = await seqState(page);
      const c = vclips(seq)[2];
      const b = await clipBox(page, c.id);
      await drag(page, { x: b.x + b.width - 2, y: b.y + b.height / 2 }, { x: b.x + b.width - 2 - 40, y: b.y + b.height / 2 });
      seq = await seqState(page);
      const after = vclips(seq).find((x) => x.id === c.id)!;
      expect(after.start).toBe(c.start);
      expect(after.duration).toBe(c.duration - 20);
      const linked = aclips(seq).find((x) => x.linkId === c.linkId)!;
      expect(linked.duration, 'linked audio trimmed with it').toBe(c.duration - 20);
    }, { note: 'zoom + snapping set through the store for determinism' });

    await g.step('Select the middle clip, Shift+Delete ripple-deletes it and closes the gap', 'UI', async () => {
      seq = await seqState(page);
      const [a, b, c] = vclips(seq);
      const box = await clipBox(page, b.id);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(() => evalStore<string[]>(page, '(s) => s.ui.selectedClipIds')).toContain(b.id);
      await page.keyboard.press('Shift+Delete');
      seq = await seqState(page);
      expect(vclips(seq).map((x) => x.id)).toEqual([a.id, c.id]);
      expect(vclips(seq)[1].start).toBe(a.duration);
      expect(aclips(seq)).toHaveLength(2);
      expect(aclips(seq)[1].start).toBe(a.duration);
    });

    await g.step('Right-click the audio cut → "Add Audio Crossfade" → audioTracks[0].transitions.length === 1', 'UI', async () => {
      seq = await seqState(page);
      const a0 = aclips(seq)[0];
      const box = await clipBox(page, a0.id);
      await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2, { button: 'right' });
      const item = page.locator('.menu-item', { hasText: 'Add Audio Crossfade' });
      await expect(item).toBeVisible();
      await item.click();
      seq = await seqState(page);
      expect(seq.audioTracks[0].transitions).toHaveLength(1);
      expect(seq.audioTracks[0].transitions[0].type).toBe('audioCrossfade');
      await expect(page.locator('[data-transition-id]')).toHaveCount(1);
    }, {
      fallback: async () => {
        // Ctrl+Shift+D (default audio transition at the selection) as the second UI path, then the store.
        seq = await seqState(page);
        const [x, y] = aclips(seq);
        await evalStore(page, '(s, ids) => s.select(ids, "set")', [x.id, y.id]);
        await page.keyboard.press('Control+Shift+D');
        seq = await seqState(page);
        if (seq.audioTracks[0].transitions.length !== 1) {
          await evalStore(page, '(s, a) => s.addTransitionAtCut(s.project.activeSequenceId, a.trackId, a.frame, "audioCrossfade")', { trackId: seq.audioTracks[0].id, frame: y.start });
          seq = await seqState(page);
        }
        expect(seq.audioTracks[0].transitions).toHaveLength(1);
      },
    });
    await setMaximized(page, 'timeline', false);

    const saved = timelineSnapshot(await seqState(page));
    await g.step('Save the project (actions.saveProject — the save dialog is native)', 'API', async () => {
      const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(fs.existsSync(projectPath)).toBe(true);
      expect(await evalStore<boolean>(page, '(s) => s.dirty')).toBe(false);
    });

    await g.step('Quit the app for real and relaunch with `--project <path>`; the timeline survives exactly', 'UI+API', async () => {
      await L.app.close();
      L = await launchGauntlet(tmp, { projectArg: projectPath });
      page = L.page;
      await expect.poll(() => evalStore<string | null>(page, '(s) => s.projectPath'), { timeout: 30_000 }).toBe(projectPath);
      expect(await page.getByTestId('recovery-dialog').count(), 'no spurious recovery prompt after a clean save+quit').toBe(0);
      const reloaded = await seqState(page);
      expect(timelineSnapshot(reloaded)).toEqual(saved);
      await expect(page.locator('.topbar .project-name')).toHaveText(await evalStore<string>(page, '(s) => s.project.name'));
    }, {
      fallback: async () => {
        const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectPath);
        expect(res.ok).toBe(true);
        expect(timelineSnapshot(await seqState(page))).toEqual(saved);
      },
    });

    const outDir = path.join(tmp, 'export');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'test1.mp4');
    await openExportDialog(page, g);
    await g.step('Export dialog: type output dir + file name, preset "720p Preview", Export, wait for done', 'UI', async () => {
      const r = await runExport(page, outDir, 'test1.mp4', async () => {
        await page.getByTestId('export-preset').selectOption('720p Preview');
        await expect(page.getByTestId('export-dialog').locator('.xd-summary')).toContainText('1280×720');
      });
      expect(r.status, r.error ?? '').toBe('done');
      await expect(page.getByTestId('export-done')).toBeVisible();
      expect(fs.existsSync(outFile)).toBe(true);
      await page.keyboard.press('Escape');
    });

    seq = await seqState(page);
    const seqSeconds = framesToSec(sequenceDurationFrames(seq), seq.fps);
    await g.step(`ffprobe: output duration == sequence duration (${seqSeconds.toFixed(3)}s) ±0.05s`, 'API', async () => {
      const info = ffprobeJson(outFile);
      const dur = Number(info.format.duration);
      const video = info.streams.find((s) => s.codec_type === 'video')!;
      expect(video.width).toBe(1280); expect(video.height).toBe(720);
      expect(Math.abs(dur - seqSeconds), `ffprobe duration ${dur.toFixed(3)}s vs sequence ${seqSeconds.toFixed(3)}s (Δ ${(dur - seqSeconds).toFixed(3)}s)`).toBeLessThanOrEqual(0.05);
    });

    await g.step('Frame colors at each remaining clip midpoint match the source scene (red, yellow)', 'API', async () => {
      const v = vclips(seq);
      expect(v).toHaveLength(2);
      const expectations = [
        { name: 'red', check: (c: { r: number; g: number; b: number }) => c.r > 180 && c.g < 70 && c.b < 70 },
        { name: 'yellow', check: (c: { r: number; g: number; b: number }) => c.r > 180 && c.g > 180 && c.b < 80 },
      ];
      v.forEach((c, i) => {
        const tOut = framesToSec(c.start + c.duration / 2, seq.fps);
        const tSrc = c.sourceIn + framesToSec(c.duration / 2, seq.fps);
        const got = frameColor(outFile, tOut);
        const want = frameColor(movie, tSrc);
        expect(colorDistance(got, want), `clip ${i} @${tOut.toFixed(2)}s out=${JSON.stringify(got)} src=${JSON.stringify(want)}`).toBeLessThan(60);
        expect(expectations[i].check(got), `clip ${i} should be ${expectations[i].name}: ${JSON.stringify(got)}`).toBe(true);
      });
    });

    g.finish(RESULTS, L.errors);
  });
});

// =====================================================================================================
// TEST 2 — TV Fan Edit
// =====================================================================================================
test.describe.serial('TEST 2 — TV Fan Edit', () => {
  test.setTimeout(600_000);
  const g = new Gauntlet('TEST2-tv-fan-edit');
  let L: Launched; let tmp: string; let mediaDir: string; let projectPath: string;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-gauntlet-2-'));
    mediaDir = prepareMedia(tmp);
    projectPath = path.join(tmp, 'station-eleven-fan-edit.recut');
    L = await launchGauntlet(tmp);
  });
  test.afterAll(async () => { g.write(RESULTS, L?.errors ?? []); await closeApp(L); });

  test('episodes → series → subtitles → transcript search → inserts → tags → edit → relaunch → export + sidecar', async () => {
    let page = L.page;
    const episodes = [MEDIA.ep1, MEDIA.ep2, MEDIA.ep3].map((p) => path.join(mediaDir, p));
    let ids: string[] = [];
    let seq!: SeqLite;

    await g.step('Import the three Station Eleven episodes', 'API', async () => {
      ids = await importMedia(page, episodes);
      expect(ids).toHaveLength(3);
    });

    await g.step('Organize as Series via the Project panel context menu dialog ("Station Eleven", season 1)', 'UI', async () => {
      await setMaximized(page, 'project', true);
      const rows = page.locator('[data-row-kind="media"]');
      await expect(rows).toHaveCount(3);
      await rows.nth(0).click();
      await rows.nth(2).click({ modifiers: ['Shift'] });
      await expect.poll(() => evalStore<number>(page, '(s) => s.ui.selectedMediaIds.length')).toBe(3);
      await rows.nth(1).click({ button: 'right' });
      await page.locator('.menu-item', { hasText: 'Organize as Series' }).click();
      const name = page.getByTestId('series-name');
      await expect(name).toBeVisible();
      await name.fill('Station Eleven');
      await page.getByTestId('series-apply').click();
      const identities = await evalStore<{ series?: string; season?: number; episode?: number }[]>(page, '(s) => Object.values(s.project.media).map((m) => m.identity).sort((a, b) => a.episode - b.episode)');
      expect(identities).toEqual([
        { series: 'Station Eleven', season: 1, episode: 1 },
        { series: 'Station Eleven', season: 1, episode: 2 },
        { series: 'Station Eleven', season: 1, episode: 3 },
      ]);
      await expect(page.locator('[data-row-kind="bin"] .pp-name', { hasText: 'Station Eleven' })).toHaveCount(1);
      await setMaximized(page, 'project', false);
    }, { fallback: async () => { await evalStore(page, '(s, ids) => s.organizeAsSeries(ids, "Station Eleven", 1)', ids); await setMaximized(page, 'project', false); } });

    await g.step('Import the matching .srt for each episode (actions.importSubtitleFile — native picker otherwise)', 'API', async () => {
      for (let i = 0; i < ids.length; i++) {
        const srt = path.join(mediaDir, MEDIA.srt(path.basename(episodes[i], '.mp4')));
        const res = await page.evaluate(([id, p]) => (window as unknown as W).__recut.actions.importSubtitleFile(id, p), [ids[i], srt] as const);
        expect(res.trackId, srt).toBeTruthy();
        expect(res.warnings).toEqual([]);
      }
    });

    const results = page.getByTestId('transcript-result');
    await g.step('Transcript panel: search "doctor" → 4 results in 3 episodes', 'UI', async () => {
      await showPanel(page, 'transcript');
      await expect(page.getByTestId('transcript-panel')).toBeVisible();
      await page.getByTestId('transcript-search').fill('doctor');
      await expect(results).toHaveCount(4);
      await expect(page.getByTestId('transcript-count')).toHaveText(/4 results in 3 media/);
      const texts = await page.getByTestId('transcript-result-text').allTextContents();
      expect(texts).toEqual(['Where is the doctor?', 'The doctor is in the lab.', 'The doctor has a secret.', 'Nobody trusts the doctor now.']);
    });

    let ep1 = ''; let ep2 = ''; let ep3 = '';
    await g.step('Click a result → Source monitor jumps to the cue (ui.sourceClip + <video>.currentTime ≈ 5 s)', 'UI', async () => {
      ep1 = (await results.nth(0).getAttribute('data-media-id'))!;
      ep2 = (await results.nth(2).getAttribute('data-media-id'))!;
      ep3 = (await results.nth(3).getAttribute('data-media-id'))!;
      expect(new Set([ep1, ep2, ep3]).size).toBe(3);
      await results.first().click();
      const sc = await evalStore<{ mediaId: string; inPoint: number; outPoint: number; time: number }>(page, '(s) => s.ui.sourceClip');
      expect(sc.mediaId).toBe(ep1);
      expect(sc.inPoint).toBeCloseTo(5, 3);
      expect(sc.outPoint).toBeCloseTo(7.5, 3);
      await waitSourceReady(page);
      await page.waitForFunction(() => { const v = document.querySelector('.source-panel video') as HTMLVideoElement; return !v.seeking && Math.abs(v.currentTime - 5) < 0.15; }, undefined, { timeout: 15_000 });
      expect(Math.abs((await sourceVideoTime(page)) - 5)).toBeLessThan(0.15);
    });

    await g.step('Insert from E01 via the result\'s "Insert at playhead" button (carries the cue)', 'UI', async () => {
      await results.first().hover();
      await results.first().getByLabel('Insert at playhead', { exact: false }).click();
      seq = await seqState(page);
      expect(vclips(seq)).toHaveLength(1);
      expect(vclips(seq)[0].mediaId).toBe(ep1);
      expect(seq.subtitleTracks[0]?.cues.map((c) => c.text)).toEqual(['Where is the doctor?']);
    });

    await g.step('Insert from E02 via the Source monitor: click result → "," on the focused Source panel', 'UI', async () => {
      await results.nth(2).click();
      await expect.poll(() => evalStore<string>(page, '(s) => s.ui.sourceClip?.mediaId')).toBe(ep2);
      await waitSourceReady(page);
      await focusSource(page);
      await page.keyboard.press(',');
      seq = await seqState(page);
      expect(vclips(seq).map((c) => c.mediaId)).toEqual([ep1, ep2]);
      expect(vclips(seq)[1].start).toBe(vclips(seq)[0].duration);
      expect(Math.abs(vclips(seq)[1].sourceIn - 1)).toBeLessThan(0.01);
    });

    await g.step('Insert from E03 via "Insert at playhead"', 'UI', async () => {
      await results.nth(3).hover();
      await results.nth(3).getByLabel('Insert at playhead', { exact: false }).click();
      seq = await seqState(page);
      expect(vclips(seq).map((c) => c.mediaId)).toEqual([ep1, ep2, ep3]);
      expect(aclips(seq)).toHaveLength(3);
    });

    await g.step('Tag clip 1 by character through the Timeline context menu "Tag…" dialog', 'UI+API', async () => {
      await setMaximized(page, 'timeline', true);
      await evalStore(page, '(s) => s.setView(s.project.activeSequenceId, { zoom: 2, scroll: 0, playhead: 0 })');
      seq = await seqState(page);
      const c = vclips(seq)[0];
      const b = await clipBox(page, c.id);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
      await page.locator('.menu-item', { hasText: 'Tag…' }).click();
      const dlg = page.getByRole('dialog').filter({ hasText: 'Tags —' });
      await expect(dlg).toBeVisible();
      const input = dlg.locator('input[placeholder="Add character…"]');
      await input.click(); await input.fill('Kirsten'); await input.press('Enter');
      await input.fill('Jeevan'); await input.press('Enter');
      await dlg.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dlg).toHaveCount(0);
      seq = await seqState(page);
      expect(vclips(seq)[0].characters).toEqual(['Kirsten', 'Jeevan']);
      expect(await evalStore<string[]>(page, '(s) => s.project.tags.characters')).toEqual(expect.arrayContaining(['Kirsten', 'Jeevan']));
      await setMaximized(page, 'timeline', false);
    }, { note: 'zoom set through the store', fallback: async () => { await setMaximized(page, 'timeline', false); await evalStore(page, '(s, id) => s.setClipTags(s.project.activeSequenceId, id, { characters: ["Kirsten", "Jeevan"] })', vclips(seq)[0].id); } });

    await g.step('Tag clip 3 by character through the Inspector TagInput', 'UI', async () => {
      seq = await seqState(page);
      const c = vclips(seq)[2];
      const b = await clipBox(page, c.id);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      const insp = page.getByTestId('inspector');
      await expect(insp).toHaveAttribute('data-mode', 'clip');
      const input = insp.locator('input[placeholder="Add character…"]');
      await input.scrollIntoViewIfNeeded();
      await input.click(); await input.fill('Miranda'); await input.press('Enter');
      await expect.poll(() => evalStore<string[]>(page, '(s, id) => { const q = s.project.sequences[s.project.activeSequenceId]; for (const t of q.videoTracks) for (const c of t.clips) if (c.id === id) return c.characters; }', c.id)).toEqual(['Miranda']);
    }, { fallback: async () => { await evalStore(page, '(s, id) => s.setClipTags(s.project.activeSequenceId, id, { characters: ["Miranda"] })', vclips(seq)[2].id); } });

    await g.step('Remove the E02 scene with Shift+Delete (ripple) → gap closed', 'UI', async () => {
      await setMaximized(page, 'timeline', true);
      seq = await seqState(page);
      const [a, b, c] = vclips(seq);
      const box = await clipBox(page, b.id);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(() => evalStore<string[]>(page, '(s) => s.ui.selectedClipIds')).toContain(b.id);
      await page.keyboard.press('Shift+Delete');
      seq = await seqState(page);
      expect(vclips(seq).map((x) => x.id)).toEqual([a.id, c.id]);
      expect(vclips(seq)[1].start).toBe(a.duration);
      expect(seq.subtitleTracks[0].cues.map((x) => x.text).sort()).toEqual(['Nobody trusts the doctor now.', 'Where is the doctor?']);
    });

    await g.step('Rearrange: mouse-drag the first clip (E01) behind the last one → order becomes [E03, E01]', 'UI', async () => {
      seq = await seqState(page);
      const [a, c] = vclips(seq);
      const zoom = seq.view.zoom;
      const b = await clipBox(page, a.id);
      const dx = (c.start + c.duration - a.start + 8) * zoom;
      await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 }, 20);
      seq = await seqState(page);
      const order = vclips(seq);
      expect(order.map((x) => x.id)).toEqual([c.id, a.id]);
      expect(order[0].start, 'E03 untouched').toBe(c.start);
      expect(order[1].start).toBeGreaterThanOrEqual(c.start + c.duration);
      const audio = aclips(seq);
      expect(audio.find((x) => x.linkId === a.linkId)!.start, 'linked audio moved with it').toBe(order[1].start);
      await setMaximized(page, 'timeline', false);
    }, { fallback: async () => { await setMaximized(page, 'timeline', false); const [a, c] = vclips(await seqState(page)); await evalStore(page, '(s, p) => s.moveClips(s.project.activeSequenceId, [{ clipId: p.id, toStart: p.to }], "overwrite")', { id: a.id, to: c.start + c.duration }); } });

    const saved = timelineSnapshot(await seqState(page));
    await g.step('Save the project', 'API', async () => {
      const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
      expect(res.ok, JSON.stringify(res)).toBe(true);
    });

    await g.step('Close and relaunch with `--project`; timeline, tags and carried cues survive', 'UI+API', async () => {
      await L.app.close();
      L = await launchGauntlet(tmp, { projectArg: projectPath });
      page = L.page;
      await expect.poll(() => evalStore<string | null>(page, '(s) => s.projectPath'), { timeout: 30_000 }).toBe(projectPath);
      expect(await page.getByTestId('recovery-dialog').count()).toBe(0);
      expect(timelineSnapshot(await seqState(page))).toEqual(saved);
      const identities = await evalStore<unknown[]>(page, '(s) => Object.values(s.project.media).map((m) => m.identity.series)');
      expect(identities).toEqual(['Station Eleven', 'Station Eleven', 'Station Eleven']);
    }, { fallback: async () => { const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectPath); expect(res.ok).toBe(true); } });

    const outDir = path.join(tmp, 'export');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'fanedit.mp4');
    const srtFile = path.join(outDir, 'fanedit.srt');
    await openExportDialog(page, g);
    await g.step('Export with "Export .srt next to the video" enabled', 'UI', async () => {
      const r = await runExport(page, outDir, 'fanedit.mp4', async () => {
        const sw = page.getByTestId('export-dialog').getByRole('switch', { name: /Export \.srt/ });
        await expect(sw).toBeEnabled();
        if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
        await expect(sw).toHaveAttribute('aria-checked', 'true');
      });
      expect(r.status, r.error ?? '').toBe('done');
      expect((r.result as { sidecarPath?: string })?.sidecarPath).toBe(srtFile);
      await page.keyboard.press('Escape');
    });

    await g.step('ffprobe duration == sequence duration ±0.05s and the sidecar SRT carries the dialogue lines', 'API', async () => {
      seq = await seqState(page);
      const want = framesToSec(sequenceDurationFrames(seq), seq.fps);
      const dur = Number(ffprobeJson(outFile).format.duration);
      expect(Math.abs(dur - want), `ffprobe ${dur.toFixed(3)}s vs sequence ${want.toFixed(3)}s`).toBeLessThanOrEqual(0.05);
      expect(fs.existsSync(srtFile), srtFile).toBe(true);
      const srt = fs.readFileSync(srtFile, 'utf8');
      expect(srt).toContain('Where is the doctor?');
      expect(srt).toContain('Nobody trusts the doctor now.');
      expect(srt).not.toContain('The doctor has a secret.');
    });

    g.finish(RESULTS, L.errors);
  });
});

// =====================================================================================================
// TEST 3 — Large-Media Workflow
// =====================================================================================================
test.describe.serial('TEST 3 — Large-Media Workflow', () => {
  test.setTimeout(600_000);
  const g = new Gauntlet('TEST3-large-media-workflow');
  let L: Launched; let tmp: string; let mediaDir: string; let projectPath: string;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-gauntlet-3-'));
    mediaDir = prepareMedia(tmp);
    projectPath = path.join(tmp, 'galaxy-marathon.recut');
    L = await launchGauntlet(tmp);
  });
  test.afterAll(async () => { g.write(RESULTS, L?.errors ?? []); await closeApp(L); });

  test('proxies → proxy playback → program monitor → proxies off/on → file move + relink → 5.1 and stereo export', async () => {
    let page = L.page;
    const files = { h264: MEDIA.movie1, ac3: MEDIA.movie2ac3, hevc: MEDIA.movie0hevc, surround: MEDIA.movie3surround };
    const id: Record<keyof typeof files, string> = { h264: '', ac3: '', hevc: '', surround: '' };
    let hevcNative = false;

    await g.step('Import Galaxy Saga 1 (H.264), 2 (AC-3), 0 (HEVC) and 3 (5.1)', 'API', async () => {
      const ids = await importMedia(page, [files.h264, files.ac3, files.hevc, files.surround].map((p) => path.join(mediaDir, p)));
      [id.h264, id.ac3, id.hevc, id.surround] = ids;
      const m = await mediaState(page);
      for (const k of Object.keys(id) as (keyof typeof id)[]) expect(m[id[k]].probeError, k).toBeUndefined();
      hevcNative = m[id.hevc].probe?.browserPlayable === true;
      expect(m[id.surround].probe?.audio[0].channels).toBe(6);
      console.log(`[TEST3] browserPlayable: h264=${m[id.h264].probe?.browserPlayable} ac3=${m[id.ac3].probe?.browserPlayable} hevc=${m[id.hevc].probe?.browserPlayable} 5.1=${m[id.surround].probe?.browserPlayable}`);
    });

    const jobsPanel = page.getByTestId('jobs-panel');
    const proxyRow = (mediaId: string) => page.locator(`[data-testid="proxy-row"][data-media-id="${mediaId}"]`);
    await g.step('Jobs › Proxies: "Generate missing proxies" → all four ready', 'UI', async () => {
      await showPanel(page, 'jobs');
      await jobsPanel.getByRole('tab', { name: 'Proxies' }).click();
      await expect(page.getByTestId('proxies-tab')).toBeVisible();
      await expect(proxyRow(id.hevc)).toHaveAttribute('data-proxy-status', 'none');
      await page.getByTestId('proxies-generate-missing').click();
      await page.waitForFunction((ids) => {
        const media = (window as unknown as W).__recut.store.getState().project.media;
        return ids.every((i: string) => media[i].proxy.status === 'ready' || media[i].proxy.status === 'failed');
      }, Object.values(id), { timeout: 300_000 });
      const m = await mediaState(page);
      for (const k of Object.keys(id) as (keyof typeof id)[]) {
        expect(m[id[k]].proxy.status, `${k}: ${m[id[k]].proxy.error ?? ''}`).toBe('ready');
        expect(fs.existsSync(m[id[k]].proxy.path!)).toBe(true);
        await expect(proxyRow(id[k])).toHaveAttribute('data-proxy-status', 'ready');
      }
    }, { fallback: async () => { for (const i of Object.values(id)) await page.evaluate((x) => (window as unknown as W).__recut.actions.startProxy(x), i); await page.waitForFunction((ids) => { const media = (window as unknown as W).__recut.store.getState().project.media; return ids.every((i: string) => media[i].proxy.status === 'ready'); }, Object.values(id), { timeout: 300_000 }); } });

    await g.step('Source monitor shows the Proxy badge for the HEVC file and plays it', 'UI', async () => {
      const row = page.locator(`[data-row-kind="media"][data-media-id="${id.hevc}"]`);
      await row.scrollIntoViewIfNeeded();
      await row.dblclick();
      await expect.poll(() => evalStore<string>(page, '(s) => s.ui.sourceClip?.mediaId')).toBe(id.hevc);
      if (!hevcNative) await expect(page.locator('.source-panel .source-badge.proxy')).toBeVisible();
      await waitSourceReady(page);
      const play = page.locator('.source-panel .source-transport .play');
      const t0 = await sourceVideoTime(page);
      await play.click();
      await page.waitForTimeout(1200);
      await play.click();
      expect(await sourceVideoTime(page)).toBeGreaterThan(t0 + 0.5);
      expect(await page.locator('.source-panel .source-error-card').count()).toBe(0);
    }, { note: 'HEVC proxy badge asserted only when HEVC is not natively decodable in this Chromium build' });

    await g.step('Build a sequence with one range from each of the four files (dbl-click → I/O → ",")', 'UI+API', async () => {
      for (const k of ['h264', 'ac3', 'hevc', 'surround'] as const) {
        const row = page.locator(`[data-row-kind="media"][data-media-id="${id[k]}"]`);
        await row.scrollIntoViewIfNeeded();
        await row.dblclick();
        await expect.poll(() => evalStore<string>(page, '(s) => s.ui.sourceClip?.mediaId')).toBe(id[k]);
        await waitSourceReady(page);
        await markAndInsert(page, 1, 3);
      }
      const seq = await seqState(page);
      expect(vclips(seq).map((c) => c.mediaId)).toEqual([id.h264, id.ac3, id.hevc, id.surround]);
      expect(aclips(seq)).toHaveLength(4);
    }, { note: 'seeks via store.setSourceTime' });

    const playheadInto = async (mediaId: string) => {
      const seq = await seqState(page);
      const c = vclips(seq).find((x) => x.mediaId === mediaId)!;
      await evalStore(page, '(s, f) => s.setView(s.project.activeSequenceId, { playhead: f })', c.start + Math.floor(c.duration / 2));
    };
    const proxySwitch = () => page.getByTestId('proxies-tab').getByRole('switch', { name: /Playback proxies/ });
    await g.step('Proxies ON (toggle in the Proxies tab): the Program monitor renders non-black frames from proxies', 'UI+API', async () => {
      await jobsPanel.getByRole('tab', { name: 'Proxies' }).click();
      if ((await proxySwitch().getAttribute('aria-checked')) !== 'true') await proxySwitch().click();
      await expect.poll(() => evalStore<boolean>(page, '(s) => s.project.settings.useProxies')).toBe(true);
      for (const k of ['h264', 'hevc', 'surround'] as const) {
        await playheadInto(id[k]);
        await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
      }
      await expect(page.getByTestId('program-proxy')).toBeVisible();
      expect(await page.getByTestId('program-missing').count()).toBe(0);
    }, { note: 'playhead placed through the store' });

    await g.step('Proxies OFF: H.264 clips render from the originals (no Proxy chip)', 'UI+API', async () => {
      await proxySwitch().click();
      await expect.poll(() => evalStore<boolean>(page, '(s) => s.project.settings.useProxies')).toBe(false);
      await playheadInto(id.h264);
      await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
      await expect(page.getByTestId('program-proxy')).toHaveCount(0);
      expect(await page.getByTestId('program-missing').count()).toBe(0);
    });

    await g.step('Proxies OFF: the HEVC clip — expected "missing/undecodable" chip; observed behaviour recorded in the note', 'UI+API', async () => {
      if (hevcNative) { g.note('skipped: HEVC decodes natively in this Chromium build'); return; }
      await playheadInto(id.hevc);
      await page.waitForTimeout(1500);
      const missing = await page.getByTestId('program-missing').count();
      const proxyChip = await page.getByTestId('program-proxy').count();
      const bright = await programBrightness(page);
      g.note(`observed with proxies off: missing-chip=${missing} proxy-chip=${proxyChip} brightness=${bright.toFixed(0)}`);
      // Either the brief's expectation (missing chip) or the app's documented fallback (plays the proxy anyway, with the Proxy chip).
      expect(missing === 1 || (proxyChip === 1 && bright > 20)).toBe(true);
    }, { note: 'app falls back to a ready proxy for undecodable originals even when proxies are off (resolvePlaybackPath)' });

    await g.step('Delete the HEVC proxy (row button) with proxies off → Program chip reports the clip as missing; regenerate → renders again', 'UI+API', async () => {
      if (hevcNative) { g.note('skipped: HEVC decodes natively in this Chromium build'); return; }
      await proxyRow(id.hevc).getByLabel('Delete proxy').click();
      await expect(proxyRow(id.hevc)).toHaveAttribute('data-proxy-status', 'none');
      await playheadInto(id.hevc);
      await expect(page.getByTestId('program-missing')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('program-missing')).toContainText(/Missing media/);
      // H.264 neighbours still render
      await playheadInto(id.h264);
      await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
      await proxyRow(id.hevc).getByTestId('proxy-generate').click();
      await expect(proxyRow(id.hevc)).toHaveAttribute('data-proxy-status', 'ready', { timeout: 180_000 });
      await playheadInto(id.hevc);
      await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
      await expect(page.getByTestId('program-missing')).toHaveCount(0, { timeout: 20_000 });
    });

    await g.step('Re-enable proxies', 'UI', async () => {
      await proxySwitch().click();
      await expect.poll(() => evalStore<boolean>(page, '(s) => s.project.settings.useProxies')).toBe(true);
    });

    await g.step('Save the project', 'API', async () => {
      const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
      expect(res.ok, JSON.stringify(res)).toBe(true);
    });

    const movedDir = path.join(mediaDir, 'movies-moved');
    await g.step('Simulate a file move: quit, rename the movies folder, relaunch with --project → media offline + Relink dialog opens', 'UI+API', async () => {
      await L.app.close();
      fs.renameSync(path.join(mediaDir, 'movies'), movedDir);
      L = await launchGauntlet(tmp, { projectArg: projectPath });
      page = L.page;
      await expect.poll(() => evalStore<string | null>(page, '(s) => s.projectPath'), { timeout: 30_000 }).toBe(projectPath);
      await expect(page.getByRole('dialog').filter({ hasText: 'Relink offline media' })).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => evalStore<number>(page, '(s) => Object.values(s.project.media).filter((m) => m.offline).length')).toBe(4);
      await expect(page.getByTestId('relink-list').locator('.pp-relink-row')).toHaveCount(4);
      await expect(page.locator('.toast.warn', { hasText: /offline/ })).toBeVisible();
      await expect(page.getByTestId('offline-banner')).toBeVisible();
    }, {
      fallback: async () => {
        const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectPath);
        expect(res.ok).toBe(true);
        await page.evaluate(() => (window as unknown as W).__recut.actions.verifyMediaOnline());
        await expect.poll(() => evalStore<number>(page, '(s) => Object.values(s.project.media).filter((m) => m.offline).length')).toBe(4);
        await evalStore(page, '(s) => s.openDialog("relink")');
      },
    });

    await g.step('Relink via "Search folder…" (folder picker is native → scanForRelink + relinkMedia through the bridge), then "Check files" in the dialog', 'UI+API', async () => {
      const relinked = await page.evaluate(async (folder) => {
        const w = window as unknown as W;
        const st = w.__recut.store.getState();
        const offline = Object.values(st.project.media as Record<string, { id: string; path: string; fileSize?: number; offline: boolean }>).filter((m) => m.offline);
        const found: { missingMediaId: string; path: string; confidence: string }[] = await w.recut.scanForRelink({ folder, missing: offline.map((m) => ({ mediaId: m.id, fileName: m.path.split('/').pop(), size: m.fileSize })) });
        const done: string[] = [];
        for (const m of offline) {
          const c = found.find((f) => f.missingMediaId === m.id);
          if (!c) continue;
          const s = await w.recut.stat(c.path);
          w.__recut.store.getState().relinkMedia(m.id, c.path, s.exists ? { size: s.size, mtimeMs: s.mtimeMs } : undefined);
          await w.__recut.actions.probeMedia(m.id);
          done.push(`${c.confidence}:${c.path}`);
        }
        return done;
      }, movedDir);
      expect(relinked).toHaveLength(4);
      expect(relinked.every((r) => r.startsWith('name+size:'))).toBe(true);
      const dlg = page.getByRole('dialog').filter({ hasText: 'Relink offline media' });
      await dlg.getByRole('button', { name: 'Check files' }).click();
      await expect(page.locator('.toast', { hasText: 'All media online' })).toBeVisible();
      await expect(dlg).toContainText('All media is online');
      await dlg.getByRole('button', { name: 'Close' }).click();
      await expect(page.getByTestId('offline-banner')).toHaveCount(0);
      const m = await mediaState(page);
      for (const k of Object.keys(id) as (keyof typeof id)[]) {
        expect(m[id[k]].offline).toBe(false);
        expect(m[id[k]].path.startsWith(movedDir)).toBe(true);
        expect(m[id[k]].probe?.duration).toBeGreaterThan(0);
      }
    });

    const outDir = path.join(tmp, 'export');
    fs.mkdirSync(outDir, { recursive: true });
    const surroundFile = path.join(outDir, 'surround.mp4');
    const stereoFile = path.join(outDir, 'stereo.mp4');
    let seqSeconds = 0;
    await openExportDialog(page, g);
    await g.step('Export with 5.1 audio (audioChannels 6) → 6-channel output with the sequence duration', 'UI', async () => {
      const seq = await seqState(page);
      seqSeconds = framesToSec(sequenceDurationFrames(seq), seq.fps);
      const r = await runExport(page, outDir, 'surround.mp4', async () => {
        const sel = page.getByTestId('export-dialog').locator('select').filter({ has: page.locator('option', { hasText: '5.1 Surround' }) });
        await sel.selectOption('6');
        await expect(page.getByTestId('export-dialog').locator('.xd-summary')).toContainText('5.1');
      });
      expect(r.status, r.error ?? '').toBe('done');
      const info = ffprobeJson(surroundFile);
      const audio = info.streams.find((s) => s.codec_type === 'audio')!;
      expect(audio.channels).toBe(6);
      const dur = Number(info.format.duration);
      expect(Math.abs(dur - seqSeconds), `ffprobe ${dur.toFixed(3)}s vs sequence ${seqSeconds.toFixed(3)}s`).toBeLessThanOrEqual(0.1);
    });

    await g.step('Export again in stereo → 2-channel output with the sequence duration', 'UI', async () => {
      await page.getByTestId('export-another').click();
      const r = await runExport(page, outDir, 'stereo.mp4', async () => {
        const sel = page.getByTestId('export-dialog').locator('select').filter({ has: page.locator('option', { hasText: '5.1 Surround' }) });
        await sel.selectOption('2');
        await expect(page.getByTestId('export-dialog').locator('.xd-summary')).toContainText('Stereo');
      });
      expect(r.status, r.error ?? '').toBe('done');
      const info = ffprobeJson(stereoFile);
      expect(info.streams.find((s) => s.codec_type === 'audio')!.channels).toBe(2);
      const dur = Number(info.format.duration);
      expect(Math.abs(dur - seqSeconds), `ffprobe ${dur.toFixed(3)}s vs sequence ${seqSeconds.toFixed(3)}s`).toBeLessThanOrEqual(0.1);
      await page.keyboard.press('Escape');
    });

    g.finish(RESULTS, L.errors);
  });
});

// =====================================================================================================
// TEST 4 — Failure Recovery
// =====================================================================================================
test.describe.serial('TEST 4 — Failure Recovery', () => {
  test.setTimeout(600_000);
  const g = new Gauntlet('TEST4-failure-recovery');
  let L: Launched; let tmp: string; let mediaDir: string;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-gauntlet-4-'));
    mediaDir = prepareMedia(tmp);
    L = await launchGauntlet(tmp);
  });
  test.afterAll(async () => { g.write(RESULTS, L?.errors ?? []); await closeApp(L); });

  test('invalid media, broken srt, canceled proxy, unwritable export dir, corrupt project, truncated autosave', async () => {
    let page = L.page;
    const errorsBefore = () => L.errors.length;

    let invalidId = ''; let movieId = ''; let hevcId = '';
    await g.step('Import invalid.mp4 → probeError + "Error" badge; the app stays responsive', 'UI+API', async () => {
      const n0 = errorsBefore();
      [invalidId] = await importMedia(page, [path.join(mediaDir, MEDIA.invalid)]);
      const m = (await mediaState(page))[invalidId];
      expect(m.probeError, 'probeError is set').toBeTruthy();
      expect(m.probe ?? null).toBeNull();
      const row = page.locator(`[data-row-kind="media"][data-media-id="${invalidId}"]`);
      await expect(row.locator('.pp-badge.danger', { hasText: 'Error' })).toBeVisible();
      // responsive: search still filters, and the item can be shown in the Source monitor without crashing
      await page.getByTestId('project-search').fill('invalid');
      await expect(page.locator('[data-row-kind="media"]')).toHaveCount(1);
      await page.getByTestId('project-search').fill('');
      await row.dblclick();
      await expect(page.locator('.source-panel .source-error-card')).toBeVisible();
      await expect(page.locator('.source-panel .source-error-card')).toContainText(/Cannot read file/);
      expect(L.errors.length - n0, `renderer errors: ${L.errors.slice(n0).join(' | ')}`).toBe(0);
    });

    await g.step('Import subs/broken.srt → no cues, warnings returned, no crash', 'API', async () => {
      const n0 = errorsBefore();
      [movieId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
      const res = await page.evaluate(([id, p]) => (window as unknown as W).__recut.actions.importSubtitleFile(id, p), [movieId, path.join(mediaDir, MEDIA.brokenSrt)] as const);
      expect(res.trackId).toBeNull();
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.warnings[0]).toMatch(/No subtitle cues recognised|timing/);
      const tracks = await evalStore<number>(page, '(s, id) => (s.project.media[id].subtitleTracks || []).length', movieId);
      expect(tracks).toBe(0);
      expect(L.errors.length - n0).toBe(0);
    }, { note: 'the Project panel "Import Subtitles…" path uses a native file picker; its toast ("No cues found …") is not reachable from automation' });

    await g.step('Cancel a proxy job mid-way (Proxies tab row Generate → Cancel) → status not ready, no .part files in the cache', 'UI', async () => {
      [hevcId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie0hevc)]);
      await showPanel(page, 'jobs');
      await page.getByTestId('jobs-panel').getByRole('tab', { name: 'Proxies' }).click();
      const row = page.locator(`[data-testid="proxy-row"][data-media-id="${hevcId}"]`);
      await expect(row).toBeVisible();
      await row.getByTestId('proxy-generate').click();
      await row.getByTestId('proxy-cancel').click({ timeout: 5_000 });
      await page.waitForFunction((id) => {
        const w = window as unknown as W;
        const p = w.__recut.store.getState().project.media[id].proxy;
        const active = w.__recut.jobsStore.getState().jobs.some((j) => j.kind === 'proxy' && j.mediaId === id && (j.status === 'queued' || j.status === 'running'));
        return !active && p.status !== 'queued' && p.status !== 'running';
      }, hevcId, { timeout: 60_000 });
      const proxy = (await mediaState(page))[hevcId].proxy;
      const job = (await jobs(page)).find((j) => j.kind === 'proxy' && j.mediaId === hevcId);
      expect(job?.status).toBe('canceled');
      expect(proxy.status).not.toBe('ready');
      expect(proxy.status).toBe('none');
      await expect.poll(() => listFilesRecursive(L.cacheDir).filter((f) => f.endsWith('.part')), { timeout: 10_000 }).toEqual([]);
      await expect(row).toHaveAttribute('data-proxy-status', 'none');
    });

    await g.step('Start an export to an unwritable directory (/proc/recut-nope) → error shown, app continues', 'UI+API', async () => {
      const n0 = errorsBefore();
      await evalStore(page, '(s, id) => { s.insertFromSource(s.project.activeSequenceId, { mediaId: id, in: 1, out: 3, atFrame: 0, mode: "insert" }); s.openDialog("export"); }', movieId);
      const dialog = page.getByTestId('export-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId('export-outdir').fill('/proc/recut-nope');
      await page.getByTestId('export-filename').fill('nope.mp4');
      await page.getByTestId('export-start').click();
      const startError = page.getByTestId('export-start-error');
      const failed = page.getByTestId('export-error');
      await expect(startError.or(failed)).toBeVisible({ timeout: 60_000 });
      const text = (await startError.count()) ? await startError.innerText() : await failed.innerText();
      g.note(`export error surfaced as: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
      expect(text).toMatch(/Cannot create output folder|failed|ENOENT|EACCES|No such file/i);
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as W).__recut.runCommand('edit.deselectAll'))).toBe(true);
      expect(fs.existsSync('/proc/recut-nope')).toBe(false);
      expect(L.errors.length - n0).toBe(0);
    }, { note: 'sequence seeded through the store; dialog opened through the store (Ctrl+M path covered in TEST 1–3)' });

    const p1 = path.join(tmp, 'keep.recut');
    const p2 = path.join(tmp, 'garbage.recut');
    await g.step('Corrupt project: actions.openProject on a garbage .recut returns an error and leaves the current project untouched', 'API', async () => {
      const r1 = await page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), p1);
      expect(r1.ok).toBe(true);
      const before = await evalStore<{ id: string; clips: number; path: string }>(page, '(s) => ({ id: s.project.id, clips: s.project.sequences[s.project.activeSequenceId].videoTracks[0].clips.length, path: s.projectPath })');
      fs.writeFileSync(p2, '{"formatVersion": 1, "this is": not json at all ]]]');
      const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), p2);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Could not open project|Not valid JSON/);
      const after = await evalStore<{ id: string; clips: number; path: string }>(page, '(s) => ({ id: s.project.id, clips: s.project.sequences[s.project.activeSequenceId].videoTracks[0].clips.length, path: s.projectPath })');
      expect(after).toEqual(before);
      expect(after.path).toBe(p1);
    });

    await g.step('Corrupt project with a .bak next to it: loader silently falls back to the backup (observed behaviour)', 'API', async () => {
      // A second save creates keep.recut.bak; then overwrite keep.recut with garbage.
      await evalStore(page, '(s) => s.addMarker(s.project.activeSequenceId, { time: 5, name: "bak marker" })');
      const r2 = await page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), p1);
      expect(r2.ok).toBe(true);
      expect(fs.existsSync(`${p1}.bak`)).toBe(true);
      const good = fs.readFileSync(p1, 'utf8');
      fs.writeFileSync(p1, good.slice(0, Math.floor(good.length / 2)));
      const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), p1);
      g.note(`openProject(corrupt file with .bak) → ok=${res.ok}${res.ok ? '' : ` error=${res.error}`}`, 'API');
      expect(res.ok).toBe(true);
      expect(await evalStore<string>(page, '(s) => s.projectPath')).toBe(p1);
      fs.writeFileSync(p1, good); // restore the file on disk
    }, { note: 'no toast / warning tells the user the backup was used' });

    await g.step('Truncated autosave does not crash recovery on relaunch; the app comes up usable', 'UI+API', async () => {
      const good = fs.readFileSync(p1, 'utf8');
      const autosave = `${p1}.autosave`;
      fs.writeFileSync(autosave, good.slice(0, 200));
      const future = new Date(Date.now() + 20_000);
      fs.utimesSync(autosave, future, future);
      await closeApp(L);
      L = await launchGauntlet(tmp);
      page = L.page;
      await page.waitForTimeout(4_000);
      expect(await page.getByTestId('recovery-dialog').count(), 'no recovery prompt for an unparseable autosave').toBe(0);
      expect(await page.evaluate(() => (window as unknown as W).__recut.runCommand('edit.deselectAll'))).toBe(true);
      const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), p1);
      expect(res.ok).toBe(true);
      expect(L.errors, `renderer errors: ${L.errors.join(' | ')}`).toEqual([]);
    });

    g.finish(RESULTS, L.errors);
  });
});
