/**
 * How a project crosses IPC in bulk: the renderer streams a manual save to main (ProjectSaveStreamApi), and the
 * main process hands an opened project to the renderer (ProjectWire).
 *
 * On open, main reads, parses and normalizes the file once (electron/project/io.ts). Sending the result as an object would
 * structured-clone the whole project on both sides of IPC and land in the renderer as one long deserialization
 * task, and the renderer used to normalize it again. Instead main sends JSON text cut at record boundaries (the
 * top level, each collection, each sequence): strings cross IPC as a copy, and the renderer parses the pieces one
 * at a time, yielding between them, so no single task holds the whole project.
 *
 * The data is already normalized (`normalized: true`): decodeProjectWire only re-creates what JSON cannot carry
 * (each sequence view is a LiveView instance) and never repairs. A project from anywhere else (a legacy
 * LoadResult.project, a recovery object) still goes through normalizeProject, so untrusted data is normalized
 * exactly once.
 *
 * Pure: no DOM, no Node.
 */
import type { Project, Sequence, SequenceSnapshot } from './model';
import type { SaveResult } from './ipc';
import { LiveView } from './project';

// ------------------------------------------------------------------
// Renderer -> main on save
// ------------------------------------------------------------------

/**
 * IPC channels of a streamed project save (ProjectSaveStreamApi). `chunk` is a one-way message (ipcRenderer.send);
 * the others are invoke / handle.
 */
export const SAVE_STREAM_IPC = {
  begin: 'project:saveBegin',
  chunk: 'project:saveChunk',
  commit: 'project:saveCommit',
  abort: 'project:saveAbort',
} as const;

export type SaveBeginResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * A manual save streamed to main while the renderer serializes it (src/state/mediaActions.ts): each piece of
 * the file text (about a megabyte, cut between records) is sent as soon as it is written, and main encodes and
 * appends it to a temp file beside the target while the next piece is serialized. The bytes on disk are those
 * of one saveProjectJson call with the whole text; only the commit makes them the project file, with the same
 * fsync, `.bak` and atomic rename (electron/project/io.ts ProjectFileWriter). Exposed on `window.recut` next to
 * RecutApi; a bridge without it saves through saveProjectJson.
 */
export interface ProjectSaveStreamApi {
  /** Start a save of the project file at `path` (main opens the temp file). */
  saveProjectBegin(path: string): Promise<SaveBeginResult>;
  /** Piece number `seq` (0, 1, 2, ...) of the text. One-way: a failed write is reported by the commit. */
  saveProjectChunk(id: string, seq: number, text: string): void;
  /** Every piece was sent (`chunks` pieces, `chars` UTF-16 code units in all): write the file. */
  saveProjectCommit(id: string, totals: { chunks: number; chars: number }): Promise<SaveResult>;
  /** Give up: the temp file is removed, the project file left as it was. */
  saveProjectAbort(id: string): Promise<void>;
}

/** The bridge streams saves (an older preload or a test double may not). */
export function canStreamSave(api: unknown): api is ProjectSaveStreamApi {
  const a = api as Partial<ProjectSaveStreamApi> | null;
  return !!a && typeof a.saveProjectBegin === 'function' && typeof a.saveProjectChunk === 'function'
    && typeof a.saveProjectCommit === 'function' && typeof a.saveProjectAbort === 'function';
}

// ------------------------------------------------------------------
// Main -> renderer on open
// ------------------------------------------------------------------

/** A collection of the project sent as its own piece(s); everything else travels in `head`. */
type WireCollection = 'media' | 'sequences' | 'scenes' | 'subtitleTracks';
const COLLECTIONS: readonly WireCollection[] = ['media', 'sequences', 'scenes', 'subtitleTracks'];

export interface ProjectWire {
  /** Produced from a normalizeProject result in the main process: the renderer must not normalize it again. */
  normalized: true;
  /** JSON of the project with each collection replaced by `{}` (keeps the key order). */
  head: string;
  /** [collection, id, JSON of that entry] for each sequence; [collection, null, JSON of the whole collection] otherwise. */
  parts: [WireCollection, string | null, string][];
}

export function isProjectWire(v: unknown): v is ProjectWire {
  const w = v as ProjectWire | null;
  return !!w && typeof w === 'object' && w.normalized === true && typeof w.head === 'string' && Array.isArray(w.parts);
}

/** Main process: a normalized project -> wire form. */
export function encodeProjectWire(project: Project): ProjectWire {
  const top: Record<string, unknown> = { ...project };
  const parts: ProjectWire['parts'] = [];
  for (const c of COLLECTIONS) {
    const v = project[c] as Record<string, unknown> | undefined;
    if (v === undefined) continue;
    top[c] = {};
    if (c === 'sequences') for (const id of Object.keys(v)) parts.push([c, id, JSON.stringify(v[id])]);
    else parts.push([c, null, JSON.stringify(v)]);
  }
  return { normalized: true, head: JSON.stringify(top), parts };
}

/** Called between pieces; resolve to continue (e.g. after a macrotask when the slice ran long). */
export type WireYield = () => Promise<void> | void;

function setOwn(rec: Record<string, unknown>, key: string, value: unknown): void {
  // A "__proto__" key is an own property after JSON.parse; keep it one (plain assignment would set the prototype).
  if (key === '__proto__') Object.defineProperty(rec, key, { value, enumerable: true, writable: true, configurable: true });
  else rec[key] = value;
}

function hydrateViews(seq: Sequence): void {
  seq.view = new LiveView(seq.view);
  if (Array.isArray(seq.snapshots)) for (const sn of seq.snapshots as SequenceSnapshot[]) if (sn?.data?.view) sn.data.view = new LiveView(sn.data.view);
}

/**
 * Renderer: wire form -> the project main normalized (sequence views as LiveView instances, as normalizeProject
 * returns them). `pause` runs between pieces (pass one that yields to keep the window responsive).
 */
export async function decodeProjectWire(wire: ProjectWire, pause?: WireYield): Promise<Project> {
  const project = JSON.parse(wire.head) as Project;
  for (const [c, id, json] of wire.parts) {
    if (pause) await pause();
    const value = JSON.parse(json) as unknown;
    const rec = project as unknown as Record<string, Record<string, unknown>>;
    if (id === null) rec[c] = value as Record<string, unknown>;
    else setOwn(rec[c], id, value);
  }
  for (const seq of Object.values(project.sequences)) hydrateViews(seq);
  return project;
}
