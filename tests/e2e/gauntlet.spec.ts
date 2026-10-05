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

export type ConformAnswer = 'click-change' | 'enter' | 'keep';

/**
 * After an insert into an empty sequence whose fps / frame size differ from the media, the app asks
 * "Change sequence to match clip?" (`conform-dialog`). Answer it the requested way. Returns true when it was shown.
 */
async function answerConformIfShown(page: Page, answer: ConformAnswer, settled: () => Promise<boolean>): Promise<boolean> {
  const dlg = page.getByTestId('conform-dialog');
  await expect.poll(async () => (await settled()) || (await dlg.count()) > 0, { timeout: 20_000 }).toBe(true);
  if (!(await dlg.count())) return false;
  if (answer === 'click-change') await page.getByTestId('conform-change').click();
  else if (answer === 'keep') await page.getByTestId('conform-keep').click();
  else await page.keyboard.press('Enter');
  await expect(dlg).toHaveCount(0);
  return true;
}

/** Mark In at `inS`, Out at `outS` with the I / O keys on the focused Source panel, then press ',' (insert). */
async function markAndInsert(page: Page, inS: number, outS: number, conform: ConformAnswer = 'click-change'): Promise<boolean> {
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
  const shown = await answerConformIfShown(page, conform, async () => (await nVideo()) > before);
  await expect.poll(nVideo).toBe(before + 1);
  return shown;
}

/** Stub Electron's native message box in the main process (records each call's message, answers `response`). */
async function stubMessageBox(L: Launched, response: number): Promise<void> {
  await L.app.evaluate(({ dialog }, response) => {
    const g = globalThis as unknown as { __gauntletMsgs: string[] };
    g.__gauntletMsgs = [];
    const fake = async (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message?: string };
      g.__gauntletMsgs.push(String(opts?.message ?? ''));
      return { response, checkboxChecked: false };
    };
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = fake;
  }, response);
}
const stubbedMessages = (L: Launched) => L.app.evaluate(() => (globalThis as unknown as { __gauntletMsgs?: string[] }).__gauntletMsgs ?? []);

