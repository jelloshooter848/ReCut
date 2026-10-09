// Development setup: makes sure a from-source checkout has what the release builds bundle, so `npm run dev` and
// `npm start` behave like an installed ReCut:
//   - FFmpeg (ffmpeg + ffprobe) in resources/ffmpeg, via scripts/<os>/get-ffmpeg.*
//   - the speech-to-text engine (whisper.cpp's whisper-cli) in resources/whisper, via scripts/<os>/get-whisper.*
// The app finds both there in development (working directory; see electron/media/ffmpeg.ts and
// electron/whisper/engine.ts). Each step is skipped when its files are already there, when the matching RECUT_* env
// variable points elsewhere, or (FFmpeg only) when ffmpeg and ffprobe are on PATH. A step that cannot run (missing
// build tools, unsupported platform) or fails prints what to do and does not stop the app from starting: ReCut then
// shows its usual "FFmpeg not found" / "engine not included" notices.
//
//   node scripts/setup-dev.mjs          (npm run setup; also run first by npm run dev and npm start)
//   RECUT_SKIP_SETUP=1 npm run dev      skip it
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const exe = (name) => (win ? `${name}.exe` : name);
const log = (msg) => console.log(`[setup] ${msg}`);
const jobs = String(Math.max(2, (os.availableParallelism?.() ?? os.cpus().length) - 1));

function onPath(cmd) {
  const r = spawnSync(win ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

/** The platform's script for `tool` ('ffmpeg' | 'whisper') as a command line, or a reason it cannot run here. */
function scriptFor(tool) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') {
    const args = ['--arch', arch, '--dest', path.join(root, 'resources', tool)];
    return { cmd: 'bash', args: [path.join(root, 'scripts', 'mac', `get-${tool}.sh`), ...args], env: { JOBS: jobs, NICE: '0' } };
  }
  if (process.platform === 'linux') {
    if (process.arch !== 'x64') return { reason: `scripts/linux/get-${tool}.sh supports x86-64 Linux only` };
    return { cmd: 'bash', args: [path.join(root, 'scripts', 'linux', `get-${tool}.sh`), '--dest', path.join(root, 'resources', tool)], env: { JOBS: jobs, NICE: '0' } };
  }
  if (win) {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'windows', `get-${tool}.ps1`), '-Dest', path.join(root, 'resources', tool)];
    if (tool === 'whisper') args.push('-Jobs', jobs);
    return { cmd: 'powershell', args };
  }
  return { reason: `no setup script for ${process.platform}` };
}

function run(tool, label, retry) {
  const s = scriptFor(tool);
  if (!s.cmd) { log(`Skipping ${label}: ${s.reason}.`); return; }
  log(`Getting ${label} (first run only)...`);
  const r = spawnSync(s.cmd, s.args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...s.env } });
  if (r.status === 0) log(`${label}: done.`);
  else log(`Could not get ${label} (exit ${r.status ?? r.error?.message}). ReCut still starts without it. Fix the error above and run: ${retry}`);
}

function setupFfmpeg() {
  if (process.env.RECUT_FFMPEG || process.env.RECUT_FFMPEG_PATH) return;
  const dir = path.join(root, 'resources', 'ffmpeg');
  if (existsSync(path.join(dir, exe('ffmpeg'))) && existsSync(path.join(dir, exe('ffprobe')))) return;
  if (onPath('ffmpeg') && onPath('ffprobe')) return;
  run('ffmpeg', 'FFmpeg', 'npm run setup');
}

function setupWhisper() {
  if (process.env.RECUT_WHISPER_CLI) return;
  if (existsSync(path.join(root, 'resources', 'whisper', exe('whisper-cli')))) return;
  // The engine is compiled from source; check the build tools first so a missing one costs no time.
  if (process.platform === 'darwin' && !onPath('cmake')) {
    log('Skipping the speech-to-text engine: it is compiled with cmake, which is not installed. Install it (brew install cmake), then run: npm run setup');
    return;
  }
  if (process.platform === 'linux' && !onPath('cmake') && !onPath('make')) {
    log('Skipping the speech-to-text engine: it needs cmake (or make) and a C++ compiler. Install them, then run: npm run setup');
    return;
  }
  run('whisper', 'the speech-to-text engine (whisper.cpp, a few minutes)', 'npm run setup');
}

if (process.env.RECUT_SKIP_SETUP) {
  log('RECUT_SKIP_SETUP is set; skipping FFmpeg and speech-to-text engine setup.');
} else {
  setupFfmpeg();
  setupWhisper();
}
