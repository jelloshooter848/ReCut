/**
 * Licence files shipped with the packaged app, for Help › About › Licences.
 *
 * The renderer never passes a path: it asks for the list (ids + labels of the files that exist) and opens one by id.
 * Main maps the id to a fixed file name in a fixed set of directories, so nothing outside this table can be opened.
 *
 * Where electron-builder puts them (package.json → build):
 *  - `<resources>/LICENSE`, `<resources>/THIRD_PARTY_NOTICES.md` (extraResources)
 *  - `<resources>/ffmpeg/FFMPEG-*.txt` (extraResources `resources/ffmpeg`, written by scripts/windows/get-ffmpeg.ps1)
 *  - `LICENSE.electron.txt`, `LICENSES.chromium.html` next to the executable (added by electron-builder itself)
 * In development the repository root (working directory / app path) stands in for `<resources>`.
 *
 * No `electron` import, so the resolution is unit-testable; electron/ipc.ts supplies the directories.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LicenceFile, LicenceFileId } from '../shared/ipc';

type Where = 'app' | 'ffmpeg' | 'exe';

interface LicenceDef { id: LicenceFileId; label: string; fileName: string; where: Where }

/** Every file the About dialog may open, in display order. */
export const LICENCE_FILES: readonly LicenceDef[] = Object.freeze([
  { id: 'recut', label: 'ReCut licence (MIT)', fileName: 'LICENSE', where: 'app' },
  { id: 'notices', label: 'Third-party notices', fileName: 'THIRD_PARTY_NOTICES.md', where: 'app' },
  { id: 'ffmpegBuild', label: 'FFmpeg build and source', fileName: 'FFMPEG-BUILD.txt', where: 'ffmpeg' },
  { id: 'ffmpegLicense', label: 'FFmpeg licence', fileName: 'FFMPEG-LICENSE.txt', where: 'ffmpeg' },
  { id: 'ffmpegReadme', label: 'FFmpeg readme', fileName: 'FFMPEG-README.txt', where: 'ffmpeg' },
  { id: 'electron', label: 'Electron licence', fileName: 'LICENSE.electron.txt', where: 'exe' },
  { id: 'chromium', label: 'Chromium licences', fileName: 'LICENSES.chromium.html', where: 'exe' },
].map((d) => Object.freeze(d as LicenceDef)));

/** Directories searched, in order, for each kind of file. */
export interface LicenceDirs { app: string[]; ffmpeg: string[]; exe: string[] }

/**
 * The search directories for this process. Packaged: `process.resourcesPath` and the executable's folder only.
 * Development (`packaged: false`): also the app path and the working directory (the repository root).
 */
export function licenceDirs(env: { packaged: boolean; resourcesPath?: string; appPath?: string; execPath: string; cwd: string }): LicenceDirs {
  const app: string[] = [];
  const ffmpeg: string[] = [];
  if (env.resourcesPath) { app.push(env.resourcesPath); ffmpeg.push(path.join(env.resourcesPath, 'ffmpeg')); }
  if (!env.packaged) {
    for (const root of [env.appPath, env.cwd]) {
      if (!root || /\.asar$/i.test(root)) continue;
      app.push(root);
      ffmpeg.push(path.join(root, 'resources', 'ffmpeg'));
    }
  }
  return { app: unique(app), ffmpeg: unique(ffmpeg), exe: unique([path.dirname(env.execPath)]) };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.map((x) => path.resolve(x)))];
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function defFor(id: unknown): LicenceDef | undefined {
  return typeof id === 'string' ? LICENCE_FILES.find((d) => d.id === id) : undefined;
}

/**
 * Absolute path of licence file `id`, or null when `id` is not one of LICENCE_FILES or the file is not present.
 * Only ever returns `<one of dirs[where]>/<fixed file name>`.
 */
export function resolveLicenceFile(id: unknown, dirs: LicenceDirs, exists: (p: string) => boolean = isFile): string | null {
  const def = defFor(id);
  if (!def) return null;
  for (const dir of dirs[def.where]) {
    const p = path.join(dir, def.fileName);
    if (exists(p)) return p;
  }
  return null;
}

/** The licence files present, in display order. */
export function listLicenceFiles(dirs: LicenceDirs, exists: (p: string) => boolean = isFile): LicenceFile[] {
  return LICENCE_FILES
    .filter((d) => resolveLicenceFile(d.id, dirs, exists) !== null)
    .map((d) => ({ id: d.id, label: d.label, fileName: d.fileName }));
}
