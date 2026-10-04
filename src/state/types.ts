/**
 * Renderer store types. The store itself lives in ./store.ts; this file only declares shapes so UI code
 * can import types without pulling in zustand.
 */
import type {
  Bin, Clip, ClipAudio, ClipTransform, DetectedScene, ID, JobInfo, Marker, MediaItem, MediaProbe, Project,
  ProjectSettings, ProxyInfo, SceneRecord, Sequence, SequenceSubtitleCue, SequenceSubtitleTrack, StoryBlock,
  SubtitleTrack, TagVocabulary, Track, Transition, TransitionType,
} from '../../shared/model';
import type { MoveSpec, NewClipSpec } from '../../shared/timeline';

export type Tool = 'select' | 'razor' | 'ripple' | 'rolling' | 'slip' | 'slide' | 'track' | 'hand';
export type SelectMode = 'set' | 'add' | 'toggle' | 'clear';
export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export type DialogName = 'export' | 'relink' | 'shortcuts' | 'newSequence' | 'preferences';
export type FilterMode = 'highlight' | 'solo';

export interface SourceClipState {
  mediaId: ID;
  inPoint: number | null;   // seconds
  outPoint: number | null;  // seconds
  time: number;             // seconds
}

export interface FilterState {
  characters: string[];
  plotlines: string[];
  locations: string[];
  tags: string[];
  mode: FilterMode;
}

export interface CompareState { sequenceA: ID | null; sequenceB: ID | null; open: boolean }

export interface Toast { id: ID; kind: ToastKind; text: string }

export interface UIState {
  tool: Tool;
  selectedClipIds: ID[];
  selectedTransitionId: ID | null;
  selectedMediaIds: ID[];
  selectedSceneIds: ID[];
  selectedBinId: ID | null;
  selectedMarkerId: ID | null;
  sourceClip: SourceClipState | null;
  activePanel: string;
  timelineFocus: boolean;
  filters: FilterState;
  compare: CompareState;
  dialogs: Record<DialogName, boolean>;
  toasts: Toast[];
}

export interface HistoryState {
  past: Project[];
  future: Project[];
  /** Labels parallel to `past` / `future` (same index). */
  pastLabels: string[];
  futureLabels: string[];
  limit: number;
}

export interface PlaybackState { playing: boolean; rate: number }

export interface StoreState {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  history: HistoryState;
  /** Snapshot of `project` taken by beginTransaction(); null when no transaction is open. */
  transaction: Project | null;
  ui: UIState;
  jobs: JobInfo[];
  playback: PlaybackState;
}

export type Recipe = (draft: Project) => void;

export interface ViewPatch { playhead?: number; zoom?: number; scroll?: number; inPoint?: number | null; outPoint?: number | null }

export interface InsertFromSourceOptions {
  mediaId: ID;
  in: number;                 // seconds
  out: number;                // seconds
  atFrame: number;
  videoTrackId?: ID;
  audioTrackId?: ID;
  mode: 'insert' | 'overwrite';
  includeVideo?: boolean;
  includeAudio?: boolean;
  extra?: Partial<NewClipSpec>;
}

export interface ClipTagsPatch {
  characters?: string[];
  plotlines?: string[];
  locations?: string[];
  tags?: string[];
  notes?: string;
  color?: string | undefined;
  name?: string;
}

export interface TrackFlagsPatch {
  muted?: boolean; solo?: boolean; locked?: boolean; patched?: boolean; height?: number; volume?: number; name?: string;
}

export interface ContinuityNoteInput { time: number; name: string; note: string; category?: string; clipId?: ID; duration?: number }

export type SequenceSettingsPatch = Partial<Pick<Sequence, 'name' | 'fps' | 'width' | 'height' | 'sampleRate' | 'channels' | 'binId' | 'versionLabel'>>;

export interface MediaRelinkStat { size?: number; mtimeMs?: number }

export interface StoreActions {
  // ---- undo model ----
  commit(label: string, recipe: Recipe): boolean;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  clearHistory(): void;
  setView(seqId: ID, patch: ViewPatch): void;
  beginTransaction(): void;
  updateTransient(recipe: Recipe): void;
  endTransaction(label: string): boolean;
  cancelTransaction(): void;

