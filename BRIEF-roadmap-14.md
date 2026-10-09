# Brief: roadmap §14, first slice: direct HEVC preview

> Working brief for this branch. **Delete this file in the last commit before the PR is marked ready**, so it never
> reaches `main`.

## Who and where
- **Branch:** `roadmap-14-hevc-preview` (this branch, cut from `main` at `c142f2f`). Work and push here only.
- You and your agent may push to this branch and open **one PR from it into `main`** (draft until ready).
  Do not push to `main` or any other branch. The owner (jelloshooter848) merges.
- The coordinating session may add commits here too (for example, merging the latest `main` or dropping in
  reference material). Pull before you start each session: `git pull origin roadmap-14-hevc-preview`.
- Read first: [CONTRIBUTING.md](CONTRIBUTING.md), [CLAUDE.md](CLAUDE.md) (the coding rules every agent follows),
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and
  [docs/ROADMAP.md](docs/ROADMAP.md) §14 and §2.

## The goal
Today the preview (Source and Program monitors) plays media through Chromium `<video>` elements. Anything Chromium
can't decode on every platform (HEVC, AC-3, DTS, …) is marked "needs a proxy" and plays through an automatically
generated H.264 proxy (see [docs/LIMITATIONS.md](docs/LIMITATIONS.md), "Preview (Chromium) and proxies", and
[docs/FORMATS.md](docs/FORMATS.md)). Export is unaffected: it always reads the originals with FFmpeg.

**This slice: play HEVC video directly in the preview, without a proxy, on machines that can decode it, and fall back
to the proxy everywhere else.**

### In scope
1. **Capability detection at runtime.** Decide per file whether this machine can decode it directly, for example with
   `VideoDecoder.isConfigSupported()` (WebCodecs) and/or `HTMLMediaElement.canPlayType` / `MediaCapabilities`
   with the file's real codec string (profile, level, bit depth, chroma from the probe). Electron is 33.x
   (Chromium 130), which has platform HEVC hardware decode on macOS and Windows where the GPU/OS supports it. Linux
   generally does not; it must fall back cleanly.
2. **Choose the simplest path that is frame-accurate.** If Chromium's `<video>` element can play the HEVC file
   directly on this machine, using it through the existing element pool is far less code than a WebCodecs decoder.
   Only build a WebCodecs path if `<video>` can't meet the frame-accuracy rules below. Write down which you chose and
   why in the PR.
3. **A setting, off by default to start:** "Play HEVC directly when this computer supports it". Off means today's
   behaviour exactly. Put it where the other preview/proxy settings live.
4. **Fallback is automatic and silent:** unsupported machine, unsupported profile (e.g. 4:2:2 or 12-bit), or a
   decode error at runtime → use the proxy (generate it if needed), as today. Never a black or frozen monitor.
5. **UI truth:** the Program monitor already shows a **Proxy** chip and the timeline shows a **PROXY** badge for clips
   that need one. Make those reflect the real path (direct vs proxy) with the setting on.

### Out of scope (later slices of §14)
- Hardware encoders (NVENC / VideoToolbox / QSV) for proxies and export.
- AC-3 / DTS direct audio, and other non-HEVC codecs.
- Changing export in any way.

## Rules you must keep
- **Preview matches export (§2).** Frame N in the monitor must be the same source frame FFmpeg exports for frame N.
  The existing direct and proxy paths are built and tested to be frame-accurate (see `src/playback/sync.ts`,
  `mediaTimeOffset` / `toElementTime` / `fromElementTime` in `src/playback/mediaSource.ts`, and the e2e and attack
  seek specs under `tests/attack/e2e`). The direct-HEVC path must pass the same checks. HEVC with B-frames and
  open GOPs is where this usually breaks, so test seeks, not just playback.
- **Timeline positions are integer frames; source positions are seconds** (CLAUDE.md).
- **Never mutate the project outside store actions** (CLAUDE.md). A new setting is a store field with an action, and
  must be handled in project load/repair (`shared/project.ts`) if it is saved in the project; a user preference that
  isn't project data belongs with the other preferences instead.
- **Performance gate:** `npm run perf:check` must not get worse (see docs/DEVELOPMENT.md, perf section). Decoding
  4K HEVC directly is heavier than an H.264 proxy; measure scrub and playback on a 4K HEVC clip with the setting on.
- **No new npm dependencies** without asking the owner first.
- **Don't change the version** (`package.json`); feature PRs never do (docs/RELEASING.md).

## Where to look
| Area | Files |
|---|---|
| Probe and "browser playable" decision | `electron/media/probe.ts` (`evaluatePlayability`, `browserPlayable`, `playabilityReason`), `shared/model.ts` (`MediaProbe`) |
| Choosing original vs proxy for preview | `src/playback/mediaSource.ts` (`mediaNeedsProxyForPreview`, `resolvePlaybackPath`, `previewPlaybackLabel`) |
| Playback engine | `src/playback/sequencePlayer.ts`, `sourcePlayer.ts`, `elementPool.ts`, `sync.ts`, `planner.ts`, `clock.ts` |
| Proxy jobs and UI | `electron/media/proxy.ts`, `src/panels/jobs/ProxiesTab.tsx`, `src/panels/timeline/clipBadges.ts`, `ClipView.tsx`, `src/panels/program/missing.ts`, `ProgramPanel.tsx` |
| Settings | `shared/model.ts` (`useProxies` and friends), the settings UI, `shared/project.ts` (load/repair) |
| Media protocol | `recut-media://` in `shared/ipc.ts` and the main-process handler; seeking needs byte-range support, which exists |

## Tests expected
- **Unit:** the direct-vs-proxy decision for each case (supported, unsupported profile, setting off, decode error
  fallback, proxies off with a ready proxy). Put pure logic in a testable module, as `mediaSource.ts` does.
- **e2e (Playwright + Electron):** with the setting on and an HEVC clip, the Program monitor plays it directly where
  supported, or falls back to the proxy with the right chip; seeking to known frames shows the right frame (burned-in
  frame numbers make this easy; the perf media and the tester kit both have HEVC clips; FFmpeg can make one with
  `-c:v libx265` and a `drawtext` frame counter). On Linux CI, direct decode is likely unavailable, so the test must
  assert the fallback there and the direct path where the platform supports it (macOS CI runners).
- Run `npm run typecheck` and `npm test` before every push; `npm run test:e2e` before asking for review.

## CI
CI does not run automatically on PR branches. To get a full build and test run on Windows, macOS and Linux, run the
**Windows build** workflow on this branch: GitHub › Actions › *Windows build* › *Run workflow* › branch
`roadmap-14-hevc-preview`. Or ask the coordinating session to dispatch it.

## Docs and roadmap, in the same PR
- `docs/FORMATS.md` and `docs/LIMITATIONS.md` (the preview and proxies sections): describe the new behaviour and the
  platforms it works on.
- `docs/USER-GUIDE.md`: the new setting.
- `docs/ROADMAP.md` §14: update the **Status** line to say this slice is done (and that hardware encoders remain), and
  its row in the Progress table. Bugs found on the way are filed under `bugs/` (see `bugs/README.md`).

## Target
Lands in the next MINOR release after it's merged: likely **1.1.0**. 0.9.0 and 1.0 do not wait for it. If it's done
early, well tested and behind the setting (off by default), the owner may choose to include it sooner.

## Coordination
Tell the owner when you start and if you need to touch files outside the table above, so the other work in flight
(interchange export in PRs #83 / #87, a perf fix around timeline scrubbing) can steer clear. If `main` moves under you,
merge it into this branch (merge commit, no rebase or force-push).
