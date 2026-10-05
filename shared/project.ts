import { PROJECT_FORMAT_VERSION, MEDIA_CATEGORIES } from './model';
import type {
  Project, Sequence, Rational, MediaItem, ProjectSettings, Bin, ID, TagVocabulary, SequenceView, Track, Clip, Transition,
  TransitionType, MediaKind, ProxyStatus, MarkerKind, Marker, StoryBlock, SequenceSubtitleTrack, SequenceSubtitleCue,
  SequenceSnapshot, SceneRecord, SubtitleTrack, ClipTransform, ClipAudio, ProxyInfo, MediaProbe, VideoStreamInfo, SourceIdentity,
  DetectedScene,
} from './model';
import { uid } from './ids';
import { makeTrack, defaultTransform, defaultAudio, reconcileTransitions } from './timeline';
import { isValidFps, parseFps } from './time';

/** Frame rate of a new sequence, and of a loaded sequence whose stored rate is unusable. */
export const DEFAULT_SEQUENCE_FPS: Readonly<Rational> = Object.freeze({ num: 24000, den: 1001 });

/**
 * The project cannot be opened by this build: it was saved by a newer ReCut, or it has no formatVersion
 * (not a ReCut project). This is a refusal, not damage: the loader reports it and never substitutes a backup.
 * Every other error out of normalizeProject means the content is damaged.
 */
export class ProjectIncompatibleError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectIncompatibleError'; }
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

export function createMediaItem(path: string, name: string): MediaItem {
  return {
    id: uid('med'), name, path, kind: 'unknown', category: 'Other', identity: {}, binId: null,
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
    notes: '', tags: [], addedAt: Date.now(),
  };
}

/**
 * Validate + migrate a parsed project JSON.
 *
 * - Throws ProjectIncompatibleError for a missing / non-numeric / newer formatVersion.
 * - Throws a plain Error for damage it cannot repair without losing work: a top-level collection holding user
 *   work (media / sequences / scenes / subtitleTracks) that is present but not an object (the loader then
 *   tries the .bak). A missing (or null) collection is just empty.
 * - Otherwise repairs: entries that are not objects (or cannot be placed: a clip / marker / scene without a
 *   finite position) are dropped; wrongly typed fields of a kept entry are reset to their defaults; frame rates
 *   are checked with isValidFps. Valid data is left as it is, and normalizing twice changes nothing more.
 */
export function normalizeProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Project file is not a JSON object');
  const p = raw as Obj;
  if (!isFiniteNum(p.formatVersion)) throw new ProjectIncompatibleError('Missing formatVersion; not a ReCut project');
  if (p.formatVersion > PROJECT_FORMAT_VERSION) throw new ProjectIncompatibleError(`Project was saved by a newer ReCut (format ${p.formatVersion}); this build reads ${PROJECT_FORMAT_VERSION}`);
  const base = createProject(str(p.name, 'Untitled Project'));
  const out = {
    ...base,
    ...p,
    formatVersion: PROJECT_FORMAT_VERSION,
    id: typeof p.id === 'string' && p.id ? p.id : base.id,
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
    activeSequenceId: typeof p.activeSequenceId === 'string' ? p.activeSequenceId : null,
  } as Project;
  out.sequenceOrder = [...new Set(out.sequenceOrder)].filter((id) => Object.hasOwn(out.sequences, id));
  for (const id of Object.keys(out.sequences)) if (!out.sequenceOrder.includes(id)) out.sequenceOrder.push(id);
  if (!out.activeSequenceId || !Object.hasOwn(out.sequences, out.activeSequenceId)) out.activeSequenceId = out.sequenceOrder[0] ?? null;
  if (out.sequenceOrder.length === 0) {
    const seq = createSequence('Sequence 01'); seq.binId = 'bin-sequences';
    out.sequences[seq.id] = seq; out.sequenceOrder.push(seq.id); out.activeSequenceId = seq.id;
  }
  repairBins(out);
  return out;
}

// ------------------------------------------------------------------
// Normalization helpers. They repair parsed JSON in place (it is a fresh copy) and return it typed.
// ------------------------------------------------------------------

type Obj = Record<string, unknown>;

