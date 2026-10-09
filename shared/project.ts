import { PROJECT_FORMAT_VERSION, MEDIA_CATEGORIES } from './model';
import type {
  Project, Sequence, Rational, MediaItem, ProjectSettings, Bin, ID, TagVocabulary, SequenceView, Track, Clip, Transition,
  TransitionType, MediaKind, ProxyStatus, MarkerKind, Marker, StoryBlock, SequenceSubtitleTrack, SequenceSubtitleCue,
  SequenceSnapshot, SceneRecord, SubtitleTrack, ClipTransform, ClipAudio, ProxyInfo, MediaProbe, VideoStreamInfo, SourceIdentity,
  DetectedScene,
} from './model';
import { uid } from './ids';
import { PRODUCT_NAME } from './productIdentity';
import { makeTrack, defaultTransform, defaultAudio, reconcileTransitions, SPEED_PERCENT_MIN, SPEED_PERCENT_MAX } from './timeline';
import { isValidFps, parseFps } from './time';
import { saneSar } from './media';
import { CHANNEL_PROXY_KEY, normalizeChannelSelection } from './audioChannels';
import { AUDIO_KEY_PROPS, normalizeKeyframeSet, shiftClipKeyframes, TRANSFORM_KEY_PROPS, type KeyProp } from './keyframes';
import { formatProjectJson } from './projectJson';
import { FLAT_LIMIT_TEXT, nestingRepairs, nestSizeRepairs } from './nest';
import {
  MAX_TIMELINE_FRAMES, MAX_SOURCE_SECONDS, MAX_PROJECT_DEPTH, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX, PROXY_HEIGHTS,
  AUTOSAVE_INTERVAL_MIN_SEC, AUTOSAVE_INTERVAL_MAX_SEC, DEFAULT_TRANSITION_FRAMES_MIN, DEFAULT_TRANSITION_FRAMES_MAX,
} from './limits';

/** Frame rate of a new sequence, and of a loaded sequence whose stored rate is unusable. */
export const DEFAULT_SEQUENCE_FPS: Readonly<Rational> = Object.freeze({ num: 24000, den: 1001 });

/**
 * The project cannot be opened by this build: it was saved by a newer version (`reason: 'newer'`), or its
 * formatVersion is missing / not a positive integer (`reason: 'notProject'`: not a project file). This is a
 * refusal, not damage: the loader reports it and never substitutes a backup. Every other error out of
 * normalizeProject means the content is damaged.
 */
export class ProjectIncompatibleError extends Error {
  constructor(message: string, readonly reason: 'newer' | 'notProject' = 'notProject') { super(message); this.name = 'ProjectIncompatibleError'; }
}

export function defaultSettings(): ProjectSettings {
  return {
    useProxies: true,
    proxyHeight: 540,
    autosaveIntervalSec: 60,
    carrySubtitles: true,
    sceneThreshold: 0.35,
    playbackResolution: 'full',
    snapping: true,
    defaultTransitionFrames: 24,
    showSourceTimecodeOnClips: false,
    highlightSpokenWords: true,
  };
}

export function emptyTags(): TagVocabulary {
  return { characters: [], plotlines: [], locations: [], themes: [], custom: [] };
}

/**
 * A sequence's view state (playhead / zoom / scroll / in / out). Deliberately a class instance: immer treats it as
 * an opaque value, so it is neither drafted nor auto-frozen, and the renderer store moves the playhead / scroll
 * IN PLACE without producing a new project (see `setView` in src/state/store.ts). Replace the whole object to
 * change zoom / in / out (so sequence identity changes). Serialises (JSON / structuredClone) as a plain object.
 */
export class LiveView implements SequenceView {
  playhead = 0;
  zoom = 4;
  scroll = 0;
  inPoint: number | null = null;
  outPoint: number | null = null;
  constructor(v?: Partial<SequenceView>) { if (v) Object.assign(this, v); }
}

/** `v` as a LiveView (a copy when it is a plain object). */
export function liveView(v: SequenceView): SequenceView {
  return v instanceof LiveView ? v : new LiveView(v);
}

export function createSequence(name: string, fps: Rational = { ...DEFAULT_SEQUENCE_FPS }, width = 1920, height = 1080): Sequence {
  if (!isValidFps(fps)) throw new RangeError(`Invalid sequence frame rate ${describeFps(fps)}`);
  const now = Date.now();
  return {
    id: uid('seq'), name, fps, width, height, sampleRate: 48000, channels: 2,
    videoTracks: [makeTrack('video', 1), makeTrack('video', 2), makeTrack('video', 3)],
    audioTracks: [makeTrack('audio', 1), makeTrack('audio', 2), makeTrack('audio', 3)],
    subtitleTracks: [],
    markers: [], storyBlocks: [], snapshots: [],
    createdAt: now, modifiedAt: now, binId: null,
    view: new LiveView(),
  };
}

export const DEFAULT_BINS: { id: string; name: string }[] = [
  { id: 'bin-movies', name: 'Movies' },
  { id: 'bin-tv', name: 'TV' },
  { id: 'bin-scenes', name: 'Scenes' },
  { id: 'bin-sequences', name: 'Sequences' },
  { id: 'bin-audio', name: 'Audio' },
  { id: 'bin-subtitles', name: 'Subtitles' },
  { id: 'bin-graphics', name: 'Graphics' },
  { id: 'bin-misc', name: 'Misc' },
];

export function createProject(name = 'Untitled Project'): Project {
  const now = Date.now();
  const bins: Record<ID, Bin> = {};
  for (const b of DEFAULT_BINS) bins[b.id] = { id: b.id, name: b.name, parentId: null, kind: 'bin' };
  const seq = createSequence('Sequence 01');
  seq.binId = 'bin-sequences';
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: uid('proj'), name, createdAt: now, modifiedAt: now,
    media: {}, bins, sequences: { [seq.id]: seq }, sequenceOrder: [seq.id],
    scenes: {}, subtitleTracks: {}, tags: emptyTags(), settings: defaultSettings(), activeSequenceId: seq.id,
  };
}

/**
 * Whether a project holds anything a user would want back: media, scenes, subtitle tracks, tags, a name other than
 * the default, more than one sequence, or a sequence with clips, markers, story blocks, snapshots or subtitles.
 * Empty bins, track layout and settings do not count. An untitled project without user work is not autosaved, not
 * offered for recovery and closes without a "Save changes?" prompt (#111).
 */
export function projectHasUserWork(p: Project): boolean {
  if (p.name !== 'Untitled Project') return true;
  if (Object.keys(p.media).length || Object.keys(p.scenes).length || Object.keys(p.subtitleTracks).length) return true;
  if (Object.values(p.tags).some((list) => list.length > 0)) return true;
  const seqs = Object.values(p.sequences);
  if (seqs.length > 1) return true;
  return seqs.some((s) => s.markers.length > 0 || s.storyBlocks.length > 0 || s.snapshots.length > 0 || s.subtitleTracks.length > 0
    || [...s.videoTracks, ...s.audioTracks].some((t) => t.clips.length > 0));
}

export function createMediaItem(path: string, name: string): MediaItem {
  return {
    id: uid('med'), name, path, kind: 'unknown', category: 'Other', identity: {}, binId: null,
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
    notes: '', tags: [], addedAt: Date.now(),
  };
}

