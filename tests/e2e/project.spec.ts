/**
 * Project / media panel e2e. Drives the real Electron app under xvfb:
 *   npm run build && bash scripts/make-test-media.sh <tmp> short
 *   xvfb-run -a npx playwright test tests/e2e/project.spec.ts -c tests/e2e/playwright.config.ts
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const EPISODES = ['Station Eleven S01E01.mp4', 'Station Eleven S01E02.mp4', 'Station Eleven S01E03.mp4'];

let app: ElectronApplication;
let page: Page;
let tmp: string;
let mediaDir: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-project-'));
  mediaDir = process.env.RECUT_TEST_MEDIA ?? path.join(tmp, 'media');
  if (!fs.existsSync(path.join(mediaDir, 'tv/Season 01', EPISODES[0]))) {
    execSync(`bash scripts/make-test-media.sh "${mediaDir}" short`, { cwd: root, stdio: 'inherit' });
  }
  app = await _electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: root,
    env: { ...process.env, RECUT_USER_DATA: path.join(tmp, 'user'), RECUT_CACHE_DIR: path.join(tmp, 'cache'), RECUT_DISABLE_GPU: '1', RECUT_UPDATE_CHECK: '0' },
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[renderer:pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[renderer:error]', m.text()); });
  // Deterministic layout for screenshots.
  await page.waitForSelector('#root', { state: 'attached', timeout: 60_000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.evaluate(() => { localStorage.removeItem('recut.layout.v1'); }); break; }
    catch { await page.waitForTimeout(500); } // execution context replaced during startup; retry
  }
  await page.reload();
  const mounted = await page.waitForSelector('#root .layout', { timeout: 20_000 }).then(() => true, () => false);
  if (!mounted) {
    // Another panel crashed the React tree at mount (not the Project panel). Keep this spec meaningful by
    // persisting a layout without the Timeline/Storyline zone content and reloading.
    console.log('[project.spec] layout failed to mount; retrying without center-bottom panels');
    await page.evaluate(() => {
      const zones = { 'left-top': ['project'], 'left-bottom': ['transcript', 'scenes', 'continuity', 'subtitles', 'markers', 'history', 'jobs'], 'monitor-left': ['source'], 'monitor-right': ['program'], 'center-bottom': [], right: ['inspector', 'compare'] };
      const sizes = { leftW: 320, rightW: 300, leftSplit: 0.42, centerSplit: 0.5, monitorSplit: 0.5 };
      localStorage.setItem('recut.layout.v1', JSON.stringify({ version: 1, workspace: 'Editing', layouts: { Editing: { zones, active: {}, sizes } } }));
    });
    await page.reload();
    await page.waitForSelector('#root .layout', { timeout: 60_000 });
  }
  await page.waitForSelector('[data-testid="project-panel"]');
  // Maximize the Project zone so the virtualized list renders every row (assertions count DOM rows).
  await setMaximized(true);
});

async function setMaximized(on: boolean) {
  const maximized = await page.evaluate(() => !!document.querySelector('.layout-maximized'));
  if (maximized === on) return;
  await page.locator('[data-zone="left-top"] .zone-tab[data-panel="project"]').dblclick();
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.layout-maximized'))).toBe(on);
}

test.afterAll(async () => {
  // Unsaved edits would make the quit flow prompt to save and block close().
  try { await page.evaluate(() => (window as any).__recut.store.setState({ dirty: false })); } catch { /* gone */ }
  await app?.close();
});

const episodePaths = () => EPISODES.map((n) => path.join(mediaDir, 'tv/Season 01', n));

test('first run: an empty project shows a prominent Import call to action', async () => {
  const cta = page.getByTestId('empty-import');
  await expect(cta).toBeVisible();
  await expect(page.getByTestId('project-panel')).toContainText('subtitles next to media are picked up automatically');
});

