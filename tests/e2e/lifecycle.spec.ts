/**
 * Project lifecycle + editing-command e2e: save / new / open, autosave, recovery, keyboard shortcuts.
 * Runs the real Electron app (see helpers.ts). Tests share one tmp dir and run serially.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, makeTestMedia, importMedia, MEDIA, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

type W = Window & {
  __recut: {
    store: { getState(): any; setState(p: any): void };
    actions: { saveProject(p: string): Promise<any>; openProject(p: string): Promise<any> };
    runCommand(id: string): boolean;
  };
};

let app: LaunchedApp;
let tmp: string;
let mediaDir: string;
let projectPath: string;
let mediaId: string;

const clipCount = () => app.page.evaluate(() => {
  const s = (window as unknown as W).__recut.store.getState();
  const seq = s.project.sequences[s.project.activeSequenceId];
  return [...seq.videoTracks, ...seq.audioTracks].reduce((n: number, t: any) => n + t.clips.length, 0);
});

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-lifecycle-'));
  mediaDir = makeTestMedia(tmp, 'short');
  projectPath = path.join(tmp, 'test.recut');
  app = await launchApp({ tmp });
});

test.afterAll(async () => {
  try { await app.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false })); } catch { /* window may be gone */ }
  await app.app.close().catch(() => undefined);
});

test('import a movie, insert a range and save the project via actions.saveProject', async () => {
  const [id] = await importMedia(app.page, [path.join(mediaDir, MEDIA.movie1)]);
  mediaId = id;
  await app.page.evaluate((mid) => {
    const st = (window as unknown as W).__recut.store.getState();
    st.insertFromSource(st.project.activeSequenceId, { mediaId: mid, in: 0, out: 4, atFrame: 0, mode: 'insert' });
  }, mediaId);
  expect(await clipCount()).toBe(2);

  const res = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.saveProject(p), projectPath);
  expect(res.ok).toBe(true);
  expect(fs.existsSync(projectPath)).toBe(true);
  const json = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(json.formatVersion).toBe(1);
  const seq = json.sequences[json.activeSequenceId];
  const clips = [...seq.videoTracks, ...seq.audioTracks].flatMap((t: any) => t.clips);
  expect(clips.length).toBe(2);
  expect(clips[0].mediaId).toBe(mediaId);
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty)).toBe(false);
  await expect.poll(() => app.page.title()).toContain('ReCut');
});

test('file.new resets the project, actions.openProject restores it and syncs the title', async () => {
  // Not dirty after the save, so no native confirmation is shown.
  const ran = await app.page.evaluate(() => (window as unknown as W).__recut.runCommand('file.new'));
  expect(ran).toBe(true);
  await expect.poll(() => app.page.evaluate(() => Object.keys((window as unknown as W).__recut.store.getState().project.media).length)).toBe(0);
  expect(await clipCount()).toBe(0);

  const res = await app.page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectPath);
  expect(res.ok).toBe(true);
  expect(await clipCount()).toBe(2);
  const name: string = await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().project.name);
  await expect.poll(() => app.page.evaluate(() => document.title)).toContain(name);
  await expect.poll(() => app.page.evaluate(() => document.title)).toContain('ReCut');
  await expect(app.page.locator('.topbar .project-name')).toHaveText(name);
});

test('a change triggers the debounced autosave next to the project file', async () => {
  const autosave = `${projectPath}.autosave`;
  fs.rmSync(autosave, { force: true });
  await app.page.evaluate(() => {
    const st = (window as unknown as W).__recut.store.getState();
    st.addMarker(st.project.activeSequenceId, { time: 12, name: 'autosave me' });
  });
  await expect.poll(() => fs.existsSync(autosave), { timeout: 7000, intervals: [250] }).toBe(true);
  const json = JSON.parse(fs.readFileSync(autosave, 'utf8'));
  expect(json.formatVersion).toBe(1);
  const seq = json.sequences[json.activeSequenceId];
  expect(seq.markers.some((m: any) => m.name === 'autosave me')).toBe(true);
  await expect(app.page.locator('.topbar .project-dirty')).toBeVisible();
});

test('keyboard: Space toggles playback, Ctrl+K adds an edit, Ctrl+Z undoes it', async () => {
  const page = app.page;
  // Make the program side the keyboard target: focus the Program panel (falls back to the store transport when none is registered).
  await page.evaluate(() => (window as unknown as W).__recut.runCommand('view.focusPanel3'));
  const program = page.locator('[data-panel-id="program"], [data-testid="program-panel"]').first();
  if (await program.count()) await program.click({ position: { x: 20, y: 40 }, force: true }).catch(() => undefined);
  else await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });

  const playing = () => page.evaluate(() => (window as unknown as W).__recut.store.getState().playback.playing);
  expect(await playing()).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(true);
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(false);

  const before = await clipCount();
  await page.evaluate(() => {
    const st = (window as unknown as W).__recut.store.getState();
    st.setView(st.project.activeSequenceId, { playhead: 40 });
  });
  await page.keyboard.press('Control+K');
  await expect.poll(clipCount).toBe(before + 2);
  await page.keyboard.press('Control+Z');
  await expect.poll(clipCount).toBe(before);
});

