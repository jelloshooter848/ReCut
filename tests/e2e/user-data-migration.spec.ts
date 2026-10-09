/**
 * User-data folder migration through the real app (electron/userDataStartup.ts, electron/userDataMigration.ts).
 *
 * The shipped folder names are equal, so these runs give the app a different name and a fake legacy folder through
 * the test-only switches (honoured only by an unpackaged app): RECUT_TEST_APP_DATA (the folder holding the user-data
 * folders), RECUT_TEST_APP_NAME, RECUT_TEST_LEGACY_USER_DATA, RECUT_TEST_MIGRATION_FORCE_COPY and
 * RECUT_TEST_MIGRATION_DIALOG. RECUT_USER_DATA is not set here: it would skip the migration.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, discardChangesOnQuit } from './helpers';
import { createMediaItem, createProject, serializeProject } from '../../shared/project';
import { USER_DATA_DIR_NAME } from '../../shared/productIdentity';

const NEW_NAME = 'MigrationTestApp';
const MARKER = 'user-data-migration.json';

interface Run { app: ElectronApplication; page: Page; out: () => string }

function baseEnv(appData: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('RECUT_')) env[k] = v;
  return { ...env, RECUT_DISABLE_GPU: '1', RECUT_UPDATE_CHECK: '0', RECUT_TEST_APP_DATA: appData, RECUT_TEST_MIGRATION_DIALOG: 'ok', ...extra };
}

async function launch(appData: string, extra: Record<string, string>): Promise<Run> {
  const app = await electron.launch({ args: [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox'], cwd: ROOT, env: baseEnv(appData, extra) });
  let out = '';
  app.process().stdout?.on('data', (d) => { out += String(d); });
  const page = await app.firstWindow();
  await page.waitForSelector('#root .layout', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __recut?: unknown }).__recut));
  return { app, page, out: () => out };
}

async function close(r: Run): Promise<void> {
  await discardChangesOnQuit(r.app);
  await r.app.close();
}

const userDataOf = (r: Run) => r.app.evaluate(({ app }) => app.getPath('userData'));
const marker = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as { result: string; from: string | null };

/** A legacy profile: prefs (recent project, skipped version), a "model", layout storage, an untitled autosave, a proxy. */
function seedLegacy(dir: string, recentProject: string): void {
  fs.mkdirSync(path.join(dir, 'whisper', 'models'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'autosave'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cache', 'proxies'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ recentProjects: [recentProject], shortcuts: {}, skippedVersion: '9.9.9' }));
  fs.writeFileSync(path.join(dir, 'whisper', 'models', 'ggml-fake.bin'), Buffer.alloc(8192, 3));
  fs.writeFileSync(path.join(dir, 'cache', 'proxies', 'k_540p_all.mp4'), Buffer.alloc(1024, 1));
}

let tmp: string;
test.beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-e2e-udm-')); });
test.afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('the shipped names are equal: nothing is moved or written', async () => {
  const appData = path.join(tmp, 'appdata');
  // No RECUT_TEST_APP_NAME: the real folder name, whose legacy names include itself.
  const current = path.join(appData, USER_DATA_DIR_NAME);
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, 'prefs.json'), JSON.stringify({ recentProjects: [], shortcuts: {} }));
  const r = await launch(appData, {});
  try {
    expect(await userDataOf(r)).toBe(current);
    expect(fs.existsSync(path.join(current, MARKER))).toBe(false);
    expect(fs.readdirSync(appData)).toEqual([path.basename(current)]);
  } finally { await close(r); }
});

