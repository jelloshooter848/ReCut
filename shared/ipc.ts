/**
 * IPC contract between the Electron main process and the renderer.
 * The preload script exposes `window.recut` implementing `RecutApi`.
 * Main-process handlers are registered under the channel names in `IPC`.
 */
import type { AppPreferences, AudioChannelSelection, ExportSettings, ID, JobInfo, MediaProbe, Project, Sequence, MediaItem } from './model';
import type { OcrLanguageState, OcrRequest } from './ocr';
import type { TranscribeRequest, WhisperEngineInfo, WhisperModelState } from './whisper';
import type { CollectRequest, CollectStartResult, CollectSummary } from './collect';
import type { ProjectWire } from './projectWire';
import type { UpdateCheckResult, UpdateCheckSetting, UpdateStatus } from './update';
import type { PathRoot } from './legacyPaths';
import { PRODUCT_NAME, envVarName } from './productIdentity';

export const IPC = {
  // app
  appInfo: 'app:info',
  appQuit: 'app:quit',
  appQuitAck: 'app:quitAck',
  appQuitCancel: 'app:quitCancel',
  openExternal: 'app:openExternal',
  showItemInFolder: 'app:showItemInFolder',
  licenceFiles: 'app:licenceFiles',
  openLicenceFile: 'app:openLicenceFile',
  toggleFullscreen: 'app:toggleFullscreen',
  // dialogs
  dialogOpenFiles: 'dialog:openFiles',
  dialogOpenFolder: 'dialog:openFolder',
  dialogSaveFile: 'dialog:saveFile',
  dialogMessage: 'dialog:message',
  // project
  projectSave: 'project:save',
  projectLoad: 'project:load',
  projectAutosave: 'project:autosave',
  projectAutosaveJson: 'project:autosaveJson',
  projectCheckRecovery: 'project:checkRecovery',
  projectDiscardRecovery: 'project:discardRecovery',
  projectRecent: 'project:recent',
  // prefs
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
  // files
  fsStat: 'fs:stat',
  fsReadText: 'fs:readText',
  /** Write a subtitle export (.srt / .vtt only), refused when it is the same file as a protected path. */
  subtitlesExport: 'subtitles:export',
  fsScanForRelink: 'fs:scanForRelink',
  fsListDir: 'fs:listDir',
  // media
  mediaProbe: 'media:probe',
  mediaThumbnail: 'media:thumbnail',
  mediaFilmstrip: 'media:filmstrip',
  mediaThumbCancel: 'media:thumbCancel',
  mediaWaveform: 'media:waveform',
  mediaProxyStart: 'media:proxyStart',
  mediaChannelProxyStart: 'media:channelProxyStart',
  mediaSceneDetectStart: 'media:sceneDetectStart',
  mediaExtractSubtitles: 'media:extractSubtitles',
  mediaUrl: 'media:url',
  // OCR of bitmap subtitles (shared/ocr.ts)
  ocrStart: 'ocr:start',
  ocrLanguages: 'ocr:languages',
  ocrInstallLanguage: 'ocr:installLanguage',
  ocrRemoveLanguage: 'ocr:removeLanguage',
  ocrInstallLanguageFromFile: 'ocr:installLanguageFromFile',
  // Speech-to-text with Whisper (shared/whisper.ts)
  whisperStart: 'whisper:start',
  whisperEngine: 'whisper:engine',
  whisperModels: 'whisper:models',
  whisperInstallModel: 'whisper:installModel',
  whisperRemoveModel: 'whisper:removeModel',
  whisperInstallModelFromFile: 'whisper:installModelFromFile',
  // jobs
  jobsList: 'jobs:list',
  jobsCancel: 'jobs:cancel',
  jobsClear: 'jobs:clear',
  // export
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportPreviewCommand: 'export:previewCommand',
  // update notice (shared/update.ts, electron/updateIpc.ts)
  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateSetSetting: 'update:setSetting',
  updateSkip: 'update:skip',
  updateOpenRelease: 'update:openRelease',
  // Collect Project (shared/collect.ts)
  collectPreflight: 'collect:preflight',
  collectStart: 'collect:start',
  // events (main -> renderer)
  evJobs: 'ev:jobs',
  evMenu: 'ev:menu',
  evOpenProjectPath: 'ev:openProjectPath',
  evBeforeQuit: 'ev:beforeQuit',
  evUpdateStatus: 'ev:updateStatus',
} as const;

