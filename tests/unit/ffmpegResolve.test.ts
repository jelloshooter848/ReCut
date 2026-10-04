import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFfmpegPath, getFfprobePath, resetFfmpegPaths } from '../../electron/media/ffmpeg';
import { resolveFfmpegPath } from '../../electron/export/exporter';
import { resolveFfmpeg } from '../../electron/ipc';
import { ffmpegMissingMessage } from '../../shared/ipc';

const proc = process as unknown as { resourcesPath?: string };
const saved = { env: { ...process.env }, resourcesPath: proc.resourcesPath };

function fakeBin(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
  return p;
}

afterEach(() => {
  process.env = { ...saved.env };
  proc.resourcesPath = saved.resourcesPath;
  resetFfmpegPaths();
});

describe('one ffmpeg resolver for the whole app', () => {
  it('finds bundled binaries in <resourcesPath>/ffmpeg, and export + AppInfo agree with the media layer', () => {
    const res = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-res-'));
    const ff = fakeBin(path.join(res, 'ffmpeg'), 'ffmpeg');
    const fp = fakeBin(path.join(res, 'ffmpeg'), 'ffprobe');
    delete process.env.RECUT_FFMPEG; delete process.env.RECUT_FFMPEG_PATH;
    delete process.env.RECUT_FFPROBE; delete process.env.RECUT_FFPROBE_PATH;
    proc.resourcesPath = res;
    resetFfmpegPaths();
    expect(getFfmpegPath()).toBe(ff);
    expect(getFfprobePath()).toBe(fp);
    expect(resolveFfmpegPath()).toBe(ff);
    expect(resolveFfmpeg()).toEqual({ ffmpegPath: ff, ffprobePath: fp });
  });

  it('export honours RECUT_FFMPEG_PATH (not only RECUT_FFMPEG)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-env-'));
    const ff = fakeBin(dir, 'my-ffmpeg');
    delete process.env.RECUT_FFMPEG;
    process.env.RECUT_FFMPEG_PATH = ff;
    resetFfmpegPaths();
    expect(resolveFfmpegPath()).toBe(ff);
  });

  it('the missing-binary message says how to fix it', () => {
    const msg = ffmpegMissingMessage('ffprobe');
    expect(msg).toMatch(/ffprobe was not found/);
    expect(msg).toMatch(/RECUT_FFMPEG/);
    expect(msg).toMatch(/RECUT_FFPROBE/);
    expect(msg).toMatch(/INSTALL\.md/);
  });
});