/**
 * Validate + migrate a parsed project JSON, and say what had to be repaired.
 *
 * - Throws ProjectIncompatibleError when formatVersion is missing / not a positive integer (not a project file)
 *   or newer than this build reads.
 * - Throws a plain Error for damage it cannot repair without losing work: a top-level collection holding user
 *   work (media / sequences / scenes / subtitleTracks) that is present but not an object (the loader then
 *   tries the .bak). A missing (or null) collection is just empty.
 * - Otherwise repairs, and lists each kind of repair in `repairs` (with a count):
 *   - entries that are not objects, or cannot be placed, are dropped; wrongly typed fields of a kept entry are
 *     reset to their defaults; values nested deeper than MAX_PROJECT_DEPTH are dropped;
 *   - every timeline position / duration (frames) becomes a safe integer in 0..MAX_TIMELINE_FRAMES: fractional
 *     values are rounded (a span rounds both of its ends, so touching clips keep touching), an item that starts
 *     outside the range is dropped (a view value is reset), an end past the range is pulled in;
 *   - source positions (seconds) must lie within MAX_SOURCE_SECONDS; clip speed is clamped to the UI range;
 *   - clips on one track never overlap: in start order, a clip overlapping the clips before it loses its
 *     overlapping head when at least one frame of it remains, otherwise it moves, unchanged, to an extra track
 *     of the same kind appended to the sequence (at most MAX_OVERFLOW_TRACKS of them; beyond that it is dropped);
 *   - duplicate ids within a sequence (tracks, clips, transitions, markers, story blocks, subtitle tracks, cues)
 *     are re-issued, the first occurrence keeping its id; transitions on the renamed clip's track follow it;
 *   - references that only resolve through Object.prototype ("constructor", "toString", ...) are cleared.
 *   Expected state resets (queued / running jobs do not survive a restart) and defaults for absent fields
 *   (older files) are not repairs. Valid data is left as it is, and normalizing the result again repairs nothing.
 */
export function normalizeProjectWithReport(raw: unknown): { project: Project; repairs: string[] } {
  const outer = repairLog;
  const log = new Map<string, number>();
  repairLog = log;
  try {
    const project = normalizeInner(raw);
    return { project, repairs: [...log].map(([what, n]) => (n > 1 ? `${what} (${n}x)` : what)) };
  } finally {
    repairLog = outer;
  }
}

/** normalizeProjectWithReport without the report. */
export function normalizeProject(raw: unknown): Project {
  return normalizeProjectWithReport(raw).project;
}

function normalizeInner(raw: unknown): Project {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Project file is not a JSON object');
  const p = raw as Obj;
  const fv = p.formatVersion;
  if (fv === undefined || fv === null) throw new ProjectIncompatibleError(`Missing formatVersion; not a ${PRODUCT_NAME} project`, 'notProject');
  if (typeof fv !== 'number' || !Number.isInteger(fv) || fv < 1) {
    throw new ProjectIncompatibleError(`Invalid formatVersion ${describeValue(fv)}; not a ${PRODUCT_NAME} project`, 'notProject');
  }
  if (fv > PROJECT_FORMAT_VERSION) throw new ProjectIncompatibleError(`Project was saved by a newer ${PRODUCT_NAME} (format ${fv}); this build reads ${PROJECT_FORMAT_VERSION}`, 'newer');
  note(`value nested more than ${MAX_PROJECT_DEPTH} levels deep removed`, pruneDeepValues(p));
  const base = createProject(str(p.name, 'Untitled Project'));
  const out = {
    ...base,
    ...p,
    formatVersion: PROJECT_FORMAT_VERSION,
    id: idOr(p.id, () => base.id),
    name: base.name,
    createdAt: num(p.createdAt, base.createdAt),
    modifiedAt: num(p.modifiedAt, base.modifiedAt),
    media: entries(p.media, 'media', repairMedia),
    bins: p.bins ?? base.bins,
    sequences: entries(p.sequences, 'sequences', (s, id) => repairSequence(s, id, DEFAULT_SEQUENCE_FPS)),
    scenes: entries(p.scenes, 'scenes', repairScene),
    subtitleTracks: entries(p.subtitleTracks, 'subtitleTracks', repairSubtitleTrack),
    tags: repairTags(p.tags),
    settings: repairSettings(p.settings),
    sequenceOrder: strList(p.sequenceOrder),
    activeSequenceId: nullableStr(p.activeSequenceId),
  } as Project;
  const order = [...new Set(out.sequenceOrder)].filter((id) => Object.hasOwn(out.sequences, id));
  for (const id of Object.keys(out.sequences)) if (!order.includes(id)) order.push(id);
  if (order.length !== out.sequenceOrder.length || order.some((id, i) => id !== out.sequenceOrder[i])) note('sequence order repaired');
  out.sequenceOrder = order;
  if (!out.activeSequenceId || !Object.hasOwn(out.sequences, out.activeSequenceId)) {
    if (out.activeSequenceId) note('unknown active sequence replaced');
    out.activeSequenceId = out.sequenceOrder[0] ?? null;
  }
  if (out.sequenceOrder.length === 0) {
    const seq = createSequence('Sequence 01'); seq.binId = 'bin-sequences';
    out.sequences[seq.id] = seq; out.sequenceOrder.push(seq.id); out.activeSequenceId = seq.id;
  }
  repairBins(out);
  repairPrototypeRefs(out);
  repairNesting(out);
  return out;
}

// ------------------------------------------------------------------
// Normalization helpers. They repair parsed JSON in place (it is a fresh copy) and return it typed.
// ------------------------------------------------------------------

type Obj = Record<string, unknown>;

/** Repairs of the normalizeProjectWithReport call in progress (what -> count); null outside one. */
let repairLog: Map<string, number> | null = null;
function note(what: string, n = 1): void {
  if (repairLog && n > 0) repairLog.set(what, (repairLog.get(what) ?? 0) + n);
}
const FIELD_RESET = 'wrongly typed or out-of-range value reset to its default';
const ROUNDED = 'timeline position rounded to a whole frame';

function describeFps(fps: unknown): string {
  if (!fps || typeof fps !== 'object') return String(fps);
  const r = fps as { num?: unknown; den?: unknown };
  return `${String(r.num)}/${String(r.den)}`;
}
function describeValue(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : String(v);
}

function isObj(v: unknown): v is Obj { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isFiniteNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isStr(v: unknown): v is string { return typeof v === 'string'; }
function isBool(v: unknown): v is boolean { return typeof v === 'boolean'; }
function isNonNegInt(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) >= 0; }
function isPosInt(v: unknown): v is number { return Number.isSafeInteger(v) && (v as number) > 0; }
const nonNeg = (n: number) => n >= 0;
const positive = (n: number) => n > 0;
const unit = (n: number) => n >= 0 && n <= 1;
/** A length in frames that is not part of the timeline layout (fades): 0..MAX_TIMELINE_FRAMES. */
const frameLength = (n: number) => n >= 0 && n <= MAX_TIMELINE_FRAMES;
/** A source position in seconds. */
const sourceSeconds = (n: number) => n >= 0 && n <= MAX_SOURCE_SECONDS;

/** `v` when it is a string, else `d` (a present, wrongly typed value is a repair). */
function str(v: unknown, d: string): string {
  if (typeof v === 'string') return v;
  if (v !== undefined) note(FIELD_RESET);
  return d;
}
function bool(v: unknown, d: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v !== undefined) note(FIELD_RESET);
  return d;
}
/** `v` when it is a finite number accepted by `ok`, else `d`. */
function num(v: unknown, d: number, ok: (n: number) => boolean = () => true): number {
  if (isFiniteNum(v) && ok(v)) return v;
  if (v !== undefined) note(FIELD_RESET);
  return d;
}
/** A string, or null (absent / null); anything else is reset to null. */
function nullableStr(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v != null) note(FIELD_RESET);
  return null;
}
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) { if (v !== undefined) note(FIELD_RESET); return []; }
  if (every(v, isStr)) return v; // the common case: keep the (fresh, parsed) array instead of copying it
  const out = v.filter(isStr);
  note('list entry that is not text removed', v.length - out.length);
  return out;
}
/** The object entries of a list; `what` names an entry in the repair report. */
function objList(v: unknown, what = 'list entry'): Obj[] {
  if (!Array.isArray(v)) { if (v !== undefined) note(FIELD_RESET); return []; }
  if (every(v, isObj)) return v as Obj[];
  const out = v.filter(isObj);
  note(`${what} that is not an object removed`, v.length - out.length);
  return out;
}
/** Every index of `v` (holes included, unlike Array#every) passes `ok`. */
function every(v: unknown[], ok: (x: unknown) => boolean): boolean {
  for (let i = 0; i < v.length; i++) if (!ok(v[i])) return false;
  return true;
}
/** `v` when it is one of the keys of `table` (own keys only: never "toString" & co.), else `d`. */
function oneOf<K extends string>(v: unknown, table: Record<K, true>, d: K): K {
  if (isStr(v) && Object.hasOwn(table, v)) return v as K;
  if (v !== undefined) note(FIELD_RESET);
  return d;
}
/** Remove an optional field that is present with an unusable value. */
function optional(o: Obj, key: string, ok: (v: unknown) => boolean): void {
  if (key in o && !ok(o[key])) { delete o[key]; note(FIELD_RESET); }
}
function idOr(v: unknown, make: () => string): string {
  if (typeof v === 'string' && v !== '') return v;
  if (v !== undefined) note('missing or invalid id replaced');
  return make();
}
/** `x` is not an own key of `rec` but resolves through its prototype ("constructor", "toString", "__proto__"). */
function inheritedOnly(rec: object, x: string): boolean { return !Object.hasOwn(rec, x) && x in rec; }

