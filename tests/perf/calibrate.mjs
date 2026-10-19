#!/usr/bin/env node
/**
 * Host calibration for the performance gate (docs/DEVELOPMENT.md → Performance gate → Calibration).
 *
 * A short fixed benchmark that says how fast this machine is, so perf-check.mjs can compare a run on one host with a
 * baseline recorded on another (bugs/closed/2026-10-07-perf-gate-verdict-not-reproducible.md @ 59eafc6: hosts of the same
 * nominal class differed 1.5-2.3x on identical code). Three scores, each the median wall time in ms of a fixed
 * workload (lower = faster), after a warm-up:
 *
 *   js      pure JavaScript shaped like store / timeline work: a 9,000-clip sequence, copy-on-write ripple edits,
 *           binary search, Map index, filter / sort, JSON.stringify / parse, structuredClone, substring search.
 *           Runs in this Node process (perf-check starts it with --expose-gc: a GC before each sample).
 *   ffmpeg  one small fixed FFmpeg encode (testsrc2 1280x720, 1.5 s, libx264 veryfast, one thread, to null).
 *   render  inside Electron with software rendering (as the Electron bench runs): style + layout of 1,500
 *           absolutely positioned clip-like divs, forced synchronously, plus a 2D canvas raster (Skia on the CPU,
 *           what painting costs under software GL), flushed with getImageData. Needs a display (xvfb on Linux).
 *
 * Each score reports its own spread ((max - min) / median of the repeats, and the interquartile range / median). An
 * interquartile spread over SPREAD_WARN means the host was not quiet while it was measured, and the calibration is
 * printed with a warning.
 *
 *   node tests/perf/calibrate.mjs [--json <file>] [--no-render] [--no-ffmpeg]
 *
 * perf-check.mjs imports calibrate() and writes the result as calibration.json into each run's result folder.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CALIBRATION_VERSION = 1;
export const SPREAD_WARN = 0.15;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const r2 = (v) => Math.round(v * 100) / 100;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Summary of repeated timings: median (the score), min, max, spread. */
/**
 * Summary of repeated timings: median (the score), min, max, spread = (max - min) / median, and iqr = interquartile
 * range / median. A single outlier (another process woke up) widens `spread` but not `iqr`; the NOISY warning uses
 * `iqr`.
 */
export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const m = median(s);
  const q = (p) => { const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo); };
  return { median: r2(m), min: r2(s[0]), max: r2(s[s.length - 1]), spread: r2((s[s.length - 1] - s[0]) / m), iqr: r2((q(0.75) - q(0.25)) / m), samples: samples.map(r2) };
}

// ---------------------------------------------------------------- js
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/** One fixed pure-JS workload; returns a checksum (identical on every host, so the work is identical too). */
export function jsWorkload() {
  const r = rng(42);
  const tracks = [];
  for (let t = 0; t < 6; t++) {
    const clips = []; let at = 0;
    for (let i = 0; i < 1500; i++) {
      const d = 24 + Math.floor(r() * 200);
      clips.push({ id: `c${t}_${i}`, mediaId: `m${i % 60}`, kind: t < 3 ? 'video' : 'audio', start: at, duration: d, sourceIn: r2(r() * 3600), speed: 1, enabled: true, linkId: `l${i}`, tags: [`t${i % 7}`], transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } });
      at += d + (i % 5 === 0 ? 12 : 0);
    }
    tracks.push({ id: `tr${t}`, clips });
  }
  let check = 0;
  // Ripple edits, copy-on-write like an immer commit: find the cut, keep the clips before it, copy the rest shifted.
  for (let e = 0; e < 60; e++) {
    const at = Math.floor(r() * 150000);
    for (let t = 0; t < tracks.length; t++) {
      const tr = tracks[t];
      let lo = 0, hi = tr.clips.length;
      while (lo < hi) { const m = (lo + hi) >> 1; const c = tr.clips[m]; if (c.start + c.duration <= at) lo = m + 1; else hi = m; }
      const clips = tr.clips.slice(0, lo);
      for (let i = lo; i < tr.clips.length; i++) { const c = tr.clips[i]; clips.push({ ...c, start: c.start + 10 }); }
      tracks[t] = { ...tr, clips };
    }
  }
  // Index, lookups, visible-window filter and sort.
  const byId = new Map();
  for (const tr of tracks) for (const c of tr.clips) byId.set(c.id, c);
  for (let i = 0; i < 40000; i++) check += byId.get(`c${i % 6}_${(i * 7) % 1500}`).start % 7;
  for (let w = 0; w < 20; w++) {
    const from = w * 5000, to = from + 20000;
    const visible = tracks.flatMap((tr) => tr.clips.filter((c) => c.start < to && c.start + c.duration > from)).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    check += visible.length;
  }
  // Save / open / IPC: serialize, parse, clone.
  const json = JSON.stringify({ tracks });
  const back = JSON.parse(json);
  const clone = structuredClone(back);
  check += json.length % 1000 + back.tracks.length + clone.tracks[5].clips.length;
  // Search keystrokes: substring match over every id.
  const names = [...byId.keys()];
  for (let q = 0; q < 20; q++) { const needle = `_${q * 3}`; for (const n of names) if (n.includes(needle)) check++; }
  return check;
}

