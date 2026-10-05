/**
 * BUG 3: loadProjectFile classification.
 *  - version refusals (newer / missing formatVersion) are explicit and never fall back to `<path>.bak`;
 *  - damage (unreadable, not JSON, not an object, structurally broken, or ANY unexpected failure while
 *    normalizing a JSON object) falls back to `<path>.bak`, keeping a `.corrupt-<ts>` copy of the primary;
 *  - hostile-but-repairable files open from the primary, repaired.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../../shared/project';
import { isValidFps } from '../../shared/time';
import { saveProjectFile, loadProjectFile } from '../../electron/project/io';
import { PROJECT_FORMAT_VERSION } from '../../shared/model';
import type { Project } from '../../shared/model';

// Delegates to the real normalizeProject / normalizeProjectWithReport, except for a marker project name that
// simulates an unexpected internal failure (a TypeError from a code path nobody anticipated).
vi.mock('../../shared/project', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../shared/project')>();
  const explode = (raw: unknown) => {
    if (raw && typeof raw === 'object' && (raw as { name?: unknown }).name === '__explode__') {
      throw new TypeError("Cannot read properties of undefined (reading 'boom')");
    }
  };
  return {
    ...real,
    normalizeProject: (raw: unknown) => { explode(raw); return real.normalizeProject(raw); },
    normalizeProjectWithReport: (raw: unknown) => { explode(raw); return real.normalizeProjectWithReport(raw); },
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
let tmp: string;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-rec-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

const rt = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const corruptCopies = async () => (await fsp.readdir(tmp)).filter((f) => f.includes('.corrupt-'));

/** A project file whose .bak holds a good project named 'backup'. */
async function withBackup(name: string): Promise<string> {
  const file = path.join(tmp, name);
  await saveProjectFile(file, createProject('backup'));
  await saveProjectFile(file, createProject('primary')); // .bak = 'backup'
  return file;
}

function hostile(mut: (p: Any, sid: string) => void): string {
  const p = rt(createProject('hostile')) as Any;
  mut(p, p.activeSequenceId);
  return JSON.stringify(p);
}

