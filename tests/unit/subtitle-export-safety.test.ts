/**
 * Subtitles panel "Export SRT/VTT" must never write over a project source asset (an imported subtitle file, a
 * media file or a proxy), and must replace its target atomically (temp file in the same folder + rename), the
 * same guarantees video export has (tests/unit/export-safety.test.ts).
 *
 * The renderer path is exercised through the real `exportSequenceSubtitles` (the function the panel and
 * `window.__recut.subtitles` call) with `window.recut.writeText` wired straight to the real main-process
 * writer in electron/fs.ts, writing real files under os.tmpdir().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Project, Sequence } from '@shared/model';
import { createMediaItem, createProject, createSequence } from '@shared/project';
import { useStore, resetStore } from '../../src/state/store';
import { exportSequenceSubtitles, writeSequenceSubtitles } from '../../src/panels/subtitles/exportSubtitles';
import { findSamePath, pathCompareKey, resolveAbsolutePath } from '@shared/pathKey';
import { writeText } from '../../electron/fs';

const FPS = { num: 24, den: 1 };
const ORIGINAL_SRT = '1\n00:00:01,000 --> 00:00:02,000\nOriginal imported line\n';
const ORIGINAL_MEDIA = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

let dir: string;
let subtitleFile: string;
let mediaFile: string;
let proxyFile: string;
let writes: string[];

function fixture(): { project: Project; seq: Sequence } {
  const project = createProject('Subtitle safety');
  const media = { ...createMediaItem(mediaFile, 'clip.mp4'), id: 'm-clip', kind: 'video' as const };
  media.proxy = { path: proxyFile, status: 'ready' };
  project.media[media.id] = media;
  project.subtitleTracks['st-imported'] = {
    id: 'st-imported', name: 'Imported', language: 'en', path: subtitleFile, mediaId: media.id, cues: [], origin: 'srt',
  };
  const seq = createSequence('Edit', FPS, 320, 240);
  seq.subtitleTracks.push({
    id: 'sst-1', name: 'Subtitles', language: 'en', enabled: true,
    cues: [{ id: 'c1', start: 24, duration: 24, offset: 0, text: 'Exported line' }],
  });
  project.sequences = { [seq.id]: seq };
  project.activeSequenceId = seq.id;
  return { project, seq };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-subtitle-export-safety-'));
  subtitleFile = path.join(dir, 'imported.en.srt');
  mediaFile = path.join(dir, 'clip.mp4');
  proxyFile = path.join(dir, 'clip.proxy.mp4');
  fs.writeFileSync(subtitleFile, ORIGINAL_SRT);
  fs.writeFileSync(mediaFile, ORIGINAL_MEDIA);
  fs.writeFileSync(proxyFile, ORIGINAL_MEDIA);
  writes = [];
  resetStore();
  useStore.setState({ project: fixture().project });
  // The preload bridge, wired to the real main-process writer.
  vi.stubGlobal('window', {
    recut: {
      writeText: async (p: string, content: string) => { writes.push(p); await writeText(p, content); },
      appInfo: async () => ({ platform: process.platform }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('exportSequenceSubtitles refuses project source files', () => {
  it('refuses the path of an imported subtitle track and leaves its bytes unchanged', async () => {
    const res = await exportSequenceSubtitles({ path: subtitleFile });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/Refusing to export subtitles to ".*imported\.en\.srt": that file is a source file of the project/);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(subtitleFile, 'utf8')).toBe(ORIGINAL_SRT);
  });

  it('refuses a project media path (format forced to VTT) and leaves its bytes unchanged', async () => {
    const res = await exportSequenceSubtitles({ path: mediaFile, format: 'vtt' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/source file of the project/);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(mediaFile).equals(ORIGINAL_MEDIA)).toBe(true);
  });

  it('refuses a proxy path', async () => {
    const res = await exportSequenceSubtitles({ path: proxyFile });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(proxyFile).equals(ORIGINAL_MEDIA)).toBe(true);
  });

  it('refuses a non-normalized spelling of a source path (./, .., doubled separators)', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    const sneaky = `${dir}${path.sep}.${path.sep}sub${path.sep}..${path.sep}${path.sep}imported.en.srt`;
    const res = await exportSequenceSubtitles({ path: sneaky });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/source file of the project/);
    expect(writes).toEqual([]);
    expect(fs.readFileSync(subtitleFile, 'utf8')).toBe(ORIGINAL_SRT);
  });

  it('a normal export still writes the sequence subtitles', async () => {
    const out = path.join(dir, 'Edit.srt');
    const res = await exportSequenceSubtitles({ path: out });
    expect(res).toEqual({ ok: true, path: out, count: 1 });
    expect(fs.readFileSync(out, 'utf8')).toBe('1\n00:00:01,000 --> 00:00:02,000\nExported line\n');
    expect(fs.readdirSync(dir).sort()).toEqual(['Edit.srt', 'clip.mp4', 'clip.proxy.mp4', 'imported.en.srt']);
  });
});

describe('electron/fs writeText is atomic', () => {
  it('replaces an existing file via a temp file in the same folder + rename, leaving no temp behind', async () => {
    const out = path.join(dir, 'out.srt');
    fs.writeFileSync(out, 'old contents that are longer than the new ones\n');
    const inodeBefore = fs.statSync(out).ino;
    const rename = vi.spyOn(fsp, 'rename');
    await writeText(out, 'new\n');
    expect(fs.readFileSync(out, 'utf8')).toBe('new\n');
    // Replaced, not truncated and rewritten in place.
    expect(fs.statSync(out).ino).not.toBe(inodeBefore);
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0] as [string, string];
    expect(to).toBe(out);
    expect(path.dirname(from)).toBe(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(['clip.mp4', 'clip.proxy.mp4', 'imported.en.srt', 'out.srt']);
  });

  it('a failed replace leaves the target untouched and no temp file behind', async () => {
    const target = path.join(dir, 'busy');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    await expect(writeText(target, 'x')).rejects.toThrow();
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.readdirSync(dir).sort()).toEqual(['busy', 'clip.mp4', 'clip.proxy.mp4', 'imported.en.srt']);
  });

  it('creates missing parent folders', async () => {
    const out = path.join(dir, 'a', 'b', 'c.vtt');
    await writeText(out, 'WEBVTT\n');
    expect(fs.readFileSync(out, 'utf8')).toBe('WEBVTT\n');
    expect(fs.readdirSync(path.dirname(out))).toEqual(['c.vtt']);
  });
});

describe('writeSequenceSubtitles (pure, injected writer)', () => {
  const posixProject = (): Project => {
    const project = createProject('P');
    project.media.m = { ...createMediaItem('/media/Show/clip.mp4', 'clip.mp4'), id: 'm' };
    project.subtitleTracks.st = { id: 'st', name: 'Imp', language: 'en', path: '/media/Show/clip.en.srt', mediaId: 'm', cues: [], origin: 'srt' };
    const seq = createSequence('Edit', FPS);
    project.sequences = { [seq.id]: seq };
    project.activeSequenceId = seq.id;
    return project;
  };
  const winProject = (): Project => {
    const project = posixProject();
    project.media.m.path = 'C:\\Media\\Show\\clip.mp4';
    project.subtitleTracks.st.path = 'C:\\Media\\Show\\clip.en.srt';
    return project;
  };

  async function attempt(project: Project, target: string, platform: string | undefined) {
    const written: string[] = [];
    const res = await writeSequenceSubtitles(project, { path: target }, { platform, writeText: async (p) => { written.push(p); } });
    return { res, written };
  }

  it('folds case and separators on win32 and darwin, not on linux', async () => {
    expect((await attempt(winProject(), 'c:/media/show/CLIP.EN.SRT', 'win32')).written).toEqual([]);
    expect((await attempt(posixProject(), '/MEDIA/show/Clip.En.Srt', 'darwin')).written).toEqual([]);
    expect((await attempt(posixProject(), '/MEDIA/show/Clip.En.Srt', undefined)).written).toEqual([]);
    expect((await attempt(posixProject(), '/MEDIA/show/Clip.En.Srt', 'linux')).written).toEqual(['/MEDIA/show/Clip.En.Srt']);
    expect((await attempt(posixProject(), '/media/Show/clip.en.srt', 'linux')).res.ok).toBe(false);
    expect((await attempt(posixProject(), '/media/Show/../Show/./clip.mp4', 'linux')).res.ok).toBe(false);
  });

  it('refuses relative and drive-relative targets (they resolve against the main process cwd)', async () => {
    for (const [target, platform] of [['clip.en.srt', 'linux'], ['./out.srt', 'linux'], ['C:out.srt', 'win32'], ['\\out.srt', 'win32']] as const) {
      const { res, written } = await attempt(posixProject(), target, platform);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error).toMatch(/needs a full file path/);
      expect(written).toEqual([]);
    }
  });

  it('a write error is reported, not thrown', async () => {
    const res = await writeSequenceSubtitles(posixProject(), { path: '/out/x.srt' }, { platform: 'linux', writeText: async () => { throw new Error('EACCES: permission denied'); } });
    expect(res).toEqual({ ok: false, error: 'EACCES: permission denied' });
  });
});

describe('shared/pathKey matches path.resolve for absolute paths', () => {
  it('posix', () => {
    for (const p of ['/', '/a/b', '/a//b/', '/a/./b/../c', '/../a', '/a/b/..', '/a/b/../../..', '/a\\b']) {
      expect(resolveAbsolutePath(p, 'linux')).toBe(path.posix.resolve(p));
    }
  });
  it('win32', () => {
    for (const p of ['C:\\', 'C:/', 'C:\\a\\b', 'c:/a//b/', 'C:\\a\\.\\b\\..\\c', 'C:\\..\\a', '\\\\srv\\share\\a\\..\\b', '//srv/share/x/']) {
      expect(resolveAbsolutePath(p, 'win32')).toBe(path.win32.resolve(p));
    }
  });
  it('keys and lookups', () => {
    expect(pathCompareKey('C:\\A\\B.srt', 'win32')).toBe('c:\\a\\b.srt');
    expect(pathCompareKey('/A/B.srt', 'linux')).toBe('/A/B.srt');
    expect(pathCompareKey('rel/b.srt', 'linux')).toBeNull();
    expect(findSamePath('/a/b', ['rel', '/a/c', '/a/./b'], 'linux')).toBe('/a/./b');
    expect(findSamePath('rel', ['rel'], 'linux')).toBeUndefined();
  });
});
