import { PROJECT_FORMAT_VERSION } from './model';
import type { Project, Sequence, Rational, MediaItem, ProjectSettings, Bin, ID, TagVocabulary } from './model';
import { uid } from './ids';
import { makeTrack, defaultTransform, defaultAudio } from './timeline';

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

export function createSequence(name: string, fps: Rational = { num: 24000, den: 1001 }, width = 1920, height = 1080): Sequence {
  const now = Date.now();
  return {
    id: uid('seq'), name, fps, width, height, sampleRate: 48000, channels: 2,
    videoTracks: [makeTrack('video', 1), makeTrack('video', 2), makeTrack('video', 3)],
    audioTracks: [makeTrack('audio', 1), makeTrack('audio', 2), makeTrack('audio', 3)],
    subtitleTracks: [],
    markers: [], storyBlocks: [], snapshots: [],
    createdAt: now, modifiedAt: now, binId: null,
    view: { playhead: 0, zoom: 4, scroll: 0, inPoint: null, outPoint: null },
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
      view: { ...template.view, ...(s.view ?? {}) },
    };
    for (const t of [...out.sequences[id].videoTracks, ...out.sequences[id].audioTracks]) {
      t.clips = Array.isArray(t.clips) ? t.clips.filter((c) => c && typeof c.start === 'number' && typeof c.duration === 'number' && c.duration > 0) : [];
      t.transitions = Array.isArray(t.transitions) ? t.transitions : [];
      for (const c of t.clips) {
        c.transform = { ...defaultTransform(), ...(c.transform ?? {}) };
        c.transform.crop = { ...defaultTransform().crop, ...(c.transform.crop ?? {}) };
        c.audio = { ...defaultAudio(), ...(c.audio ?? {}) };
        c.tags ??= []; c.characters ??= []; c.plotlines ??= []; c.locations ??= []; c.notes ??= '';
        c.speed ||= 1; c.enabled ??= true; c.kind ??= t.kind;
      }
      t.clips.sort((a, b) => a.start - b.start);
    }
  }
  out.sequenceOrder = out.sequenceOrder.filter((id) => out.sequences[id]);
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
  for (const s of Object.values(out.scenes)) { s.characters ??= []; s.tags ??= []; s.notes ??= ''; s.rating ??= 0; s.color ??= '#4d7cfe'; s.location ??= ''; s.arc ??= ''; }
  for (const st of Object.values(out.subtitleTracks)) { st.cues ??= []; st.origin ??= 'srt'; st.language ??= 'und'; }
  return out;
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}
