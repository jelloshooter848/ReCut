/**
 * Electron main process entry: app lifecycle, the single editor window, menu, protocol, IPC.
 *
 * Env:
 *  RECUT_DEV_URL   — load the Vite dev server instead of dist/renderer/index.html
 *  RECUT_USER_DATA — override the userData directory (tests)
 *  RECUT_SMOKE=1   — headless smoke test: probe the media protocol, log, quit after 2s
 *  RECUT_DISABLE_GPU=1 — software rendering (xvfb)
 */
import { app, BrowserWindow, net, protocol, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC, MEDIA_SCHEME } from '../shared/ipc';
import type { JobInfo } from '../shared/model';
import { registerIpc, registerMediaIpc, resolveCacheDir, resolveFfmpeg } from './ipc';
import { installMenu } from './menu';
import { registerMediaProtocol } from './media/protocol';
import { mediaHandlers } from './media/index';
import * as io from './project/io';
import { projectPathFromArgv } from './project/argv';
import os from 'node:os';
import { getFfmpegPath, getFfprobePath, getFfmpegVersion, runFfmpeg } from './media/ffmpeg';
import { probeMedia } from './media/probe';

const isDev = Boolean(process.env.RECUT_DEV_URL) || !app.isPackaged;
const smoke = process.env.RECUT_SMOKE === '1';
const QUIT_FALLBACK_MS = 3000;

// ------------------------------------------------------------------
// Pre-ready configuration
// ------------------------------------------------------------------

app.setName('ReCut'); // before any getPath('userData') so dev and packaged share a location
if (process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
if (process.env.RECUT_DISABLE_GPU === '1' || smoke) app.disableHardwareAcceleration();
if (process.env.RECUT_USER_DATA) app.setPath('userData', path.resolve(process.env.RECUT_USER_DATA));

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
  },
]);

export { projectPathFromArgv };

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

let win: BrowserWindow | null = null;
let pendingProjectPath: string | null = projectPathFromArgv(process.argv.slice(1));
let quitConfirmed = false;
let quitTimer: NodeJS.Timeout | null = null;
let menu: { refresh(): void } | null = null;

const userData = () => app.getPath('userData');

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

function sendMenu(command: string): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC.evMenu, command);
}

function openProjectPath(p: string): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send(IPC.evOpenProjectPath, p);
  } else {
    pendingProjectPath = p;
  }
}

// ------------------------------------------------------------------
// Quit flow: ask the renderer first (it may prompt to save).
// The renderer acks ev:beforeQuit immediately (quitAck), which cancels the 3 s fallback; the
// fallback only covers a hung renderer. It then confirms with quit(true) or stands down with
// quitCancel() (user chose Cancel, or the save failed).
// ------------------------------------------------------------------

let quitPending = false;

function clearQuitTimer(): void {
  if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; }
}

function requestQuit(force: boolean): void {
  if (force || quitConfirmed || !win || win.isDestroyed()) {
    quitConfirmed = true;
    quitPending = false;
    clearQuitTimer();
    app.quit();
    return;
  }
  if (quitPending) return; // already asked; the renderer is handling it
  quitPending = true;
  win.webContents.send(IPC.evBeforeQuit);
  quitTimer = setTimeout(() => {
    quitTimer = null;
    quitConfirmed = true;
    app.quit();
  }, QUIT_FALLBACK_MS);
}

/** The renderer received ev:beforeQuit and is handling it: no more force-quit fallback. */
function ackQuit(): void {
  clearQuitTimer();
}

/** The renderer decided to stay open. */
function cancelQuit(): void {
  clearQuitTimer();
  quitPending = false;
}

// ------------------------------------------------------------------
// Window
// ------------------------------------------------------------------

const MIN_W = 1200;
const MIN_H = 700;

interface SavedBounds { width: number; height: number; x?: number; y?: number }
function savedBounds(prefs: { layout?: Record<string, number> }): SavedBounds | null {
  const l = prefs.layout;
  if (!l || typeof l['window.width'] !== 'number' || typeof l['window.height'] !== 'number') return null;
  const out: SavedBounds = {
    width: Math.max(MIN_W, Math.round(l['window.width'])),
    height: Math.max(MIN_H, Math.round(l['window.height'])),
  };
  if (typeof l['window.x'] === 'number' && typeof l['window.y'] === 'number') {
    const r = { x: Math.round(l['window.x']), y: Math.round(l['window.y']), width: out.width, height: out.height };
    // Only trust the position if it lands on a current display.
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return r.x < a.x + a.width && r.x + r.width > a.x && r.y < a.y + a.height && r.y + r.height > a.y;
    });
    if (onScreen) { out.x = r.x; out.y = r.y; }
  }
  return out;
}