test('recovery: a newer autosave is offered on relaunch and can be recovered', async () => {
  // Leave the app without a quit prompt, then plant a newer autosave with a recognisable change.
  await app.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false }));
  await app.app.close();

  const autosave = `${projectPath}.autosave`;
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  project.name = 'Recovered Cut';
  fs.writeFileSync(autosave, JSON.stringify(project));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(autosave, future, future);

  app = await launchApp({ tmp });
  const dialog = app.page.getByTestId('recovery-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('Recover unsaved changes');
  await app.page.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => app.page.evaluate(() => (window as unknown as W).__recut.store.getState().project.name)).toBe('Recovered Cut');
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath)).toBe(projectPath);
  expect(await clipCount()).toBe(2);
  // Recovered content is not yet on disk → dirty, title shows it.
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty)).toBe(true);
  await expect.poll(() => app.page.evaluate(() => document.title)).toContain('Recovered Cut *');
});

test('opening a damaged project falls back to the backup, says so, and names an untitled project after its file', async () => {
  const damaged = path.join(tmp, 'My Damaged Cut.recut');
  const good = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  good.name = 'Untitled Project';
  fs.writeFileSync(`${damaged}.bak`, JSON.stringify(good));
  fs.writeFileSync(damaged, '{ "formatVersion": 1, truncated');
  await app.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false }));
  // Same path as an OS "open with" / second instance: main -> ev:openProjectPath -> requestOpenProject.
  await app.app.evaluate(({ BrowserWindow }, p) => { BrowserWindow.getAllWindows()[0].webContents.send('ev:openProjectPath', p); }, damaged);
  await expect.poll(() => app.page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath), { timeout: 10_000 }).toBe(damaged);
  await expect(app.page.getByText(/Opened the backup from .*; the project file was damaged/)).toBeVisible();
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().project.name)).toBe('My Damaged Cut');
  expect(fs.readdirSync(tmp).some((f) => f.startsWith('My Damaged Cut.recut.corrupt-'))).toBe(true);
});

test('Save As of an untitled project names it after the file', async () => {
  await app.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false }));
  await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().newProject());
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().project.name)).toBe('Untitled Project');
  const target = path.join(tmp, 'Trailer Recut.recut');
  await app.app.evaluate(({ dialog }, p) => {
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = () => Promise.resolve({ canceled: false, filePath: p });
  }, target);
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.runCommand('file.saveAs'))).toBe(true);
  await expect.poll(() => app.page.evaluate(() => (window as unknown as W).__recut.store.getState().projectPath)).toBe(target);
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().project.name)).toBe('Trailer Recut');
  expect(JSON.parse(fs.readFileSync(target, 'utf8')).name).toBe('Trailer Recut');
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty)).toBe(false);
});

test('quit prompt: Cancel keeps the app open past the 3 s fallback; the next quit prompts again', async () => {
  const alive = () => app.app.process().exitCode === null && !app.page.isClosed();
  await app.page.evaluate(() => {
    const st = (window as unknown as W).__recut.store.getState();
    st.addMarker(st.project.activeSequenceId, { time: 1, name: 'unsaved' });
  });
  expect(await app.page.evaluate(() => (window as unknown as W).__recut.store.getState().dirty)).toBe(true);
  await app.app.evaluate(({ dialog }) => {
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = () => Promise.resolve({ response: 2, checkboxChecked: false });
  });
  await app.page.evaluate(() => { void (window as unknown as { recut: { quit(f: boolean): Promise<void> } }).recut.quit(false); });
  await app.page.waitForTimeout(4000);
  expect(alive()).toBe(true);
  // The pending-quit state was cleared: a new quit request prompts again; Don't Save quits.
  await app.app.evaluate(({ dialog }) => {
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
  });
  const exited = new Promise<void>((r) => app.app.process().once('exit', () => r()));
  await app.page.evaluate(() => { void (window as unknown as { recut: { quit(f: boolean): Promise<void> } }).recut.quit(false); }).catch(() => undefined);
  await Promise.race([exited, new Promise((_r, rej) => setTimeout(() => rej(new Error('app did not quit after Don\'t Save')), 2500))]);
});
