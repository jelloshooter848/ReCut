/**
 * bugs/closed/2026-10-06-edits-during-save-marked-saved.md @ 59eafc6
 *
 * A save serializes a snapshot of the project, then awaits serialization slices and the IPC write. Edits committed
 * in that window are not in the file, so the save must not mark them saved: the project stays dirty and the next
 * save writes them. Runs the real store + saveProject with a window.recut whose writes resolve only when the test
 * says so.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useStore, resetStore } from '../../src/state/store';
import { autosaveProject, saveProject } from '../../src/state/mediaActions';
import { confirmDiscardIfDirty } from '../../src/app/project';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const g = globalThis as Any;
const S = () => useStore.getState();

interface Write { path: string; json: string; resolve: () => void }
/** In-flight writes (in the order they reached "main") and the text the "disk" holds once each one lands. */
let writes: Write[];
let disk: string | null;

function delayedApi(extra: Record<string, unknown> = {}) {
  g.recut = {
    saveProjectJson: (path: string, json: string) => new Promise((r) => {
      const w: Write = { path, json, resolve: () => { disk = json; r({ ok: true, path }); } };
      writes.push(w);
    }),
    ...extra,
  };
}

/** Let queued tasks / serialization slices run until `n` writes have been sent (or give up). */
async function untilWrites(n: number): Promise<void> {
  for (let i = 0; i < 200 && writes.length < n; i++) await new Promise((r) => setTimeout(r, 0));
}
const nameIn = (json: string | null) => (json ? JSON.parse(json).name : null);

beforeEach(() => { resetStore(); g.window = globalThis; writes = []; disk = null; });
afterEach(() => { delete g.recut; delete g.window; });

describe('edits committed while a save is in flight stay unsaved', () => {
  it('an edit after serialization starts keeps the project dirty; the next save writes it', async () => {
    delayedApi();
    S().renameProject('A');
    const first = saveProject('/p/x.recut');
    await untilWrites(1);
    expect(writes).toHaveLength(1);
    S().renameProject('B'); // committed while the write is in flight
    writes[0].resolve();
    expect((await first).ok).toBe(true);

    expect(nameIn(disk)).toBe('A');
    expect(S().dirty).toBe(true); // the file does not have 'B'
    expect(S().projectPath).toBe('/p/x.recut');

    const second = saveProject();
    await untilWrites(2);
    writes[1].resolve();
    expect((await second).ok).toBe(true);
    expect(nameIn(disk)).toBe('B');
    expect(S().dirty).toBe(false);
  });

  it('an edit right after save is called (before the first slice / IPC) is written or stays dirty', async () => {
    delayedApi();
    S().renameProject('A');
    const first = saveProject('/p/x.recut');
    S().renameProject('B'); // synchronously after the call: in the snapshot or not, it must not be lost
    await untilWrites(1);
    writes[0].resolve();
    await first;
    expect(S().dirty || nameIn(disk) === 'B').toBe(true);
  });

  it('undo while a save is in flight keeps the project dirty', async () => {
    delayedApi();
    S().renameProject('A');
    S().renameProject('B');
    const first = saveProject('/p/x.recut');
    await untilWrites(1);
    S().undo(); // back to 'A' in memory; the file gets 'B'
    writes[0].resolve();
    await first;
    expect(nameIn(disk)).toBe('B');
    expect(S().project.name).toBe('A');
    expect(S().dirty).toBe(true);
  });

  it('Save As with an edit in flight takes the new path but stays dirty', async () => {
    delayedApi();
    useStore.setState({ projectPath: '/p/old.recut' });
    S().renameProject('A');
    const first = saveProject('/p/new.recut');
    await untilWrites(1);
    S().renameProject('B');
    writes[0].resolve();
    await first;
    expect(S().projectPath).toBe('/p/new.recut'); // the file at the new path is this project's
    expect(S().dirty).toBe(true);
  });

  it('a save of a project that was replaced (new project) while in flight does not touch the new one', async () => {
    delayedApi();
    S().renameProject('A');
    const first = saveProject('/p/x.recut');
    await untilWrites(1);
    S().newProject('Fresh');
    S().renameProject('Fresh edit');
    writes[0].resolve();
    await first;
    expect(S().projectPath).toBe(null);
    expect(S().dirty).toBe(true);
  });

  it('two saves (save pressed twice): an older write never leaves newer content marked saved', async () => {
    // Writes resolve newest first whenever more than one is in flight (the worst order for a naive version).
    delayedApi();
    S().renameProject('A');
    const p1 = saveProject('/p/x.recut');
    await untilWrites(1);
    S().renameProject('B');
    const p2 = saveProject('/p/x.recut');
    await untilWrites(2);
    let settled = false;
    const both = Promise.all([p1, p2]).then(() => { settled = true; });
    for (let i = 0; i < 200 && !settled; i++) {
      const open = writes.filter((w) => !(w as Any).done);
      const w = open[open.length - 1];
      if (w) { (w as Any).done = true; w.resolve(); }
      await new Promise((r) => setTimeout(r, 0));
    }
    await both;
    // Whatever order the writes ran in, the file ends with the latest content before the project is clean.
    expect(nameIn(disk)).toBe('B');
    expect(S().dirty).toBe(false);
  });

  it('close-without-saving prompt: "Save" with an edit during the save does not report it safe to discard', async () => {
    delayedApi({ message: async () => 0 }); // the user picks "Save"
    useStore.setState({ projectPath: '/p/x.recut' });
    S().renameProject('A');
    const decision = confirmDiscardIfDirty();
    await untilWrites(1);
    S().renameProject('B');
    writes[0].resolve();
    expect(await decision).toBe(false); // 'B' is only in memory: new / open must not go ahead
    expect(S().dirty).toBe(true);
  });

  it('an autosave during a manual save writes the newer edit but marks nothing saved', async () => {
    const autosaves: string[] = [];
    delayedApi({ autosaveProjectJson: async (_p: string | null, json: string) => { autosaves.push(json); return { ok: true, path: 'a' }; } });
    S().renameProject('A');
    const first = saveProject('/p/x.recut');
    await untilWrites(1);
    S().renameProject('B');
    await autosaveProject();
    expect(nameIn(autosaves[0])).toBe('B');
    expect(S().dirty).toBe(true);
    writes[0].resolve();
    await first;
    expect(S().dirty).toBe(true);
  });

  it('a save with no edits in flight still marks the project saved', async () => {
    delayedApi();
    S().renameProject('A');
    const first = saveProject('/p/x.recut');
    await untilWrites(1);
    writes[0].resolve();
    await first;
    expect(S().dirty).toBe(false);
    expect(S().projectPath).toBe('/p/x.recut');
  });
});
