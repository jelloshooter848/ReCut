/**
 * File › Export Timeline… end to end (Roadmap §10): the real File menu item opens the dialog on the active sequence;
 * every format of INTERCHANGE_FORMATS is listed with its description (EDL with its one-file-per-video-track note);
 * the report shows the summary and the issues before saving; Export… opens the (stubbed) native save dialog with the
 * sequence name and the format's extension, and the files land in the chosen folder with the right header.
 *
 * The export assertions need the real writers (shared/interchange, written on the core branch). Until they are
 * merged `exportTimeline` throws, which the dialog must show as an error without crashing; `realWriters` guards
 * the rest.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { exportTimeline, INTERCHANGE_FORMATS, type InterchangeFormat } from '../../shared/interchange';
import { createProject } from '../../shared/project';
import { importMedia, launchApp, type LaunchedApp } from './helpers';

/** Optional: where to save screenshots of the dialog (for docs or review). */
const SHOT_DIR = process.env.RECUT_INTERCHANGE_SHOT_DIR;

/** The format writers are present: exportTimeline does not throw for an empty sequence. */
const realWriters = (() => {
  try { const p = createProject(); exportTimeline(p, p.sequenceOrder[0], 'fcpxml'); return true; } catch { return false; }
})();

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;
let outDir: string;

type W = { __recut: { store: { getState(): any } } };

function makeMedia(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { stdio: 'ignore' });
}

async function openFromMenu(): Promise<void> {
  const clicked = await launched.app.evaluate(({ Menu, BrowserWindow }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File');
    const item = file?.submenu?.items.find((i) => i.label === 'Export Timeline…');
    if (!item) return false;
    item.click(undefined, BrowserWindow.getAllWindows()[0], BrowserWindow.getAllWindows()[0]?.webContents);
    return true;
  });
  expect(clicked).toBe(true);
  await expect(page.getByTestId('interchange-dialog')).toBeVisible();
}

/** The next native save dialog returns `file`; its options are kept in globalThis.__saveOpts. */
async function stubSave(file: string): Promise<void> {
  await launched.app.evaluate(({ dialog }, p) => {
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = (...args: unknown[]) => {
      (globalThis as unknown as { __saveOpts: unknown }).__saveOpts = args[args.length - 1];
      return Promise.resolve({ canceled: false, filePath: p });
    };
  }, file);
}
const saveOpts = () => launched.app.evaluate(() => (globalThis as unknown as { __saveOpts: { defaultPath?: string; filters?: { extensions: string[] }[] } }).__saveOpts);

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
  outDir = path.join(launched.tmp, 'Resolve hand-off');
  fs.mkdirSync(outDir);
  const movie = path.join(launched.tmp, 'rips', 'Galaxy Saga.mp4');
  makeMedia(movie);
  const [id] = await importMedia(page, [movie]);
  await page.evaluate((mediaId) => {
    const s = (window as unknown as W).__recut.store.getState();
    const seqId = s.project.activeSequenceId;
    s.renameSequence(seqId, 'Saga Fan Cut');
    s.insertFromSource(seqId, { mediaId, in: 0, out: 1, atFrame: 0, mode: 'overwrite' });
    (window as unknown as W).__recut.store.getState().insertFromSource(seqId, { mediaId, in: 2, out: 3, atFrame: 24, mode: 'overwrite' });
  }, id);
});

test.afterAll(async () => {
  await launched?.app.close();
  fs.rmSync(launched.tmp, { recursive: true, force: true });
});

test('File › Export Timeline… lists the formats, shows the report (or the error) and closes with Escape', async () => {
  await openFromMenu();
  await expect(page.getByTestId('interchange-sequence')).toHaveValue(await page.evaluate(() => (window as unknown as W).__recut.store.getState().project.activeSequenceId));
  for (const f of Object.keys(INTERCHANGE_FORMATS) as InterchangeFormat[]) {
    const radio = page.getByTestId(`interchange-format-${f}`);
    await radio.check();
    await expect(page.getByRole('radio', { name: INTERCHANGE_FORMATS[f].label })).toBeChecked();
    await expect(page.getByTestId('interchange-dialog')).toContainText(INTERCHANGE_FORMATS[f].description);
    await expect(page.getByTestId('interchange-edl-note')).toHaveCount(f === 'edl' ? 1 : 0);
    if (realWriters) {
      await expect(page.getByTestId('interchange-summary')).toContainText(/[1-9]\d* clips?/);
      await expect(page.getByTestId('interchange-summary')).toContainText('1 media file');
      await expect(page.getByTestId('interchange-export')).toBeEnabled();
    } else {
      // The stub throws: the dialog shows the error and does not offer Export…; the app keeps running.
      await expect(page.getByTestId('interchange-error')).toContainText('not implemented');
      await expect(page.getByTestId('interchange-export')).toBeDisabled();
    }
  }
  if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'export-timeline-dialog.png') }); }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('interchange-dialog')).toHaveCount(0);
  await expect(page.locator('#root .layout')).toBeVisible();
});

test('Export… writes each format into the chosen folder', async () => {
  test.skip(!realWriters, 'needs the interchange writers (shared/interchange from the core branch)');
  const headers: Record<InterchangeFormat, (text: string) => void> = {
    fcpxml: (t) => { expect(t.startsWith('<?xml')).toBe(true); expect(t).toContain('<fcpxml'); },
    otio: (t) => { expect(t.trimStart().startsWith('{')).toBe(true); expect(t).toMatch(/"OTIO_SCHEMA":\s*"Timeline\.1"/); },
    edl: (t) => { expect(t.startsWith('TITLE:')).toBe(true); },
  };
  for (const f of Object.keys(INTERCHANGE_FORMATS) as InterchangeFormat[]) {
    await openFromMenu();
    await page.getByTestId(`interchange-format-${f}`).check();
    await expect(page.getByTestId('interchange-summary')).toBeVisible();
    await expect(page.getByTestId('interchange-export')).toBeEnabled();
    const ext = INTERCHANGE_FORMATS[f].extension;
    await stubSave(path.join(outDir, `Final.${ext}`));
    // Enter is Export… (the focus is on the format radio, not a button).
    await page.getByTestId(`interchange-format-${f}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('interchange-done')).toBeVisible();
    if (SHOT_DIR && f === 'edl') await page.screenshot({ path: path.join(SHOT_DIR, 'export-timeline-done.png') });
    const opts = await saveOpts();
    expect(opts.defaultPath).toBe(`Saga Fan Cut.${ext}`);
    expect(opts.filters?.[0]?.extensions).toEqual([ext]);
    const written = fs.readdirSync(outDir).filter((n) => n.startsWith('Final') && n.endsWith(`.${ext}`));
    expect(written.length).toBeGreaterThan(0);
    if (f !== 'edl') expect(written).toEqual([`Final.${ext}`]);
    else for (const n of written) expect(n).toMatch(/^Final.*\.edl$/);
    for (const n of written) {
      const text = fs.readFileSync(path.join(outDir, n), 'utf8');
      expect(text.length).toBeGreaterThan(0);
      headers[f](text);
    }
    await expect(page.locator('.toast').filter({ hasText: `Exported ${written.length} file` }).last()).toBeVisible();
    await page.getByTestId('interchange-cancel').click();
    await expect(page.getByTestId('interchange-dialog')).toHaveCount(0);
  }
});
