/**
 * Shared helpers for Playwright + Electron e2e tests.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(__dirname, '..', '..');

export interface LaunchedApp { app: ElectronApplication; page: Page; userData: string; cacheDir: string; tmp: string }

export async function launchApp(opts: { tmp?: string; env?: Record<string, string> } = {}): Promise<LaunchedApp> {
  const tmp = opts.tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'recut-e2e-'));
  const userData = path.join(tmp, 'userData');
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const app = await electron.launch({
    args: [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox'],
    cwd: ROOT,
    // RECUT_UPDATE_CHECK=0: no update opt-in prompt and no update check (tests/e2e/update.spec.ts turns it back on).
    env: { ...process.env, RECUT_USER_DATA: userData, RECUT_CACHE_DIR: cacheDir, RECUT_DISABLE_GPU: '1', RECUT_UPDATE_CHECK: '0', ...(opts.env ?? {}) },
  });
  // Closing a project with unsaved changes now (correctly) asks Save/Don't Save/Cancel, which would hang
  // teardown. Tests that care about the prompt drive it explicitly; plain close() discards changes.
  const rawClose = app.close.bind(app);
  app.close = async () => {
    try {
      await app.windows()[0]?.evaluate(() => {
        const w = window as unknown as { __recut?: { store: { setState(p: object): void } } };
        w.__recut?.store.setState({ dirty: false });
      });
    } catch { /* window already gone */ }
    await rawClose();
  };
  const page = await app.firstWindow();
  await page.waitForSelector('#root .layout', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __recut?: unknown }).__recut));
  return { app, page, userData, cacheDir, tmp };
}

/** Generates the synthetic media set once per tmp dir. Returns the directory. */
export function makeTestMedia(tmp: string, mode: 'short' | 'full' = 'short'): string {
  const dir = path.join(tmp, 'media');
  if (!fs.existsSync(path.join(dir, 'movies'))) {
    execFileSync('bash', [path.join(ROOT, 'scripts/make-test-media.sh'), dir, mode], { stdio: 'ignore' });
  }
  return dir;
}

export const MEDIA = {
  movie1: 'movies/Galaxy Saga 1 - A New Dawn.mp4',
  movie2ac3: 'movies/Galaxy Saga 2 - Dark Tide.mp4',
  movie3surround: 'movies/Galaxy Saga 3 - Surround Finale.mp4',
  movie0hevc: 'movies/Galaxy Saga 0 - HEVC Prequel.mp4',
  ep1: 'tv/Season 01/Station Eleven S01E01.mp4',
  ep2: 'tv/Season 01/Station Eleven S01E02.mp4',
  ep3: 'tv/Season 01/Station Eleven S01E03.mp4',
  srt: (name: string) => `subs/${name}.srt`,
  brokenSrt: 'subs/broken.srt',
  invalid: 'invalid.mp4',
  score: 'score.m4a',
  title: 'title-card.png',
};

/** Import files through the renderer's real import path and wait until every item is probed. */
export async function importMedia(page: Page, paths: string[]): Promise<string[]> {
  const ids: string[] = await page.evaluate(async (p) => {
    const w = window as unknown as { __recut: { actions: { importMediaFiles(paths: string[]): Promise<string[]> } } };
    return w.__recut.actions.importMediaFiles(p);
  }, paths);
  await page.waitForFunction((ids) => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { media: Record<string, { probe?: unknown; probeError?: string }> } } } } };
    const media = w.__recut.store.getState().project.media;
    return ids.every((id) => media[id] && (media[id].probe || media[id].probeError));
  }, ids, { timeout: 60_000 });
  return ids;
}

export async function getState<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate((src) => {
    const w = window as unknown as { __recut: { store: { getState(): unknown } } };
    const state = w.__recut.store.getState();
    // eslint-disable-next-line no-new-func
    return new Function('s', `return (${src})(s)`)(state);
  }, fn) as Promise<T>;
}

export function ffprobeJson(file: string): { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number; channels?: number; r_frame_rate?: string }[] } {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(out.toString());
}

/** Average RGB of a frame at `time` seconds. */
export function frameColor(file: string, time: number): { r: number; g: number; b: number } {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=32:18', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  let r = 0, g = 0, b = 0; const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}