test('imports three episodes and shows probed rows', async () => {
  await page.evaluate((paths) => (window as any).__recut.actions.importMediaFiles(paths), episodePaths());
  await page.waitForFunction(() => {
    const m = Object.values((window as any).__recut.store.getState().project.media) as any[];
    return m.length === 3 && m.every((x) => x.probe);
  }, undefined, { timeout: 60_000 });

  const rows = page.locator('[data-row-kind="media"]');
  await expect(rows).toHaveCount(3);
  for (const name of EPISODES) {
    const row = rows.filter({ hasText: name.replace('.mp4', '') });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('00:12');      // 3 scenes × 4 s
    await expect(row).toContainText('640×360');
    await expect(row).toContainText('24');          // fps
    await expect(row).toContainText('2ch aac');
  }
  await expect(page.getByTestId('empty-import')).toHaveCount(0);
  // Identity parsed at import: Episode category, routed into TV › Station Eleven › Season 1 and selected.
  const placed = await page.evaluate(() => {
    const s = (window as any).__recut.store.getState();
    const bin = (id: string | null) => (id ? s.project.bins[id] : null);
    return Object.values(s.project.media).map((m: any) => ({
      category: m.category, identity: m.identity, bin: bin(m.binId)?.name, parent: bin(bin(m.binId)?.parentId)?.name,
      top: bin(bin(bin(m.binId)?.parentId)?.parentId)?.id, selected: s.ui.selectedMediaIds.includes(m.id),
    })).sort((a: any, b: any) => a.identity.episode - b.identity.episode);
  });
  expect(placed.map((p) => p.identity.episode)).toEqual([1, 2, 3]);
  for (const p of placed) expect(p).toMatchObject({ category: 'Episode', bin: 'Season 1', parent: 'Station Eleven', top: 'bin-tv', selected: true, identity: { series: 'Station Eleven', season: 1 } });

  // Info footer (collapsed by default) shows read-only metadata for the selected item.
  await rows.first().click();
  const info = page.getByTestId('info-footer');
  await expect(info).toContainText('Station Eleven S01E01');
  await info.locator('.pp-info-head').click();
  await expect(info).toContainText('h264 640×360');
  await expect(info).toContainText('2ch (stereo)');
  await info.locator('.pp-info-head').click();
});

test('organizes the episodes as a series through the context menu and renders the series tree', async () => {
  const rows = page.locator('[data-row-kind="media"]');
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => (window as any).__recut.store.getState().ui.selectedMediaIds.length)).toBe(3);

  await rows.nth(1).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Organize as Series' }).click();
  const seriesName = page.getByTestId('series-name');
  await expect(seriesName).toHaveValue('Station Eleven');
  // Episode numbers were parsed from the file names.
  const table = page.locator('.pp-dialog-table tbody tr');
  await expect(table).toHaveCount(3);
  await page.getByTestId('series-apply').click();

  const identities = await page.evaluate(() => Object.values((window as any).__recut.store.getState().project.media).map((m: any) => m.identity).sort((a: any, b: any) => a.episode - b.episode));
  expect(identities).toEqual([
    { series: 'Station Eleven', season: 1, episode: 1 },
    { series: 'Station Eleven', season: 1, episode: 2 },
    { series: 'Station Eleven', season: 1, episode: 3 },
  ]);
  // Bins mode: TV › Station Eleven › Season 1 exist and hold the episodes.
  const binNames = page.locator('[data-row-kind="bin"] .pp-name');
  await expect(binNames.filter({ hasText: 'Station Eleven' })).toHaveCount(1);
  await expect(binNames.filter({ hasText: 'Season 1' })).toHaveCount(1);
  await expect(page.locator('[data-row-kind="media"]').first()).toContainText('S01E01');

  // Series mode: Series → Season → Episodes.
  await page.getByTestId('mode-series').click();
  await expect(page.locator('[data-group-kind="series"]')).toContainText('Station Eleven');
  await expect(page.locator('[data-group-kind="season"]')).toContainText('Season 1');
  await expect(page.locator('[data-row-kind="media"]')).toHaveCount(3);
  await expect(page.locator('[data-group-kind="loose"]')).toHaveCount(0);
  await page.getByTestId('mode-bins').click();
});