/** How to fix a missing FFmpeg (shown in the startup banner and in import / export / proxy errors). */
export const FFMPEG_INSTALL_HELP =
  `Install FFmpeg (it provides both ffmpeg and ffprobe) and restart ${PRODUCT_NAME}: \`sudo apt install ffmpeg\` on Debian/Ubuntu, `
  + `\`brew install ffmpeg\` on macOS, or \`winget install Gyan.FFmpeg\` on Windows. Or point ${PRODUCT_NAME} at the binaries with the `
  + `${envVarName('FFMPEG')} and ${envVarName('FFPROBE')} environment variables. See docs/INSTALL.md.`;

/** Clear error for a missing ffmpeg / ffprobe binary. */
export function ffmpegMissingMessage(binary: 'ffmpeg' | 'ffprobe'): string {
  return `${binary} was not found, so ${PRODUCT_NAME} cannot ${binary === 'ffprobe' ? 'read media files' : 'process media'}. ${FFMPEG_INSTALL_HELP}`;
}

export interface AppInfo {
  version: string;
  platform: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegVersion: string | null;
  cacheDir: string;
  userDataDir: string;
  /**
   * Where paths into a legacy user-data folder (and its default cache) are looked for now (shared/legacyPaths.ts):
   * proxy paths saved before the folder moved. Empty or absent when there is none.
   */
  legacyPathRoots?: PathRoot[];
  /** Folder holding the installed OCR language files (`<userData>/ocr/tessdata`). */
  ocrDataDir: string;
  /** Folder holding the installed Whisper models (`<userData>/whisper/models`). */
  whisperModelsDir?: string;
  /** The user's home directory (fallback output location for exports). */
  homeDir: string;
  isDev: boolean;
}

/** Licence files Help › About can open (see electron/licences.ts). The renderer opens them by id, never by path. */
export type LicenceFileId = 'recut' | 'notices' | 'ffmpegBuild' | 'ffmpegLicense' | 'ffmpegReadme' | 'electron' | 'chromium' | 'tesseract'
  | 'whisperLicense' | 'whisperBuild';
export interface LicenceFile { id: LicenceFileId; label: string; fileName: string }
export type OpenLicenceResult = { ok: true } | { ok: false; error: string };

/** Structural stand-in for the DOM `File` (shared/ is compiled without the DOM lib); a real File satisfies it. */
export interface DroppedFile { name: string; size: number; type: string }

export interface FileFilter { name: string; extensions: string[] }

export interface OpenFilesOptions { title?: string; filters?: FileFilter[]; multi?: boolean; defaultPath?: string }
export interface SaveFileOptions { title?: string; filters?: FileFilter[]; defaultPath?: string }
export interface MessageOptions { type?: 'none' | 'info' | 'error' | 'question' | 'warning'; title?: string; message: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number }

export interface FileStat { exists: boolean; size?: number; mtimeMs?: number; isDirectory?: boolean }

/** Result of `exportSubtitleFile`: refusals (project source, not .srt/.vtt, not absolute) come back as `ok: false`. */
export type SubtitleWriteResult = { ok: true; path: string } | { ok: false; error: string };

export type SaveResult = { ok: true; path: string } | { ok: false; error: string }
export type LoadResult =
  | {
    ok: true; path: string; project: Project; fromBackup?: boolean; backupMtime?: number;
    /** What had to be repaired to open the file (one line per kind of repair); absent when nothing was. */
    repaired?: string[];
    /** Copy of the file as it was before the repairs (`<file>.pre-repair-<ts>`), when `repaired` is set and the copy worked. */
    preRepairPath?: string;
  }
  | { ok: false; error: string }

export interface RecoveryInfo {
  autosavePath: string; projectPath: string | null; savedAt: number; project: Project;
  /** What had to be repaired to load the autosave (one line per kind of repair); absent when nothing was. No copy is kept. */
  repaired?: string[];
}

/**
 * What `loadProject` resolves to over IPC: a LoadResult whose project travels as `projectWire` (JSON pieces of the
 * project main already normalized; see shared/projectWire.ts) instead of a structured-cloned object. A plain
 * LoadResult (`project`, e.g. from an older bridge or a test double) is still accepted and normalized by the renderer.
 */
