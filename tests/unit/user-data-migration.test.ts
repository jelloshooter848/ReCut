/**
 * User-data folder migration (electron/userDataMigration.ts): the pure decision, and the move / copy / fallback on a
 * real temporary app-data folder with injected failures. The end-to-end run through Electron is
 * tests/e2e/user-data-migration.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIGRATION_MARKER, compareTrees, folderHasData, listFiles, isFolderInUse, isSameFolder, migrateUserData, planUserDataMigration,
  readMigrationMarker, type MigrationFacts, type MigrationOptions,
} from '../../electron/userDataMigration';
import { LEGACY_USER_DATA_DIR_NAMES, USER_DATA_DIR_NAME } from '../../shared/productIdentity';

// ------------------------------------------------------------------
// planUserDataMigration (pure)
// ------------------------------------------------------------------

function facts(over: {
  overridden?: boolean;
  current?: Partial<MigrationFacts['current']>;
  legacy?: Partial<MigrationFacts['legacy'][number]>[];
} = {}): MigrationFacts {
  return {
    overridden: over.overridden ?? false,
    current: { path: '/appdata/New', exists: false, hasData: false, markerPresent: false, ...over.current },
    legacy: (over.legacy ?? [{}]).map((l) => ({ path: '/appdata/Old', exists: true, hasData: true, sameAsCurrent: false, inUse: false, ...l })),
  };
}

describe('planUserDataMigration', () => {
  it('legacy only: move', () => {
    expect(planUserDataMigration(facts())).toEqual({ kind: 'move', legacy: '/appdata/Old' });
  });
  it('an empty or disposable-only current folder counts as empty: move', () => {
    expect(planUserDataMigration(facts({ current: { exists: true, hasData: false } }))).toEqual({ kind: 'move', legacy: '/appdata/Old' });
  });
  it('both hold data: never merged, current kept', () => {
    expect(planUserDataMigration(facts({ current: { exists: true, hasData: true } }))).toEqual({ kind: 'both-existed', legacy: '/appdata/Old' });
  });
  it('both hold data and the legacy app runs: still both-existed (the legacy folder is not touched)', () => {
    expect(planUserDataMigration(facts({ current: { exists: true, hasData: true }, legacy: [{ inUse: true }] })).kind).toBe('both-existed');
  });
  it('legacy app running: nothing moves', () => {
    expect(planUserDataMigration(facts({ legacy: [{ inUse: true }] }))).toEqual({ kind: 'legacy-in-use', legacy: '/appdata/Old' });
  });
  it('no legacy folder, or one without data: nothing to migrate', () => {
    expect(planUserDataMigration(facts({ legacy: [{ exists: false, hasData: false }] }))).toEqual({ kind: 'nothing-to-migrate' });
    expect(planUserDataMigration(facts({ legacy: [{ exists: true, hasData: false }] }))).toEqual({ kind: 'nothing-to-migrate' });
  });
  it('the first legacy folder with data is the source', () => {
    const plan = planUserDataMigration(facts({ legacy: [{ path: '/appdata/A', exists: false, hasData: false }, { path: '/appdata/B' }, { path: '/appdata/C' }] }));
    expect(plan).toEqual({ kind: 'move', legacy: '/appdata/B' });
  });
  it('skipped: override, same folder (equal names, case-only rename), marker present', () => {
    expect(planUserDataMigration(facts({ overridden: true }))).toEqual({ kind: 'skip', reason: 'override' });
    expect(planUserDataMigration(facts({ legacy: [{ sameAsCurrent: true }] }))).toEqual({ kind: 'skip', reason: 'same-folder' });
    expect(planUserDataMigration(facts({ legacy: [] }))).toEqual({ kind: 'skip', reason: 'same-folder' });
    expect(planUserDataMigration(facts({ current: { exists: true, markerPresent: true } }))).toEqual({ kind: 'skip', reason: 'done' });
  });
});

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

describe('isSameFolder', () => {
  it('folds case on Windows and macOS only', () => {
    expect(isSameFolder('/a/ReCut', '/a/recut', 'win32')).toBe(true);
    expect(isSameFolder('/a/ReCut', '/a/recut', 'darwin')).toBe(true);
    expect(isSameFolder('/nonexistent-a/ReCut', '/nonexistent-a/recut', 'linux')).toBe(false);
    expect(isSameFolder('/a/x/../ReCut', '/a/ReCut', 'linux')).toBe(true);
  });
});

/** fs whose readlinkSync of `<dir>/SingletonLock` returns `target` (or fails as missing when null). */
function fakeSingletonLock(dir: string, target: string | null): typeof fs {
  return {
    ...fs,
    readlinkSync: ((p: fs.PathLike) => {
      if (path.resolve(String(p)) === path.resolve(dir, 'SingletonLock')) {
        if (target === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return target;
      }
      return fs.readlinkSync(p);
    }) as typeof fs.readlinkSync,
  };
}

describe('isFolderInUse', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-udm-lock-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('POSIX: a SingletonLock naming a live process on this host is held; a dead one or another format is not', () => {
    const lockFs = (target: string | null) => fakeSingletonLock(dir, target);
    expect(isFolderInUse(dir, { platform: 'linux', hostname: 'myhost', fs: lockFs(`myhost-${process.pid}`) })).toBe(true);
    expect(isFolderInUse(dir, { platform: 'linux', hostname: 'myhost', isPidAlive: () => false, fs: lockFs(`myhost-${process.pid}`) })).toBe(false);
    // Another machine may be using a shared home folder: held.
    expect(isFolderInUse(dir, { platform: 'linux', hostname: 'otherhost', isPidAlive: () => false, fs: lockFs(`myhost-${process.pid}`) })).toBe(true);
    expect(isFolderInUse(dir, { platform: 'darwin', hostname: 'myhost', fs: lockFs('garbage') })).toBe(false);
    expect(isFolderInUse(dir, { platform: 'darwin', hostname: 'myhost', fs: lockFs(null) })).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('POSIX: reads a real SingletonLock symlink', () => {
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
    expect(isFolderInUse(dir, { platform: process.platform })).toBe(true);
  });

  it('Windows: a lockfile that cannot be opened for writing is held', () => {
    const fakeFs = (code: string | null) => ({
      ...fs,
      openSync: ((p: string) => { if (code) throw Object.assign(new Error(code), { code }); return fs.openSync(p, 'w'); }) as typeof fs.openSync,
    });
    expect(isFolderInUse(dir, { platform: 'win32', fs: fakeFs('EBUSY') })).toBe(true);
    expect(isFolderInUse(dir, { platform: 'win32', fs: fakeFs('ENOENT') })).toBe(false);
    expect(isFolderInUse(dir, { platform: 'win32', fs: fakeFs(null) })).toBe(false);
  });
});

describe('folderHasData', () => {
  it('ignores Chromium caches, locks and the marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-udm-data-'));
    try {
      expect(folderHasData(dir)).toBe(false);
      for (const n of ['Cache', 'GPUCache', 'Crashpad']) fs.mkdirSync(path.join(dir, n));
      fs.writeFileSync(path.join(dir, MIGRATION_MARKER), '{}');
      expect(folderHasData(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, 'prefs.json'), '{}');
      expect(folderHasData(dir)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ------------------------------------------------------------------
// migrateUserData on disk
// ------------------------------------------------------------------

describe('migrateUserData', () => {
  let appData: string;
  let legacy: string;
  let current: string;
  const logs: string[] = [];

  beforeEach(() => {
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-udm-'));
    legacy = path.join(appData, 'OldName');
    current = path.join(appData, 'NewName');
    logs.length = 0;
  });
  afterEach(() => { fs.rmSync(appData, { recursive: true, force: true }); });

  const opts = (o: Partial<MigrationOptions> = {}): MigrationOptions => ({
    current, legacy: [legacy], overridden: false, appVersion: '9.9.9', now: () => 1234, log: (m) => logs.push(m),
    isPidAlive: () => false, sleep: () => undefined, ...o,
  });

  /** A legacy profile: prefs naming a cache folder inside it, a model, Local Storage, an autosave, and Chromium caches. */
  function seedLegacy(dir = legacy): void {
    fs.mkdirSync(path.join(dir, 'whisper', 'models'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'autosave'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'GPUCache'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mycache', 'proxies'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ recentProjects: ['/p/a.recut'], cacheDir: path.join(dir, 'mycache') }));
    fs.writeFileSync(path.join(dir, 'whisper', 'models', 'ggml-tiny.bin'), Buffer.alloc(4096, 7));
    fs.writeFileSync(path.join(dir, 'Local Storage', 'leveldb', '000003.log'), 'layout');
    fs.writeFileSync(path.join(dir, 'autosave', 'untitled.recut.autosave'), '{"formatVersion":1}');
    fs.writeFileSync(path.join(dir, 'GPUCache', 'data_0'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'mycache', 'proxies', 'k_540p_all.mp4'), Buffer.alloc(2048, 1));
  }

  it('the shipped names are equal today: a no-op that writes nothing', () => {
    const ad = path.join(appData, 'ad');
    fs.mkdirSync(path.join(ad, USER_DATA_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(ad, USER_DATA_DIR_NAME, 'prefs.json'), '{}');
    const before = fs.readdirSync(ad).join(',');
    const out = migrateUserData(opts({ current: path.join(ad, USER_DATA_DIR_NAME), legacy: LEGACY_USER_DATA_DIR_NAMES.map((n) => path.join(ad, n)) }));
    expect(out).toMatchObject({ result: 'none', reason: 'same-folder', userData: path.join(ad, USER_DATA_DIR_NAME) });
    expect(fs.readdirSync(ad).join(',')).toBe(before);
    expect(fs.existsSync(path.join(ad, USER_DATA_DIR_NAME, MIGRATION_MARKER))).toBe(false);
  });

  it('legacy only: renamed into place, cacheDir rewritten, marker written; a second run is a no-op', () => {
    seedLegacy();
    const out = migrateUserData(opts());
    expect(out).toMatchObject({ result: 'moved', userData: current, legacy });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(current, 'whisper', 'models', 'ggml-tiny.bin')).length).toBe(4096);
    expect(fs.existsSync(path.join(current, 'autosave', 'untitled.recut.autosave'))).toBe(true);
    const prefs = JSON.parse(fs.readFileSync(path.join(current, 'prefs.json'), 'utf8'));
    expect(prefs.cacheDir).toBe(path.join(current, 'mycache'));
    expect(prefs.recentProjects).toEqual(['/p/a.recut']);
    expect(readMigrationMarker(current)).toEqual({ from: legacy, at: 1234, result: 'moved', appVersion: '9.9.9' });
    expect(fs.existsSync(`${current}.migration-lock`)).toBe(false);

    const again = migrateUserData(opts());
    expect(again).toMatchObject({ result: 'none', reason: 'done', userData: current });
  });

  it('a current folder holding only Chromium caches is replaced by the move', () => {
    seedLegacy();
    fs.mkdirSync(path.join(current, 'Crashpad'), { recursive: true });
    expect(migrateUserData(opts()).result).toBe('moved');
    expect(fs.existsSync(path.join(current, 'prefs.json'))).toBe(true);
  });

  it('only the current folder: nothing to migrate (marker), nothing else touched', () => {
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, 'prefs.json'), '{"x":1}');
    expect(migrateUserData(opts())).toMatchObject({ result: 'nothing-to-migrate', userData: current });
    expect(readMigrationMarker(current)?.result).toBe('nothing-to-migrate');
    expect(fs.readFileSync(path.join(current, 'prefs.json'), 'utf8')).toBe('{"x":1}');
  });

  it('neither folder: nothing to migrate', () => {
    expect(migrateUserData(opts())).toMatchObject({ result: 'nothing-to-migrate', userData: current });
    expect(readMigrationMarker(current)).toMatchObject({ from: null, result: 'nothing-to-migrate' });
  });

  it('both hold data: neither is touched, current used, marker both-existed', () => {
    seedLegacy();
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, 'prefs.json'), '{"fresh":true}');
    const out = migrateUserData(opts());
    expect(out).toMatchObject({ result: 'both-existed', userData: current, legacy });
    expect(fs.existsSync(path.join(legacy, 'whisper', 'models', 'ggml-tiny.bin'))).toBe(true);
    expect(fs.readFileSync(path.join(current, 'prefs.json'), 'utf8')).toBe('{"fresh":true}');
    expect(fs.existsSync(path.join(current, 'whisper'))).toBe(false);
    expect(readMigrationMarker(current)?.result).toBe('both-existed');
    // One-time: the next launch skips.
    expect(migrateUserData(opts()).result).toBe('none');
  });

  it('legacy app running: nothing moves, this session uses the legacy folder, no marker', () => {
    seedLegacy();
    const out = migrateUserData(opts({ platform: 'linux', hostname: 'h', isPidAlive: () => true, fs: fakeSingletonLock(legacy, 'h-4242') }));
    expect(out).toMatchObject({ result: 'legacy-in-use', userData: legacy, legacy });
    expect(fs.existsSync(path.join(legacy, 'prefs.json'))).toBe(true);
    expect(fs.existsSync(current)).toBe(false);
  });

  it('rename fails (another volume): copied without caches, verified, original kept', () => {
    seedLegacy();
    const out = migrateUserData(opts({ forceCopy: true }));
    expect(out).toMatchObject({ result: 'copied', userData: current, legacy });
    expect(out.error).toMatch(/EXDEV/);
    expect(fs.existsSync(path.join(legacy, 'prefs.json'))).toBe(true); // the original stays
    expect(fs.existsSync(path.join(current, 'GPUCache'))).toBe(false); // disposable caches are not copied
    // Same files (prefs.json differs only by the rewritten cacheDir).
    expect([...listFiles(current).keys()].sort()).toEqual([...listFiles(legacy).keys()].sort());
    expect(fs.readFileSync(path.join(current, 'whisper', 'models', 'ggml-tiny.bin'))).toEqual(fs.readFileSync(path.join(legacy, 'whisper', 'models', 'ggml-tiny.bin')));
    expect(fs.existsSync(`${current}.migrating`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(current, 'prefs.json'), 'utf8')).cacheDir).toBe(path.join(current, 'mycache'));
    expect(readMigrationMarker(current)?.result).toBe('copied');
  });

  it('rename fails with EPERM (a scanner holds a file): the same copy fallback', () => {
    seedLegacy();
    const realRename = fs.renameSync;
    const fakeFs = {
      ...fs,
      renameSync: ((a: fs.PathLike, b: fs.PathLike) => {
        if (String(a) === legacy) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return realRename(a, b);
      }) as typeof fs.renameSync,
    };
    expect(migrateUserData(opts({ fs: fakeFs })).result).toBe('copied');
    expect(fs.existsSync(path.join(legacy, 'prefs.json'))).toBe(true);
  });

  it('the copy fails part way: the partial copy is removed, the legacy folder is used and untouched, no marker', () => {
    seedLegacy();
    const legacyFilesBefore = [...listFiles(legacy)];
    let copies = 0;
    const fakeFs = {
      ...fs,
      copyFileSync: ((a: fs.PathLike, b: fs.PathLike, mode?: number) => {
        if (++copies === 3) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return fs.copyFileSync(a, b, mode);
      }) as typeof fs.copyFileSync,
    };
    const out = migrateUserData(opts({ fs: fakeFs, forceCopy: true }));
    expect(out).toMatchObject({ result: 'failed', userData: legacy, legacy });
    expect(out.error).toMatch(/ENOSPC/);
    expect(fs.existsSync(`${current}.migrating`)).toBe(false);
    expect(fs.existsSync(current)).toBe(false);
    expect([...listFiles(legacy)]).toEqual(legacyFilesBefore);
    expect(fs.readFileSync(path.join(legacy, 'whisper', 'models', 'ggml-tiny.bin')).length).toBe(4096);
    // Retried at the next launch.
    expect(migrateUserData(opts()).result).toBe('moved');
  });

  it('a copy that does not verify is refused (sizes differ)', () => {
    seedLegacy();
    const fakeFs = {
      ...fs,
      copyFileSync: ((a: fs.PathLike, b: fs.PathLike, mode?: number) => {
        fs.copyFileSync(a, b, mode);
        if (String(a).endsWith('ggml-tiny.bin')) fs.truncateSync(b, 10);
      }) as typeof fs.copyFileSync,
    };
    const out = migrateUserData(opts({ fs: fakeFs, forceCopy: true }));
    expect(out.result).toBe('failed');
    expect(out.error).toMatch(/ggml-tiny\.bin: 4096 bytes, 10 copied/);
    expect(fs.existsSync(current)).toBe(false);
  });

  it('the override and the marker skip everything', () => {
    seedLegacy();
    expect(migrateUserData(opts({ overridden: true }))).toMatchObject({ result: 'none', reason: 'override', userData: current });
    expect(fs.existsSync(path.join(legacy, 'prefs.json'))).toBe(true);
    fs.mkdirSync(current);
    fs.writeFileSync(path.join(current, MIGRATION_MARKER), JSON.stringify({ result: 'nothing-to-migrate' }));
    expect(migrateUserData(opts())).toMatchObject({ result: 'none', reason: 'done' });
    expect(fs.existsSync(path.join(legacy, 'prefs.json'))).toBe(true);
  });

  it('a case-only rename on a case-insensitive system is the same folder: skipped', () => {
    seedLegacy();
    const out = migrateUserData(opts({ platform: 'win32', current: path.join(appData, 'OLDNAME') }));
    expect(out).toMatchObject({ result: 'none', reason: 'same-folder' });
  });

  it('two launches at once: the one finding the migration lock held by a live process waits, then gives up (busy)', () => {
    seedLegacy();
    fs.writeFileSync(`${current}.migration-lock`, '999999');
    let t = 0;
    const out = migrateUserData(opts({ isPidAlive: () => true, now: () => (t += 1000), lockWaitMs: 5000 }));
    expect(out).toMatchObject({ result: 'busy', userData: current });
    expect(fs.existsSync(path.join(legacy, 'prefs.json'))).toBe(true);
  });

  it('a stale migration lock (its process is gone) is taken over', () => {
    seedLegacy();
    fs.writeFileSync(`${current}.migration-lock`, '999999');
    expect(migrateUserData(opts({ isPidAlive: () => false })).result).toBe('moved');
    expect(fs.existsSync(`${current}.migration-lock`)).toBe(false);
  });

  it('a launch that waited sees the other launch\'s result and does not migrate again', () => {
    seedLegacy();
    fs.writeFileSync(`${current}.migration-lock`, '999999');
    let waits = 0;
    const out = migrateUserData(opts({
      isPidAlive: () => true,
      sleep: () => {
        // The other launch finishes while this one waits.
        if (++waits === 2) { fs.renameSync(legacy, current); fs.writeFileSync(path.join(current, MIGRATION_MARKER), '{"result":"moved"}'); fs.unlinkSync(`${current}.migration-lock`); }
      },
    }));
    expect(out).toMatchObject({ result: 'none', reason: 'done', userData: current });
  });
});