test('search filters by identity and tag text', async () => {
  const search = page.getByTestId('project-search');
  await search.fill('S01E02');
  await expect(page.locator('[data-row-kind="media"]')).toHaveCount(1);
  await expect(page.locator('[data-row-kind="media"]')).toContainText('S01E02');
  await search.fill('');
  await expect(page.locator('[data-row-kind="media"]')).toHaveCount(3);
});

test('detects scenes through the context menu and lists scene rows under the media', async () => {
  const row = page.locator('[data-row-kind="media"]', { hasText: 'S01E01' });
  const mediaId = await row.getAttribute('data-media-id');
  await row.click();                       // plain click: only this item is selected
  await row.click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Detect Scenes' }).click();
  await page.getByTestId('detect-run').click();
  // The media row reports progress while the job runs, then the result lands in the store.
  await expect(row).toContainText('Scenes');
  await expect.poll(() => page.evaluate((id) => (window as any).__recut.store.getState().project.media[id]?.sceneDetectStatus, mediaId), { timeout: 90_000 }).toBe('done');
  const scenes = page.locator(`[data-row-kind="scene"][data-media-id="${mediaId}"]`);
  await expect(scenes.first()).toBeVisible();
  const n = await scenes.count();
  expect(n).toBeGreaterThanOrEqual(2);
  expect(await page.locator('[data-row-kind="scene"]').count()).toBe(n);   // only this media was detected
  await expect(scenes.first()).toContainText('Scene 001');
  await expect(scenes.first()).toContainText('00:00–');
  await expect(row).toContainText(`${n} scene${n === 1 ? '' : 's'}`);

  // Inline rename of a scene via F2.
  await scenes.first().click();
  await page.keyboard.press('F2');
  const field = page.getByTestId('rename-field');
  await expect(field).toBeVisible();
  await field.fill('Cold open');
  await page.keyboard.press('Enter');
  await expect(scenes.first()).toContainText('Cold open');
  // Merge with next via context menu shrinks the list by one.
  await scenes.first().click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Merge with Next' }).click();
  await expect(scenes).toHaveCount(n - 1);
});

test('keyboard: Enter loads the selected media in the Source monitor', async () => {
  const rows = page.locator('[data-row-kind="media"]');
  await rows.nth(1).click();
  await page.keyboard.press('Enter');
  const src = await page.evaluate(() => (window as any).__recut.store.getState().ui.sourceClip);
  expect(src?.mediaId).toBeTruthy();
  const name = await page.evaluate((id) => (window as any).__recut.store.getState().project.media[id].name, src.mediaId);
  expect(name).toContain('S01E02');
});

test('screenshot', async () => {
  const dir = path.join(root, 'docs/screenshots');
  fs.mkdirSync(dir, { recursive: true });
  // Maximized panel with the info footer open: thumbnails are lazy, give them a moment to land.
  await setMaximized(true);
  await page.locator('[data-row-kind="media"]').first().click();
  await page.getByTestId('info-footer').locator('.pp-info-head').click();
  await page.waitForTimeout(1500);
  await page.getByTestId('project-panel').screenshot({ path: path.join(dir, 'project-panel.png') });
  // Normal layout for the docs shot (footer collapsed so the list gets the room).
  await page.getByTestId('info-footer').locator('.pp-info-head').click();
  await setMaximized(false);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(dir, 'project.png') });
});