/** Each sample runs the workload `per` times (ms per workload); a GC before each sample when --expose-gc is on. */
export function measureJs({ warmup = 3, reps = 11, per = 3 } = {}) {
  let check = 0;
  for (let i = 0; i < warmup; i++) check = jsWorkload();
  const samples = [];
  for (let i = 0; i < reps; i++) {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const t = performance.now();
    for (let k = 0; k < per; k++) { const c = jsWorkload(); if (c !== check) throw new Error(`calibration js workload is not deterministic (${c} != ${check})`); }
    samples.push((performance.now() - t) / per);
  }
  return { ...summarize(samples), checksum: check };
}

// ---------------------------------------------------------------- ffmpeg
/**
 * One thread: a multi-threaded encode on a 4-vCPU container varied +-15 % between repeats (scheduling), one thread
 * +-2 %. The perf rows run FFmpeg multi-threaded, so this measures per-core speed; hosts of the class the gate runs
 * on have the same core count.
 */
export const FFMPEG_ARGS = ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-t', '1.5', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '1', '-f', 'null', '-'];

export function measureFfmpeg({ ffmpeg = process.env.RECUT_FFMPEG || 'ffmpeg', warmup = 2, reps = 9 } = {}) {
  const once = () => {
    const t = performance.now();
    const r = spawnSync(ffmpeg, FFMPEG_ARGS, { encoding: 'utf8' });
    const ms = performance.now() - t;
    if (r.status !== 0) throw new Error(`calibration ffmpeg failed (${r.error?.message ?? r.status}): ${(r.stderr ?? '').slice(-300)}`);
    return ms;
  };
  for (let i = 0; i < warmup; i++) once();
  const samples = [];
  for (let i = 0; i < reps; i++) samples.push(once());
  return summarize(samples);
}

