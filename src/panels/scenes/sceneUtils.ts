/**
 * Pure helpers for the Scene Library panel: fps lookup, formatting, filtering, sorting, grouping and the
 * store-facing actions (load in Source, insert at playhead, drag payload) shared by rows, cards and menus.
 */
import type { ID, MediaItem, Rational, SceneRecord, SceneSequence } from '@shared/model';
import { createSequence } from '@shared/project';
import { formatSequenceSecondsTimecode, formatClock, secondsToFrames, validFpsOr } from '@shared/time';
import { uid } from '@shared/ids';
import { clipEnd, findClip } from '@shared/timeline';
import { useStore, identityLabel } from '@/state';
import { activeSequence } from '@/state/selectors';
import { setClipDrag, type ClipDragPayload } from '@/app/dnd';
import { useLayoutStore } from '@/components/layout/layoutStore';
import { toast } from '@/components/ui/toastStore';

export const DEFAULT_FPS: Rational = { num: 24000, den: 1001 };

export type SortKey = 'name' | 'source' | 'rating' | 'created' | 'duration';
export type GroupKey = 'none' | 'media' | 'character' | 'arc' | 'location';
export type ViewMode = 'list' | 'grid';

export interface SceneFilters {
  query: string;
  character: string;
  location: string;
  arc: string;
  tag: string;
  minRating: number;
  mediaId: string;
  color: string;
}

export const EMPTY_FILTERS: SceneFilters = { query: '', character: '', location: '', arc: '', tag: '', minRating: 0, mediaId: '', color: '' };

export function filtersActive(f: SceneFilters): boolean {
  return !!(f.query || f.character || f.location || f.arc || f.tag || f.minRating > 0 || f.mediaId || f.color);
}

/** The media's video frame rate, or `fallback` when it is unknown / unusable (a probe stores {num:0,den:1} for unknown). */
export function mediaFps(media: MediaItem | undefined, fallback: Rational = DEFAULT_FPS): Rational {
  return validFpsOr(media?.probe?.video?.fps, fallback);
}

export function sourceLabel(media: MediaItem | undefined): string {
  if (!media) return 'Missing media';
  const idn = media.identity;
  if (idn.series) {
    const p = (n: number) => String(n).padStart(2, '0');
    const se = idn.season !== undefined || idn.episode !== undefined ? `S${p(idn.season ?? 0)}${idn.episode !== undefined ? `E${p(idn.episode)}` : ''}` : '';
    return [idn.series, se, idn.title].filter(Boolean).join(' · ');
  }
  return identityLabel(media);
}

export function rangeLabel(scene: SceneRecord, fps: Rational): string {
  return `${formatSequenceSecondsTimecode(scene.in, fps)} → ${formatSequenceSecondsTimecode(scene.out, fps)}`;
}

export function durationLabel(scene: SceneRecord): string {
  return formatClock(Math.max(0, scene.out - scene.in), false).replace(/^00:/, '0:');
}

export function sceneDuration(scene: SceneRecord): number { return Math.max(0, scene.out - scene.in); }

/** Facet values available for the filter selects. */
export interface SceneFacets { characters: string[]; locations: string[]; arcs: string[]; tags: string[]; colors: string[]; mediaIds: string[] }

export function collectFacets(scenes: SceneRecord[]): SceneFacets {
  const c = new Set<string>(), l = new Set<string>(), a = new Set<string>(), t = new Set<string>(), col = new Set<string>(), m = new Set<string>();
  for (const s of scenes) {
    s.characters.forEach((x) => c.add(x));
    s.tags.forEach((x) => t.add(x));
    if (s.location) l.add(s.location);
    if (s.arc) a.add(s.arc);
    if (s.color) col.add(s.color.toLowerCase());
    m.add(s.mediaId);
  }
  const sort = (set: Set<string>) => [...set].sort((x, y) => x.localeCompare(y));
  return { characters: sort(c), locations: sort(l), arcs: sort(a), tags: sort(t), colors: sort(col), mediaIds: [...m] };
}