test('legacy folder only: moved on first start, settings kept, a saved proxy path remapped', async () => {
  const appData = path.join(tmp, 'appdata');
  const legacy = path.join(appData, 'OldAppName');
  const current = path.join(appData, NEW_NAME);
  // A saved project whose media proxy points into the legacy folder's cache.
  const media = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(media, Buffer.alloc(16));
  const project = createProject('Moved');
  const item = { ...createMediaItem(media, 'clip.mp4'), id: 'm1', proxy: { status: 'ready' as const, path: path.join(legacy, 'cache', 'proxies', 'k_540p_all.mp4'), progress: 1 } };
  project.media[item.id] = item;
  const projectFile = path.join(tmp, 'moved.recut');
  fs.writeFileSync(projectFile, serializeProject(project));
  seedLegacy(legacy, projectFile);

  const r = await launch(appData, { RECUT_TEST_APP_NAME: NEW_NAME, RECUT_TEST_LEGACY_USER_DATA: legacy });
  try {
    expect(await userDataOf(r)).toBe(current);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(current, 'whisper', 'models', 'ggml-fake.bin')).length).toBe(8192);
    expect(marker(current)).toMatchObject({ result: 'moved', from: legacy });
    // Settings came along: the recent list.
    const recent = await r.page.evaluate(() => (window as unknown as { recut: { recentProjects(): Promise<string[]> } }).recut.recentProjects());
    expect(recent).toEqual([projectFile]);
    // The project's proxy path into the old folder resolves to the moved file, without a "missing" reset.
    const info = await r.page.evaluate(() => (window as unknown as { recut: { appInfo(): Promise<{ legacyPathRoots?: unknown[] }> } }).recut.appInfo());
    expect(info.legacyPathRoots?.length).toBeGreaterThan(0);
    type W = { __recut: { actions: { openProject(p: string): Promise<{ ok: boolean }>; verifyProxies(): Promise<string[]> }; store: { getState(): { project: { media: Record<string, { proxy: { status: string; path?: string } }> } } } } };
    expect((await r.page.evaluate((p) => (window as unknown as W).__recut.actions.openProject(p), projectFile)).ok).toBe(true);
    expect(await r.page.evaluate(() => (window as unknown as W).__recut.actions.verifyProxies())).toEqual([]);
    const proxy = await r.page.evaluate(() => (window as unknown as W).__recut.store.getState().project.media.m1.proxy);
    expect(proxy).toEqual(expect.objectContaining({ status: 'ready', path: path.join(current, 'cache', 'proxies', 'k_540p_all.mp4') }));
  } finally { await close(r); }

  // Second start: the marker ends the check.
  const again = await launch(appData, { RECUT_TEST_APP_NAME: NEW_NAME, RECUT_TEST_LEGACY_USER_DATA: legacy });
  try {
    expect(await userDataOf(again)).toBe(current);
    expect(fs.existsSync(legacy)).toBe(false);
  } finally { await close(again); }
});

test('both folders hold data: neither is touched, the new one is used, a one-time notice', async () => {
  const appData = path.join(tmp, 'appdata');
  const legacy = path.join(appData, 'OldAppName');
  const current = path.join(appData, NEW_NAME);
  seedLegacy(legacy, path.join(tmp, 'x.recut'));
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, 'prefs.json'), JSON.stringify({ recentProjects: [], shortcuts: {}, skippedVersion: '1.1.1' }));
  const legacyPrefs = fs.readFileSync(path.join(legacy, 'prefs.json'), 'utf8');

  const r = await launch(appData, { RECUT_TEST_APP_NAME: NEW_NAME, RECUT_TEST_LEGACY_USER_DATA: legacy });
  try {
    expect(await userDataOf(r)).toBe(current);
    await expect.poll(() => r.out()).toContain('user-data notice: Your earlier settings were left where they are');
    expect(fs.readFileSync(path.join(legacy, 'prefs.json'), 'utf8')).toBe(legacyPrefs);
    expect(fs.existsSync(path.join(legacy, 'whisper', 'models', 'ggml-fake.bin'))).toBe(true);
    expect(fs.existsSync(path.join(current, 'whisper'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(current, 'prefs.json'), 'utf8')).skippedVersion).toBe('1.1.1');
    expect(marker(current)).toMatchObject({ result: 'both-existed', from: legacy });
  } finally { await close(r); }
});

