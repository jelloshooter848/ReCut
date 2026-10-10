# Perf gate: multi-hour scrub at 1 px/frame has 50–155 ms long tasks in about half the runs

| Field | Value |
|---|---|
| Status | fixed |
| Severity | medium |
| Area | timeline / performance gate |
| Reported by / date | Claude (perf gate re-run on 0.8.0), 2026-10-08 |
| Found on commit | 3b9ffdf (main, 0.8.0 + PR #92); also on 0.7.0 (2aaf2c0) |
| Environment | 4-core cloud container of the reference class (Xeon 2.10 GHz, 16 GB), Linux 6.18, Node 22.22.0, FFmpeg 6.1.1-3ubuntu5, xvfb with software GL, source build |

## Report

### Summary
The gate `electron | long | long tasks during scrub multi-hour @ 1 px/frame, no selection` (budget `== 0`) fails in
about half the runs, on 0.7.0 and on 0.8.0 alike. With `--runs 2` a gate must pass in both runs, so `npm run
perf:check` is not reproducibly green on the reference-class container. That leaves the 1.0 criterion "The
performance gate passes" (docs/ROADMAP.md, Ready for 1.0, item 7) open. A user scrubbing a 3 h sequence at
1 px/frame sees 2–5 hitches of 50–155 ms in the 3 s drag, about one run in two.

### Steps to reproduce
1. On a quiet machine, holding the perf lock: `npm run build`, then
   `xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-perf.mjs`. Or run
   `node tests/perf/perf-check.mjs --electron-only --skip-build`.
2. Read the row `long tasks during scrub multi-hour @ 1 px/frame, no selection` in `test-results/perf/electron.json`
   (`value` is the count, `longTasks` the durations in ms).
3. Repeat 3–5 times.

### Expected
0 long tasks in every run, as in the seed runs of the baseline (`calib/seed2`, 7 October: 0 and 0).

### Actual
Results of the same-host runs on 8 October, quiet machine, perf lock held. The lists are task durations in ms.

| Build | Runs | Values |
|---|---|---|
| main 3b9ffdf | 7 | 2 [109, 85], 3 [87, 100, 58], 0, 0, 0, 4, 0 |
| 0.7.0 2aaf2c0 | 3 | 5 [57, 80, 74, 60, 62], 4 [114, 118, 101, 85], 3 [82, 104, 81] |

The 0.7.0 runs were interleaved with three of the main runs (`perf-check.mjs --ab`).

In earlier result folders since the row was added on 6 October, it reads 0 to 7 on every build. For example, the
`i5/ab-iso` A/B on 7 October (pre-0.8.0 code) gave 4, 3, 0 and 7. The other multi-hour scrub variants nearly always
read 0: 50 clips selected, within the visible page, and zoom-to-fit.

### Evidence
- `docs/attack/performance.md` → "Gate re-run on 0.8.0 (8 October 2026)": the full table, and the A/B result
  (B better than A on this row: 0 [0–0] against 4 [3–5]).
- `bugs/closed/2026-10-05-perf-budgets-2500-clips.md` → Follow-ups already lists "first-visit page-flip cost on the
  3 h sequence on a loaded machine" as possible future work.

### Suspected cause (hypothesis)
This row has not been profiled. The counting pass of the same scrub records about 176–180 page flips: every page
flip mounts a newly visible page of the 3 h sequence. The long tasks are probably first-visit page flips, which
mount clips and request filmstrips and waveforms, and land in the timing pass when the counting pass has not already
visited those pages. A hypothesis to check: whether the run order (counting pass, then timing pass) and caching in
`src/panels/timeline` decide when a page counts as visited. Profile it with `electron-cpuprof.mjs` adapted to this
scenario, or with a Chromium trace of the timing pass, and compare a run with long tasks against one without.

### Scope
Two related rows also keep the gate from being reproducibly green. Neither is a 0.8.0 change.
- `main | thumbs | filmstrip 48 frames cold` (guardrail, ≤ 3,000 ms): 3,036 and 2,859 ms on 8 October. The baseline
  median is 2,984 ms and was over budget in 1 of its 2 seed runs.
- `electron | pool | media elements created during 10 s playback @ 1 px/frame` (guardrail, count, baseline 0,
  tolerance 1): it reads 0–2 on every build since the seed, including 1 and 2 on code equal to the baseline's playback
  code. The seed's 0 / 0 was the low end, so medians of 1.5–2 fail the zero-baseline rule.


---

## Verification

| Field | Value |
|---|---|
| Verified by / date | Claude (Claude Code session), 2026-10-08/09 |
| Verified on commit | 37912dd (`claude/perf-gate-080`: 0.8.0 + the perf-gate re-run) |
| Verdict | Reproduced: 6 of 11 full Electron bench runs failed the row (2–4 long tasks of 50–101 ms) |

Every run held the heavy and perf locks and started at a 1-minute load of 1.0 or less. The scrub's timing pass was
traced in each run (CDP tracing, or tracing plus a 4 ms sampler of the renderer main thread's `schedstat`, the
renderer's `utime`/`stime`/page faults, `/proc/stat`, `/proc/meminfo` Dirty/Writeback and per-process CPU and
`write_bytes`). The scripts are in the session scratchpad. The bench copy only adds the trace around this one row.

| Run | Long tasks (start in the 3 s pass: duration, ms) | Kernel writeback (flush worker) during the pass |
|---|---|---|
| t2 | 0 | not sampled |
| t3 | 2476: 57, 2535: 64, 2604: 50, 2657: 62 | not sampled |
| t4 | 1355: 63, 1427: 88, 1572: 52 | not sampled |
| t5 | 2708: 50, 2839: 74 | not sampled |
| t6 | 0 | not sampled |
| s2 | 528: 59, 595: 79, 683: 75, 773: 100 | 0.54–0.86 s, 33 ticks |
| s3 | 0 | none |
| s4 | 1156: 67, 1226: 101, 1341: 70 | 1.18–1.40 s, 24 ticks |
| s5 | 0 | none |
| s6 | 2507: 80, 2589: 58, 2649: 65 | 2.5–2.7 s, 16 ticks |
| s1 | 0 | sampler did not attach |

---

## Resolution

| Field | Value |
|---|---|
| Closed by / date | Claude (Claude Code session), 2026-10-09 |
| Fix | Harness fix, no app change: the Electron perf scripts launch the app with `TMPDIR` on tmpfs (`/dev/shm`), so Chromium's shared memory is not disk-backed (it is not in a normal launch of the app either) |
| Files changed | `tests/perf/_launch-env.mjs` (new), `tests/perf/_launch-env.d.mts` (new), `tests/perf/_electron-common.mjs`, `tests/perf/electron-perf.mjs`, `tests/unit/perf-launch-env.test.ts` (new), `docs/DEVELOPMENT.md`, `docs/attack/performance.md`, this file; new open bugs `2026-10-09-perf-filmstrip-cold-borderline.md`, `2026-10-09-perf-pool-elements-created-during-playback.md`, `2026-10-09-program-scrub-stalls-on-unready-element.md` |
| Regression test | `tests/unit/perf-launch-env.test.ts` |

### Root cause

The long tasks are not slow code in the app. They are ordinary page-flip frames that ran 4–6× slower while the kernel
was writing back hundreds of megabytes of Chromium shared memory that the test harness had put on the disk.

1. **What a long task is.** In every failing trace the long tasks are single page-flip frames: one
   `FireAnimationFrame` (the bench's `setView`, the React render of the new page) followed by `UpdateLayoutTree`,
   `Layout`, `PrePaint`, `Paint`, `Layerize` and `Commit`. Normal frames of the same pass take 14–16 ms (the main
   thread is about 95 % busy at 60 fps). In a long task each phase is 4–8× its normal cost for the same work:
   t4 at 1427 ms, 88 ms in total: JS 18.8 ms (normal 3.8), style 9.4 ms for 37–172 elements (normal 0.8 ms for the
   same counts), layout 16.7 ms for 138–285 dirty objects (normal 1.6 ms for the same counts), paint 11.8 (1.4),
   layerize 13.2 (2.4). Nothing extra ran: no GC (no V8 GC event over 1 ms inside any of the 11 traced long tasks), no new work
   type, the same Layout dirty-object counts as the frames around them.
2. **The thread was on the CPU, just slow.** Thread CPU time (`tdur`) equals wall time in every long task (t3:
   57/60, 64/62, 50/49, 62/54 ms; t4: 63/63, 88/89, 49/49, 53/52; t5: 51/51, 50/48, 75/74). The sampler shows the
   main thread at about 100 % CPU with 0–10 % run-queue wait in those windows, no major faults, no direct
   compaction or reclaim (`compact_stall` and `allocstall` stay 0), and `utime`, not `stime`. So it was not starved
   by other processes. Its work ran slower: every renderer thread slowed together.
3. **When it happens: kernel writeback.** In all 5 sampled runs the long tasks line up with the kernel's flush
   worker (`kworker/u16:N+flush-254:0`, writeback to `/dev/vda`) and with no other activity on the machine. The 3
   failing runs had writeback in exactly the long-task window (s4: Dirty 315 → 259 MB flushed in 1.18–1.40 s, long
   tasks 1.16–1.41 s). The 2 passing runs (s3, s5) had none during the pass.
4. **What was written: the renderer's shared memory, on disk.** Per-process `write_bytes` in s6: the renderer
   process dirtied 800 MB of file pages in the 90 s before and during the pass (163 MB in the 5 s of the preceding
   zoom-to-fit scrub, 77 MB during the pass), the browser process 134 MB, everything else under 16 MB. The app's
   autosaves are a small part of it (4 `autosaveJson` writes, about 30 MB each). The renderer holds about 100 open
   deleted files `/tmp/.org.chromium.Chromium.XXXXXX`: its shared memory regions (decoded video frames for the
   Program monitor, software-compositor tiles and resources, IPC buffers). They are on disk because Playwright's
   Electron loader appends `--disable-dev-shm-usage` (playwright-core `lib/server/electron/loader.js`,
   `chromiumSwitches`). With that switch Chromium creates shared memory as files in `TMPDIR`, and on this
   container `/tmp` is the ext4 root disk (`/dev/shm` is tmpfs). How writeback slows a process that has those
   pages mapped is not measured in detail. The likely mechanism: writeback write-protects the mapped pages, which
   costs faults and TLB shootdowns on the CPUs running the process's threads, and in this VM (Firecracker,
   virtio-blk) the block I/O itself also takes host CPU. The measured effect: the whole renderer ran 4–6× slower
   for 0.2–0.5 s.
5. **Why this row, and why half the runs.** The kernel writes dirty pages back 30 s after they are dirtied
   (`dirty_expire_centisecs` 3000, flusher every 5 s). This row's 3 s timing pass is the first heavy step about 30 s
   after the multi-hour section's sequence switches, zoom-to-fit scrub and filmstrip work dirtied 250–350 MB, and
   its main thread runs at 95 % with no slack. Whether the flush lands inside the 3 s window depends on the
   flusher's 5 s phase, so about half the runs fail. The row after it (50 clips selected) starts after the flush,
   and the in-page rows dirty little. A user never runs the app with that switch: Chromium on Linux keeps shared
   memory in `/dev/shm` or memfd (RAM).
6. **Confirmed by a direct A/B.** A small harness (launch, big project, 20 distinct copies of the media as in the
   bench's proxy step, multi-hour sequence, the same scrub sweep, about 40 s per run) was run interleaved, 7 + 1
   runs with the default `/tmp` against 6 runs with `TMPDIR=/dev/shm`, each with a timing and a counting pass:
   - `/tmp`: long tasks in 4 of 16 passes (56, 63, 58 and 68 ms), and the renderer wrote 435–463 MB.
   - `/dev/shm`: 0 of 12 passes, and the renderer wrote 0 bytes.

   The Program monitor's decode traffic during the sweep was the same on both sides: 16–28 media elements created
   per pass.

Two side findings, not the cause:
- In 2 of the 11 runs the Program monitor issued no seeks during the whole pass (s3: 0 `currentTime` writes, with 2
  pooled elements stuck at `readyState < 2` or seeking before the pass). Those runs did less media work. Filed as
  `bugs/open/2026-10-09-program-scrub-stalls-on-unready-element.md`.
- Chromium also does extra work per page flip in this sweep: about 15 ms of main-thread time per frame. That is
  within budget (60 fps) and unchanged.

### Fix

The bench is genuinely wrong here: it measured a test-harness artifact that no user of the app can hit. The app is
unchanged.

- `tests/perf/_launch-env.mjs` (new): `launchEnv(extra)` returns `process.env` plus `extra`, with `TMPDIR` set to a
  per-process directory under `/dev/shm` on Linux, removed on exit. With Playwright's switch, Chromium's shared
  memory then lives on tmpfs again, as it does without the switch. The app's own small temp files (export filter
  scripts, OCR extraction) follow `os.tmpdir()` there too and are deleted after use. `RECUT_PERF_DISK_SHM=1` keeps
  the old behaviour, for reproducing this bug.
- `electron-perf.mjs` and `_electron-common.mjs` (`launchAndBuild`, used by `electron-probe`, `electron-cpuprof`,
  `electron-attrib`) launch with `env: launchEnv({...})`. `calibrate.mjs` starts Electron itself, without
  Playwright, so it never had the switch and is unchanged.
- No budget, tier, row name or baseline changed.

### Before / after

All runs held the heavy and perf locks and started at a 1-minute load of 1.0 or less. The row is the count of long
tasks in the 3 s timing pass, with durations in ms.

| Measurement | Before (Chromium shared memory in `/tmp` on disk) | After (`TMPDIR` on `/dev/shm`) |
|---|---|---|
| Full `electron-perf.mjs`, traced or sampled copy (37912dd) | 11 runs: 0, 4 [57, 64, 50, 62], 3 [63, 88, 52], 2 [50, 74], 0, 0, 4 [59, 79, 75, 100], 0, 3 [67, 101, 70], 0, 3 [80, 58, 65]: 6 of 11 fail | — |
| Full `electron-perf.mjs` (this fix) | — | 5 runs: 0, 0, 0, 0, 0 |
| `npm run perf:check -- --runs 2` (this fix) | — | row 0 and 0, PASS 2/2; all 98 of 98 gates PASS in both runs |
| Narrow harness, interleaved, timing + counting pass | 8 runs: long tasks in 4 of 16 passes (56, 63, 58, 68); renderer wrote 435–463 MB | 6 runs: 0 of 12 passes; renderer wrote 0 bytes |
| Peak `/dev/shm` use during a full run | — | 0.60 GB (median 0.56 GB) |

The first before-run's 551 ms task at the start of the pass was the trace starting; it is excluded above. Earlier
runs (bug report) on the same code: 2, 3, 0, 0, 0, 4, 0, and on 0.7.0: 5, 4, 3.

`perf:check --runs 2` (both suites, this fix):
- Gates: 98, PASS 98, FAIL 0 (raw, no normalization needed).
- Guardrails: 134, PASS 132, FAIL 2.
  - `pool: media elements created during 10 s playback` read 2 and 2: pre-existing, now its own open bug.
  - `main | thumbs | filmstrip 48 frames warm (all cached)` read 5.58 and 13.83 ms against a 5.2 ms baseline. The
    node suite is unchanged by this fix. Three reruns of that test, alone and locked, read 4.35, 4.73 and 3.65 ms,
    so run 2's 13.83 ms was noise.
- `filmstrip 48 frames cold`: 2,528 and 2,706 ms (PASS, x0.88 of the baseline).
- Every other gate and guardrail row was the same or better.

No same-host A/B of the app was run: no app code changed (`dist/` is identical on both sides), and the harness A/B
above isolates the one variable the fix changes.

### Regression test proof

`tests/unit/perf-launch-env.test.ts` checks two things: that `launchEnv` puts `TMPDIR` on `/dev/shm/recut-perf-*`
and keeps the rest of the environment, and that every `electron.launch({…})` in `electron-perf.mjs` and
`_electron-common.mjs` passes `env: launchEnv(`. On 37912dd the second test fails, because both launches pass
`env: { ...process.env, … }`, and the module does not exist yet.

On 37912dd (in a scratch worktree, with only the test file copied in):

```
 FAIL  tests/unit/perf-launch-env.test.ts
Error: Failed to load url ../perf/_launch-env.mjs ... Does the file exist?
```

With `_launch-env.mjs` copied in too, but the launches unchanged:

```
 × perf launch environment > is what every Electron launch of the perf scripts uses
   → electron-perf.mjs: expected 'electron.launch({ args: [path.join(RO…' to contain 'env: launchEnv('
      Tests  1 failed | 1 passed (2)
```

On this branch: 2 passed.

### Tests run

- `npm run typecheck`: clean.
- `npm test`: 119 files, 2,026 passed, 2 skipped.
- `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts` on timeline, program, nest and keyframes specs
  (heavy lock): 14 passed.
- `node tests/perf/perf-check.mjs --runs 2`: see Before / after.
- 5 runs of `electron-perf.mjs`.

### Changed existing assertions

None.

### Compatibility risks

None for the app: no app code changed. The shipped app never gets `--disable-dev-shm-usage`. `electron/main.ts`
appends only `no-sandbox` (when passed) and `enable-blink-features`, and the switch comes from Playwright's loader,
which only test launches load.

- **CI:** no workflow runs `tests/perf`. On Windows CI, `npm test` runs the new unit test: its Linux-only case is
  skipped, and the source check passes.
- **`/dev/shm` size:** a full bench run keeps up to 0.60 GB of shared memory alive (median 0.56 GB). `/dev/shm` on
  this container is a 16 GB tmpfs (RAM-backed), and the same memory sits in the page cache when it is in `/tmp`.
  `launchEnv` uses `/dev/shm` only with at least 2 GiB free, and checks again at each launch. Below that, for
  example in Docker's default 64 MB, it prints a warning and leaves `TMPDIR` alone (the old behaviour) rather than
  let Chromium crash on a full tmpfs. `RECUT_PERF_DISK_SHM=1` forces the old behaviour. Perf results from before this fix on a disk-backed `/tmp` include the
writeback noise. Rows that page-flip or decode heavily (the multi-hour page-flip scrub) were the ones affected. Other
rows' values can improve slightly. On a host whose `/tmp` is already tmpfs nothing changes.

### Follow-ups

- [#155](https://github.com/jelloshooter848/ReCut/issues/155): `main | thumbs | filmstrip 48 frames cold` sits on its
  3,000 ms guardrail. It is a node-suite row with a different cause.
- `bugs/open/2026-10-09-perf-pool-elements-created-during-playback.md`: the pool row reads 1–2 against a seed of 0.
  It still read 2, 2, 1 in the 3 verification runs after this fix, so the cause is not shared.
- `bugs/open/2026-10-09-program-scrub-stalls-on-unready-element.md`: the Program monitor sometimes stops seeking
  during a scrub.
- The e2e and attack suites also launch through Playwright and so put shared memory in `/tmp`. They measure
  correctness, not timing, so this is left as is.