/** A timeline position: finite, rounded to a whole frame, within 0..MAX_TIMELINE_FRAMES; else null. */
function framePos(v: unknown): number | null {
  if (!isFiniteNum(v)) return null;
  const f = Math.round(v) + 0; // + 0: never -0
  return f >= 0 && f <= MAX_TIMELINE_FRAMES ? f : null;
}
/** `n` needs no rounding (a whole number, or too large for fractions). */
function isWhole(n: number): boolean { return Math.round(n) === n || !Number.isFinite(n); }
/** The rounded end of a span starting at the (unrounded) `start`, pulled in to MAX_TIMELINE_FRAMES. */
function frameEnd(start: number, length: number, what: string): number {
  const e = Math.round(start + length);
  if (e > MAX_TIMELINE_FRAMES) { note(`${what} shortened to end at the timeline limit`); return MAX_TIMELINE_FRAMES; }
  return e;
}

/**
 * Remove every object / array nested deeper than MAX_PROJECT_DEPTH (the root is depth 1); returns how many.
 * Recursive, but it never descends below MAX_PROJECT_DEPTH (the children there are removed, not visited), so
 * arbitrarily deep input cannot overflow the stack here; afterwards JSON.stringify / structuredClone of the project
 * cannot either. (Recursion instead of an explicit stack: about a third faster on a 27 MB project.)
 */
function pruneDeepValues(v: Obj | unknown[], depth = 1): number {
  let removed = 0;
  const tooDeep = depth >= MAX_PROJECT_DEPTH;
  if (Array.isArray(v)) {
    let w = 0;
    const n = v.length;
    for (let i = 0; i < n; i++) {
      const x: unknown = v[i];
      if (x !== null && typeof x === 'object') {
        if (tooDeep) { removed++; continue; }
        removed += pruneDeepValues(x as Obj, depth + 1);
      }
      if (w !== i) v[w] = x;
      w++;
    }
    if (w !== n) v.length = w;
  } else {
    // Parsed JSON: plain objects without enumerable inherited keys, so for-in sees own keys only.
    for (const k in v) {
      const x = v[k];
      if (x === null || typeof x !== 'object') continue;
      if (tooDeep) { delete v[k]; removed++; } else removed += pruneDeepValues(x as Obj, depth + 1);
    }
  }
  return removed;
}

// Exhaustive tables: adding a member to one of these unions without updating them fails typecheck.
const TRANSITION_TYPES: Record<TransitionType, true> = { crossDissolve: true, dipToBlack: true, audioCrossfade: true };
const MEDIA_KINDS: Record<MediaKind, true> = { video: true, audio: true, image: true, subtitle: true, unknown: true };
const PROXY_STATUSES: Record<ProxyStatus, true> = { none: true, queued: true, running: true, ready: true, failed: true };
const MARKER_KINDS: Record<MarkerKind, true> = { marker: true, continuity: true, chapter: true };
const JOB_STATES: Record<NonNullable<MediaItem['sceneDetectStatus']>, true> = { none: true, running: true, done: true, failed: true };
const WAVEFORM_STATES: Record<NonNullable<MediaItem['waveformStatus']>, true> = { none: true, running: true, ready: true, failed: true };
const BIN_KINDS: Record<NonNullable<Bin['kind']>, true> = { bin: true, series: true, season: true, collection: true };
const PLAYBACK_RESOLUTIONS: Record<ProjectSettings['playbackResolution'], true> = { full: true, '1/2': true, '1/4': true };

/** Extra tracks per kind and sequence that overlapping clips may be moved to on load. */
const MAX_OVERFLOW_TRACKS = 32;

/**
 * A top-level record of entries. Missing / null: empty. Present but not an object: damage (throws). Entries
 * that are not objects, and a "__proto__" key (an own property after JSON.parse), are dropped.
 */
function entries<T>(v: unknown, label: string, repair: (o: Obj, id: ID) => T | null): Record<ID, T> {
  const out: Record<ID, T> = {};
  if (v === undefined || v === null) return out;
  if (!isObj(v)) throw new Error(`Project data is damaged: "${label}" must be an object, found ${Array.isArray(v) ? 'an array' : typeof v}`);
  for (const [id, o] of Object.entries(v)) {
    if (id === '__proto__' || !isObj(o)) { note(`${label} entry that is not an object removed`); continue; }
    const r = repair(o, id);
    if (r !== null) out[id] = r;
  }
  return out;
}

/** An entry of a keyed collection carries its key as id. */
function keyedId(o: Obj, id: ID): void {
  if (o.id !== undefined && o.id !== id) note('id that differs from its key replaced');
  o.id = id;
}

/** A stored frame rate: kept when valid, a bare number (hand-edited file) goes through parseFps, else `fallback`. */
function repairFps(v: unknown, fallback: Readonly<Rational>): Rational {
  if (isValidFps(v)) return v;
  if (v !== undefined) note('invalid frame rate replaced');
  const parsed = isFiniteNum(v) ? parseFps(v) : null;
  return parsed ? { ...parsed } : { ...fallback };
}

function repairSequence(s: Obj, id: ID, fallbackFps: Readonly<Rational>): Sequence {
  keyedId(s, id);
  const template = createSequence(str(s.name, 'Sequence'));
  const fps = repairFps(s.fps, fallbackFps);
  const posInt = (v: unknown, d: number) => { if (isPosInt(v)) return v; if (v !== undefined) note(FIELD_RESET); return d; };
  const seq = {
    ...template, ...s, id,
    name: template.name,
    fps,
    width: posInt(s.width, template.width),
    height: posInt(s.height, template.height),
    sampleRate: posInt(s.sampleRate, template.sampleRate),
    channels: posInt(s.channels, template.channels),
    createdAt: num(s.createdAt, template.createdAt),
    modifiedAt: num(s.modifiedAt, template.modifiedAt),
    binId: nullableStr(s.binId),
    videoTracks: repairTracks(s.videoTracks, 'video', template.videoTracks, fps),
    audioTracks: repairTracks(s.audioTracks, 'audio', template.audioTracks, fps),
    subtitleTracks: objList(s.subtitleTracks, 'subtitle track').map(repairSequenceSubtitleTrack),
    markers: objList(s.markers, 'marker').map(repairMarker).filter((m): m is Marker => m !== null),
    storyBlocks: objList(s.storyBlocks, 'story block').map(repairStoryBlock).filter((b): b is StoryBlock => b !== null),
    snapshots: objList(s.snapshots, 'snapshot').map((x) => repairSnapshot(x, id, fps)).filter((x): x is SequenceSnapshot => x !== null),
    view: new LiveView(repairView(s.view, template.view)),
  } as Sequence;
  optional(seq as unknown as Obj, 'parentSequenceId', isStr);
  optional(seq as unknown as Obj, 'versionLabel', isStr);
  dedupeSequenceIds(seq);
  for (const t of [...seq.videoTracks, ...seq.audioTracks]) reconcileLoadedTransitions(t);
  return seq;
}

