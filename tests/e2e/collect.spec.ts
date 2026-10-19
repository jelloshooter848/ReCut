/**
 * File › Collect Project… end to end: the real File menu item opens the dialog; the destination comes from the
 * (stubbed) native folder picker; the summary shows size, free space and the offline file that will be skipped;
 * the collect runs as a job; the collected project opens with every clip online and its paths inside the new folder,
 * while the original files stay where they were. A second test collects what 0.8.0 added (compound clips nested two
 * levels deep and in two places, keyframes, an extracted centre channel with its channel proxy, a Whisper track, a
 * still) with "Include proxies" and reopens it: nothing repaired, nothing rebuilt, nothing outside the folder.
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
  await expect(page.getByTestId('collect-summary')).toContainText('1 media item not used in any timeline');
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

function makeSurround(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tones = [400, 600, 1000, 60, 1400, 1800].flatMap((f) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=48000:duration=4`]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24:d=4', ...tones,
    '-filter_complex', '[1:a][2:a][3:a][4:a][5:a][6:a]join=inputs=6:channel_layout=5.1:map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-BL|5.0-BR[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '448k', file], { stdio: 'ignore' });
}

/** Sequences and subtitle tracks with every file path masked: what a collect must not change. */
function maskedEdit(p: any): string {
  const seqs = JSON.parse(JSON.stringify(p.sequences));
  for (const s of Object.values<any>(seqs)) {
    for (const t of s.subtitleTracks) if (t.sourcePaths) t.sourcePaths = t.sourcePaths.map(() => '<path>');
    for (const snap of s.snapshots) for (const t of snap.data.subtitleTracks) if (t.sourcePaths) t.sourcePaths = t.sourcePaths.map(() => '<path>');
  }
  const subs = JSON.parse(JSON.stringify(p.subtitleTracks));
  for (const t of Object.values<any>(subs)) if (t.path) t.path = '<path>';
  return JSON.stringify({ seqs, subs, order: p.sequenceOrder });
}

