/**
 * File › Collect Project… end to end: the real File menu item opens the dialog; the destination comes from the
 * (stubbed) native folder picker; the summary shows size, free space and the offline file that will be skipped;
 * the collect runs as a job; the collected project opens with every clip online and its paths inside the new folder,
 * while the original files stay where they were.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { importMedia, launchApp, type LaunchedApp } from './helpers';

/** Optional: where to save screenshots of the dialog (for docs or review). */
const SHOT_DIR = process.env.RECUT_COLLECT_SHOT_DIR;

let launched: LaunchedApp;
let page: Page;

type W = { __recut: { store: { getState(): any; setState(p: object): void }; runCommand(id: string): boolean } };

function makeMedia(file: string, pattern: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `${pattern}=duration=3:size=320x240:rate=24`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { stdio: 'ignore' });
}

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.app.close();
  fs.rmSync(launched.tmp, { recursive: true, force: true });
});

test('File › Collect Project… copies the project and its media into a new folder that opens with every clip online', async () => {
  const src = path.join(launched.tmp, 'rips');
  const disc1 = path.join(src, 'Disc 1', 'title_t00.mp4');
  const disc2 = path.join(src, 'Disc 2', 'title_t00.mp4');
  const lost = path.join(src, 'Disc 3', 'lost.mp4');
  makeMedia(disc1, 'testsrc');
  makeMedia(disc2, 'testsrc2');
  makeMedia(lost, 'smptebars');
  const ids = await importMedia(page, [disc1, disc2, lost]);
  // Both discs on the timeline; the third file goes offline before the collect.
  await page.evaluate((mediaIds) => {
    const st = (window as unknown as W).__recut.store.getState();
    st.insertFromSource(st.project.activeSequenceId, { mediaId: mediaIds[0], in: 0, out: 2, atFrame: 0, mode: 'overwrite' });
    const st2 = (window as unknown as W).__recut.store.getState();
    st2.insertFromSource(st2.project.activeSequenceId, { mediaId: mediaIds[1], in: 0, out: 2, atFrame: 48, mode: 'overwrite' });
  }, ids);
  await page.evaluate(() => (window as unknown as W).__recut.store.getState().renameProject('Saga Fan Cut'));
  fs.rmSync(lost);

  const dest = path.join(launched.tmp, 'Archive Drive');
  fs.mkdirSync(dest);
  await launched.app.evaluate(({ dialog }, folder) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
  }, dest);

  // The real menu item (File › Collect Project…) sends file.collect to the renderer.
  const clicked = await launched.app.evaluate(({ Menu, BrowserWindow }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File');
    const item = file?.submenu?.items.find((i) => i.label === 'Collect Project…');
    if (!item) return false;
    item.click(undefined, BrowserWindow.getAllWindows()[0], BrowserWindow.getAllWindows()[0]?.webContents);
    return true;
  });
  expect(clicked).toBe(true);
  const dlg = page.getByTestId('collect-dialog');
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId('collect-start')).toBeDisabled(); // no destination yet

  await page.getByTestId('collect-choose').click();
  await expect(page.getByTestId('collect-destination')).toHaveValue(dest);
  const folder = path.join(dest, 'Saga Fan Cut');
  await expect(page.getByTestId('collect-folder')).toHaveText(folder);
  const expectedBytes = fs.statSync(disc1).size + fs.statSync(disc2).size;
  await expect(page.getByTestId('collect-total')).not.toHaveText('0 B');
  await expect(page.getByTestId('collect-free')).not.toHaveText('unknown');
  await expect(page.getByTestId('collect-missing')).toContainText('lost.mp4');
  expect(expectedBytes).toBeGreaterThan(0);

  // Only media used in sequences: the same two files here (the offline one is unused too).
  await page.getByTestId('collect-scope-sequences').check();
  await expect(page.getByTestId('collect-summary')).not.toContainText('lost.mp4');
  await expect(page.getByTestId('collect-summary')).toContainText('1 media item not used in any sequence');
  if (SHOT_DIR) await page.locator('.collect-dialog').screenshot({ path: path.join(SHOT_DIR, 'collect-dialog.png') });

  await page.getByTestId('collect-start').click();
  await expect(page.getByTestId('collect-done')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.toast', { hasText: 'Project collected to' })).toBeVisible();
  if (SHOT_DIR) await page.locator('.collect-dialog').screenshot({ path: path.join(SHOT_DIR, 'collect-done.png') });

  // On disk: the two same-named files kept apart by their folder names; no incomplete marker.
  expect(fs.existsSync(path.join(folder, 'Saga Fan Cut.recut'))).toBe(true);
  expect(fs.readFileSync(path.join(folder, 'Media', 'Disc 1', 'title_t00.mp4')).equals(fs.readFileSync(disc1))).toBe(true);
  expect(fs.readFileSync(path.join(folder, 'Media', 'Disc 2', 'title_t00.mp4')).equals(fs.readFileSync(disc2))).toBe(true);
  expect(fs.existsSync(path.join(folder, 'COLLECT-INCOMPLETE.txt'))).toBe(false);
  // The open project still points at the originals.
  const openPaths: string[] = await page.evaluate((mediaIds) => mediaIds.map((id) => (window as unknown as W).__recut.store.getState().project.media[id].path), ids);
  expect(openPaths.slice(0, 2)).toEqual([disc1, disc2]);

  // Open the collected project from the dialog: every clip is online, its media inside the collected folder.
  await page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false }));
  await page.getByTestId('collect-open').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath), { timeout: 20_000 })
    .toBe(path.join(folder, 'Saga Fan Cut.recut'));
  await expect.poll(async () => page.evaluate(() => {
    const p = (window as unknown as W).__recut.store.getState().project;
    const seq = p.sequences[p.activeSequenceId];
    const clips = [...seq.videoTracks, ...seq.audioTracks].flatMap((t: { clips: { mediaId: string }[] }) => t.clips);
    return clips.length > 0 && clips.every((c: { mediaId: string }) => p.media[c.mediaId] && !p.media[c.mediaId].offline);
  }), { timeout: 20_000 }).toBe(true);
  const collectedPaths: string[] = await page.evaluate((mediaIds) => mediaIds.map((id) => (window as unknown as W).__recut.store.getState().project.media[id].path), ids);
  expect(collectedPaths[0]).toBe(path.join(folder, 'Media', 'Disc 1', 'title_t00.mp4'));
  expect(collectedPaths[1]).toBe(path.join(folder, 'Media', 'Disc 2', 'title_t00.mp4'));
  expect(collectedPaths[2]).toBe(lost); // not copied: unchanged (and offline)

  // A second collect into the same destination is refused: the folder is no longer empty.
  await page.evaluate(() => (window as unknown as W).__recut.runCommand('file.collect'));
  await expect(page.getByTestId('collect-problem')).toContainText('not empty');
  await expect(page.getByTestId('collect-start')).toBeDisabled();
});