/** A snapshot needs its data; the data is a sequence (without snapshots) and is repaired like one. */
function repairSnapshot(sn: Obj, seqId: ID, seqFps: Rational): SequenceSnapshot | null {
  if (!isObj(sn.data)) { note('snapshot without data removed'); return null; }
  const { snapshots: _nested, ...data } = sn.data;
  if (_nested !== undefined) note('snapshot nested in a snapshot removed');
  const dataId = idOr(data.id, () => seqId);
  const repaired: Partial<Sequence> = repairSequence({ ...data, id: dataId }, dataId, seqFps);
  delete repaired.snapshots;
  return {
    ...sn,
    id: idOr(sn.id, () => uid('snap')),
    name: str(sn.name, ''),
    createdAt: num(sn.createdAt, 0),
    data: repaired as SequenceSnapshot['data'],
  } as SequenceSnapshot;
}

/**
 * The tracks of one kind. Clips are placed (see placeClip), sorted, and overlaps resolved; clips that do not fit
 * on their track go to extra tracks appended after the stored ones.
 */
function repairTracks(v: unknown, kind: Track['kind'], template: Track[], fps: Rational): Track[] {
  const list = objList(v, 'track');
  if (!list.length) return template;
  const displaced: Clip[] = [];
  const tracks = list.map((t, i) => repairTrack(t, kind, i + 1, fps, displaced));
  if (displaced.length) placeDisplaced(tracks, displaced, kind);
  return tracks;
}

function repairTrack(t: Obj, kind: Track['kind'], index: number, fps: Rational, displaced: Clip[]): Track {
  const d = makeTrack(kind, index);
  const track = {
    ...d, ...t,
    id: idOr(t.id, () => d.id),
    name: str(t.name, d.name),
    kind,
    muted: bool(t.muted, d.muted), solo: bool(t.solo, d.solo), locked: bool(t.locked, d.locked), patched: bool(t.patched, d.patched),
    height: num(t.height, d.height, positive),
    volume: num(t.volume, d.volume, nonNeg),
    clips: objList(t.clips, 'clip').filter(placeClip).map((c) => repairClip(c, kind)),
    // A transition needs a known type and clip references that are ids or null; reconcileTransitions (after the
    // ids are unique) then drops the ones whose clips are gone / not adjacent and clamps durations.
    transitions: objList(t.transitions, 'transition').filter((tr) => {
      const ok = isStr(tr.type) && Object.hasOwn(TRANSITION_TYPES, tr.type)
        && (tr.outClipId == null || isStr(tr.outClipId)) && (tr.inClipId == null || isStr(tr.inClipId));
      if (!ok) note('transition of unknown type or with invalid clip references removed');
      return ok;
    }).map((tr) => {
      if (isFiniteNum(tr.duration) && Math.round(tr.duration) !== tr.duration) { tr.duration = Math.round(tr.duration); note(ROUNDED); }
      return { ...tr, id: idOr(tr.id, () => uid('tr')), outClipId: tr.outClipId ?? null, inClipId: tr.inClipId ?? null } as Transition;
    }),
  } as Track;
  track.clips.sort((a, b) => a.start - b.start);
  track.clips = resolveOverlaps(track.clips, fps, displaced);
  return track;
}

/** reconcileTransitions, reporting what it dropped or shortened. */
function reconcileLoadedTransitions(track: Track): void {
  if (track.transitions.length === 0) return; // nothing to drop or fit
  const before = track.transitions.map((t) => t.duration);
  reconcileTransitions(track);
  const after = track.transitions;
  note('transition between clips that are missing or not adjacent removed', before.length - after.length);
  if (after.length === before.length && after.some((t, i) => t.duration !== before[i])) note('transition duration fitted to its clips');
}

/**
 * Sorted clips of one track -> the clips that stay, none overlapping. A clip that starts before the end of the
 * clips kept so far loses its overlapping head (start, duration and sourceIn move together) when at least one
 * frame of it is left; otherwise it is pushed, unchanged, to `displaced`.
 */
function resolveOverlaps(clips: Clip[], fps: Rational, displaced: Clip[]): Clip[] {
  const kept: Clip[] = [];
  let end = 0;
  for (const c of clips) {
    if (kept.length && c.start < end) {
      const cut = end - c.start;
      if (c.duration - cut < 1) { displaced.push(c); note('clip covered by an earlier clip on its track moved to a new track'); continue; }
      c.start = end;
      c.duration -= cut;
      c.sourceIn += (cut * fps.den / fps.num) * c.speed;
      shiftClipKeyframes(c, cut);
      note('overlapping clip shortened at its start');
    }
    kept.push(c);
    end = c.start + c.duration;
  }
  return kept;
}

/** Put displaced clips on extra tracks of `kind` (first track they fit on, in start order). */
function placeDisplaced(tracks: Track[], displaced: Clip[], kind: Track['kind']): void {
  displaced.sort((a, b) => a.start - b.start);
  const extra: { track: Track; end: number }[] = [];
  for (const c of displaced) {
    let slot = extra.find((x) => x.end <= c.start);
    if (!slot) {
      if (extra.length >= MAX_OVERFLOW_TRACKS) { note('overlapping clip removed (too many overlapping layers)'); continue; }
      slot = { track: makeTrack(kind, tracks.length + 1), end: 0 };
      slot.track.patched = false;
      tracks.push(slot.track);
      extra.push(slot);
    }
    slot.track.clips.push(c);
    slot.end = c.start + c.duration;
  }
}

/**
 * A clip survives load only with a usable position, length and source in (older files may omit sourceIn: 0).
 * Its span is rounded to whole frames (both ends, so touching clips keep touching) and must start within
 * 0..MAX_TIMELINE_FRAMES - 1; an end past MAX_TIMELINE_FRAMES is pulled in.
 */
function placeClip(c: Obj): boolean {
  if (c.sourceIn === undefined) c.sourceIn = 0;
  const { start, duration, sourceIn } = c;
  if (!isFiniteNum(start) || start < 0 || !isFiniteNum(duration) || duration < 1 || !isFiniteNum(sourceIn) || !sourceSeconds(sourceIn)) {
    note('clip without a usable position, length or source position removed');
    return false;
  }
  const s = framePos(start);
  if (s === null || s >= MAX_TIMELINE_FRAMES) { note('clip placed beyond the timeline limit removed'); return false; }
  if (s !== start || !isWhole(start + duration)) note(ROUNDED);
  const e = frameEnd(start, duration, 'clip');
  c.start = s;
  c.duration = e - s;
  return true;
}

function repairClip(c: Obj, trackKind: Track['kind']): Clip {
  c.id = idOr(c.id, () => uid('clip'));
  c.mediaId = str(c.mediaId, '');
  c.name = str(c.name, '');
  c.linkId = nullableStr(c.linkId);
  c.transform = repairTransform(c.transform);
  c.audio = repairClipAudio(c.audio);
  c.tags = strList(c.tags); c.characters = strList(c.characters); c.plotlines = strList(c.plotlines); c.locations = strList(c.locations);
  c.notes = str(c.notes, '');
  if (c.speed === undefined) c.speed = 1;
  else if (!isFiniteNum(c.speed) || !(c.speed > 0)) { c.speed = 1; note(FIELD_RESET); }
  else if (c.speed < SPEED_MIN || c.speed > SPEED_MAX) { c.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, c.speed)); note('clip speed clamped to the supported range'); }
  c.enabled = bool(c.enabled, true);
  if (c.kind !== 'video' && c.kind !== 'audio') { if (c.kind !== undefined) note(FIELD_RESET); c.kind = trackKind; }
  optional(c, 'audioStream', isNonNegInt);
  optional(c, 'color', isStr); optional(c, 'sceneRecordId', isStr); optional(c, 'originLabel', isStr);
  // Nested sequence (Roadmap §8): the clip's media id is the sequence id and it plays at speed 1 (shared/nest.ts).
  optional(c, 'sequenceId', (v) => isStr(v) && v !== '');
  if (isStr(c.sequenceId)) {
    if (c.mediaId !== c.sequenceId) { c.mediaId = c.sequenceId; note(FIELD_RESET); }
    if (c.speed !== 1) { c.speed = 1; note(FIELD_RESET); }
  }
  return c as unknown as Clip;
}
const SPEED_MIN = SPEED_PERCENT_MIN / 100;
const SPEED_MAX = SPEED_PERCENT_MAX / 100;