export type LoadReply = LoadResult | (Omit<Extract<LoadResult, { ok: true }>, 'project'> & { projectWire: ProjectWire });

/** What `checkRecovery` resolves to over IPC: RecoveryInfo with the project as `projectWire` (and its name for the prompt). */
export type RecoveryReply = RecoveryInfo | (Omit<RecoveryInfo, 'project'> & { projectWire: ProjectWire; projectName: string });

export interface RelinkCandidate { missingMediaId: ID; path: string; confidence: 'name+size' | 'name' }
export interface RelinkScanRequest { folder: string; missing: { mediaId: ID; fileName: string; size?: number }[] }

export interface ThumbnailRequest { path: string; time: number; width?: number; mediaId?: ID }
export interface FilmstripRequest {
  path: string; times: number[]; width: number; mediaId?: ID;
  /** Names this request so `cancelThumbnails([requestId])` can drop its still-queued frames. */
  requestId?: string;
}

export interface WaveformData {
  /** peaks per second */
  rate: number;
  /** Uint8 min/max interleaved? No: simple absolute peaks 0..255, one per bucket */
  peaks: Uint8Array;
  duration: number;
}

export interface ProxyRequest {
  mediaId: ID; path: string; height: number; audioChannels?: number;
  /**
   * The stream a fallback proxy keeps when the all-streams run and the decodable-streams run both fail (absolute
   * index; the media's preferred stream). A proxy normally carries every audio stream (electron/media/proxy.ts).
   */
  audioStream?: number;
}
/**
 * Preview audio for a clip's channel selection (Roadmap §9): stream `stream` (absolute index) of the original at
 * `path`, through the export's stereo `pan` filter (electron/media/channelProxy.ts). A job of kind 'channelProxy'
 * whose result is `{ path, key, cached }` (key: shared/audioChannels.ts channelProxyKey).
 */
export interface ChannelProxyRequest { mediaId: ID; path: string; stream: number; selection: AudioChannelSelection }
export interface SceneDetectRequest { mediaId: ID; path: string; threshold: number; duration: number; minSceneSeconds?: number }
export interface SceneDetectResult { boundaries: number[]; duration: number }

export interface ExportRequest {
  sequence: Sequence;
  /**
   * The project sequences `sequence` nests (transitively, keyed by id; shared/nest.ts nestedSequencesFor), which the
   * export flattens into the outer timeline. Absent or empty when it nests none.
   */
  sequences?: Record<ID, Sequence>;
  media: Record<ID, MediaItem>;
  settings: ExportSettings;
  /** Sequence subtitle cues, already resolved to seconds. */
  subtitles?: { start: number; end: number; text: string }[];
  /**
   * The sequence's subtitle tracks one by one (cues resolved to seconds), for soft subtitle streams
   * (`settings.subtitleOutputs`, MKV). Hidden (disabled) tracks are included: the settings choose.
   */
  subtitleTracks?: { id: ID; name: string; language: string; cues: { start: number; end: number; text: string }[] }[];
  /**
   * Every project source asset the export must never write over (or next to, via its `.part` temp or
   * sidecar `.srt`): all project media paths and proxy paths (used by this sequence or not) and imported
   * subtitle track files. Filled by the Export dialog; optional for other callers (the sequence's own
   * media and everything in `media` are always protected).
   */
  protectedPaths?: string[];
  /**
   * Replace an existing output file / sidecar .srt (the user confirmed). Without it the export is refused with
   * code 'exists' when either already exists. Never allows writing over a project source or a folder.
   */
  overwrite?: boolean;
}
export type ExportStartResult =
  /** `outputPaths`: every file of a per-track audio export (one per audio track); `outputPath` is the first. */
  | { ok: true; jobId: ID; outputPath: string; outputPaths?: string[] }
  /** `code: 'exists'`: the output or sidecar exists; ask the user and resend with `overwrite: true`. */
  | { ok: false; error: string; code?: 'exists' }

export type MenuCommand = string;