test('import: routing by identity, sidecar subtitles, de-dupe, missing files, proxies and relink warnings', async () => {
  const scratch = path.join(tmp, 'imp');
  fs.mkdirSync(scratch, { recursive: true });
  const ep = path.join(scratch, 'Night Shift S02E05.mp4');
  fs.copyFileSync(path.join(mediaDir, 'tv/Season 01', EPISODES[0]), ep);
  fs.copyFileSync(path.join(mediaDir, 'subs/Station Eleven S01E01.srt'), path.join(scratch, 'Night Shift S02E05.srt'));
  fs.copyFileSync(path.join(mediaDir, 'subs/Station Eleven S01E02.srt'), path.join(scratch, 'Night Shift S02E05.fr.srt'));
  const film = path.join(scratch, 'Some Film (1999).mp4');
  fs.copyFileSync(path.join(mediaDir, 'movies/Galaxy Saga 1 - A New Dawn.mp4'), film);
  const score = path.join(scratch, 'score.m4a'); fs.copyFileSync(path.join(mediaDir, 'score.m4a'), score);
  const card = path.join(scratch, 'title-card.png'); fs.copyFileSync(path.join(mediaDir, 'title-card.png'), card);
  const loose = path.join(scratch, 'loose.srt'); fs.copyFileSync(path.join(mediaDir, 'subs/Station Eleven S01E03.srt'), loose);
  const missing = path.join(scratch, 'never-existed.mp4');

  await page.evaluate(() => {
    const w = window as any; w.__toastLog = [];
    w.__recut.store.subscribe((s: any, p: any) => { if (s.ui.toasts !== p.ui.toasts) for (const t of s.ui.toasts) if (!w.__toastLog.some((x: any) => x.id === t.id)) w.__toastLog.push(t); });
  });
  const toasts = () => page.evaluate(() => ((window as any).__toastLog as { text: string }[]).map((t) => t.text));

  const r = await page.evaluate((paths) => (window as any).__recut.actions.importMedia(paths, null), [ep, ep, film, score, card, loose, missing]);
  expect(r.added).toHaveLength(5);                         // ep (once), film, score, card, missing
  expect(r.existing).toEqual([]);
  expect(r.sidecarsUsed.sort()).toEqual([path.join(scratch, 'Night Shift S02E05.fr.srt'), path.join(scratch, 'Night Shift S02E05.srt')]);
  await page.waitForFunction((ids) => ids.every((id: string) => { const m = (window as any).__recut.store.getState().project.media[id]; return m && (m.probe || m.probeError); }), r.added, { timeout: 60_000 });

  const byPath = await page.evaluate(() => {
    const s = (window as any).__recut.store.getState();
    const out: Record<string, any> = {};
    for (const m of Object.values(s.project.media) as any[]) {
      const b = m.binId ? s.project.bins[m.binId] : null;
      const parent = b?.parentId ? s.project.bins[b.parentId] : null;
      out[m.path] = { id: m.id, category: m.category, identity: m.identity, binId: m.binId, bin: b?.name, parent: parent?.name, grand: parent?.parentId ?? null, offline: m.offline, probeError: m.probeError, kind: m.kind,
        subs: m.subtitleTrackIds.map((t: string) => s.project.subtitleTracks[t]?.language).sort() };
    }
    return out;
  });
  expect(byPath[ep]).toMatchObject({ category: 'Episode', identity: { series: 'Night Shift', season: 2, episode: 5 }, bin: 'Season 2', parent: 'Night Shift', grand: 'bin-tv', subs: ['fr', 'und'] });
  expect(byPath[film]).toMatchObject({ category: 'Movie', identity: { title: 'Some Film', year: 1999 }, binId: 'bin-movies' });
  expect(byPath[score]).toMatchObject({ category: 'Music', binId: 'bin-audio', kind: 'audio' });
  expect(byPath[card]).toMatchObject({ category: 'Other', binId: 'bin-graphics', kind: 'image' });
  expect(byPath[loose]).toBeUndefined();
  expect(byPath[missing]).toMatchObject({ offline: true });
  expect(byPath[missing].probeError).toBeTruthy();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  let log = await toasts();
  expect(log.some((t) => /Imported 2 subtitle files found next to the media/.test(t))).toBe(true);
  expect(log.some((t) => /Import subtitles/.test(t))).toBe(true);
  // New items are selected and the panel scrolled to them.
  const sel = await page.evaluate(() => (window as any).__recut.store.getState().ui.selectedMediaIds);
  expect([...sel].sort()).toEqual([...r.added].sort());
  await expect(page.locator(r.added.map((id: string) => `[data-row-kind="media"][data-media-id="${id}"]`).join(', ')).first()).toBeVisible();

  // Same path again → no new item, toast, existing item selected.
  const again = await page.evaluate((p) => (window as any).__recut.actions.importMedia([p], null), ep);
  expect(again.added).toEqual([]);
  expect(again.existing).toEqual([byPath[ep].id]);
  log = await toasts();
  expect(log).toContain('Already imported: 1');
  expect(await page.evaluate(() => (window as any).__recut.store.getState().ui.selectedMediaIds)).toEqual([byPath[ep].id]);
  // …and revealed: the panel scrolls down to TV › Night Shift › Season 2.
  await expect(page.locator(`[data-row-kind="media"][data-media-id="${byPath[ep].id}"]`)).toBeInViewport();

  // QA-13: a ready proxy whose file is gone is reset by "Check files" / project open.
  await page.evaluate((id) => (window as any).__recut.store.getState().setProxy(id, { status: 'ready', path: '/nonexistent/recut-proxy.mp4' }), byPath[film].id);
  await page.evaluate(() => (window as any).__recut.actions.verifyMediaOnline());
  expect(await page.evaluate((id) => (window as any).__recut.store.getState().project.media[id].proxy.status, byPath[film].id)).toBe('none');

  // E-03: with proxies on, undecodable media (AC-3 audio) gets a proxy queued automatically.
  await page.evaluate(() => (window as any).__recut.store.getState().setSettings({ useProxies: true }));
  const ac3 = path.join(scratch, 'Dark Tide (2002).mp4');
  fs.copyFileSync(path.join(mediaDir, 'movies/Galaxy Saga 2 - Dark Tide.mp4'), ac3);
  const [ac3Id] = await page.evaluate((p) => (window as any).__recut.actions.importMediaFiles([p]), ac3);
  await expect.poll(() => page.evaluate((id) => (window as any).__recut.store.getState().project.media[id].proxy.status, ac3Id), { timeout: 60_000 }).not.toBe('none');
  log = await toasts();
  expect(log.some((t) => /Generating proxies for 1 file the preview can't decode/.test(t))).toBe(true);
  await page.evaluate(() => (window as any).__recut.store.getState().setSettings({ useProxies: false }));

  // QA-22: relink to a shorter file → clips past the end are trimmed to the new media (and reported).
  // (Was: only reported, "will freeze on the last frame"; attack-qa media-proxy-export requires the trim.)
  const short = path.join(scratch, 'short.mp4');
  execSync(`ffmpeg -hide_banner -loglevel error -y -i "${ep}" -t 2 -c copy "${short}"`);
  await page.evaluate((id) => { const st = (window as any).__recut.store.getState(); st.insertFromSource(st.project.activeSequenceId, { mediaId: id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' }); }, byPath[ep].id);
  await expect.poll(() => page.evaluate(() => !!(window as any).__recut.projectActions)).toBe(true);
  expect(await page.evaluate((id) => (window as any).__recut.projectActions.clipsPastEnd(id, 2), byPath[ep].id)).toBeGreaterThan(0);
  expect(await page.evaluate(({ id, p }) => (window as any).__recut.projectActions.relinkWithPath(id, p), { id: byPath[ep].id, p: short })).toBe(true);
  const shortDur: number = await page.evaluate((id) => (window as any).__recut.store.getState().project.media[id].probe.duration, byPath[ep].id);
  expect(shortDur).toBeLessThan(5);
  expect(await page.evaluate(({ id, d }) => (window as any).__recut.projectActions.clipsPastEnd(id, d), { id: byPath[ep].id, d: shortDur })).toBe(0);
  await expect(page.locator('.toast-host')).toContainText(/shorter after the relink: trimmed \d+ clips? that ran past the end/);
});