test('Collect round trip of 0.8.0 content: nested compound clips, keyframes, centre channel proxy, Whisper track, still', async () => {
  const src = path.join(launched.tmp, 'rips 080');
  const surround = path.join(src, 'Disc 4', 'surround51.mkv');
  const innerA = path.join(src, 'Disc A', 'title_t00.mp4');
  const innerB = path.join(src, 'Disc B', 'title_t00.mp4');
  const still = path.join(src, 'Graphics', 'title card.png');
  makeSurround(surround);
  makeMedia(innerA, 'testsrc');
  makeMedia(innerB, 'testsrc2');
  fs.mkdirSync(path.dirname(still), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'smptebars=s=320x240', '-frames:v', '1', still], { stdio: 'ignore' });

  await page.evaluate(() => (window as unknown as W).__recut.store.getState().newProject('Compound Fan Cut'));
  const [surroundId, aId, bId, stillId] = await importMedia(page, [surround, innerA, innerB, still]);
  const built = await page.evaluate(({ surroundId, aId, bId, stillId }) => {
    const S = () => (window as unknown as W).__recut.store.getState();
    const main: string = S().project.activeSequenceId;
    const seq = () => S().project.sequences[main];
    const [sv] = S().insertFromSource(main, { mediaId: surroundId, in: 0, out: 2, atFrame: 0, mode: 'overwrite' });
    const [stillClip] = S().insertFromSource(main, { mediaId: stillId, in: 0, out: 2, atFrame: 0, mode: 'overwrite', includeAudio: false, videoTrackId: seq().videoTracks[1].id });
    const a = S().insertFromSource(main, { mediaId: aId, in: 0, out: 1, atFrame: 48, mode: 'overwrite' });
    const b = S().insertFromSource(main, { mediaId: bId, in: 1, out: 2, atFrame: 72, mode: 'overwrite' });
    // Compound clip of A and B (media used only inside nested sequences from now on), then a compound of that.
    const inner: string = S().makeCompoundClip(main, [...a, ...b], 'Inner');
    const innerClips = [...seq().videoTracks, ...seq().audioTracks].flatMap((t: any) => t.clips).filter((c: any) => c.sequenceId === inner).map((c: any) => c.id);
    const middle: string = S().makeCompoundClip(main, innerClips, 'Middle');
    // The inner sequence nested a second time, directly in the main sequence.
    const again = S().nestSequence(main, inner, 120);
    const centre = S().extractCentreChannel(main, sv);
    S().addClipKeyframe(main, [stillClip], 'opacity', 0);
    S().addClipKeyframe(main, [stillClip], 'opacity', 24);
    S().putWhisperSubtitleTrack({ id: 'sub-whisper-e2e', name: 'English (Whisper)', language: 'eng', mediaId: surroundId, origin: 'whisper', streamIndex: 1,
      cues: [{ id: 'w1', start: 0.5, end: 1.5, text: 'Hello there.' }] });
    S().takeSnapshot(main, 'Before collect');
    return { main, inner, middle, again: again.length, centre: centre.ok };
  }, { surroundId, aId, bId, stillId });
  expect(built.inner && built.middle && built.again && built.centre).toBeTruthy();
  // The centre channel's preview audio (a channel proxy) is built by the app.
  await expect.poll(() => page.evaluate((id) => (window as unknown as W).__recut.store.getState().project.media[id].channelProxies?.['1.ch-FC']?.status, surroundId),
    { timeout: 60_000 }).toBe('ready');
  // The AC-3 file may also get a media proxy (proxies on): let it settle, so the collect sees a stable project.
  await expect.poll(() => page.evaluate(() => Object.values<any>((window as unknown as W).__recut.store.getState().project.media)
    .some((m) => m.proxy.status === 'queued' || m.proxy.status === 'running')), { timeout: 120_000 }).toBe(false);
  const before = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as W).__recut.store.getState().project)));
  const cacheProxy: string = before.media[surroundId].channelProxies['1.ch-FC'].path;

  const dest = path.join(launched.tmp, 'Archive 080');
  fs.mkdirSync(dest);
  await launched.app.evaluate(({ dialog }, folder) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] });
  }, dest);
  await page.evaluate(() => (window as unknown as W).__recut.runCommand('file.collect'));
  await expect(page.getByTestId('collect-dialog')).toBeVisible();
  await page.getByTestId('collect-choose').click();
  await page.getByTestId('collect-scope-sequences').check();
  const proxies = page.getByRole('switch', { name: /Include proxies/ });
  if ((await proxies.getAttribute('aria-checked')) !== 'true') await proxies.click();
  await expect(proxies).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('collect-summary')).toBeVisible();
  await page.getByTestId('collect-start').click();
  await expect(page.getByTestId('collect-done')).toBeVisible({ timeout: 60_000 });

  const folder = path.join(dest, 'Compound Fan Cut');
  const files = fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(folder, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
  expect(files).toEqual([
    'Compound Fan Cut.recut',
    'Media/Disc A/title_t00.mp4',
    'Media/Disc B/title_t00.mp4',
    'Media/surround51.mkv',
    'Media/title card.png',
    'Proxies/surround51.mkv_ch1.ch-FC_v2.m4a',
    ...Object.values<any>(before.media).filter((m) => m.proxy.status === 'ready')
      .map((m) => `Proxies/${path.basename(m.path)}_${/_(\d+p[^/\\]*\.mp4|still\.png)$/.exec(m.proxy.path)![1]}`),
  ].sort());
  expect(fs.readFileSync(path.join(folder, 'Proxies', 'surround51.mkv_ch1.ch-FC_v2.m4a')).equals(fs.readFileSync(cacheProxy))).toBe(true);

  await page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false }));
  await page.getByTestId('collect-open').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath), { timeout: 20_000 })
    .toBe(path.join(folder, 'Compound Fan Cut.recut'));
  // Give the channel-proxy sync (400 ms after a change) time to check the collected file; it must keep it.
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as W).__recut.store.getState().project)));
  await expect(page.locator('.toast', { hasText: 'repaired' })).toHaveCount(0);

  // Every file reference points into the collected folder, and nothing else changed.
  const inFolder = (p: string) => !path.relative(folder, p).startsWith('..') && path.isAbsolute(p);
  for (const m of Object.values<any>(after.media)) {
    expect(inFolder(m.path), m.path).toBe(true);
    expect(m.offline).toBe(false);
    if (m.proxy.status === 'ready') expect(inFolder(m.proxy.path), m.proxy.path).toBe(true);
    for (const cp of Object.values<any>(m.channelProxies ?? {})) if (cp.path) expect(inFolder(cp.path), cp.path).toBe(true);
  }
  expect(after.media[surroundId].channelProxies['1.ch-FC']).toMatchObject({ status: 'ready', path: path.join(folder, 'Proxies', 'surround51.mkv_ch1.ch-FC_v2.m4a') });
  expect(maskedEdit(after)).toBe(maskedEdit(before));
  const nestedIn = (id: string) => Object.values<any>(after.sequences)
    .filter((s) => [...s.videoTracks, ...s.audioTracks].some((t: any) => t.clips.some((c: any) => c.sequenceId === id))).map((s) => s.name).sort();
  expect(nestedIn(built.inner)).toEqual(['Middle', after.sequences[built.main].name].sort());
  expect(nestedIn(built.middle)).toEqual([after.sequences[built.main].name]);
  expect(after.subtitleTracks['sub-whisper-e2e']).toEqual(before.subtitleTracks['sub-whisper-e2e']);
  // The originals were not touched.
  const openPaths = [surround, innerA, innerB, still];
  for (const f of openPaths) expect(fs.existsSync(f)).toBe(true);
});
