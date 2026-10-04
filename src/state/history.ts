/**
 * Pure undo/redo helpers over immutable Project references.
 * The store keeps previous `Project` objects; immer's structural sharing makes this cheap.
 */
import { produce } from 'immer';
import type { ID, MediaItem, Project } from '../../shared/model';
import type { HistoryState } from './types';

export const DEFAULT_HISTORY_LIMIT = 200;

export function emptyHistory(limit = DEFAULT_HISTORY_LIMIT): HistoryState {
  return { past: [], future: [], pastLabels: [], futureLabels: [], limit };
}

/** Push `previous` as a new undo entry, clearing redo. Caps at `limit`. */
export function pushHistory(h: HistoryState, previous: Project, label: string): HistoryState {
  const past = [...h.past, previous];
  const pastLabels = [...h.pastLabels, label];
  while (past.length > h.limit) { past.shift(); pastLabels.shift(); }
  return { ...h, past, pastLabels, future: [], futureLabels: [] };
}

const MEDIA_MIRROR_FIELDS = ['probe', 'probeError', 'kind', 'proxy', 'offline', 'path', 'fileSize', 'fileMtime', 'sceneDetectStatus', 'waveformStatus'] as const satisfies readonly (keyof MediaItem)[];

/**
 * Carry the *current* non-undoable editor state into the project being restored:
 *  - `view` of every sequence that exists in both (playhead/zoom/scroll/in/out are not undoable)
 *  - `activeSequenceId` when that sequence still exists in the restored project
 */
export function carryViewState(restored: Project, current: Project): Project {
  return produce(restored, (draft) => {
    for (const id of Object.keys(draft.sequences)) {
      const cur = current.sequences[id];
      if (cur) draft.sequences[id].view = { ...cur.view };
    }
    // Job/status mirrors (probe, proxy, offline/relink, scene-detect status) are applied quietly and are not
    // undoable, so they may have arrived after the snapshot being restored was taken: keep the current values.
    for (const id of Object.keys(draft.media)) {
      const cur = current.media[id];
      if (!cur) continue;
      const m = draft.media[id];
      for (const k of MEDIA_MIRROR_FIELDS) {
        if (m[k] === cur[k]) continue;
        if (cur[k] === undefined) delete m[k];
        else (m as unknown as Record<string, unknown>)[k] = cur[k];
      }
    }
    if (current.activeSequenceId && draft.sequences[current.activeSequenceId]) {
      draft.activeSequenceId = current.activeSequenceId;
    }
  });
}

export interface HistoryStep { history: HistoryState; project: Project; label: string }

export function undoHistory(h: HistoryState, current: Project): HistoryStep | null {
  if (h.past.length === 0) return null;
  const past = h.past.slice(0, -1);
  const pastLabels = h.pastLabels.slice(0, -1);
  const label = h.pastLabels[h.pastLabels.length - 1] ?? '';
  const restored = carryViewState(h.past[h.past.length - 1], current);
  return {
    label,
    project: restored,
    history: { ...h, past, pastLabels, future: [...h.future, current], futureLabels: [...h.futureLabels, label] },
  };
}

export function redoHistory(h: HistoryState, current: Project): HistoryStep | null {
  if (h.future.length === 0) return null;
  const future = h.future.slice(0, -1);
  const futureLabels = h.futureLabels.slice(0, -1);
  const label = h.futureLabels[h.futureLabels.length - 1] ?? '';
  const restored = carryViewState(h.future[h.future.length - 1], current);
  return {
    label,
    project: restored,
    history: { ...h, future, futureLabels, past: [...h.past, current], pastLabels: [...h.pastLabels, label] },
  };
}

export function undoLabel(h: HistoryState): string | null {
  return h.past.length ? h.pastLabels[h.pastLabels.length - 1] ?? '' : null;
}
export function redoLabel(h: HistoryState): string | null {
  return h.future.length ? h.futureLabels[h.futureLabels.length - 1] ?? '' : null;
}

/** Ids of sequences whose object identity changed between two project versions. */
export function changedSequenceIds(prev: Project, next: Project): ID[] {
  const out: ID[] = [];
  for (const id of Object.keys(next.sequences)) if (next.sequences[id] !== prev.sequences[id]) out.push(id);
  return out;
}
