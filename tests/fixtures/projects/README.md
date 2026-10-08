# Saved-project fixtures

`recut-<version>.recut` is a project file **saved by ReCut `<version>` itself**, one for every stable release from
0.3.0 on. `tests/unit/project-compat.test.ts` opens each one through the app's real open path
(`loadProjectFile` in `electron/project/io.ts`, which runs `normalizeProject`) and checks that nothing the release
saved is lost, that saving and reopening is stable, and that a file from a newer format is refused with a clear
message. This is the test behind the compatibility promise in [docs/project-format.md](../../../docs/project-format.md#compatibility-promise).

**Never edit these files by hand, and never regenerate an old one.** Each is a record of what that release wrote. If
a change to ReCut makes one of them fail to open, or open with less data, the change is wrong (or needs a migration in
`normalizeProject()`), not the fixture. Line endings are kept as written (`.gitattributes`).

## How they are made

`node scripts/make-project-fixture.mjs --root <checkout of the release>` builds the same project with the given
checkout's own code and writes `tests/fixtures/projects/recut-<version>.recut` here:

1. `scripts/project-fixture-scenario.mjs` is bundled with esbuild against that checkout (its `src/state/store.ts`,
   `shared/` and `electron/project/io.ts`; packages come from the checkout's `node_modules`, then from this
   repository's).
2. It drives the checkout's store with the same actions the UI calls: five media items with probe data (a 5.1 movie
   with two audio and two subtitle streams, a PAL anamorphic TV episode organised as a series, a FLAC, a PNG still and
   an offline file; Windows and POSIX paths, non-ASCII names), proxies, detected scenes, media subtitle tracks
   (SRT sidecar, manual, and from 0.6.0 an OCR track with its `streamIndex`), bins, tags, non-default project
   settings, three sequences (23.976 fps stereo with linked picture and sound, a disabled clip, transitions of every
   type, a transform, audio levels and fades, clip tags, chapter / range / continuity markers, story blocks, carried
   and manual subtitle cues, a snapshot, a locked track and a stored view, and from 0.8.0 keyframes (see below); an
   alternate cut with lineage and a version label; a 25 fps 5.1 sequence) and the scene library. From 0.8.0 (nested
   sequences) the alt cut also holds a compound clip (a fourth sequence, "Reel 1") and the 25 fps sequence nested
   after it.
3. It serializes the project as that release saves it (`serializeForSave` and `projectJsonChunks`, as
   `src/state/mediaActions.ts` does) and writes it with that release's `saveProjectJson`.
4. It opens the file again with that release's `loadProjectFile` and fails unless it opens without repairs.

**Keyframes (from 0.8.0, Roadmap §11).** When the checkout's store has `addClipKeyframe`, the main sequence's title
card (the PNG still on V2, frames 48–143) is animated: opacity eases in from 0 to 0.9 over clip frames 0–24, scale goes
from 0.8 to 1.1 over frames 0–95 (the last segment eased), and position moves x 40 → -60 with y held at -20 between
frames 12 and 90. The music clip on A2 has a level dip: 0.5 → 0.2 → 0.2 → 0.5 at clip frames 48, 72, 96 and 120 (ease
on the first and third segments). The keyframes are added with the store action, then their values are set on the
clips found with `findClip`. Frames are clip-relative, so the alternate cut and the snapshot, copied from the main
sequence, carry the same lists. Every other clip has no `keyframes` field, and `project-compat.test.ts` checks that
older fixtures open without any.

Time and `Math.random` are fixed, so running the script twice on the same checkout writes the same bytes. Features a
release did not have are left out (for example `proxy.audioStreams` before 0.4.0, OCR tracks before 0.6.0); the
scenario detects them from the checkout's `shared/model.ts` and store.

The files from 0.3.0 to 0.6.0 were made on 7 October 2026 from detached `git worktree`s of the tags `v0.3.0`,
`v0.4.0`, `v0.4.1`, `v0.5.0` and `v0.6.0`, with `node_modules` symlinked from the main checkout (no install). `recut-0.6.1.recut` was made the same day from the 0.6.1 release commit on `main` (f90c419), before its tag existed. `recut-0.7.0.recut` was made by the 0.7.0 release PR, as every later one is.

## Adding the fixture for a new release

The release PR adds `recut-<new version>.recut` ([docs/RELEASING.md](../../../docs/RELEASING.md)):

```bash
node scripts/make-project-fixture.mjs          # this checkout, at the version in package.json
```

The unit suite fails while the fixture for the stable version in `package.json` is missing. A release candidate
(`1.0.0-rc.N`) has no fixture: the script refuses a pre-release version, and the candidates must open the last stable
release's fixture like every other build ([docs/RELEASING.md → Release candidates](../../../docs/RELEASING.md#release-candidates)). When a release adds data
to the project file, extend the scenario first (behind a check that the checkout has the feature) so the new
fixture covers it, and add assertions for it to `tests/unit/project-compat.test.ts`.