function repairTransform(v: unknown): ClipTransform {
  const d = defaultTransform();
  if (v !== undefined && !isObj(v)) note(FIELD_RESET);
  const t = isObj(v) ? v : {};
  if (t.crop !== undefined && !isObj(t.crop)) note(FIELD_RESET);
  const crop = isObj(t.crop) ? t.crop : {};
  const out = {
    ...t,
    x: num(t.x, d.x), y: num(t.y, d.y), scale: num(t.scale, d.scale, positive), rotation: num(t.rotation, d.rotation),
    opacity: num(t.opacity, d.opacity, unit),
    crop: { ...crop, left: num(crop.left, 0, unit), top: num(crop.top, 0, unit), right: num(crop.right, 0, unit), bottom: num(crop.bottom, 0, unit) },
  } as ClipTransform;
  // Keyframes (Roadmap §11): optional; unusable entries dropped (shared/keyframes.ts).
  if ('keyframes' in out) repairKeyframes(out, TRANSFORM_KEY_PROPS);
  return out;
}

function repairKeyframes(owner: ClipTransform | ClipAudio, props: readonly KeyProp[]): void {
  const r = normalizeKeyframeSet(props, owner.keyframes);
  if (r.repaired) note('invalid keyframes removed or fixed');
  if (r.value) owner.keyframes = r.value; else delete owner.keyframes;
}

function repairClipAudio(v: unknown): ClipAudio {
  const d = defaultAudio();
  if (v !== undefined && !isObj(v)) note(FIELD_RESET);
  const a = isObj(v) ? v : {};
  const out = {
    ...a,
    gain: num(a.gain, d.gain), volume: num(a.volume, d.volume, nonNeg),
    fadeIn: num(a.fadeIn, d.fadeIn, frameLength), fadeOut: num(a.fadeOut, d.fadeOut, frameLength), muted: bool(a.muted, d.muted),
  } as ClipAudio;
  // Channel selection (Roadmap §9): optional; an unusable one plays the stream's normal mix (absent).
  if ('channelSelection' in out) {
    const sel = normalizeChannelSelection(out.channelSelection);
    if (sel.repaired) note(FIELD_RESET);
    if (sel.value) out.channelSelection = sel.value; else delete out.channelSelection;
  }
  if ('keyframes' in out) repairKeyframes(out, AUDIO_KEY_PROPS);
  return out;
}

function repairSequenceSubtitleTrack(t: Obj): SequenceSubtitleTrack {
  // Imported subtitle files (protected from export overwrite): a list of non-empty paths, or absent.
  if ('sourcePaths' in t) {
    const paths = Array.isArray(t.sourcePaths) ? t.sourcePaths.filter((x): x is string => isStr(x) && x !== '') : [];
    if (!Array.isArray(t.sourcePaths) || paths.length !== t.sourcePaths.length) note('invalid subtitle source path removed');
    if (paths.length) t.sourcePaths = paths; else delete t.sourcePaths;
  }
  return {
    ...t,
    id: idOr(t.id, () => uid('sst')),
    name: str(t.name, ''),
    language: str(t.language, 'und'),
    enabled: bool(t.enabled, true),
    cues: objList(t.cues, 'subtitle cue').map(repairSequenceCue).filter((c): c is SequenceSubtitleCue => c !== null),
  } as SequenceSubtitleTrack;
}

/**
 * A cue attached to a clip is placed from the clip (its stored start / duration are only a cache: an unusable
 * value becomes 0). A free cue needs a start within the timeline and at least one frame (rounded like a clip).
 */
function repairSequenceCue(c: Obj): SequenceSubtitleCue | null {
  optional(c, 'clipId', (v) => isStr(v) && v !== '');
  optional(c, 'srcStart', isFiniteNum);
  optional(c, 'srcEnd', isFiniteNum);
  if ('clipId' in c) {
    for (const k of ['start', 'duration'] as const) {
      const f = framePos(c[k]);
      if (f === null || f !== c[k]) { if (c[k] !== undefined) note(f === null ? FIELD_RESET : ROUNDED); c[k] = f ?? 0; }
    }
  } else {
    const s = framePos(c.start);
    if (s === null || s >= MAX_TIMELINE_FRAMES || !isFiniteNum(c.duration)) { note('free subtitle cue without a usable position removed'); return null; }
    const e = frameEnd(c.start as number, c.duration, 'subtitle cue');
    if (e - s < 1) { note('free subtitle cue without a positive length removed'); return null; }
    if (s !== c.start || !isWhole((c.start as number) + c.duration)) note(ROUNDED);
    c.start = s; c.duration = e - s;
  }
  c.id = idOr(c.id, () => uid('scue'));
  if (c.offset === undefined) c.offset = 0;
  else if (!isFiniteNum(c.offset) || Math.abs(Math.round(c.offset)) > MAX_TIMELINE_FRAMES) { note(FIELD_RESET); c.offset = 0; }
  else if (Math.round(c.offset) !== c.offset) { note(ROUNDED); c.offset = Math.round(c.offset) + 0; }
  c.text = str(c.text, '');
  repairWords(c);
  return c as unknown as SequenceSubtitleCue;
}

function repairMarker(m: Obj): Marker | null {
  const t = framePos(m.time);
  if (t === null || !isFiniteNum(m.time) || m.time < 0) { note('marker without a usable time removed'); return null; }
  if (m.duration === undefined) m.duration = 0;
  else if (!isFiniteNum(m.duration) || m.duration < 0) { note(FIELD_RESET); m.duration = 0; }
  if (t !== m.time || !isWhole(m.time + (m.duration as number))) note(ROUNDED);
  m.duration = frameEnd(m.time, m.duration as number, 'marker') - t;
  m.time = t;
  m.id = idOr(m.id, () => uid('mk'));
  m.name = str(m.name, ''); m.note = str(m.note, ''); m.color = str(m.color, '#4d7cfe');
  m.kind = oneOf(m.kind, MARKER_KINDS, 'marker');
  optional(m, 'category', isStr); optional(m, 'resolved', isBool); optional(m, 'clipId', isStr);
  return m as unknown as Marker;
}

/** A story block spans start..end frames: a reversed one is turned around; it must start within the timeline. */
function repairStoryBlock(b: Obj): StoryBlock | null {
  if (!isFiniteNum(b.start) || !isFiniteNum(b.end)) { note('story block without a usable range removed'); return null; }
  let lo = b.start, hi = b.end;
  if (hi < lo) { [lo, hi] = [hi, lo]; note('story block with its end before its start turned around'); }
  const s = framePos(lo);
  if (s === null || s >= MAX_TIMELINE_FRAMES) { note('story block outside the timeline removed'); return null; }
  if (s !== lo || !isWhole(hi)) note(ROUNDED);
  const e = frameEnd(lo, hi - lo, 'story block');
  b.start = s; b.end = e;
  b.id = idOr(b.id, () => uid('sb'));
  b.name = str(b.name, ''); b.color = str(b.color, '#7c5cff'); b.notes = str(b.notes, '');
  return b as unknown as StoryBlock;
}

