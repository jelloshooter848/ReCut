/**
 * Thin wrapper around the ffmpeg / ffprobe binaries.
 *
 * - Resolves binary locations (env → bundled resources → PATH).
 * - `runFfmpeg` spawns ffmpeg with progress reporting, cancellation and readable errors.
 * - `runFfprobeJson` runs ffprobe and parses its JSON output.
 *
 * No Electron imports here so unit tests can exercise it directly under Node.
 */
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegMissingMessage } from '../../shared/ipc';

export type FfBinary = 'ffmpeg' | 'ffprobe';

const resolved: Partial<Record<FfBinary, string | null>> = {};

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function exeNames(name: FfBinary): string[] {
  if (process.platform !== 'win32') return [name];
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  return [name, ...exts.map((e) => name + e.toLowerCase()), ...exts.map((e) => name + e)];
}

/** Directories that may contain a bundled ffmpeg (`resources/ffmpeg` next to the app). */
function bundledDirs(): string[] {
  const dirs: string[] = [];
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (rp) dirs.push(path.join(rp, 'ffmpeg'), rp);
  const execDir = path.dirname(process.execPath);
  dirs.push(path.join(execDir, 'resources', 'ffmpeg'), path.join(execDir, 'resources'));
  dirs.push(path.join(process.cwd(), 'resources', 'ffmpeg'));
  return dirs;
}

function whichSync(name: FfBinary): string | null {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = (process.env.PATH ?? '').split(sep).filter(Boolean);
  // GUI launches (macOS Finder, desktop files) often get a minimal PATH: also look in the usual install folders.
  if (process.platform !== 'win32') dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin');
  for (const dir of dirs) {
    for (const file of exeNames(name)) {
      const full = path.join(dir, file);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve the path to ffmpeg or ffprobe. The single resolver for the whole app (media services, export,
 * About / Preferences). Order:
 *   1. env RECUT_FFMPEG / RECUT_FFPROBE (or RECUT_FFMPEG_PATH / RECUT_FFPROBE_PATH)
 *   2. bundled `<process.resourcesPath>/ffmpeg/<name>(.exe)` (electron-builder extraResources), then
 *      `resources/ffmpeg` next to the executable / in the working directory (dev)
 *   3. PATH, then /usr/local/bin, /usr/bin, /opt/homebrew/bin, /snap/bin
 * Returns null when not found. Result is cached; call `resetFfmpegPaths()` to re-resolve.
 */
export function resolveBinary(name: FfBinary): string | null {
  if (name in resolved) return resolved[name] ?? null;
  const envVar = name === 'ffmpeg'
    ? (process.env.RECUT_FFMPEG || process.env.RECUT_FFMPEG_PATH)
    : (process.env.RECUT_FFPROBE || process.env.RECUT_FFPROBE_PATH);
  let found: string | null = null;
  if (envVar && isExecutable(envVar)) found = envVar;
  if (!found) {
    outer: for (const dir of bundledDirs()) {
      for (const file of exeNames(name)) {
        const full = path.join(dir, file);
        if (isExecutable(full)) { found = full; break outer; }
      }
    }
  }
  if (!found) found = whichSync(name);
  resolved[name] = found;
  return found;
}

export function getFfmpegPath(): string | null { return resolveBinary('ffmpeg'); }
export function getFfprobePath(): string | null { return resolveBinary('ffprobe'); }
export function resetFfmpegPaths(): void { delete resolved.ffmpeg; delete resolved.ffprobe; }

/** Override the resolved binaries (e.g. from app preferences). Pass null to fall back to auto-resolution. */
export function setFfmpegPaths(paths: { ffmpeg?: string | null; ffprobe?: string | null }): void {
  if (paths.ffmpeg !== undefined) {
    if (paths.ffmpeg && isExecutable(paths.ffmpeg)) resolved.ffmpeg = paths.ffmpeg; else delete resolved.ffmpeg;
  }
  if (paths.ffprobe !== undefined) {
    if (paths.ffprobe && isExecutable(paths.ffprobe)) resolved.ffprobe = paths.ffprobe; else delete resolved.ffprobe;
  }
}

/** Returns e.g. "6.1.1-3ubuntu5" or null when ffmpeg is missing. */
export function getFfmpegVersion(): Promise<string | null> {
  const bin = getFfmpegPath();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /ffmpeg version (\S+)/.exec(String(stdout));
      resolve(m ? m[1] : String(stdout).split('\n')[0] || null);
    });
  });
}

