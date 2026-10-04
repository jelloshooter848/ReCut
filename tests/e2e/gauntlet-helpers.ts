/**
 * Helpers for the acceptance gauntlet (tests/e2e/gauntlet.spec.ts).
 *
 * Everything here is test plumbing: launching Electron with/without a `--project` CLI argument, generating the
 * synthetic media set once and copying it per test, reading the store through `window.__recut`, a soft-step
 * recorder (so a failing step is logged as a bug and later steps still run), and small UI utilities (drag,
 * zone maximize, panel tabs, pixel sampling).
 */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, ffprobeJson, frameColor } from './helpers';

export { ROOT, ffprobeJson, frameColor };
export { MEDIA } from './helpers';

// ---------------------------------------------------------------------------------------------- types

export interface ClipLite { id: string; kind: 'video' | 'audio'; name: string; mediaId: string; start: number; duration: number; sourceIn: number; linkId: string | null; characters: string[]; tags: string[]; enabled: boolean }
export interface TransitionLite { id: string; type: string; duration: number; inClipId?: string; outClipId?: string }
export interface TrackLite { id: string; kind: 'video' | 'audio'; name: string; clips: ClipLite[]; transitions: TransitionLite[] }
export interface SeqLite {
  id: string; name: string; fps: { num: number; den: number };
  videoTracks: TrackLite[]; audioTracks: TrackLite[];
  subtitleTracks: { id: string; cues: { id: string; clipId?: string; text: string; offset: number }[] }[];
  view: { playhead: number; zoom: number; scroll: number; inPoint: number | null; outPoint: number | null };
}
export interface MediaLite { id: string; name: string; path: string; kind: string; offline: boolean; probeError?: string; probe?: { duration: number; browserPlayable: boolean; audio: { channels: number; codec: string }[]; video?: { codec: string } } | null; proxy: { status: string; path?: string; error?: string }; identity: Record<string, unknown>; subtitleTracks?: unknown[] }
export interface JobLite { id: string; kind: string; status: string; progress: number; error?: string; mediaId?: string; result?: unknown }

// ---------------------------------------------------------------------------------------------- media

const MEDIA_CACHE = path.join(process.env.RECUT_GAUNTLET_CACHE ?? path.join(os.tmpdir(), 'recut-gauntlet-media-cache'));