function repairView(raw: unknown, defaults: Sequence['view']): Sequence['view'] {
  if (raw !== undefined && !isObj(raw)) note(FIELD_RESET);
  const v: Obj = isObj(raw) ? raw : {};
  const frame = (x: unknown, d: number) => { const f = framePos(x); if (f !== x && x !== undefined) note(f === null ? FIELD_RESET : ROUNDED); return f ?? d; };
  const inOut = (x: unknown) => { if (x === null || x === undefined) return null; const f = framePos(x); if (f !== x) note(f === null ? FIELD_RESET : ROUNDED); return f; };
  let zoom = defaults.zoom;
  if (isFiniteNum(v.zoom) && v.zoom > 0) {
    zoom = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, v.zoom));
    if (zoom !== v.zoom) note(FIELD_RESET);
  } else if (v.zoom !== undefined) note(FIELD_RESET);
  return {
    ...v,
    playhead: frame(v.playhead, 0),
    zoom,
    scroll: num(v.scroll, 0, (n) => n >= 0 && n <= MAX_TIMELINE_FRAMES), // fractional: the first visible frame
    inPoint: inOut(v.inPoint),
    outPoint: inOut(v.outPoint),
  } as unknown as Sequence['view'];
}

/**
 * Ids are unique within a sequence: tracks (video and audio together), clips (all tracks), transitions,
 * markers, story blocks, subtitle tracks, and cues (all subtitle tracks). A repeated id is re-issued, the first
 * occurrence keeps it. Transitions on the track of a renamed clip are pointed at the clips that make them
 * adjacent (else at the first clip carrying the referenced id); markers / cues keep pointing at the first.
 */
function dedupeSequenceIds(seq: Sequence): void {
  const tracks = [...seq.videoTracks, ...seq.audioTracks];
  uniqueIds([tracks], (t) => uid(t.kind === 'video' ? 'v' : 'a'), 'track');
  const renamedFrom = new Map<Clip, ID>();
  uniqueIds(tracks.map((t) => t.clips), () => uid('clip'), 'clip', (c, old) => renamedFrom.set(c, old));
  if (renamedFrom.size) for (const t of tracks) retargetTransitions(t, renamedFrom);
  uniqueIds(tracks.map((t) => t.transitions), () => uid('tr'), 'transition');
  uniqueIds([seq.markers], () => uid('mk'), 'marker');
  uniqueIds([seq.storyBlocks], () => uid('sb'), 'story block');
  uniqueIds([seq.subtitleTracks], () => uid('sst'), 'subtitle track');
  uniqueIds(seq.subtitleTracks.map((t) => t.cues), () => uid('scue'), 'subtitle cue');
}

/** Ids unique across the items of all `lists`, in order (lists instead of one flattened copy: no big temporary). */
function uniqueIds<T extends { id: ID }>(lists: T[][], make: (item: T) => ID, what: string, renamed?: (item: T, old: ID) => void): void {
  const seen = new Set<ID>();
  for (const items of lists) {
    for (const it of items) {
      if (seen.has(it.id)) {
        const old = it.id;
        let id = make(it);
        while (seen.has(id)) id = make(it);
        it.id = id;
        note(`duplicate ${what} id re-issued`);
        renamed?.(it, old);
      }
      seen.add(it.id);
    }
  }
}

function retargetTransitions(track: Track, renamedFrom: Map<Clip, ID>): void {
  if (!track.transitions.length || !track.clips.some((c) => renamedFrom.has(c))) return;
  const byStoredId = new Map<ID, Clip[]>();
  for (const c of track.clips) {
    const key = renamedFrom.get(c) ?? c.id;
    const list = byStoredId.get(key);
    if (list) list.push(c); else byStoredId.set(key, [c]);
  }
  for (const tr of track.transitions) {
    const outs = tr.outClipId ? byStoredId.get(tr.outClipId) : undefined;
    const ins = tr.inClipId ? byStoredId.get(tr.inClipId) : undefined;
    let a = outs?.[0], b = ins?.[0];
    if (outs && ins) {
      search: for (const x of outs) for (const y of ins) if (x !== y && x.start + x.duration === y.start) { a = x; b = y; break search; }
    }
    if (a) tr.outClipId = a.id;
    if (b) tr.inClipId = b.id;
  }
}

/**
 * Nested sequences (Roadmap §8): a reference that only resolves through Object.prototype is removed, and so is every
 * reference that closes a cycle (A in B in A) or nests deeper than MAX_NEST_DEPTH (shared/nest.ts nestingRepairs),
 * and then every nested clip that makes a sequence flatten past MAX_FLAT_TRACKS / MAX_FLAT_CLIPS (nestSizeRepairs):
 * those clips stay where they are as clips of missing media. A reference to a sequence that is not in the project
 * stays (the clip renders as offline, like missing media).
 */
function repairNesting(p: Project): void {
  const seqs: Omit<Sequence, 'snapshots'>[] = [];
  for (const s of Object.values(p.sequences)) { seqs.push(s); for (const sn of s.snapshots) seqs.push(sn.data); }
  let any = false;
  for (const s of seqs) {
    for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) {
      if (c.sequenceId === undefined) continue;
      if (inheritedOnly(p.sequences, c.sequenceId)) { delete c.sequenceId; note('nested sequence reference that is not a sequence id cleared'); continue; }
      any = true;
    }
  }
  if (!any) return;
  for (const [host, child] of nestingRepairs(p.sequences, p.sequenceOrder)) {
    const seq = p.sequences[host];
    for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) {
      if (c.sequenceId === child) { delete c.sequenceId; note('nested sequence that contained itself or was nested too deep made offline'); }
    }
    // New track lists: shared/nest.ts caches the references per list.
    seq.videoTracks = [...seq.videoTracks]; seq.audioTracks = [...seq.audioTracks];
  }
  const sized = new Set<ID>();
  for (const [host, clipId] of nestSizeRepairs(p.sequences, p.sequenceOrder)) {
    const seq = p.sequences[host];
    for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) {
      if (c.id === clipId && c.sequenceId !== undefined) { delete c.sequenceId; note(`nested sequence that would expand to more than ${FLAT_LIMIT_TEXT} when flattened made offline`); }
    }
    sized.add(host);
  }
  for (const host of sized) {
    const seq = p.sequences[host];
    seq.videoTracks = [...seq.videoTracks]; seq.audioTracks = [...seq.audioTracks];
  }
}

/** References into keyed collections that only resolve through Object.prototype are cleared (missing). */
function repairPrototypeRefs(p: Project): void {
  const clearMedia = (o: { mediaId: ID }) => { if (inheritedOnly(p.media, o.mediaId)) { o.mediaId = ''; note('media reference that is not a media id cleared'); } };
  const seqs: Omit<Sequence, 'snapshots'>[] = [];
  for (const s of Object.values(p.sequences)) { seqs.push(s); for (const sn of s.snapshots) seqs.push(sn.data); }
  for (const s of seqs) {
    for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) {
      clearMedia(c);
      if (c.sceneRecordId !== undefined && inheritedOnly(p.scenes, c.sceneRecordId)) { delete c.sceneRecordId; note('scene reference that is not a scene id cleared'); }
    }
  }
  for (const sc of Object.values(p.scenes)) clearMedia(sc);
  for (const st of Object.values(p.subtitleTracks)) {
    if (st.mediaId !== null && inheritedOnly(p.media, st.mediaId)) { st.mediaId = null; note('media reference that is not a media id cleared'); }
  }
  for (const m of Object.values(p.media)) {
    const ids = m.subtitleTrackIds.filter((id) => !inheritedOnly(p.subtitleTracks, id));
    if (ids.length !== m.subtitleTrackIds.length) { m.subtitleTrackIds = ids; note('subtitle track reference that is not a subtitle track id removed'); }
  }
}

