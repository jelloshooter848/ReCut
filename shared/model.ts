/**
 * ReCut project model.
 *
 * Time conventions:
 *  - Timeline positions/durations are integer FRAMES at the owning sequence's frame rate.
 *  - Source media positions (sourceIn, scene boundaries, subtitle cues on media) are SECONDS (float).
 *  - A sequence frame rate is a rational {num, den} (e.g. 24000/1001).
 */

export const PROJECT_FORMAT_VERSION = 1;

export type ID = string;

export interface Rational { num: number; den: number }

export type MediaCategory =
  | 'Movie' | 'Episode' | 'Deleted Scene' | 'Alternate Cut' | 'Trailer' | 'Bonus Feature' | 'Music' | 'Other';

export const MEDIA_CATEGORIES: MediaCategory[] = [
  'Movie', 'Episode', 'Deleted Scene', 'Alternate Cut', 'Trailer', 'Bonus Feature', 'Music', 'Other',
];

export type MediaKind = 'video' | 'audio' | 'image' | 'subtitle' | 'unknown';

export interface AudioStreamInfo {
  index: number;          // stream index within file (absolute ffprobe index)
  codec: string;
  channels: number;
  layout: string;         // e.g. "stereo", "5.1(side)"
  sampleRate: number;
  language?: string;
  title?: string;
  /**
   * True when ffprobe reported no channel layout and `layout` is a guess from the channel count (probe.ts
   * layoutForChannels): channels are then numbered, not named (shared/audioChannels.ts). Absent on older probes.
   */
  layoutGuessed?: boolean;
}

export interface VideoStreamInfo {
  index: number;
  codec: string;
  width: number;
  height: number;
  fps: Rational;
  avgFps: Rational;
  pixFmt?: string;
  isVfr: boolean;
  colorSpace?: string;
  /** Display rotation in degrees (0/90/180/270). `width`/`height` are the display size. Absent on old probes. */
  rotation?: number;
  /** Coded (storage) size before rotation. */
  codedWidth?: number;
  codedHeight?: number;
  /** Video stream start relative to the container start (seconds, >= 0). */
  startTime?: number;
  /**
   * Sample (pixel) aspect ratio of the stored picture; `width`/`height` are storage pixels, so the display width
   * is `width * sar` (for SAR > 1). Absent on old probes and treated as 1:1; readers must validate it.
   */
  sar?: Rational;
}

export interface SubtitleStreamInfo { index: number; codec: string; language?: string; title?: string }

export interface MediaProbe {
  container: string;
  duration: number;             // seconds
  size: number;                 // bytes
  video?: VideoStreamInfo;
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
  startTime: number;            // container start time (seconds), used to normalize seeking
  bitrate?: number;
  /** Whether Chromium can decode this file directly (container + codecs). */
  browserPlayable: boolean;
  playabilityReason?: string;
}

export type ProxyStatus = 'none' | 'queued' | 'running' | 'ready' | 'failed';

export interface ProxyInfo {
  status: ProxyStatus;
  path?: string;
  progress?: number;         // 0..1
  error?: string;
  width?: number;
  height?: number;
  /**
   * Older single-stream proxies only: the audio stream baked into it (undefined: its `_a<N>` file suffix, else the
   * source's first audio stream). Proxies named `*_all.mp4` carry every audio stream (src/playback/mediaSource.ts
   * proxyAudioStreams).
   */
  audioStream?: number;
  /**
   * The source audio streams the proxy carries (absolute ffprobe indexes, in its track order), as the proxy job
   * recorded them (electron/media/proxy.ts ProxyResult.audioStreams): every stream, or a fallback's subset when one
   * stream could not be decoded or encoded. Proxies from before 0.4 have none.
   */
  audioStreams?: number[];
}

export interface DetectedScene {
  id: ID;
  start: number;   // seconds
  end: number;     // seconds
  name: string;
  tags: string[];
  characters: string[];
}

/** Hierarchical identity for TV / franchise organisation. All optional. */
export interface SourceIdentity {
  series?: string;
  season?: number;
  episode?: number;
  collection?: string;   // e.g. "Original Trilogy"
  franchise?: string;    // e.g. "Star Wars"
  title?: string;        // human title (movie name / episode title)
  year?: number;
}

