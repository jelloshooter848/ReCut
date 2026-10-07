/**
 * ReCut renderer store: a single zustand store holding the Project plus editor UI state, with an
 * immer-based undo/redo model.
 *
 *  - Every project change goes through `commit(label, recipe)` (undoable) or `setView` / `setActiveSequence`
 *    / `updateTransient` (not undoable).
 *  - Transient drags use beginTransaction / updateTransient / endTransaction so a drag is one undo step.
 *  - This module is DOM-free and importable from vitest (node). IPC wrappers live in ./mediaActions.ts.
 *
 * Usage: `useStore((s) => s.project)` in React, `useStore.getState()` anywhere else.
 */
import { create } from 'zustand';
import { produce, current, freeze, isDraftable } from 'immer';
import type {
  Bin, Clip, DetectedScene, ID, Marker, MediaItem, MediaKind, MediaProbe, Project, SceneRecord, Sequence,
  SequenceSubtitleCue, SequenceSubtitleTrack, StoryBlock, Track, Transition, TransitionType, TagVocabulary, SequenceView,
} from '../../shared/model';
import { uid } from '../../shared/ids';
import { isValidFps, secondsToFrames } from '../../shared/time';
import { createProject, LiveView } from '../../shared/project';
import {
  MIN_CLIP_FRAMES, allTracks, clipEnd, clipSourceOut, findClip, maxDurationFrom, findTrack, linkedClips, makeClip, placeClips,
  razorAt, removeClips as tlRemoveClips, rippleDeleteClips, rippleDeleteDisabledClips, removableDisabledClipIds, liftRange, extractRange, trimStart, trimEnd,
  rippleTrimStart, rippleTrimEnd, rollEdit as tlRollEdit, slipClip, slideClip, moveClips as tlMoveClips, readItems, clipsWithIds,
  addTransition as tlAddTransition, removeTransition as tlRemoveTransition, addTrack as tlAddTrack,
  removeTrack as tlRemoveTrack, reconcileTransitions, reconcileAll, rippleShift, addMarker as tlAddMarker,
  followClipMarkers, transitionLimit, setClipAudioStream as tlSetClipAudioStream, type NewClipSpec, type MediaDurationLookup,
} from '../../shared/timeline';
import { emptyHistory, pushHistory, undoHistory, redoHistory, changedSequenceIds, undoLabel, redoLabel } from './history';
import { proxyStreamStale } from '../playback/mediaSource';
import type {
  RecutStore, StoreState, UIState, Recipe, SelectMode, Tool, DialogName, ToastKind, SequenceSettingsPatch,
} from './types';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isPosInt(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) > 0; }

/**
 * A sequence settings patch keeps the invariants normalizeProject enforces on load (shared/project.ts
 * repairSequence): fps passes isValidFps; width / height / sampleRate / channels are positive safe integers;
 * name is a string; versionLabel a string or undefined; binId a string or null. Any other key or value: false.
 */
export function isValidSequenceSettingsPatch(patch: SequenceSettingsPatch): boolean {
  if (!patch || typeof patch !== 'object') return false;
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'fps': if (!isValidFps(v)) return false; break;
      case 'width': case 'height': case 'sampleRate': case 'channels': if (!isPosInt(v)) return false; break;
      case 'name': if (typeof v !== 'string') return false; break;
      case 'versionLabel': if (v !== undefined && typeof v !== 'string') return false; break;
      case 'binId': if (v !== null && typeof v !== 'string') return false; break;
      default: return false;
    }
  }
  return true;
}

export function initialUi(): UIState {
  return {
    tool: 'select',
    selectedClipIds: [],
    selectedTransitionId: null,
    selectedMediaIds: [],
    selectedSceneIds: [],
    selectedBinId: null,
    selectedMarkerId: null,
    sourceClip: null,
    activePanel: 'project',
    timelineFocus: false,
    filters: { characters: [], plotlines: [], locations: [], tags: [], mode: 'highlight' },
    compare: { sequenceA: null, sequenceB: null, open: false },
    dialogs: { export: false, relink: false, shortcuts: false, newSequence: false, preferences: false },
    toasts: [],
  };
}

/**
 * Selection-ish UI state that is reset when a different project is loaded. Modal dialogs close too: they hold
 * state read from the project that was open (e.g. the Export dialog's settings / range / output name).
 */
function resetSelectionUi(ui: UIState): UIState {
  const dialogs = { ...ui.dialogs };
  for (const k of Object.keys(dialogs) as (keyof UIState['dialogs'])[]) dialogs[k] = false;
  return {
    ...ui, dialogs,
    selectedClipIds: [], selectedTransitionId: null, selectedMediaIds: [], selectedSceneIds: [],
    selectedBinId: null, selectedMarkerId: null, sourceClip: null,
    filters: { characters: [], plotlines: [], locations: [], tags: [], mode: ui.filters.mode },
    compare: { sequenceA: null, sequenceB: null, open: false },
  };
}

/** Still-image extensions; the same list as IMAGE_EXT in electron/media/probe.ts (tests/unit/stills.test.ts). */
export const STILL_IMAGE_EXTS: readonly string[] = [
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic', 'heif', 'avif',
  'jxl', 'tga', 'exr', 'psd', 'dpx', 'sgi', 'pcx', 'ppm', 'pgm', 'pbm', 'pam', 'qoi', 'hdr', 'jp2', 'j2k',
];
const STILL_IMAGE_CODECS: readonly string[] = [
  'png', 'apng', 'mjpeg', 'jpegls', 'webp', 'bmp', 'tiff', 'gif', 'jpegxl', 'targa', 'exr', 'psd', 'dpx', 'sgi', 'pcx',
  'ppm', 'pgm', 'pgmyuv', 'pbm', 'pam', 'qoi', 'hdr', 'jpeg2000', 'av1', 'hevc',
];

/**
 * Media kind from a probe; mirrors classifyKind in electron/media/probe.ts. The main process marks stills (an image
 * demuxer, or a single picture from an image file: AVIF / HEIC / one-frame GIF) with playabilityReason 'still image'.
 * A probe without the mark (saved by an older version) is a still when it has a picture without duration or audio from
 * an image file or image codec. An animated GIF has a duration and frames: a video (it plays through a proxy).
 */
export function kindFromProbe(p: MediaProbe, path = ''): MediaKind {
  if (p.video) {
    if (p.playabilityReason === 'still image' || /_pipe$|^image2/i.test(p.container)) return 'image';
    const m = /\.([^./\\]+)$/.exec(path);
    const ext = m ? m[1].toLowerCase() : '';
    if (!(p.duration > 0) && p.audio.length === 0 && (STILL_IMAGE_EXTS.includes(ext) || STILL_IMAGE_CODECS.includes(p.video.codec))) return 'image';
    return 'video';
  }
  if (p.audio.length > 0) return 'audio';
  if (p.subtitles.length > 0) return 'subtitle';
  return 'unknown';
}

export function mediaDurationLookup(project: Project): MediaDurationLookup {
  return (id) => {
    const m = project.media[id];
    if (!m || m.kind === 'image') return Infinity;
    return m.probe?.duration ?? Infinity;
  };
}

/** Drop UI references to things that no longer exist in the project. Returns the same object when nothing changed. */
function pruneUi(project: Project, ui: UIState): UIState {
  let next = ui;
  const seq = project.activeSequenceId ? project.sequences[project.activeSequenceId] : undefined;
  if (ui.selectedClipIds.length || ui.selectedTransitionId) {
    const clipIds = new Set<ID>(); const trIds = new Set<ID>();
    if (seq) for (const t of allTracks(seq)) { for (const c of t.clips) clipIds.add(c.id); for (const tr of t.transitions) trIds.add(tr.id); }
    const kept = ui.selectedClipIds.filter((id) => clipIds.has(id));
    if (kept.length !== ui.selectedClipIds.length) next = { ...next, selectedClipIds: kept };
    if (ui.selectedTransitionId && !trIds.has(ui.selectedTransitionId)) next = { ...next, selectedTransitionId: null };
  }
  if (ui.selectedMarkerId && !(seq && seq.markers.some((m) => m.id === ui.selectedMarkerId))) next = { ...next, selectedMarkerId: null };
  if (ui.selectedMediaIds.length) {
    const kept = ui.selectedMediaIds.filter((id) => project.media[id]);
    if (kept.length !== ui.selectedMediaIds.length) next = { ...next, selectedMediaIds: kept };
  }
  if (ui.selectedSceneIds.length) {
    const kept = ui.selectedSceneIds.filter((id) => project.scenes[id]);
    if (kept.length !== ui.selectedSceneIds.length) next = { ...next, selectedSceneIds: kept };
  }
  if (ui.selectedBinId && !project.bins[ui.selectedBinId]) next = { ...next, selectedBinId: null };
  if (ui.sourceClip && !project.media[ui.sourceClip.mediaId]) next = { ...next, sourceClip: null };
  return next;
}

function applySelect(list: ID[], ids: ID[], mode: SelectMode): ID[] {
  switch (mode) {
    case 'clear': return [];
    case 'add': { const s = new Set(list); for (const id of ids) s.add(id); return [...s]; }
    case 'toggle': { const s = new Set(list); for (const id of ids) { if (s.has(id)) s.delete(id); else s.add(id); } return [...s]; }
    default: return [...ids];
  }
}

function addToVocab(tags: TagVocabulary, kind: keyof TagVocabulary, values: string[] | undefined): void {
  if (!values) return;
  for (const v of values) { const t = v.trim(); if (t && !tags[kind].includes(t)) tags[kind].push(t); }
}

function plainClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** Resolved [start,end) frames of a sequence subtitle cue, or null when it cannot be placed. */
function cueFrames(seq: Sequence, cue: SequenceSubtitleCue): { start: number; end: number; clip?: Clip } | null {
  if (cue.clipId) {
    const clip = findClip(seq, cue.clipId)?.clip;
    if (!clip || cue.srcStart === undefined || cue.srcEnd === undefined) return null;
    const toF = (sec: number) => clip.start + Math.round((sec - clip.sourceIn) / clip.speed * seq.fps.num / seq.fps.den) + cue.offset;
    return { start: toF(cue.srcStart), end: toF(cue.srcEnd), clip };
  }
  return { start: cue.start + cue.offset, end: cue.start + cue.duration + cue.offset };
}