/** Stub the native folder / file picker in the main process so a UI button that opens it gets `paths`. */
async function stubOpenDialog(L: Launched, paths: string[]): Promise<void> {
  await L.app.evaluate(({ dialog }, paths) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, paths);
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
  // No blocking (error) items; info / warnings such as "Export always uses original media, not proxies." are fine.
  await expect(page.getByTestId('export-checklist').locator('.xd-check-item.error')).toHaveCount(0);
  await expect(page.getByTestId('export-start')).toBeEnabled();
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
      expect(await evalStore<string[]>(page, '(s) => s.ui.selectedMediaIds'), 'imported item is selected').toEqual([mediaId]);
    });

    await g.step('Import auto-routes the movie into the Movies bin', 'API', async () => {
      const r = await evalStore<{ bin: string | null; category: string; identity: unknown }>(page, '(s, id) => ({ bin: s.project.media[id].binId, category: s.project.media[id].category, identity: s.project.media[id].identity })', mediaId);
      g.note(`"Galaxy Saga 1 - A New Dawn.mp4" → bin=${r.bin} category=${r.category} identity=${JSON.stringify(r.identity)}`, 'API');
      expect(r.bin, 'movie titles without a (year) are not recognised as movies (parseIdentity.importIdentity requires a year)').toBe('bin-movies');
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

    await g.step('I / O / , on the focused Source panel ×3 → conform prompt (click Change) → 3 video + 3 linked audio clips (seeks via store.setSourceTime)', 'UI+API', async () => {
      const ranges: [number, number][] = [[1, 3], [5, 7], [9, 11]];
      const shown: boolean[] = [];
      for (const [i, o] of ranges) {
        shown.push(await markAndInsert(page, i, o, 'click-change'));
        // three-point rules: the playhead lands at the end of the edit; sequence In/Out are cleared
        const v = await evalStore<{ ph: number; i: number | null; o: number | null; end: number }>(page, '(s) => { const q = s.project.sequences[s.project.activeSequenceId]; const ends = q.videoTracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)); return { ph: q.view.playhead, i: q.view.inPoint, o: q.view.outPoint, end: Math.max(...ends) }; }');
        expect(v.ph, 'playhead at end of edit').toBe(v.end); expect(v.i).toBeNull(); expect(v.o).toBeNull();
      }
      expect(shown, 'conform dialog only on the first insert into the empty sequence').toEqual([true, false, false]);
      const fmt = await evalStore<{ fps: { num: number; den: number }; w: number; h: number }>(page, '(s) => { const q = s.project.sequences[s.project.activeSequenceId]; return { fps: q.fps, w: q.width, h: q.height }; }');
      expect(fmt.fps.num / fmt.fps.den).toBeCloseTo(24, 5); expect([fmt.w, fmt.h]).toEqual([640, 360]);
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
      expect([...(await evalStore<string[]>(page, '(s) => s.ui.selectedMediaIds'))].sort()).toEqual([...ids].sort());
    });

    await g.step('Episodes auto-organise into TV › Station Eleven › Season 1 with episode numbers (Project panel shows the bins)', 'UI+API', async () => {
      const r = await evalStore<{ identities: unknown[]; path: string[][] }>(page, `(s, ids) => {
        const bins = s.project.bins;
        const chain = (id) => { const out = []; let b = bins[id]; while (b) { out.unshift(b.name); b = b.parentId ? bins[b.parentId] : null; } return out; };
        return { identities: ids.map((id) => ({ series: s.project.media[id].identity.series, season: s.project.media[id].identity.season, episode: s.project.media[id].identity.episode })),
                 path: ids.map((id) => chain(s.project.media[id].binId)) };
      }`, ids);
      expect(r.identities).toEqual([1, 2, 3].map((episode) => ({ series: 'Station Eleven', season: 1, episode })));
      for (const p of r.path) expect(p).toEqual(['TV', 'Station Eleven', 'Season 1']);
      await expect(page.locator('[data-row-kind="bin"] .pp-name', { hasText: 'Station Eleven' })).toHaveCount(1);
      await expect(page.locator('[data-row-kind="bin"] .pp-name', { hasText: /^Season 1$/ })).toHaveCount(1);
    }, { fallback: async () => { await evalStore(page, '(s, ids) => s.organizeAsSeries(ids.map((id, i) => ({ id, episode: i + 1 })), "Station Eleven", 1)', ids); } });

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

    let transcriptConform = false;
    await g.step('Insert from E01 via the result\'s "Insert at playhead" button (carries the cue)', 'UI', async () => {
      await results.first().hover();
      await results.first().getByLabel('Insert at playhead', { exact: false }).click();
      transcriptConform = await answerConformIfShown(page, 'enter', async () => (await evalStore<number>(page, '(s) => s.project.sequences[s.project.activeSequenceId].videoTracks[0].clips.length')) > 0);
      seq = await seqState(page);
      expect(vclips(seq)).toHaveLength(1);
      expect(vclips(seq)[0].mediaId).toBe(ep1);
      expect(seq.subtitleTracks[0]?.cues.map((c) => c.text)).toEqual(['Where is the doctor?']);
    });

    await g.step('Transcript "Insert at playhead" into the EMPTY 1080p/23.976 sequence offers the conform prompt (like Source , and timeline drop)', 'UI', async () => {
      const fmt = await evalStore<{ fps: number; w: number; h: number }>(page, '(s) => { const q = s.project.sequences[s.project.activeSequenceId]; return { fps: q.fps.num / q.fps.den, w: q.width, h: q.height }; }');
      g.note(`sequence after first Transcript insert: ${fmt.w}x${fmt.h} @ ${fmt.fps.toFixed(3)} fps; conform prompt shown=${transcriptConform}`);
      expect(transcriptConform, 'Transcript insert bypasses maybeConformSequence (calls store.insertFromSource directly)').toBe(true);
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
      const v = vclips(seq);
      const cues = seq.subtitleTracks.flatMap((t, ti) => t.cues.map((c) => `${ti}:${c.text}@${['E01', 'E02', 'E03'][v.findIndex((x) => x.id === c.clipId)] ?? c.clipId}`));
      g.note(`sequence cues after the three inserts: ${cues.join(' | ')}`);
      expect(seq.subtitleTracks.flatMap((t) => t.cues.filter((c) => c.clipId === v[2].id).map((c) => c.text))).toEqual(['Nobody trusts the doctor now.']);
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
      // (the TagInput drops its placeholder once it holds a value, so locate it by its form row)
      const input = dlg.locator('.tl-form-row', { hasText: 'Characters' }).locator('input');
      await input.click(); await input.fill('Kirsten'); await input.press('Enter');
      await input.fill('Jeevan'); await input.press('Enter');
      await dlg.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dlg).toHaveCount(0);
      seq = await seqState(page);
      expect(vclips(seq)[0].characters).toEqual(['Kirsten', 'Jeevan']);
      expect(await evalStore<string[]>(page, '(s) => s.project.tags.characters')).toEqual(expect.arrayContaining(['Kirsten', 'Jeevan']));
      await setMaximized(page, 'timeline', false);
    }, { note: 'zoom set through the store', fallback: async () => { await page.keyboard.press('Escape'); await setMaximized(page, 'timeline', false); await evalStore(page, '(s, id) => s.setClipTags(s.project.activeSequenceId, id, { characters: ["Kirsten", "Jeevan"] })', vclips(seq)[0].id); } });

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
      const cuesAfter = seq.subtitleTracks.flatMap((t, ti) => t.cues.map((x) => `${ti}:${x.text}@${x.clipId === a.id ? 'E01' : x.clipId === c.id ? 'E03' : x.clipId}`));
      g.note(`sequence cues after the ripple delete: ${cuesAfter.join(' | ')}`);
      expect(seq.subtitleTracks.flatMap((t) => t.cues.map((x) => x.text)).sort()).toEqual(['Nobody trusts the doctor now.', 'Where is the doctor?']);
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
    let undecodable: (keyof typeof id)[] = [];
    await g.step('Proxies are on → undecodable files (HEVC / AC-3) get proxies automatically on import; Jobs › Proxies shows them ready', 'UI', async () => {
      expect(await evalStore<boolean>(page, '(s) => s.project.settings.useProxies')).toBe(true);
      const m0 = await mediaState(page);
      undecodable = (Object.keys(id) as (keyof typeof id)[]).filter((k) => m0[id[k]].probe?.browserPlayable === false);
      g.note(`not browser-playable: ${undecodable.join(', ') || '(none)'}`, 'API');
      expect(undecodable).toContain('ac3');
      if (!hevcNative) expect(undecodable).toContain('hevc');
      await showPanel(page, 'jobs');
      await jobsPanel.getByRole('tab', { name: 'Proxies' }).click();
      await expect(page.getByTestId('proxies-tab')).toBeVisible();
      for (const k of undecodable) await expect(proxyRow(id[k])).toHaveAttribute('data-proxy-status', 'ready', { timeout: 300_000 });
      const m = await mediaState(page);
      for (const k of Object.keys(id) as (keyof typeof id)[]) {
        if (undecodable.includes(k)) {
          expect(m[id[k]].proxy.status, `${k}: ${m[id[k]].proxy.error ?? ''}`).toBe('ready');
          expect(fs.existsSync(m[id[k]].proxy.path!)).toBe(true);
        } else {
          expect(m[id[k]].proxy.status, `${k} is decodable → no automatic proxy`).toBe('none');
        }
      }
    }, { fallback: async () => { for (const k of undecodable) await page.evaluate((x) => (window as unknown as W).__recut.actions.startProxy(x), id[k]); await page.waitForFunction((ids) => { const media = (window as unknown as W).__recut.store.getState().project.media; return ids.every((i: string) => media[i].proxy.status === 'ready'); }, undecodable.map((k) => id[k]), { timeout: 300_000 }); } });

    await g.step('Source monitor shows the PROXY badge for the HEVC file and plays it (currentTime advances)', 'UI', async () => {
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

    await g.step('Build a sequence with one range from each of the four files (dbl-click → I/O → ","; conform prompt answered with Enter)', 'UI+API', async () => {
      const shown: boolean[] = [];
      for (const k of ['h264', 'ac3', 'hevc', 'surround'] as const) {
        const row = page.locator(`[data-row-kind="media"][data-media-id="${id[k]}"]`);
        await row.scrollIntoViewIfNeeded();
        await row.dblclick();
        await expect.poll(() => evalStore<string>(page, '(s) => s.ui.sourceClip?.mediaId')).toBe(id[k]);
        await waitSourceReady(page);
        shown.push(await markAndInsert(page, 1, 3, 'enter'));
      }
      expect(shown).toEqual([true, false, false, false]);
      const fmt = await evalStore<{ fps: number; w: number }>(page, '(s) => { const q = s.project.sequences[s.project.activeSequenceId]; return { fps: q.fps.num / q.fps.den, w: q.width }; }');
      expect(fmt.w, 'Enter = default button (Change)').toBe(640); expect(fmt.fps).toBeCloseTo(24, 5);
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
    const chips = async () => ({
      offline: await page.getByTestId('program-offline').count(), needsProxy: await page.getByTestId('program-needs-proxy').count(),
      cantPlay: await page.getByTestId('program-missing').count(), proxy: await page.getByTestId('program-proxy').count(),
    });
    await g.step('Proxies ON: the Program monitor renders non-black frames for every clip; Proxy chip on the HEVC clip; no problem chips', 'UI+API', async () => {
      await jobsPanel.getByRole('tab', { name: 'Proxies' }).click();
      await expect(proxySwitch()).toHaveAttribute('aria-checked', 'true');
      for (const k of ['h264', 'ac3', 'hevc', 'surround'] as const) {
        await playheadInto(id[k]);
        await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
        if (k === 'hevc' && !hevcNative) await expect(page.getByTestId('program-proxy')).toBeVisible();
      }
      const c = await chips();
      expect([c.offline, c.needsProxy, c.cantPlay]).toEqual([0, 0, 0]);
    }, { note: 'playhead placed through the store' });

    await g.step('Proxies OFF (Proxies tab switch): H.264 clips render from the originals (no Proxy chip, no problem chips)', 'UI+API', async () => {
      await proxySwitch().click();
      await expect.poll(() => evalStore<boolean>(page, '(s) => s.project.settings.useProxies')).toBe(false);
      await playheadInto(id.h264);
      await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
      await expect(page.getByTestId('program-proxy')).toHaveCount(0);
      expect(await page.getByTestId('program-missing').count()).toBe(0);
    });

    await g.step('Proxies OFF with the HEVC proxy still ready — observed behaviour (app falls back to the proxy for an undecodable original)', 'UI+API', async () => {
      if (hevcNative) { g.note('skipped: HEVC decodes natively in this Chromium build'); return; }
      await playheadInto(id.hevc);
      await page.waitForTimeout(1500);
      const c = await chips();
      const bright = await programBrightness(page);
      g.note(`observed with proxies off + HEVC proxy ready: needs-proxy chip=${c.needsProxy} proxy chip=${c.proxy} brightness=${bright.toFixed(0)}`);
      expect(c.needsProxy === 1 || (c.proxy === 1 && bright > 20)).toBe(true);
    }, { note: 'resolvePlaybackPath: a ready proxy is used for undecodable originals even with proxies off' });

    await g.step('Proxies OFF + HEVC proxy deleted (row button) → Program shows `program-needs-proxy` "Needs proxy: N" while H.264 renders; chip\'s "Generate proxies" → renders again', 'UI+API', async () => {
      if (hevcNative) { g.note('skipped: HEVC decodes natively in this Chromium build'); return; }
      await proxyRow(id.hevc).getByLabel('Delete proxy').click();
      await expect(proxyRow(id.hevc)).toHaveAttribute('data-proxy-status', 'none');
      await playheadInto(id.hevc);
      const chip = page.getByTestId('program-needs-proxy');
      await expect(chip).toBeVisible({ timeout: 20_000 });
      await expect(chip).toContainText(/Needs proxy: [1-9]/);
      g.note(`needs-proxy chip text with one undecodable file at the playhead: "${(await chip.innerText()).replace(/\s+/g, ' ').trim()}" (counts video + linked audio clips, not files)`);
      expect(await page.getByTestId('program-offline').count()).toBe(0);
      await playheadInto(id.h264);
      await expect.poll(() => programBrightness(page), { message: 'H.264 clip renders while HEVC needs a proxy', timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
      await expect(page.getByTestId('program-proxy')).toHaveCount(0);
      // the chip reflects the clips under the playhead → go back to the HEVC clip before using its action
      await playheadInto(id.hevc);
      await expect(chip).toBeVisible({ timeout: 20_000 });
      const gen = page.getByTestId('program-generate-proxies');
      if (!(await gen.isVisible({ timeout: 20_000 }).catch(() => false)) && !(await gen.waitFor({ timeout: 20_000 }).then(() => true, () => false))) {
        const st = await evalStore<unknown>(page, '(s, id) => s.project.media[id].proxy', id.hevc);
        const active = (await jobs(page)).filter((j) => j.kind === 'proxy' && j.mediaId === id.hevc).map((j) => j.status);
        throw new Error(`no "Generate proxies" action on the chip: chip="${(await chip.innerText().catch(() => '(gone)')).replace(/\s+/g, ' ')}" hevc proxy=${JSON.stringify(st)} jobs=${active.join(',')}`);
      }
      await gen.click();
      await expect(proxyRow(id.hevc)).toHaveAttribute('data-proxy-status', 'ready', { timeout: 180_000 });
      await expect(page.getByTestId('program-needs-proxy')).toHaveCount(0, { timeout: 20_000 });
      // Nudge the playhead one frame so the frame is re-planned (the paused-frame refresh is checked separately below).
      const seqNow = await seqState(page);
      await evalStore(page, '(s, f) => s.setView(s.project.activeSequenceId, { playhead: f })', seqNow.view.playhead + 1);
      await expect.poll(() => programBrightness(page), { message: 'HEVC renders again after regenerating its proxy (proxies off → fallback)', timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
    });

    await g.step('Paused Program frame refreshes by itself when the clip under the playhead gets a playable source (proxy becomes ready)', 'UI+API', async () => {
      if (hevcNative) { g.note('skipped: HEVC decodes natively in this Chromium build'); return; }
      // proxies are off; delete the proxy again → black + chip; regenerate from the Proxies row WITHOUT moving the playhead.
      await proxyRow(id.hevc).getByLabel('Delete proxy').click();
      await playheadInto(id.hevc);
      await expect(page.getByTestId('program-needs-proxy')).toBeVisible({ timeout: 20_000 });
      await proxyRow(id.hevc).getByTestId('proxy-generate').click();
      await expect(proxyRow(id.hevc)).toHaveAttribute('data-proxy-status', 'ready', { timeout: 180_000 });
      await expect(page.getByTestId('program-needs-proxy')).toHaveCount(0, { timeout: 20_000 });
      let refreshed = true;
      try { await expect.poll(() => programBrightness(page), { timeout: 15_000, intervals: [250] }).toBeGreaterThan(20); } catch { refreshed = false; }
      const seqNow = await seqState(page);
      await evalStore(page, '(s, f) => s.setView(s.project.activeSequenceId, { playhead: f })', seqNow.view.playhead + 1);
      const afterNudge = await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20).then(() => true, () => false);
      g.note(`paused frame refreshed on its own=${refreshed}; rendered after a 1-frame playhead nudge=${afterNudge}`);
      expect(refreshed, 'Program stays black on the paused frame after the proxy becomes ready until the playhead moves').toBe(true);
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
      await expect(page.getByTestId('program-offline')).toContainText(/Offline: [1-9]/);
      g.note(`Program chip: ${(await page.getByTestId('program-offline').innerText()).trim()}`);
    }, {
      fallback: async () => {
        const res = await page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectPath);
        expect(res.ok).toBe(true);
        await page.evaluate(() => (window as unknown as W).__recut.actions.verifyMediaOnline());
        await expect.poll(() => evalStore<number>(page, '(s) => Object.values(s.project.media).filter((m) => m.offline).length')).toBe(4);
        await evalStore(page, '(s) => s.openDialog("relink")');
      },
    });

    await g.step('window.recut.scanForRelink on the moved folder finds all four files by name+size', 'API', async () => {
      const found = await page.evaluate(async (folder) => {
        const w = window as unknown as W;
        const offline = Object.values(w.__recut.store.getState().project.media as Record<string, { id: string; path: string; fileSize?: number; probe?: { size?: number }; offline: boolean }>).filter((m) => m.offline);
        return w.recut.scanForRelink({ folder, missing: offline.map((m) => ({ mediaId: m.id, fileName: m.path.split('/').pop(), size: m.fileSize ?? m.probe?.size })) }) as Promise<{ missingMediaId: string; path: string; confidence: string }[]>;
      }, movedDir);
      expect(found).toHaveLength(4);
      expect(found.every((f) => f.confidence === 'name+size' && f.path.startsWith(movedDir))).toBe(true);
    });

    await g.step('Relink dialog: "Search folder…" (native folder picker stubbed in main to return the moved folder) → "Apply 4 matches" → all online', 'UI', async () => {
      await stubOpenDialog(L, [movedDir]);
      const dlg = page.getByRole('dialog').filter({ hasText: 'Relink offline media' });
      await expect(dlg).toBeVisible();
      await dlg.getByRole('button', { name: /Search folder/ }).click();
      await expect(page.locator('.toast', { hasText: 'Found 4 matches' })).toBeVisible({ timeout: 30_000 });
      await dlg.getByRole('button', { name: /Apply 4 matches/ }).click();
      await expect.poll(() => evalStore<number>(page, '(s) => Object.values(s.project.media).filter((m) => m.offline).length'), { timeout: 60_000 }).toBe(0);
      await expect(dlg).toContainText('All media is online');
      await dlg.getByRole('button', { name: 'Check files' }).click();
      await expect(page.locator('.toast', { hasText: 'All media online' })).toBeVisible();
      await dlg.locator('button.btn', { hasText: /^Close$/ }).click();
      await expect(dlg).toHaveCount(0);
      await expect(page.getByTestId('offline-banner')).toHaveCount(0);
      await expect(page.getByTestId('program-offline')).toHaveCount(0);
      const m = await mediaState(page);
      for (const k of Object.keys(id) as (keyof typeof id)[]) {
        expect(m[id[k]].offline).toBe(false);
        expect(m[id[k]].path.startsWith(movedDir)).toBe(true);
        expect(m[id[k]].probe?.duration).toBeGreaterThan(0);
      }
      await playheadInto(id.h264);
      await expect.poll(() => programBrightness(page), { timeout: 30_000, intervals: [250] }).toBeGreaterThan(20);
    }, {
      note: 'only the OS folder picker is stubbed (dialog.showOpenDialog in the main process)',
      fallback: async () => {
        await page.evaluate(async (folder) => {
          const w = window as unknown as W;
          const st = w.__recut.store.getState();
          const offline = Object.values(st.project.media as Record<string, { id: string; path: string; fileSize?: number; offline: boolean }>).filter((m) => m.offline);
          const found: { missingMediaId: string; path: string }[] = await w.recut.scanForRelink({ folder, missing: offline.map((m) => ({ mediaId: m.id, fileName: m.path.split('/').pop(), size: m.fileSize })) });
          for (const m of offline) {
            const c = found.find((f) => f.missingMediaId === m.id);
            if (!c) continue;
            const s = await w.recut.stat(c.path);
            w.__recut.store.getState().relinkMedia(m.id, c.path, s.exists ? { size: s.size, mtimeMs: s.mtimeMs } : undefined);
            await w.__recut.actions.probeMedia(m.id);
          }
        }, movedDir);
        await evalStore(page, '(s) => s.closeDialog("relink")');
        expect(await evalStore<number>(page, '(s) => Object.values(s.project.media).filter((m) => m.offline).length')).toBe(0);
      },
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
        const sel = page.getByTestId('export-dialog').locator('select:not([data-testid="export-preset"])').filter({ has: page.locator('option', { hasText: /^5\.1 Surround$/ }) });
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
        const sel = page.getByTestId('export-dialog').locator('select:not([data-testid="export-preset"])').filter({ has: page.locator('option', { hasText: /^5\.1 Surround$/ }) });
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

  test('invalid media, broken srt, canceled proxy, unwritable export dir, corrupt project, corrupt autosave, quit prompt', async () => {
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

    await g.step('Cancel a proxy job mid-way (proxies off before import; Proxies tab row Generate → Cancel once it is running) → not ready, no .part files', 'UI', async () => {
      await showPanel(page, 'jobs');
      await page.getByTestId('jobs-panel').getByRole('tab', { name: 'Proxies' }).click();
      const sw = page.getByTestId('proxies-tab').getByRole('switch', { name: /Playback proxies/ });
      if ((await sw.getAttribute('aria-checked')) === 'true') await sw.click();
      await expect.poll(() => evalStore<boolean>(page, '(s) => s.project.settings.useProxies')).toBe(false);
      [hevcId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie0hevc)]);
      const row = page.locator(`[data-testid="proxy-row"][data-media-id="${hevcId}"]`);
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('data-proxy-status', 'none');
      let outcome = '';
      for (let attempt = 0; attempt < 3 && outcome !== 'canceled'; attempt++) {
        const before = (await jobs(page)).filter((j) => j.kind === 'proxy').map((j) => j.id);
        // Click Generate, then click the row's Cancel button as soon as the job is running (DOM clicks inside one evaluate so the
        // short synthetic file cannot finish in between two Playwright round-trips).
        outcome = await page.evaluate(async ({ id, before }) => {
          const w = window as unknown as W;
          const rowEl = () => document.querySelector(`[data-testid="proxy-row"][data-media-id="${id}"]`);
          (rowEl()?.querySelector('[data-testid="proxy-generate"]') as HTMLElement | null)?.click();
          const t0 = performance.now();
          while (performance.now() - t0 < 60_000) {
            const j = w.__recut.jobsStore.getState().jobs.find((x) => x.kind === 'proxy' && x.mediaId === id && !before.includes(x.id));
            if (j && (j.status === 'done' || j.status === 'failed')) return `finished-before-cancel:${j.status}`;
            const btn = rowEl()?.querySelector('[data-testid="proxy-cancel"]') as HTMLElement | null;
            if (j && j.status === 'running' && btn) { btn.click(); return `cancel-clicked@${Math.round(j.progress * 100)}%`; }
            await new Promise((r) => setTimeout(r, 15));
          }
          return 'timeout';
        }, { id: hevcId, before });
        g.note(`attempt ${attempt + 1}: ${outcome}`);
        if (!outcome.startsWith('cancel-clicked')) { await evalStore(page, '(s, id) => s.setProxy(id, { status: "none" })', hevcId); continue; }
        const job = await waitForJob(page, { kind: 'proxy', exclude: before, mediaId: hevcId }, 60_000);
        outcome = job?.status ?? 'missing';
      }
      expect(outcome).toBe('canceled');
      await page.waitForFunction((id) => { const p = (window as unknown as W).__recut.store.getState().project.media[id].proxy; return p.status !== 'queued' && p.status !== 'running'; }, hevcId, { timeout: 30_000 });
      const proxy = (await mediaState(page))[hevcId].proxy;
      expect(proxy.status).not.toBe('ready');
      expect(proxy.status).toBe('none');
      await expect.poll(() => listFilesRecursive(L.cacheDir).filter((f) => /\.part(-|$)/.test(path.basename(f))), { timeout: 15_000 }).toEqual([]);
      await expect(row).toHaveAttribute('data-proxy-status', 'none');
      await expect(row.getByTestId('proxy-generate')).toBeVisible();
    }, { note: 'proxies switched off through the Proxies-tab switch so the import does not auto-start a proxy' });

    /** Fill the Export dialog with `outDir`, press Export, expect a start error or a failed job; returns the message. */
    const exportExpectingFailure = async (outDir: string): Promise<string> => {
      const dialog = page.getByTestId('export-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId('export-outdir').fill(outDir);
      await page.getByTestId('export-filename').fill('nope.mp4');
      await expect(page.getByTestId('export-start')).toBeEnabled();
      const clicked = page.getByTestId('export-start').click({ timeout: 15_000 }).then(() => 'ok', (e: Error) => e.message);
      const startError = page.getByTestId('export-start-error');
      const failed = page.getByTestId('export-error');
      const shown = await Promise.race([
        expect(startError.or(failed)).toBeVisible({ timeout: 45_000 }).then(() => true, () => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), 50_000)),
      ]);
      if (!shown) {
        const mainAlive = await Promise.race([L.app.evaluate(() => 1).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 8_000))]);
        throw new Error(`no export error after 45 s; click=${await Promise.race([clicked, Promise.resolve('pending')])}; main process responsive=${mainAlive}`);
      }
      const text = (await startError.count()) ? await startError.innerText() : await failed.innerText();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as W).__recut.runCommand('edit.deselectAll'))).toBe(true);
      return text.replace(/\s+/g, ' ').trim();
    };

    await g.step('Start an export to an unwritable directory (/proc/recut-nope on Linux, a path inside a file elsewhere) → error shown, app continues', 'UI+API', async () => {
      const n0 = errorsBefore();
      await evalStore(page, '(s, id) => { s.insertFromSource(s.project.activeSequenceId, { mediaId: id, in: 1, out: 3, atFrame: 0, mode: "insert" }); s.openDialog("export"); }', movieId);
      // /proc is only unwritable on Linux; elsewhere use a folder "inside" an existing file, which no OS can create.
      const unwritable = process.platform === 'linux' ? '/proc/recut-nope' : path.join(mediaDir, MEDIA.movie1, 'recut-nope');
      const text = await exportExpectingFailure(unwritable);
      g.note(`export error surfaced as: ${text.slice(0, 160)}`);
      expect(text).toMatch(/Cannot create output folder|failed|ENOENT|EACCES|ENOTDIR|No such file|not a folder/i);
      expect(fs.existsSync(unwritable)).toBe(false);
      expect(L.errors.length - n0).toBe(0);
    }, {
      note: 'sequence seeded through the store; dialog opened through the store (Ctrl+M path covered in TEST 1–3)',
      timeoutMs: 150_000,
      fallback: async () => {
        // The main process is frozen: kill it, relaunch (crash recovery may offer the untitled autosave → Discard),
        // re-seed and verify the same failure handling with an unwritable path that does not hang (parent is a file).
        L.app.process().kill('SIGKILL');
        await new Promise((r) => setTimeout(r, 2_000));
        L = await launchGauntlet(tmp);
        page = L.page;
        const rec = page.getByTestId('recovery-dialog');
        if (await rec.waitFor({ timeout: 8_000 }).then(() => true, () => false)) {
          g.note('relaunch after the forced kill offered crash recovery (untitled autosave) → Discard');
          await page.getByRole('button', { name: 'Discard', exact: true }).click();
        }
        [movieId] = await importMedia(page, [path.join(mediaDir, MEDIA.movie1)]);
        await evalStore(page, '(s, id) => { s.insertFromSource(s.project.activeSequenceId, { mediaId: id, in: 1, out: 3, atFrame: 0, mode: "insert" }); s.openDialog("export"); }', movieId);
        const blocker = path.join(tmp, 'not-a-folder.txt');
        fs.writeFileSync(blocker, 'x');
        const text = await exportExpectingFailure(path.join(blocker, 'out'));
        g.note(`export to <file>/out error surfaced as: ${text.slice(0, 160)}`);
        expect(text).toMatch(/Cannot create output folder|ENOTDIR|EEXIST|failed/i);
        expect(L.errors).toEqual([]);
      },
    });

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

    await g.step('Corrupt autosaves do not break startup recovery: truncated untitled autosave ignored, the valid newer autosave of keep.recut is still offered and recovers', 'UI+API', async () => {
      await closeApp(L);
      const good = fs.readFileSync(p1, 'utf8');
      const proj = JSON.parse(good);
      proj.name = 'keep (recovered)';
      const autosave = `${p1}.autosave`;
      fs.writeFileSync(autosave, JSON.stringify(proj));
      const untitled = path.join(L.userData, 'autosave', 'untitled.recut.autosave');
      fs.mkdirSync(path.dirname(untitled), { recursive: true });
      fs.writeFileSync(untitled, good.slice(0, 200));
      const future = new Date(Date.now() + 30_000);
      fs.utimesSync(autosave, future, future);
      fs.utimesSync(untitled, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000)); // newest, but unreadable
      L = await launchGauntlet(tmp);
      page = L.page;
      const rec = page.getByTestId('recovery-dialog');
      await expect(rec).toBeVisible({ timeout: 30_000 });
      await expect(rec).toContainText('keep.recut');
      await page.getByRole('button', { name: 'Recover', exact: true }).click();
      await expect.poll(() => evalStore<string>(page, '(s) => s.project.name')).toBe('keep (recovered)');
      expect(await evalStore<string>(page, '(s) => s.projectPath')).toBe(p1);
      expect(await evalStore<boolean>(page, '(s) => s.dirty')).toBe(true);
      expect(await page.evaluate(() => (window as unknown as W).__recut.runCommand('edit.deselectAll'))).toBe(true);
      expect(L.errors, `renderer errors: ${L.errors.join(' | ')}`).toEqual([]);
    }, {
      fallback: async () => {
        if (!L.page.isClosed()) { page = L.page; return; }
        L = await launchGauntlet(tmp); page = L.page;
      },
    });

    await g.step('Quit prompt: dirty project + window.recut.quit(false) with the native Save/Don\'t Save/Cancel box stubbed to Cancel → app stays open > 5 s', 'UI+API', async () => {
      await evalStore(page, '(s) => s.addMarker(s.project.activeSequenceId, { time: 12, name: "unsaved" })');
      expect(await evalStore<boolean>(page, '(s) => s.dirty')).toBe(true);
      await stubMessageBox(L, 2);
      let closed = false;
      L.app.on('close', () => { closed = true; });
      await page.evaluate(() => { void (window as unknown as W).recut.quit(false); });
      await expect.poll(() => stubbedMessages(L), { timeout: 15_000 }).toEqual([expect.stringMatching(/Save changes to .* before quitting\?/)]);
      await page.waitForTimeout(5_500);
      expect(closed, 'app closed despite Cancel').toBe(false);
      expect(page.isClosed()).toBe(false);
      expect(await L.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)).toBe(1);
      expect(await evalStore<boolean>(page, '(s) => s.dirty'), 'still dirty: nothing saved or discarded').toBe(true);
      expect(await page.evaluate(() => (window as unknown as W).__recut.runCommand('edit.deselectAll'))).toBe(true);
      // A second quit request is handled again (pending state was cleared by quitCancel).
      await page.evaluate(() => { void (window as unknown as W).recut.quit(false); });
      await expect.poll(async () => (await stubbedMessages(L)).length, { timeout: 15_000 }).toBe(2);
      await page.waitForTimeout(1_000);
      expect(closed).toBe(false);
    }, { note: 'dialog.showMessageBox replaced in the main process via electronApp.evaluate' });

    g.finish(RESULTS, L.errors);
  });
});