export interface MediaItem {
  id: ID;
  name: string;
  path: string;
  kind: MediaKind;
  category: MediaCategory;
  identity: SourceIdentity;
  binId: ID | null;
  probe?: MediaProbe;
  probeError?: string;
  offline: boolean;
  fileSize?: number;
  fileMtime?: number;
  proxy: ProxyInfo;
  detectedScenes: DetectedScene[];
  sceneDetectStatus?: 'none' | 'running' | 'done' | 'failed';
  subtitleTrackIds: ID[];
  thumbnailTime?: number;   // poster frame time (seconds)
  notes: string;
  tags: string[];
  color?: string;
  addedAt: number;
  /** Preferred audio stream for new clips (absolute stream index). */
  preferredAudioStream?: number;
  /** Cache of waveform availability: path to peaks file */
  waveformStatus?: 'none' | 'running' | 'ready' | 'failed';
  /**
   * Preview proxies of clips' channel selections (ClipAudio.channelSelection), keyed by shared/audioChannels.ts
   * channelProxyKey (stream + selection): stereo audio files made with the export's `pan` filter
   * (electron/media/channelProxy.ts). Mirrored quietly from the jobs, like `proxy`; entries no clip uses are pruned.
   */
  channelProxies?: Record<string, ProxyInfo>;
}

export interface Bin {
  id: ID;
  name: string;
  parentId: ID | null;
  color?: string;
  /** Bins can be flagged as auto-organised containers (Series / Season) */
  kind?: 'bin' | 'series' | 'season' | 'collection';
}

export interface Crop { left: number; top: number; right: number; bottom: number }  // 0..1 fractions

export interface ClipTransform {
  x: number;        // offset in sequence pixels
  y: number;
  scale: number;    // 1 = 100%
  rotation: number; // degrees
  opacity: number;  // 0..1
  crop: Crop;
}

export interface ClipAudio {
  gain: number;      // dB applied first (clip gain)
  volume: number;    // linear multiplier 0..2 (level)
  fadeIn: number;    // frames
  fadeOut: number;   // frames
  muted: boolean;
  /**
   * What the clip plays of its (multichannel) source stream; absent = the stream's normal mix. See
   * shared/audioChannels.ts. A selection the stream cannot honour plays the normal mix (with an export warning).
   */
  channelSelection?: AudioChannelSelection;
}

/**
 * Per-clip channel selection: one source channel as mono (`channel`: an FFmpeg channel name of the stream's layout
 * such as 'FC', or 'c<N>' (0-based) when the layout is unknown), or a controlled stereo downmix with centre and
 * surround levels in dB (BS.775 defaults −3 / −3; LFE omitted).
 */
export type AudioChannelSelection =
  | { mode: 'channel'; channel: string }
  | { mode: 'downmix'; centreDb: number; surroundDb: number };

export type TransitionType = 'crossDissolve' | 'dipToBlack' | 'audioCrossfade';

export interface Transition {
  id: ID;
  type: TransitionType;
  /** Total duration in frames (centered on the cut between outClipId and inClipId). */
  duration: number;
  outClipId: ID | null;   // null => transition from black/silence (clip start)
  inClipId: ID | null;    // null => transition to black/silence (clip end)
}

export interface Clip {
  id: ID;
  mediaId: ID;
  name: string;
  start: number;       // frame
  duration: number;    // frames
  sourceIn: number;    // seconds in source
  speed: number;       // 1 = normal; source seconds consumed per timeline second
  linkId: ID | null;   // shared id among linked video/audio clips
  enabled: boolean;
  kind: 'video' | 'audio';
  audioStream?: number;   // absolute source stream index for audio clips
  transform: ClipTransform;
  audio: ClipAudio;
  tags: string[];
  characters: string[];
  plotlines: string[];
  locations: string[];
  notes: string;
  color?: string;
  sceneRecordId?: ID;   // if created from library scene
  /** Marks when this clip was dragged in from a detected scene / transcript cue */
  originLabel?: string;
}