export function matchesFilters(scene: SceneRecord, f: SceneFilters, media: MediaItem | undefined): boolean {
  if (f.character && !scene.characters.includes(f.character)) return false;
  if (f.location && scene.location !== f.location) return false;
  if (f.arc && scene.arc !== f.arc) return false;
  if (f.tag && !scene.tags.includes(f.tag)) return false;
  if (f.minRating > 0 && scene.rating < f.minRating) return false;
  if (f.mediaId && scene.mediaId !== f.mediaId) return false;
  if (f.color && (scene.color ?? '').toLowerCase() !== f.color.toLowerCase()) return false;
  if (f.query) {
    const q = f.query.trim().toLowerCase();
    if (q) {
      const hay = [scene.name, scene.location, scene.arc, scene.notes, ...scene.characters, ...scene.tags, media?.name ?? '', sourceLabel(media)]
        .join('\n').toLowerCase();
      if (!hay.includes(q)) return false;
    }
  }
  return true;
}

const numericCollator = new Intl.Collator(undefined, { numeric: true });
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** sourceLabel per media object (labels only change when the media item does). */
const sourceLabelCache = new WeakMap<MediaItem, string>();
function cachedSourceLabel(m: MediaItem | undefined): string {
  if (!m) return sourceLabel(m);
  let l = sourceLabelCache.get(m);
  if (l === undefined) { l = sourceLabel(m); sourceLabelCache.set(m, l); }
  return l;
}

export function compareScenes(a: SceneRecord, b: SceneRecord, key: SortKey, dir: 1 | -1, media: Record<ID, MediaItem>): number {
  let r = 0;
  switch (key) {
    case 'name': r = nameCollator.compare(a.name, b.name); break;
    case 'rating': r = b.rating - a.rating; break;
    case 'created': r = a.createdAt - b.createdAt; break;
    case 'duration': r = sceneDuration(a) - sceneDuration(b); break;
    case 'source': {
      const ma = media[a.mediaId], mb = media[b.mediaId];
      r = (ma === mb ? 0 : numericCollator.compare(cachedSourceLabel(ma), cachedSourceLabel(mb))) || a.in - b.in;
      break;
    }
  }
  if (r === 0) r = numericCollator.compare(a.name, b.name) || a.in - b.in;
  return r * dir;
}

export interface SceneGroup { key: string; label: string; scenes: SceneRecord[] }

/** Groups a sorted list. A scene with several characters appears under each of them. */
export function groupScenes(scenes: SceneRecord[], by: GroupKey, media: Record<ID, MediaItem>): SceneGroup[] {
  if (by === 'none') return [{ key: '*', label: 'All scenes', scenes }];
  const map = new Map<string, SceneGroup>();
  const push = (key: string, label: string, s: SceneRecord) => {
    const g = map.get(key) ?? { key, label, scenes: [] };
    g.scenes.push(s); map.set(key, g);
  };
  for (const s of scenes) {
    if (by === 'media') push(`m:${s.mediaId}`, sourceLabel(media[s.mediaId]), s);
    else if (by === 'arc') push(`a:${s.arc}`, s.arc || 'No arc', s);
    else if (by === 'location') push(`l:${s.location}`, s.location || 'No location', s);
    else if (by === 'character') {
      if (s.characters.length === 0) push('c:', 'No character', s);
      else for (const c of s.characters) push(`c:${c}`, c, s);
    }
  }
  const groups = [...map.values()];
  groups.sort((x, y) => {
    const xe = x.label.startsWith('No '), ye = y.label.startsWith('No ');
    if (xe !== ye) return xe ? 1 : -1;
    return x.label.localeCompare(y.label, undefined, { numeric: true });
  });
  return groups;
}

// ------------------------------------------------------------------ store-facing actions

export function loadSceneInSource(scene: SceneRecord): void {
  const s = useStore.getState();
  if (!s.project.media[scene.mediaId]) { toast.warn('Scene media is missing from the project'); return; }
  s.setSourceClip(scene.mediaId, scene.in);
  s.setSourceIn(scene.in);
  s.setSourceOut(scene.out);
  s.setActivePanel('source');
  useLayoutStore.getState().focusPanel('source');
}