export interface RecutApi {
  appInfo(): Promise<AppInfo>;
  quit(force?: boolean): Promise<void>;
  /** Acknowledge ev:beforeQuit (the renderer is alive and handling it; cancels the force-quit fallback). */
  quitAck(): Promise<void>;
  /** The renderer decided not to quit (Cancel / failed save): clear the pending quit and stay open. */
  quitCancel(): Promise<void>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  /** The licence files shipped with this build (the app's own, third-party notices, bundled FFmpeg, Electron), in display order. */
  licenceFiles(): Promise<LicenceFile[]>;
  /** Open one of `licenceFiles()` with the system's default app (or reveal it when nothing can open it). */
  openLicenceFile(id: LicenceFileId): Promise<OpenLicenceResult>;
  toggleFullscreen(): Promise<boolean>;
  /** Filesystem path of a File dropped from the OS (Electron >= 32 no longer exposes `File.path`). '' when unknown. */
  pathForFile(file: DroppedFile): string;

  openFiles(opts: OpenFilesOptions): Promise<string[]>;
  openFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  saveFile(opts: SaveFileOptions): Promise<string | null>;
  message(opts: MessageOptions): Promise<number>;

  saveProject(path: string, project: Project): Promise<SaveResult>;
  /**
   * Same as saveProject with the project already serialized in the renderer (serializeProject layout): one string
   * crosses IPC instead of a structured clone of the whole project; main writes it as-is (atomic, `.bak`).
   */
  saveProjectJson(path: string, json: string): Promise<SaveResult>;
  loadProject(path: string): Promise<LoadReply>;
  /** Writes <projectPath>.autosave (or an app-data file when the project has never been saved). */
  autosaveProject(path: string | null, project: Project): Promise<SaveResult>;
  /**
   * Same as autosaveProject with the project already serialized (JSON.stringify in the renderer): a string
   * crosses contextBridge/IPC without a structured clone of the whole object graph. Written as-is
   * (atomically, no re-parse / normalize).
   */
  autosaveProjectJson(path: string | null, json: string): Promise<SaveResult>;
  checkRecovery(): Promise<RecoveryReply | null>;
  discardRecovery(autosavePath: string): Promise<void>;
  recentProjects(): Promise<string[]>;

  getPrefs(): Promise<AppPreferences>;
  setPrefs(patch: Partial<AppPreferences>): Promise<AppPreferences>;

  stat(path: string): Promise<FileStat>;
  readText(path: string): Promise<string>;
  /**
   * Atomically write subtitle text to `path` (.srt / .vtt only). The main process refuses a target that is
   * the same file as any of `protectedPaths` (the project's source files) by canonical path (symlinks
   * resolved, case-folded on Windows / macOS) or device + inode.
   */
  exportSubtitleFile(path: string, content: string, protectedPaths: string[]): Promise<SubtitleWriteResult>;
  listDir(path: string): Promise<{ name: string; path: string; isDirectory: boolean; size: number }[]>;
  scanForRelink(req: RelinkScanRequest): Promise<RelinkCandidate[]>;

  probe(path: string): Promise<MediaProbe>;
  /** Returns a recut-media:// URL to a cached JPEG. */
  thumbnail(req: ThumbnailRequest): Promise<string>;
  filmstrip(req: FilmstripRequest): Promise<string[]>;
  /** Drop the still-queued frames of filmstrip requests (by `requestId`); running extractions finish and are cached. */
  cancelThumbnails(requestIds: string[]): Promise<void>;
  /** Peaks of one audio stream (`streamIndex`: absolute ffprobe index; default the first audio stream). */
  waveform(path: string, mediaId?: ID, streamIndex?: number): Promise<WaveformData>;
  startProxy(req: ProxyRequest): Promise<JobInfo>;
  /** Queue (or join) the channel proxy job of a clip's channel selection. */
  startChannelProxy(req: ChannelProxyRequest): Promise<JobInfo>;
  startSceneDetect(req: SceneDetectRequest): Promise<JobInfo>;
  /** Extracts embedded text subtitle stream to SRT text. */
  extractSubtitles(path: string, streamIndex: number): Promise<string>;
  /** Convert a filesystem path to a streamable URL for <video>/<img>. */
  mediaUrl(path: string): string;