function repairMedia(m: Obj, id: ID): MediaItem {
  keyedId(m, id);
  const hasPath = isStr(m.path);
  if (!hasPath) { note('media without a file path marked offline'); m.path = ''; }
  m.name = str(m.name, '');
  m.kind = oneOf(m.kind, MEDIA_KINDS, 'unknown');
  if (!(isStr(m.category) && (MEDIA_CATEGORIES as string[]).includes(m.category))) { if (m.category !== undefined) note(FIELD_RESET); m.category = 'Other'; }
  m.identity = repairIdentity(m.identity);
  m.binId = nullableStr(m.binId); // existence is checked by repairBins
  m.offline = hasPath ? bool(m.offline, false) : true;
  m.proxy = repairProxy(m.proxy);
  m.detectedScenes = objList(m.detectedScenes, 'detected scene').map(repairDetectedScene).filter((d): d is DetectedScene => d !== null);
  m.subtitleTrackIds = strList(m.subtitleTrackIds);
  m.tags = strList(m.tags);
  m.notes = str(m.notes, '');
  m.addedAt = num(m.addedAt, 0);
  optional(m, 'sceneDetectStatus', (v) => isStr(v) && Object.hasOwn(JOB_STATES, v));
  optional(m, 'waveformStatus', (v) => isStr(v) && Object.hasOwn(WAVEFORM_STATES, v));
  // Jobs do not survive a restart (expected, not a repair).
  if (m.sceneDetectStatus === 'running') m.sceneDetectStatus = 'none';
  if (m.waveformStatus === 'running') m.waveformStatus = 'none';
  optional(m, 'color', isStr); optional(m, 'probeError', isStr);
  optional(m, 'thumbnailTime', (v) => isFiniteNum(v) && v >= 0);
  optional(m, 'preferredAudioStream', isNonNegInt);
  optional(m, 'fileSize', (v) => isFiniteNum(v) && v >= 0);
  optional(m, 'fileMtime', isFiniteNum);
  if ('probe' in m) { if (isObj(m.probe)) m.probe = repairProbe(m.probe); else { delete m.probe; note(FIELD_RESET); } }
  if ('channelProxies' in m) m.channelProxies = repairChannelProxies(m.channelProxies);
  if (m.channelProxies === undefined) delete m.channelProxies;
  return m as unknown as MediaItem;
}

function repairIdentity(v: unknown): SourceIdentity {
  if (v !== undefined && !isObj(v)) note(FIELD_RESET);
  const id: Obj = isObj(v) ? v : {};
  for (const k of ['series', 'collection', 'franchise', 'title']) optional(id, k, isStr);
  for (const k of ['season', 'episode', 'year']) optional(id, k, isFiniteNum);
  return id as SourceIdentity;
}

/** Jobs do not survive a restart: queued / running proxies become 'none' (expected); unknown states are repairs. */
function repairProxy(v: unknown): ProxyInfo {
  if (isObj(v) && (v.status === 'running' || v.status === 'queued')) return { status: 'none' };
  if (!isObj(v) || !isStr(v.status) || !Object.hasOwn(PROXY_STATUSES, v.status)) {
    if (v !== undefined) note(FIELD_RESET);
    return { status: 'none' };
  }
  optional(v, 'path', isStr); optional(v, 'error', isStr);
  for (const k of ['progress', 'width', 'height', 'audioStream']) optional(v, k, isFiniteNum);
  optional(v, 'audioStreams', (x: unknown) => Array.isArray(x) && x.every((n) => Number.isSafeInteger(n) && (n as number) >= 0));
  return v as unknown as ProxyInfo;
}

/**
 * Channel-selection preview proxies (MediaItem.channelProxies): well-formed keys with a proxy record each. Entries with
 * nothing on disk (none, or a job that did not survive the restart) are dropped, not kept as 'none'.
 */
function repairChannelProxies(v: unknown): Record<string, ProxyInfo> | undefined {
  if (!isObj(v)) { note(FIELD_RESET); return undefined; }
  const out: Record<string, ProxyInfo> = {};
  for (const k of Object.keys(v)) {
    if (!CHANNEL_PROXY_KEY.test(k)) { note(FIELD_RESET); continue; }
    const p = repairProxy(v[k]);
    if (p.status !== 'none') out[k] = p;
  }
  return Object.keys(out).length ? out : undefined;
}

function repairDetectedScene(d: Obj): DetectedScene | null {
  if (!isFiniteNum(d.start) || !isFiniteNum(d.end) || !sourceSeconds(d.start) || !sourceSeconds(d.end)) { note('detected scene without a usable range removed'); return null; }
  d.id = idOr(d.id, () => uid('ds'));
  d.name = str(d.name, '');
  d.tags = strList(d.tags); d.characters = strList(d.characters);
  return d as unknown as DetectedScene;
}

function repairProbe(pr: Obj): MediaProbe {
  pr.container = str(pr.container, '');
  pr.duration = num(pr.duration, 0, nonNeg);
  pr.size = num(pr.size, 0, nonNeg);
  pr.startTime = num(pr.startTime, 0);
  pr.browserPlayable = bool(pr.browserPlayable, false);
  pr.audio = objList(pr.audio, 'probed audio stream').filter(repairAudioStream);
  pr.subtitles = objList(pr.subtitles, 'probed subtitle stream');
  optional(pr, 'bitrate', isFiniteNum); optional(pr, 'playabilityReason', isStr);
  if ('video' in pr) { if (isObj(pr.video)) pr.video = repairVideoStream(pr.video); else { delete pr.video; note(FIELD_RESET); } }
  return pr as unknown as MediaProbe;
}

/**
 * A stored audio stream entry: it is used as is until the file is probed again (an offline file never is), so an
 * entry without a usable stream index is dropped (clips on it fall back to the first stream, as for a stream the
 * file no longer has) and the other fields are reset when unusable.
 */
function repairAudioStream(a: Obj): boolean {
  if (!isNonNegInt(a.index)) { note('probed audio stream without a usable index removed'); return false; }
  a.codec = str(a.codec, 'unknown');
  a.channels = num(a.channels, 0, (n) => Number.isSafeInteger(n) && n >= 0);
  a.layout = str(a.layout, '');
  a.sampleRate = num(a.sampleRate, 0, nonNeg);
  optional(a, 'language', isStr); optional(a, 'title', isStr); optional(a, 'layoutGuessed', isBool);
  return true;
}

/**
 * Probed frame rates: the prober stores {0,1} for "no usable rate" and readers check `fps.num > 0`, so a
 * stored rate that fails isValidFps becomes that same "unknown" value rather than an invented rate.
 */
function repairProbeFps(v: unknown): Rational {
  if (isValidFps(v)) return v;
  const r = v as { num?: unknown; den?: unknown } | null;
  if (!(isObj(r) && r.num === 0 && r.den === 1)) note('invalid frame rate replaced');
  return { num: 0, den: 1 };
}

function repairVideoStream(v: Obj): VideoStreamInfo {
  v.index = num(v.index, 0);
  v.codec = str(v.codec, 'unknown');
  v.width = num(v.width, 0, nonNeg);
  v.height = num(v.height, 0, nonNeg);
  v.fps = repairProbeFps(v.fps);
  v.avgFps = repairProbeFps(v.avgFps);
  v.isVfr = bool(v.isVfr, false);
  optional(v, 'pixFmt', isStr); optional(v, 'colorSpace', isStr);
  for (const k of ['rotation', 'codedWidth', 'codedHeight', 'startTime']) optional(v, k, isFiniteNum);
  // Sample aspect ratio: positive safe integers with a ratio in MIN_SAR..MAX_SAR (shared/media.ts), else dropped.
  if ('sar' in v) { const sar = saneSar(v.sar); if (sar) v.sar = sar; else { delete v.sar; note(FIELD_RESET); } }
  return v as unknown as VideoStreamInfo;
}

