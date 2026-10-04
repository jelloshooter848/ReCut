import { PROJECT_FORMAT_VERSION } from './model';
import type { Project, Sequence, Rational, MediaItem, ProjectSettings, Bin, ID, TagVocabulary, SequenceView } from './model';
import { uid } from './ids';
import { makeTrack, defaultTransform, defaultAudio, reconcileTransitions } from './timeline';

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

export function createSequence(name: string, fps: Rational = { num: 24000, den: 1001 }, width = 1920, height = 1080): Sequence {
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

/** Validate + migrate a parsed project JSON. Throws on hopeless input; repairs minor issues. */
export function normalizeProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new Error('Project file is not a JSON object');
  const p = raw as Partial<Project> & Record<string, unknown>;
  if (typeof p.formatVersion !== 'number') throw new Error('Missing formatVersion; not a ReCut project');
  if (p.formatVersion > PROJECT_FORMAT_VERSION) throw new Error(`Project was saved by a newer ReCut (format ${p.formatVersion}); this build reads ${PROJECT_FORMAT_VERSION}`);
  const base = createProject(typeof p.name === 'string' ? p.name : 'Untitled Project');
  const out: Project = {
    ...base,
    ...p,
    formatVersion: PROJECT_FORMAT_VERSION,
    media: (p.media as Project['media']) ?? {},
    bins: (p.bins as Project['bins']) ?? base.bins,
    sequences: (p.sequences as Project['sequences']) ?? {},
    scenes: (p.scenes as Project['scenes']) ?? {},
    subtitleTracks: (p.subtitleTracks as Project['subtitleTracks']) ?? {},
    tags: { ...emptyTags(), ...((p.tags as TagVocabulary) ?? {}) },
    settings: { ...defaultSettings(), ...((p.settings as ProjectSettings) ?? {}) },
    sequenceOrder: Array.isArray(p.sequenceOrder) ? (p.sequenceOrder as ID[]) : [],
    activeSequenceId: (p.activeSequenceId as ID | null) ?? null,
  } as Project;
  // Repair sequences
  for (const id of Object.keys(out.sequences)) {
    const s = out.sequences[id];
    if (!s || typeof s !== 'object') { delete out.sequences[id]; continue; }
    const template = createSequence(s.name ?? 'Sequence');
    out.sequences[id] = {
      ...template, ...s, id,
      videoTracks: Array.isArray(s.videoTracks) && s.videoTracks.length ? s.videoTracks : template.videoTracks,
      audioTracks: Array.isArray(s.audioTracks) && s.audioTracks.length ? s.audioTracks : template.audioTracks,
      subtitleTracks: Array.isArray(s.subtitleTracks) ? s.subtitleTracks : [],
      markers: Array.isArray(s.markers) ? s.markers : [],
      storyBlocks: Array.isArray(s.storyBlocks) ? s.storyBlocks : [],
      snapshots: Array.isArray(s.snapshots) ? s.snapshots : [],
      view: new LiveView(repairView({ ...template.view, ...(s.view ?? {}) }, template.view)),
    };
    for (const t of [...out.sequences[id].videoTracks, ...out.sequences[id].audioTracks]) {
      t.clips = Array.isArray(t.clips) ? t.clips.filter(isValidClip) : [];
      t.transitions = Array.isArray(t.transitions) ? t.transitions : [];
      for (const c of t.clips) {
        c.transform = { ...defaultTransform(), ...(c.transform ?? {}) };
        c.transform.crop = { ...defaultTransform().crop, ...(c.transform.crop ?? {}) };
        c.audio = { ...defaultAudio(), ...(c.audio ?? {}) };
        c.tags ??= []; c.characters ??= []; c.plotlines ??= []; c.locations ??= []; c.notes ??= '';
        if (!Number.isFinite(c.speed) || !(c.speed > 0)) c.speed = 1;
        c.enabled ??= true; c.kind ??= t.kind;
      }
      t.clips.sort((a, b) => a.start - b.start);
      // Drop transitions whose clips are gone / no longer adjacent; clamp durations so none overlap.
      t.transitions = t.transitions.filter((tr) => tr && typeof tr === 'object');
      reconcileTransitions(t);
    }
  }
  out.sequenceOrder = [...new Set(out.sequenceOrder)].filter((id) => out.sequences[id]);
  for (const id of Object.keys(out.sequences)) if (!out.sequenceOrder.includes(id)) out.sequenceOrder.push(id);
  if (!out.activeSequenceId || !out.sequences[out.activeSequenceId]) out.activeSequenceId = out.sequenceOrder[0] ?? null;
  if (out.sequenceOrder.length === 0) {
    const seq = createSequence('Sequence 01'); seq.binId = 'bin-sequences';
    out.sequences[seq.id] = seq; out.sequenceOrder.push(seq.id); out.activeSequenceId = seq.id;
  }
  for (const id of Object.keys(out.media)) { if (!out.media[id] || typeof out.media[id] !== "object") { delete out.media[id]; } }
  for (const m of Object.values(out.media)) {
    m.proxy ??= { status: 'none' };
    if (m.proxy.status === 'running' || m.proxy.status === 'queued') m.proxy = { status: 'none' };
    m.detectedScenes ??= []; m.subtitleTrackIds ??= []; m.tags ??= []; m.notes ??= ''; m.identity ??= {};
    m.category ??= 'Other'; m.offline ??= false;
    if (m.sceneDetectStatus === 'running') m.sceneDetectStatus = 'none';
    if (m.waveformStatus === 'running') m.waveformStatus = 'none';
  }
  repairBins(out);
  for (const s of Object.values(out.scenes)) { s.characters ??= []; s.tags ??= []; s.notes ??= ''; s.rating ??= 0; s.color ??= '#4d7cfe'; s.location ??= ''; s.arc ??= ''; }
  for (const st of Object.values(out.subtitleTracks)) { st.cues ??= []; st.origin ??= 'srt'; st.language ??= 'und'; }
  return out;
}

function isFiniteNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

/** A clip survives load only with a finite, non-negative position/source in and at least one frame. */
function isValidClip(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const x = c as { start?: unknown; duration?: unknown; sourceIn?: unknown };
  if (x.sourceIn === undefined) x.sourceIn = 0; // older files may omit it (null = NaN/Infinity after JSON: dropped)
  return isFiniteNum(x.start) && x.start >= 0
    && isFiniteNum(x.duration) && x.duration >= 1
    && isFiniteNum(x.sourceIn) && x.sourceIn >= 0;
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
  if (!p.bins || typeof p.bins !== 'object' || Array.isArray(p.bins)) {
    p.bins = {};
    for (const b of DEFAULT_BINS) p.bins[b.id] = { id: b.id, name: b.name, parentId: null, kind: 'bin' };
  }
  for (const id of Object.keys(p.bins)) {
    const b = p.bins[id];
    if (!b || typeof b !== 'object') { delete p.bins[id]; continue; }
    b.id = id;
    if (b.parentId === undefined || (b.parentId !== null && (b.parentId === id || !p.bins[b.parentId]))) b.parentId = null;
  }
  // Break cycles: walk each bin's ancestor chain; the edge that leads back into the chain is cut.
  for (const id of Object.keys(p.bins)) {
    const seen = new Set<ID>([id]);
    let node = p.bins[id];
    while (node.parentId) {
      if (seen.has(node.parentId)) { node.parentId = null; break; } // cut the edge that closes the cycle
      seen.add(node.parentId);
      node = p.bins[node.parentId];
    }
  }
  for (const m of Object.values(p.media)) if (m.binId == null || !p.bins[m.binId]) m.binId = null;
  for (const s of Object.values(p.sequences)) if (s.binId == null || !p.bins[s.binId]) s.binId = null;
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}