let boundsTimer: NodeJS.Timeout | null = null;
function rememberBounds(w: BrowserWindow, immediate = false): void {
  const write = async () => {
    boundsTimer = null;
    if (w.isDestroyed()) return;
    const maximized = w.isMaximized();
    const b = maximized ? w.getNormalBounds() : w.getBounds();
    const prefs = await io.readPrefs(userData());
    await io.updatePrefs(userData(), {
      layout: {
        ...(prefs.layout ?? {}),
        'window.x': b.x, 'window.y': b.y, 'window.width': b.width, 'window.height': b.height,
        'window.maximized': maximized ? 1 : 0,
      },
    });
  };
  if (boundsTimer) clearTimeout(boundsTimer);
  if (immediate) void write();
  else boundsTimer = setTimeout(() => void write(), 500);
}

/** Synchronous variant for the close path, where an async write would not finish before quit. */
function rememberBoundsSync(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  try {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    const maximized = w.isMaximized();
    const b = maximized ? w.getNormalBounds() : w.getBounds();
    const file = io.prefsPath(userData());
    let prefs = io.defaultPrefs();
    try { prefs = io.normalizePrefs(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* defaults */ }
    prefs.layout = {
      ...(prefs.layout ?? {}),
      'window.x': b.x, 'window.y': b.y, 'window.width': b.width, 'window.height': b.height,
      'window.maximized': maximized ? 1 : 0,
    };
    io.atomicWriteFileSync(file, JSON.stringify(prefs, null, 2)); // temp + rename: a crash never leaves half a prefs.json
  } catch (e) {
    console.error('could not save window bounds:', e);
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const prefs = await io.readPrefs(userData());
  const bounds = savedBounds(prefs);
  const workArea = screen.getPrimaryDisplay().workAreaSize;

  const w = new BrowserWindow({
    width: bounds?.width ?? Math.min(1600, Math.max(MIN_W, workArea.width - 80)),
    height: bounds?.height ?? Math.min(1000, Math.max(MIN_H, workArea.height - 80)),
    x: bounds?.x,
    y: bounds?.y,
    minWidth: MIN_W,
    minHeight: MIN_H,
    backgroundColor: '#1e1e1e',
    title: 'ReCut',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win = w;

  if (prefs.layout?.['window.maximized'] === 1) w.maximize();
  w.once('ready-to-show', () => w.show());
  w.on('resize', () => rememberBounds(w));
  w.on('move', () => rememberBounds(w));
  w.on('maximize', () => rememberBounds(w));
  w.on('unmaximize', () => rememberBounds(w));

  // Closing the window is a quit on every platform except macOS; route it through the quit flow.
  w.on('close', (e) => {
    rememberBoundsSync(w);
    if (quitConfirmed) return;
    e.preventDefault();
    requestQuit(false);
  });
  w.on('closed', () => { if (win === w) win = null; });

  // Keep the renderer inside the app: no in-window navigation, external links go to the browser.
  const allowedOrigin = process.env.RECUT_DEV_URL ? new URL(process.env.RECUT_DEV_URL).origin : null;
  w.webContents.on('will-navigate', (e, url) => {
    if (allowedOrigin && url.startsWith(allowedOrigin)) return;
    if (url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  w.webContents.on('did-finish-load', () => {
    if (pendingProjectPath) {
      const p = pendingProjectPath;
      pendingProjectPath = null;
      w.webContents.send(IPC.evOpenProjectPath, p);
    }
  });

  if (process.env.RECUT_DEV_URL) {
    await w.loadURL(process.env.RECUT_DEV_URL);
  } else {
    await w.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return w;
}

// ------------------------------------------------------------------
// Smoke test (RECUT_SMOKE=1): verify the media protocol serves ranges, then quit.
// ------------------------------------------------------------------

async function runSmoke(): Promise<void> {
  // Results go to stdout and, when RECUT_SMOKE_OUT is set, to that file (Windows GUI apps have no attached console).
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); console.log(line); };
  const target = process.env.RECUT_SMOKE_FILE || (process.platform === 'win32' ? process.execPath : '/usr/bin/ffmpeg');
  const url = `${MEDIA_SCHEME}://local/${encodeURIComponent(target)}`;
  try {
    const res = await net.fetch(url, { headers: { Range: 'bytes=10-19' } });
    const body = new Uint8Array(await res.arrayBuffer());
    log(`smoke: protocol status=${res.status} content-length=${res.headers.get('content-length')} content-range=${res.headers.get('content-range')} body-bytes=${body.byteLength} type=${res.headers.get('content-type')}`);
    const head = await net.fetch(url, { method: 'HEAD' });
    log(`smoke: HEAD status=${head.status} content-length=${head.headers.get('content-length')} accept-ranges=${head.headers.get('accept-ranges')}`);
    const missing = await net.fetch(`${MEDIA_SCHEME}://local/${encodeURIComponent('/definitely/not/here.mp4')}`);
    log(`smoke: missing status=${missing.status}`);
    const bad = await net.fetch(url, { headers: { Range: 'bytes=99999999999-' } });
    log(`smoke: unsatisfiable status=${bad.status} content-range=${bad.headers.get('content-range')}`);
  } catch (e) {
    log(`smoke: protocol fetch FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
  // FFmpeg: resolved paths, version, and a real encode + probe of a generated clip.
  try {
    log(`smoke: ffmpeg path=${getFfmpegPath()} ffprobe path=${getFfprobePath()} version=${await getFfmpegVersion()}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-smoke-'));
    const clip = path.join(tmp, 'smoke clip.mp4');
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]).promise;
    const probe = await probeMedia(clip);
    log(`smoke: ffmpeg encode+probe ok duration=${probe.duration.toFixed(2)} video=${probe.video?.codec} ${probe.video?.width}x${probe.video?.height} audio=${probe.audio[0]?.codec ?? 'none'} browserPlayable=${probe.browserPlayable}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    log(`smoke: ffmpeg FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Renderer: did the React app mount its layout?
  try {
    const mounted = win && !win.isDestroyed()
      ? await win.webContents.executeJavaScript(`new Promise((r) => { let n = 0; const t = setInterval(() => { if (document.querySelector('#root .layout') || ++n > 100) { clearInterval(t); r(!!document.querySelector('#root .layout')); } }, 100); })`)
      : false;
    log(`smoke: window loaded=${win && !win.isDestroyed() ? win.webContents.getURL() : 'none'} layout=${mounted ? 'mounted' : 'MISSING'}`);
  } catch (e) {
    log(`smoke: renderer check FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = process.env.RECUT_SMOKE_OUT;
  if (out) { try { fs.writeFileSync(out, lines.join('\n') + '\n'); } catch { /* ignore */ } }
  setTimeout(() => requestQuit(true), 1000);
}

// ------------------------------------------------------------------
// App lifecycle
// ------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const p = projectPathFromArgv(argv.slice(1), workingDirectory || undefined);
    if (p) openProjectPath(p);
    else if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.on('open-file', (e, p) => { e.preventDefault(); openProjectPath(p); }); // macOS

  app.on('before-quit', (e) => {
    if (quitConfirmed) return;
    e.preventDefault();
    requestQuit(false);
  });

  app.on('will-quit', () => {
    void mediaHandlers.shutdown?.();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') requestQuit(true);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) void createWindow();
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  void app.whenReady().then(async () => {
    registerMediaProtocol();

    const ud = userData();
    registerIpc({
      getWindow: () => win,
      requestQuit,
      ackQuit,
      cancelQuit,
      userData: ud,
      isDev,
      onRecentChanged: () => menu?.refresh(),
    });

    const cacheDir = await resolveCacheDir(ud);
    const ff = resolveFfmpeg();
    try {
      await mediaHandlers.init?.({ userData: ud, cacheDir, ffmpegPath: ff.ffmpegPath, ffprobePath: ff.ffprobePath, broadcast });
    } catch (e) {
      console.error('media init failed:', e);
    }
    registerMediaIpc(mediaHandlers);
    mediaHandlers.onJobsUpdate((jobs: JobInfo[]) => broadcast(IPC.evJobs, jobs));

    let recentCache: string[] = (await io.readPrefs(ud)).recentProjects;
    const installed = installMenu({
      send: sendMenu,
      openProjectPath,
      getRecent: () => recentCache,
      requestQuit: () => requestQuit(false),
      isDev,
    });
    menu = {
      refresh: () => {
        void io.readPrefs(ud).then((p) => { recentCache = p.recentProjects; installed.refresh(); });
      },
    };

    await createWindow();

    if (smoke) void runSmoke();
  });
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main process:', reason);
});