function findCue(seq: Sequence, cueId: ID): { track: SequenceSubtitleTrack; cue: SequenceSubtitleCue; index: number } | null {
  for (const track of seq.subtitleTracks) {
    const index = track.cues.findIndex((c) => c.id === cueId);
    if (index >= 0) return { track, cue: track.cues[index], index };
  }
  return null;
}

function findTransition(seq: Sequence, id: ID): { track: Track; transition: Transition } | null {
  for (const track of allTracks(seq)) {
    const transition = track.transitions.find((t) => t.id === id);
    if (transition) return { track, transition };
  }
  return null;
}

/** Deep-clone a sequence with fresh ids for everything, keeping link groups / transition / cue references consistent. */
export function cloneSequenceWithNewIds(src: Sequence, newName: string): Sequence {
  const copy = plainClone<Sequence>({ ...src, snapshots: [] });
  const clipMap = new Map<ID, ID>();
  const linkMap = new Map<ID, ID>();
  const mapClip = (id: ID) => { let n = clipMap.get(id); if (!n) { n = uid('clip'); clipMap.set(id, n); } return n; };
  const mapLink = (id: ID) => { let n = linkMap.get(id); if (!n) { n = uid('link'); linkMap.set(id, n); } return n; };
  for (const t of [...copy.videoTracks, ...copy.audioTracks]) {
    t.id = uid(t.kind === 'video' ? 'v' : 'a');
    for (const c of t.clips) { c.id = mapClip(c.id); if (c.linkId) c.linkId = mapLink(c.linkId); }
    for (const tr of t.transitions) {
      tr.id = uid('tr');
      tr.outClipId = tr.outClipId ? mapClip(tr.outClipId) : null;
      tr.inClipId = tr.inClipId ? mapClip(tr.inClipId) : null;
    }
  }
  for (const st of copy.subtitleTracks) {
    st.id = uid('sst');
    for (const c of st.cues) { c.id = uid('scue'); if (c.clipId) c.clipId = clipMap.get(c.clipId) ?? c.clipId; }
  }
  for (const m of copy.markers) { m.id = uid('mk'); if (m.clipId) m.clipId = clipMap.get(m.clipId) ?? m.clipId; }
  for (const b of copy.storyBlocks) b.id = uid('sb');
  const now = Date.now();
  copy.id = uid('seq');
  copy.name = newName;
  copy.createdAt = now;
  copy.modifiedAt = now;
  copy.parentSequenceId = src.id;
  copy.view = new LiveView(copy.view); // own (non-shared, never frozen) view object
  return copy;
}

// ------------------------------------------------------------------
// Freezing an opened project in idle slices
// ------------------------------------------------------------------
//
// immer auto-freezes what it produces, and its finalize step deep-walks every value of the result that is not
// frozen yet. A project from loadProjectData (parsed from the file) starts unfrozen, so the first produce after an
// open used to walk and freeze the whole project in one task: about 370 ms on a 2,500-clip project, paid by the
// first edit. Instead, loadProjectData starts a walk that freezes the project in idle slices; a produce afterwards
// only meets frozen values, which immer skips.
//
// Children are frozen before their parent (post-order), so "frozen" always means "frozen all the way down": that
// is what immer assumes when it skips a frozen value, and what shared/timeline.ts (isOriginalItem / patchItem)
// assumes of a frozen base array or item. Only what immer itself freezes is frozen (isDraftable values: plain
// objects and arrays here); a sequence's LiveView is a class instance and stays mutable (setView's fast path).
// Every store write that produces from the project finishes a pending walk first (settleProjectFreeze), with this
// walker, which is several times cheaper than immer's finalize walk, so an edit that lands before the idle walk is
// done still finds a fully frozen project and is never slower than it was without the walk.

/**
 * Longest stretch of one idle freeze slice, well under the 50 ms long-task mark. A slice uses the idle time the
 * browser offers up to this cap (one slice per idle period: a callback requested during an idle period runs in the
 * next one); a slice forced by the timeout runs FREEZE_FORCED_SLICE_MS.
 */
const FREEZE_SLICE_MS = 24;
const FREEZE_FORCED_SLICE_MS = 8;
/** Upper bound (ms) an idle slice waits for idle time before it runs anyway. */
const FREEZE_IDLE_TIMEOUT_MS = 100;

/** Post-order walk state: a stack of objects, their child values and the next child index. */
interface FreezeWalk { objs: object[]; vals: unknown[][]; idx: number[] }

let pendingFreeze: FreezeWalk | null = null;

function childValues(o: object): unknown[] { return Array.isArray(o) ? o : Object.values(o); }

/** Plain object or plain array: the project's data, frozen with Object.freeze directly (immer's freeze is slower). */
function isPlainData(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === Array.prototype || proto === null;
}

/** Freezes what immer would freeze, children first. Returns true when done, false when `budgetMs` ran out first. */
function runFreezeWalk(w: FreezeWalk, budgetMs = Infinity): boolean {
  const { objs, vals, idx } = w;
  const end = performance.now() + budgetMs;
  let n = 0;
  while (objs.length) {
    if ((++n & 255) === 0 && budgetMs !== Infinity && performance.now() >= end) return false;
    const top = objs.length - 1;
    const vs = vals[top];
    let i = idx[top];
    let child: object | null = null;
    while (i < vs.length) {
      const v = vs[i++];
      if (v !== null && typeof v === 'object' && !Object.isFrozen(v) && (isPlainData(v) || isDraftable(v))) { child = v; break; }
    }
    if (child) { idx[top] = i; objs.push(child); vals.push(childValues(child)); idx.push(0); continue; }
    const o = objs[top]; // shallow freeze: every child is frozen already
    if (isPlainData(o)) Object.freeze(o); else freeze(o); // immer's freeze also guards Map / Set mutators
    objs.pop(); vals.pop(); idx.pop();
  }
  return true;
}

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining(): number };
type IdleScheduler = (cb: (d?: IdleDeadlineLike) => void) => void;
/** requestIdleCallback in the renderer; a plain macrotask where there is none (node / vitest). */
const scheduleIdle: IdleScheduler = (cb) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: FREEZE_IDLE_TIMEOUT_MS });
  else setTimeout(cb, 0);
};

/** Start freezing `project` in idle slices (replaces any walk still pending for an earlier project). */
function freezeInIdleSlices(project: Project): void {
  if (Object.isFrozen(project)) { pendingFreeze = null; return; }
  const walk: FreezeWalk = { objs: [project], vals: [childValues(project)], idx: [0] };
  pendingFreeze = walk;
  const slice = (d?: IdleDeadlineLike) => {
    if (pendingFreeze !== walk) return; // finished by settleProjectFreeze, or another project was loaded
    const budget = d && !d.didTimeout ? Math.min(FREEZE_SLICE_MS, Math.max(1, d.timeRemaining() - 1)) : FREEZE_FORCED_SLICE_MS;
    if (runFreezeWalk(walk, budget)) pendingFreeze = null;
    else scheduleIdle(slice);
  };
  scheduleIdle(slice);
}

/**
 * Finish the pending idle freeze of an opened project now (no-op when none is pending). Called before every
 * produce from the store's project so immer never walks an unfrozen opened project itself.
 */
export function settleProjectFreeze(): void {
  const w = pendingFreeze;
  if (!w) return;
  pendingFreeze = null;
  runFreezeWalk(w);
}

/** True while an opened project is still being frozen in idle slices (tests / perf diagnostics). */
export function projectFreezePending(): boolean { return pendingFreeze !== null; }

// ------------------------------------------------------------------
// Store
// ------------------------------------------------------------------

function initialState(): StoreState {
  return {
    project: createProject(),
    projectPath: null,
    dirty: false,
    revision: 0,
    loadedRevision: 0,
    history: emptyHistory(),
    transaction: null,
    ui: initialUi(),
    jobs: [],
    playback: { playing: false, rate: 1 },
    viewTick: 0,
  };
}