function describeFps(fps: unknown): string {
  if (!fps || typeof fps !== 'object') return String(fps);
  const r = fps as { num?: unknown; den?: unknown };
  return `${String(r.num)}/${String(r.den)}`;
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

function str(v: unknown, d: string): string { return typeof v === 'string' ? v : d; }
function bool(v: unknown, d: boolean): boolean { return typeof v === 'boolean' ? v : d; }
/** `v` when it is a finite number accepted by `ok`, else `d`. */
function num(v: unknown, d: number, ok: (n: number) => boolean = () => true): number { return isFiniteNum(v) && ok(v) ? v : d; }
function strList(v: unknown): string[] { return Array.isArray(v) ? v.filter(isStr) : []; }
function objList(v: unknown): Obj[] { return Array.isArray(v) ? v.filter(isObj) : []; }
/** `v` when it is one of the keys of `table` (own keys only: never "toString" & co.), else `d`. */
function oneOf<K extends string>(v: unknown, table: Record<K, true>, d: K): K { return isStr(v) && Object.hasOwn(table, v) ? (v as K) : d; }
/** Remove an optional field that is present with an unusable value. */
function optional(o: Obj, key: string, ok: (v: unknown) => boolean): void { if (key in o && !ok(o[key])) delete o[key]; }
function idOr(v: unknown, make: () => string): string { return typeof v === 'string' && v !== '' ? v : make(); }

// Exhaustive tables: adding a member to one of these unions without updating them fails typecheck.
const TRANSITION_TYPES: Record<TransitionType, true> = { crossDissolve: true, dipToBlack: true, audioCrossfade: true };
const MEDIA_KINDS: Record<MediaKind, true> = { video: true, audio: true, image: true, subtitle: true, unknown: true };
const PROXY_STATUSES: Record<ProxyStatus, true> = { none: true, queued: true, running: true, ready: true, failed: true };
const MARKER_KINDS: Record<MarkerKind, true> = { marker: true, continuity: true, chapter: true };
const JOB_STATES: Record<NonNullable<MediaItem['sceneDetectStatus']>, true> = { none: true, running: true, done: true, failed: true };
const WAVEFORM_STATES: Record<NonNullable<MediaItem['waveformStatus']>, true> = { none: true, running: true, ready: true, failed: true };
const BIN_KINDS: Record<NonNullable<Bin['kind']>, true> = { bin: true, series: true, season: true, collection: true };
const PLAYBACK_RESOLUTIONS: Record<ProjectSettings['playbackResolution'], true> = { full: true, '1/2': true, '1/4': true };

/**
 * A top-level record of entries. Missing / null: empty. Present but not an object: damage (throws). Entries
 * that are not objects, and a "__proto__" key (an own property after JSON.parse), are dropped.
 */
function entries<T>(v: unknown, label: string, repair: (o: Obj, id: ID) => T | null): Record<ID, T> {
  const out: Record<ID, T> = {};
  if (v === undefined || v === null) return out;
  if (!isObj(v)) throw new Error(`Project data is damaged: "${label}" must be an object, found ${Array.isArray(v) ? 'an array' : typeof v}`);
  for (const [id, o] of Object.entries(v)) {
    if (id === '__proto__' || !isObj(o)) continue;
    const r = repair(o, id);
    if (r !== null) out[id] = r;
  }
  return out;
}

/** A stored frame rate: kept when valid, a bare number (hand-edited file) goes through parseFps, else `fallback`. */
function repairFps(v: unknown, fallback: Readonly<Rational>): Rational {
  if (isValidFps(v)) return v;
  const parsed = isFiniteNum(v) ? parseFps(v) : null;
  return parsed ? { ...parsed } : { ...fallback };
}

function repairSequence(s: Obj, id: ID, fallbackFps: Readonly<Rational>): Sequence {
  const template = createSequence(str(s.name, 'Sequence'));
  const fps = repairFps(s.fps, fallbackFps);
  const seq = {
    ...template, ...s, id,
    name: template.name,
    fps,
    width: isPosInt(s.width) ? s.width : template.width,
    height: isPosInt(s.height) ? s.height : template.height,
    sampleRate: isPosInt(s.sampleRate) ? s.sampleRate : template.sampleRate,
    channels: isPosInt(s.channels) ? s.channels : template.channels,
    createdAt: num(s.createdAt, template.createdAt),
    modifiedAt: num(s.modifiedAt, template.modifiedAt),
    binId: isStr(s.binId) ? s.binId : null,
    videoTracks: repairTracks(s.videoTracks, 'video', template.videoTracks),
    audioTracks: repairTracks(s.audioTracks, 'audio', template.audioTracks),
    subtitleTracks: objList(s.subtitleTracks).map(repairSequenceSubtitleTrack),
    markers: objList(s.markers).map(repairMarker).filter((m): m is Marker => m !== null),
    storyBlocks: objList(s.storyBlocks).map(repairStoryBlock).filter((b): b is StoryBlock => b !== null),
    snapshots: objList(s.snapshots).map((x) => repairSnapshot(x, id, fps)).filter((x): x is SequenceSnapshot => x !== null),
    view: new LiveView(repairView({ ...template.view, ...(isObj(s.view) ? s.view : {}) }, template.view)),
  } as Sequence;
  optional(seq as unknown as Obj, 'parentSequenceId', isStr);
  optional(seq as unknown as Obj, 'versionLabel', isStr);
  return seq;
}

/** A snapshot needs its data; the data is a sequence (without snapshots) and is repaired like one. */
function repairSnapshot(sn: Obj, seqId: ID, seqFps: Rational): SequenceSnapshot | null {
  if (!isObj(sn.data)) return null;
  const { snapshots: _nested, ...data } = sn.data;
  const repaired: Partial<Sequence> = repairSequence(data, idOr(data.id, () => seqId), seqFps);
  delete repaired.snapshots;
  return {
    ...sn,
    id: idOr(sn.id, () => uid('snap')),
    name: str(sn.name, ''),
    createdAt: num(sn.createdAt, 0),
    data: repaired as SequenceSnapshot['data'],
  } as SequenceSnapshot;
}

function repairTracks(v: unknown, kind: Track['kind'], template: Track[]): Track[] {
  const list = objList(v);
  return list.length ? list.map((t, i) => repairTrack(t, kind, i + 1)) : template;
}

function repairTrack(t: Obj, kind: Track['kind'], index: number): Track {
  const d = makeTrack(kind, index);
  const track = {
    ...d, ...t,
    id: idOr(t.id, () => d.id),
    name: str(t.name, d.name),
    kind,
    muted: bool(t.muted, d.muted), solo: bool(t.solo, d.solo), locked: bool(t.locked, d.locked), patched: bool(t.patched, d.patched),
    height: num(t.height, d.height, positive),
    volume: num(t.volume, d.volume, nonNeg),
    clips: objList(t.clips).filter(isValidClip).map((c) => repairClip(c, kind)),
    // A transition needs a known type and clip references that are ids or null; reconcileTransitions then drops
    // the ones whose clips are gone / not adjacent and clamps durations.
    transitions: objList(t.transitions).filter((tr) => isStr(tr.type) && Object.hasOwn(TRANSITION_TYPES, tr.type)
      && (tr.outClipId == null || isStr(tr.outClipId)) && (tr.inClipId == null || isStr(tr.inClipId)))
      .map((tr) => ({ ...tr, id: idOr(tr.id, () => uid('tr')), outClipId: tr.outClipId ?? null, inClipId: tr.inClipId ?? null }) as Transition),
  } as Track;
  track.clips.sort((a, b) => a.start - b.start);
  reconcileTransitions(track);
  return track;
}

/** A clip survives load only with a finite, non-negative position/source in and at least one frame. */
function isValidClip(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const x = c as { start?: unknown; duration?: unknown; sourceIn?: unknown };
  if (x.sourceIn === undefined) x.sourceIn = 0; // older files may omit it (null = NaN/Infinity after JSON: dropped)
  return isFiniteNum(x.start) && x.start >= 0
    && isFiniteNum(x.duration) && x.duration >= 1
    && isFiniteNum(x.sourceIn) && x.sourceIn >= 0;
}

function repairClip(c: Obj, trackKind: Track['kind']): Clip {
  c.id = idOr(c.id, () => uid('clip'));
  c.mediaId = str(c.mediaId, '');
  c.name = str(c.name, '');
  c.linkId = isStr(c.linkId) ? c.linkId : null;
  c.transform = repairTransform(c.transform);
  c.audio = repairClipAudio(c.audio);
  c.tags = strList(c.tags); c.characters = strList(c.characters); c.plotlines = strList(c.plotlines); c.locations = strList(c.locations);
  c.notes = str(c.notes, '');
  if (!isFiniteNum(c.speed) || !(c.speed > 0)) c.speed = 1;
  c.enabled = bool(c.enabled, true);
  if (c.kind !== 'video' && c.kind !== 'audio') c.kind = trackKind;
  optional(c, 'audioStream', isNonNegInt);
  optional(c, 'color', isStr); optional(c, 'sceneRecordId', isStr); optional(c, 'originLabel', isStr);
  return c as unknown as Clip;
}

function repairTransform(v: unknown): ClipTransform {
  const d = defaultTransform();
  const t = isObj(v) ? v : {};
  const crop = isObj(t.crop) ? t.crop : {};
  return {
    ...t,
    x: num(t.x, d.x), y: num(t.y, d.y), scale: num(t.scale, d.scale, positive), rotation: num(t.rotation, d.rotation),
    opacity: num(t.opacity, d.opacity, unit),
    crop: { ...crop, left: num(crop.left, 0, unit), top: num(crop.top, 0, unit), right: num(crop.right, 0, unit), bottom: num(crop.bottom, 0, unit) },
  } as ClipTransform;
}

function repairClipAudio(v: unknown): ClipAudio {
  const d = defaultAudio();
  const a = isObj(v) ? v : {};
  return {
    ...a,
    gain: num(a.gain, d.gain), volume: num(a.volume, d.volume, nonNeg),
    fadeIn: num(a.fadeIn, d.fadeIn, nonNeg), fadeOut: num(a.fadeOut, d.fadeOut, nonNeg), muted: bool(a.muted, d.muted),
  } as ClipAudio;
}

function repairSequenceSubtitleTrack(t: Obj): SequenceSubtitleTrack {
  return {
    ...t,
    id: idOr(t.id, () => uid('sst')),
    name: str(t.name, ''),
    language: str(t.language, 'und'),
    enabled: bool(t.enabled, true),
    cues: objList(t.cues).map(repairSequenceCue).filter((c): c is SequenceSubtitleCue => c !== null),
  } as SequenceSubtitleTrack;
}

/** A cue attached to a clip is placed from the clip; a free cue needs a finite start and duration. */
function repairSequenceCue(c: Obj): SequenceSubtitleCue | null {
  optional(c, 'clipId', (v) => isStr(v) && v !== '');
  optional(c, 'srcStart', isFiniteNum);
  optional(c, 'srcEnd', isFiniteNum);
  if (!('clipId' in c) && (!isFiniteNum(c.start) || !isFiniteNum(c.duration))) return null;
  c.id = idOr(c.id, () => uid('cue'));
  c.start = num(c.start, 0); c.duration = num(c.duration, 0); c.offset = num(c.offset, 0);
  c.text = str(c.text, '');
  return c as unknown as SequenceSubtitleCue;
}

function repairMarker(m: Obj): Marker | null {
  if (!isFiniteNum(m.time) || m.time < 0) return null;
  m.id = idOr(m.id, () => uid('mk'));
  m.duration = num(m.duration, 0, nonNeg);
  m.name = str(m.name, ''); m.note = str(m.note, ''); m.color = str(m.color, '#4d7cfe');
  m.kind = oneOf(m.kind, MARKER_KINDS, 'marker');
  optional(m, 'category', isStr); optional(m, 'resolved', isBool); optional(m, 'clipId', isStr);
  return m as unknown as Marker;
}

function repairStoryBlock(b: Obj): StoryBlock | null {
  if (!isFiniteNum(b.start) || !isFiniteNum(b.end)) return null;
  b.id = idOr(b.id, () => uid('sb'));
  b.name = str(b.name, ''); b.color = str(b.color, '#7c5cff'); b.notes = str(b.notes, '');
  return b as unknown as StoryBlock;
}

function repairMedia(m: Obj, id: ID): MediaItem {
  m.id = id;
  const hasPath = isStr(m.path);
  if (!hasPath) m.path = '';
  m.name = str(m.name, '');
  m.kind = oneOf(m.kind, MEDIA_KINDS, 'unknown');
  m.category = isStr(m.category) && (MEDIA_CATEGORIES as string[]).includes(m.category) ? m.category : 'Other';
  m.identity = repairIdentity(m.identity);
  m.binId = isStr(m.binId) ? m.binId : null; // existence is checked by repairBins
  m.offline = hasPath ? bool(m.offline, false) : true;
  m.proxy = repairProxy(m.proxy);
  m.detectedScenes = objList(m.detectedScenes).map(repairDetectedScene).filter((d): d is DetectedScene => d !== null);
  m.subtitleTrackIds = strList(m.subtitleTrackIds);
  m.tags = strList(m.tags);
  m.notes = str(m.notes, '');
  m.addedAt = num(m.addedAt, 0);
  optional(m, 'sceneDetectStatus', (v) => isStr(v) && Object.hasOwn(JOB_STATES, v));
  optional(m, 'waveformStatus', (v) => isStr(v) && Object.hasOwn(WAVEFORM_STATES, v));
  if (m.sceneDetectStatus === 'running') m.sceneDetectStatus = 'none';
  if (m.waveformStatus === 'running') m.waveformStatus = 'none';
  optional(m, 'color', isStr); optional(m, 'probeError', isStr);
  optional(m, 'thumbnailTime', (v) => isFiniteNum(v) && v >= 0);
  optional(m, 'preferredAudioStream', isNonNegInt);
  optional(m, 'fileSize', (v) => isFiniteNum(v) && v >= 0);
  optional(m, 'fileMtime', isFiniteNum);
  if ('probe' in m) { if (isObj(m.probe)) m.probe = repairProbe(m.probe); else delete m.probe; }
  return m as unknown as MediaItem;
}

function repairIdentity(v: unknown): SourceIdentity {
  const id: Obj = isObj(v) ? v : {};
  for (const k of ['series', 'collection', 'franchise', 'title']) optional(id, k, isStr);
  for (const k of ['season', 'episode', 'year']) optional(id, k, isFiniteNum);
  return id as SourceIdentity;
}

/** Jobs do not survive a restart: queued / running proxies (and unknown states) become 'none'. */
function repairProxy(v: unknown): ProxyInfo {
  if (!isObj(v) || !isStr(v.status) || !Object.hasOwn(PROXY_STATUSES, v.status) || v.status === 'running' || v.status === 'queued') return { status: 'none' };
  optional(v, 'path', isStr); optional(v, 'error', isStr);
  for (const k of ['progress', 'width', 'height', 'audioStream']) optional(v, k, isFiniteNum);
  return v as unknown as ProxyInfo;
}

function repairDetectedScene(d: Obj): DetectedScene | null {
  if (!isFiniteNum(d.start) || !isFiniteNum(d.end) || d.start < 0 || d.end < 0) return null;
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
  pr.audio = objList(pr.audio);
  pr.subtitles = objList(pr.subtitles);
  optional(pr, 'bitrate', isFiniteNum); optional(pr, 'playabilityReason', isStr);
  if ('video' in pr) { if (isObj(pr.video)) pr.video = repairVideoStream(pr.video); else delete pr.video; }
  return pr as unknown as MediaProbe;
}

/**
 * Probed frame rates: the prober stores {0,1} for "no usable rate" and readers check `fps.num > 0`, so a
 * stored rate that fails isValidFps becomes that same "unknown" value rather than an invented rate.
 */
function repairProbeFps(v: unknown): Rational { return isValidFps(v) ? v : { num: 0, den: 1 }; }

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
  return v as unknown as VideoStreamInfo;
}