/**
 * Major version from an `ffmpeg -version` banner: "6.1.1-3ubuntu5" -> 6, "9.0.2-essentials_build" -> 9,
 * "n7.1-12-g…" -> 7. Git master builds ("N-118000-g…", "git-2025-…") are treated as current (99). Unknown -> 0.
 */
export function parseFfmpegMajor(versionLine: string): number {
  const m = /ffmpeg version\s+(\S+)/.exec(versionLine);
  const v = m ? m[1] : versionLine.trim();
  if (/^(N-|git-)/i.test(v)) return 99;
  const n = /^n?(\d+)\./.exec(v);
  return n ? parseInt(n[1], 10) : 0;
}

const majorCache = new Map<string, number>();
/** FFmpeg major version of `bin` (cached; one short synchronous `-version` call per binary). */
export function ffmpegMajorVersionSync(bin: string): number {
  const hit = majorCache.get(bin);
  if (hit !== undefined) return hit;
  let major = 0;
  try {
    const out = execFileSync(bin, ['-hide_banner', '-version'], { timeout: 10_000, windowsHide: true }).toString();
    major = parseFfmpegMajor(out.split(/\r?\n/)[0] ?? '');
  } catch { major = 0; }
  majorCache.set(bin, major);
  return major;
}

/**
 * Adapt argument spellings that changed between FFmpeg versions. `-filter_complex_script <file>` was deprecated in 7.0
 * (replaced by `-/filter_complex <file>`) and removed in 8; `-/filter_complex` does not exist before 7.
 */
export function adaptFfmpegArgs(args: string[], major: number): string[] {
  if (major < 7) return args;
  return args.map((a) => (a === '-filter_complex_script' ? '-/filter_complex' : a === '-filter_script' ? '-/filter' : a));
}

// ------------------------------------------------------------------
// runFfmpeg
// ------------------------------------------------------------------

export class FfmpegError extends Error {
  code: number | null;
  signal: NodeJS.Signals | null;
  canceled: boolean;
  stderr: string;
  constructor(message: string, opts: { code?: number | null; signal?: NodeJS.Signals | null; canceled?: boolean; stderr?: string }) {
    super(message);
    this.name = 'FfmpegError';
    this.code = opts.code ?? null;
    this.signal = opts.signal ?? null;
    this.canceled = opts.canceled ?? false;
    this.stderr = opts.stderr ?? '';
  }
}

export interface FfmpegProgress {
  /** Output time in seconds. */
  outTime: number;
  frame?: number;
  fps?: number;
  speed?: number;
  /** 0..1 when `duration` was provided, otherwise undefined. */
  fraction?: number;
}

export interface RunFfmpegOptions {
  /** Expected output duration in seconds; enables 0..1 progress. */
  duration?: number;
  onProgress?: (progress: number, info: FfmpegProgress) => void;
  /**
   * 'progress' (default): stdout carries `-progress` key/value lines.
   * 'data': stdout carries output data (e.g. `-f u8 -`); progress goes to fd 3 where supported.
   * 'ignore': stdout is discarded and no progress is requested.
   */
  stdout?: 'progress' | 'data' | 'ignore';
  /** Streaming stdout chunks (only in 'data' mode). */
  onStdout?: (chunk: Buffer) => void;
  /** Collect stdout into the result (only in 'data' mode). Default false. */
  collectStdout?: boolean;
  /** Called per stderr line (useful for filters like showinfo). */
  onStderrLine?: (line: string) => void;
  /** ffmpeg -loglevel. Default 'error'. */
  loglevel?: string;
  /** Maximum number of stderr lines kept for error reporting. Default 200. */
  stderrLines?: number;
  signal?: AbortSignal;
  cwd?: string;
}

export interface FfmpegResult {
  code: number;
  stderr: string;
  stdout?: Buffer;
}