/** Library scenes need an in / out within 0..MAX_SOURCE_SECONDS; other fields are reset when wrongly typed. */
function repairScene(s: Obj, id: ID): SceneRecord | null {
  if (!isFiniteNum(s.in) || !isFiniteNum(s.out) || !sourceSeconds(s.in) || !sourceSeconds(s.out)) { note('scene without a usable range removed'); return null; }
  keyedId(s, id);
  s.name = str(s.name, ''); s.mediaId = str(s.mediaId, '');
  s.characters = strList(s.characters); s.tags = strList(s.tags);
  s.notes = str(s.notes, ''); s.location = str(s.location, ''); s.arc = str(s.arc, '');
  s.rating = num(s.rating, 0); s.color = str(s.color, '#4d7cfe'); s.createdAt = num(s.createdAt, 0);
  return s as unknown as SceneRecord;
}

/** Optional per-word timing of a cue (#118): a list of {start, end, text} in source seconds; anything else is dropped. */
function repairWords(c: Obj): void {
  if (c.words === undefined) return;
  const ok = (w: unknown): boolean => isObj(w) && isFiniteNum(w.start) && isFiniteNum(w.end) && Math.abs(w.start) <= MAX_SOURCE_SECONDS
    && Math.abs(w.end) <= MAX_SOURCE_SECONDS && typeof w.text === 'string';
  const list = Array.isArray(c.words) ? c.words.filter(ok).map((w) => ({ start: (w as Obj).start, end: (w as Obj).end, text: (w as Obj).text })) : [];
  if (!Array.isArray(c.words) || list.length !== c.words.length) note('subtitle word timing without a usable time removed');
  if (list.length) c.words = list; else delete c.words;
}

function repairSubtitleTrack(t: Obj, id: ID): SubtitleTrack {
  keyedId(t, id);
  t.name = str(t.name, ''); t.language = str(t.language, 'und'); t.origin = str(t.origin, 'srt');
  t.mediaId = nullableStr(t.mediaId);
  optional(t, 'path', isStr);
  optional(t, 'streamIndex', isNonNegInt);
  const inRange = (n: unknown) => isFiniteNum(n) && Math.abs(n) <= MAX_SOURCE_SECONDS;
  t.cues = objList(t.cues, 'subtitle cue').filter((c) => {
    const ok = inRange(c.start) && inRange(c.end);
    if (!ok) note('subtitle cue without a usable time removed');
    return ok;
  }).map((c) => {
    c.id = idOr(c.id, () => uid('cue')); c.text = str(c.text, '');
    repairWords(c);
    return c;
  });
  return t as unknown as SubtitleTrack;
}

function repairTags(v: unknown): TagVocabulary {
  if (v !== undefined && !isObj(v)) note(FIELD_RESET);
  const t = isObj(v) ? v : {};
  return {
    ...t,
    characters: strList(t.characters), plotlines: strList(t.plotlines), locations: strList(t.locations),
    themes: strList(t.themes), custom: strList(t.custom),
  } as TagVocabulary;
}

/** Each known setting must have its default's type (finite for numbers) and a value the Preferences UI allows. */
function repairSettings(v: unknown): ProjectSettings {
  const d = defaultSettings();
  if (v !== undefined && !isObj(v)) note(FIELD_RESET);
  const out: Obj = { ...(isObj(v) ? v : {}) };
  for (const [k, dv] of Object.entries(d)) {
    const cur = out[k];
    if (typeof cur !== typeof dv || (typeof dv === 'number' && !isFiniteNum(cur))) {
      if (cur !== undefined) note(FIELD_RESET);
      out[k] = dv;
    }
  }
  const s = out as unknown as ProjectSettings;
  s.playbackResolution = oneOf(s.playbackResolution, PLAYBACK_RESOLUTIONS, d.playbackResolution);
  const clampInt = (x: number, lo: number, hi: number) => {
    const r = Math.min(hi, Math.max(lo, Math.round(x)));
    if (r !== x) note('setting clamped to its allowed range');
    return r;
  };
  if (!PROXY_HEIGHTS.includes(s.proxyHeight)) {
    const want = Math.min(PROXY_HEIGHTS[PROXY_HEIGHTS.length - 1], Math.max(PROXY_HEIGHTS[0], s.proxyHeight));
    s.proxyHeight = PROXY_HEIGHTS.reduce((best, h) => (Math.abs(h - want) < Math.abs(best - want) ? h : best));
    note('setting clamped to its allowed range');
  }
  s.autosaveIntervalSec = clampInt(s.autosaveIntervalSec, AUTOSAVE_INTERVAL_MIN_SEC, AUTOSAVE_INTERVAL_MAX_SEC);
  s.defaultTransitionFrames = clampInt(s.defaultTransitionFrames, DEFAULT_TRANSITION_FRAMES_MIN, DEFAULT_TRANSITION_FRAMES_MAX);
  if (!unit(s.sceneThreshold)) { s.sceneThreshold = d.sceneThreshold; note(FIELD_RESET); }
  return s;
}

/**
 * Bins: drop junk entries, re-root bins whose parent is unknown, themselves, or part of a cycle (so every
 * bin is reachable from the root), and clear media/sequence binIds that point at unknown bins.
 */
function repairBins(p: Project): void {
  const src: unknown = p.bins;
  const bins: Record<ID, Bin> = {};
  if (isObj(src)) {
    for (const [id, b] of Object.entries(src)) {
      if (id !== '__proto__' && isObj(b)) bins[id] = b as unknown as Bin;
      else note('bin entry that is not an object removed');
    }
  } else {
    note(FIELD_RESET);
    for (const b of DEFAULT_BINS) bins[b.id] = { id: b.id, name: b.name, parentId: null, kind: 'bin' };
  }
  p.bins = bins;
  for (const id of Object.keys(bins)) {
    const b = bins[id];
    keyedId(b as unknown as Obj, id);
    b.name = str(b.name, '');
    optional(b as unknown as Obj, 'kind', (v) => isStr(v) && Object.hasOwn(BIN_KINDS, v));
    optional(b as unknown as Obj, 'color', isStr);
    if (!isStr(b.parentId) || b.parentId === id || !Object.hasOwn(bins, b.parentId)) {
      if (b.parentId != null) note('bin parent that does not exist cleared');
      b.parentId = null;
    }
  }
  // Break cycles in one pass (linear): walk each bin's ancestor chain until a root or a bin already known to
  // reach one; a parent edge leading back into the current chain closes a cycle and is cut (the same edge the
  // per-bin walk cut before).
  const ON_CHAIN = 1, DONE = 2;
  const state = new Map<ID, number>();
  for (const id of Object.keys(bins)) {
    if (state.has(id)) continue;
    const chain: ID[] = [];
    let cur: ID | null = id;
    while (cur !== null && !state.has(cur)) {
      state.set(cur, ON_CHAIN);
      chain.push(cur);
      const parent: ID | null = bins[cur].parentId;
      if (parent !== null && state.get(parent) === ON_CHAIN) { bins[cur].parentId = null; note('bin cycle broken'); break; }
      cur = parent;
    }
    for (const x of chain) state.set(x, DONE);
  }
  for (const m of Object.values(p.media)) {
    if (m.binId == null || !Object.hasOwn(bins, m.binId)) { if (m.binId != null) note('reference to a missing bin cleared'); m.binId = null; }
  }
  for (const s of Object.values(p.sequences)) {
    if (s.binId == null || !Object.hasOwn(bins, s.binId)) { if (s.binId != null) note('reference to a missing bin cleared'); s.binId = null; }
  }
}

/**
 * Project file text for manual saves: the structure indented, one record (clip, marker, cue, ...) per line; see
 * shared/projectJson.ts. Parses to the same value as JSON.stringify(p); any JSON layout reads back.
 */
export function serializeProject(p: Project): string {
  return formatProjectJson(p);
}