/** Library scenes need a finite, non-negative in / out; other fields are reset when wrongly typed. */
function repairScene(s: Obj, id: ID): SceneRecord | null {
  if (!isFiniteNum(s.in) || !isFiniteNum(s.out) || s.in < 0 || s.out < 0) return null;
  s.id = id;
  s.name = str(s.name, ''); s.mediaId = str(s.mediaId, '');
  s.characters = strList(s.characters); s.tags = strList(s.tags);
  s.notes = str(s.notes, ''); s.location = str(s.location, ''); s.arc = str(s.arc, '');
  s.rating = num(s.rating, 0); s.color = str(s.color, '#4d7cfe'); s.createdAt = num(s.createdAt, 0);
  return s as unknown as SceneRecord;
}

function repairSubtitleTrack(t: Obj, id: ID): SubtitleTrack {
  t.id = id;
  t.name = str(t.name, ''); t.language = str(t.language, 'und'); t.origin = str(t.origin, 'srt');
  t.mediaId = isStr(t.mediaId) ? t.mediaId : null;
  optional(t, 'path', isStr);
  t.cues = objList(t.cues).filter((c) => isFiniteNum(c.start) && isFiniteNum(c.end)).map((c) => {
    c.id = idOr(c.id, () => uid('cue')); c.text = str(c.text, '');
    return c;
  });
  return t as unknown as SubtitleTrack;
}

