/**
 * The bundled speech-to-text engine: where `whisper-cli` is, its version, how ReCut runs it and how a run is
 * stopped. No Electron import (unit-testable).
 *
 * Resolution order: env RECUT_WHISPER_CLI (tests, developers), then the bundled `<resources>/whisper/whisper-cli(.exe)`
 * (electron-builder extraResources, built by scripts/<platform>/get-whisper.*), then `resources/whisper` next to the
 * executable or in the working directory (development). The engine is never looked up on PATH: ReCut runs only the
 * build it ships.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WHISPER_CLI_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';

let resolved: string | null | undefined;

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

/** Folders that may hold the bundled engine. */
export function whisperBundledDirs(): string[] {
  const dirs: string[] = [];
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (rp) dirs.push(path.join(rp, 'whisper'));
  dirs.push(path.join(path.dirname(process.execPath), 'resources', 'whisper'));
  dirs.push(path.join(process.cwd(), 'resources', 'whisper'));
  return dirs;
}

/** Path of whisper-cli, or null when this build has none. Cached; `resetWhisperCliPath()` re-resolves. */
export function getWhisperCliPath(): string | null {
  if (resolved !== undefined) return resolved;
  const env = process.env.RECUT_WHISPER_CLI;
  let found: string | null = null;
  if (env && isExecutable(env)) found = env;
  if (!found) {
    for (const dir of whisperBundledDirs()) {
      const p = path.join(dir, WHISPER_CLI_NAME);
      if (isExecutable(p)) { found = p; break; }
    }
  }
  resolved = found;
  return found;
}

export function resetWhisperCliPath(): void { resolved = undefined; }

/** "1.9.5" from `whisper-cli --version` output ("whisper.cpp version: 1.9.5"), or null. */
export function parseWhisperVersion(out: string): string | null {
  const m = /whisper\.cpp version:\s*(\S+)/.exec(out);
  return m ? m[1] : null;
}

/** Run `whisper-cli --version` (no model needed). Rejects with a readable error when it does not run. */
export function whisperCliVersion(bin = getWhisperCliPath()): Promise<string> {
  if (!bin) return Promise.reject(new Error('The speech-to-text engine (whisper-cli) is not included in this build of ReCut.'));
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { timeout: 20_000, windowsHide: true, cwd: path.dirname(bin) }, (err, stdout, stderr) => {
      const v = parseWhisperVersion(`${stdout}\n${stderr}`);
      if (v) return resolve(v);
      reject(new Error(`whisper-cli did not start: ${err ? err.message : (String(stderr || stdout).trim().split(/\r?\n/).pop() ?? 'no output')}`));
    });
  });
}

/** Threads whisper-cli uses: every core but one (at least 1), so the editor stays responsive. */
export function whisperThreads(cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length): number {
  return Math.max(1, Math.floor(cores) - 1);
}

/**
 * Stop a child process and anything it started: `taskkill /T /F` on Windows (the whole tree), SIGKILL on the process
 * (and its process group when it leads one) elsewhere. whisper-cli and FFmpeg start no children of their own, so this
 * is belt and braces. Never throws.
 */
export function killTree(child: ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch { /* ignore */ } });
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}
