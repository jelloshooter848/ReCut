/**
 * Preload: exposes `window.recut` (RecutApi) to the renderer via contextBridge.
 * Every method maps 1:1 onto an IPC channel from shared/ipc.ts.
 */
import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron';
import type { AppPreferences, ID, JobInfo, Project } from '../shared/model';
import type { OcrRequest } from '../shared/ocr';
import type { TranscribeRequest } from '../shared/whisper';
import type { UpdateCheckSetting, UpdateStatus } from '../shared/update';
import type { CollectRequest } from '../shared/collect';
import { IPC, pathToMediaUrl } from '../shared/ipc';
import { SAVE_STREAM_IPC, type ProjectAutosaveStreamApi, type ProjectSaveStreamApi } from '../shared/projectWire';
import type {
  DroppedFile, ExportRequest, FilmstripRequest, LicenceFileId, MenuCommand, MessageOptions, OpenFilesOptions, ProxyRequest, ChannelProxyRequest, RecutApi,
  RelinkScanRequest, SaveFileOptions, SceneDetectRequest, ThumbnailRequest,
} from '../shared/ipc';

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

// `ev:openProjectPath` can arrive (from argv / second instance) before the renderer has mounted
// and subscribed. Buffer it here and replay to the first subscriber.
const pendingOpenPaths: string[] = [];
let openPathSubscribers = 0;
ipcRenderer.on(IPC.evOpenProjectPath, (_e, p: string) => {
  if (openPathSubscribers === 0 && typeof p === 'string') pendingOpenPaths.push(p);
});

