// README screenshots and demo GIFs, captured from the real app with open-movie footage.
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/readme-media.mjs --media <dir> [--out docs/screenshots]
//   xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/readme-media.mjs --synthetic [--only transcript,demo-ocr]
//
// Options:
//   --media <dir>     footage: tos.(mov|mp4|mkv) + tos-en.srt (Tears of Steel), sintel.(mkv|mp4|mov) + sintel-en.srt
//                     (Sintel), ggml-base.en.bin (Whisper model; or --whisper-model <file>). Names are matched loosely.
//   --synthetic       use scripts/make-test-media.sh output instead (local debugging; fake speech-to-text engine)
//   --out <dir>       where the PNGs and GIFs go (default docs/screenshots)
//   --only <a,b,...>  a subset: still names (project, timeline, ...) and/or demo names (demo-ocr, ...)
//   --work <dir>      scratch folder (prepared excerpts, cache, videos); default <tmp>/recut-readme-media[-synthetic]
//   --no-build        do not run `npm run build` first
//   --fake-whisper    a stand-in speech-to-text engine and test model (as --synthetic does), for local runs
//   --search <word>   the word the transcript-search demo types (default: chosen from both films' subtitles)
//
// What it does: cuts short excerpts of both films (the windows with the most dialogue), makes a "disc rip" MKV of Tears of
// Steel with a DVD bitmap subtitle track (rendered from the SRT by tests/helpers/bitmapSubs.ts) and AC-3 5.1 sound,
// builds a fan-edit project through window.__recut (as the e2e tests do), saves it, takes the stills, then records
// each demo in its own app run (Playwright recordVideo) and turns the interesting parts into a GIF with FFmpeg
// (palettegen / paletteuse). Fails when a GIF is over 3 MB or the changed files in --out add up to more than 20 MB.
//
// Footage credit: Tears of Steel and Sintel (c) Blender Foundation, CC BY 3.0 (see docs/screenshots/README.md).
import { _electron as electron } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const synthetic = argv.includes('--synthetic');
const fakeWhisper = synthetic || argv.includes('--fake-whisper');
const mediaArg = flag('--media');
const outDir = path.resolve(root, flag('--out') ?? 'docs/screenshots');
const only = new Set((flag('--only') ?? '').split(',').map((s) => s.trim().replace(/\.(png|gif)$/, '')).filter(Boolean));
const work = path.resolve(flag('--work') ?? path.join(os.tmpdir(), synthetic ? 'recut-readme-media-synthetic' : 'recut-readme-media'));
const searchArg = flag('--search');
const W = 1600, H = 900;
const GIF = { width: 960, fps: 12, maxSeconds: 12, softBytes: 2.3 * 1024 * 1024, maxBytes: 3 * 1024 * 1024 };
const TOTAL_BUDGET = 20 * 1024 * 1024;
const FRANCHISE = 'Blender Open Movies';
const PROJECT_NAME = 'Open Movie Fan Cut';

if (!synthetic && !mediaArg) { console.error('readme-media: pass --media <dir> or --synthetic'); process.exit(2); }

const STILLS = ['shell', 'project', 'project-panel', 'source', 'program', 'program-maximized', 'timeline', 'inspector', 'transcript',
  'scenes', 'storyline', 'compare', 'continuity', 'jobs', 'export', 'export-formats', 'program-still', 'collect', 'channels',
  'keyframes', 'nested'];
const DEMOS = ['demo-transcript-search', 'demo-whisper', 'demo-ocr', 'demo-what-if', 'demo-compare', 'demo-nest-keyframes'];
for (const n of only) if (!STILLS.includes(n) && !DEMOS.includes(n)) { console.error(`readme-media: unknown name in --only: ${n}`); process.exit(2); }
const wanted = (name) => only.size === 0 || only.has(name);

const log = (...a) => console.log('[readme-media]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const written = [];

// ------------------------------------------------------------------------------------------------ small utilities

function ff(args, opts = {}) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ').slice(0, 300)} failed: ${(r.stderr || '').slice(-1500)}`);
  return r;
}
function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
}
const duration = (file) => Number(probe(file).format.duration);
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdirp = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };

/** SRT text -> cues {start, end, text} (seconds). Tolerates a BOM, CRLF, missing indices and dot milliseconds. */
function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  const ts = (s) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + Number(`0.${m[4]}`) : NaN; };
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const start = ts(a), end = ts(z);
    const t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && t) cues.push({ start, end, text: t });
  }
  return cues.sort((x, y) => x.start - y.start);
}
function writeSrt(file, cues) {
  const f = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
  fs.writeFileSync(file, cues.map((c, i) => `${i + 1}\n${f(c.start)} --> ${f(c.end)}\n${c.text}\n`).join('\n'));
}
/** The `len`-second window (start on a 5 s grid) whose cues carry the most dialogue. */
function bestWindow(cues, total, len) {
  if (total <= len) return 0;
  let best = 0, bestScore = -1;
  for (let s = 0; s + len <= total; s += 5) {
    const score = cues.filter((c) => c.start >= s + 1 && c.end <= s + len - 2).reduce((n, c) => n + c.text.length, 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}
const windowCues = (cues, start, len) => cues.filter((c) => c.start >= start + 0.5 && c.end <= start + len - 0.5)
  .map((c) => ({ ...c, start: c.start - start, end: c.end - start }));

const STOP = new Set('that this with have from your what they there were when will would could should about into just like then them than been were here come know dont didnt cant wont youre thats were well yeah okay right want going gonna said tell they these those where which while there their again because some something nothing really still only over very much more even also make made take look need back down away other every after before through never ever always maybe sure think thing things doing done does dont lets let'.split(' '));
const PREFERRED = ['remember', 'alone', 'dragon', 'sorry', 'home', 'world', 'help', 'time', 'never', 'again', 'together', 'hand', 'life', 'kill', 'wait', 'stop', 'everything'];
const words = (cues) => cues.flatMap((c) => c.text.toLowerCase().replace(/[’']/g, '').split(/[^a-z]+/)).filter((w) => w.length >= 4);
/** A word both films say: a preferred one if possible, else the most evenly shared non-stopword. */
function commonWord(a, b) {
  const ca = new Map(), cb = new Map();
  for (const w of words(a)) ca.set(w, (ca.get(w) ?? 0) + 1);
  for (const w of words(b)) cb.set(w, (cb.get(w) ?? 0) + 1);
  for (const p of PREFERRED) if (ca.has(p) && cb.has(p)) return p;
  let best = null, score = 0;
  for (const [w, n] of ca) {
    if (STOP.has(w) || !cb.has(w)) continue;
    const s = Math.min(n, cb.get(w)) * 10 + w.length;
    if (s > score) { best = w; score = s; }
  }
  return best;
}
/** A distinctive word from a cue list (longest non-stopword in the middle third). */
function distinctiveWord(cues) {
  const ws = words(cues).filter((w) => !STOP.has(w));
  return ws.sort((x, y) => y.length - x.length)[0] ?? null;
}

async function bundleHelper(name) {
  const esbuild = await import('esbuild');
  const outfile = path.join(work, 'lib', `${name}.mjs`);
  await esbuild.build({ entryPoints: [path.join(root, 'tests/helpers', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}

// ------------------------------------------------------------------------------------------------ media preparation

/** Find the raw inputs. Real footage: loose name matching in --media. Synthetic: scripts/make-test-media.sh output. */
function rawInputs() {
  if (synthetic) {
    const dir = path.join(work, 'synthetic');
    if (!fs.existsSync(path.join(dir, 'subs', 'Galaxy Saga 2 - Dark Tide.srt'))) {
      rmrf(dir);
      log('generating synthetic media (scripts/make-test-media.sh full)');
      execFileSync('bash', [path.join(root, 'scripts/make-test-media.sh'), dir, 'full'], { stdio: 'inherit' });
    }
    return {
      tos: path.join(dir, 'movies/Galaxy Saga 1 - A New Dawn.mp4'), tosSrt: path.join(dir, 'subs/Galaxy Saga 1 - A New Dawn.srt'),
      sintel: path.join(dir, 'movies/Galaxy Saga 2 - Dark Tide.mp4'), sintelSrt: path.join(dir, 'subs/Galaxy Saga 2 - Dark Tide.srt'),
      model: null,
    };
  }
  const dir = path.resolve(mediaArg);
  const files = fs.readdirSync(dir);
  const find = (re, what) => {
    const f = files.find((n) => re.test(n));
    if (!f) throw new Error(`no ${what} in ${dir} (files: ${files.join(', ')})`);
    return path.join(dir, f);
  };
  const modelArg = flag('--whisper-model');
  return {
    tos: find(/^(tos|tears).*\.(mov|mp4|mkv)$/i, 'Tears of Steel video'),
    tosSrt: find(/^(tos|tears).*\.srt$/i, 'Tears of Steel subtitles'),
    sintel: find(/^sintel.*\.(mkv|mp4|mov)$/i, 'Sintel video'),
    sintelSrt: find(/^sintel.*\.srt$/i, 'Sintel subtitles'),
    model: modelArg ? path.resolve(modelArg) : (files.includes('ggml-base.en.bin') ? path.join(dir, 'ggml-base.en.bin') : null),
  };
}

/**
 * Excerpts (H.264 / AAC, at most 720p), their shifted SRTs, the Sintel copy without a sidecar (for Whisper), the
 * "disc rip" MKV (DVD bitmap subtitles + AC-3 5.1) and a PNG still. Cached in <work>/media by input stamp.
 */
async function prepareMedia() {
  const raw = rawInputs();
  const dir = path.join(work, 'media');
  const stamp = JSON.stringify([raw.tos, raw.sintel, raw.tosSrt, raw.sintelSrt].map((f) => [f, fs.statSync(f).size]).concat([[1]]));
  const stampFile = path.join(dir, 'stamp.json');
  const M = {
    dir,
    tos: path.join(dir, 'films', 'Tears of Steel (2012).mp4'),
    sintel: path.join(dir, 'films', 'Sintel (2010).mp4'),
    tosSrt: path.join(dir, 'subs', 'Tears of Steel (2012).en.srt'),
    sintelSrt: path.join(dir, 'subs', 'Sintel (2010).en.srt'),
    sintelBare: path.join(dir, 'whisper', 'Sintel (2010).mp4'),
    rip: path.join(dir, 'rip', 'Tears of Steel (2012) - Disc Rip.mkv'),
    still: path.join(dir, 'stills', 'Sintel still.png'),
    model: raw.model,
  };
  if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) {
    log('media: using the prepared excerpts in', dir);
  } else {
    rmrf(dir);
    for (const d of ['films', 'subs', 'whisper', 'rip', 'stills', 'tmp']) mkdirp(path.join(dir, d));
    const excerpt = (src, srt, dst, dstSrt, len) => {
      const total = duration(src);
      const cues = parseSrt(fs.readFileSync(srt, 'utf8'));
      const n = Math.min(len, total);
      const start = bestWindow(cues, total, n);
      const v = probe(src).streams.find((s) => s.codec_type === 'video');
      const scale = v && v.height > 720 ? ['-vf', 'scale=-2:720'] : [];
      log(`media: ${path.basename(dst)} = ${path.basename(src)} ${start}s +${n}s`);
      ff(['-ss', String(start), '-i', src, '-t', String(n), '-map', '0:v:0', '-map', '0:a:0', ...scale, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', dst]);
      writeSrt(dstSrt, windowCues(cues, start, n));
    };
    excerpt(raw.tos, raw.tosSrt, M.tos, M.tosSrt, synthetic ? 60 : 180);
    excerpt(raw.sintel, raw.sintelSrt, M.sintel, M.sintelSrt, synthetic ? 60 : 150);
    fs.copyFileSync(M.sintel, M.sintelBare);

    // Disc rip: the densest 90 s of the Tears of Steel excerpt, its English lines as a DVD bitmap subtitle stream,
    // the sound upmixed to AC-3 5.1 with the dialogue in the centre channel.
    const tosCues = parseSrt(fs.readFileSync(M.tosSrt, 'utf8'));
    const tosDur = duration(M.tos);
    const ripLen = Math.min(90, tosDur);
    const ripStart = bestWindow(tosCues, tosDur, ripLen);
    const events = [];
    for (const c of windowCues(tosCues, ripStart, ripLen)) {
      const prev = events[events.length - 1];
      const start = Math.max(c.start, prev ? prev.end : 0);
      const text = c.text.split('\n').slice(0, 2).map((l) => l.slice(0, 46)).join('\n');
      if (c.end - start > 0.3) events.push({ start, end: c.end, text });
    }
    const { makeBitmapSubsFixture } = await bundleHelper('bitmapSubs');
    const fx = await makeBitmapSubsFixture(path.join(dir, 'tmp', 'subs'), { codec: 'dvd_subtitle', events, duration: ripLen, name: 'tos-dvdsub' });
    log(`media: ${events.length} DVD subtitle bitmaps rendered`);
    ff(['-ss', String(ripStart), '-i', M.tos, '-t', String(ripLen), '-i', fx.path,
      '-map', '0:v:0', '-map', '0:a:0', '-map', `1:${fx.streamIndex}`, '-c:v', 'copy',
      '-af', 'pan=5.1(side)|FL=0.6*c0|FR=0.6*c1|FC=0.5*c0+0.5*c1|LFE=0.2*c0+0.2*c1|SL=0.4*c0|SR=0.4*c1',
      '-c:a', 'ac3', '-b:a', '448k', '-c:s', 'copy', '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=eng', '-t', String(ripLen), M.rip]);
    rmrf(path.join(dir, 'tmp'));

    // A still from Sintel with a white border (drawn as a picture-in-picture on V2).
    ff(['-ss', String(Math.min(40, duration(M.sintel) / 2)), '-i', M.sintel, '-frames:v', '1', '-vf', 'scale=640:-2,pad=iw+24:ih+24:12:12:white', M.still]);
    fs.writeFileSync(stampFile, stamp);
  }
  M.tosCues = parseSrt(fs.readFileSync(M.tosSrt, 'utf8'));
  M.sintelCues = parseSrt(fs.readFileSync(M.sintelSrt, 'utf8'));
  M.tosDur = duration(M.tos);
  M.sintelDur = duration(M.sintel);
  return M;
}

// ------------------------------------------------------------------------------------------------ the app

const CURSOR_JS = `(() => {
  if (document.getElementById('demo-cursor')) return;
  const d = document.createElement('div');
  d.id = 'demo-cursor';
  d.style.cssText = 'position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
    'background:rgba(255,204,0,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.6),0 2px 6px rgba(0,0,0,.5);' +
    'pointer-events:none;z-index:2147483647;transition:transform 90ms ease-out';
  document.documentElement.appendChild(d);
  addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.transform = 'scale(0.6)'; d.style.background = 'rgba(255,120,0,.85)'; }, true);
  addEventListener('mouseup', () => { d.style.transform = ''; d.style.background = 'rgba(255,204,0,.55)'; }, true);
})()`;

let whisperEnv = {};
let testModel = null;

/** Launch ReCut with a fresh user-data folder (OCR English and the Whisper model pre-installed) and a shared cache. */
async function launch(name, { record = false } = {}) {
  const tmp = path.join(work, 'sessions', name);
  rmrf(tmp);
  const userData = mkdirp(path.join(tmp, 'userData'));
  fs.copyFileSync(path.join(root, 'tests/fixtures/ocr/eng.traineddata'), path.join(mkdirp(path.join(userData, 'ocr', 'tessdata')), 'eng.traineddata'));
  const models = mkdirp(path.join(userData, 'whisper', 'models'));
  if (testModel) fs.writeFileSync(path.join(models, 'ggml-test-tiny.bin'), testModel);
  else if (Media.model) fs.copyFileSync(Media.model, path.join(models, 'ggml-base.en.bin'));
  const env = { ...process.env, ...whisperEnv, RECUT_USER_DATA: userData, RECUT_CACHE_DIR: mkdirp(path.join(work, 'cache')), RECUT_DISABLE_GPU: '1', RECUT_UPDATE_CHECK: '0', RECUT_HEADLESS: '1' };
  const app = await electron.launch({
    args: [path.join(root, 'dist/electron/main.js'), '--no-sandbox'], cwd: root, env, timeout: 90_000,
    ...(record ? { recordVideo: { dir: path.join(tmp, 'video'), size: { width: W, height: H } } } : {}),
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  const t0 = Date.now();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log(`[${name}:pageerror]`, e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}:console]`, m.text().slice(0, 300)); });
  await page.waitForSelector('#root .layout', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }, s) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(s.w, s.h); w.setPosition(0, 0); }, { w: W, h: H });
  await page.evaluate(() => { localStorage.removeItem('recut.layout.v1'); localStorage.removeItem('recut.shortcuts.v1'); });
  await page.reload();
  await page.waitForSelector('#root .layout', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__recut), undefined, { timeout: 30_000 });
  // Native message boxes are not in the recording: make them fail so ReCut shows its in-app dialog instead.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = () => Promise.reject(new Error('readme-media: in-app dialogs')); });
  const ctx = {
    name, app, page, tmp, userData, errors, record, t0,
    now: () => (Date.now() - t0) / 1000,
    segments: [],
    async close() {
      try { await page.evaluate(() => window.__recut.store.setState({ dirty: false })); } catch { /* gone */ }
      const video = record ? page.video() : null;
      await app.close().catch(() => undefined);
      return video ? video.path() : null;
    },
  };
  await page.evaluate(() => document.fonts?.ready);
  return ctx;
}

const st = (page, fn, arg) => page.evaluate(({ src, arg }) => {
  // eslint-disable-next-line no-new-func
  return new Function('st', 'arg', 'w', `return (${src})(st, arg, w)`)(window.__recut.store.getState(), arg, window.__recut);
}, { src: fn, arg });

async function importMedia(page, paths) {
  const ids = await page.evaluate((p) => window.__recut.actions.importMediaFiles(p), paths);
  await page.waitForFunction((ids) => {
    const media = window.__recut.store.getState().project.media;
    return ids.every((id) => media[id] && (media[id].probe || media[id].probeError));
  }, ids, { timeout: 120_000 });
  return ids;
}

async function waitJobsIdle(page, timeout = 240_000) {
  await page.waitForFunction(() => window.__recut.jobsStore.getState().jobs.every((j) => ['done', 'failed', 'canceled'].includes(j.status)), undefined, { timeout, polling: 500 });
}

async function showPanel(page, id) {
  await page.evaluate((panelId) => window.__recut.store.getState().setActivePanel(panelId), id);
  const tab = page.locator(`.zone-tab[data-panel="${id}"]`).first();
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
}

async function setWorkspace(page, name) {
  await page.locator('.ws-tab', { hasText: name }).first().click();
  await page.waitForTimeout(300);
}

async function setMaximized(page, panel, on) {
  const isMax = () => page.evaluate(() => !!document.querySelector('.layout-maximized'));
  if ((await isMax()) === on) return;
  const tab = page.locator(`.zone-tab[data-panel="${panel}"]`).first();
  await tab.click();
  await tab.dblclick();
  await page.waitForFunction((on) => !!document.querySelector('.layout-maximized') === on, on, { timeout: 10_000 });
  await page.waitForTimeout(300);
}

/** Use a custom layout (what a user gets by dragging panel tabs between zones). */
async function setLayout(page, workspace, zones, sizes) {
  await page.evaluate(({ workspace, zones, sizes }) => {
    localStorage.setItem('recut.layout.v1', JSON.stringify({ version: 1, workspace, layouts: { [workspace]: { zones, active: {}, sizes } } }));
  }, { workspace, zones, sizes });
  await page.reload();
  await page.waitForSelector('#root .layout', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__recut), undefined, { timeout: 30_000 });
}

async function programBrightness(page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]');
    const g = c?.getContext('2d');
    if (!c || !g || !c.width) return -1;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 64) { s += d[i] + d[i + 1] + d[i + 2]; n += 3; }
    return n ? s / n : -1;
  });
}
async function waitProgramFrame(page, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if ((await programBrightness(page)) > 4) return true; await sleep(250); }
  log('note: the Program monitor stayed dark');
  return false;
}
async function waitSourceFrame(page, seconds, timeout = 20_000) {
  await page.waitForFunction((t) => {
    const v = document.querySelector('.source-panel video');
    return !!v && v.readyState >= 2 && !v.seeking && (t == null || Math.abs(v.currentTime - t) < 0.25);
  }, seconds ?? null, { timeout }).catch(() => log('note: the Source monitor did not settle'));
}

// Cursor-visible interaction for the recordings.
async function moveTo(page, loc, opts = {}) {
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = await loc.boundingBox();
  if (!b) throw new Error(`not visible: ${loc}`);
  const x = b.x + (opts.dx ?? Math.min(b.width / 2, 60)), y = b.y + (opts.dy ?? b.height / 2);
  await page.mouse.move(x, y, { steps: opts.steps ?? 16 });
  await page.waitForTimeout(opts.pause ?? 150);
  return { x, y };
}
async function clickOn(page, loc, opts = {}) {
  await moveTo(page, loc, opts);
  await page.mouse.down({ button: opts.button ?? 'left' });
  await page.waitForTimeout(70);
  await page.mouse.up({ button: opts.button ?? 'left' });
  await page.waitForTimeout(opts.after ?? 250);
}
/** The Transcript panel's Import menu, through its submenus. */
async function transcriptMenu(page, labels) {
  await clickOn(page, page.getByTestId('transcript-panel').getByRole('button', { name: 'Import' }));
  for (const label of labels.slice(0, -1)) await moveTo(page, page.locator('.menu-item', { hasText: label }).first(), { steps: 10, pause: 350 });
  await clickOn(page, page.locator('.menu-item', { hasText: labels[labels.length - 1] }).first(), { steps: 10 });
}

/** Above this a still is re-encoded with a 256-colour palette (about a third of the size); the hero image may be bigger. */
const pngSoftLimit = (name) => (name === 'project' ? 1100 : 420) * 1024;

async function dismissToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast-host .toast button[aria-label="Dismiss"]').forEach((b) => b.click()));
}

async function shoot(page, name, { keepToasts = false } = {}) {
  const file = path.join(outDir, `${name}.png`);
  await page.waitForTimeout(400);
  if (!keepToasts) { await dismissToasts(page); await page.waitForTimeout(150); }
  await page.screenshot({ path: file });
  if (fs.statSync(file).size > pngSoftLimit(name)) {
    const tmp = `${file}.pal.png`;
    ff(['-i', file, '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', tmp]);
    if (fs.statSync(tmp).size < fs.statSync(file).size) fs.renameSync(tmp, file); else fs.rmSync(tmp);
  }
  written.push(file);
  log(`wrote ${path.relative(root, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

async function step(name, fn) {
  try { await fn(); } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n').slice(0, 6).join(' | ') : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`[readme-media] FAILED ${name}: ${msg}`);
  }
}

// ------------------------------------------------------------------------------------------------ recording -> GIF

/** Show a magenta frame, so the video's time base can be matched to the script's clock. */
async function flash(ctx) {
  await ctx.page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'demo-calibrate';
    d.style.cssText = 'position:fixed;inset:0;background:#ff00ff;z-index:2147483647';
    document.body.appendChild(d);
  });
  ctx.flashAt = ctx.now();
  await ctx.page.waitForTimeout(500);
  await ctx.page.evaluate(() => document.getElementById('demo-calibrate')?.remove());
  await ctx.page.waitForTimeout(300);
  await ctx.page.evaluate(CURSOR_JS);
}

/** Video time of the first magenta frame. */
function findFlash(video) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', video, '-vf', 'scale=4:4,showinfo', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 28 });
  const times = [...String(r.stderr).matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const buf = r.stdout;
  const fsz = 4 * 4 * 3;
  for (let i = 0; i < times.length && (i + 1) * fsz <= buf.length; i++) {
    let R = 0, G = 0, B = 0;
    for (let k = i * fsz; k < (i + 1) * fsz; k += 3) { R += buf[k]; G += buf[k + 1]; B += buf[k + 2]; }
    R /= 16; G /= 16; B /= 16;
    if (R > 200 && G < 80 && B > 200) return times[i];
  }
  throw new Error(`no calibration frame in ${video}`);
}

/** Cut the kept segments out of the recording (sped up where asked) and encode a GIF within budget. */
function makeGif(ctx, video, name) {
  const offset = ctx.flashAt - findFlash(video); // script time - video time
  let segs = ctx.segments.map((s) => ({ from: Math.max(0, s.from - offset), to: s.to - offset, speed: s.speed }));
  const total = segs.reduce((n, s) => n + (s.to - s.from) / s.speed, 0);
  if (total > GIF.maxSeconds) {
    const k = total / (GIF.maxSeconds - 0.2);
    segs = segs.map((s) => ({ ...s, speed: s.speed * k }));
    log(`${name}: ${total.toFixed(1)} s of footage, sped up ${k.toFixed(2)}x to fit ${GIF.maxSeconds} s`);
  }
  const file = path.join(outDir, `${name}.gif`);
  // Settings from best to smallest: the first one under the soft target wins, else the smallest under the hard limit.
  const tries = [{ fps: GIF.fps, colors: 160, width: GIF.width }, { fps: 10, colors: 128, width: GIF.width }, { fps: 10, colors: 96, width: 900 },
    { fps: 8, colors: 96, width: 880 }, { fps: 7, colors: 64, width: 800 }];
  let best = null;
  for (const t of tries) {
    const parts = segs.map((s, i) => `[v${i}]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)}[s${i}]`);
    const graph = [`[0:v]split=${segs.length}${segs.map((_, i) => `[v${i}]`).join('')}`, ...parts,
      `${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=${t.fps},scale=${t.width}:-2:flags=lanczos,split[a][b]`,
      `[a]palettegen=max_colors=${t.colors}:stats_mode=diff[p]`, `[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`].join(';');
    ff(['-i', video, '-filter_complex', graph, '-loop', '0', file]);
    const size = fs.statSync(file).size;
    log(`${name}.gif: ${(size / 1048576).toFixed(2)} MB at ${t.width}px ${t.fps} fps ${t.colors} colours, ${duration(file).toFixed(1)} s`);
    if (size <= GIF.softBytes) { fs.rmSync(`${file}.best`, { force: true }); written.push(file); return; }
    if (size <= GIF.maxBytes && (!best || size < best.size)) { best = { size, t }; fs.copyFileSync(file, `${file}.best`); }
  }
  if (!best) { fs.rmSync(file, { force: true }); throw new Error(`${name}.gif is over ${GIF.maxBytes} bytes at every setting`); }
  fs.renameSync(`${file}.best`, file);
  written.push(file);
}

/** Run one recorded demo: setup (not kept), then `body(ctx, keep)` where keep(fn, speed) records a kept segment. */
async function demo(name, setup, body) {
  if (!wanted(name)) return;
  await step(name, async () => {
    const ctx = await launch(name, { record: true });
    let video = null;
    try {
      const data = await setup(ctx);
      await flash(ctx);
      await ctx.page.mouse.move(W / 2, H / 2);
      await ctx.page.waitForTimeout(300);
      const keep = async (fn, speed = 1) => { const from = ctx.now(); const r = await fn(); ctx.segments.push({ from, to: ctx.now(), speed }); return r; };
      await body(ctx, keep, data);
      await ctx.page.waitForTimeout(200);
      if (ctx.errors.length) throw new Error(`page errors: ${ctx.errors.join(' | ')}`);
    } finally {
      video = await ctx.close();
    }
    if (!video || !fs.existsSync(video)) throw new Error('no video was recorded');
    makeGif(ctx, video, name);
  });
}

// ------------------------------------------------------------------------------------------------ the project

const projectFile = () => path.join(work, 'project', `${PROJECT_NAME}.recut`);

/** Clip ranges around subtitle lines, spread over the excerpt (seconds). */
function clipRanges(cues, dur, n) {
  const usable = cues.filter((c) => c.end - c.start >= 1 && c.end - c.start <= 7);
  const picks = [];
  for (let i = 0; i < n; i++) {
    const c = usable[Math.floor(((i + 0.5) * usable.length) / n)];
    if (c) picks.push([Math.max(0, c.start - 0.7), Math.min(dur, Math.max(c.end + 0.7, c.start + 3))]);
    else picks.push([(dur * i) / n, Math.min(dur, (dur * i) / n + 4)]);
  }
  return picks;
}

/** Import both films, the disc rip and the still; transcripts, identity, scenes; a tagged fan cut and an alternate. */
async function buildProject(ctx) {
  const { page } = ctx;
  const M = Media;
  const [tos, sintel, rip, still] = await importMedia(page, [M.tos, M.sintel, M.rip, M.still]);
  for (const [id, title, year] of [[tos, 'Tears of Steel', 2012], [sintel, 'Sintel', 2010], [rip, 'Tears of Steel', 2012]]) {
    await st(page, '(st, a) => st.updateMedia(a.id, { category: "Movie", identity: { title: a.title, year: a.year, franchise: a.fr } })', { id, title, year, fr: FRANCHISE });
  }
  for (const [id, srt] of [[tos, M.tosSrt], [sintel, M.sintelSrt]]) {
    const r = await page.evaluate(([id, p]) => window.__recut.actions.importSubtitleFile(id, p, 'eng'), [id, srt]);
    if (!r.trackId) throw new Error(`subtitle import failed: ${r.warnings.join('; ')}`);
  }
  await page.evaluate((id) => window.__recut.actions.startSceneDetect(id), tos);
  await page.evaluate((id) => window.__recut.actions.startProxy(id), rip);

  const tosR = clipRanges(M.tosCues, M.tosDur, 5);
  const sinR = clipRanges(M.sintelCues, M.sintelDur, 4);
  const plan = [];
  for (let i = 0; i < 5; i++) {
    plan.push({ mediaId: tos, r: tosR[i], characters: [i % 2 ? 'Thom' : 'Celia'], locations: ['Amsterdam'], plotlines: ['The robots'] });
    if (sinR[i]) plan.push({ mediaId: sintel, r: sinR[i], characters: ['Sintel'], locations: ['The mountains'], plotlines: ['The dragon'] });
  }
  const B = await st(page, `(st, a) => {
    const seqId = st.project.activeSequenceId;
    st.renameSequence(seqId, 'Fan Cut');
    st.updateSequenceSettings(seqId, { fps: { num: 24, den: 1 }, width: 1280, height: 720 });
    const end = () => { const q = window.__recut.store.getState().project.sequences[seqId]; return Math.max(0, ...[...q.videoTracks, ...q.audioTracks].flatMap((t) => t.clips.map((c) => c.start + c.duration))); };
    const clips = [];
    for (const p of a.plan) {
      const s = window.__recut.store.getState();
      const at = end();
      const ids = s.insertFromSource(seqId, { mediaId: p.mediaId, in: p.r[0], out: p.r[1], atFrame: at, mode: 'insert' });
      for (const id of ids) window.__recut.store.getState().setClipTags(seqId, id, { characters: p.characters, locations: p.locations, plotlines: p.plotlines });
      clips.push({ ids, at, mediaId: p.mediaId });
    }
    return { seqId, clips, end: end() };
  }`, { plan });
  B.tos = tos; B.sintel = sintel; B.rip = rip; B.still = still;
  // Video clip id of each planned clip, in timeline order.
  B.v = await st(page, `(st, a) => { const q = st.project.sequences[a.seqId]; const v = new Set(q.videoTracks.flatMap((t) => t.clips.map((c) => c.id))); return a.clips.map((c) => c.ids.find((id) => v.has(id))); }`, B);

  // The still on V2 over the third clip, small, top right.
  const c3 = B.clips[2];
  await st(page, `(st, a) => {
    const q = st.project.sequences[a.seqId];
    const ids = st.insertFromSource(a.seqId, { mediaId: a.still, in: 0, out: 3, atFrame: a.at + 6, mode: 'overwrite', videoTrackId: q.videoTracks[1].id, includeAudio: false });
    window.__recut.store.getState().setClipTransform(a.seqId, ids[0], { scale: 0.32, x: q.width * 0.29, y: -q.height * 0.27 });
  }`, { seqId: B.seqId, still, at: c3.at });

  // Story blocks, chapter markers, continuity notes.
  const at = (i) => B.clips[Math.min(i, B.clips.length - 1)].at;
  const blocks = [['Act I · The bridge', 0, at(3)], ['Act II · The quest', at(3), at(6)], ['Act III · The reckoning', at(6), B.end]];
  await st(page, `(st, a) => {
    for (const [name, start, end] of a.blocks) window.__recut.store.getState().addStoryBlock(a.seqId, { name, start, end });
    for (const [name, start] of a.blocks) window.__recut.store.getState().addMarker(a.seqId, { time: start, name, kind: 'chapter' });
    const notes = [
      { time: a.at1 + 12, name: "Celia's jacket", note: 'Zipped in the wide shot, open in the close-up. Check the source at the cut.', category: 'wardrobe', clipId: a.v[0] },
      { time: a.at2 + 10, name: 'Score jumps at the cut', note: 'The music restarts on the Sintel shot; add an audio crossfade.', category: 'music', clipId: a.v[1] },
      { time: a.at3 + 8, name: 'Missing prop', note: 'The scale is gone in the next shot.', category: 'prop', clipId: a.v[3] },
    ];
    const ids = notes.map((n) => window.__recut.store.getState().addContinuityNote(a.seqId, n));
    window.__recut.store.getState().resolveContinuity(a.seqId, ids[2], true);
  }`, { seqId: B.seqId, blocks, v: B.v, at1: at(0), at2: at(1), at3: at(3) });

  // Scene library: a few named records per film.
  const scenes = [
    [tos, M.tosCues, 0.15, 'On the bridge', ['Celia', 'Thom'], 'Amsterdam', 5, 'Breakup'],
    [tos, M.tosCues, 0.45, 'Control room', ['Thom'], 'Oude Kerk', 4, 'The plan'],
    [tos, M.tosCues, 0.8, 'The robots attack', ['Celia'], 'Amsterdam', 3, 'Battle'],
    [sintel, M.sintelCues, 0.2, 'The gatekeeper', ['Sintel'], 'The mountains', 5, 'The quest'],
    [sintel, M.sintelCues, 0.6, 'Scales', ['Sintel'], 'Snowfield', 4, 'The dragon'],
    [sintel, M.sintelCues, 0.9, 'Alone', ['Sintel'], 'The cave', 3, 'The dragon'],
  ];
  for (const [mediaId, cues, f, name, characters, location, rating, arc] of scenes) {
    const c = cues[Math.min(cues.length - 1, Math.floor(cues.length * f))] ?? { start: 1, end: 4 };
    await st(page, `(st, a) => {
      st.setSourceClip(a.mediaId, a.in); st.setSourceIn(a.in); st.setSourceOut(a.out);
      const id = window.__recut.store.getState().sceneFromSource(a.name);
      if (id) window.__recut.store.getState().updateScene(id, { characters: a.characters, location: a.location, rating: a.rating, arc: a.arc, tags: ['dialogue'] });
    }`, { mediaId, in: Math.max(0, c.start - 1), out: c.end + 1.5, name, characters, location, rating, arc });
  }
  await st(page, '(st) => { st.setSourceClip(null); st.selectScenes([]); }');

  // An alternate cut: two clips gone, one trimmed.
  B.altId = await st(page, `(st, a) => {
    const s = () => window.__recut.store.getState();
    const id = s().duplicateSequence(a.seqId, 'Fan Cut (short)');
    const kill = (vid) => {
      const q = s().project.sequences[id];
      const all = [...q.videoTracks, ...q.audioTracks].flatMap((t) => t.clips);
      const v = all.find((c) => c.kind === 'video' && c.start === vid.start && c.mediaId === vid.mediaId);
      if (!v) return;
      s().select(all.filter((c) => c.id === v.id || (v.linkId && c.linkId === v.linkId)).map((c) => c.id));
      s().rippleDeleteSelected(id);
    };
    const orig = s().project.sequences[a.seqId].videoTracks[0].clips;
    const targets = [orig[orig.length - 2], orig[3]].filter(Boolean).map((c) => ({ start: c.start, mediaId: c.mediaId }));
    targets.sort((x, y) => y.start - x.start).forEach(kill);
    const q = s().project.sequences[id];
    const first = q.videoTracks[0].clips[0];
    if (first) s().trimClipEdge(id, first.id, 'end', first.start + Math.round(first.duration * 0.7), true);
    s().select([]);
    s().setActiveSequence(a.seqId);
    return id;
  }`, { seqId: B.seqId });
  await st(page, `(st) => st.renameProject(${JSON.stringify(PROJECT_NAME)})`);
  await waitJobsIdle(page);
  mkdirp(path.dirname(projectFile()));
  const saved = await page.evaluate((p) => window.__recut.actions.saveProject(p), projectFile());
  if (!saved.ok) throw new Error(`save failed: ${saved.error}`);
  fs.writeFileSync(path.join(work, 'project', 'ids.json'), JSON.stringify(B));
  log(`project saved: ${projectFile()} (${B.clips.length} clips)`);
  return B;
}

async function openProject(ctx) {
  const { page } = ctx;
  const r = await page.evaluate((p) => window.__recut.actions.openProject(p), projectFile());
  if (!r.ok) throw new Error(`open failed: ${r.error}`);
  await page.waitForFunction(() => {
    const media = Object.values(window.__recut.store.getState().project.media);
    return media.length > 0 && media.every((m) => m.probe && !m.offline);
  }, undefined, { timeout: 60_000 });
  await waitJobsIdle(page).catch(() => undefined);
  return JSON.parse(fs.readFileSync(path.join(work, 'project', 'ids.json'), 'utf8'));
}

const fitTimeline = async (page) => { await page.evaluate(() => window.__recut.runCommand('view.zoomToFit')); await page.waitForTimeout(300); };
const setPlayhead = (page, f) => st(page, '(st, f) => st.setView(st.project.activeSequenceId, { playhead: f })', f);
const clipStart = (page, seqId, id) => st(page, '(st, a) => { const q = st.project.sequences[a.seqId]; for (const t of [...q.videoTracks, ...q.audioTracks]) for (const c of t.clips) if (c.id === a.id) return c.start; return 0; }', { seqId, id });

// ------------------------------------------------------------------------------------------------ stills

async function stills() {
  const names = STILLS.filter(wanted);
  const needProject = !fs.existsSync(projectFile()) || names.length > 0 || DEMOS.some(wanted);
  if (!needProject) return;
  const ctx = await launch('stills');
  const { page } = ctx;
  try {
    if (wanted('shell')) await step('shell', async () => { await page.waitForTimeout(800); await shoot(page, 'shell'); });
    const B = await buildProject(ctx);
    const seqId = B.seqId;
    const v = B.v;
    const tosClip = v[2];

    const hero = async () => {
      await showPanel(page, 'project');
      await showPanel(page, 'transcript');
      await st(page, '(st, a) => { st.setActiveSequence(a.seqId); st.selectMedia([]); st.select([a.clip]); }', { seqId, clip: tosClip });
      await fitTimeline(page);
      const ph = (await clipStart(page, seqId, tosClip)) + 30;
      await setPlayhead(page, ph);
      const s = M_sintelCue(0.3);
      await st(page, '(st, a) => { st.setSourceClip(a.id, a.t); st.setSourceIn(a.in); st.setSourceOut(a.out); }', { id: B.sintel, t: s.start + 0.4, in: s.start - 0.5, out: s.end + 0.5 });
      await waitSourceFrame(page, s.start + 0.4);
      await waitProgramFrame(page);
    };

    if (wanted('project')) await step('project', async () => {
      await hero();
      await page.getByTestId('transcript-search').fill(searchWord());
      await page.getByTestId('transcript-scope').selectOption(`franchise:${FRANCHISE}`).catch(() => undefined);
      await page.waitForTimeout(1200);
      await shoot(page, 'project');
      await page.getByTestId('transcript-search').fill('');
      await page.getByTestId('transcript-scope').selectOption('project').catch(() => undefined);
    });
    if (wanted('source')) await step('source', async () => {
      await hero();
      await showPanel(page, 'source');
      await shoot(page, 'source');
    });
    if (wanted('program')) await step('program', async () => {
      await hero();
      await st(page, '(st, a) => st.setView(a.seqId, { inPoint: a.i, outPoint: a.o })', { seqId, i: B.clips[1].at, o: B.clips[4].at });
      await showPanel(page, 'program');
      await shoot(page, 'program');
      await st(page, '(st, a) => st.setView(a.seqId, { inPoint: null, outPoint: null })', { seqId });
    });
    if (wanted('program-maximized')) await step('program-maximized', async () => {
      await hero();
      await page.getByTestId('program-maximize').click();
      await page.waitForTimeout(600);
      await waitProgramFrame(page);
      await shoot(page, 'program-maximized');
      await page.getByTestId('program-maximize').click();
      await page.waitForTimeout(300);
    });
    if (wanted('timeline')) await step('timeline', async () => {
      await hero();
      await setMaximized(page, 'timeline', true);
      await fitTimeline(page);
      await page.waitForTimeout(800);
      await shoot(page, 'timeline');
      await setMaximized(page, 'timeline', false);
    });
    if (wanted('inspector')) await step('inspector', async () => {
      await hero();
      await showPanel(page, 'inspector');
      await shoot(page, 'inspector');
    });
    if (wanted('project-panel')) await step('project-panel', async () => {
      await hero();
      await showPanel(page, 'project');
      await setMaximized(page, 'project', true);
      await page.locator(`[data-row-kind="media"]`).first().click();
      await st(page, '(st, a) => st.selectMedia([a])', B.tos);
      const footer = page.getByTestId('info-footer').locator('.pp-info-head');
      if (await footer.count()) await footer.click();
      await page.waitForTimeout(1500);
      await shoot(page, 'project-panel');
      if (await footer.count()) await footer.click();
      await setMaximized(page, 'project', false);
    });
    if (wanted('transcript')) await step('transcript', async () => {
      await hero();
      await showPanel(page, 'transcript');
      const word = searchWord();
      await page.getByTestId('transcript-search').fill(word);
      await page.getByTestId('transcript-scope').selectOption(`franchise:${FRANCHISE}`);
      const hit = page.getByTestId('transcript-result').first();
      await hit.waitFor({ timeout: 10_000 });
      await hit.click();
      await waitSourceFrame(page);
      await page.getByTestId('transcript-search').focus();
      await shoot(page, 'transcript');
      await page.getByTestId('transcript-search').fill('');
    });
    if (wanted('scenes')) await step('scenes', async () => {
      await hero();
      await showPanel(page, 'scenes');
      await page.locator('[data-scene-id]').first().click();
      await page.waitForTimeout(1200);
      await shoot(page, 'scenes');
    });
    if (wanted('continuity')) await step('continuity', async () => {
      await hero();
      await showPanel(page, 'continuity');
      const row = page.locator('.cty-row[data-marker-id]').first();
      await row.waitFor({ timeout: 10_000 });
      await row.locator('.cty-expand').click().catch(() => undefined);
      await page.waitForTimeout(400);
      await shoot(page, 'continuity');
    });
    if (wanted('jobs')) await step('jobs', async () => {
      await hero();
      await showPanel(page, 'jobs');
      await st(page, '(st, a) => st.selectMedia([a])', B.rip);
      const proxies = page.locator('.zone [role="tab"], .tabs button, button', { hasText: /^Proxies/ }).first();
      if (await proxies.count()) await proxies.click().catch(() => undefined);
      await page.waitForTimeout(600);
      await shoot(page, 'jobs');
    });
    if (wanted('program-still')) await step('program-still', async () => {
      await hero();
      await st(page, '(st, a) => st.select([])');
      await setPlayhead(page, B.clips[2].at + 40);
      await page.waitForTimeout(500);
      await waitProgramFrame(page);
      await page.waitForTimeout(800);
      await shoot(page, 'program-still');
    });
    if (wanted('compare')) await step('compare', async () => {
      await setWorkspace(page, 'Compare');
      await showPanel(page, 'compare');
      await page.getByTestId('compare-select-a').selectOption(seqId);
      await page.getByTestId('compare-select-b').selectOption(B.altId);
      const row = page.locator('[data-testid="diff-row"][data-kind="onlyA"]').first();
      await row.waitFor({ timeout: 10_000 });
      await row.click();
      await page.waitForTimeout(1500);
      await page.getByTestId('compare-panel').locator('[data-testid="compare-play"]').scrollIntoViewIfNeeded().catch(() => undefined);
      await shoot(page, 'compare');
    });
    if (wanted('storyline')) await step('storyline', async () => {
      await setWorkspace(page, 'Compare');
      await st(page, '(st, a) => st.setActiveSequence(a)', seqId);
      await showPanel(page, 'storyline');
      await page.getByTestId('filter-mode-highlight').click();
      await page.getByTestId('filter-characters-Sintel').check();
      await page.getByTestId('whatif-readout').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(800);
      await shoot(page, 'storyline');
      await page.getByTestId('filter-clear').click();
    });
    await setWorkspace(page, 'Editing');
    await st(page, '(st, a) => st.setActiveSequence(a)', seqId);

    if (wanted('export')) await step('export', async () => {
      await hero();
      await st(page, '(st) => { st.select([]); st.openDialog("export"); }');
      await page.getByTestId('export-dialog').waitFor();
      await page.getByTestId('export-outdir').fill(path.join(os.homedir(), 'Videos', 'Fan edits'));
      await page.getByTestId('export-filename').fill('Open Movie Fan Cut.mp4');
      await page.getByTestId('export-format').selectOption('mkv');
      await page.getByTestId('export-sub-include-1').check().catch(() => undefined);
      await page.waitForTimeout(500);
      await shoot(page, 'export');
      await page.keyboard.press('Escape');
    });
    if (wanted('export-formats')) await step('export-formats', async () => {
      await st(page, '(st) => { st.select([]); st.openDialog("export"); }');
      await page.getByTestId('export-dialog').waitFor();
      await page.getByTestId('export-outdir').fill(path.join(os.homedir(), 'Videos', 'Fan edits'));
      await page.getByTestId('export-filename').fill('Open Movie Fan Cut (master).mov');
      await page.getByTestId('export-format').selectOption('mov');
      await page.getByTestId('export-intermediate-codec').selectOption('prores');
      await page.getByTestId('export-profile').selectOption('hq');
      await page.waitForTimeout(500);
      await shoot(page, 'export-formats');
      await page.keyboard.press('Escape');
    });
    if (wanted('collect')) await step('collect', async () => {
      const dest = path.join(os.tmpdir(), 'Archive Drive');
      rmrf(dest); mkdirp(dest);
      await ctx.app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] }); }, dest);
      await page.evaluate(() => window.__recut.runCommand('file.collect'));
      await page.getByTestId('collect-dialog').waitFor();
      await page.getByTestId('collect-choose').click();
      await page.getByTestId('collect-total').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="collect-total"]')?.textContent !== '0 B', undefined, { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(600);
      await shoot(page, 'collect');
      await page.keyboard.press('Escape');
    });

    // From here on the stills change the cut (the project is already saved for the demos).
    if (wanted('channels')) await step('channels', async () => {
      await hero();
      await st(page, '(st) => st.select([])');
      const at = await st(page, '(st, a) => { const q = st.project.sequences[a]; return Math.max(...[...q.videoTracks, ...q.audioTracks].flatMap((t) => t.clips.map((c) => c.start + c.duration))); }', seqId);
      const ids = await st(page, '(st, a) => st.insertFromSource(a.seqId, { mediaId: a.rip, in: 20, out: 32, atFrame: a.at, mode: "overwrite" })', { seqId, rip: B.rip, at });
      const vid = await st(page, '(st, a) => { const q = st.project.sequences[a.seqId]; const v = new Set(q.videoTracks.flatMap((t) => t.clips.map((c) => c.id))); return a.ids.find((id) => v.has(id)); }', { seqId, ids });
      await st(page, '(st, a) => st.setView(a.seqId, { playhead: a.at + 48 })', { seqId, at });
      await fitTimeline(page);
      // Timeline clip context menu > Extract Centre Channel (Dialogue), as a user does it.
      const b = await page.locator(`.tl-clip[data-clip-id="${vid}"]`).boundingBox();
      if (!b) throw new Error('the disc-rip clip is not visible');
      await page.mouse.click(b.x + Math.min(b.width / 2, 50), b.y + b.height / 2, { button: 'right' });
      await page.locator('.menu-item', { hasText: 'Extract Centre Channel (Dialogue)' }).click();
      await page.locator('.toast', { hasText: 'Centre channel extracted' }).waitFor({ timeout: 10_000 });
      const centre = await st(page, '(st, a) => st.project.sequences[a].audioTracks.flatMap((t) => t.clips).find((c) => c.audio?.channelSelection?.mode === "channel")?.id', seqId);
      if (!centre) throw new Error('no centre-channel clip');
      await st(page, '(st, a) => st.select([a])', centre);
      await page.waitForFunction((id) => {
        const m = window.__recut.store.getState().project.media[id];
        return Object.values(m.channelProxies ?? {}).some((p) => p && p.status === 'ready');
      }, B.rip, { timeout: 120_000 }).catch(() => log('note: the centre-channel preview is not ready'));
      const picker = page.getByTestId('inspector').getByTestId('clip-audio-channels');
      await picker.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(500);
      await shoot(page, 'channels', { keepToasts: true });
    });
    if (wanted('keyframes')) await step('keyframes', async () => {
      await hero();
      const id = v[0];
      const s0 = await clipStart(page, seqId, id);
      await st(page, '(st, a) => st.select([a])', id);
      await setPlayhead(page, s0);
      const insp = page.getByTestId('inspector');
      await insp.getByTestId('kf-scale').click();
      await insp.getByTestId('kf-position').click();
      await setPlayhead(page, s0 + 60);
      await typeNumber(page, '[data-prop="scale"] .numfield', '135');
      await typeNumber(page, '[data-prop="position"] .numfield', '-180');
      await insp.getByTestId('kf-scale-interp').selectOption('ease').catch(() => undefined);
      await setPlayhead(page, s0 + 34);
      await insp.locator('[data-prop="scale"]').scrollIntoViewIfNeeded();
      await waitProgramFrame(page);
      await page.waitForTimeout(800);
      await shoot(page, 'keyframes');
    });
    if (wanted('nested')) await step('nested', async () => {
      await hero();
      const nid = await st(page, '(st, a) => st.makeCompoundClip(a.seqId, [a.v[3], a.v[4]], "The quest")', { seqId, v });
      if (!nid) throw new Error('makeCompoundClip returned nothing');
      const clip = await st(page, '(st, a) => { const q = st.project.sequences[a]; return q.videoTracks[0].clips.find((c) => c.sequenceId)?.id; }', seqId);
      await st(page, '(st, a) => st.select([a])', clip);
      await setPlayhead(page, (await clipStart(page, seqId, clip)) + 20);
      await fitTimeline(page);
      await page.locator('.tl-clip.nested').first().waitFor({ timeout: 10_000 });
      await waitProgramFrame(page);
      await page.waitForTimeout(800);
      await shoot(page, 'nested');
    });
  } finally {
    await ctx.close();
  }
}

async function typeNumber(page, selector, value) {
  const field = page.getByTestId('inspector').locator(selector).first();
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.locator('input').waitFor({ timeout: 5000 });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(value, { delay: 60 });
  await page.keyboard.press('Enter');
}

let Media;
const M_sintelCue = (f) => Media.sintelCues[Math.min(Media.sintelCues.length - 1, Math.floor(Media.sintelCues.length * f))] ?? { start: 2, end: 4 };
let searchWordCache;
function searchWord() {
  if (!searchWordCache) searchWordCache = searchArg ?? commonWord(Media.tosCues, Media.sintelCues) ?? distinctiveWord(Media.tosCues) ?? 'the';
  return searchWordCache;
}

// ------------------------------------------------------------------------------------------------ demos

async function demos() {
  // 1. Transcript search across both films (franchise scope); a hit opens in the Source monitor.
  await demo('demo-transcript-search', async (ctx) => {
    const B = await openProject(ctx);
    await showPanel(ctx.page, 'transcript');
    await st(ctx.page, '(st, a) => { st.setActiveSequence(a); st.setSourceClip(null); }', B.seqId);
    await fitTimeline(ctx.page);
    return B;
  }, async (ctx, keep) => {
    const { page } = ctx;
    const word = searchWord();
    log(`demo-transcript-search: searching "${word}"`);
    await keep(async () => {
      await clickOn(page, page.getByTestId('transcript-search'));
      await page.keyboard.type(word, { delay: 110 });
      await page.waitForTimeout(700);
      await moveTo(page, page.getByTestId('transcript-scope'));
      await page.getByTestId('transcript-scope').selectOption(`franchise:${FRANCHISE}`);
      await page.waitForTimeout(1200);
      const hits = page.getByTestId('transcript-result');
      await hits.first().waitFor({ timeout: 10_000 });
      const n = await hits.count();
      const target = hits.nth(Math.min(n - 1, Math.max(1, Math.floor(n / 2))));
      await clickOn(page, target, { after: 200 });
      await waitSourceFrame(page);
      await page.waitForTimeout(500);
      const play = page.locator('.source-panel button.play').first();
      if (await play.count()) { await clickOn(page, play); await page.waitForTimeout(2200); await play.click(); }
      await page.waitForTimeout(500);
    });
  });

  // 2. Transcribe Sintel (no subtitles) with the bundled Whisper engine; the line is then searchable.
  await demo('demo-whisper', async (ctx) => {
    const [id] = await importMedia(ctx.page, [Media.sintelBare]);
    await st(ctx.page, '(st, id) => { st.selectMedia([id]); st.setSourceClip(id, 1); }', id);
    await showPanel(ctx.page, 'transcript');
    await waitSourceFrame(ctx.page);
    return { id };
  }, async (ctx, keep, { id }) => {
    const { page } = ctx;
    await keep(async () => {
      await transcriptMenu(page, ['Transcribe…', 'Local Whisper…']);
      await page.getByTestId('transcribe-dialog').waitFor();
      await page.waitForTimeout(1300);
      await clickOn(page, page.getByTestId('transcribe-start'));
      await page.waitForTimeout(700);
    });
    // The wait: kept, but squeezed to about two seconds.
    const t = ctx.now();
    await page.waitForFunction((id) => Object.values(window.__recut.store.getState().project.subtitleTracks).some((t) => t.mediaId === id && t.origin === 'whisper'), id, { timeout: 600_000, polling: 250 });
    const waited = ctx.now() - t;
    ctx.segments.push({ from: t, to: ctx.now(), speed: Math.max(1, waited / 2) });
    log(`demo-whisper: transcription took ${waited.toFixed(1)} s`);
    const cues = await st(page, '(st, id) => Object.values(st.project.subtitleTracks).find((t) => t.mediaId === id && t.origin === "whisper").cues.map((c) => ({ start: c.start, end: c.end, text: c.text }))', id);
    const word = distinctiveWord(cues.slice(Math.floor(cues.length / 3))) ?? distinctiveWord(cues) ?? cues[0]?.text.split(/\s+/)[0] ?? 'the';
    log(`demo-whisper: ${cues.length} cues; searching "${word}"`);
    await keep(async () => {
      await page.waitForTimeout(900);
      await clickOn(page, page.getByTestId('transcript-search'));
      await page.keyboard.type(word, { delay: 110 });
      await page.waitForTimeout(900);
      const hit = page.getByTestId('transcript-result').first();
      await hit.waitFor({ timeout: 10_000 });
      await clickOn(page, hit);
      await waitSourceFrame(page);
      await page.waitForTimeout(1500);
    });
  });

  // 3. Read with OCR on the disc rip's DVD subtitle stream -> a searchable text track.
  await demo('demo-ocr', async (ctx) => {
    const [id] = await importMedia(ctx.page, [Media.rip]);
    await st(ctx.page, '(st, id) => { st.selectMedia([id]); st.setSourceClip(id, 1); }', id);
    await showPanel(ctx.page, 'transcript');
    await ctx.page.waitForTimeout(800);
    return { id };
  }, async (ctx, keep, { id }) => {
    const { page } = ctx;
    await keep(async () => {
      await transcriptMenu(page, ['Embedded…', 'Read with OCR']);
      await page.getByTestId('ocr-dialog').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-testid="ocr-start"]')?.hasAttribute('disabled'), undefined, { timeout: 15_000 });
      await page.waitForTimeout(1300);
      await clickOn(page, page.getByTestId('ocr-start'));
      await page.waitForTimeout(600);
    });
    const t = ctx.now();
    await page.waitForFunction((id) => Object.values(window.__recut.store.getState().project.subtitleTracks).some((t) => t.mediaId === id && t.origin === 'ocr'), id, { timeout: 600_000, polling: 250 });
    const waited = ctx.now() - t;
    ctx.segments.push({ from: t, to: ctx.now(), speed: Math.max(1, waited / 1.5) });
    const cues = await st(page, '(st, id) => Object.values(st.project.subtitleTracks).find((t) => t.mediaId === id && t.origin === "ocr").cues.map((c) => ({ start: c.start, end: c.end, text: c.text }))', id);
    const word = distinctiveWord(cues) ?? 'the';
    log(`demo-ocr: OCR took ${waited.toFixed(1)} s, ${cues.length} cues; searching "${word}"`);
    await keep(async () => {
      await page.waitForTimeout(1000);
      // The Transcript tab lists the read lines.
      const tab = page.getByTestId('transcript-panel').locator('button, [role="tab"]', { hasText: /^Transcript$/ }).first();
      if (await tab.count()) { await clickOn(page, tab); await page.waitForTimeout(1800); }
      const searchTab = page.getByTestId('transcript-panel').locator('button, [role="tab"]', { hasText: /^Search$/ }).first();
      if (await searchTab.count()) await clickOn(page, searchTab);
      await clickOn(page, page.getByTestId('transcript-search'));
      await page.keyboard.type(word, { delay: 110 });
      await page.waitForTimeout(900);
      const hit = page.getByTestId('transcript-result').first();
      await hit.waitFor({ timeout: 10_000 });
      await clickOn(page, hit);
      await waitSourceFrame(page);
      await page.waitForTimeout(1200);
    });
  });

  // 4. What if: tag filter -> runtime estimate -> disable -> Remove disabled.
  await demo('demo-what-if', async (ctx) => {
    const { page } = ctx;
    await setLayout(page, 'Editing', {
      'left-top': ['project'], 'left-bottom': ['transcript', 'scenes', 'continuity', 'subtitles', 'markers', 'history', 'jobs'],
      'monitor-left': ['storyline', 'source'], 'monitor-right': ['program'], 'center-bottom': ['timeline'], right: ['inspector', 'compare'],
    }, { leftW: 240, rightW: 250, leftSplit: 0.45, centerSplit: 0.52, monitorSplit: 0.6 });
    const B = await openProject(ctx);
    await st(page, '(st, a) => st.setActiveSequence(a)', B.seqId);
    await showPanel(page, 'storyline');
    await fitTimeline(page);
    await setPlayhead(page, 0);
    await waitProgramFrame(page);
    return B;
  }, async (ctx, keep) => {
    const { page } = ctx;
    await keep(async () => {
      await clickOn(page, page.getByTestId('filter-mode-highlight'));
      await clickOn(page, page.getByTestId('filter-characters-Sintel'), { after: 1400 });
      await moveTo(page, page.getByTestId('whatif-readout'), { pause: 1200 });
      await clickOn(page, page.getByTestId('disable-matching'), { after: 1500 });
      await clickOn(page, page.getByTestId('remove-disabled'), { after: 700 });
      await clickOn(page, page.getByTestId('confirm-button-0'), { after: 400 });
      await clickOn(page, page.getByTestId('filter-clear'), { after: 1500 });
    });
  });

  // 5. Compare two cuts side by side with the structural diff.
  await demo('demo-compare', async (ctx) => {
    const B = await openProject(ctx);
    await setWorkspace(ctx.page, 'Compare');
    await showPanel(ctx.page, 'compare');
    await st(ctx.page, '(st, a) => st.setActiveSequence(a)', B.seqId);
    await ctx.page.waitForTimeout(600);
    return B;
  }, async (ctx, keep, B) => {
    const { page } = ctx;
    await keep(async () => {
      await moveTo(page, page.getByTestId('compare-select-a'));
      await page.getByTestId('compare-select-a').selectOption(B.seqId);
      await page.waitForTimeout(400);
      await moveTo(page, page.getByTestId('compare-select-b'));
      await page.getByTestId('compare-select-b').selectOption(B.altId);
      await page.waitForTimeout(1200);
      const row = page.locator('[data-testid="diff-row"][data-kind="onlyA"]').first();
      await row.waitFor({ timeout: 10_000 });
      await clickOn(page, row, { after: 1200 });
      await clickOn(page, page.getByTestId('compare-play'));
      await page.waitForTimeout(3200);
      await page.getByTestId('compare-play').click();
      const moved = page.locator('[data-testid="diff-row"][data-kind="moved"]').first();
      if (await moved.count()) await clickOn(page, moved, { after: 1200 });
    });
  });

  // 6. Nest clips into a compound clip, then a scale / position keyframe move played in the Program monitor.
  await demo('demo-nest-keyframes', async (ctx) => {
    const B = await openProject(ctx);
    await st(ctx.page, '(st, a) => { st.setActiveSequence(a); st.select([]); }', B.seqId);
    await fitTimeline(ctx.page);
    await setPlayhead(ctx.page, 0);
    await waitProgramFrame(ctx.page);
    return B;
  }, async (ctx, keep, B) => {
    const { page } = ctx;
    const seqId = B.seqId;
    await keep(async () => {
      const a = page.locator(`.tl-clip[data-clip-id="${B.v[0]}"]`), b = page.locator(`.tl-clip[data-clip-id="${B.v[1]}"]`);
      await clickOn(page, a, { after: 250 });
      await moveTo(page, b);
      await page.keyboard.down('Shift');
      await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.waitForTimeout(400);
      await clickOn(page, a, { button: 'right', after: 500 });
      await clickOn(page, page.locator('.menu-item', { hasText: 'Make Compound Clip' }), { after: 1100 });
    }, 1.3);
    const clip = await st(page, '(st, a) => st.project.sequences[a].videoTracks[0].clips.find((c) => c.sequenceId)?.id', seqId);
    if (!clip) throw new Error('no compound clip');
    const s0 = await clipStart(page, seqId, clip);
    await st(page, '(st, a) => st.select([a])', clip);
    await setPlayhead(page, s0);
    const insp = page.getByTestId('inspector');
    await insp.locator('[data-prop="scale"]').scrollIntoViewIfNeeded();
    await keep(async () => {
      await page.waitForTimeout(500);
      await clickOn(page, insp.getByTestId('kf-scale'));
      await clickOn(page, insp.getByTestId('kf-position'));
      await setPlayhead(page, s0 + 48);
      await page.waitForTimeout(400);
      await moveTo(page, insp.locator('[data-prop="scale"] .numfield').first());
      await typeNumber(page, '[data-prop="scale"] .numfield', '140');
      await moveTo(page, insp.locator('[data-prop="position"] .numfield').first());
      await typeNumber(page, '[data-prop="position"] .numfield', '-200');
      await page.waitForTimeout(500);
    }, 1.4);
    await setPlayhead(page, s0);
    await page.waitForTimeout(400);
    await keep(async () => {
      await clickOn(page, page.getByTestId('program-play'));
      await page.waitForTimeout(2600);
      await page.getByTestId('program-play').click();
      await page.waitForTimeout(400);
    });
  });
}

// ------------------------------------------------------------------------------------------------ main

function budget() {
  const rel = path.relative(root, outDir);
  let files;
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', rel], { cwd: root }).toString();
    files = out.split('\n').filter(Boolean).map((l) => path.join(root, l.slice(3).trim().replace(/^"|"$/g, ''))).filter((f) => fs.existsSync(f));
  } catch {
    files = fs.readdirSync(outDir).map((f) => path.join(outDir, f));
  }
  const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  log(`changed files in ${rel}: ${files.length}, ${(total / 1048576).toFixed(2)} MB (budget ${TOTAL_BUDGET / 1048576} MB)`);
  for (const f of files.sort()) log(`  ${(fs.statSync(f).size / 1024).toFixed(0).padStart(6)} KB  ${path.relative(root, f)}`);
  if (total > TOTAL_BUDGET) failures.push(`budget: ${(total / 1048576).toFixed(2)} MB of changed files in ${rel}, over ${TOTAL_BUDGET / 1048576} MB`);
}

async function main() {
  if (!argv.includes('--no-build')) {
    const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  mkdirp(work); mkdirp(outDir);
  log(`work folder ${work}`);
  Media = await prepareMedia();
  if (fakeWhisper) {
    // No real speech-to-text model here: whisper.cpp's test model and a stand-in engine (tests/helpers/fakeWhisper.cjs).
    const { buildTestWhisperModel } = await bundleHelper('whisperModel');
    testModel = buildTestWhisperModel();
    const sha = crypto.createHash('sha256').update(testModel).digest('hex');
    const fake = path.join(mkdirp(path.join(work, 'fake-whisper')), 'whisper-cli');
    fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "whisper.cpp version: 1.9.5"; exit 0; fi\nexec node "${path.join(root, 'tests/helpers/fakeWhisper.cjs')}" "$@"\n`, { mode: 0o755 });
    whisperEnv = { RECUT_WHISPER_CLI: fake, RECUT_WHISPER_MODEL_URL: 'http://127.0.0.1:9/models/', RECUT_WHISPER_TEST_MODEL: `${testModel.length}:${sha}` };
  } else if (wanted('demo-whisper') && !Media.model) {
    throw new Error('demo-whisper needs a Whisper model: put ggml-base.en.bin in --media or pass --whisper-model');
  }
  log(`search word: "${searchWord()}"`);
  await stills();
  await demos();
  budget();
  if (failures.length) {
    console.log(`[readme-media] ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  log(`done: ${written.length} files`);
}

main().catch((e) => { console.error('[readme-media]', e); process.exit(1); });