test('rename fails (another volume): copied and verified, the legacy folder kept', async () => {
  const appData = path.join(tmp, 'appdata');
  fs.mkdirSync(appData, { recursive: true });
  // A real cross-device move where /dev/shm is another file system; otherwise the forced EXDEV switch.
  let legacyRoot = tmp;
  const extra: Record<string, string> = {};
  try {
    if (fs.statSync('/dev/shm').dev !== fs.statSync(tmp).dev) legacyRoot = fs.mkdtempSync('/dev/shm/recut-e2e-udm-');
  } catch { /* no /dev/shm */ }
  if (legacyRoot === tmp) extra.RECUT_TEST_MIGRATION_FORCE_COPY = '1';
  const legacy = path.join(legacyRoot, 'OldAppName');
  const current = path.join(appData, NEW_NAME);
  try {
    seedLegacy(legacy, path.join(tmp, 'x.recut'));
    fs.mkdirSync(path.join(legacy, 'GPUCache'));
    fs.writeFileSync(path.join(legacy, 'GPUCache', 'from-legacy'), 'cache');
    const r = await launch(appData, { RECUT_TEST_APP_NAME: NEW_NAME, RECUT_TEST_LEGACY_USER_DATA: legacy, ...extra });
    try {
      expect(await userDataOf(r)).toBe(current);
      expect(marker(current)).toMatchObject({ result: 'copied', from: legacy });
      expect(fs.readFileSync(path.join(current, 'whisper', 'models', 'ggml-fake.bin')).length).toBe(8192);
      // Disposable caches are not copied (Chromium makes its own GPUCache in the new folder).
      expect(fs.existsSync(path.join(current, 'GPUCache', 'from-legacy'))).toBe(false);
      expect(fs.readFileSync(path.join(legacy, 'whisper', 'models', 'ggml-fake.bin')).length).toBe(8192); // kept
      expect(fs.existsSync(`${current}.migrating`)).toBe(false);
    } finally { await close(r); }
  } finally {
    if (legacyRoot !== tmp) fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
});

test.describe('the legacy app is running', () => {
  // The lock check reads Chromium's SingletonLock (<host>-<pid>), faked here with a live process that is not the app.
  test.skip(process.platform !== 'linux', 'the faked single-instance lock is the Linux / macOS one; unit tests cover Windows');

  let holder: ChildProcess;
  test.beforeEach(() => { holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }); });
  test.afterEach(() => { holder.kill(); });

  function seedLocked(appData: string): string {
    const legacy = path.join(appData, 'OldAppName');
    seedLegacy(legacy, path.join(tmp, 'x.recut'));
    fs.symlinkSync(`${os.hostname()}-${holder.pid}`, path.join(legacy, 'SingletonLock'));
    return legacy;
  }

  test('Quit: nothing is moved', async () => {
    const appData = path.join(tmp, 'appdata');
    const legacy = seedLocked(appData);
    const current = path.join(appData, NEW_NAME);
    const env = baseEnv(appData, { RECUT_TEST_APP_NAME: NEW_NAME, RECUT_TEST_LEGACY_USER_DATA: legacy, RECUT_TEST_MIGRATION_DIALOG: 'quit' });
    const electronBin = require('electron') as unknown as string;
    const child = spawn(electronBin, [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code).toBe(0);
    expect(out).toContain(`user-data notice: Quit ${path.basename(legacy)}, then click Restart`);
    expect(fs.existsSync(path.join(legacy, 'whisper', 'models', 'ggml-fake.bin'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'prefs.json'))).toBe(true);
    expect(fs.existsSync(path.join(current, 'prefs.json'))).toBe(false);
    expect(fs.existsSync(path.join(current, MARKER))).toBe(false);
  });

  test('Continue without moving: this session uses the legacy folder, nothing is moved', async () => {
    const appData = path.join(tmp, 'appdata');
    const legacy = seedLocked(appData);
    const current = path.join(appData, NEW_NAME);
    const r = await launch(appData, { RECUT_TEST_APP_NAME: NEW_NAME, RECUT_TEST_LEGACY_USER_DATA: legacy, RECUT_TEST_MIGRATION_DIALOG: 'continue' });
    try {
      expect(await userDataOf(r)).toBe(legacy);
      expect(fs.existsSync(path.join(legacy, 'whisper', 'models', 'ggml-fake.bin'))).toBe(true);
      expect(fs.existsSync(path.join(current, 'prefs.json'))).toBe(false);
      expect(fs.existsSync(path.join(current, MARKER))).toBe(false);
    } finally { await close(r); }
  });
});
