/**
 * Preload: exposes `window.recut` (RecutApi) to the renderer via contextBridge.
 * Every method maps 1:1 onto an IPC channel from shared/ipc.ts.
 */
import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron';
import type { AppPreferences, ID, JobInfo, Project } from '../shared/model';
import { IPC, pathToMediaUrl } from '../shared/ipc';
import type {
  DroppedFile, ExportRequest, FilmstripRequest, MenuCommand, MessageOptions, OpenFilesOptions, ProxyRequest, RecutApi,
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

const api: RecutApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  quit: (force?: boolean) => ipcRenderer.invoke(IPC.appQuit, Boolean(force)),
  quitAck: () => ipcRenderer.invoke(IPC.appQuitAck),
  quitCancel: () => ipcRenderer.invoke(IPC.appQuitCancel),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  showItemInFolder: (path: string) => ipcRenderer.invoke(IPC.showItemInFolder, path),
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
  scanForRelink: (req: RelinkScanRequest) => ipcRenderer.invoke(IPC.fsScanForRelink, req),

  probe: (path: string) => ipcRenderer.invoke(IPC.mediaProbe, path),
  thumbnail: (req: ThumbnailRequest) => ipcRenderer.invoke(IPC.mediaThumbnail, req),
  filmstrip: (req: FilmstripRequest) => ipcRenderer.invoke(IPC.mediaFilmstrip, req),
  cancelThumbnails: (requestIds: string[]) => ipcRenderer.invoke(IPC.mediaThumbCancel, requestIds),
  waveform: (path: string, mediaId?: ID) => ipcRenderer.invoke(IPC.mediaWaveform, path, mediaId),
  startProxy: (req: ProxyRequest) => ipcRenderer.invoke(IPC.mediaProxyStart, req),
  startSceneDetect: (req: SceneDetectRequest) => ipcRenderer.invoke(IPC.mediaSceneDetectStart, req),
  extractSubtitles: (path: string, streamIndex: number) => ipcRenderer.invoke(IPC.mediaExtractSubtitles, path, streamIndex),
  mediaUrl: (path: string) => pathToMediaUrl(path),

  listJobs: () => ipcRenderer.invoke(IPC.jobsList),
  cancelJob: (id: ID) => ipcRenderer.invoke(IPC.jobsCancel, id),
  clearJobs: () => ipcRenderer.invoke(IPC.jobsClear),

  startExport: (req: ExportRequest) => ipcRenderer.invoke(IPC.exportStart, req),
  cancelExport: (jobId: ID) => ipcRenderer.invoke(IPC.exportCancel, jobId),
  previewExportCommand: (req: ExportRequest) => ipcRenderer.invoke(IPC.exportPreviewCommand, req),

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
};

contextBridge.exposeInMainWorld('recut', api);
