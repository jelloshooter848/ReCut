import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LICENCE_FILES, licenceDirs, listLicenceFiles, resolveLicenceFile } from '../../electron/licences';

// bugs/closed/2026-10-07-bundled-ffmpeg-licence-not-shipped.md: releases must ship ReCut's LICENSE, the third-party
// notices and the bundled FFmpeg's licence / build files, and Help › About › Licences opens them by id only.

const repo = fileURLToPath(new URL('../..', import.meta.url));

function fakeInstall(): { dirs: ReturnType<typeof licenceDirs>; root: string; resources: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-lic-'));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(path.join(resources, 'ffmpeg'), { recursive: true });
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.writeFileSync(path.join(resources, f), f);
  for (const f of ['FFMPEG-LICENSE.txt', 'FFMPEG-BUILD.txt', 'ffmpeg.exe']) fs.writeFileSync(path.join(resources, 'ffmpeg', f), f);
  for (const f of ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'secret.txt']) fs.writeFileSync(path.join(root, f), f);
  const dirs = licenceDirs({ packaged: true, resourcesPath: resources, appPath: path.join(resources, 'app.asar'), execPath: path.join(root, 'ReCut.exe'), cwd: os.tmpdir() });
  return { dirs, root, resources };
}

describe('licence files (Help › About › Licences)', () => {
  it('resolves each known id to its fixed file in the packaged layout', () => {
    const { dirs, root, resources } = fakeInstall();
    expect(resolveLicenceFile('recut', dirs)).toBe(path.join(resources, 'LICENSE'));
    expect(resolveLicenceFile('notices', dirs)).toBe(path.join(resources, 'THIRD_PARTY_NOTICES.md'));
    expect(resolveLicenceFile('ffmpegLicense', dirs)).toBe(path.join(resources, 'ffmpeg', 'FFMPEG-LICENSE.txt'));
    expect(resolveLicenceFile('ffmpegBuild', dirs)).toBe(path.join(resources, 'ffmpeg', 'FFMPEG-BUILD.txt'));
    expect(resolveLicenceFile('electron', dirs)).toBe(path.join(root, 'LICENSE.electron.txt'));
    expect(resolveLicenceFile('chromium', dirs)).toBe(path.join(root, 'LICENSES.chromium.html'));
    // Not in this build (no readme in the archive): absent, not an error.
    expect(resolveLicenceFile('ffmpegReadme', dirs)).toBeNull();
    expect(listLicenceFiles(dirs).map((f) => f.id)).toEqual(['recut', 'notices', 'ffmpegBuild', 'ffmpegLicense', 'electron', 'chromium']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses anything that is not a known id: paths, file names, prototype keys, non-strings', () => {
    const { dirs, root } = fakeInstall();
    const hostile: unknown[] = [
      '../secret.txt', 'secret.txt', path.join(root, 'secret.txt'), 'LICENSE', 'ffmpeg.exe', 'FFMPEG-LICENSE.txt',
      '__proto__', 'constructor', 'toString', '', 'RECUT', ' recut', 'recut/../..', null, undefined, 1, {}, ['recut'],
      { id: 'recut' },
    ];
    for (const id of hostile) expect(resolveLicenceFile(id, dirs), String(id)).toBeNull();
    // Every path it can ever return is <search dir>/<fixed name>.
    const allowed = new Set(LICENCE_FILES.flatMap((d) => [...dirs.app, ...dirs.ffmpeg, ...dirs.exe].map((dir) => path.join(dir, d.fileName))));
    for (const d of LICENCE_FILES) {
      const p = resolveLicenceFile(d.id, dirs, () => true);
      expect(p && allowed.has(p)).toBe(true);
      expect(path.basename(p!)).toBe(d.fileName);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('packaged: never looks in the working directory or the app path', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-lic-cwd-'));
    fs.writeFileSync(path.join(cwd, 'LICENSE'), 'someone else\'s licence');
    const dirs = licenceDirs({ packaged: true, resourcesPath: path.join(cwd, 'nothing-here'), appPath: cwd, execPath: path.join(cwd, 'x', 'ReCut.exe'), cwd });
    expect(resolveLicenceFile('recut', dirs)).toBeNull();
    // Development: the repository root (working directory) stands in for <resources>.
    const dev = licenceDirs({ packaged: false, appPath: cwd, execPath: path.join(cwd, 'x', 'electron'), cwd });
    expect(resolveLicenceFile('recut', dev)).toBe(path.join(cwd, 'LICENSE'));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('licence files in the repository and the package config', () => {
  it('LICENSE is MIT, as package.json says', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    expect(pkg.license).toBe('MIT');
    expect(fs.readFileSync(path.join(repo, 'LICENSE'), 'utf8')).toMatch(/^MIT License\s+Copyright \(c\) \d{4} ReCut contributors/);
  });

  it('electron-builder ships LICENSE, THIRD_PARTY_NOTICES.md and everything in resources/ffmpeg', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    const extra = pkg.build.extraResources as { from: string; to: string; filter?: string[] }[];
    expect(extra).toEqual(expect.arrayContaining([
      { from: 'LICENSE', to: 'LICENSE' },
      { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
      { from: 'resources/ffmpeg', to: 'ffmpeg', filter: ['**/*'] },
    ]));
    for (const e of extra) if (e.from !== 'resources/ffmpeg') expect(fs.existsSync(path.join(repo, e.from)), e.from).toBe(true);
  });

  it('get-ffmpeg.ps1 writes the licence, readme and build files that About and the notices point to', () => {
    const ps = fs.readFileSync(path.join(repo, 'scripts/windows/get-ffmpeg.ps1'), 'utf8');
    for (const f of ['FFMPEG-LICENSE.txt', 'FFMPEG-README.txt', 'FFMPEG-BUILD.txt']) {
      expect(ps).toContain(`'${f}'`);
      expect(LICENCE_FILES.some((d) => d.fileName === f)).toBe(true);
    }
  });

  it('THIRD_PARTY_NOTICES.md lists the current runtime npm packages (node scripts/third-party-notices.mjs --check)', () => {
    const out = execFileSync(process.execPath, [path.join(repo, 'scripts/third-party-notices.mjs'), '--check'], { encoding: 'utf8' });
    expect(out).toContain('up to date');
    const notices = fs.readFileSync(path.join(repo, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies)) expect(notices).toContain(`| ${dep} |`);
    expect(notices).toMatch(/GPL-3\.0-or-later/);
    expect(notices).toContain('LICENSES.chromium.html');
  });
});
