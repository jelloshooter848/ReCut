/**
 * IPC registration for the main process.
 *
 * `registerIpc(deps)` wires the app / dialog / project / prefs / fs channels.
 * `registerMediaIpc(handlers)` wires the media / jobs / export channels to an implementation of
 * `MediaHandlers` (provided by electron/media/index.ts, owned by the media agent).
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDirSafe } from './safeMkdir';
import { getFfmpegPath, getFfprobePath } from './media/ffmpeg';
import type { AppPreferences, ID, JobInfo, MediaProbe, Project } from '../shared/model';
import { IPC, pathToMediaUrl } from '../shared/ipc';
import type {
  AppInfo, ExportRequest, ExportStartResult, FilmstripRequest, LoadReply, MessageOptions, OpenFilesOptions,
  ProxyRequest, RecoveryReply, RecutApi, RelinkScanRequest, SaveFileOptions, SaveResult, SceneDetectRequest, ThumbnailRequest, WaveformData,
} from '../shared/ipc';
import { encodeProjectWire, isAutosaveStreamRef, SAVE_STREAM_IPC as IPC_SAVE, type SaveBeginResult } from '../shared/projectWire';
import * as io from './project/io';
import * as fsApi from './fs';

// ------------------------------------------------------------------
// Media / jobs / export contract (implemented by electron/media/index.ts)
// ------------------------------------------------------------------

/** Context handed to the media layer once the app is ready. */
export interface MediaContext {
  userData: string;
  cacheDir: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  /** Broadcast to every renderer window (used for ev:jobs). */
  broadcast(channel: string, ...args: unknown[]): void;
}

/**
 * The media/jobs/export portion of RecutApi, as implemented in the main process, plus
 * `onJobsUpdate` for pushing job list changes to the renderer (`ev:jobs`).
 */
export interface MediaHandlers {
  /** Optional one-time setup after app ready (cache dir, ffmpeg discovery, ...). */
  init?(ctx: MediaContext): Promise<void> | void;
  /** Optional teardown before quit (kill child processes). */
  shutdown?(): Promise<void> | void;

  probe(path: string): Promise<MediaProbe>;
  thumbnail(req: ThumbnailRequest): Promise<string>;
  filmstrip(req: FilmstripRequest): Promise<string[]>;
  cancelThumbnails(requestIds: string[]): Promise<void>;
  waveform(path: string, mediaId?: ID): Promise<WaveformData>;
  startProxy(req: ProxyRequest): Promise<JobInfo>;
  startSceneDetect(req: SceneDetectRequest): Promise<JobInfo>;
  extractSubtitles(path: string, streamIndex: number): Promise<string>;

  listJobs(): Promise<JobInfo[]>;
  cancelJob(id: ID): Promise<void>;
  clearJobs(): Promise<void>;

  startExport(req: ExportRequest): Promise<ExportStartResult>;
  cancelExport(jobId: ID): Promise<void>;
  previewExportCommand(req: ExportRequest): Promise<string[]>;

  /** Subscribe to job list changes; returns an unsubscribe function. */
  onJobsUpdate(cb: (jobs: JobInfo[]) => void): () => void;
}

// Compile-time check: MediaHandlers must stay in sync with the RecutApi surface.
type MediaApiKeys = 'probe' | 'thumbnail' | 'filmstrip' | 'cancelThumbnails' | 'waveform' | 'startProxy' | 'startSceneDetect' | 'extractSubtitles'
  | 'listJobs' | 'cancelJob' | 'clearJobs' | 'startExport' | 'cancelExport' | 'previewExportCommand';
type _AssertMediaHandlers = Pick<RecutApi, MediaApiKeys> extends Pick<MediaHandlers, MediaApiKeys> ? true : never;
const _mediaHandlersInSync: _AssertMediaHandlers = true;
void _mediaHandlersInSync;

export function registerMediaIpc(h: MediaHandlers): void {
  ipcMain.handle(IPC.mediaProbe, (_e, p: string) => h.probe(assertString(p, 'path')));
  ipcMain.handle(IPC.mediaThumbnail, (_e, req: ThumbnailRequest) => h.thumbnail(req));
  ipcMain.handle(IPC.mediaFilmstrip, (_e, req: FilmstripRequest) => h.filmstrip(req));
  ipcMain.handle(IPC.mediaThumbCancel, (_e, ids: unknown) => h.cancelThumbnails(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []));
  ipcMain.handle(IPC.mediaWaveform, (_e, p: string, mediaId?: ID) => h.waveform(assertString(p, 'path'), mediaId));
  ipcMain.handle(IPC.mediaProxyStart, (_e, req: ProxyRequest) => h.startProxy(req));
  ipcMain.handle(IPC.mediaSceneDetectStart, (_e, req: SceneDetectRequest) => h.startSceneDetect(req));
  ipcMain.handle(IPC.mediaExtractSubtitles, (_e, p: string, streamIndex: number) => h.extractSubtitles(assertString(p, 'path'), Number(streamIndex)));
  ipcMain.handle(IPC.jobsList, () => h.listJobs());
  ipcMain.handle(IPC.jobsCancel, (_e, id: ID) => h.cancelJob(assertString(id, 'id')));
  ipcMain.handle(IPC.jobsClear, () => h.clearJobs());
  ipcMain.handle(IPC.exportStart, (_e, req: ExportRequest) => h.startExport(req));
  ipcMain.handle(IPC.exportCancel, (_e, id: ID) => h.cancelExport(assertString(id, 'jobId')));
  ipcMain.handle(IPC.exportPreviewCommand, (_e, req: ExportRequest) => h.previewExportCommand(req));
}

