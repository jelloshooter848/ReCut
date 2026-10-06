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
- Bugs are filed and closed as Markdown files under `bugs/` (see `bugs/README.md`, copy `bugs/TEMPLATE.md`).
- Versioning and releases: see docs/RELEASING.md. Feature and bug PRs never change the version.

## Commands
- `npm run dev` — vite + electron. `npm run build` — build both. `npm run typecheck`, `npm test`, `npm run test:e2e`.
- Headless: `xvfb-run -a npx electron --no-sandbox .`