function repairTags(v: unknown): TagVocabulary {
  const t = isObj(v) ? v : {};
  return {
    ...t,
    characters: strList(t.characters), plotlines: strList(t.plotlines), locations: strList(t.locations),
    themes: strList(t.themes), custom: strList(t.custom),
  } as TagVocabulary;
}

/** Each known setting must have its default's type (finite for numbers) and a sensible value. */
function repairSettings(v: unknown): ProjectSettings {
  const d = defaultSettings();
  const out: Obj = { ...(isObj(v) ? v : {}) };
  for (const [k, dv] of Object.entries(d)) {
    const cur = out[k];
    if (typeof cur !== typeof dv || (typeof dv === 'number' && !isFiniteNum(cur))) out[k] = dv;
  }
  const s = out as unknown as ProjectSettings;
  s.playbackResolution = oneOf(s.playbackResolution, PLAYBACK_RESOLUTIONS, d.playbackResolution);
  if (!(s.proxyHeight > 0)) s.proxyHeight = d.proxyHeight;
  if (!(s.autosaveIntervalSec > 0)) s.autosaveIntervalSec = d.autosaveIntervalSec;
  if (!(s.defaultTransitionFrames >= 1)) s.defaultTransitionFrames = d.defaultTransitionFrames;
  if (!unit(s.sceneThreshold)) s.sceneThreshold = d.sceneThreshold;
  return s;
}