// ------------------------------------------------------------------
// Core IPC
// ------------------------------------------------------------------

export interface IpcDeps {
  getWindow(): BrowserWindow | null;
  /** Begin the quit flow; `force` skips the renderer confirmation round-trip. */
  requestQuit(force: boolean): void;
  /** The renderer acknowledged ev:beforeQuit (cancels the hung-renderer fallback). */
  ackQuit?(): void;
  /** The renderer chose to stay open (Cancel / failed save). */
  cancelQuit?(): void;
  userData: string;
  isDev: boolean;
  /** Called whenever the recent-projects list changes (menu rebuild). */
  onRecentChanged?(): void;
}

function assertString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`Expected ${name} to be a string`);
  return v;
}

function parentWindow(deps: IpcDeps): BrowserWindow | undefined {
  const w = deps.getWindow();
  return w && !w.isDestroyed() ? w : undefined;
}

// --- ffmpeg discovery: the same resolver the media services and export use ---

let ffmpegVersionCache: Promise<string | null> | null = null;
function ffmpegVersion(ffmpegPath: string | null): Promise<string | null> {
  if (!ffmpegPath) return Promise.resolve(null);
  ffmpegVersionCache ??= new Promise((resolve) => {
    execFile(ffmpegPath, ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /ffmpeg version (\S+)/.exec(String(stdout));
      resolve(m ? m[1] : String(stdout).split('\n')[0] || null);
    });
  });
  return ffmpegVersionCache;
}

export function resolveFfmpeg(): { ffmpegPath: string | null; ffprobePath: string | null } {
  return { ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath() };
}

