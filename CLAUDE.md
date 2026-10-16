# ReCut — agent working notes

ReCut is an Electron + React + TypeScript non-linear video editor for fan edits. FFmpeg does all media work.

## Layout
- `shared/` — model (`model.ts`), frame math (`time.ts`), pure timeline ops (`timeline.ts`), subtitles, project factories, IPC contract (`ipc.ts`). Shared by main and renderer. **Pure, no DOM, no Node.**
- `electron/` — main process (window, protocol, IPC, project I/O, FFmpeg jobs, export).
- `src/` — renderer (React). `src/state/store.ts` is the single zustand store.
- `tests/unit` — vitest. `tests/e2e` — Playwright driving Electron under xvfb.

## Conventions
- Timeline positions are integer frames at the sequence fps; source positions are seconds.
- Never mutate the project outside store actions. Timeline ops live in `shared/timeline.ts` and are called from store actions inside immer.
- Inside a store recipe, `track.clips` may be a plain array holding frozen originals (see `shared/timeline.ts` write helpers). To modify a clip, get it via `findClip` / `linkedClips` / `clipsWithIds` (they return writable clips); never write through `track.clips[i]` directly.
- Media is streamed via `recut-media://local/<encoded path>` (see `shared/ipc.ts`).
- Do not add npm dependencies without noting it in your report; keep to what is in package.json.
- Run `npm run typecheck` and `npm test` before reporting done.
- Agents own only the files named in their task. Do not edit other files; report needed changes instead.
- Bugs are tracked in GitHub Issues (use the Bug report template). Link the issue from the fix PR (`Fixes #N`). There is no `bugs/` folder any more: comments citing `bugs/closed/<file> @ 59eafc6` refer to old reports, readable with `git show 59eafc6:bugs/closed/<file>`.
- A PR that completes a roadmap entry updates `docs/ROADMAP.md` in the same PR: the entry's **Status** line and its row in the Progress table.
- Every issue branch adds its changelog-draft line (Added / Changed / Fixed / Known issues, linked to the issue) and a QA block (tick-box steps a tester can follow) to `docs/NEXT-RELEASE.md` in the same change. Append to the end of each list; don't reorder or rewrite other entries.
- `CHANGELOG.md` is edited only by release-prep PRs into `rc` (and hotfixes): each one writes the version's section from the draft in `docs/NEXT-RELEASE.md`. Release candidates (`X.Y.Z-rc.N`, which most releases do not have) leave the draft as it is; the stable release's release-prep PR resets it to its empty template, and the reset reaches `dev` from `main` when `main` is merged back.
- Versioning and releases: see docs/RELEASING.md. Feature and bug PRs never change the version.
- Branches (CONTRIBUTING.md "Branches and pull requests"): branch from the personal branch you're working for (`devDavid` or `devJames`), or `dev` if told, and PR back into it. One task per branch, one PR. Never target `main` except when the owner asks (the `rc` → `main` release PR or a hotfix). Don't push to `dev`, `rc`, `main` or the other person's branch. Merge `dev` into your branch before opening a PR into `dev`.
- Release branches: `dev` is the integration branch (contributors, James and agents open PRs into it), `rc` holds the next release (and its release candidates, when it has them: always for a MAJOR release, for a MINOR one only when the owner decides) and `main` released code; only the owner merges into `rc` and `main` (docs/RELEASING.md "Branches and roles").
- Agents never push to `rc` or `main`. Open a PR into `rc` only when the coordinator asks, as `git cherry-pick -x -m 1 <dev PR merge>` picks in dev order or a merge of a `dev` commit, on a `claude/promote-<topic>` branch from `rc` (docs/RELEASING.md "Promoting dev to rc").

## Commands
- `npm run dev` — vite + electron. `npm run build` — build both. `npm run typecheck`, `npm test`, `npm run test:e2e`.
- Headless: `xvfb-run -a npx electron --no-sandbox .`