export function sceneClipExtra(scene: SceneRecord) {
  return {
    name: scene.name,
    sceneRecordId: scene.id,
    characters: [...scene.characters],
    tags: [...scene.tags],
    locations: scene.location ? [scene.location] : [],
    plotlines: scene.arc ? [scene.arc] : [],
    notes: scene.notes,
    color: scene.color || undefined,
    originLabel: 'library',
  };
}

/** Insert / overwrite the scene at the active sequence playhead. Returns created clip ids. */
export function insertSceneAtPlayhead(scene: SceneRecord, mode: 'insert' | 'overwrite'): ID[] {
  const s = useStore.getState();
  const seq = activeSequence(s);
  if (!seq) { toast.warn('No active timeline'); return []; }
  if (!s.project.media[scene.mediaId]) { toast.warn('Scene media is missing from the project'); return []; }
  const ids = s.insertFromSource(seq.id, {
    mediaId: scene.mediaId, in: scene.in, out: scene.out, atFrame: seq.view.playhead, mode, extra: sceneClipExtra(scene),
  });
  if (ids.length === 0) toast.warn(`Could not ${mode} "${scene.name}" (track locked or no track available)`);
  return ids;
}

/** Insert several scenes back-to-back at the playhead (in the order given), as one undo step. */
export function insertScenesAtPlayhead(scenes: SceneRecord[], mode: 'insert' | 'overwrite', label = mode === 'insert' ? 'Insert scenes' : 'Overwrite scenes'): void {
  const s = useStore.getState();
  const seq = activeSequence(s);
  if (!seq) { toast.warn('No active timeline'); return; }
  let at = seq.view.playhead;
  s.batch(label, () => { for (const scene of scenes) {
    const ids = s.insertFromSource(seq.id, { mediaId: scene.mediaId, in: scene.in, out: scene.out, atFrame: at, mode, extra: sceneClipExtra(scene) });
    if (!ids.length) continue;
    // Advance by what was actually placed: inserts are capped at the media end, so the rounded scene length
    // (secondsToFrames) can be a frame longer than the clip and would leave a gap.
    const placed = useStore.getState().project.sequences[seq.id];
    let end = -Infinity;
    if (placed) for (const id of ids) { const loc = findClip(placed, id); if (loc) end = Math.max(end, clipEnd(loc.clip)); }
    at = Number.isFinite(end) ? end : at + Math.max(1, secondsToFrames(sceneDuration(scene), seq.fps));
  } });
  if (scenes.length) s.setView(seq.id, { playhead: at });
}

// ------------------------------------------------------------------ sequences of scenes (#146)

/** A sequence's scenes that still exist, in its order. */
export function sequenceScenes(q: SceneSequence, scenes: Record<ID, SceneRecord> = useStore.getState().project.scenes): SceneRecord[] {
  return q.sceneIds.map((id) => scenes[id]).filter((x): x is SceneRecord => !!x);
}

/** Total length of a sequence's scenes, in seconds. */
export function sequenceDuration(q: SceneSequence, scenes?: Record<ID, SceneRecord>): number {
  return sequenceScenes(q, scenes).reduce((t, sc) => t + sceneDuration(sc), 0);
}

/** Next free default sequence name: "Sequence 01", "Sequence 02", … */
export function nextSequenceName(): string {
  const names = new Set(Object.values(useStore.getState().project.sceneSequences ?? {}).map((q) => q.name));
  for (let n = 1; ; n++) { const name = `Sequence ${String(n).padStart(2, '0')}`; if (!names.has(name)) return name; }
}

/** Put a sequence's scenes on the active timeline at the playhead, back to back, in one undo step. */
export function insertSequenceAtPlayhead(q: SceneSequence, mode: 'insert' | 'overwrite'): void {
  const scenes = sequenceScenes(q);
  if (!scenes.length) { toast.warn(`"${q.name}" has no scenes`); return; }
  insertScenesAtPlayhead(scenes, mode, mode === 'insert' ? 'Insert sequence' : 'Overwrite sequence');
}