export async function resolveCacheDir(userData: string): Promise<string> {
  const prefs = await io.readPrefs(userData);
  const fallback = path.join(userData, 'cache');
  const dir = prefs.cacheDir && prefs.cacheDir.trim() ? prefs.cacheDir : fallback;
  // No recursive mkdir on a user path (BUG-1: it never returns under /proc). An unusable configured
  // folder falls back to the default cache folder.
  try {
    await ensureDirSafe(dir);
    return dir;
  } catch (e) {
    if (dir === fallback) return dir;
    console.warn(`cache folder ${dir} is not usable (${e instanceof Error ? e.message : String(e)}); using ${fallback}`);
    await ensureDirSafe(fallback).catch(() => undefined);
    return fallback;
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { userData } = deps;

  // --- app ---
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    const { ffmpegPath, ffprobePath } = resolveFfmpeg();
    return {
      version: app.getVersion(),
      platform: process.platform,
      ffmpegPath,
      ffprobePath,
      ffmpegVersion: await ffmpegVersion(ffmpegPath),
      cacheDir: await resolveCacheDir(userData),
      userDataDir: userData,
      homeDir: app.getPath('home'),
      isDev: deps.isDev,
    };
  });
  ipcMain.handle(IPC.appQuit, (_e, force?: boolean) => { deps.requestQuit(Boolean(force)); });
  ipcMain.handle(IPC.appQuitAck, () => { deps.ackQuit?.(); });
  ipcMain.handle(IPC.appQuitCancel, () => { deps.cancelQuit?.(); });
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    assertString(url, 'url');
    if (!/^(https?|mailto):/i.test(url)) throw new Error('Only http(s) and mailto URLs can be opened');
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC.showItemInFolder, (_e, p: string) => { shell.showItemInFolder(assertString(p, 'path')); });
  ipcMain.handle(IPC.toggleFullscreen, () => {
    const w = parentWindow(deps);
    if (!w) return false;
    const next = !w.isFullScreen();
    w.setFullScreen(next);
    return next;
  });

  // --- dialogs ---
  ipcMain.handle(IPC.dialogOpenFiles, async (_e, opts: OpenFilesOptions = {}) => {
    const w = parentWindow(deps);
    const options: Electron.OpenDialogOptions = {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    };
    const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle(IPC.dialogOpenFolder, async (_e, opts: { title?: string; defaultPath?: string } = {}) => {
    const w = parentWindow(deps);
    const options: Electron.OpenDialogOptions = { title: opts.title, defaultPath: opts.defaultPath, properties: ['openDirectory', 'createDirectory'] };
    const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.dialogSaveFile, async (_e, opts: SaveFileOptions = {}) => {
    const w = parentWindow(deps);
    const options: Electron.SaveDialogOptions = { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters };
    const r = w ? await dialog.showSaveDialog(w, options) : await dialog.showSaveDialog(options);
    return r.canceled || !r.filePath ? null : r.filePath;
  });
  ipcMain.handle(IPC.dialogMessage, async (_e, opts: MessageOptions) => {
    const w = parentWindow(deps);
    const options: Electron.MessageBoxOptions = {
      type: opts.type ?? 'none',
      title: opts.title,
      message: opts.message,
      detail: opts.detail,
      buttons: opts.buttons ?? ['OK'],
      defaultId: opts.defaultId,
      cancelId: opts.cancelId,
      noLink: true,
    };
    const r = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
    return r.response;
  });

  // --- project ---
  /** After a successful save: recent list, and the untitled autosave of the same project is dropped. */
  const afterSave = async (savedPath: string, projectId: unknown) => {
    await Promise.all([io.addRecentProject(userData, savedPath), io.clearUntitledAutosaveForId(projectId, userData)]);
    deps.onRecentChanged?.();
  };
  // A string is the project already serialized by the renderer (saveProjectJson): written as-is. An object
  // (saveProject, older renderers) is serialized here.
  ipcMain.handle(IPC.projectSave, async (_e, p: string, data: Project | string) => {
    const file = assertString(p, 'path');
    const isJson = typeof data === 'string';
    const res = isJson ? await io.saveProjectJson(file, data) : await io.saveProjectFile(file, data);
    if (res.ok) await afterSave(res.path, isJson ? io.topLevelProjectId(data) : data?.id);
    return res;
  });
  // Streamed manual save (shared/projectWire.ts ProjectSaveStreamApi): the renderer sends the file text in pieces
  // while it serializes; each open save belongs to the window that began it and is dropped if that window goes away.
  const saveStreams = new Map<string, { writer: io.ProjectFileWriter; sender: number }>();
  const watchedSenders = new Set<number>();
  const MAX_SAVE_STREAMS_PER_WINDOW = 4;
  const saveStream = (id: unknown, sender: number) => {
    const s = typeof id === 'string' ? saveStreams.get(id) : undefined;
    return s && s.sender === sender ? s.writer : undefined;
  };
  /** Open a streamed save (`open` creates its writer) for the window behind `e`; `label` starts its error messages. */
  const beginStream = async (e: Electron.IpcMainInvokeEvent, label: string, open: () => Promise<io.ProjectFileWriter>): Promise<SaveBeginResult> => {
    const sender = e.sender.id;
    if ([...saveStreams.values()].filter((s) => s.sender === sender).length >= MAX_SAVE_STREAMS_PER_WINDOW) {
      return { ok: false, error: `${label}: too many saves in progress` };
    }
    let writer: io.ProjectFileWriter;
    try { writer = await open(); } catch (err) {
      return { ok: false, error: `${label}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const id = randomUUID();
    saveStreams.set(id, { writer, sender });
    if (!watchedSenders.has(sender)) {
      // A renderer that crashes or closes mid-save never commits: drop its temp files.
      watchedSenders.add(sender);
      const drop = () => { for (const [k, s] of saveStreams) if (s.sender === sender) { saveStreams.delete(k); void s.writer.abort(); } };
      e.sender.on('render-process-gone', drop);
      e.sender.once('destroyed', () => { watchedSenders.delete(sender); drop(); });
    }
    return { ok: true, id };
  };
  ipcMain.handle(IPC_SAVE.begin, (e, p: string): Promise<SaveBeginResult> => {
    const file = assertString(p, 'path');
    return beginStream(e, 'Could not save project', () => io.ProjectFileWriter.open(file));
  });
  // Streamed autosave: committed over IPC.projectAutosaveJson (below) with an AutosaveStreamRef.
  ipcMain.handle(IPC_SAVE.autosaveBegin, (e, p: unknown): Promise<SaveBeginResult> =>
    beginStream(e, 'Autosave failed', () => io.ProjectFileWriter.openAutosave(typeof p === 'string' && p ? p : null, userData)));
  ipcMain.on(IPC_SAVE.chunk, (e, id: unknown, seq: unknown, text: unknown) => {
    saveStream(id, e.sender.id)?.append(seq as number, text as string);
  });
  ipcMain.handle(IPC_SAVE.commit, async (e, id: unknown, totals: io.SaveStreamTotals): Promise<SaveResult> => {
    const writer = saveStream(id, e.sender.id);
    // An autosave stream is only committed as an autosave (never turned into a project file, with recent / .bak).
    if (!writer || writer.kind !== 'project') return { ok: false, error: 'Could not save project: no such save in progress' };
    // Registered until the commit is done: pieces the commit message overtook still reach the writer.
    const res = await writer.commit(totals);
    saveStreams.delete(id as string);
    if (res.ok) await afterSave(res.path, writer.projectId());
    return res;
  });
  ipcMain.handle(IPC_SAVE.abort, async (e, id: unknown) => {
    const writer = saveStream(id, e.sender.id);
    if (!writer) return;
    saveStreams.delete(id as string);
    await writer.abort();
  });
  // The project is read, parsed and normalized once here and sent as JSON pieces (shared/projectWire.ts): no
  // structured clone of the whole project, and the renderer does not normalize it again.
  ipcMain.handle(IPC.projectLoad, async (_e, p: string): Promise<LoadReply> => {
    const res = await io.loadProjectFile(assertString(p, 'path'));
    if (!res.ok) return res;
    const recent = io.addRecentProject(userData, res.path); // prefs I/O overlaps the encoding below
    const { project, ...rest } = res;
    let reply: LoadReply;
    try { reply = { ...rest, projectWire: encodeProjectWire(project) }; } catch (e) { await recent.catch(() => undefined); throw e; }
    await recent;
    deps.onRecentChanged?.();
    return reply;
  });
  ipcMain.handle(IPC.projectAutosave, (_e, p: string | null, project: Project) => io.writeAutosave(typeof p === 'string' && p ? p : null, project, userData));
  // `json` is the autosave text, or an AutosaveStreamRef to commit the streamed autosave it names (the text was
  // sent in pieces after IPC_SAVE.autosaveBegin for the same project path).
  ipcMain.handle(IPC.projectAutosaveJson, async (e, p: string | null, json: unknown): Promise<SaveResult> => {
    const projectPath = typeof p === 'string' && p ? p : null;
    if (!isAutosaveStreamRef(json)) return io.writeAutosaveJson(projectPath, json as string, userData);
    const writer = saveStream(json.stream, e.sender.id);
    if (!writer || writer.kind !== 'autosave') return { ok: false, error: 'Autosave failed: no such autosave in progress' };
    if (io.autosavePathFor(projectPath, userData) !== writer.path) {
      saveStreams.delete(json.stream);
      await writer.abort();
      return { ok: false, error: 'Autosave failed: the autosave was started for another project' };
    }
    // Registered until the commit is done: pieces the commit message overtook still reach the writer.
    const res = await writer.commit({ chunks: json.chunks, chars: json.chars });
    saveStreams.delete(json.stream);
    return res;
  });
  ipcMain.handle(IPC.projectCheckRecovery, async (): Promise<RecoveryReply | null> => {
    const prefs = await io.readPrefs(userData);
    const info = await io.checkRecovery(userData, prefs.recentProjects);
    if (!info) return null;
    const { project, ...rest } = info;
    return { ...rest, projectName: project.name, projectWire: encodeProjectWire(project) };
  });
  ipcMain.handle(IPC.projectDiscardRecovery, (_e, p: string) => io.discardRecovery(assertString(p, 'autosavePath')));
  ipcMain.handle(IPC.projectRecent, () => io.existingRecentProjects(userData));

  // --- prefs ---
  ipcMain.handle(IPC.prefsGet, () => io.readPrefs(userData));
  ipcMain.handle(IPC.prefsSet, async (_e, patch: Partial<AppPreferences>) => {
    const before = await io.readPrefs(userData);
    const next = await io.updatePrefs(userData, patch ?? {});
    if (JSON.stringify(before.recentProjects) !== JSON.stringify(next.recentProjects)) deps.onRecentChanged?.();
    return next;
  });

  // --- fs ---
  ipcMain.handle(IPC.fsStat, (_e, p: string) => fsApi.stat(assertString(p, 'path')));
  ipcMain.handle(IPC.fsReadText, (_e, p: string) => fsApi.readText(assertString(p, 'path')));
  // No generic text write: the renderer can only write subtitle exports, checked here against the project's sources.
  ipcMain.handle(IPC.subtitlesExport, (_e, p: unknown, content: unknown, protectedPaths: unknown) =>
    fsApi.writeSubtitleFile(p as string, content as string, protectedPaths as string[]));
  ipcMain.handle(IPC.fsListDir, (_e, p: string) => fsApi.listDir(assertString(p, 'path')));
  ipcMain.handle(IPC.fsScanForRelink, (_e, req: RelinkScanRequest) => fsApi.scanForRelink(req));

  // --- media url (pure; preload also computes this synchronously) ---
  ipcMain.handle(IPC.mediaUrl, (_e, p: string) => pathToMediaUrl(assertString(p, 'path')));
}