  /** Read a bitmap subtitle stream (PGS / VobSub / DVB / XSUB) with OCR: a job of kind 'ocr' whose result is an OcrResult. */
  startOcr(req: OcrRequest): Promise<JobInfo>;
  /** Every installable OCR language (shared/ocr.ts OCR_LANGUAGES) and whether it is installed or downloading. */
  ocrLanguages(): Promise<OcrLanguageState[]>;
  /** Download and verify one OCR language: a job of kind 'download' (one per language at a time). */
  ocrInstallLanguage(code: string): Promise<JobInfo>;
  /** Delete an installed OCR language (refused while it is downloading). */
  ocrRemoveLanguage(code: string): Promise<{ ok: boolean; error?: string }>;
  /** Install an OCR language from a local file the user picked; refused unless it matches the manifest SHA-256. */
  ocrInstallLanguageFromFile(code: string, path: string): Promise<{ ok: boolean; error?: string }>;

  /** Transcribe one audio stream with Whisper: a job of kind 'transcribe' whose result is a TranscribeResult. */
  startTranscribe(req: TranscribeRequest): Promise<JobInfo>;
  /** The bundled speech-to-text engine (path, version) and the models folder. */
  whisperEngine(): Promise<WhisperEngineInfo>;
  /** Every installable Whisper model (shared/whisper.ts WHISPER_MODELS) and whether it is installed or downloading. */
  whisperModels(): Promise<WhisperModelState[]>;
  /** Download and verify one Whisper model: a job of kind 'download' (one per model at a time; resumes a partial file). */
  whisperInstallModel(id: string): Promise<JobInfo>;
  /** Delete an installed Whisper model and any partial download (refused while it is downloading). */
  whisperRemoveModel(id: string): Promise<{ ok: boolean; error?: string }>;
  /** Install a Whisper model from a local file the user picked; refused unless it matches the manifest SHA-256. */
  whisperInstallModelFromFile(id: string, path: string): Promise<{ ok: boolean; error?: string }>;

  listJobs(): Promise<JobInfo[]>;
  cancelJob(id: ID): Promise<void>;
  clearJobs(): Promise<void>;

  startExport(req: ExportRequest): Promise<ExportStartResult>;
  cancelExport(jobId: ID): Promise<void>;
  previewExportCommand(req: ExportRequest): Promise<string[]>;

  /** Collect Project: what a collect with these options would copy, and whether it can start (shared/collect.ts). */
  collectPreflight(req: CollectRequest): Promise<CollectSummary>;
  /** Start Collect Project: a job of kind 'collect' (cancel with cancelJob); its result is a CollectResult. */
  startCollect(req: CollectRequest): Promise<CollectStartResult>;

  onJobs(cb: (jobs: JobInfo[]) => void): () => void;
  onMenu(cb: (command: MenuCommand) => void): () => void;
  onOpenProjectPath(cb: (path: string) => void): () => void;
  onBeforeQuit(cb: () => void): () => void;

  // ---- update notice (shared/update.ts); nothing is downloaded or installed ----
  /** The update setting, the last check and the newer release to tell the user about (if any). */
  updateStatus(): Promise<UpdateStatus>;
  /** Check GitHub now, whatever the setting (Help › Check for Updates…). Never rejects for network errors. */
  checkForUpdates(): Promise<UpdateCheckResult>;
  /** Preferences › Check for updates (also the answer to the first-launch prompt). */
  setUpdateCheck(setting: UpdateCheckSetting): Promise<UpdateStatus>;
  /** "Skip this version". */
  skipUpdateVersion(version: string): Promise<UpdateStatus>;
  /** Open a release page in the browser; refused (false) unless it is this repository's releases page. */
  openReleasePage(url: string): Promise<boolean>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
}

declare global {
  interface Window { recut: RecutApi }
}

/** Scheme used for streaming local media into the renderer with range support. */
// frozen: changing this would break every place that builds or parses these URLs (protocol registration, thumbnails,
// the smoke test and about 25 test files) with nothing gained: the scheme is invisible to users and never saved.
export const MEDIA_SCHEME = 'recut-media';
export function pathToMediaUrl(path: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(path)}`;
}
export function mediaUrlToPath(url: string): string {
  const prefix = `${MEDIA_SCHEME}://local/`;
  return decodeURIComponent(url.startsWith(prefix) ? url.slice(prefix.length) : url);
}
