/**
 * #111: a blank untitled project (at most an empty bin) is not worth a recovery prompt or a "Save changes?" prompt.
 *  - projectHasUserWork tells user work from a blank project;
 *  - checkRecovery drops (deletes) an untitled autosave without user work, and still offers one with work;
 *  - confirmDiscardIfDirty (File › New / Open) asks nothing for a dirty untitled project without user work.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMediaItem, createProject, projectHasUserWork } from '../../shared/project';
import { checkRecovery, untitledAutosavePath, writeAutosave } from '../../electron/project/io';
import { useStore, resetStore } from '../../src/state/store';
import { confirmDiscardIfDirty } from '../../src/app/project';
import type { Project } from '../../shared/model';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** A blank project plus an empty "New Bin": the autosave from the #111 report. */
function blankWithBin(): Project {
  const p = createProject();
  p.bins.binNew = { id: 'binNew', name: 'New Bin', parentId: null, kind: 'bin' };
  return p;
}
const seqOf = (p: Project) => p.sequences[p.activeSequenceId!];

describe('projectHasUserWork', () => {
  it('a new project, an empty bin or changed settings are not user work', () => {
    expect(projectHasUserWork(createProject())).toBe(false);
    expect(projectHasUserWork(blankWithBin())).toBe(false);
    const p = createProject();
    p.settings.autosaveIntervalSec = 5;
    expect(projectHasUserWork(p)).toBe(false);
  });

  it('media, scenes, tags, markers, extra sequences and a project name are user work', () => {
    const cases: [string, (p: Project) => void][] = [
      ['media', (p) => { const m = createMediaItem('/m/a.mp4', 'a.mp4'); p.media[m.id] = m; }],
      ['scene', (p) => { p.scenes.s1 = { id: 's1', name: 's', mediaId: 'm', in: 0, out: 1 } as Any; }],
      ['tag', (p) => { p.tags.characters.push('Luke'); }],
      ['marker', (p) => { seqOf(p).markers.push({ id: 'mk', frame: 10, name: 'm', color: 'red', kind: 'marker' } as Any); }],
      ['second sequence', (p) => { const s = { ...seqOf(p), id: 'seq2' }; p.sequences.seq2 = s; p.sequenceOrder.push('seq2'); }],
      ['name', (p) => { p.name = 'My Cut'; }],
    ];
    for (const [what, mut] of cases) {
      const p = createProject();
      mut(p);
      expect(projectHasUserWork(p), what).toBe(true);
    }
  });
});

describe('checkRecovery and the untitled autosave', () => {
  let tmp: string;
  let userData: string;
  beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-111-')); userData = path.join(tmp, 'ud'); });
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

  it('does not offer, and deletes, an untitled autosave without user work', async () => {
    expect((await writeAutosave(null, blankWithBin(), userData)).ok).toBe(true);
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(true);
    expect(await checkRecovery(userData, [])).toBeNull();
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(false);
  });

  it('still offers an untitled autosave with user work', async () => {
    const p = blankWithBin();
    const m = createMediaItem('/m/a.mp4', 'a.mp4');
    p.media[m.id] = m;
    expect((await writeAutosave(null, p, userData)).ok).toBe(true);
    const rec = await checkRecovery(userData, []);
    expect(rec?.projectPath).toBeNull();
    expect(Object.keys(rec!.project.media)).toEqual([m.id]);
  });
});

describe('confirmDiscardIfDirty (File › New / Open)', () => {
  const g = globalThis as Any;
  let prompts: string[];
  beforeEach(() => {
    resetStore();
    prompts = [];
    g.window = globalThis;
    g.recut = { message: async (o: { message: string }) => { prompts.push(o.message); return 2; } }; // 2 = Cancel
  });
  afterEach(() => { delete g.recut; delete g.window; });

  it('asks nothing for a dirty untitled project without user work', async () => {
    useStore.setState({ project: blankWithBin(), projectPath: null, dirty: true });
    expect(await confirmDiscardIfDirty()).toBe(true);
    expect(prompts).toEqual([]);
  });

  it('still asks for a dirty untitled project with user work', async () => {
    const p = createProject();
    p.tags.characters.push('Luke');
    useStore.setState({ project: p, projectPath: null, dirty: true });
    expect(await confirmDiscardIfDirty()).toBe(false);
    expect(prompts).toEqual(['Save changes to "Untitled Project"?']);
  });

  it('still asks for a dirty saved project, even a blank one', async () => {
    useStore.setState({ project: createProject(), projectPath: '/p/blank.recut', dirty: true });
    expect(await confirmDiscardIfDirty()).toBe(false);
    expect(prompts).toHaveLength(1);
  });
});