/** Generate the short synthetic media set once (cached across tests) and copy it into `tmp/media`. */
export function prepareMedia(tmp: string): string {
  if (!fs.existsSync(path.join(MEDIA_CACHE, 'movies', 'Galaxy Saga 1 - A New Dawn.mp4'))) {
    fs.rmSync(MEDIA_CACHE, { recursive: true, force: true });
    execFileSync('bash', [path.join(ROOT, 'scripts/make-test-media.sh'), MEDIA_CACHE, 'short'], { stdio: 'ignore' });
  }
  const dir = path.join(tmp, 'media');
  fs.cpSync(MEDIA_CACHE, dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------------------------- launch

export interface Launched { app: ElectronApplication; page: Page; tmp: string; userData: string; cacheDir: string; errors: string[] }

/**
 * Launch the built app. `projectArg` adds `--project <path>` to argv (TEST 1/2/3 relaunch). Retries while
 * `dist/renderer/index.html` is missing (another agent may be rebuilding) and while the window fails to appear.
 */
export async function launchGauntlet(tmp: string, opts: { projectArg?: string; width?: number; height?: number } = {}): Promise<Launched> {
  const userData = path.join(tmp, 'userData');
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const args = [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox'];
  if (opts.projectArg) args.push('--project', opts.projectArg);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!fs.existsSync(path.join(ROOT, 'dist/renderer/index.html')) || !fs.existsSync(path.join(ROOT, 'dist/electron/main.js'))) {
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    let app: ElectronApplication | null = null;
    try {
      app = await electron.launch({
        args, cwd: ROOT, timeout: 90_000,
        env: { ...process.env, RECUT_USER_DATA: userData, RECUT_CACHE_DIR: cacheDir, RECUT_DISABLE_GPU: '1' },
      });
      const page = await app.firstWindow({ timeout: 60_000 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.waitForSelector('#root .layout', { timeout: 60_000 });
      await page.waitForFunction(() => Boolean((window as unknown as { __recut?: unknown }).__recut), undefined, { timeout: 30_000 });
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(size.w, size.h); w.center(); }, { w: opts.width ?? 1500, h: opts.height ?? 950 });
      await page.waitForTimeout(300);
      return { app, page, tmp, userData, cacheDir, errors };
    } catch (e) {
      lastErr = e;
      await app?.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  throw new Error(`Could not launch ReCut: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** Close without a quit prompt (clears dirty first). */
export async function closeApp(l: Launched | null | undefined): Promise<void> {
  if (!l) return;
  try { await l.page.evaluate(() => (window as unknown as W).__recut.store.setState({ dirty: false })); } catch { /* window may be gone */ }
  await l.app.close().catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------- store access

export type W = Window & {
  __recut: {
    store: { getState(): any; setState(p: any): void };
    actions: Record<string, (...a: any[]) => Promise<any>>;
    selectors: Record<string, unknown>;
    runCommand(id: string): boolean;
    jobsStore: { getState(): { jobs: JobLite[] } };
    subtitles: { exportSequenceSubtitles(o: { path: string; format?: string }): Promise<{ ok: boolean; count?: number; error?: string }> };
  };
  recut: Record<string, (...a: any[]) => Promise<any>>;
};

/** Run `fn(state, arg)` against the live store state inside the renderer. */
export function evalStore<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  return page.evaluate(({ src, arg }) => {
    const w = window as unknown as W;
    // eslint-disable-next-line no-new-func
    return new Function('st', 'arg', `return (${src})(st, arg)`)(w.__recut.store.getState(), arg);
  }, { src: fn, arg }) as Promise<T>;
}

export const seqState = (page: Page) => evalStore<SeqLite>(page, `(s) => {
  const q = s.project.sequences[s.project.activeSequenceId];
  if (!q) return null;
  const clip = (c) => ({ id: c.id, kind: c.kind, name: c.name, mediaId: c.mediaId, start: c.start, duration: c.duration, sourceIn: c.sourceIn, linkId: c.linkId, characters: c.characters, tags: c.tags, enabled: c.enabled });
  const track = (t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.map(clip), transitions: t.transitions.map((x) => ({ id: x.id, type: x.type, duration: x.duration, inClipId: x.inClipId, outClipId: x.outClipId })) });
  return JSON.parse(JSON.stringify({ id: q.id, name: q.name, fps: q.fps, videoTracks: q.videoTracks.map(track), audioTracks: q.audioTracks.map(track),
    subtitleTracks: (q.subtitleTracks || []).map((t) => ({ id: t.id, cues: t.cues.map((c) => ({ id: c.id, clipId: c.clipId, text: c.text, offset: c.offset })) })), view: q.view }));
}`);

export const mediaState = (page: Page) => evalStore<Record<string, MediaLite>>(page, `(s) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(s.project.media).map(([id, m]) => [id, { id: m.id, name: m.name, path: m.path, kind: m.kind, offline: m.offline, probeError: m.probeError, probe: m.probe ? { duration: m.probe.duration, browserPlayable: m.probe.browserPlayable, audio: m.probe.audio, video: m.probe.video ? { codec: m.probe.video.codec } : undefined } : null, proxy: m.proxy, identity: m.identity, subtitleTracks: m.subtitleTracks }]))))`);

export const jobs = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as W).__recut.jobsStore.getState().jobs)) as JobLite[]);

export const sequenceDurationFrames = (seq: SeqLite) => Math.max(0, ...[...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.clips.map((c) => c.start + c.duration)));
export const framesToSec = (frames: number, fps: { num: number; den: number }) => (frames * fps.den) / fps.num;
export const vclips = (seq: SeqLite) => seq.videoTracks.flatMap((t) => t.clips).sort((a, b) => a.start - b.start);
export const aclips = (seq: SeqLite) => seq.audioTracks.flatMap((t) => t.clips).sort((a, b) => a.start - b.start);

/** Import through the renderer's real import action (the file picker is a native dialog) and wait for probes. */
export async function importMedia(page: Page, paths: string[]): Promise<string[]> {
  const ids: string[] = await page.evaluate((p) => (window as unknown as W).__recut.actions.importMediaFiles(p), paths);
  await page.waitForFunction((ids) => {
    const media = (window as unknown as W).__recut.store.getState().project.media;
    return ids.every((id: string) => media[id] && (media[id].probe || media[id].probeError));
  }, ids, { timeout: 90_000 });
  return ids;
}

/**
 * Wait until a job of `kind` (not in `exclude`) reaches a terminal status and return it. The predicate is plain
 * data because the renderer's CSP (`script-src 'self'`) forbids eval in the page's main world.
 */
export async function waitForJob(page: Page, q: { kind: string; exclude?: string[]; mediaId?: string }, timeout = 180_000): Promise<JobLite | undefined> {
  const match = (j: JobLite, q: { kind: string; exclude?: string[]; mediaId?: string }) =>
    j.kind === q.kind && !(q.exclude ?? []).includes(j.id) && (!q.mediaId || j.mediaId === q.mediaId) && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled');
  await page.waitForFunction((q) => {
    const js = (window as unknown as W).__recut.jobsStore.getState().jobs;
    return js.some((j) => j.kind === q.kind && !(q.exclude ?? []).includes(j.id) && (!q.mediaId || j.mediaId === q.mediaId) && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled'));
  }, q, { timeout });
  return (await jobs(page)).find((j) => match(j, q));
}

// ---------------------------------------------------------------------------------------------- UI utilities

export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + Math.sign(to.x - from.x || 1) * 4, from.y, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** Bring a panel's tab to the front (adds it to its default zone if it is not laid out). */
export async function showPanel(page: Page, id: string): Promise<void> {
  await page.evaluate((panelId) => (window as unknown as W).__recut.store.getState().setActivePanel(panelId), id);
  const tab = page.locator(`.zone-tab[data-panel="${id}"]`).first();
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
}

/** Toggle the "maximize zone" state of the zone holding `panel` by double-clicking its tab. */
export async function setMaximized(page: Page, panel: string, on: boolean): Promise<void> {
  const isMax = async () => page.evaluate(() => !!document.querySelector('.layout-maximized'));
  if ((await isMax()) === on) { if (on) return; else return; }
  const tab = page.locator(`.zone-tab[data-panel="${panel}"]`).first();
  await tab.click();
  await tab.dblclick();
  await expect.poll(isMax, { timeout: 10_000 }).toBe(on);
  await page.waitForTimeout(250);
}

export async function clipBox(page: Page, id: string) {
  const loc = page.locator(`[data-clip-id="${id}"]`);
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = await loc.boundingBox();
  if (!b) throw new Error(`clip ${id} is not visible in the timeline`);
  return b;
}

/** Average brightness (0..255) of the Program canvas, or -1 when there is no canvas. */
export async function programBrightness(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 28) { sum += (data[i] + data[i + 1] + data[i + 2]) / 3; n++; }
    return n ? sum / n : -1;
  });
}

export async function sourceVideoTime(page: Page): Promise<number> {
  return page.evaluate(() => (document.querySelector('.source-panel video') as HTMLVideoElement | null)?.currentTime ?? -1);
}

export async function waitSourceReady(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(() => { const v = document.querySelector('.source-panel video') as HTMLVideoElement | null; return !!v && v.readyState >= 2; }, undefined, { timeout });
}

/** Seek the Source monitor through the store (what the Transcript panel does) and wait for the frame to land. */
export async function seekSource(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => (window as unknown as W).__recut.store.getState().setSourceTime(t), seconds);
  await page.waitForFunction((t) => { const v = document.querySelector('.source-panel video') as HTMLVideoElement | null; return !!v && !v.seeking && Math.abs(v.currentTime - t) < 0.1; }, seconds, { timeout: 10_000 });
}

export function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p)); else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- soft steps

export type Mode = 'UI' | 'API' | 'UI+API';
export interface StepResult { name: string; mode: Mode; ok: boolean; note?: string; error?: string }

/**
 * Records every step so docs/acceptance.md can list UI-vs-API usage and the outcome. A failing step is logged
 * (and the test fails at the end through `finish()`), but execution continues; `fallback` lets a blocked flow be
 * continued through the store API, marked clearly as a workaround.
 */
export class Gauntlet {
  readonly steps: StepResult[] = [];
  constructor(readonly label: string) {}

  async step<T>(name: string, mode: Mode, fn: () => Promise<T>, opts: { note?: string; fallback?: () => Promise<T | void> } = {}): Promise<T | undefined> {
    try {
      const r = await fn();
      this.steps.push({ name, mode, ok: true, note: opts.note });
      console.log(`[${this.label}] PASS (${mode}) ${name}${opts.note ? ` — ${opts.note}` : ''}`);
      return r;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 6).join(' | ');
      this.steps.push({ name, mode, ok: false, note: opts.note, error: msg });
      console.log(`[${this.label}] FAIL (${mode}) ${name}: ${msg}`);
      if (opts.fallback) {
        try {
          const r = await opts.fallback();
          this.steps.push({ name: `${name} [WORKAROUND via store API]`, mode: 'API', ok: true });
          console.log(`[${this.label}] WORKAROUND ${name}`);
          return (r ?? undefined) as T | undefined;
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          this.steps.push({ name: `${name} [WORKAROUND]`, mode: 'API', ok: false, error: m2 });
          console.log(`[${this.label}] WORKAROUND FAILED ${name}: ${m2}`);
        }
      }
      return undefined;
    }
  }

  /** Record an observation that is not a pass/fail step (shows up in the report). */
  note(text: string, mode: Mode = 'UI'): void { this.steps.push({ name: `  ↳ ${text}`, mode, ok: true }); }

  /** Write the step log (for the acceptance report). Idempotent; called from afterAll too so partial runs leave a log. */
  write(outDir: string, pageErrors: string[] = []): void {
    fs.mkdirSync(outDir, { recursive: true });
    const failed = this.steps.filter((s) => !s.ok);
    const summary = { label: this.label, verdict: failed.length ? 'FAIL' : 'PASS', passed: this.steps.length - failed.length, total: this.steps.length, steps: this.steps, pageErrors };
    fs.writeFileSync(path.join(outDir, `${this.label.replace(/[^A-Za-z0-9]+/g, '-')}.json`), JSON.stringify(summary, null, 2));
  }

  /** Write the step log and fail the test when any step failed. */
  finish(outDir: string, pageErrors: string[] = []): void {
    this.write(outDir, pageErrors);
    const failed = this.steps.filter((s) => !s.ok);
    console.log(`[${this.label}] VERDICT ${failed.length ? 'FAIL' : 'PASS'} (${this.steps.length - failed.length}/${this.steps.length} steps passed)`);
    expect(failed.map((s) => `${s.name}: ${s.error}`), `${this.label} failed steps`).toEqual([]);
  }
}
