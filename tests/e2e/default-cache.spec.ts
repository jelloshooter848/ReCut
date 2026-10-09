/**
 * The default cache folder `<userData>/cache` survives app starts
 * (bugs/closed/2026-10-09-default-cache-dir-is-chromium-http-cache.md).
 *
 * On Windows and macOS (case-insensitive file systems) `<userData>/cache` is the same folder as Chromium's HTTP cache
 * folder `<userData>/Cache`. With the HTTP cache on, Chromium deletes every entry of that folder except `Cache_Data` at
 * every start (content/browser/network_service_instance_impl.cc MaybeDeleteOldCache), taking proxies, thumbnails,
 * waveforms, scene, OCR and Whisper results with it. On Linux the two are different folders, so these tests pass there
 * even without the fix; the Windows and macOS e2e jobs are the real check.
 *
 * Unlike the other specs, these launch WITHOUT RECUT_CACHE_DIR, so the app uses its default cache folder.
 *
 * RECUT_E2E_TMP: put the test profiles in this folder instead of the system temp folder. Pointing it at a
 * case-insensitive mount on Linux (e.g. `ciopfs back mnt`) reproduces the Windows and macOS behaviour locally.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers';

test.describe.configure({ mode: 'serial' });

/** One file in each cache subfolder (electron/media/cache.ts CACHE_SUBDIRS), shaped like what the app writes. */
const KEY = '0123456789abcdef0123456789abcdef01234567';
const SEED: Record<string, string> = {
  'proxies': `${KEY}_540p_all.mp4`,
  'thumbs': `${KEY}_f000120_w160.jpg`,
  'waves': `${KEY}.json`,
  'scenes': `${KEY}.json`,
  'ocr': `${KEY}_s3.json`,
  'whisper': `${KEY}_a1.json`,
  'ids': KEY,
};

const tmps: string[] = [];
function newTmp(): string {
  const t = fs.mkdtempSync(path.join(process.env.RECUT_E2E_TMP || os.tmpdir(), 'recut-e2e-defcache-'));
  tmps.push(t);
  return t;
}

test.afterAll(() => {
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
});

function seedCache(cache: string): void {
  for (const [sub, file] of Object.entries(SEED)) {
    fs.mkdirSync(path.join(cache, sub), { recursive: true });
    fs.writeFileSync(path.join(cache, sub, file), `recut ${sub} cache entry`);
  }
}

/** `cache: [a, b]; proxies: [x]; …` — what CI logs show when an assertion fails. */
function listing(cache: string): string {
  const ls = (d: string) => { try { return `[${fs.readdirSync(d).sort().join(', ')}]`; } catch (e) { return `[(${(e as NodeJS.ErrnoException).code})]`; } };
  const parts = [`${cache}: ${ls(cache)}`, `userData: ${ls(path.dirname(cache))}`];
  for (const sub of Object.keys(SEED)) parts.push(`${sub}: ${ls(path.join(cache, sub))}`);
  return parts.join('; ');
}

function expectCacheIntact(cache: string, when: string): void {
  const missing = Object.entries(SEED).filter(([sub, file]) => !fs.existsSync(path.join(cache, sub, file))).map(([sub, file]) => `${sub}/${file}`);
  expect(missing, `${when}: cache entries missing; ${listing(cache)}`).toEqual([]);
  const names = fs.readdirSync(cache);
  expect(names.filter((n) => n === 'Cache_Data' || /^old_Cache_Data_\d{3}$/.test(n)), `${when}: Chromium's HTTP cache in the app's cache folder; ${listing(cache)}`).toEqual([]);
}

/**
 * Start the app on `<tmp>/userData` with its default cache folder, let Chromium set up the default session's network
 * context (which is where it cleans `<sessionData>/Cache`), then quit.
 */
async function startAndQuit(tmp: string): Promise<void> {
  const app = await launchApp({ tmp, env: { RECUT_CACHE_DIR: '' } });
  try {
    const info = await app.page.evaluate(() => (window as unknown as { recut: { appInfo(): Promise<{ cacheDir: string; userDataDir: string }> } }).recut.appInfo());
    expect(path.resolve(info.cacheDir)).toBe(path.resolve(app.userData, 'cache'));
    // Make sure the network context exists (the cache-size query goes through it), then give Chromium's
    // best-effort cleanup task time to run.
    await app.app.evaluate(async ({ session }) => { try { await session.defaultSession.getCacheSize(); } catch { /* no HTTP cache */ } });
    await app.page.waitForTimeout(3000);
  } finally {
    await app.app.close();
  }
}

test('the default cache survives a start on a profile whose cache folder has no Cache_Data', async () => {
  const tmp = newTmp();
  const cache = path.join(tmp, 'userData', 'cache');
  seedCache(cache);
  await startAndQuit(tmp);
  expectCacheIntact(cache, 'after the first start');
});

test('the default cache survives restarts and a move of the profile to a new path', async () => {
  const tmp = newTmp();
  const userData = path.join(tmp, 'userData');
  const cache = path.join(userData, 'cache');
  // A profile the app made (on Windows and macOS without the fix, Chromium makes `Cache/Cache_Data` in it), then
  // cache entries written by the app, then a second start.
  await startAndQuit(tmp);
  seedCache(cache);
  await startAndQuit(tmp);
  expectCacheIntact(cache, 'after a restart');

  // The same profile at another path (a copied or migrated profile).
  const moved = newTmp();
  fs.cpSync(userData, path.join(moved, 'userData'), { recursive: true });
  await startAndQuit(moved);
  expectCacheIntact(path.join(moved, 'userData', 'cache'), 'after a start on the moved profile');
});

test("a profile from an older version: Chromium's stale Cache_Data is removed, the app's cache entries are kept", async () => {
  const tmp = newTmp();
  const cache = path.join(tmp, 'userData', 'cache');
  seedCache(cache);
  // What Chromium left in the shared folder on Windows and macOS: its cache backend folder (blockfile and simple-cache
  // file names) and a backend folder it renamed for deletion (net/disk_cache/cache_util.cc, old_<name>_NNN).
  for (const [dir, files] of [['Cache_Data', ['index', 'data_0', 'data_1', 'f_000001']], ['Cache_Data/index-dir', ['the-real-index']], ['old_Cache_Data_000', ['index']]] as const) {
    fs.mkdirSync(path.join(cache, dir), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(cache, dir, f), 'chromium');
  }
  await startAndQuit(tmp);
  expectCacheIntact(cache, 'after the first start');
});
