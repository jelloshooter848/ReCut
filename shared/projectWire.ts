/**
 * How the main process hands an opened project to the renderer.
 *
 * Main reads, parses and normalizes the file once (electron/project/io.ts). Sending the result as an object would
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
import { LiveView } from './project';

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
