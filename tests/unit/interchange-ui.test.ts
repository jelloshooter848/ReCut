/**
 * File › Export Timeline… (Roadmap §10), the parts around the format writers: the dialog's pure helpers (default
 * name, where each file goes, issue groups; src/panels/interchange/interchangeFiles.ts) and the main-process writer
 * (electron/interchange.ts): only .fcpxml / .otio / .edl plain names, never over a project source or a non-file,
 * existing files only with `overwrite`, atomic writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultTimelineFileName, groupIssues, interchangeTargets, splitPickedPath } from '../../src/panels/interchange/interchangeFiles';
import { writeInterchangeFiles } from '../../electron/interchange';
import { IPC } from '@shared/ipc';
import type { InterchangeIssue } from '@shared/interchange';

const f = (name: string, contents = 'x') => ({ name, contents });

describe('Export Timeline: file names', () => {
  it('offers the sequence name made safe, with the format extension', () => {
    expect(defaultTimelineFileName('Saga: Fan Cut', 'fcpxml')).toBe('Saga_ Fan Cut.fcpxml');
    expect(defaultTimelineFileName('  ', 'otio')).toBe('Timeline.otio');
  });

  it('splits picked paths on / and \\ and keeps a root folder', () => {
    expect(splitPickedPath('/home/me/Cut.edl')).toEqual({ folder: '/home/me', name: 'Cut.edl' });
    expect(splitPickedPath('/Cut.edl')).toEqual({ folder: '/', name: 'Cut.edl' });
    expect(splitPickedPath('C:\\Edits\\Cut.edl')).toEqual({ folder: 'C:\\Edits', name: 'Cut.edl' });
    expect(splitPickedPath('C:\\Cut.edl')).toEqual({ folder: 'C:\\', name: 'Cut.edl' });
  });

  it('one file: the picked name, with the extension added when it was left out', () => {
    expect(interchangeTargets('/out/My Cut.fcpxml', [f('Seq.fcpxml')], 'fcpxml')).toEqual({ folder: '/out', names: ['My Cut.fcpxml'] });
    expect(interchangeTargets('/out/My Cut', [f('Seq.otio')], 'otio')).toEqual({ folder: '/out', names: ['My Cut.otio'] });
  });

  it('several EDLs: the picked name is the base, each file keeps what tells it apart', () => {
    const files = [f('Saga Cut_V1.edl'), f('Saga Cut_V2.edl'), f('Saga Cut_V3.edl')];
    expect(interchangeTargets('/out/Final.edl', files, 'edl').names).toEqual(['Final_V1.edl', 'Final_V2.edl', 'Final_V3.edl']);
    expect(interchangeTargets('/out/Final', files, 'edl').names).toEqual(['Final_V1.edl', 'Final_V2.edl', 'Final_V3.edl']);
    // Names with no shared stem still get a separator; names that do not differ are numbered.
    expect(interchangeTargets('/out/Final.edl', [f('V1.edl'), f('V2.edl')], 'edl').names).toEqual(['Final_V1.edl', 'Final_V2.edl']);
    expect(interchangeTargets('/out/Final.edl', [f('Cut - V1.edl'), f('Cut - V10.edl')], 'edl').names).toEqual(['Final - V1.edl', 'Final - V10.edl']);
    expect(interchangeTargets('/out/Final.edl', [f('a.edl'), f('a.edl')], 'edl').names).toEqual(['Final_1.edl', 'Final_2.edl']);
  });
});

describe('Export Timeline: issue groups', () => {
  const issue = (kind: InterchangeIssue['kind'], severity: InterchangeIssue['severity']): InterchangeIssue => ({ kind, severity, message: kind, count: 1 });
  it('warnings first, then info, empty groups left out', () => {
    const g = groupIssues([issue('nested', 'info'), issue('keyframes', 'warning'), issue('crop', 'warning')]);
    expect(g.map((x) => [x.severity, x.issues.map((i) => i.kind)])).toEqual([['warning', ['keyframes', 'crop']], ['info', ['nested']]]);
    expect(groupIssues([issue('nested', 'info')]).map((x) => x.severity)).toEqual(['info']);
    expect(groupIssues([])).toEqual([]);
  });
});

describe('Export Timeline: main-process writer', () => {
  let dir: string;
  let media: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-interchange-'));
    media = path.join(dir, 'source.edl'); // a project source that happens to have an interchange extension
    fs.writeFileSync(media, 'ORIGINAL');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is the only new write channel', () => {
    expect(IPC.interchangeWrite).toBe('interchange:write');
  });

  it('writes every file into the folder and leaves no temp or .bak behind', async () => {
    const res = await writeInterchangeFiles({ folder: dir, files: [f('Cut_V1.edl', 'TITLE: A\n'), f('Cut_V2.edl', 'TITLE: B\n')], protectedPaths: [media] });
    expect(res).toEqual({ ok: true, paths: [path.join(dir, 'Cut_V1.edl'), path.join(dir, 'Cut_V2.edl')] });
    expect(fs.readFileSync(path.join(dir, 'Cut_V2.edl'), 'utf8')).toBe('TITLE: B\n');
    expect(fs.readdirSync(dir).sort()).toEqual(['Cut_V1.edl', 'Cut_V2.edl', 'source.edl']);
  });

  it('asks before replacing existing files, and replaces them with overwrite', async () => {
    const target = path.join(dir, 'Cut.fcpxml');
    fs.writeFileSync(target, 'OLD');
    const req = { folder: dir, files: [f('Cut.fcpxml', '<?xml?>')], protectedPaths: [] };
    const first = await writeInterchangeFiles(req);
    expect(first).toMatchObject({ ok: false, code: 'exists', existing: [target] });
    expect(fs.readFileSync(target, 'utf8')).toBe('OLD');
    expect(await writeInterchangeFiles({ ...req, overwrite: true })).toEqual({ ok: true, paths: [target] });
    expect(fs.readFileSync(target, 'utf8')).toBe('<?xml?>');
  });

  it('refuses project sources (also through a symlink), non-files, other extensions and path names', async () => {
    const r1 = await writeInterchangeFiles({ folder: dir, files: [f('source.edl')], protectedPaths: [media], overwrite: true });
    expect(r1.ok).toBe(false);
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(dir, alias);
    const r2 = await writeInterchangeFiles({ folder: alias, files: [f('source.edl')], protectedPaths: [media], overwrite: true });
    expect(r2.ok).toBe(false);
    expect(fs.readFileSync(media, 'utf8')).toBe('ORIGINAL');
    fs.mkdirSync(path.join(dir, 'Folder.otio'));
    expect((await writeInterchangeFiles({ folder: dir, files: [f('Folder.otio')], protectedPaths: [], overwrite: true })).ok).toBe(false);
    for (const name of ['cut.mp4', '../cut.edl', 'sub/cut.edl', 'sub\\cut.edl', '.edl/..', '']) {
      expect((await writeInterchangeFiles({ folder: dir, files: [f(name)], protectedPaths: [] })).ok, name).toBe(false);
    }
    expect((await writeInterchangeFiles({ folder: 'relative', files: [f('a.edl')], protectedPaths: [] })).ok).toBe(false);
    expect((await writeInterchangeFiles({ folder: path.join(dir, 'missing'), files: [f('a.edl')], protectedPaths: [] })).ok).toBe(false);
    expect((await writeInterchangeFiles({ folder: dir, files: [f('a.edl'), f('A.EDL')], protectedPaths: [] })).ok).toBe(false);
    expect((await writeInterchangeFiles({ folder: dir, files: [], protectedPaths: [] })).ok).toBe(false);
    expect((await writeInterchangeFiles(null)).ok).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['Folder.otio', 'alias', 'source.edl']);
  });
});