export interface Track {
  id: ID;
  name: string;
  kind: 'video' | 'audio';
  clips: Clip[];
  transitions: Transition[];
  muted: boolean;
  solo: boolean;
  locked: boolean;
  height: number;      // px
  volume: number;      // linear
  /** Source patching target */
  patched: boolean;
}

export type MarkerKind = 'marker' | 'continuity' | 'chapter';

export interface Marker {
  id: ID;
  time: number;        // frame
  duration: number;    // frames (0 = point)
  name: string;
  note: string;
  color: string;
  kind: MarkerKind;
  category?: string;   // continuity: 'wardrobe' | 'prop' | 'dialogue' | 'music' | 'lighting' | 'source' | 'other'
  resolved?: boolean;
  clipId?: ID;
}

export interface SequenceSubtitleCue {
  id: ID;
  /** When attached to a clip, timeline position is derived from the clip's current position. */
  clipId?: ID;
  srcStart?: number;    // seconds within source media
  srcEnd?: number;
  start: number;        // frame (authoritative only when no clipId)
  duration: number;     // frames (authoritative only when no clipId)
  offset: number;       // frames nudge applied on top of derived position
  text: string;
}

export interface SequenceSubtitleTrack {
  id: ID;
  name: string;
  language: string;
  enabled: boolean;
  cues: SequenceSubtitleCue[];
  /** Subtitle files whose cues were imported into this track (project sources: exports never overwrite them). */
  sourcePaths?: string[];
}

export interface StoryBlock {
  id: ID;
  name: string;
  start: number;     // frame
  end: number;       // frame
  color: string;
  notes: string;
}

export interface SequenceSnapshot {
  id: ID;
  name: string;
  createdAt: number;
  data: Omit<Sequence, 'snapshots'>;
}

export interface Sequence {
  id: ID;
  name: string;
  fps: Rational;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;              // 2 or 6
  videoTracks: Track[];
  audioTracks: Track[];
  subtitleTracks: SequenceSubtitleTrack[];
  markers: Marker[];
  storyBlocks: StoryBlock[];
  snapshots: SequenceSnapshot[];
  /** Alternate-cut lineage */
  parentSequenceId?: ID;
  versionLabel?: string;
  createdAt: number;
  modifiedAt: number;
  binId: ID | null;
  /** Editor state that is nice to persist (not undoable). See `LiveView` in project.ts. */
  view: SequenceView;
}

export interface SequenceView { playhead: number; zoom: number; scroll: number; inPoint: number | null; outPoint: number | null }

export interface SceneRecord {
  id: ID;
  name: string;
  mediaId: ID;
  in: number;         // seconds
  out: number;        // seconds
  characters: string[];
  location: string;
  arc: string;
  tags: string[];
  notes: string;
  rating: number;     // 0..5
  color: string;
  createdAt: number;
}

export interface SubtitleCue { id: ID; start: number; end: number; text: string }  // seconds

export interface SubtitleTrack {
  id: ID;
  name: string;
  language: string;
  path?: string;
  mediaId: ID | null;     // associated source media
  cues: SubtitleCue[];
  /** Provider that produced it: 'srt' | 'vtt' | 'ocr' | 'whisper' | 'manual' (embedded text streams are 'srt') */
  origin: string;
  /**
   * Source stream of an OCR / embedded track (a subtitle stream) or a Whisper track (the audio stream it was
   * transcribed from): absolute ffprobe stream index in the media file (`mediaId`). Non-negative integer; absent for
   * tracks not read from a stream.
   */
  streamIndex?: number;
}

export interface TagVocabulary {
  characters: string[];
  plotlines: string[];
  locations: string[];
  themes: string[];
  custom: string[];
}

export interface ProjectSettings {
  useProxies: boolean;
  proxyHeight: number;         // 540 / 720
  autosaveIntervalSec: number;
  carrySubtitles: boolean;     // copy media subtitle cues into sequence when inserting clips
  sceneThreshold: number;      // 0..1
  playbackResolution: 'full' | '1/2' | '1/4';
  snapping: boolean;
  defaultTransitionFrames: number;
  showSourceTimecodeOnClips: boolean;
}