  // ---- project ----
  newProject(name?: string): void;
  loadProjectData(project: Project, path: string | null): void;
  markSaved(path: string): void;
  setSettings(patch: Partial<ProjectSettings>): void;
  renameProject(name: string): void;

  // ---- bins ----
  addBin(name: string, parentId?: ID | null, kind?: Bin['kind']): ID;
  renameBin(id: ID, name: string): void;
  deleteBin(id: ID): void;
  moveToBin(ids: ID[], binId: ID | null): void;
  organizeAsSeries(mediaIds: ID[], series: string, season: number): { seriesBinId: ID; seasonBinId: ID };

  // ---- media ----
  addMedia(items: MediaItem[]): void;
  updateMedia(id: ID, patch: Partial<MediaItem>): void;
  removeMedia(ids: ID[]): void;
  setMediaProbe(id: ID, result: MediaProbe | { error: string }): void;
  setProxy(id: ID, proxy: ProxyInfo): void;
  setSceneDetectStatus(id: ID, status: NonNullable<MediaItem['sceneDetectStatus']>): void;
  setDetectedScenes(id: ID, boundaries: number[], duration: number): void;
  renameDetectedScene(mediaId: ID, sceneId: ID, name: string): void;
  mergeDetectedScenes(mediaId: ID, sceneIds: ID[]): void;
  splitDetectedScene(mediaId: ID, sceneId: ID, atSeconds: number): void;
  tagDetectedScene(mediaId: ID, sceneId: ID, patch: { tags?: string[]; characters?: string[] }): void;
  deleteDetectedScene(mediaId: ID, sceneId: ID): void;
  relinkMedia(id: ID, newPath: string, stat?: MediaRelinkStat): void;
  setOffline(id: ID, offline: boolean): void;
  addMediaSubtitleTrack(track: SubtitleTrack): void;
  removeMediaSubtitleTrack(trackId: ID): void;

  // ---- sequences ----
  addSequence(seq: Sequence, opts?: { activate?: boolean }): void;
  duplicateSequence(id: ID, newName: string): ID | null;
  deleteSequence(id: ID): void;
  renameSequence(id: ID, name: string): void;
  setActiveSequence(id: ID | null): void;
  takeSnapshot(seqId: ID, name: string): ID | null;
  restoreSnapshot(seqId: ID, snapshotId: ID): void;
  deleteSnapshot(seqId: ID, snapshotId: ID): void;
  updateSequenceSettings(seqId: ID, patch: SequenceSettingsPatch): void;

  // ---- timeline ----
  insertFromSource(seqId: ID, opts: InsertFromSourceOptions): ID[];
  placeClipsAction(seqId: ID, placements: { trackId: ID; clip: Clip }[], mode: 'insert' | 'overwrite'): boolean;
  razor(seqId: ID, frame: number, trackIds?: ID[]): ID[];
  razorAtPlayhead(seqId?: ID): ID[];
  deleteSelected(seqId?: ID): void;
  rippleDeleteSelected(seqId?: ID): void;
  liftInOut(seqId?: ID, trackIds?: ID[]): void;
  extractInOut(seqId?: ID, trackIds?: ID[]): void;
  trimClipEdge(seqId: ID, clipId: ID, edge: 'start' | 'end', frame: number, ripple: boolean): void;
  rollEdit(seqId: ID, outClipId: ID, inClipId: ID, frame: number): void;
  slip(seqId: ID, clipId: ID, deltaFrames: number): void;
  slide(seqId: ID, clipId: ID, deltaFrames: number): void;
  moveClips(seqId: ID, moves: MoveSpec[], mode: 'insert' | 'overwrite'): boolean;
  nudgeSelected(deltaFrames: number, seqId?: ID): void;
  setClipEnabled(seqId: ID, clipId: ID, enabled: boolean): void;
  toggleClipEnabledSelected(seqId?: ID): void;
  linkSelected(seqId?: ID): void;
  unlinkSelected(seqId?: ID): void;
  setClipTransform(seqId: ID, clipId: ID, patch: Partial<ClipTransform>): void;
  setClipAudio(seqId: ID, clipId: ID, patch: Partial<ClipAudio>): void;
  setClipSpeed(seqId: ID, clipId: ID, speed: number, opts?: { ripple?: boolean }): void;
  setClipTags(seqId: ID, clipId: ID, patch: ClipTagsPatch): void;
  addTransitionAtCut(seqId: ID, trackId: ID, frame: number, type: TransitionType, frames?: number): Transition | null;
  addDefaultTransitionAtSelection(seqId?: ID): void;
  removeTransition(seqId: ID, transitionId: ID): void;
  setTransitionDuration(seqId: ID, transitionId: ID, frames: number): void;
  addTrack(seqId: ID, kind: 'video' | 'audio'): ID | null;
  removeTrack(seqId: ID, trackId: ID): void;
  setTrackFlags(seqId: ID, trackId: ID, patch: TrackFlagsPatch): void;