// ---------------------------------------------------------------- render (Electron)
const RENDER_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
window.bench = (reps) => {
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:1600px;height:720px;overflow:hidden;font:12px sans-serif';
  document.body.appendChild(root);
  const els = [];
  for (let i = 0; i < 1500; i++) {
    const d = document.createElement('div'); d.textContent = 'Clip ' + i + ' scene ' + (i % 37);
    d.style.cssText = 'position:absolute;top:' + ((i % 12) * 60) + 'px;height:56px;border:1px solid #888;background:hsl(' + (i % 360) + ',40%,40%);white-space:nowrap;overflow:hidden;color:#eee';
    root.appendChild(d); els.push(d);
  }
  const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 400; document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const one = (k) => {
    for (let i = 0; i < els.length; i++) { const e = els[i]; e.style.left = ((i * 37 + k * 13) % 1600) + 'px'; e.style.width = (40 + ((i + k) % 200)) + 'px'; }
    let s = 0;
    for (let i = 0; i < els.length; i += 25) s += els[i].offsetLeft + els[i].getBoundingClientRect().width;
    ctx.clearRect(0, 0, 1600, 400);
    for (let i = 0; i < 4000; i++) { ctx.fillStyle = 'hsl(' + ((i + k) % 360) + ',50%,50%)'; ctx.fillRect((i * 7) % 1600, (i * 13) % 400, 30, 2 + (i % 40)); }
    ctx.font = '12px sans-serif'; for (let i = 0; i < 200; i++) ctx.fillText('label ' + i + ' ' + k, (i * 53) % 1500, (i * 17) % 390 + 10);
    s += ctx.getImageData((k * 31) % 1600, (k * 7) % 400, 1, 1).data[0];
    return s;
  };
  for (let w = 0; w < 10; w++) one(w);
  const out = [];
  for (let r = 0; r < reps; r++) { const t = performance.now(); for (let k = 0; k < 10; k++) one(r * 10 + k); out.push(performance.now() - t); }
  return out;
};
</script>`;

const RENDER_MAIN = `
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({ width: 1600, height: 1000, show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false, sandbox: false } });
    await w.loadFile(process.env.RECUT_CALIB_PAGE);
    const samples = await w.webContents.executeJavaScript('bench(' + Number(process.env.RECUT_CALIB_REPS) + ')');
    process.stdout.write('RECUT_CALIB ' + JSON.stringify(samples) + '\\n');
    app.exit(0);
  } catch (e) { process.stderr.write(String(e && e.stack || e) + '\\n'); app.exit(1); }
});
`;

export async function measureRender({ reps = 9, timeoutMs = 120_000 } = {}) {
  const require = (await import('node:module')).createRequire(import.meta.url);
  const electronBin = require('electron');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-calib-'));
  try {
    fs.writeFileSync(path.join(dir, 'main.cjs'), RENDER_MAIN);
    fs.writeFileSync(path.join(dir, 'page.html'), RENDER_PAGE);
    const needX = process.platform === 'linux' && !process.env.DISPLAY;
    const [cmd, args] = needX ? ['xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', electronBin, path.join(dir, 'main.cjs'), '--no-sandbox']] : [electronBin, [path.join(dir, 'main.cjs'), '--no-sandbox']];
    const out = await new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd: dir, env: { ...process.env, RECUT_CALIB_PAGE: path.join(dir, 'page.html'), RECUT_CALIB_REPS: String(reps), ELECTRON_ENABLE_LOGGING: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '', se = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('calibration render: timed out')); }, timeoutMs);
      p.stdout.on('data', (d) => { so += d; }); p.stderr.on('data', (d) => { se += d; });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => { clearTimeout(timer); const m = so.match(/RECUT_CALIB (\[.*\])/); if (m) resolve(JSON.parse(m[1])); else reject(new Error(`calibration render: electron exited ${code}: ${se.slice(-400)}`)); });
    });
    return summarize(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- all
export function machineInfo() {
  const ffmpeg = (() => { try { const r = spawnSync(process.env.RECUT_FFMPEG || 'ffmpeg', ['-version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.split('\n')[0].replace(/ Copyright.*$/, '') : 'unknown'; } catch { return 'unknown'; } })();
  return { nproc: os.cpus().length, cpu: os.cpus()[0]?.model ?? 'unknown', memGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, node: process.version, ffmpeg };
}

/**
 * Measures every category. A category that cannot run (no FFmpeg, no display for Electron) is recorded with an
 * `error` instead of a score; perf-check then falls back as documented (render -> js).
 */
export async function calibrate({ render = true, ffmpeg = true, log = () => {} } = {}) {
  const out = { version: CALIBRATION_VERSION, at: new Date().toISOString(), load: os.loadavg().map(r2), machine: machineInfo(), scores: {} };
  const t0 = performance.now();
  try { out.scores.js = measureJs(); } catch (e) { out.scores.js = { error: String(e.message ?? e) }; }
  log(`js ${fmt(out.scores.js)}`);
  if (ffmpeg) { try { out.scores.ffmpeg = measureFfmpeg(); } catch (e) { out.scores.ffmpeg = { error: String(e.message ?? e) }; } log(`ffmpeg ${fmt(out.scores.ffmpeg)}`); }
  if (render) { try { out.scores.render = await measureRender(); } catch (e) { out.scores.render = { error: String(e.message ?? e) }; } log(`render ${fmt(out.scores.render)}`); }
  out.ms = Math.round(performance.now() - t0);
  out.loadAfter = os.loadavg().map(r2);
  return out;
}

export function fmt(s) {
  if (!s) return 'not measured';
  if (s.error) return `FAILED (${s.error.split('\n')[0]})`;
  return `${s.median} ms (min-max ${s.min}-${s.max}, interquartile ${Math.round(s.iqr * 100)} %${s.iqr > SPREAD_WARN ? ', NOISY: host not quiet?' : ''})`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--json');
  const res = await calibrate({ render: !argv.includes('--no-render'), ffmpeg: !argv.includes('--no-ffmpeg'), log: (s) => console.log(`[calibrate] ${s}`) });
  console.log(`[calibrate] ${res.ms} ms, load ${res.load.join(' ')} -> ${res.loadAfter.join(' ')}`);
  if (i >= 0 && argv[i + 1]) { fs.writeFileSync(path.resolve(argv[i + 1]), `${JSON.stringify(res, null, 2)}\n`); console.log(`[calibrate] -> ${argv[i + 1]}`); }
  else console.log(JSON.stringify(res.scores, (k, v) => (k === 'samples' ? undefined : v)));
}
void ROOT;