export interface Project {
  formatVersion: number;
  id: ID;
  name: string;
  createdAt: number;
  modifiedAt: number;
  media: Record<ID, MediaItem>;
  bins: Record<ID, Bin>;
  sequences: Record<ID, Sequence>;
  sequenceOrder: ID[];
  scenes: Record<ID, SceneRecord>;
  subtitleTracks: Record<ID, SubtitleTrack>;
  tags: TagVocabulary;
  settings: ProjectSettings;
  activeSequenceId: ID | null;
}

// ------------------------------------------------------------------
// Keyboard shortcut config (persisted in app preferences)
// ------------------------------------------------------------------
export interface ShortcutBinding { command: string; keys: string }

export interface AppPreferences {
  recentProjects: string[];
  shortcuts: Record<string, string>;   // command -> key combo
  cacheDir?: string;
  lastExportDir?: string;
  layout?: Record<string, number>;
  /** tessdata code (shared/ocr.ts) last used for OCR, the OCR dialog's default when the track language says nothing. */
  ocrLastLanguage?: string;
  /** Whisper model id (shared/whisper.ts) last used to transcribe, the Transcribe dialog's default while installed. */
  whisperLastModel?: string;
  /** Update notice (shared/update.ts): Preferences › Check for updates. Absent means 'ask'. */
  updateCheck?: 'ask' | 'on' | 'off';
  /** When the last update check was made (ms since the epoch), and whether GitHub answered it. */
  updateLastCheckAt?: number;
  updateLastCheckOk?: boolean;
  /** The release the last answered check found, when it was newer than the version running then. */
  updateLatest?: { version: string; url: string };
  /** "Skip this version": the release whose notice the user turned off. */
  updateSkipVersion?: string;
}

// ------------------------------------------------------------------
// Jobs (background work in the main process)
// ------------------------------------------------------------------
/**
 * 'ocr': bitmap subtitles to text; 'download': OCR language or Whisper model install; 'transcribe': speech-to-text
 * (Whisper); 'channelProxy': preview audio of a clip's channel selection (electron/media/channelProxy.ts);
 * 'collect': Collect Project (copy the project and its media to one folder).
 */
export type JobKind = 'probe' | 'proxy' | 'waveform' | 'sceneDetect' | 'export' | 'thumbnails' | 'transcribe' | 'ocr' | 'download' | 'channelProxy' | 'collect';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface JobInfo {
  id: ID;
  kind: JobKind;
  title: string;
  status: JobStatus;
  progress: number;      // 0..1
  message?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  mediaId?: ID;
  result?: unknown;
}

// ------------------------------------------------------------------
// Export
// ------------------------------------------------------------------
export interface ExportSettings {
  outputDir: string;
  fileName: string;
  width: number;
  height: number;
  fps: Rational;
  videoCodec: 'libx264' | 'libx265';
  qualityMode: 'crf' | 'bitrate';
  crf: number;
  videoBitrateKbps: number;
  preset: string;
  audioCodec: 'aac' | 'ac3';
  audioBitrateKbps: number;
  audioChannels: 2 | 6;
  sampleRate: number;
  rangeMode: 'entire' | 'inOut';
  burnSubtitles: boolean;
  exportSubtitleSidecar: boolean;
  useProxies: false;   // export always uses originals
  // --- Output format (0.8.0). All optional: settings saved before have none and export as MP4. See shared/exportFormat.ts.
  /** File format; absent = 'mp4'. MP4 uses videoCodec / audioCodec; MOV the intermediate codec with PCM audio; WAV / FLAC are audio only. */
  container?: ExportContainer;
  /** MOV video codec; absent = 'prores'. */
  intermediateCodec?: IntermediateCodec;
  /** ProRes profile; absent = 'hq'. */
  proresProfile?: ProResProfile;
  /** DNxHR profile; absent = 'hq'. */
  dnxhrProfile?: DnxhrProfile;
  /** Sample depth of PCM (MOV, WAV) and FLAC audio; absent = 24. */
  audioBitDepth?: AudioBitDepth;
  /** Audio-only formats: one file per audio track instead of one mixed file. */
  audioPerTrack?: boolean;
  // --- Packaging (0.9.0, ROADMAP §7). Optional, MKV only: absent = one main mix and no soft subtitles (as before).
  /** MKV: the output audio tracks, in order (the first is the default track); absent or empty = one main mix with audioCodec / audioBitrateKbps / audioChannels. */
  audioOutputs?: ExportAudioOutput[];
  /** MKV: sequence subtitle tracks muxed as soft subtitle streams, in order; absent or empty = none. */
  subtitleOutputs?: ExportSubtitleOutput[];
}