export const useStore = create<RecutStore>()((set, get) => {
  /**
   * Stamp modifiedAt on the project and on sequences whose identity changed; clip-anchored markers /
   * continuity notes in those sequences follow their clip (see followClipMarkers).
   */
  const stamp = (prev: Project, next: Project, followMarkers = true): Project => {
    const changed = changedSequenceIds(prev, next);
    const now = Date.now();
    return produce(next, (d) => {
      d.modifiedAt = now;
      for (const id of changed) {
        const seq = d.sequences[id];
        if (!seq) continue;
        seq.modifiedAt = now;
        if (followMarkers && prev.sequences[id]) followClipMarkers(prev.sequences[id], seq);
      }
    });
  };

  /** `followMarkers: false` for recipes that replace a sequence wholesale (its markers are already right). */
  const commit = (label: string, recipe: Recipe, opts: { followMarkers?: boolean } = {}): boolean => {
    settleProjectFreeze();
    const prev = get().project;
    const produced = produce(prev, recipe);
    if (produced === prev) return false;
    const next = stamp(prev, produced, opts.followMarkers ?? true);
    set((s) => ({ project: next, dirty: true, revision: s.revision + 1, history: pushHistory(s.history, prev, label), ui: pruneUi(next, s.ui) }));
    return true;
  };

  /** Apply a recipe without touching history (view / active sequence / transient drags / job status mirrors). */
  const quiet = (recipe: Recipe, opts: { dirty?: boolean } = {}): void => {
    settleProjectFreeze();
    const prev = get().project;
    const next = produce(prev, recipe);
    if (next === prev) return;
    set((s) => ({ project: next, ui: pruneUi(next, s.ui), ...(opts.dirty ? { dirty: true, revision: s.revision + 1 } : {}) }));
  };

  const activeId = (seqId?: ID): ID | null => seqId ?? get().project.activeSequenceId;
  const seqOf = (seqId?: ID): Sequence | null => { const id = activeId(seqId); return id ? get().project.sequences[id] ?? null : null; };
  /** Duplicate a sequence as the next version (optionally ripple-removing its disabled clips) in one undo step. */
  const duplicateSeq = (id: ID, newName: string, label: string, withoutDisabled: boolean): ID | null => {
    const src = get().project.sequences[id];
    if (!src) return null;
    const copy = cloneSequenceWithNewIds(src, newName);
    if (withoutDisabled) rippleDeleteDisabledClips(copy);
    commit(label, (d) => {
      const siblings = Object.values(d.sequences).filter((s) => s.parentSequenceId === id || s.id === id).length;
      copy.versionLabel = `v${siblings + 1}`;
      d.sequences[copy.id] = copy;
      const at = d.sequenceOrder.indexOf(id);
      d.sequenceOrder.splice(at >= 0 ? at + 1 : d.sequenceOrder.length, 0, copy.id);
      d.activeSequenceId = copy.id;
    });
    return copy.id;
  };
  /** Selected clips in track order; inside a recipe they may be written to (only these are drafted). */
  const selectedIn = (seq: Sequence, ids: ID[]): Clip[] => clipsWithIds(seq, ids);

  /** Media relinked since their last probe result: the next probe fits their clips to the new file. */
  const relinkAwaitingProbe = new Set<ID>();
  /**
   * After a relink to a shorter file: clips that now run past the media end are trimmed to it, and clips that
   * start past it are removed (one undo step, with a warning toast). Locked tracks are included: the clips
   * would otherwise reference source time the file does not have (playback freezes, export clones the last
   * frame). Returns { trimmed, removed }.
   */
  const fitClipsToRelinkedMedia = (mediaId: ID): { trimmed: number; removed: number } => {
    const res = { trimmed: 0, removed: 0 };
    const m = get().project.media[mediaId];
    const dur = m?.probe?.duration;
    if (!m || m.kind === 'image' || typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0) return res;
    commit('Fit clips to relinked media', (d) => {
      for (const seq of Object.values(d.sequences)) {
        const removed = new Set<ID>();
        let changed = false;
        for (const t of allTracks(seq)) {
          const before = removed.size;
          for (const c of t.clips) {
            if (c.mediaId !== mediaId) continue;
            const fit = maxDurationFrom(c.sourceIn, c.speed, dur, seq.fps);
            if (c.duration <= fit) continue;
            changed = true;
            if (fit >= MIN_CLIP_FRAMES) { c.duration = fit; res.trimmed++; } else { removed.add(c.id); res.removed++; }
          }
          if (removed.size !== before) t.clips = t.clips.filter((c) => !removed.has(c.id));
        }
        if (!changed) continue;
        if (removed.size) for (const st of seq.subtitleTracks) st.cues = st.cues.filter((c) => !(c.clipId && removed.has(c.clipId)));
        reconcileAll(seq);
      }
    });
    if (res.trimmed || res.removed) {
      const n = (k: number) => `${k} clip${k === 1 ? '' : 's'}`;
      const parts: string[] = [];
      if (res.trimmed) parts.push(`trimmed ${n(res.trimmed)} that ran past the end of the file`);
      if (res.removed) parts.push(`removed ${n(res.removed)} that started past the end of the file`);
      get().toast('warning', `"${m.name}" is shorter after the relink: ${parts.join(', ')}`);
    }
    return res;
  };

  const setUi = (patch: Partial<UIState> | ((ui: UIState) => Partial<UIState>)) =>
    set((s) => ({ ui: { ...s.ui, ...(typeof patch === 'function' ? patch(s.ui) : patch) } }));

  return {
    ...initialState(),

    // ---------------------------------------------------------------- undo model
    commit,
    quiet,
    undo() {
      const s = get();
      if (s.transaction) return false;
      settleProjectFreeze();
      const step = undoHistory(s.history, s.project);
      if (!step) return false;
      set({ project: step.project, history: step.history, dirty: true, revision: s.revision + 1, ui: pruneUi(step.project, s.ui) });
      return true;
    },
    redo() {
      const s = get();
      if (s.transaction) return false;
      settleProjectFreeze();
      const step = redoHistory(s.history, s.project);
      if (!step) return false;
      set({ project: step.project, history: step.history, dirty: true, revision: s.revision + 1, ui: pruneUi(step.project, s.ui) });
      return true;
    },
    canUndo() { return get().history.past.length > 0; },
    canRedo() { return get().history.future.length > 0; },
    clearHistory() { set((s) => ({ history: emptyHistory(s.history.limit) })); },

    setView(seqId, patch) {
      const cur = get().project.sequences[seqId];
      if (!cur) return;
      const v = cur.view;
      // Hot path (playback / scrubbing / wheel): playhead and scroll are mutated in place. No new project or
      // sequence reference, so panels selecting `sequences` / a sequence do not re-render; `viewTick` makes
      // zustand re-run selectors so consumers of the primitive (`usePlayhead`) update. Not dirty, no history.
      if (patch.zoom === undefined && patch.inPoint === undefined && patch.outPoint === undefined && !Object.isFrozen(v)) {
        let changed = false;
        if (patch.playhead !== undefined) {
          const ph = Math.max(0, Math.round(patch.playhead));
          if (ph !== v.playhead) { v.playhead = ph; changed = true; }
        }
        if (patch.scroll !== undefined) {
          const sc = Math.max(0, patch.scroll);
          if (sc !== v.scroll) { v.scroll = sc; changed = true; }
        }
        if (changed) set((s) => ({ viewTick: s.viewTick + 1 }));
        return;
      }
      // Zoom / in / out (or a frozen plain view): replace the view object so every consumer of the sequence
      // re-renders. The new view is a LiveView (never frozen), so later playhead moves take the fast path.
      settleProjectFreeze();
      const prev = get().project;
      const next = produce(prev, (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const nv: SequenceView = { ...seq.view };
        if (patch.playhead !== undefined) nv.playhead = Math.max(0, Math.round(patch.playhead));
        if (patch.zoom !== undefined) nv.zoom = patch.zoom;
        if (patch.scroll !== undefined) nv.scroll = Math.max(0, patch.scroll);
        if (patch.inPoint !== undefined) nv.inPoint = patch.inPoint === null ? null : Math.max(0, Math.round(patch.inPoint));
        if (patch.outPoint !== undefined) nv.outPoint = patch.outPoint === null ? null : Math.max(0, Math.round(patch.outPoint));
        if (nv.inPoint !== null && nv.outPoint !== null && nv.outPoint < nv.inPoint) {
          const t = nv.inPoint; nv.inPoint = nv.outPoint; nv.outPoint = t;
        }
        const ov = seq.view;
        if (ov instanceof LiveView && nv.playhead === ov.playhead && nv.zoom === ov.zoom && nv.scroll === ov.scroll && nv.inPoint === ov.inPoint && nv.outPoint === ov.outPoint) return;
        seq.view = new LiveView(nv);
      });
      if (next !== prev) set((s) => ({ project: next, viewTick: s.viewTick + 1 }));
    },

    beginTransaction() {
      if (get().transaction) return;
      set({ transaction: get().project });
    },
    updateTransient(recipe) {
      if (!get().transaction) set({ transaction: get().project });
      quiet(recipe);
    },
    endTransaction(label) {
      const s = get();
      const snapshot = s.transaction;
      if (!snapshot) return false;
      if (snapshot === s.project) { set({ transaction: null }); return false; }
      settleProjectFreeze();
      const next = stamp(snapshot, s.project);
      set({ project: next, transaction: null, dirty: true, revision: s.revision + 1, history: pushHistory(s.history, snapshot, label), ui: pruneUi(next, s.ui) });
      return true;
    },
    cancelTransaction() {
      const s = get();
      if (!s.transaction) return;
      set({ project: s.transaction, transaction: null, ui: pruneUi(s.transaction, s.ui) });
    },

    // ---------------------------------------------------------------- project
    newProject(name = 'Untitled Project') {
      relinkAwaitingProbe.clear();
      pendingFreeze = null; // a walk still freezing the previous project is not needed any more
      set((s) => ({
        project: createProject(name), projectPath: null, dirty: false, revision: s.revision + 1, loadedRevision: s.revision + 1,
        history: emptyHistory(s.history.limit),
        transaction: null, ui: resetSelectionUi(s.ui), playback: { playing: false, rate: 1 },
      }));
    },
    loadProjectData(project, path) {
      relinkAwaitingProbe.clear();
      set((s) => ({
        project, projectPath: path, dirty: false, revision: s.revision + 1, loadedRevision: s.revision + 1,
        history: emptyHistory(s.history.limit), transaction: null,
        ui: pruneUi(project, resetSelectionUi(s.ui)), playback: { playing: false, rate: 1 },
      }));
      // Opened projects arrive unfrozen: freeze them off the critical path, so the first edit does not pay for it.
      freezeInIdleSlices(project);
    },
    markSaved(path, revision) {
      set((s) => {
        if (revision === undefined || revision === s.revision) return { projectPath: path, dirty: false };
        if (revision < s.loadedRevision) return {}; // that save wrote a project since replaced by new / open
        return { projectPath: path }; // the file is this project's, without the edits made during the save
      });
    },
    setSettings(patch) { commit('Change settings', (d) => { Object.assign(d.settings, patch); }); },
    renameProject(name) { commit('Rename project', (d) => { d.name = name; }); },

    // ---------------------------------------------------------------- bins
    addBin(name, parentId = null, kind = 'bin') {
      const id = uid('bin');
      commit('New bin', (d) => { d.bins[id] = { id, name, parentId: parentId && d.bins[parentId] ? parentId : null, kind }; });
      return id;
    },
    renameBin(id, name) { commit('Rename bin', (d) => { const b = d.bins[id]; if (b) b.name = name; }); },
    deleteBin(id) {
      commit('Delete bin', (d) => {
        const bin = d.bins[id];
        if (!bin) return;
        const parent = bin.parentId;
        for (const b of Object.values(d.bins)) if (b.parentId === id) b.parentId = parent;
        for (const m of Object.values(d.media)) if (m.binId === id) m.binId = parent;
        for (const s of Object.values(d.sequences)) if (s.binId === id) s.binId = parent;
        delete d.bins[id];
      });
    },
    moveToBin(ids, binId) {
      commit('Move to bin', (d) => {
        const target = binId && d.bins[binId] ? binId : null;
        for (const id of ids) {
          if (d.media[id]) d.media[id].binId = target;
          else if (d.sequences[id]) d.sequences[id].binId = target;
          else if (d.bins[id] && id !== target) {
            // prevent cycles: a bin cannot be moved into its own subtree
            let p: ID | null = target; let cycle = false;
            while (p) { if (p === id) { cycle = true; break; } p = d.bins[p]?.parentId ?? null; }
            if (!cycle) d.bins[id].parentId = target;
          }
        }
      });
    },
    organizeAsSeries(items, series, season) {
      let seriesBinId = ''; let seasonBinId = '';
      const entries = items.map((it) => (typeof it === 'string' ? { id: it } : it));
      commit('Organize as series', (d) => {
        const tvParent = d.bins['bin-tv'] ? 'bin-tv' : null;
        let seriesBin = Object.values(d.bins).find((b) => b.kind === 'series' && b.name === series);
        if (!seriesBin) { seriesBin = { id: uid('bin'), name: series, parentId: tvParent, kind: 'series' }; d.bins[seriesBin.id] = seriesBin; }
        const seasonName = `Season ${season}`;
        let seasonBin = Object.values(d.bins).find((b) => b.kind === 'season' && b.parentId === seriesBin!.id && b.name === seasonName);
        if (!seasonBin) { seasonBin = { id: uid('bin'), name: seasonName, parentId: seriesBin.id, kind: 'season' }; d.bins[seasonBin.id] = seasonBin; }
        seriesBinId = seriesBin.id; seasonBinId = seasonBin.id;
        for (const it of entries) {
          const m = d.media[it.id];
          if (!m) continue;
          m.identity.series = series;
          m.identity.season = season;
          if (it.episode !== undefined) m.identity.episode = it.episode;
          if (it.title !== undefined) { if (it.title) m.identity.title = it.title; else delete m.identity.title; }
          if (m.category === 'Other' || m.category === 'Movie') m.category = 'Episode';
          m.binId = seasonBin.id;
        }
      });
      return { seriesBinId, seasonBinId };
    },

    // ---------------------------------------------------------------- media
    addMedia(items) {
      if (items.length === 0) return;
      commit(items.length === 1 ? 'Import media' : `Import ${items.length} media files`, (d) => {
        for (const it of items) d.media[it.id] = it;
      });
    },
    updateMedia(id, patch) {
      commit('Edit media', (d) => {
        const m = d.media[id];
        if (!m) return;
        const { identity, ...rest } = patch;
        const prevStream = m.preferredAudioStream;
        Object.assign(m, rest, { id });
        // A proxy built for another audio stream would preview the wrong track: mark it stale (Generate again).
        if ('preferredAudioStream' in rest && m.preferredAudioStream !== prevStream && proxyStreamStale(m)) m.proxy = { status: 'none' };
        if (identity) {
          // Merge over the current identity; an explicit `undefined` clears that field.
          const merged: Record<string, unknown> = { ...m.identity };
          for (const [k, v] of Object.entries(identity)) { if (v === undefined) delete merged[k]; else merged[k] = v; }
          m.identity = merged as MediaItem['identity'];
        }
        addToVocab(d.tags, 'custom', patch.tags);
      });
    },
    removeMedia(ids) {
      const idSet = new Set(ids);
      commit(ids.length === 1 ? 'Remove media' : `Remove ${ids.length} media items`, (d) => {
        for (const id of ids) {
          const m = d.media[id];
          if (!m) continue;
          for (const tid of m.subtitleTrackIds) delete d.subtitleTracks[tid];
          delete d.media[id];
        }
        for (const st of Object.values(d.subtitleTracks)) if (st.mediaId && idSet.has(st.mediaId)) delete d.subtitleTracks[st.id];
        for (const sc of Object.values(d.scenes)) if (idSet.has(sc.mediaId)) delete d.scenes[sc.id];
        for (const seq of Object.values(d.sequences)) {
          const removedClips = new Set<ID>();
          for (const t of allTracks(seq)) {
            // Raw scan (no proxy per clip); only tracks that lose a clip get a new array.
            const items = readItems(t.clips);
            if (!items.some((c) => idSet.has(c.mediaId))) continue;
            t.clips = items.filter((c) => { if (idSet.has(c.mediaId)) { removedClips.add(c.id); return false; } return true; });
            reconcileTransitions(t);
          }
          if (removedClips.size) for (const st of seq.subtitleTracks) st.cues = st.cues.filter((c) => !(c.clipId && removedClips.has(c.clipId)));
        }
      });
    },
    setMediaProbe(id, result) {
      // Probe results arrive asynchronously after the import step: a job mirror, not an undo step.
      const afterRelink = relinkAwaitingProbe.delete(id);
      quiet((d) => {
        const m = d.media[id];
        if (!m) return;
        if ('error' in result) { m.probeError = result.error; m.probe = undefined; return; }
        m.probe = result;
        m.probeError = undefined;
        m.offline = false;
        m.kind = kindFromProbe(result, m.path);
        if (m.preferredAudioStream === undefined && result.audio.length) m.preferredAudioStream = result.audio[0].index;
      }, { dirty: true });
      // The first probe of a relinked file: fit clips that now run past its end (an undoable step of its own).
      if (afterRelink && !('error' in result)) fitClipsToRelinkedMedia(id);
    },
    // Job/status mirrors are quiet: they arrive asynchronously and must not become undo steps (nor clear redo).
    setProxy(id, proxy) { quiet((d) => { const m = d.media[id]; if (m) m.proxy = proxy; }, { dirty: true }); },
    invalidateProxy(id) {
      // A "ready" proxy whose file is gone/unreadable: forget it so playback falls back to the original.
      quiet((d) => { const m = d.media[id]; if (m && m.proxy.status !== 'none') m.proxy = { status: 'none' }; }, { dirty: true });
    },
    setSceneDetectStatus(id, status) { quiet((d) => { const m = d.media[id]; if (m) m.sceneDetectStatus = status; }, { dirty: true }); },
    setDetectedScenes(id, boundaries, duration) {
      // Detection results also arrive from a background job; edits to the scenes (rename/merge/split) stay undoable.
      quiet((d) => {
        const m = d.media[id];
        if (!m) return;
        const cuts = [...new Set(boundaries.filter((b) => b > 0 && b < duration))].sort((a, b) => a - b);
        const edges = [0, ...cuts, duration];
        const scenes: DetectedScene[] = [];
        for (let i = 0; i < edges.length - 1; i++) {
          if (edges[i + 1] - edges[i] <= 0) continue;
          scenes.push({ id: uid('dsc'), start: edges[i], end: edges[i + 1], name: `Scene ${String(scenes.length + 1).padStart(3, '0')}`, tags: [], characters: [] });
        }
        m.detectedScenes = scenes;
        m.sceneDetectStatus = 'done';
      }, { dirty: true });
    },
    renameDetectedScene(mediaId, sceneId, name) {
      commit('Rename scene', (d) => { const s = d.media[mediaId]?.detectedScenes.find((x) => x.id === sceneId); if (s) s.name = name; });
    },
    mergeDetectedScenes(mediaId, sceneIds) {
      commit('Merge scenes', (d) => {
        const m = d.media[mediaId];
        if (!m || sceneIds.length < 2) return;
        const want = new Set(sceneIds);
        const list = m.detectedScenes;
        const idx = list.map((s, i) => (want.has(s.id) ? i : -1)).filter((i) => i >= 0);
        if (idx.length < 2) return;
        // must be adjacent (contiguous indices)
        for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return;
        const first = list[idx[0]];
        for (let i = 1; i < idx.length; i++) {
          const s = list[idx[i]];
          first.end = Math.max(first.end, s.end);
          for (const t of s.tags) if (!first.tags.includes(t)) first.tags.push(t);
          for (const c of s.characters) if (!first.characters.includes(c)) first.characters.push(c);
        }
        m.detectedScenes = list.filter((s, i) => i === idx[0] || !want.has(s.id));
      });
    },
    splitDetectedScene(mediaId, sceneId, atSeconds) {
      commit('Split scene', (d) => {
        const m = d.media[mediaId];
        if (!m) return;
        const i = m.detectedScenes.findIndex((s) => s.id === sceneId);
        if (i < 0) return;
        const s = m.detectedScenes[i];
        if (atSeconds <= s.start || atSeconds >= s.end) return;
        const tail: DetectedScene = { id: uid('dsc'), start: atSeconds, end: s.end, name: `${s.name} (2)`, tags: [...s.tags], characters: [...s.characters] };
        s.end = atSeconds;
        m.detectedScenes.splice(i + 1, 0, tail);
      });
    },
    tagDetectedScene(mediaId, sceneId, patch) {
      commit('Tag scene', (d) => {
        const s = d.media[mediaId]?.detectedScenes.find((x) => x.id === sceneId);
        if (!s) return;
        if (patch.tags) { s.tags = [...patch.tags]; addToVocab(d.tags, 'custom', patch.tags); }
        if (patch.characters) { s.characters = [...patch.characters]; addToVocab(d.tags, 'characters', patch.characters); }
      });
    },
    deleteDetectedScene(mediaId, sceneId) {
      commit('Delete scene', (d) => { const m = d.media[mediaId]; if (m) m.detectedScenes = m.detectedScenes.filter((s) => s.id !== sceneId); });
    },
    relinkMedia(id, newPath, stat) {
      if (get().project.media[id]) relinkAwaitingProbe.add(id);
      quiet((d) => {
        const m = d.media[id];
        if (!m) return;
        m.path = newPath;
        m.offline = false;
        m.probeError = undefined;
        if (stat?.size !== undefined) m.fileSize = stat.size;
        if (stat?.mtimeMs !== undefined) m.fileMtime = stat.mtimeMs;
      }, { dirty: true });
    },
    setOffline(id, offline) { quiet((d) => { const m = d.media[id]; if (m) m.offline = offline; }); },
    addMediaSubtitleTrack(track) {
      commit('Add subtitles', (d) => {
        d.subtitleTracks[track.id] = track;
        if (track.mediaId) {
          const m = d.media[track.mediaId];
          if (m && !m.subtitleTrackIds.includes(track.id)) m.subtitleTrackIds.push(track.id);
        }
      });
    },
    removeMediaSubtitleTrack(trackId) {
      commit('Remove subtitles', (d) => {
        delete d.subtitleTracks[trackId];
        for (const m of Object.values(d.media)) m.subtitleTrackIds = m.subtitleTrackIds.filter((id) => id !== trackId);
      });
    },

    // ---------------------------------------------------------------- sequences
    addSequence(seq, opts = {}) {
      commit('New sequence', (d) => {
        if (seq.binId === null && d.bins['bin-sequences']) seq = { ...seq, binId: 'bin-sequences' };
        d.sequences[seq.id] = seq;
        if (!d.sequenceOrder.includes(seq.id)) d.sequenceOrder.push(seq.id);
        if (opts.activate ?? true) d.activeSequenceId = seq.id;
      });
    },
    duplicateSequence(id, newName) {
      return duplicateSeq(id, newName, 'Duplicate sequence', false);
    },
    duplicateWithoutDisabled(id, newName) {
      return duplicateSeq(id, newName, 'Duplicate as cut without disabled clips', true);
    },
    removeDisabledClips(seqId) {
      const seq = seqOf(seqId);
      if (!seq || !removableDisabledClipIds(seq).length) return 0;
      let removed = 0;
      commit('Remove disabled clips', (d) => { const s = d.sequences[seq.id]; if (s) removed = rippleDeleteDisabledClips(s); });
      return removed;
    },
    deleteSequence(id) {
      commit('Delete sequence', (d) => {
        if (!d.sequences[id]) return;
        const at = d.sequenceOrder.indexOf(id);
        delete d.sequences[id];
        d.sequenceOrder = d.sequenceOrder.filter((x) => x !== id);
        if (d.activeSequenceId === id) d.activeSequenceId = d.sequenceOrder[Math.min(Math.max(at, 0), d.sequenceOrder.length - 1)] ?? null;
      });
    },
    renameSequence(id, name) { commit('Rename sequence', (d) => { const s = d.sequences[id]; if (s) s.name = name; }); },
    setActiveSequence(id) {
      quiet((d) => { if (id === null || d.sequences[id]) d.activeSequenceId = id; });
    },
    takeSnapshot(seqId, name) {
      const snapId = uid('snap');
      const ok = commit('Take snapshot', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const { snapshots: _s, ...data } = current(seq);
        seq.snapshots.push({ id: snapId, name, createdAt: Date.now(), data });
      });
      return ok ? snapId : null;
    },
    restoreSnapshot(seqId, snapshotId) {
      commit('Restore snapshot', (d) => {
        const seq = d.sequences[seqId];
        const snap = seq?.snapshots.find((s) => s.id === snapshotId);
        if (!seq || !snap) return;
        const live = current(seq);
        d.sequences[seqId] = { ...plainClone(snap.data), id: seqId, snapshots: live.snapshots, view: live.view } as Sequence;
      }, { followMarkers: false });
    },
    deleteSnapshot(seqId, snapshotId) {
      commit('Delete snapshot', (d) => { const seq = d.sequences[seqId]; if (seq) seq.snapshots = seq.snapshots.filter((s) => s.id !== snapshotId); });
    },
    updateSequenceSettings(seqId, patch) {
      // An invalid patch is ignored as a whole (never half-applied, no undo step).
      if (!isValidSequenceSettingsPatch(patch)) return;
      commit('Sequence settings', (d) => {
        const seq = d.sequences[seqId];
        if (seq) Object.assign(seq, patch.fps ? { ...patch, fps: { num: patch.fps.num, den: patch.fps.den } } : patch);
      });
    },

    // ---------------------------------------------------------------- timeline
    insertFromSource(seqId, o) {
      let created: ID[] = [];
      let unpatched = false;
      commit(o.mode === 'insert' ? 'Insert' : 'Overwrite', (d) => {
        const seq = d.sequences[seqId];
        const media = d.media[o.mediaId];
        if (!seq || !media) return;
        const inS = Math.max(0, Math.min(o.in, o.out));
        const outS = Math.max(o.in, o.out);
        const speed = o.extra?.speed && o.extra.speed > 0 ? o.extra.speed : 1;
        // Rounding may add a frame the media does not have (a whole-clip insert: 240.72 frames -> 241). The trim
        // limits count whole frames available (floor): cap there, as the three-point edit does. A range that is
        // itself past the media end keeps plain rounding.
        const exact = (outS - inS) / speed * seq.fps.num / seq.fps.den;
        let duration = Math.max(MIN_CLIP_FRAMES, secondsToFrames((outS - inS) / speed, seq.fps));
        const fit = maxDurationFrom(inS, speed, mediaDurationLookup(d)(o.mediaId), seq.fps);
        if (duration > fit && Math.floor(exact + 1e-6) <= fit) duration = Math.max(MIN_CLIP_FRAMES, fit);
        const unprobed = media.kind === 'unknown' && !media.probe;
        const hasVideo = media.kind === 'video' || media.kind === 'image' || !!media.probe?.video || unprobed;
        const hasAudio = media.kind === 'audio' || (media.probe?.audio.length ?? 0) > 0 || unprobed;
        const includeVideo = (o.includeVideo ?? true) && hasVideo;
        const includeAudio = (o.includeAudio ?? true) && hasAudio;
        // Source patching (Premiere): unless the caller asks for a kind explicitly (includeX: true) or names
        // its track, a kind is only placed when one of its tracks is patched.
        const pick = (tracks: Track[], id: ID | undefined, explicit: boolean) => {
          if (id) return tracks.find((t) => t.id === id);
          const patched = tracks.find((t) => t.patched && !t.locked);
          return patched ?? (explicit ? tracks.find((t) => !t.locked) : undefined);
        };
        const vTrack = includeVideo ? pick(seq.videoTracks, o.videoTrackId, o.includeVideo === true) : undefined;
        const aTrack = includeAudio ? pick(seq.audioTracks, o.audioTrackId, o.includeAudio === true) : undefined;
        if (!vTrack && !aTrack) {
          if ((includeVideo && o.includeVideo === undefined && !o.videoTrackId) || (includeAudio && o.includeAudio === undefined && !o.audioTrackId)) unpatched = true;
          return;
        }
        const linkId = vTrack && aTrack ? uid('link') : null;
        const base: NewClipSpec = {
          mediaId: o.mediaId, name: media.name, sourceIn: inS, duration, kind: 'video',
          ...(o.extra ?? {}), speed, linkId,
        };
        const placements: { trackId: ID; clip: Clip }[] = [];
        let videoClip: Clip | undefined; let audioClip: Clip | undefined;
        const at = Math.max(0, Math.round(o.atFrame));
        if (vTrack) { videoClip = makeClip({ ...base, kind: 'video', audioStream: undefined }, at); placements.push({ trackId: vTrack.id, clip: videoClip }); }
        if (aTrack) {
          const stream = o.extra?.audioStream ?? media.preferredAudioStream ?? media.probe?.audio[0]?.index;
          audioClip = makeClip({ ...base, kind: 'audio', audioStream: stream }, at);
          placements.push({ trackId: aTrack.id, clip: audioClip });
        }
        if (!placeClips(seq, placements, o.mode)) return;
        created = placements.map((p) => p.clip.id);
        addToVocab(d.tags, 'characters', base.characters);
        addToVocab(d.tags, 'plotlines', base.plotlines);
        addToVocab(d.tags, 'locations', base.locations);
        addToVocab(d.tags, 'custom', base.tags);
        // Carry media subtitle cues overlapping [in,out] into the sequence, anchored to the new clip.
        const anchor = videoClip ?? audioClip;
        if (d.settings.carrySubtitles && anchor) {
          for (const tid of media.subtitleTrackIds) {
            const st = d.subtitleTracks[tid];
            if (!st) continue;
            const overlapping = readItems(st.cues).filter((c) => c.end > inS && c.start < outS); // read only: no drafts
            if (overlapping.length === 0) continue;
            // Tracks are named by language; untagged ('und') tracks take the media track's name (e.g. the SRT base name).
            const untagged = !st.language || st.language === 'und';
            const trackName = untagged ? (st.name?.replace(/\.[^./\\]+$/, '') || 'Subtitles') : st.language;
            let target = seq.subtitleTracks.find((t) => t.language === st.language && (!untagged || t.name === trackName));
            if (!target) {
              target = { id: uid('sst'), name: trackName, language: st.language, enabled: true, cues: [] };
              seq.subtitleTracks.push(target);
            }
            // The subtitle file stays a project source (exports never overwrite it) even after the media
            // track is removed (projectSourcePaths in src/panels/export/request.ts).
            if (typeof st.path === 'string' && st.path) {
              const sources = target.sourcePaths ?? [];
              if (!sources.includes(st.path)) target.sourcePaths = [...sources, st.path];
            }
            for (const cue of overlapping) {
              const s = anchor.start + Math.round((cue.start - inS) / speed * seq.fps.num / seq.fps.den);
              const e = anchor.start + Math.round((cue.end - inS) / speed * seq.fps.num / seq.fps.den);
              target.cues.push({ id: uid('scue'), clipId: anchor.id, srcStart: cue.start, srcEnd: cue.end, start: s, duration: Math.max(1, e - s), offset: 0, text: cue.text });
            }
            // Sort the raw items (same stable order) instead of drafting every cue of the track.
            target.cues = [...readItems(target.cues)].sort((a, b) => (a.srcStart ?? a.start) - (b.srcStart ?? b.start));
          }
        }
      });
      if (unpatched) get().toast('warning', 'No source tracks patched');
      return created;
    },
    placeClipsAction(seqId, placements, mode) {
      let ok = false;
      commit(mode === 'insert' ? 'Insert clips' : 'Overwrite clips', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        ok = placeClips(seq, placements.map((p) => ({ trackId: p.trackId, clip: plainClone(p.clip) })), mode);
      });
      return ok;
    },
    razor(seqId, frame, trackIds) {
      let created: ID[] = [];
      commit('Razor', (d) => { const seq = d.sequences[seqId]; if (seq) created = razorAt(seq, Math.round(frame), trackIds).map((c) => c.id); });
      return created;
    },
    razorAtPlayhead(seqId) {
      const seq = seqOf(seqId);
      if (!seq) return [];
      const frame = seq.view.playhead;
      const sel = selectedIn(seq, get().ui.selectedClipIds).filter((c) => c.start < frame && clipEnd(c) > frame);
      const trackIds = sel.length ? [...new Set(sel.map((c) => findClip(seq, c.id)!.track.id))] : undefined;
      return get().razor(seq.id, frame, trackIds);
    },
    deleteSelected(seqId) {
      const seq = seqOf(seqId);
      if (!seq) return;
      const { selectedClipIds, selectedTransitionId } = get().ui;
      if (!selectedClipIds.length && !selectedTransitionId) return;
      commit('Delete', (d) => {
        const s = d.sequences[seq.id];
        if (!s) return;
        if (selectedClipIds.length) tlRemoveClips(s, selectedClipIds);
        if (selectedTransitionId) tlRemoveTransition(s, selectedTransitionId);
      });
    },
    rippleDeleteSelected(seqId) {
      const seq = seqOf(seqId);
      if (!seq) return;
      const { selectedClipIds, selectedTransitionId } = get().ui;
      if (!selectedClipIds.length && !selectedTransitionId) return;
      commit('Ripple delete', (d) => {
        const s = d.sequences[seq.id];
        if (!s) return;
        if (selectedTransitionId) tlRemoveTransition(s, selectedTransitionId);
        if (selectedClipIds.length) rippleDeleteClips(s, selectedClipIds);
      });
    },
    liftInOut(seqId, trackIds) {
      const seq = seqOf(seqId);
      if (!seq || seq.view.inPoint === null || seq.view.outPoint === null || seq.view.outPoint <= seq.view.inPoint) return;
      const { inPoint, outPoint } = seq.view;
      commit('Lift', (d) => { const s = d.sequences[seq.id]; if (s) liftRange(s, inPoint, outPoint, trackIds); });
    },
    extractInOut(seqId, trackIds) {
      const seq = seqOf(seqId);
      if (!seq || seq.view.inPoint === null || seq.view.outPoint === null || seq.view.outPoint <= seq.view.inPoint) return;
      const { inPoint, outPoint } = seq.view;
      commit('Extract', (d) => { const s = d.sequences[seq.id]; if (s) extractRange(s, inPoint, outPoint, trackIds); });
    },
    trimClipEdge(seqId, clipId, edge, frame, ripple) {
      commit(ripple ? 'Ripple trim' : 'Trim', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const dur = mediaDurationLookup(d);
        const f = Math.round(frame);
        if (ripple) { if (edge === 'start') rippleTrimStart(seq, clipId, f, dur); else rippleTrimEnd(seq, clipId, f, dur); return; }
        const loc = findClip(seq, clipId);
        if (!loc) return;
        const anchor = edge === 'start' ? loc.clip.start : clipEnd(loc.clip);
        const group = linkedClips(seq, loc.clip).filter((c) => (edge === 'start' ? c.start : clipEnd(c)) === anchor);
        for (const g of group) { if (edge === 'start') trimStart(seq, g.id, f, dur); else trimEnd(seq, g.id, f, dur); }
      });
    },
    rollEdit(seqId, outClipId, inClipId, frame) {
      commit('Rolling edit', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const dur = mediaDurationLookup(d);
        const a = findClip(seq, outClipId); const b = findClip(seq, inClipId);
        if (!a || !b) return;
        // roll linked partners that share the same cut too
        const cut = clipEnd(a.clip);
        const outs = linkedClips(seq, a.clip).filter((c) => clipEnd(c) === cut);
        const ins = linkedClips(seq, b.clip).filter((c) => c.start === cut);
        const pairs: [ID, ID][] = [[outClipId, inClipId]];
        for (const o of outs) {
          if (o.id === outClipId) continue;
          const ot = findClip(seq, o.id)!.track;
          const partner = ins.find((i) => i.id !== inClipId && findClip(seq, i.id)!.track.id === ot.id);
          if (partner) pairs.push([o.id, partner.id]);
        }
        let target = Math.round(frame);
        for (const [o, i] of pairs) { const r = tlRollEdit(seq, o, i, target, dur); if (!Number.isNaN(r)) target = r; }
      });
    },
    slip(seqId, clipId, deltaFrames) {
      commit('Slip', (d) => { const seq = d.sequences[seqId]; if (seq) slipClip(seq, clipId, Math.round(deltaFrames), mediaDurationLookup(d)); });
    },
    slide(seqId, clipId, deltaFrames) {
      commit('Slide', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const loc = findClip(seq, clipId);
        if (!loc) return;
        const group = linkedClips(seq, loc.clip);
        let dlt = Math.round(deltaFrames);
        for (const g of group) dlt = slideClip(seq, g.id, dlt, mediaDurationLookup(d));
      });
    },
    moveClips(seqId, moves, mode) {
      let ok = false;
      commit('Move', (d) => { const seq = d.sequences[seqId]; if (seq) ok = tlMoveClips(seq, moves, mode); });
      return ok;
    },
    nudgeSelected(deltaFrames, seqId) {
      const seq = seqOf(seqId);
      if (!seq) return;
      const clips = selectedIn(seq, get().ui.selectedClipIds);
      if (!clips.length || deltaFrames === 0) return;
      let delta = Math.round(deltaFrames);
      let minStart = Infinity; // a loop, not Math.min(...spread): huge selections would overflow the stack
      for (const c of clips) if (c.start < minStart) minStart = c.start;
      if (minStart + delta < 0) delta = -minStart;
      if (delta === 0) return;
      const moves = clips.map((c) => ({ clipId: c.id, toTrackId: findClip(seq, c.id)!.track.id, toStart: c.start + delta }));
      commit('Nudge', (d) => { const s = d.sequences[seq.id]; if (s) tlMoveClips(s, moves, 'overwrite'); });
    },
    setClipEnabled(seqId, clipId, enabled) {
      commit(enabled ? 'Enable clip' : 'Disable clip', (d) => { const loc = d.sequences[seqId] && findClip(d.sequences[seqId], clipId); if (loc) loc.clip.enabled = enabled; });
    },
    toggleClipEnabledSelected(seqId) {
      const seq = seqOf(seqId);
      if (!seq) return;
      const ids = get().ui.selectedClipIds;
      if (!ids.length) return;
      commit('Toggle enabled', (d) => { const s = d.sequences[seq.id]; if (s) for (const c of selectedIn(s, ids)) c.enabled = !c.enabled; });
    },
    linkSelected(seqId) {
      const seq = seqOf(seqId);
      if (!seq) return;
      const ids = get().ui.selectedClipIds;
      if (ids.length < 2) return;
      commit('Link', (d) => { const s = d.sequences[seq.id]; if (!s) return; const link = uid('link'); for (const c of selectedIn(s, ids)) c.linkId = link; });
    },
    unlinkSelected(seqId) {
      const seq = seqOf(seqId);
      if (!seq) return;
      const ids = get().ui.selectedClipIds;
      if (!ids.length) return;
      commit('Unlink', (d) => { const s = d.sequences[seq.id]; if (s) for (const c of selectedIn(s, ids)) c.linkId = null; });
    },
    setClipTransform(seqId, clipId, patch) {
      commit('Transform', (d) => {
        const loc = d.sequences[seqId] && findClip(d.sequences[seqId], clipId);
        if (!loc) return;
        const { crop, ...rest } = patch;
        Object.assign(loc.clip.transform, rest);
        if (crop) loc.clip.transform.crop = { ...loc.clip.transform.crop, ...crop };
      });
    },
    setClipAudio(seqId, clipId, patch) {
      commit('Audio', (d) => { const loc = d.sequences[seqId] && findClip(d.sequences[seqId], clipId); if (loc) Object.assign(loc.clip.audio, patch); });
    },
    setClipAudioStream(seqId, clipIds, index) {
      commit('Audio stream', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const changed = tlSetClipAudioStream(seq, clipIds, index);
        // A proxy without a stream these clips now play would preview the wrong track: mark it stale (Generate again).
        for (const mediaId of new Set(changed.map((c) => c.mediaId))) {
          const m = d.media[mediaId];
          if (m && proxyStreamStale(m, changed.filter((c) => c.mediaId === mediaId).map((c) => c.audioStream ?? m.preferredAudioStream))) m.proxy = { status: 'none' };
        }
      });
    },
    setClipSpeed(seqId, clipId, speed, opts = {}) {
      if (!(speed > 0) || !Number.isFinite(speed)) return;
      commit('Speed', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const loc = findClip(seq, clipId);
        if (!loc) return;
        const group = linkedClips(seq, loc.clip);
        const groupIds = new Set(group.map((g) => g.id));
        const oldEnd = clipEnd(loc.clip);
        const mediaDur = mediaDurationLookup(d);
        // Duration that keeps the clip's source range at the new speed. Rounding may not add a frame the
        // media does not have (the trim limits count whole frames available): when the exact length fits,
        // cap at that. A clip already past its media end keeps plain rounding.
        const speedDur = (g: Clip): number => {
          const exact = g.duration * g.speed / speed;
          const want = Math.max(MIN_CLIP_FRAMES, Math.round(exact));
          const fit = maxDurationFrom(g.sourceIn, speed, mediaDur(g.mediaId), seq.fps);
          return want > fit && Math.floor(exact + 1e-6) <= fit ? Math.max(MIN_CLIP_FRAMES, fit) : want;
        };
        const newDur = speedDur(loc.clip);
        const delta = newDur - loc.clip.duration;
        if (opts.ripple) {
          if (delta > 0) rippleShift(seq, oldEnd, delta, { except: groupIds });
          for (const g of group) { g.duration = speedDur(g); g.speed = speed; }
          if (delta < 0) rippleShift(seq, oldEnd, delta, { except: groupIds });
        } else {
          for (const g of group) {
            const gl = findClip(seq, g.id)!;
            const next = gl.track.clips[gl.index + 1];
            let dur = speedDur(g);
            if (next) dur = Math.max(MIN_CLIP_FRAMES, Math.min(dur, next.start - g.start));
            g.duration = dur; g.speed = speed;
          }
        }
        reconcileAll(seq);
      });
    },
    setClipTags(seqId, clipId, patch) {
      commit('Tag clip', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const loc = findClip(seq, clipId);
        if (!loc) return;
        for (const c of linkedClips(seq, loc.clip)) {
          if (patch.characters) c.characters = [...patch.characters];
          if (patch.plotlines) c.plotlines = [...patch.plotlines];
          if (patch.locations) c.locations = [...patch.locations];
          if (patch.tags) c.tags = [...patch.tags];
          if (patch.notes !== undefined) c.notes = patch.notes;
          if ('color' in patch) c.color = patch.color;
          if (patch.name !== undefined) c.name = patch.name;
        }
        addToVocab(d.tags, 'characters', patch.characters);
        addToVocab(d.tags, 'plotlines', patch.plotlines);
        addToVocab(d.tags, 'locations', patch.locations);
        addToVocab(d.tags, 'custom', patch.tags);
      });
    },
    addTransitionAtCut(seqId, trackId, frame, type, frames) {
      let tr: Transition | null = null;
      commit('Add transition', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const made = tlAddTransition(seq, trackId, Math.round(frame), type, Math.max(1, Math.round(frames ?? d.settings.defaultTransitionFrames)));
        if (made) tr = { ...made };
      });
      return tr;
    },
    addDefaultTransitionAtSelection(seqId) {
      const seq = seqOf(seqId);
      if (!seq) return;
      const ids = get().ui.selectedClipIds;
      commit('Add default transition', (d) => {
        const s = d.sequences[seq.id];
        if (!s) return;
        const frames = Math.max(1, d.settings.defaultTransitionFrames);
        const typeFor = (t: Track): TransitionType => (t.kind === 'audio' ? 'audioCrossfade' : 'crossDissolve');
        const cuts: { trackId: ID; frame: number }[] = [];
        if (ids.length) {
          const sel = new Set(ids);
          let pairs = 0;
          for (const t of allTracks(s)) {
            const tc = readItems(t.clips); // read only
            for (let i = 0; i < tc.length - 1; i++) {
              const a = tc[i]; const b = tc[i + 1];
              if (sel.has(a.id) && sel.has(b.id) && clipEnd(a) === b.start) { cuts.push({ trackId: t.id, frame: b.start }); pairs++; }
            }
          }
          if (pairs === 0) {
            // single clip(s): the edge nearest the playhead
            for (const c of selectedIn(s, ids)) {
              const t = findClip(s, c.id)!.track;
              const ph = s.view.playhead;
              const frame = Math.abs(ph - c.start) <= Math.abs(clipEnd(c) - ph) ? c.start : clipEnd(c);
              cuts.push({ trackId: t.id, frame });
            }
          }
        } else {
          // nearest edit point to the playhead across unlocked tracks; apply on every track with a cut there
          const ph = s.view.playhead;
          let best: number | null = null;
          for (const t of allTracks(s)) {
            if (t.locked) continue;
            for (const c of readItems(t.clips)) for (const f of [c.start, clipEnd(c)]) if (best === null || Math.abs(f - ph) < Math.abs(best - ph)) best = f;
          }
          if (best === null) return;
          for (const t of allTracks(s)) {
            if (t.locked) continue;
            if (readItems(t.clips).some((c) => c.start === best || clipEnd(c) === best)) cuts.push({ trackId: t.id, frame: best });
          }
        }
        for (const cut of cuts) {
          const t = findTrack(s, cut.trackId);
          if (t) tlAddTransition(s, cut.trackId, cut.frame, typeFor(t), frames);
        }
      });
    },
    removeTransition(seqId, transitionId) {
      commit('Remove transition', (d) => { const seq = d.sequences[seqId]; if (seq) tlRemoveTransition(seq, transitionId); });
    },
    setTransitionDuration(seqId, transitionId, frames) {
      commit('Transition duration', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const found = findTransition(seq, transitionId);
        if (!found) return;
        const tr = found.transition;
        const out = tr.outClipId ? readItems(found.track.clips).find((c) => c.id === tr.outClipId) : null;
        const inn = tr.inClipId ? readItems(found.track.clips).find((c) => c.id === tr.inClipId) : null;
        // Never overlap the transition on the other edge of either clip.
        tr.duration = Math.max(1, Math.min(Math.round(frames), transitionLimit(found.track, out, inn, tr.id)));
        reconcileTransitions(found.track);
      });
    },
    addTrack(seqId, kind, index) {
      let id: ID | null = null;
      commit(`Add ${kind} track`, (d) => { const seq = d.sequences[seqId]; if (seq) id = tlAddTrack(seq, kind, index).id; });
      return id;
    },
    removeTrack(seqId, trackId) {
      commit('Remove track', (d) => { const seq = d.sequences[seqId]; if (seq) tlRemoveTrack(seq, trackId); });
    },
    setTrackFlags(seqId, trackId, patch) {
      commit('Track settings', (d) => {
        const seq = d.sequences[seqId];
        const track = seq && findTrack(seq, trackId);
        if (!seq || !track) return;
        if (patch.patched === true) {
          // source patching is exclusive within a track kind
          for (const t of track.kind === 'video' ? seq.videoTracks : seq.audioTracks) t.patched = t.id === trackId;
        } else if (patch.patched === false) track.patched = false;
        const { patched: _p, ...rest } = patch;
        Object.assign(track, rest);
      });
    },

    // ---------------------------------------------------------------- markers
    addMarker(seqId, marker) {
      let id: ID | null = null;
      commit('Add marker', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const m = tlAddMarker(seq, {
          time: Math.max(0, Math.round(marker.time)), duration: marker.duration ?? 0, name: marker.name ?? 'Marker', note: marker.note ?? '',
          color: marker.color ?? '#4d7cfe', kind: marker.kind ?? 'marker', category: marker.category, resolved: marker.resolved, clipId: marker.clipId,
        });
        id = m.id;
      });
      return id;
    },
    updateMarker(seqId, markerId, patch) {
      commit('Edit marker', (d) => {
        const seq = d.sequences[seqId];
        const m = seq?.markers.find((x) => x.id === markerId);
        if (!seq || !m) return;
        Object.assign(m, patch);
        if (patch.time !== undefined) m.time = Number.isFinite(patch.time) ? Math.max(0, Math.round(patch.time)) : 0;
        if (patch.duration !== undefined) m.duration = Number.isFinite(patch.duration) ? Math.max(0, Math.round(patch.duration)) : 0;
        seq.markers.sort((a, b) => a.time - b.time);
      });
    },
    removeMarker(seqId, markerId) {
      commit('Remove marker', (d) => { const seq = d.sequences[seqId]; if (seq) seq.markers = seq.markers.filter((m) => m.id !== markerId); });
    },
    addContinuityNote(seqId, note) {
      let id: ID | null = null;
      commit('Add continuity note', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const m = tlAddMarker(seq, {
          time: Math.max(0, Math.round(note.time)), duration: note.duration ?? 0, name: note.name, note: note.note, color: '#f5a623',
          kind: 'continuity', category: note.category ?? 'other', resolved: false, clipId: note.clipId,
        });
        id = m.id;
      });
      return id;
    },
    resolveContinuity(seqId, markerId, resolved = true) {
      commit(resolved ? 'Resolve continuity note' : 'Reopen continuity note', (d) => {
        const m = d.sequences[seqId]?.markers.find((x) => x.id === markerId);
        if (m) m.resolved = resolved;
      });
    },

    // ---------------------------------------------------------------- story blocks
    addStoryBlock(seqId, block) {
      const id = uid('sb');
      const ok = commit('Add story block', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const start = Math.max(0, Math.round(Math.min(block.start, block.end)));
        const end = Math.max(start + 1, Math.round(Math.max(block.start, block.end)));
        const b: StoryBlock = { id, name: block.name ?? 'Block', start, end, color: block.color ?? '#7c5cff', notes: block.notes ?? '' };
        seq.storyBlocks.push(b);
        seq.storyBlocks.sort((a, c) => a.start - c.start);
      });
      return ok ? id : null;
    },
    updateStoryBlock(seqId, blockId, patch) {
      commit('Edit story block', (d) => {
        const seq = d.sequences[seqId];
        const b = seq?.storyBlocks.find((x) => x.id === blockId);
        if (!seq || !b) return;
        Object.assign(b, patch);
        if (b.end <= b.start) b.end = b.start + 1;
        seq.storyBlocks.sort((a, c) => a.start - c.start);
      });
    },
    removeStoryBlock(seqId, blockId) {
      commit('Remove story block', (d) => { const seq = d.sequences[seqId]; if (seq) seq.storyBlocks = seq.storyBlocks.filter((b) => b.id !== blockId); });
    },

    // ---------------------------------------------------------------- sequence subtitles
    addSequenceSubtitleTrack(seqId, init = {}) {
      const id = uid('sst');
      const ok = commit('Add subtitle track', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        const language = init.language ?? 'und';
        seq.subtitleTracks.push({ id, name: init.name ?? language, language, enabled: true, cues: [] });
      });
      return ok ? id : null;
    },
    removeSequenceSubtitleTrack(seqId, trackId) {
      commit('Remove subtitle track', (d) => { const seq = d.sequences[seqId]; if (seq) seq.subtitleTracks = seq.subtitleTracks.filter((t) => t.id !== trackId); });
    },
    toggleSubtitleTrack(seqId, trackId, enabled) {
      commit('Toggle subtitle track', (d) => { const t = d.sequences[seqId]?.subtitleTracks.find((x) => x.id === trackId); if (t) t.enabled = enabled ?? !t.enabled; });
    },
    updateCue(seqId, cueId, patch) {
      commit('Edit subtitle', (d) => {
        const seq = d.sequences[seqId];
        const f = seq && findCue(seq, cueId);
        if (!f) return;
        if (patch.text !== undefined) f.cue.text = patch.text;
        if (patch.offset !== undefined && Number.isFinite(patch.offset)) {
          // A nudge may not move the cue before the sequence start: start + offset >= 0.
          const base = cueFrames(seq, { ...f.cue, offset: 0 });
          const minOffset = !base ? -Infinity : base.start > 0 ? -base.start : 0;
          f.cue.offset = Math.max(minOffset, Math.round(patch.offset)) || 0; // never -0
        }
      });
    },
    addManualCue(seqId, trackId, cue) {
      const id = uid('scue');
      const ok = commit('Add subtitle', (d) => {
        const t = d.sequences[seqId]?.subtitleTracks.find((x) => x.id === trackId);
        if (!t) return;
        t.cues.push({ id, start: Math.max(0, Math.round(cue.start)), duration: Math.max(1, Math.round(cue.duration)), offset: 0, text: cue.text });
        t.cues.sort((a, b) => a.start - b.start);
      });
      return ok ? id : null;
    },
    splitCue(seqId, cueId, atFrame) {
      let newId: ID | null = null;
      commit('Split subtitle', (d) => {
        const seq = d.sequences[seqId];
        const f = seq && findCue(seq, cueId);
        if (!seq || !f) return;
        const r = cueFrames(seq, f.cue);
        const at = Math.round(atFrame);
        if (!r || at <= r.start || at >= r.end) return;
        const lines = f.cue.text.split('\n');
        const half = Math.ceil(lines.length / 2);
        const textA = lines.length > 1 ? lines.slice(0, half).join('\n') : f.cue.text;
        const textB = lines.length > 1 ? lines.slice(half).join('\n') : f.cue.text;
        const second: SequenceSubtitleCue = { ...f.cue, id: uid('scue'), text: textB };
        f.cue.text = textA;
        if (r.clip) {
          const clip = r.clip;
          const srcAt = clip.sourceIn + ((at - f.cue.offset) - clip.start) * seq.fps.den / seq.fps.num * clip.speed;
          f.cue.srcEnd = srcAt;
          second.srcStart = srcAt;
        } else {
          f.cue.duration = at - r.start;
          second.start = f.cue.start + (at - r.start);
          second.duration = r.end - at;
        }
        f.track.cues.splice(f.index + 1, 0, second);
        newId = second.id;
      });
      return newId;
    },
    mergeCues(seqId, cueIds) {
      if (cueIds.length < 2) return;
      commit('Merge subtitles', (d) => {
        const seq = d.sequences[seqId];
        if (!seq) return;
        // One index over every cue (findCue per id would be quadratic for a large selection).
        const byId = new Map<ID, { track: SequenceSubtitleTrack; cue: SequenceSubtitleCue }>();
        for (const track of seq.subtitleTracks) for (const cue of track.cues) if (!byId.has(cue.id)) byId.set(cue.id, { track, cue });
        const found = [...new Set(cueIds)].map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
        if (found.length < 2) return;
        const resolved = found.map((f) => ({ f, r: cueFrames(seq, f.cue) })).filter((x): x is { f: typeof x.f; r: NonNullable<typeof x.r> } => !!x.r);
        if (resolved.length < 2) return;
        resolved.sort((a, b) => a.r.start - b.r.start);
        const first = resolved[0];
        const text = resolved.map((x) => x.f.cue.text).join('\n');
        const sameClip = resolved.every((x) => x.f.cue.clipId && x.f.cue.clipId === first.f.cue.clipId);
        const cue = first.f.cue;
        // Loops, not Math.min/max(...spread): huge selections would overflow the stack.
        if (sameClip) {
          let srcStart = Infinity; let srcEnd = -Infinity;
          for (const x of resolved) { srcStart = Math.min(srcStart, x.f.cue.srcStart ?? Infinity); srcEnd = Math.max(srcEnd, x.f.cue.srcEnd ?? -Infinity); }
          cue.srcStart = srcStart;
          cue.srcEnd = srcEnd;
        } else {
          let start = Infinity; let end = -Infinity;
          for (const x of resolved) { start = Math.min(start, x.r.start); end = Math.max(end, x.r.end); }
          cue.clipId = undefined; cue.srcStart = undefined; cue.srcEnd = undefined;
          cue.start = start; cue.duration = Math.max(1, end - start); cue.offset = 0;
        }
        cue.text = text;
        const drop = new Set(resolved.slice(1).map((x) => x.f.cue.id));
        for (const t of seq.subtitleTracks) t.cues = t.cues.filter((c) => !drop.has(c.id));
      });
    },
    removeCue(seqId, cueId) {
      commit('Remove subtitle', (d) => { const seq = d.sequences[seqId]; if (seq) for (const t of seq.subtitleTracks) t.cues = t.cues.filter((c) => c.id !== cueId); });
    },

    // ---------------------------------------------------------------- scenes library
    addScene(record) {
      commit('Add scene', (d) => {
        d.scenes[record.id] = record;
        addToVocab(d.tags, 'characters', record.characters);
        addToVocab(d.tags, 'custom', record.tags);
        if (record.location) addToVocab(d.tags, 'locations', [record.location]);
        if (record.arc) addToVocab(d.tags, 'plotlines', [record.arc]);
      });
    },
    updateScene(id, patch) {
      commit('Edit scene', (d) => {
        const s = d.scenes[id];
        if (!s) return;
        Object.assign(s, patch, { id });
        addToVocab(d.tags, 'characters', patch.characters);
        addToVocab(d.tags, 'custom', patch.tags);
        if (patch.location) addToVocab(d.tags, 'locations', [patch.location]);
        if (patch.arc) addToVocab(d.tags, 'plotlines', [patch.arc]);
      });
    },
    removeScene(id) { commit('Remove scene', (d) => { delete d.scenes[id]; }); },
    sceneFromSource(name) {
      const s = get();
      const sc = s.ui.sourceClip;
      const media = sc ? s.project.media[sc.mediaId] : undefined;
      if (!sc || !media) return null;
      const inS = sc.inPoint ?? 0;
      const outS = sc.outPoint ?? media.probe?.duration ?? inS;
      if (outS <= inS) return null;
      const n = Object.values(s.project.scenes).filter((x) => x.mediaId === media.id).length + 1;
      const record: SceneRecord = {
        id: uid('scn'), name: name ?? `${media.name} – Scene ${n}`, mediaId: media.id, in: inS, out: outS,
        characters: [], location: '', arc: '', tags: [], notes: '', rating: 0, color: '#4d7cfe', createdAt: Date.now(),
      };
      get().addScene(record);
      return record.id;
    },
    sceneFromClip(seqId, clipId, name) {
      const seq = get().project.sequences[seqId];
      const loc = seq && findClip(seq, clipId);
      if (!seq || !loc) return null;
      const c = loc.clip;
      const record: SceneRecord = {
        id: uid('scn'), name: name ?? c.name, mediaId: c.mediaId, in: c.sourceIn, out: clipSourceOut(c, seq.fps),
        characters: [...c.characters], location: c.locations[0] ?? '', arc: c.plotlines[0] ?? '', tags: [...c.tags], notes: c.notes,
        rating: 0, color: c.color ?? '#4d7cfe', createdAt: Date.now(),
      };
      get().addScene(record);
      return record.id;
    },

    // ---------------------------------------------------------------- tags
    addTag(kind, value) { commit('Add tag', (d) => addToVocab(d.tags, kind, [value])); },

    // ---------------------------------------------------------------- ui (no history)
    setTool(tool: Tool) { setUi({ tool }); },
    select(clipIds, mode = 'set') {
      setUi((ui) => {
        const selectedClipIds = applySelect(ui.selectedClipIds, clipIds, mode);
        return { selectedClipIds, selectedTransitionId: selectedClipIds.length ? null : ui.selectedTransitionId };
      });
    },
    selectTransition(id) { setUi((ui) => ({ selectedTransitionId: id, selectedClipIds: id ? [] : ui.selectedClipIds })); },
    selectMedia(ids, mode = 'set') { setUi((ui) => ({ selectedMediaIds: applySelect(ui.selectedMediaIds, ids, mode) })); },
    selectScenes(ids, mode = 'set') { setUi((ui) => ({ selectedSceneIds: applySelect(ui.selectedSceneIds, ids, mode) })); },
    selectBin(id) { setUi({ selectedBinId: id }); },
    selectMarker(id) { setUi({ selectedMarkerId: id }); },
    setSourceClip(mediaId, time = 0) {
      setUi((ui) => {
        if (!mediaId) return { sourceClip: null };
        if (ui.sourceClip?.mediaId === mediaId) return { sourceClip: { ...ui.sourceClip, time } };
        return { sourceClip: { mediaId, inPoint: null, outPoint: null, time } };
      });
    },
    setSourceIn(seconds) {
      setUi((ui) => {
        if (!ui.sourceClip) return {};
        const sc = { ...ui.sourceClip, inPoint: seconds === null ? null : Math.max(0, seconds) };
        if (sc.inPoint !== null && sc.outPoint !== null && sc.outPoint < sc.inPoint) sc.outPoint = sc.inPoint;
        return { sourceClip: sc };
      });
    },
    setSourceOut(seconds) {
      setUi((ui) => {
        if (!ui.sourceClip) return {};
        const sc = { ...ui.sourceClip, outPoint: seconds === null ? null : Math.max(0, seconds) };
        if (sc.inPoint !== null && sc.outPoint !== null && sc.inPoint > sc.outPoint) sc.inPoint = sc.outPoint;
        return { sourceClip: sc };
      });
    },
    setSourceTime(seconds) { setUi((ui) => (ui.sourceClip ? { sourceClip: { ...ui.sourceClip, time: Math.max(0, seconds) } } : {})); },
    setActivePanel(panel) { setUi({ activePanel: panel }); },
    setTimelineFocus(focus) { setUi({ timelineFocus: focus }); },
    setFilters(patch) { setUi((ui) => ({ filters: { ...ui.filters, ...patch } })); },
    clearFilters() { setUi((ui) => ({ filters: { characters: [], plotlines: [], locations: [], tags: [], mode: ui.filters.mode } })); },
    setCompare(patch) { setUi((ui) => ({ compare: { ...ui.compare, ...patch } })); },
    openDialog(name: DialogName) { setUi((ui) => ({ dialogs: { ...ui.dialogs, [name]: true } })); },
    closeDialog(name: DialogName) { setUi((ui) => ({ dialogs: { ...ui.dialogs, [name]: false } })); },
    toast(kind: ToastKind, text) {
      const id = uid('toast');
      setUi((ui) => ({ toasts: [...ui.toasts, { id, kind, text }] }));
      return id;
    },
    dismissToast(id) { setUi((ui) => ({ toasts: ui.toasts.filter((t) => t.id !== id) })); },
    setJobs(jobs) { set({ jobs }); },
    setPlaying(playing) { set((s) => ({ playback: { ...s.playback, playing } })); },
    setPlaybackRate(rate) { set((s) => ({ playback: { ...s.playback, rate } })); },
  };
});

// ------------------------------------------------------------------
// Persistence helpers / misc
// ------------------------------------------------------------------

/** Project data ready for saving (pure data already; just stamps modifiedAt). */
export function serializeForSave(state: StoreState = useStore.getState()): Project {
  settleProjectFreeze();
  return produce(state.project, (d) => { d.modifiedAt = Date.now(); });
}

export function getUndoLabels(state: StoreState = useStore.getState()): { undo: string | null; redo: string | null } {
  return { undo: undoLabel(state.history), redo: redoLabel(state.history) };
}

/** Reset the store to a fresh project (tests / "New Project"). */
export function resetStore(): void {
  useStore.setState({ ...initialState() });
}

export type { RecutStore, StoreState, UIState } from './types';
export type { Bin, Marker, MediaItem, Sequence, Track, Transition, Clip } from '../../shared/model';