export interface FfmpegRun {
  promise: Promise<FfmpegResult>;
  /** Kill the process (SIGKILL). The promise rejects with FfmpegError{canceled:true}. */
  cancel(): void;
  child: ChildProcess | null;
  args: string[];
}

function parseOutTime(key: string, value: string): number | null {
  const v = value.trim();
  if (key === 'out_time_us') {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n / 1e6 : null;
  }
  if (key === 'out_time_ms') {
    // ffmpeg (≤7.x) actually reports microseconds here despite the name.
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n / 1e6 : null;
  }
  if (key === 'out_time') {
    const m = /^(-?)(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(v);
    if (!m) return null;
    if (m[1] === '-') return null;
    return Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  }
  return null;
}

/** Split a stream of bytes into lines, invoking `onLine` for each complete line. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer | string): void; flush(): void } {
  let rest = '';
  return {
    push(chunk) {
      rest += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = rest.search(/[\r\n]/)) >= 0) {
        const line = rest.slice(0, idx);
        rest = rest.slice(idx + 1);
        if (line.length) onLine(line);
      }
    },
    flush() {
      if (rest.length) onLine(rest);
      rest = '';
    },
  };
}

/**
 * Spawn ffmpeg with `-hide_banner -nostdin -y -loglevel <lvl>` plus progress reporting.
 * Resolves on exit code 0; rejects with a FfmpegError carrying the last stderr lines otherwise.
 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): FfmpegRun {
  const bin = getFfmpegPath();
  const stdoutMode = opts.stdout ?? 'progress';
  const loglevel = opts.loglevel ?? 'error';
  const maxLines = opts.stderrLines ?? 200;

  const baseArgs = ['-hide_banner', '-nostdin', '-y', '-loglevel', loglevel];
  let stdio: ('ignore' | 'pipe')[] = ['ignore', 'pipe', 'pipe'];
  let progressFd: number | null = null;
  if (stdoutMode === 'progress') {
    baseArgs.push('-progress', 'pipe:1', '-nostats');
    progressFd = 1;
  } else if (stdoutMode === 'data') {
    baseArgs.push('-nostats');
    if (process.platform !== 'win32') {
      baseArgs.push('-progress', 'pipe:3');
      stdio = ['ignore', 'pipe', 'pipe', 'pipe'];
      progressFd = 3;
    }
  } else {
    baseArgs.push('-nostats');
    stdio = ['ignore', 'ignore', 'pipe'];
  }
  const fullArgs = [...baseArgs, ...args];

  if (!bin) {
    return {
      promise: Promise.reject(new FfmpegError(ffmpegMissingMessage('ffmpeg'), {})),
      cancel() {},
      child: null,
      args: fullArgs,
    };
  }

  let canceled = false;
  let child: ChildProcess;
  try {
    child = spawn(bin, fullArgs, { stdio, cwd: opts.cwd, windowsHide: true });
  } catch (e) {
    return {
      promise: Promise.reject(new FfmpegError(`failed to spawn ffmpeg: ${(e as Error).message}`, {})),
      cancel() {},
      child: null,
      args: fullArgs,
    };
  }

  const stderrRing: string[] = [];
  const stderrSplit = lineSplitter((line) => {
    stderrRing.push(line);
    if (stderrRing.length > maxLines) stderrRing.shift();
    opts.onStderrLine?.(line);
  });

  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;

  const progressState: FfmpegProgress = { outTime: 0 };
  let lastReported = -1;
  const progressSplit = lineSplitter((line) => {
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'out_time_us' || key === 'out_time_ms' || key === 'out_time') {
      const t = parseOutTime(key, value);
      if (t !== null && t > progressState.outTime) progressState.outTime = t;
    } else if (key === 'frame') {
      progressState.frame = Number(value) || 0;
    } else if (key === 'fps') {
      progressState.fps = Number(value) || 0;
    } else if (key === 'speed') {
      const n = parseFloat(value.replace(/x$/, ''));
      if (Number.isFinite(n)) progressState.speed = n;
    } else if (key === 'progress') {
      // 'continue' | 'end' — emit one update per block
      if (opts.duration && opts.duration > 0) {
        let frac = progressState.outTime / opts.duration;
        if (value === 'end') frac = 1;
        frac = Math.max(0, Math.min(1, frac));
        progressState.fraction = frac;
        if (frac !== lastReported) {
          lastReported = frac;
          opts.onProgress?.(frac, { ...progressState });
        }
      } else {
        opts.onProgress?.(value === 'end' ? 1 : 0, { ...progressState });
      }
    }
  });

  child.stderr?.on('data', (c: Buffer) => stderrSplit.push(c));

  if (stdoutMode === 'progress') {
    child.stdout?.on('data', (c: Buffer) => progressSplit.push(c));
  } else if (stdoutMode === 'data') {
    child.stdout?.on('data', (c: Buffer) => {
      opts.onStdout?.(c);
      if (opts.collectStdout) { stdoutChunks.push(c); stdoutBytes += c.length; }
    });
    if (progressFd === 3) {
      const fd3 = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
      fd3?.on('data', (c: Buffer) => progressSplit.push(c));
    }
  }

  const cancel = () => {
    if (canceled) return;
    canceled = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) cancel();
    else opts.signal.addEventListener('abort', cancel, { once: true });
  }

  const promise = new Promise<FfmpegResult>((resolve, reject) => {
    let spawnError: Error | null = null;
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code, signal) => {
      stderrSplit.flush();
      progressSplit.flush();
      opts.signal?.removeEventListener('abort', cancel);
      const stderr = stderrRing.join('\n');
      if (canceled) {
        reject(new FfmpegError('ffmpeg canceled', { code, signal, canceled: true, stderr }));
        return;
      }
      if (spawnError) {
        reject(new FfmpegError(`failed to run ffmpeg: ${spawnError.message}`, { code, signal, stderr }));
        return;
      }
      if (code === 0) {
        resolve({ code: 0, stderr, stdout: opts.collectStdout ? Buffer.concat(stdoutChunks, stdoutBytes) : undefined });
        return;
      }
      const tail = stderrRing.slice(-20).join('\n').trim();
      const what = code !== null ? `exited with code ${code}` : `was killed by ${signal ?? 'signal'}`;
      reject(new FfmpegError(`ffmpeg ${what}${tail ? `:\n${tail}` : ''}`, { code, signal, stderr }));
    });
  });

  return { promise, cancel, child, args: fullArgs };
}

// ------------------------------------------------------------------
// ffprobe
// ------------------------------------------------------------------

/** Run ffprobe with `-v error -print_format json` prepended and parse stdout as JSON. */
export function runFfprobeJson<T = unknown>(args: string[], opts: { timeoutMs?: number } = {}): Promise<T> {
  const bin = getFfprobePath();
  if (!bin) return Promise.reject(new FfmpegError(ffmpegMissingMessage('ffprobe'), {}));
  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, ['-v', 'error', '-print_format', 'json', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const errLines: string[] = [];
    const errSplit = lineSplitter((l) => { errLines.push(l); if (errLines.length > 50) errLines.shift(); });
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => errSplit.push(c));
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, opts.timeoutMs);
      timer.unref();
    }
    let spawnError: Error | null = null;
    child.on('error', (e) => { spawnError = e; });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      errSplit.flush();
      const stderr = errLines.join('\n');
      if (spawnError) return reject(new FfmpegError(`failed to run ffprobe: ${spawnError.message}`, { stderr }));
      const text = Buffer.concat(out).toString('utf8');
      if (code !== 0) {
        const tail = errLines.slice(-20).join('\n').trim();
        return reject(new FfmpegError(`ffprobe ${code !== null ? `exited with code ${code}` : `killed by ${signal}`}${tail ? `:\n${tail}` : ''}`, { code, signal, stderr }));
      }
      try {
        resolve(JSON.parse(text || '{}') as T);
      } catch (e) {
        reject(new FfmpegError(`ffprobe produced invalid JSON: ${(e as Error).message}`, { code, stderr }));
      }
    });
  });
}

/** Convenience: format a seconds value for `-ss` / `-t` arguments. */
export function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return sec.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
