/**
 * The Electron perf scripts launch the app with Chromium's shared memory on tmpfs
 * (bugs/closed/2026-10-08-perf-multi-hour-scrub-long-tasks-flaky.md). Playwright's Electron loader adds
 * --disable-dev-shm-usage, which puts every shared memory region in a file under TMPDIR; on a disk-backed /tmp their
 * writeback slowed the renderer 4–6x and made `long tasks during scrub multi-hour @ 1 px/frame` flaky.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { launchEnv } from '../perf/_launch-env.mjs';

const PERF = path.resolve(__dirname, '../perf');

describe('perf launch environment', () => {
  // The module removes its directory on process exit, which a vitest worker may skip.
  afterAll(() => { const d = launchEnv().TMPDIR; if (d?.startsWith('/dev/shm/recut-perf-')) fs.rmSync(d, { recursive: true, force: true }); });

  it.runIf(process.platform === 'linux' && fs.existsSync('/dev/shm'))('puts TMPDIR on /dev/shm and keeps the rest of the environment', () => {
    const env = launchEnv({ RECUT_DISABLE_GPU: '1' });
    expect(env.TMPDIR).toMatch(/^\/dev\/shm\/recut-perf-/);
    expect(fs.statSync(env.TMPDIR!).isDirectory()).toBe(true);
    expect(env.RECUT_DISABLE_GPU).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
    // One directory per process, reused by later launches.
    expect(launchEnv().TMPDIR).toBe(env.TMPDIR);
  });

  it('is what every Electron launch of the perf scripts uses', () => {
    for (const file of ['electron-perf.mjs', '_electron-common.mjs']) {
      const src = fs.readFileSync(path.join(PERF, file), 'utf8');
      const launches = src.match(/electron\.launch\(\{[^\n]*/g) ?? [];
      expect(launches.length, file).toBeGreaterThan(0);
      for (const l of launches) expect(l, file).toContain('env: launchEnv(');
    }
  });
});