const api: RecutApi & ProjectSaveStreamApi & ProjectAutosaveStreamApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  quit: (force?: boolean) => ipcRenderer.invoke(IPC.appQuit, Boolean(force)),
  quitAck: () => ipcRenderer.invoke(IPC.appQuitAck),
  quitCancel: () => ipcRenderer.invoke(IPC.appQuitCancel),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  showItemInFolder: (path: string) => ipcRenderer.invoke(IPC.showItemInFolder, path),
  licenceFiles: () => ipcRenderer.invoke(IPC.licenceFiles),
  openLicenceFile: (id: LicenceFileId) => ipcRenderer.invoke(IPC.openLicenceFile, id),
  toggleFullscreen: () => ipcRenderer.invoke(IPC.toggleFullscreen),
  pathForFile: (file: DroppedFile) => {
    try { return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]) || ''; } catch { return ''; }
  },

  openFiles: (opts: OpenFilesOptions) => ipcRenderer.invoke(IPC.dialogOpenFiles, opts),
  openFolder: (opts?: { title?: string; defaultPath?: string }) => ipcRenderer.invoke(IPC.dialogOpenFolder, opts ?? {}),
  saveFile: (opts: SaveFileOptions) => ipcRenderer.invoke(IPC.dialogSaveFile, opts),
  message: (opts: MessageOptions) => ipcRenderer.invoke(IPC.dialogMessage, opts),

  saveProject: (path: string, project: Project) => ipcRenderer.invoke(IPC.projectSave, path, project),
  // Same channel: main writes a string as-is and serializes an object itself.
  saveProjectJson: (path: string, json: string) => ipcRenderer.invoke(IPC.projectSave, path, json),
  // Streamed manual save (shared/projectWire.ts): pieces are one-way messages, in order on the same pipe as the invokes.
  saveProjectBegin: (path: string) => ipcRenderer.invoke(SAVE_STREAM_IPC.begin, path),
  saveProjectChunk: (id: string, seq: number, text: string) => { ipcRenderer.send(SAVE_STREAM_IPC.chunk, id, seq, text); },
  saveProjectCommit: (id: string, totals: { chunks: number; chars: number }) => ipcRenderer.invoke(SAVE_STREAM_IPC.commit, id, totals),
  saveProjectAbort: (id: string) => ipcRenderer.invoke(SAVE_STREAM_IPC.abort, id),
  // Streamed autosave: pieces / abort as above; the commit goes over the autosave channel with a stream reference.
  autosaveProjectBegin: (path: string | null) => ipcRenderer.invoke(SAVE_STREAM_IPC.autosaveBegin, path),
  autosaveProjectCommit: (path: string | null, id: string, totals: { chunks: number; chars: number }) =>
    ipcRenderer.invoke(IPC.projectAutosaveJson, path, { stream: id, chunks: totals.chunks, chars: totals.chars }),
  loadProject: (path: string) => ipcRenderer.invoke(IPC.projectLoad, path),
  autosaveProject: (path: string | null, project: Project) => ipcRenderer.invoke(IPC.projectAutosave, path, project),
  autosaveProjectJson: (path: string | null, json: string) => ipcRenderer.invoke(IPC.projectAutosaveJson, path, json),
  checkRecovery: () => ipcRenderer.invoke(IPC.projectCheckRecovery),
  discardRecovery: (autosavePath: string) => ipcRenderer.invoke(IPC.projectDiscardRecovery, autosavePath),
  recentProjects: () => ipcRenderer.invoke(IPC.projectRecent),

  getPrefs: () => ipcRenderer.invoke(IPC.prefsGet),
  setPrefs: (patch: Partial<AppPreferences>) => ipcRenderer.invoke(IPC.prefsSet, patch),

  stat: (path: string) => ipcRenderer.invoke(IPC.fsStat, path),
  readText: (path: string) => ipcRenderer.invoke(IPC.fsReadText, path),
  exportSubtitleFile: (path: string, content: string, protectedPaths: string[]) => ipcRenderer.invoke(IPC.subtitlesExport, path, content, protectedPaths),
  listDir: (path: string) => ipcRenderer.invoke(IPC.fsListDir, path),
  relocateLegacyPath: (path: string) => ipcRenderer.invoke(IPC.fsRelocateLegacyPath, path),
  scanForRelink: (req: RelinkScanRequest) => ipcRenderer.invoke(IPC.fsScanForRelink, req),

  probe: (path: string) => ipcRenderer.invoke(IPC.mediaProbe, path),
  thumbnail: (req: ThumbnailRequest) => ipcRenderer.invoke(IPC.mediaThumbnail, req),
  filmstrip: (req: FilmstripRequest) => ipcRenderer.invoke(IPC.mediaFilmstrip, req),
  cancelThumbnails: (requestIds: string[]) => ipcRenderer.invoke(IPC.mediaThumbCancel, requestIds),
  waveform: (path: string, mediaId?: ID, streamIndex?: number) => ipcRenderer.invoke(IPC.mediaWaveform, path, mediaId, streamIndex),
  startProxy: (req: ProxyRequest) => ipcRenderer.invoke(IPC.mediaProxyStart, req),
  lookupProxy: (req: ProxyRequest) => ipcRenderer.invoke(IPC.mediaProxyLookup, req),
  startChannelProxy: (req: ChannelProxyRequest) => ipcRenderer.invoke(IPC.mediaChannelProxyStart, req),
  startSceneDetect: (req: SceneDetectRequest) => ipcRenderer.invoke(IPC.mediaSceneDetectStart, req),
  extractSubtitles: (path: string, streamIndex: number) => ipcRenderer.invoke(IPC.mediaExtractSubtitles, path, streamIndex),
  mediaUrl: (path: string) => pathToMediaUrl(path),

  startOcr: (req: OcrRequest) => ipcRenderer.invoke(IPC.ocrStart, req),
  ocrLanguages: () => ipcRenderer.invoke(IPC.ocrLanguages),
  ocrInstallLanguage: (code: string) => ipcRenderer.invoke(IPC.ocrInstallLanguage, code),
  ocrRemoveLanguage: (code: string) => ipcRenderer.invoke(IPC.ocrRemoveLanguage, code),
  ocrInstallLanguageFromFile: (code: string, path: string) => ipcRenderer.invoke(IPC.ocrInstallLanguageFromFile, code, path),
  startTranscribe: (req: TranscribeRequest) => ipcRenderer.invoke(IPC.whisperStart, req),
  whisperEngine: () => ipcRenderer.invoke(IPC.whisperEngine),
  whisperModels: () => ipcRenderer.invoke(IPC.whisperModels),
  whisperInstallModel: (id: string) => ipcRenderer.invoke(IPC.whisperInstallModel, id),
  whisperRemoveModel: (id: string) => ipcRenderer.invoke(IPC.whisperRemoveModel, id),
  whisperInstallModelFromFile: (id: string, path: string) => ipcRenderer.invoke(IPC.whisperInstallModelFromFile, id, path),

  listJobs: () => ipcRenderer.invoke(IPC.jobsList),
  cancelJob: (id: ID) => ipcRenderer.invoke(IPC.jobsCancel, id),
  clearJobs: () => ipcRenderer.invoke(IPC.jobsClear),

  startExport: (req: ExportRequest) => ipcRenderer.invoke(IPC.exportStart, req),
  cancelExport: (jobId: ID) => ipcRenderer.invoke(IPC.exportCancel, jobId),
  previewExportCommand: (req: ExportRequest) => ipcRenderer.invoke(IPC.exportPreviewCommand, req),
  collectPreflight: (req: CollectRequest) => ipcRenderer.invoke(IPC.collectPreflight, req),
  startCollect: (req: CollectRequest) => ipcRenderer.invoke(IPC.collectStart, req),

  onJobs: (cb: (jobs: JobInfo[]) => void) => subscribe<[JobInfo[]]>(IPC.evJobs, cb),
  onMenu: (cb: (command: MenuCommand) => void) => subscribe<[MenuCommand]>(IPC.evMenu, cb),
  onOpenProjectPath: (cb: (path: string) => void) => {
    openPathSubscribers++;
    const off = subscribe<[string]>(IPC.evOpenProjectPath, cb);
    if (pendingOpenPaths.length) {
      const replay = pendingOpenPaths.splice(0, pendingOpenPaths.length);
      queueMicrotask(() => { for (const p of replay) cb(p); });
    }
    return () => { openPathSubscribers = Math.max(0, openPathSubscribers - 1); off(); };
  },
  onBeforeQuit: (cb: () => void) => subscribe<[]>(IPC.evBeforeQuit, cb),

  updateStatus: () => ipcRenderer.invoke(IPC.updateStatus),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  setUpdateCheck: (setting: UpdateCheckSetting) => ipcRenderer.invoke(IPC.updateSetSetting, setting),
  skipUpdateVersion: (version: string) => ipcRenderer.invoke(IPC.updateSkip, version),
  openReleasePage: (url: string) => ipcRenderer.invoke(IPC.updateOpenRelease, url),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => subscribe<[UpdateStatus]>(IPC.evUpdateStatus, cb),
};

contextBridge.exposeInMainWorld('recut', api);
