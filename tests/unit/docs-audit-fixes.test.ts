/**
 * Defects found by the docs audit (2026-10-08):
 *  1. File › Import Media… and the Project panel's Import… offer the same file-type filters (one list, docs/FORMATS.md)
 *     (bugs/closed/2026-10-08-import-menu-stale-file-filter.md);
 *  2. the frame rate of a sequence with clips is fixed: Sequence Settings… disables it and the store action refuses it
 *     (bugs/closed/2026-10-08-sequence-settings-fps-retimes-clips.md);
 *  3. Help › About says every release build bundles a GPL FFmpeg, not only the Windows builds.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// The command layer touches `window` (toasts, layout store). Provide a bare window; each test installs its own bridge.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = globalThis;
  (g.window as Record<string, unknown>).recut = undefined;
});

import type { FileFilter, OpenFilesOptions } from '../../shared/ipc';
import type { MediaItem, Rational, Sequence } from '../../shared/model';
import { createMediaItem, createSequence } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import { FPS_LOCKED_REASON, resetStore, sequenceHasClips, useStore } from '../../src/state/store';
import { IMPORT_FILTERS, SUBTITLE_FILTERS, importViaDialog } from '../../src/panels/project/actions';
import { ABOUT_LICENCE_TEXT, EXTRA_COMMAND_IDS, registerEditingCommands } from '../../src/app/commands';
import { registerShellCommands } from '../../src/keyboard/commands';
import { runCommand } from '../../src/keyboard/shortcuts';
import { COMMAND_IDS } from '../../src/keyboard/commandIds';
import { sequenceFpsLock } from '../../src/app/dialogs/NewSequenceDialog';

const R = (num: number, den = 1): Rational => ({ num, den });
const F24 = R(24), F25 = R(25);
const S = () => useStore.getState();
const w = window as unknown as { recut: unknown };

beforeAll(() => { registerShellCommands(); registerEditingCommands(); });
afterEach(() => { w.recut = undefined; });

describe('Import Media… (menu, Ctrl+I) and the Project panel Import… use one filter list', () => {
  it('both open the file dialog with IMPORT_FILTERS', async () => {
    const calls: OpenFilesOptions[] = [];
    w.recut = { openFiles: vi.fn(async (o: OpenFilesOptions) => { calls.push(o); return []; }) };
    expect(runCommand(COMMAND_IDS.importMedia)).toBe(true);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await importViaDialog(null);
    expect(calls.length).toBe(2);
    const [menu, panel] = calls.map((c) => c.filters as FileFilter[]);
    expect(menu).toBe(IMPORT_FILTERS);
    expect(panel).toBe(IMPORT_FILTERS);
    expect(menu).toEqual(panel);
  });

  it('the shared list carries the formats docs/FORMATS.md documents, Subtitles included', () => {
    const exts = (name: string) => IMPORT_FILTERS.find((f) => f.name === name)?.extensions ?? [];
    for (const e of ['tif', 'tiff', 'heic', 'avif', 'exr', 'psd', 'jxl']) expect(exts('Images')).toContain(e);
    for (const e of ['mts', '3gp', 'ogv']) expect(exts('Video')).toContain(e);
    for (const e of ['opus', 'dts', 'eac3', 'aiff']) expect(exts('Audio')).toContain(e);
    expect(exts('Subtitles')).toEqual(['srt', 'vtt']);
    for (const e of ['mts', 'heic', 'opus', 'srt']) expect(exts('All media')).toContain(e);
  });

  it('Import Subtitles… (menu) uses the panel subtitle filter list', async () => {
    resetStore();
    const m: MediaItem = { ...createMediaItem('/media/movie.mkv', 'movie.mkv'), id: 'M', kind: 'video' };
    useStore.setState((st) => ({ project: { ...st.project, media: { ...st.project.media, M: m } }, ui: { ...st.ui, selectedMediaIds: ['M'] } }));
    const calls: OpenFilesOptions[] = [];
    w.recut = { openFiles: vi.fn(async (o: OpenFilesOptions) => { calls.push(o); return []; }) };
    expect(runCommand(EXTRA_COMMAND_IDS.importSubtitles)).toBe(true);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].filters).toBe(SUBTITLE_FILTERS);
  });
});

describe('the frame rate of a sequence with clips is fixed', () => {
  let seqId: string;
  const seq = (): Sequence => S().project.sequences[seqId];
  const toasts = () => S().ui.toasts.map((t) => t.text);

  beforeEach(() => {
    resetStore();
    const s = createSequence('Seq', F24, 1920, 1080);
    S().addSequence(s, { activate: true });
    seqId = s.id;
    S().clearHistory();
  });

  function addClip(): void {
    useStore.setState((st) => {
      const s = st.project.sequences[seqId];
      const v1 = { ...s.videoTracks[0], clips: [makeClip({ mediaId: 'M', name: 'v', sourceIn: 0, duration: 48, kind: 'video' }, 0)] };
      return { project: { ...st.project, sequences: { ...st.project.sequences, [seqId]: { ...s, videoTracks: [v1, ...s.videoTracks.slice(1)] } } } };
    });
  }

  it('an empty sequence can change its frame rate', () => {
    expect(sequenceHasClips(seq())).toBe(false);
    S().updateSequenceSettings(seqId, { fps: F25 });
    expect(seq().fps).toEqual(F25);
    expect(toasts()).toEqual([]);
  });

  it('updateSequenceSettings refuses a frame-rate change once the sequence has clips, with a warning', () => {
    addClip();
    expect(sequenceHasClips(seq())).toBe(true);
    S().updateSequenceSettings(seqId, { fps: F25 });
    expect(seq().fps).toEqual(F24);
    expect(S().history.past.length).toBe(0);
    expect(toasts()).toEqual([`Frame rate not changed. ${FPS_LOCKED_REASON}`]);
  });

  it('the rest of the patch still applies; the same rate (any spelling) is not a change', () => {
    addClip();
    S().updateSequenceSettings(seqId, { fps: F25, width: 1280, height: 720, sampleRate: 44100, name: 'Renamed' });
    expect(seq()).toMatchObject({ fps: F24, width: 1280, height: 720, sampleRate: 44100, name: 'Renamed' });
    S().ui.toasts.forEach((t) => S().dismissToast(t.id));
    S().updateSequenceSettings(seqId, { fps: R(48, 2), channels: 6 });
    expect(seq()).toMatchObject({ fps: { num: 48, den: 2 }, channels: 6 });
    expect(toasts()).toEqual([]);
  });

  it('Sequence Settings… locks the frame rate (with the Inspector explanation) only when the sequence has clips', () => {
    expect(sequenceFpsLock(null)).toBeNull(); // New Sequence
    expect(sequenceFpsLock(seq())).toBeNull();
    addClip();
    expect(sequenceFpsLock(seq())).toBe(FPS_LOCKED_REASON);
    expect(FPS_LOCKED_REASON).toBe('Frame rate is fixed once a timeline has clips (positions are frames).');
  });
});

describe('Help › About licence text', () => {
  it('says every release build bundles a GPL FFmpeg', async () => {
    const details: string[] = [];
    w.recut = {
      appInfo: async () => ({ version: '0.0.0-test', ffmpegVersion: 'n8.1', ffmpegPath: '/x/ffmpeg', cacheDir: '/cache' }),
      licenceFiles: async () => [],
      message: vi.fn(async (o: { detail?: string }) => { details.push(o.detail ?? ''); return 0; }),
    };
    expect(runCommand(EXTRA_COMMAND_IDS.about)).toBe(true);
    await vi.waitFor(() => expect(details.length).toBe(1));
    expect(details[0]).toContain(ABOUT_LICENCE_TEXT);
    expect(ABOUT_LICENCE_TEXT).toMatch(/every ReCut release build is GPL/);
    expect(ABOUT_LICENCE_TEXT).not.toMatch(/Windows/);
  });
});