/**
 * A new timeline named after the sequence, with the active timeline's frame rate and size (or the defaults), holding
 * the sequence's scenes from the start, in one undo step. Returns the new timeline's id.
 */
export function newTimelineFromSequence(q: SceneSequence): ID | null {
  const s = useStore.getState();
  const scenes = sequenceScenes(q);
  if (!scenes.length) { toast.warn(`"${q.name}" has no scenes`); return null; }
  const like = activeSequence(s);
  const tl = like ? createSequence(q.name, { ...like.fps }, like.width, like.height) : createSequence(q.name);
  if (like) { tl.sampleRate = like.sampleRate; tl.channels = like.channels; }
  s.batch('New timeline from sequence', () => {
    useStore.getState().addSequence(tl, { activate: true });
    insertScenesAtPlayhead(scenes, 'overwrite');
  });
  useStore.getState().setView(tl.id, { playhead: 0 });
  toast.ok(`Timeline "${q.name}" made from ${scenes.length} scene${scenes.length === 1 ? '' : 's'}`);
  return tl.id;
}

/** Drag payload for a whole sequence: its scenes, in order. */
export function sequenceDragPayload(q: SceneSequence): ClipDragPayload[] {
  return sequenceScenes(q).map(sceneDragPayload);
}

export function sceneDragPayload(scene: SceneRecord): ClipDragPayload {
  return {
    mediaId: scene.mediaId, in: scene.in, out: scene.out, name: scene.name, origin: 'library',
    sceneRecordId: scene.id, characters: [...scene.characters], tags: [...scene.tags],
  };
}

export function startSceneDrag(dt: DataTransfer, scenes: SceneRecord[]): void {
  setClipDrag(dt, scenes.map(sceneDragPayload));
}

export function duplicateScene(scene: SceneRecord): ID {
  const copy: SceneRecord = { ...scene, id: uid('scn'), name: `${scene.name} copy`, characters: [...scene.characters], tags: [...scene.tags], createdAt: Date.now() };
  useStore.getState().addScene(copy);
  return copy.id;
}

/** Default name for a new record from the Source monitor, mirroring the store's fallback. */
export function defaultSceneName(mediaId: ID): string {
  const s = useStore.getState();
  const media = s.project.media[mediaId];
  const n = Object.values(s.project.scenes).filter((x) => x.mediaId === mediaId).length + 1;
  return `${media?.name ?? 'Scene'} – Scene ${n}`;
}

/** Create SceneRecords from a media item's detected scenes in one undo step (skips ranges already in the library). */
export function importDetectedScenes(mediaId: ID): number {
  const s = useStore.getState();
  const media = s.project.media[mediaId];
  if (!media) return 0;
  const existing = Object.values(s.project.scenes).filter((x) => x.mediaId === mediaId);
  const records: SceneRecord[] = [];
  for (const d of media.detectedScenes) {
    if (d.end - d.start <= 0) continue;
    if (existing.some((x) => Math.abs(x.in - d.start) < 0.05 && Math.abs(x.out - d.end) < 0.05)) continue;
    records.push({
      id: uid('scn'), name: d.name || `Scene ${records.length + 1}`, mediaId, in: d.start, out: d.end,
      characters: [...d.characters], location: '', arc: '', tags: [...d.tags], notes: '', rating: 0, color: media.color ?? '#4d7cfe', createdAt: Date.now(),
    });
  }
  if (records.length === 0) return 0;
  s.commit(`Import ${records.length} detected shots`, (d) => {
    const addVocab = (list: string[], values: string[]) => { for (const v of values) if (v && !list.includes(v)) list.push(v); };
    for (const r of records) {
      d.scenes[r.id] = r;
      addVocab(d.tags.characters, r.characters);
      addVocab(d.tags.custom, r.tags);
    }
  });
  return records.length;
}