  // ---- markers ----
  addMarker(seqId: ID, marker: Partial<Omit<Marker, 'id'>> & { time: number }): ID | null;
  updateMarker(seqId: ID, markerId: ID, patch: Partial<Omit<Marker, 'id'>>): void;
  removeMarker(seqId: ID, markerId: ID): void;
  addContinuityNote(seqId: ID, note: ContinuityNoteInput): ID | null;
  resolveContinuity(seqId: ID, markerId: ID, resolved?: boolean): void;

  // ---- story blocks ----
  addStoryBlock(seqId: ID, block: Partial<Omit<StoryBlock, 'id'>> & { start: number; end: number }): ID | null;
  updateStoryBlock(seqId: ID, blockId: ID, patch: Partial<Omit<StoryBlock, 'id'>>): void;
  removeStoryBlock(seqId: ID, blockId: ID): void;

  // ---- sequence subtitles ----
  addSequenceSubtitleTrack(seqId: ID, init?: { name?: string; language?: string }): ID | null;
  removeSequenceSubtitleTrack(seqId: ID, trackId: ID): void;
  toggleSubtitleTrack(seqId: ID, trackId: ID, enabled?: boolean): void;
  updateCue(seqId: ID, cueId: ID, patch: { text?: string; offset?: number }): void;
  addManualCue(seqId: ID, trackId: ID, cue: { start: number; duration: number; text: string }): ID | null;
  splitCue(seqId: ID, cueId: ID, atFrame: number): ID | null;
  mergeCues(seqId: ID, cueIds: ID[]): void;
  removeCue(seqId: ID, cueId: ID): void;

  // ---- scenes library ----
  addScene(record: SceneRecord): void;
  updateScene(id: ID, patch: Partial<SceneRecord>): void;
  removeScene(id: ID): void;
  sceneFromSource(name?: string): ID | null;
  sceneFromClip(seqId: ID, clipId: ID, name?: string): ID | null;

  // ---- tags ----
  addTag(kind: keyof TagVocabulary, value: string): void;

  // ---- ui (no history) ----
  setTool(tool: Tool): void;
  select(clipIds: ID[], mode?: SelectMode): void;
  selectTransition(id: ID | null): void;
  selectMedia(ids: ID[], mode?: SelectMode): void;
  selectScenes(ids: ID[], mode?: SelectMode): void;
  selectBin(id: ID | null): void;
  selectMarker(id: ID | null): void;
  setSourceClip(mediaId: ID | null, time?: number): void;
  setSourceIn(seconds: number | null): void;
  setSourceOut(seconds: number | null): void;
  setSourceTime(seconds: number): void;
  setActivePanel(panel: string): void;
  setTimelineFocus(focus: boolean): void;
  setFilters(patch: Partial<FilterState>): void;
  clearFilters(): void;
  setCompare(patch: Partial<CompareState>): void;
  openDialog(name: DialogName): void;
  closeDialog(name: DialogName): void;
  toast(kind: ToastKind, text: string): ID;
  dismissToast(id: ID): void;
  setJobs(jobs: JobInfo[]): void;
  setPlaying(playing: boolean): void;
  setPlaybackRate(rate: number): void;
}

export type RecutStore = StoreState & StoreActions;

// Re-export a few model types for convenience of UI code importing from '@/state'.
export type { Clip, Track, Sequence, Project, MediaItem, SequenceSubtitleCue, SequenceSubtitleTrack, DetectedScene };