function repairView(v: Sequence['view'], defaults: Sequence['view']): Sequence['view'] {
  const inOut = (x: unknown) => (isFiniteNum(x) && x >= 0 ? x : null);
  return {
    ...v,
    zoom: isFiniteNum(v.zoom) && v.zoom > 0 ? v.zoom : defaults.zoom,
    scroll: isFiniteNum(v.scroll) && v.scroll >= 0 ? v.scroll : 0,
    playhead: isFiniteNum(v.playhead) && v.playhead >= 0 ? v.playhead : 0,
    inPoint: inOut(v.inPoint),
    outPoint: inOut(v.outPoint),
  };
}

/**
 * Bins: drop junk entries, re-root bins whose parent is unknown, themselves, or part of a cycle (so every
 * bin is reachable from the root), and clear media/sequence binIds that point at unknown bins.
 */
function repairBins(p: Project): void {
  const src: unknown = p.bins;
  const bins: Record<ID, Bin> = {};
  if (isObj(src)) {
    for (const [id, b] of Object.entries(src)) if (id !== '__proto__' && isObj(b)) bins[id] = b as unknown as Bin;
  } else {
    for (const b of DEFAULT_BINS) bins[b.id] = { id: b.id, name: b.name, parentId: null, kind: 'bin' };
  }
  p.bins = bins;
  for (const id of Object.keys(bins)) {
    const b = bins[id];
    b.id = id;
    b.name = str(b.name, '');
    optional(b as unknown as Obj, 'kind', (v) => isStr(v) && Object.hasOwn(BIN_KINDS, v));
    optional(b as unknown as Obj, 'color', isStr);
    if (!isStr(b.parentId) || b.parentId === id || !Object.hasOwn(bins, b.parentId)) b.parentId = null;
  }
  // Break cycles: walk each bin's ancestor chain; the edge that leads back into the chain is cut.
  for (const id of Object.keys(bins)) {
    const seen = new Set<ID>([id]);
    let node = bins[id];
    while (node.parentId) {
      if (seen.has(node.parentId)) { node.parentId = null; break; } // cut the edge that closes the cycle
      seen.add(node.parentId);
      node = bins[node.parentId];
    }
  }
  for (const m of Object.values(p.media)) if (m.binId == null || !Object.hasOwn(bins, m.binId)) m.binId = null;
  for (const s of Object.values(p.sequences)) if (s.binId == null || !Object.hasOwn(bins, s.binId)) s.binId = null;
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}
