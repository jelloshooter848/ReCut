# Contributing to ReCut

Thanks for your interest in ReCut, a desktop video editor for fan edits built with Electron, React and TypeScript,
with FFmpeg doing all media work. Bug reports, testing on your platform, documentation fixes and code are all
welcome.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

- **Questions and ideas:** [GitHub Discussions](https://github.com/jelloshooter848/ReCut/discussions).
- **Bugs and feature requests:** [GitHub Issues](https://github.com/jelloshooter848/ReCut/issues/new/choose), using
  the forms.
- **A first contribution:** issues labelled
  [good first issue](https://github.com/jelloshooter848/ReCut/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  are small and self-contained, and each says which files to look at and how to test it. Comment on the issue before
  you start so two people don't work on the same thing.

**Never attach or link copyrighted footage** in issues, pull requests or discussions, not even a short clip. If a bug
needs media, reproduce it with the synthetic test media (`scripts/make-test-media.sh`) or a file you made yourself,
and paste `ffprobe` output for the original file instead.

## Development setup

You need **Node.js 20 or 22** (developed on 22). For speech-to-text you also need **cmake** and a C++ compiler
(macOS: Xcode command line tools and `brew install cmake`; Linux: `cmake` and `g++`; Windows: Visual Studio with the C++
workload).

`npm run dev` and `npm start` first run `scripts/setup-dev.mjs` (also `npm run setup`), which gets what the release
builds bundle when it is missing:
- **FFmpeg** into `resources/ffmpeg/` (`scripts/<os>/get-ffmpeg.*`), unless `ffmpeg` and `ffprobe` are on `PATH` or
  `RECUT_FFMPEG` is set. [docs/INSTALL.md](docs/INSTALL.md#prerequisites) explains the FFmpeg requirements.
- **The speech-to-text engine** (whisper.cpp) compiled into `resources/whisper/` (`scripts/<os>/get-whisper.*`), a few
  minutes the first time. Without cmake it is skipped with a note; ReCut then says the engine is not included and the
  engine tests are skipped.

Both folders are git-ignored, and later runs skip whatever is already there. Set `RECUT_SKIP_SETUP=1` to skip setup.

```bash
git clone https://github.com/jelloshooter848/ReCut.git
cd ReCut
npm install
npm run dev                                  # Vite dev server + Electron; the renderer hot-reloads
```

`npm run dev` does not reload the main process: restart it after changing anything under `electron/`. `npm start`
makes a production build and launches it.

To try things without your own media, generate synthetic, copyright-free test files (needs FFmpeg):

```bash
scripts/make-test-media.sh ./test-media      # add "short" for 4 s scenes
```

For isolated runs (so you don't touch your own preferences or cache), set `RECUT_USER_DATA` and `RECUT_CACHE_DIR` to
temporary folders.

### Where things are

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before your first code change, and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full repository layout, scripts and test suites. In short:

- `shared/`: pure TypeScript shared by both processes (data model, frame math, timeline operations, subtitles, the
  IPC contract in `shared/ipc.ts`). **No DOM, no Node.**
- `electron/`: the main process (window, menus, project I/O, FFmpeg jobs, export).
- `src/`: the React renderer. `src/state/store.ts` is the single zustand + immer store.
- `tests/unit` (Vitest) and `tests/e2e` (Playwright driving the built app); more suites are listed in
  DEVELOPMENT.

## Tests and checks

Run these before you open a pull request, and say in the PR what you ran:

```bash
npm run typecheck                            # tsc for the renderer/shared and the electron projects
npm test                                     # Vitest over tests/unit; some tests run real FFmpeg
```

If you changed the UI or anything end-to-end, also run the end-to-end suite. `npm run test:e2e` builds the app and
runs Playwright over `tests/e2e`; it needs a display:

```bash
npm run test:e2e                             # Windows, macOS, or Linux with a desktop session
xvfb-run -a npm run test:e2e                 # Linux without a display (install xvfb)
```

To run a single spec after a build: `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/<name>.spec.ts`
(drop `xvfb-run -a` where you have a display). See [tests/e2e/README.md](tests/e2e/README.md).

The media attack suite, the QA repro suite, the acceptance gauntlet and the performance gate (`npm run perf:check`,
about 25 minutes on a quiet machine) are described in [DEVELOPMENT › Test suites](docs/DEVELOPMENT.md#test-suites).
You don't need them for most changes; a maintainer will ask if a change could affect them.

CI (`.github/workflows/windows.yml`) runs on every push to `main` or `dev` and on every pull request into `dev`,
`devDavid` or `devJames` that changes more than Markdown and `docs/`: it typechecks, runs the unit and end-to-end
suites on Windows, macOS and Linux, and builds and smoke-tests the Windows installer, the Linux AppImage and both macOS
dmgs. A pull request run is a test build: it never publishes anything. A new push to the pull request's branch
cancels the older run. It takes a while, so run the checks locally first; a maintainer can also start it by hand on a
branch.

## Code conventions

These matter more than style, and reviewers will ask about them. The full list is in
[DEVELOPMENT › Conventions](docs/DEVELOPMENT.md#conventions).

- **Frames vs seconds.** Timeline positions and durations are integer frames at the sequence's frame rate. Source
  positions (`clip.sourceIn`, scene bounds, cues) are seconds. Convert only with `shared/time.ts`.
- **Change the project only in store actions.** Timeline operations are pure functions in `shared/timeline.ts`,
  called from store actions inside immer recipes. Inside a recipe, get a writable clip with `findClip`, `linkedClips`
  or `clipsWithIds`; never write through `track.clips[i]` directly.
- **Undoable vs quiet writes.** `commit(label, recipe)` makes an undo step; `quiet(recipe)` does not and is for
  background status (probe results, proxy status, offline flags). View state (playhead, zoom, scroll, In/Out) is
  never undoable.
- **Commands** have ids in `src/keyboard/commandIds.ts` and default keys in `DEFAULT_BINDINGS`
  (`src/keyboard/shortcuts.ts`). A new or changed shortcut also goes in [docs/SHORTCUTS.md](docs/SHORTCUTS.md).
- **No new npm dependencies** without saying so in the PR, and why.
- **Project files:** a change to saved data bumps `formatVersion` and migrates old files in `normalizeProject()`
  (`shared/project.ts`); every saved-project fixture in `tests/fixtures/projects/` must keep opening. See
  [docs/project-format.md](docs/project-format.md).

## Branches and pull requests

| Branch | What it holds | Who writes to it |
|---|---|---|
| `main` | Released code only: it moves only when a release or a hotfix is merged. | The owner merges PRs from `dev` (releases) and hotfix PRs. |
| `dev` | The shared integration branch: everything that is finished and reviewed. | The owner merges PRs into it. Nobody pushes to it. |
| `devDavid`, `devJames` | Each person's long-lived branch: David's (the owner) and James's. | Their owner, through PRs from task branches. |
| task branches (`fix-…`, `claude/…`) | One task: one fix, or one slice of a feature. | Whoever does the task. |

The flow:

1. **Start every session by merging `dev` into your personal branch** (`git fetch origin`, then
   `git merge origin/dev` on `devDavid` or `devJames`).
2. **Branch each task from your personal branch** and open its PR back into your personal branch. Use a short
   descriptive name, for example `fix-collect-fat32-message`. Agents work the same way, on `claude/…` branches: one
   task per branch and one PR, never several tasks stacked on one branch.
3. **Open a PR from your personal branch into `dev` every 1–2 days, or as soon as one change is finished.** One change
   per PR (a fix, or one slice of a feature), small enough to review. The point is to find conflicts with the other
   person's work within a day or two, not after a week. Before opening it, merge `dev` into your branch again and get
   CI green.
4. **Large features go in slices.** Each slice is its own PR into `dev`; a slice that leaves the feature half-done
   goes behind a setting, so `dev` always works.
5. **Releases** are a release-prep PR into `dev`, then one PR from `dev` into `main`; a **hotfix** branches from `main`
   and PRs into `main`, and `main` is then merged into `dev`. See [docs/RELEASING.md](docs/RELEASING.md).

Only the owner merges into `dev` and `main`. James and his bot push only to `devJames` and their own task branches,
and open PRs. Nobody pushes to `dev` or `main` directly, and nobody pushes to another person's branch.

A daily overlap check (run by the owner's coordinating session) test-merges `dev`, `devDavid`, `devJames` and the open
PR branches and reports where they touch the same code.

**Outside contributors:** fork the repository, branch from `dev`, and open the PR against `dev`. Never target `main`.

Before you open a PR into `dev`, check:

- [ ] `dev` is merged into your branch, and CI on the PR is green (`npm run typecheck` and `npm test` locally first).
- [ ] The PR is **one change**: one fix or one feature slice, small enough to review in one sitting. A half-done
      feature is behind a setting.
- [ ] It says **what** and **why**, how you tested it (commands and results), and links the issue it closes
      (`Closes #123`).
- [ ] A bug fix comes with a **regression test** that fails before the fix. Never weaken, skip or delete an existing
      test to get green; if an assertion encoded the bug, change it and say so.
- [ ] The docs your change affects are updated: the [User Guide](docs/USER-GUIDE.md), [FORMATS](docs/FORMATS.md),
      [SHORTCUTS](docs/SHORTCUTS.md), and [LIMITATIONS](docs/LIMITATIONS.md) (remove an item your change fixes, add
      one for a new limitation).
- [ ] If it completes a [Roadmap](docs/ROADMAP.md) entry, it updates [docs/ROADMAP.md](docs/ROADMAP.md): the entry's
      **Status** line and its row in the Progress table.
- [ ] It does **not** change the version. Feature and bug PRs never touch `version` in `package.json` or
      `package-lock.json`; only a release-prep PR changes it ([docs/RELEASING.md](docs/RELEASING.md)).

### The changelog

Don't edit [CHANGELOG.md](CHANGELOG.md) in a feature or bug PR. Each release PR adds the new version's section,
written from the merged changes since the previous release and from the bug issues closed since then
([RELEASING › What goes in the changelog](docs/RELEASING.md#what-goes-in-the-changelog)). Help it by giving your PR a
title and description that say what a user will notice, and by linking the issue it fixes (`Fixes #N`).

## Reporting bugs

Open an issue with the [bug report form](https://github.com/jelloshooter848/ReCut/issues/new?template=bug_report.yml).
Please search [existing issues](https://github.com/jelloshooter848/ReCut/issues) first. A fixable report has:

- **The ReCut version:** **Help › About ReCut** (it also shows the FFmpeg version and path). If you run from source,
  the commit (`git rev-parse --short HEAD`).
- **Your OS and its version**, and the FFmpeg version if media is involved.
- **Steps someone else can follow.** "Sometimes" isn't a repro; say how often and under what conditions.
- **Expected and actual behaviour**, with exact error text and values. Keep what you observed separate from what you
  think the cause is.
- **Error output.** ReCut does not write log files. Instead, paste:
  - the full error of a failed job from the **Jobs** panel (click the error line to expand it; the text can be
    selected and copied);
  - the text of any error dialog or notification;
  - errors from the developer console (**View › Toggle Developer Tools**, Console tab), if any appear;
  - the terminal output, if you started ReCut from a terminal (for example `npm run dev`, or the AppImage).

Where ReCut keeps preferences, autosaves and its cache on each OS is listed in
[INSTALL › Where data lives](docs/INSTALL.md#where-data-lives).

All bugs are tracked in GitHub Issues. Older reports, from before the project moved to Issues, are kept as a
read-only archive in [`bugs/closed/`](bugs/closed/), which code comments link to; don't add files there.

**Security problems:** please don't describe a vulnerability in a public issue.
<!-- OWNER: say how to report a vulnerability privately (GitHub private vulnerability reporting is currently off for this repository, or give a contact), then remove this comment. -->
[Private reporting channel to be added.]

## How ReCut is built, and AI-assisted contributions

ReCut is directed by one person, the repository owner, and much of its code, tests and documentation was written by
AI coding agents (Claude, via Claude Code) working on tasks the owner defines. The owner decides what gets built and
in what order; the [Roadmap](docs/ROADMAP.md) records those decisions.

<!-- OWNER: describe how you review changes -->
Changes reach `dev`, and from there `main`, through pull requests that the owner merges. CI runs the unit and
end-to-end suites on Windows, macOS and Linux.

Because of how it is built, ReCut leans on automated checks: release builds are installed or launched and
smoke-tested on all three systems before anything is published, media "attack" suites measure exported frames and
audio sync with real FFmpeg, saved projects from every release since 0.3.0 are reopened by the unit suite, and the
bug process requires a test that fails before each fix. What doesn't work is listed in
[LIMITATIONS](docs/LIMITATIONS.md).

Contributions from people, with or without AI tools, are welcome on the same terms: you are responsible for the
change, you have read and understood it, it follows the conventions above and it comes with tests. Say in the PR if
a tool wrote a substantial part of it.

## Licence

ReCut is released under the [MIT License](LICENSE). Contributions are accepted under the same licence.
