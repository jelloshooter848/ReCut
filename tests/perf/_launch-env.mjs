/**
 * Launch environment of the Electron perf scripts (electron-perf.mjs, _electron-common.mjs). Pure Node, no
 * Playwright import, so tests/unit/perf-launch-env.test.ts can check it.
 */
import fs from 'node:fs';

/**
 * Environment for an app launched with Playwright's `_electron.launch` in a perf script: `extra` over process.env,
 * plus TMPDIR on tmpfs (/dev/shm) on Linux.
 *
 * Why: Playwright's Electron loader appends `--disable-dev-shm-usage` (playwright-core
 * lib/server/electron/loader.js, chromiumSwitches; meant for Docker's tiny /dev/shm). With it, Chromium creates every
 * shared memory region (decoded video frames, software-compositor tiles and resources, IPC buffers) as a deleted
 * file in TMPDIR, and on this container /tmp is the ext4 disk. Scrubbing the multi-hour sequence then dirties
 * hundreds of MB of such file pages in the renderer (435–463 MB in a 40 s scrub harness, 800 MB in the 90 s before
 * and during the multi-hour scrub row); their writeback (the kernel's flush worker, up to 30 s later) ran every
 * thread of the renderer 4–6x slower for 0.2–0.5 s and turned page-flip frames of ~15 ms into 50–110 ms long tasks
 * (bugs/closed/2026-10-08-perf-multi-hour-scrub-long-tasks-flaky.md @ 59eafc6). The app as users run it never gets that
 * switch (electron/main.ts appends only no-sandbox and enable-blink-features): Chromium keeps its shared memory in
 * /dev/shm or memfd there. TMPDIR on tmpfs restores that, since the switch only moves the regions to TMPDIR. Not used
 * when /dev/shm has under 2 GiB free (see below). The app's own temp files (export filter scripts, OCR extraction)
 * follow os.tmpdir() into it too; they are small and deleted after use. Created once per process, removed on exit.
 */
let shmTmp = null;
let warned = false;
/** Free space /dev/shm needs before the bench uses it (bytes). */
const MIN_SHM_FREE = 2 * 2 ** 30;
export function launchEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (process.platform === 'linux' && process.env.RECUT_PERF_DISK_SHM !== '1') {
    try {
      // Only on a roomy tmpfs: a small /dev/shm (Docker's default is 64 MB) is why Playwright adds the switch, and
      // Chromium crashes when it cannot grow a shared memory file. A run of electron-perf.mjs keeps up to 0.6 GB of
      // such files alive (measured: median 0.56 GB, peak 0.60 GB on the 4-core container).
      const st = fs.statfsSync('/dev/shm');
      if (st.bavail * st.bsize < MIN_SHM_FREE) {
        if (!warned) {
          warned = true;
          console.warn(`[perf] /dev/shm has under ${MIN_SHM_FREE / 2 ** 30} GiB free: Chromium's shared memory stays in TMPDIR (${process.env.TMPDIR || '/tmp'})`);
        }
        return env;
      }
      if (!shmTmp) {
        shmTmp = fs.mkdtempSync('/dev/shm/recut-perf-');
        process.on('exit', () => { try { fs.rmSync(shmTmp, { recursive: true, force: true }); } catch { /* best effort */ } });
      }
      env.TMPDIR = shmTmp;
    } catch { /* no writable /dev/shm: keep TMPDIR */ }
  }
  return env;
}
