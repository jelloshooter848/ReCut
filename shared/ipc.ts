/**
 * IPC contract between the Electron main process and the renderer.
 * The preload script exposes `window.recut` implementing `RecutApi`.
 * Main-process handlers are registered under the channel names in `IPC`.
 */
import type { AppPreferences, ExportSettings, ID, JobInfo, MediaProbe, Project, Sequence, MediaItem } from './model';

export const IPC = {
  // app
  appInfo: 'app:info',
  appQuit: 'app:quit',
  appQuitAck: 'app:quitAck',
  appQuitCancel: 'app:quitCancel',
  openExternal: 'app:openExternal',
  showItemInFolder: 'app:showItemInFolder',
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
  projectCheckRecovery: 'project:checkRecovery',
  projectDiscardRecovery: 'project:discardRecovery',
  projectRecent: 'project:recent',
  // prefs
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
  // files
  fsStat: 'fs:stat',
  fsReadText: 'fs:readText',
  fsWriteText: 'fs:writeText',
  fsScanForRelink: 'fs:scanForRelink',
  fsListDir: 'fs:listDir',
  // media
  mediaProbe: 'media:probe',
  mediaThumbnail: 'media:thumbnail',
  mediaFilmstrip: 'media:filmstrip',
  mediaWaveform: 'media:waveform',
  mediaProxyStart: 'media:proxyStart',
  mediaSceneDetectStart: 'media:sceneDetectStart',
  mediaExtractSubtitles: 'media:extractSubtitles',
  mediaUrl: 'media:url',
  // jobs
  jobsList: 'jobs:list',
  jobsCancel: 'jobs:cancel',
  jobsClear: 'jobs:clear',
  // export
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportPreviewCommand: 'export:previewCommand',
  // events (main -> renderer)
  evJobs: 'ev:jobs',
  evMenu: 'ev:menu',
  evOpenProjectPath: 'ev:openProjectPath',
  evBeforeQuit: 'ev:beforeQuit',
} as const;

export interface AppInfo {
  version: string;
  platform: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegVersion: string | null;
  cacheDir: string;
  userDataDir: string;
  /** The user's home directory (fallback output location for exports). */
  homeDir: string;
  isDev: boolean;
}

/** Structural stand-in for the DOM `File` (shared/ is compiled without the DOM lib); a real File satisfies it. */
export interface DroppedFile { name: string; size: number; type: string }

export interface FileFilter { name: string; extensions: string[] }

export interface OpenFilesOptions { title?: string; filters?: FileFilter[]; multi?: boolean; defaultPath?: string }
export interface SaveFileOptions { title?: string; filters?: FileFilter[]; defaultPath?: string }
export interface MessageOptions { type?: 'none' | 'info' | 'error' | 'question' | 'warning'; title?: string; message: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number }

export interface FileStat { exists: boolean; size?: number; mtimeMs?: number; isDirectory?: boolean }

export type SaveResult = { ok: true; path: string } | { ok: false; error: string }
export type LoadResult =
  | { ok: true; path: string; project: Project; fromBackup?: boolean; backupMtime?: number }
  | { ok: false; error: string }

export interface RecoveryInfo { autosavePath: string; projectPath: string | null; savedAt: number; project: Project }

export interface RelinkCandidate { missingMediaId: ID; path: string; confidence: 'name+size' | 'name' }
export interface RelinkScanRequest { folder: string; missing: { mediaId: ID; fileName: string; size?: number }[] }

export interface ThumbnailRequest { path: string; time: number; width?: number; mediaId?: ID }
export interface FilmstripRequest { path: string; times: number[]; width: number; mediaId?: ID }

export interface WaveformData {
  /** peaks per second */
  rate: number;
  /** Uint8 min/max interleaved? No: simple absolute peaks 0..255, one per bucket */
  peaks: Uint8Array;
  duration: number;
}

export interface ProxyRequest {
  mediaId: ID; path: string; height: number; audioChannels?: number;
  /** Absolute ffprobe index of the audio stream to carry (the media's preferredAudioStream); default: first audio stream. */
  audioStream?: number;
}
export interface SceneDetectRequest { mediaId: ID; path: string; threshold: number; duration: number; minSceneSeconds?: number }
export interface SceneDetectResult { boundaries: number[]; duration: number }

export interface ExportRequest {
  sequence: Sequence;
  media: Record<ID, MediaItem>;
  settings: ExportSettings;
  /** Sequence subtitle cues, already resolved to seconds. */
  subtitles?: { start: number; end: number; text: string }[];
}
export type ExportStartResult = { ok: true; jobId: ID; outputPath: string } | { ok: false; error: string }

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
  toggleFullscreen(): Promise<boolean>;
  /** Filesystem path of a File dropped from the OS (Electron >= 32 no longer exposes `File.path`). '' when unknown. */
  pathForFile(file: DroppedFile): string;

  openFiles(opts: OpenFilesOptions): Promise<string[]>;
  openFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  saveFile(opts: SaveFileOptions): Promise<string | null>;
  message(opts: MessageOptions): Promise<number>;

  saveProject(path: string, project: Project): Promise<SaveResult>;
  loadProject(path: string): Promise<LoadResult>;
  /** Writes <projectPath>.autosave (or an app-data file when the project has never been saved). */
  autosaveProject(path: string | null, project: Project): Promise<SaveResult>;
  checkRecovery(): Promise<RecoveryInfo | null>;
  discardRecovery(autosavePath: string): Promise<void>;
  recentProjects(): Promise<string[]>;

  getPrefs(): Promise<AppPreferences>;
  setPrefs(patch: Partial<AppPreferences>): Promise<AppPreferences>;

  stat(path: string): Promise<FileStat>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<{ name: string; path: string; isDirectory: boolean; size: number }[]>;
  scanForRelink(req: RelinkScanRequest): Promise<RelinkCandidate[]>;

  probe(path: string): Promise<MediaProbe>;
  /** Returns a recut-media:// URL to a cached JPEG. */
  thumbnail(req: ThumbnailRequest): Promise<string>;
  filmstrip(req: FilmstripRequest): Promise<string[]>;
  waveform(path: string, mediaId?: ID): Promise<WaveformData>;
  startProxy(req: ProxyRequest): Promise<JobInfo>;
  startSceneDetect(req: SceneDetectRequest): Promise<JobInfo>;
  /** Extracts embedded text subtitle stream to SRT text. */
  extractSubtitles(path: string, streamIndex: number): Promise<string>;
  /** Convert a filesystem path to a streamable URL for <video>/<img>. */
  mediaUrl(path: string): string;

  listJobs(): Promise<JobInfo[]>;
  cancelJob(id: ID): Promise<void>;
  clearJobs(): Promise<void>;

  startExport(req: ExportRequest): Promise<ExportStartResult>;
  cancelExport(jobId: ID): Promise<void>;
  previewExportCommand(req: ExportRequest): Promise<string[]>;

  onJobs(cb: (jobs: JobInfo[]) => void): () => void;
  onMenu(cb: (command: MenuCommand) => void): () => void;
  onOpenProjectPath(cb: (path: string) => void): () => void;
  onBeforeQuit(cb: () => void): () => void;
}

declare global {
  interface Window { recut: RecutApi }
}

/** Scheme used for streaming local media into the renderer with range support. */
export const MEDIA_SCHEME = 'recut-media';
export function pathToMediaUrl(path: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(path)}`;
}
export function mediaUrlToPath(url: string): string {
  const prefix = `${MEDIA_SCHEME}://local/`;
  return decodeURIComponent(url.startsWith(prefix) ? url.slice(prefix.length) : url);
}