describe('hostile but repairable .recut files open from the primary, repaired', () => {
  const seqOf = (p: Project) => p.sequences[p.activeSequenceId!];
  const cases: [string, (p: Any, sid: string) => void, (p: Project) => void][] = [
    ['scenes {broken: null}', (p) => { p.scenes = { broken: null, ok: { id: 'ok', name: 's', mediaId: 'm', in: 0, out: 1 } }; },
      (p) => { expect(Object.keys(p.scenes)).toEqual(['ok']); }],
    ['subtitleTracks {broken: null}', (p) => { p.subtitleTracks = { broken: null }; }, (p) => { expect(p.subtitleTracks).toEqual({}); }],
    ['videoTracks [null]', (p, sid) => { p.sequences[sid].videoTracks = [null]; },
      (p) => { expect(seqOf(p).videoTracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3']); }],
    ['audioTracks [null]', (p, sid) => { p.sequences[sid].audioTracks = [null, 5, 'x']; },
      (p) => { expect(seqOf(p).audioTracks.map((t) => t.name)).toEqual(['A1', 'A2', 'A3']); }],
    ['markers / snapshots junk', (p, sid) => { p.sequences[sid].markers = [null]; p.sequences[sid].snapshots = [null, { data: 'x' }]; },
      (p) => { expect(seqOf(p).markers).toEqual([]); expect(seqOf(p).snapshots).toEqual([]); }],
    ['sequence fps {num: 24, den: 0}', (p, sid) => { p.sequences[sid].fps = { num: 24, den: 0 }; }, () => undefined],
    ['media proxy / probe junk', (p) => { p.media = { m: { path: '/m.mkv', name: 'm', proxy: 'x', probe: 7 } }; },
      (p) => { expect(p.media.m.proxy).toEqual({ status: 'none' }); expect('probe' in p.media.m).toBe(false); expect(p.media.m.path).toBe('/m.mkv'); }],
  ];
  for (const [label, mut, check] of cases) {
    it(label, async () => {
      const file = await withBackup(`${label.replace(/\W+/g, '_')}.recut`);
      await fsp.writeFile(file, hostile(mut));
      const res = await loadProjectFile(file);
      expect(res.ok, res.ok ? '' : res.error).toBe(true);
      if (!res.ok) return;
      expect(res.project.name).toBe('hostile');
      expect(res.fromBackup).toBeFalsy();
      expect(await corruptCopies()).toEqual([]);
      const seq = seqOf(res.project);
      expect(seq.fps).toEqual({ num: 24000, den: 1001 }); // the default rate (also the repair for an invalid one)
      expect(isValidFps(seq.fps)).toBe(true);
      expect(seq.videoTracks.length).toBeGreaterThan(0);
      check(res.project);
    });
  }
});

describe('structurally corrupt primary falls back to a valid .bak', () => {
  const cases: [string, string][] = [
    ['sequences is a string', hostile((p) => { p.sequences = 'garbage'; })],
    ['media is an array', hostile((p) => { p.media = [{ path: '/a' }]; })],
    ['scenes is a number', hostile((p) => { p.scenes = 42; })],
    ['subtitleTracks is true', hostile((p) => { p.subtitleTracks = true; })],
    ['unexpected TypeError while normalizing', hostile((p) => { p.name = '__explode__'; })],
    ['top-level array', '[1,2,3]'],
    ['top-level null', 'null'],
    ['truncated JSON', '{"formatVersion": 1, "sequences": {'],
  ];
  for (const [label, text] of cases) {
    it(label, async () => {
      const file = await withBackup('c.recut');
      await fsp.writeFile(file, text);
      const res = await loadProjectFile(file);
      expect(res.ok, res.ok ? '' : res.error).toBe(true);
      if (!res.ok) return;
      expect(res.project.name).toBe('backup');
      expect(res.fromBackup).toBe(true);
      expect(res.backupMtime).toBe((await fsp.stat(file + '.bak')).mtimeMs);
      const aside = await corruptCopies();
      expect(aside).toHaveLength(1);
      expect(await fsp.readFile(path.join(tmp, aside[0]), 'utf8')).toBe(text);
    });
  }

  it('without a usable .bak, structural damage is reported as an error naming the damage', async () => {
    const file = path.join(tmp, 'solo.recut');
    await fsp.writeFile(file, hostile((p) => { p.sequences = 'garbage'; }));
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/sequences/);
    expect(await corruptCopies()).toEqual([]);
  });

  it('an unexpected normalization failure without a .bak is reported, not swallowed', async () => {
    const file = path.join(tmp, 'boom.recut');
    await fsp.writeFile(file, hostile((p) => { p.name = '__explode__'; }));
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/boom/);
  });

  it('a damaged primary whose .bak is newer-format reports an error and loads nothing', async () => {
    const file = path.join(tmp, 'd.recut');
    await fsp.writeFile(file, hostile((p) => { p.sequences = 'garbage'; }));
    await fsp.writeFile(file + '.bak', JSON.stringify({ ...rt(createProject('future')), formatVersion: PROJECT_FORMAT_VERSION + 1 }));
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(false);
  });
});

describe('version refusals never fall back to the .bak', () => {
  const cases: [string, string, RegExp][] = [
    ['newer formatVersion', JSON.stringify({ ...rt(createProject('future')), formatVersion: PROJECT_FORMAT_VERSION + 1 }), /newer ReCut/],
    ['missing formatVersion', JSON.stringify({ ...rt(createProject('nover')), formatVersion: undefined }), /formatVersion/],
    ['string formatVersion', JSON.stringify({ ...rt(createProject('strver')), formatVersion: '1' }), /formatVersion/],
    ['newer formatVersion with broken content', JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION + 1, sequences: 'garbage', scenes: { x: null } }), /newer ReCut/],
  ];
  for (const [label, text, msg] of cases) {
    it(label, async () => {
      const file = await withBackup('v.recut');
      await fsp.writeFile(file, text);
      const res = await loadProjectFile(file);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(msg);
      expect(await corruptCopies()).toEqual([]);
      expect(await fsp.readFile(file, 'utf8')).toBe(text); // untouched
    });
  }
});
