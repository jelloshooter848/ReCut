/**
 * Follow-up fixes (project open / recovery):
 *  3. Both open paths (actions.openProject and requestOpenProject) report a repaired load the same way.
 *  4. checkRecovery reports what the autosave needed repaired (RecoveryInfo.repaired, no copies) and the
 *     recovery prompt says so.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../../shared/project';
import { checkRecovery, writeAutosaveJson } from '../../electron/project/io';
import type { LoadResult, RecoveryInfo } from '../../shared/ipc';
import { useStore, resetStore } from '../../src/state/store';
import { openProject } from '../../src/state/mediaActions';
import { recoveryPrompt, requestOpenProject } from '../../src/app/project';
import { getToasts } from '../../src/components/ui/toastStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const rt = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe('3: repaired loads warn on every open path', () => {
  const g = globalThis as Any;
  let loadResult: LoadResult;
  beforeEach(() => {
    resetStore();
    g.window = globalThis;
    g.recut = {
      loadProject: async () => loadResult,
      stat: async () => ({ exists: true }),
    };
    loadResult = {
      ok: true, path: '/projects/r.recut', project: rt(createProject('Repaired one')),
      repaired: ['invalid clip removed', 'clip start out of range'], preRepairPath: '/projects/r.recut.pre-repair-123',
    };
  });
  afterEach(() => { delete g.recut; delete g.window; });

  it('actions.openProject toasts the repair warning naming the kept copy', async () => {
    const res = await openProject('/projects/r.recut');
    expect(res.ok).toBe(true);
    const texts = useStore.getState().ui.toasts.filter((t) => t.kind === 'warning').map((t) => t.text);
    expect(texts.some((t) => /damaged and has been repaired/.test(t) && /r\.recut\.pre-repair-123/.test(t))).toBe(true);
  });

  it('requestOpenProject shows the same warning (and no "Opened" success toast)', async () => {
    const before = getToasts().length;
    expect(await requestOpenProject('/projects/r.recut')).toBe(true);
    const fresh = getToasts().slice(before).map((t) => `${t.kind}:${t.text}`);
    expect(fresh.some((t) => /^warn:.*damaged and has been repaired/.test(t))).toBe(true);
    expect(fresh.some((t) => /^ok:Opened/.test(t))).toBe(false);
  });

  it('both paths adopt the file name for a default-named project', async () => {
    loadResult = { ok: true, path: '/projects/My Cut.recut', project: rt(createProject('Untitled Project')) };
    await openProject('/projects/My Cut.recut');
    expect(useStore.getState().project.name).toBe('My Cut');
  });
});

describe('4: recovery reports repairs', () => {
  let tmp: string;
  let userData: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-fu-io-'));
    userData = path.join(tmp, 'userData');
    await fsp.mkdir(userData, { recursive: true });
  });
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

  function damaged(): string {
    const p = rt(createProject('repairable')) as Any;
    p.sequences[p.activeSequenceId].videoTracks[0].clips = [
      { id: 'good', mediaId: 'm1', name: 'g', start: 0, duration: 10, sourceIn: 0, speed: 1 },
      { id: 'neg', mediaId: 'm1', name: 'n', start: -1, duration: 10, sourceIn: 0, speed: 1 },
    ];
    return JSON.stringify(p);
  }

  it('checkRecovery fills RecoveryInfo.repaired for a repaired autosave, without copies', async () => {
    const f = path.join(tmp, 'a.recut');
    expect((await writeAutosaveJson(f, damaged(), userData)).ok).toBe(true);
    const rec = await checkRecovery(userData, [f]);
    expect(rec).not.toBeNull();
    expect(rec!.repaired?.length).toBeGreaterThan(0);
    expect((await fsp.readdir(tmp)).filter((x) => x.includes('.pre-repair-'))).toEqual([]);
  });

  it('a clean autosave has no repaired field', async () => {
    const f = path.join(tmp, 'b.recut');
    expect((await writeAutosaveJson(f, JSON.stringify(createProject('clean')), userData)).ok).toBe(true);
    const rec = await checkRecovery(userData, [f]);
    expect(rec).not.toBeNull();
    expect(rec!.repaired).toBeUndefined();
  });

  it('the recovery prompt warns when the autosave needed repairs', () => {
    const info: RecoveryInfo = { autosavePath: '/p/a.recut.autosave', projectPath: '/p/a.recut', savedAt: 0, project: createProject('A') };
    expect(recoveryPrompt(info).detail).not.toMatch(/repair/i);
    const opts = recoveryPrompt({ ...info, repaired: ['invalid clip removed'] });
    expect(opts.detail).toMatch(/damaged/i);
    expect(opts.detail).toMatch(/invalid clip removed/);
    expect(opts.type).toBe('warning');
  });
});