/** Export file formats (§6, §7). */
export type ExportContainer = 'mp4' | 'mov' | 'wav' | 'flac' | 'mkv';
/** Channel layout of one output audio track (§7). */
export type ExportAudioLayout = 'mono' | 'stereo' | '5.1';
/** Codec of one output audio track (§7); PCM and FLAC take ExportSettings.audioBitDepth. */
export type ExportAudioCodec = 'aac' | 'ac3' | 'flac' | 'pcm';
/** One output audio track of an MKV export: a mix of some of the sequence's audio tracks (shared/exportFormat.ts). */
export interface ExportAudioOutput {
  /** Sequence audio track ids mixed into this track; absent = every track the export renders (the main mix). */
  sources?: ID[];
  layout: ExportAudioLayout;
  codec: ExportAudioCodec;
  /** AAC / AC-3 bitrate in kbit/s; absent = a default for the layout. */
  bitrateKbps?: number;
  /** ISO 639-2 language code; absent or empty = 'und'. */
  language?: string;
  /** Stream title shown by players; absent = none. */
  title?: string;
}
/** One soft subtitle stream of an MKV export: a sequence subtitle track. */
export interface ExportSubtitleOutput {
  /** SequenceSubtitleTrack id. */
  trackId: ID;
  /** ISO 639-2 language code; absent = from the track's language. */
  language?: string;
  /** Stream title; absent = the track's name. */
  title?: string;
  default?: boolean;
  forced?: boolean;
}
export type IntermediateCodec = 'prores' | 'dnxhr';
export type ProResProfile = 'proxy' | 'lt' | 'standard' | 'hq' | '4444';
export type DnxhrProfile = 'lb' | 'sq' | 'hq' | 'hqx' | '444';
export type AudioBitDepth = 16 | 24;

export interface ExportPreset { name: string; settings: Partial<ExportSettings> }

export const EXPORT_PRESETS: ExportPreset[] = [
  { name: '1080p High Quality', settings: { width: 1920, height: 1080, videoCodec: 'libx264', qualityMode: 'crf', crf: 18, preset: 'medium', audioCodec: 'aac', audioBitrateKbps: 320, audioChannels: 2 } },
  { name: '1080p Smaller File', settings: { width: 1920, height: 1080, videoCodec: 'libx264', qualityMode: 'crf', crf: 26, preset: 'fast', audioCodec: 'aac', audioBitrateKbps: 160, audioChannels: 2 } },
  { name: '4K High Quality', settings: { width: 3840, height: 2160, videoCodec: 'libx264', qualityMode: 'crf', crf: 18, preset: 'medium', audioCodec: 'aac', audioBitrateKbps: 320, audioChannels: 2 } },
  { name: '720p Preview', settings: { width: 1280, height: 720, videoCodec: 'libx264', qualityMode: 'crf', crf: 28, preset: 'veryfast', audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2 } },
  { name: '1080p 5.1 Surround', settings: { width: 1920, height: 1080, videoCodec: 'libx264', qualityMode: 'crf', crf: 18, preset: 'medium', audioCodec: 'ac3', audioBitrateKbps: 640, audioChannels: 6 } },
  // Intermediate and audio-only presets keep the frame size, rate and channels (a preset without `container` is MP4).
  { name: 'ProRes 422 HQ (MOV)', settings: { container: 'mov', intermediateCodec: 'prores', proresProfile: 'hq', audioBitDepth: 24 } },
  { name: 'DNxHR HQ (MOV)', settings: { container: 'mov', intermediateCodec: 'dnxhr', dnxhrProfile: 'hq', audioBitDepth: 24 } },
  { name: 'WAV 24-bit (audio only)', settings: { container: 'wav', audioBitDepth: 24, audioPerTrack: false } },
  { name: 'WAV per audio track', settings: { container: 'wav', audioBitDepth: 24, audioPerTrack: true } },
];
