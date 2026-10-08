#!/usr/bin/env node
// The ReCut tester kit: open-movie media, deliberately awkward files, two ready projects and plain-language docs, in one
// zip for friends who test a release without using their own files. Run on CI by .github/workflows/tester-kit.yml.
//
//   node scripts/tester-kit.mjs --sources <dir> [--out <dir>] [--work <dir>] [--zip]
//   node scripts/tester-kit.mjs --synthetic [--out <dir>] [--zip]        (small generated stand-ins, for local runs)
//
// --sources holds the downloads (see the workflow): tos.mov, tos-en.srt, tos-de.srt (Tears of Steel), sintel.mkv (its
// English and French subtitles are taken from its own tracks) and, optionally, sintel-me.flac (Sintel's music-and-
// effects track), bbb.mov (Big Buck Bunny) and ed.mov (Elephants Dream). --out gets the kit folder (ReCut-Tester-Kit-<version>/) and, with --zip, the zip.
// --work keeps encodes and analysis between runs (the four films are re-encoded only when their source or settings
// change). Every FFmpeg failure, missing input, unexpected probe result or budget overrun stops the build.
//
// Everything is deterministic where practical: fixed encoder settings and thread counts, no metadata from the sources,
// fixed time and ids in the projects, sorted zip entries with fixed dates.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const synthetic = argv.includes('--synthetic');
const sourcesArg = flag('--sources');
if (!synthetic && !sourcesArg) { console.error('tester-kit: pass --sources <dir> or --synthetic'); process.exit(2); }

/** The ReCut release the kit is for (its docs name it; the projects are written by this checkout's code). */
const KIT_VERSION = flag('--version') ?? '0.9.0';
const KIT_NAME = `ReCut-Tester-Kit-${KIT_VERSION}`;
const outDir = path.resolve(flag('--out') ?? path.join(repo, 'build', 'tester-kit'));
const work = path.resolve(flag('--work') ?? path.join(outDir, '..', synthetic ? 'tester-kit-work-synthetic' : 'tester-kit-work'));
const kit = path.join(outDir, KIT_NAME);
const zipPath = path.join(outDir, `${KIT_NAME}.zip`);
/** Hard limit for the zip; the owner asked for about 600-800 MB. */
const ZIP_BUDGET = synthetic ? 200 * 1024 * 1024 : 800 * 1024 * 1024;
const ZIP_LOW = synthetic ? 0 : 500 * 1024 * 1024;
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
/** Synthetic runs shorten the long things (the two-hour file becomes three minutes). */
const LONG_SECONDS = synthetic ? 180 : 7200;
const THREADS = '4';

const log = (...a) => console.log('[tester-kit]', ...a);
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdirp = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ------------------------------------------------------------------------------------------------ FFmpeg

/** Run FFmpeg; any non-zero exit (or an error line with -xerror) throws with the end of stderr. */
function ff(args, { what } = {}) {
  const full = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args];
  const r = spawnSync(FFMPEG, full, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`ffmpeg could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed${what ? ` (${what})` : ''}: ${FFMPEG} ${full.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ').slice(0, 1500)}\n${(r.stderr || '').slice(-3000)}`);
  return r;
}
/** FFmpeg writing raw output to stdout (Buffer). */
function ffOut(args, what) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${what}): ${String(r.stderr).slice(-2000)}`);
  return r.stdout;
}
function probe(file) {
  return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { maxBuffer: 1 << 26 }).toString());
}
const duration = (file) => Number(probe(file).format.duration);
/** Common output flags: no metadata or chapters copied from the sources, bit-exact muxing (no encoder version strings). */
const CLEAN = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'];
const X264 = (crf, extra = []) => ['-c:v', 'libx264', '-preset', synthetic ? 'veryfast' : 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', THREADS, ...extra];
const AAC = (kbps = 160, ch = 2) => ['-c:a', 'aac', '-b:a', `${kbps}k`, '-ac', String(ch), '-ar', '48000'];

function requireEncoders() {
  const enc = execFileSync(FFMPEG, ['-hide_banner', '-encoders']).toString();
  const fil = execFileSync(FFMPEG, ['-hide_banner', '-filters']).toString();
  const need = ['libx264', 'libx265', 'prores_ks', 'dnxhd', 'dvdsub', 'aac', 'ac3', 'flac', 'libmp3lame', 'pcm_s24le', 'png', 'mjpeg', 'srt'];
  const missing = need.filter((e) => !new RegExp(`^\\s*[VAS][.A-Z]{5}\\s+${e}\\s`, 'm').test(enc));
  if (!/\sdrawtext\s/.test(fil)) missing.push('drawtext filter');
  if (missing.length) throw new Error(`this FFmpeg lacks: ${missing.join(', ')} (${FFMPEG}; use the repo's bundled build: scripts/linux/get-ffmpeg.sh)`);
  log('ffmpeg:', execFileSync(FFMPEG, ['-hide_banner', '-version']).toString().split('\n')[0]);
}

let ffMajor = null;
function ffmpegMajor() {
  if (ffMajor === null) { const m = /version n?(\d+)\./.exec(execFileSync(FFMPEG, ['-hide_banner', '-version']).toString()); ffMajor = m ? Number(m[1]) : 0; }
  return ffMajor;
}

function fontFile() {
  for (const f of ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf']) {
    if (fs.existsSync(f)) return f;
  }
  throw new Error('no DejaVu Sans font (install fonts-dejavu-core)');
}
/** A drawtext filter with the font and text read from a file (no filtergraph escaping of the text). */
let textSeq = 0;
function drawtext(text, opts) {
  const f = path.join(mkdirp(path.join(work, 'text')), `t${textSeq++}.txt`);
  fs.writeFileSync(f, text);
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  return `drawtext=fontfile='${esc(fontFile())}':textfile='${esc(f)}':${opts}`;
}

// ------------------------------------------------------------------------------------------------ the TypeScript side

async function loadLib() {
  const esbuild = await import('esbuild');
  const outfile = path.join(mkdirp(path.join(work, 'lib')), 'kit-lib.mjs');
  await esbuild.build({
    entryPoints: [path.join(repo, 'scripts', 'tester-kit', 'entry.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20',
    outfile, logLevel: 'warning', nodePaths: [path.join(repo, 'node_modules')], tsconfig: path.join(repo, 'tsconfig.json'),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

// ------------------------------------------------------------------------------------------------ films

const FILMS = [
  { key: 'tos', title: 'Tears of Steel', year: 2012, src: 'tos.mov', subs: { en: 'tos-en.srt', de: 'tos-de.srt' }, maxrate: 1300, characters: ['Celia', 'Thom'], location: 'Amsterdam' },
  // Sintel's official subtitles are tracks inside the official 720p MKV (download.blender.org/durian/subs/ has
  // translations only): `embedded` names the track language each file is extracted from.
  { key: 'sintel', title: 'Sintel', year: 2010, src: 'sintel.mkv', subs: { en: 'sintel-en.srt', fr: 'sintel-fr.srt' }, embedded: { en: 'eng', fr: 'fre' }, maxrate: 950, characters: ['Sintel', 'Scales'], location: 'The mountains' },
  { key: 'bbb', title: 'Big Buck Bunny', year: 2008, src: 'bbb.mov', subs: {}, maxrate: 1000, characters: ['Big Buck Bunny'], location: 'The meadow' },
  { key: 'ed', title: 'Elephants Dream', year: 2006, src: 'ed.mov', subs: {}, maxrate: 900, characters: ['Proog', 'Emo'], location: 'The machine' },
];
const filmName = (f) => `${f.title} (${f.year})`;

/** Synthetic stand-ins: 90 s per film, with cuts, tones and made-up subtitles (never shipped). */
function makeSyntheticSources(dir) {
  mkdirp(dir);
  const scenes = ['testsrc2', 'smptehdbars', 'rgbtestsrc', 'pal75bars', 'testsrc', 'yuvtestsrc'];
  const freqs = { tos: 330, sintel: 440, bbb: 550, ed: 660 };
  for (const f of FILMS) {
    const out = path.join(dir, f.src);
    for (const lang of Object.keys(f.subs)) {
      const cues = [];
      for (let t = 0, i = 1; t < 45; t += 5, i++) cues.push(`${i}\n00:00:${String(t).padStart(2, '0')},100 --> 00:00:${String(t).padStart(2, '0')},900\n[${lang}] ${f.title} line ${i}, about the dragon\n`);
      fs.writeFileSync(path.join(dir, f.subs[lang]), cues.join('\n'));
    }
    if (fs.existsSync(out)) continue;
    const inputs = scenes.flatMap((s) => ['-f', 'lavfi', '-i', `${s}=s=1280x720:r=24:d=15`]);
    const graph = `${scenes.map((_, i) => `[${i}:v]format=yuv420p,setsar=1[v${i}]`).join(';')};${scenes.map((_, i) => `[v${i}]`).join('')}concat=n=${scenes.length}:v=1:a=0[v]`;
    // "Speech": a 1 s tone burst every 5 s in the first 45 s (where the subtitles are), over a second tone ("music").
    const audio = `aevalsrc='0.3*sin(2*PI*${freqs[f.key]}*t)*lt(mod(t\\,5)\\,1)*lt(t\\,45)|0.3*sin(2*PI*${freqs[f.key]}*t)*lt(mod(t\\,5)\\,1)*lt(t\\,45)':s=48000:d=90`;
    ff([...inputs, '-f', 'lavfi', '-i', audio, '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=90', '-filter_complex', `${graph};[6:a][7:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k', out], { what: `synthetic ${f.key}` });
  }
  // A music-and-effects track for Sintel: the "music" tone only, so mix minus it is the "speech".
  const me = path.join(dir, 'sintel-me.flac');
  if (!fs.existsSync(me)) ff(['-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=90', '-af', 'aformat=channel_layouts=stereo', '-c:a', 'flac', me]);
}

/** Normalised official subtitles (UTF-8, no BOM, CRLF), checked with ReCut's own parser. */
function prepareSubtitles(L, src) {
  const out = {};
  for (const f of FILMS) {
    out[f.key] = {};
    for (const [lang, file] of Object.entries(f.subs)) {
      let p = path.join(src, file);
      if (!fs.existsSync(p) && f.embedded?.[lang]) {
        // The film's own subtitle track in that language (exactly one), as SRT.
        const input = path.join(src, f.src);
        const tracks = probe(input).streams.filter((x) => x.codec_type === 'subtitle' && x.tags?.language === f.embedded[lang]);
        if (tracks.length !== 1) throw new Error(`${f.src}: ${tracks.length} subtitle tracks in ${f.embedded[lang]}, want 1`);
        p = path.join(mkdirp(path.join(work, 'subs')), file);
        ff(['-i', input, '-map', `0:${tracks[0].index}`, '-c:s', 'srt', '-f', 'srt', p], { what: `extract ${file}` });
        log(`${file}: extracted from ${f.src} (stream ${tracks[0].index}, ${f.embedded[lang]})`);
      }
      if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
      const text = L.normalizeSubtitleBytes(fs.readFileSync(p));
      const { cues, warnings } = L.readCues(text);
      if (!cues.length) throw new Error(`${file}: no cues`);
      if (warnings.length) throw new Error(`${file}: ReCut's parser warns: ${warnings.join('; ')}`);
      out[f.key][lang] = { cues, text: L.writeSrt(cues) };
    }
  }
  return out;
}

/** Encode the four films for franchise/ (cached in <work>/films by source size and settings). */
function encodeFilms(src) {
  const dir = mkdirp(path.join(work, 'films'));
  const res = {};
  for (const f of FILMS) {
    const input = path.join(src, f.src);
    if (!fs.existsSync(input)) throw new Error(`missing source ${input}`);
    const v = probe(input).streams.find((s) => s.codec_type === 'video');
    // 720p: 1280 wide (Elephants Dream is published at 1024x576 at most on download.blender.org, so it is upscaled).
    const scale = v.width !== 1280 ? ['scale=w=1280:h=-2:flags=lanczos'] : [];
    const args = ['-i', input, '-map', '0:v:0', '-map', '0:a:0', '-vf', [...scale, 'format=yuv420p'].join(','),
      ...X264(23, ['-maxrate', `${f.maxrate}k`, '-bufsize', `${2 * f.maxrate}k`, '-profile:v', 'high', '-g', '48']),
      ...AAC(128), ...CLEAN, '-movflags', '+faststart'];
    const stamp = sha(JSON.stringify([fs.statSync(input).size, args.slice(2), synthetic]));
    const out = path.join(dir, `${f.key}-${stamp}.mp4`);
    if (!fs.existsSync(out)) {
      log(`encoding ${f.title} (${f.src}, ${duration(input).toFixed(0)} s)`);
      const t0 = Date.now();
      ff([...args, `${out}.part.mp4`], { what: `encode ${f.title}` });
      fs.renameSync(`${out}.part.mp4`, out);
      log(`  ${f.title}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    } else log(`cached encode of ${f.title}: ${path.basename(out)}`);
    res[f.key] = out;
    // Drop encodes of this film made with other settings (the CI cache keeps only what this build uses).
    for (const old of fs.readdirSync(dir)) if (old.startsWith(`${f.key}-`) && !old.startsWith(path.basename(out))) fs.rmSync(path.join(dir, old), { force: true });
  }
  return res;
}

/** Per-frame scene score and mean luma of an encode (cached next to it). */
function frameStats(L, file) {
  const cache = `${file}.stats.json`;
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-an', '-vf',
    "scale=160:-2,select='gte(scene\\,0)',signalstats,metadata=print:file=-", '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`frame analysis of ${file} failed: ${r.stderr.slice(-1500)}`);
  const stats = L.parseFrameStats(r.stdout);
  if (stats.length < 100) throw new Error(`frame analysis of ${file}: only ${stats.length} frames`);
  fs.writeFileSync(cache, JSON.stringify(stats));
  return stats;
}

// ------------------------------------------------------------------------------------------------ Sintel's dialogue

/** Mono float samples of a file's first audio stream (`from`/`len` seconds, `rate` Hz). */
function pcm(file, { from = 0, len, rate, stream = '0:a:0', channel = null }) {
  const af = channel === null ? ['-ac', '1'] : ['-af', `pan=mono|c0=c${channel}`];
  const buf = ffOut(['-ss', String(from), '-t', String(len), '-i', file, '-map', stream, ...af, '-ar', String(rate), '-f', 'f32le', '-'], `decode ${path.basename(file)}`);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}
function bestLag(a, b, center, radius) {
  // The lag (in samples, within center +- radius) at which b best matches a: a[i] ~ b[i - lag].
  let best = center, bestV = -Infinity;
  for (let lag = center - radius; lag <= center + radius; lag++) {
    let s = 0, na = 0, nb = 0;
    for (let i = Math.max(0, lag); i < a.length && i - lag < b.length; i++) { const x = a[i], y = b[i - lag]; s += x * y; na += x * x; nb += y * y; }
    const v = s / Math.sqrt(na * nb + 1e-12);
    if (v > bestV) { bestV = v; best = lag; }
  }
  return { lag: best, corr: bestV };
}

/**
 * Sintel's music-and-effects track (sintel-m+e-st.flac, published with the film) lined up with the film's own mix:
 * the offset from the waveforms, then the fold of the film's channels that matches the M&E, then how much is left
 * when the M&E is taken away in stretches without dialogue. Clean (residual at most -20 dB) means the folded film
 * minus the M&E is the dialogue alone.
 */
function alignSintelMe(L, sintelFile, meFile, cues) {
  if (!meFile) return { ok: false, why: 'no sintel-me.flac' };
  const total = Math.min(duration(sintelFile), duration(meFile));
  const env = (x, hop) => { const out = new Float32Array(Math.floor(x.length / hop)); for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < hop; k++) { const v = x[i * hop + k]; s += v * v; } out[i] = Math.sqrt(s / hop); } return out; };
  const span = Math.min(240, total - 20);
  const a8 = pcm(sintelFile, { from: 10, len: span, rate: 8000 }), b8 = pcm(meFile, { from: 10, len: span, rate: 8000 });
  const coarse = bestLag(env(a8, 80), env(b8, 80), 0, 300); // 10 ms steps, up to +-3 s
  const lag8 = bestLag(a8.subarray(0, 8000 * 60), b8.subarray(0, 8000 * 60), coarse.lag * 80, 120).lag; // 1/8000 s steps
  // Sample-accurate at 48 kHz around the 8 kHz estimate, in a stretch without dialogue.
  const quiet = L.quietSpans(cues, 10, total - 10, 8);
  if (!quiet.length) return { ok: false, why: 'no stretch without dialogue to measure' };
  const [q0] = quiet[Math.floor(quiet.length / 2)];
  const a48 = pcm(sintelFile, { from: q0, len: 6, rate: 48000 });
  const b48 = pcm(meFile, { from: Math.max(0, q0 - lag8 / 8000 - 0.01), len: 6.02, rate: 48000 });
  // b48 starts 10 ms + lag earlier: a48[i] ~ b48[i + 480 + 0] when the 8 kHz estimate is exact.
  const base = 480;
  let best = { off: base, v: -Infinity };
  for (let off = base - 12; off <= base + 12; off++) {
    let s = 0, na = 0, nb = 0;
    for (let i = 0; i < a48.length - 600; i++) { const x = a48[i], y = b48[i + off]; s += x * y; na += x * x; nb += y * y; }
    const v = s / Math.sqrt(na * nb + 1e-12);
    if (v > best.v) best = { off, v };
  }
  const offsetSec = lag8 / 8000 - (best.off - base) / 48000; // the M&E is played this much later than the mix
  // The M&E is a stereo fold of the music and effects; the film's track may be 5.1. Find, per M&E channel, the mix of
  // the film's channels that matches it best (least squares over the stretches without dialogue): with the same
  // master, the film folded that way minus the M&E is the dialogue. Fitted on every other stretch, measured on the rest.
  const nch = probe(sintelFile).streams.find((x) => x.codec_type === 'audio')?.channels ?? 2;
  // 5-second pieces of the quiet stretches, at most 16, spread over the film.
  const pieces = quiet.flatMap(([a, b]) => { const out = []; for (let t = a; t + 5 <= b; t += 5) out.push([t, t + 5]); return out; });
  const spans = pieces.filter((_, i) => i % Math.max(1, Math.floor(pieces.length / 16)) === 0).slice(0, 16);
  const decode = (file, from, ch) => {
    const buf = ffOut(['-ss', String(from), '-t', '5', '-i', file, '-map', '0:a:0', '-ac', String(ch), '-ar', '48000', '-f', 'f32le', '-'], `decode ${path.basename(file)}`);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  };
  const blocks = spans.map(([a]) => ({ x: decode(sintelFile, a, nch), y: decode(meFile, a - offsetSec, 2) }));
  const fold = [0, 1].map((oc) => {
    const A = Array.from({ length: nch }, () => new Float64Array(nch)), b = new Float64Array(nch);
    blocks.forEach(({ x, y }, k) => {
      if (k % 2) return;
      const n = Math.min(x.length / nch, y.length / 2);
      for (let t = 0; t < n; t++) {
        const target = y[t * 2 + oc];
        for (let i = 0; i < nch; i++) { const xi = x[t * nch + i]; b[i] += xi * target; for (let j = 0; j < nch; j++) A[i][j] += xi * x[t * nch + j]; }
      }
    });
    for (let i = 0; i < nch; i++) A[i][i] += 1e-6; // a silent channel (LFE in quiet passages) must not make it singular
    return solve(A, b);
  });
  let res = 0, tot = 0;
  blocks.forEach(({ x, y }, k) => {
    if (!(k % 2)) return;
    const n = Math.min(x.length / nch, y.length / 2);
    for (let t = 0; t < n; t++) for (let oc = 0; oc < 2; oc++) {
      let v = 0; for (let i = 0; i < nch; i++) v += fold[oc][i] * x[t * nch + i];
      const r = v - y[t * 2 + oc]; res += r * r; tot += y[t * 2 + oc] ** 2;
    }
  });
  const residualDb = 10 * Math.log10((res + 1e-12) / (tot + 1e-12));
  const out = { ok: residualDb <= -20 && Math.abs(offsetSec) <= 5 && blocks.length >= 4, offsetSec, fold, nch, residualDb, corr: best.v };
  log(`Sintel M&E alignment: offset ${(offsetSec * 1000).toFixed(2)} ms (corr ${best.v.toFixed(3)}), fold of ${nch} channels ${fold.map((w) => `[${Array.from(w, (v) => v.toFixed(3)).join(' ')}]`).join(' ')}, residual ${residualDb.toFixed(1)} dB in ${Math.floor(blocks.length / 2)} held-out quiet stretches -> ${out.ok ? 'clean' : 'not clean'}`);
  return out;
}

/** Solve A x = b (small, symmetric positive definite) by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let v = M[r][n]; for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k]; x[r] = v / M[r][r]; }
  return x;
}

/**
 * Is the centre channel of Sintel's own 5.1 mix the dialogue alone? Its level between the lines (stretches of at
 * least 3 s without an English subtitle, before the end credits) against its level during the lines: at most -20 dB
 * means the centre carries little but the voices, and the film's 5.1 track is the test file as it is.
 */
function centreIsDialogue(L, f) {
  const p = probe(f.source).streams.find((x) => x.codec_type === 'audio');
  if (!p || p.channels !== 6) return { ok: false, why: `the film's sound is ${p?.channel_layout ?? 'missing'}, not 5.1` };
  const rate = 8000;
  const fc = pcm(f.source, { from: 0, len: f.dur, rate, channel: 2 });
  const fl = pcm(f.source, { from: 0, len: f.dur, rate, channel: 0 });
  const end = Math.max(...f.cues.map((c) => c.end)) + 2;
  const level = (x, spans) => { let s = 0, n = 0; for (const [a, b] of spans) for (let i = Math.floor(a * rate); i < Math.min(x.length, b * rate); i++) { s += x[i] * x[i]; n++; } return 10 * Math.log10(s / Math.max(1, n) + 1e-12); };
  const speech = f.cues.filter((c) => c.end <= end).map((c) => [c.start + 0.2, c.end - 0.2]).filter(([a, b]) => b > a);
  const quiet = L.quietSpans(f.cues, 10, end, 3, 1);
  const r = { speechDb: level(fc, speech), quietDb: level(fc, quiet), quietFlDb: level(fl, quiet), quietSeconds: quiet.reduce((n, [a, b]) => n + b - a, 0) };
  r.ok = r.quietSeconds >= 60 && r.quietDb - r.speechDb <= -20;
  log(`Sintel centre channel: ${r.speechDb.toFixed(1)} dB during the lines, ${r.quietDb.toFixed(1)} dB between them (front left ${r.quietFlDb.toFixed(1)} dB), over ${r.quietSeconds.toFixed(0)} s -> ${r.ok ? 'dialogue only' : 'not dialogue only'}`);
  return r;
}

/** -filter_complex inputs for Sintel's dialogue stem (mix minus aligned M&E), stereo, starting at `start`. */
function sintelDialogueArgs(sintelFile, meFile, al, start, len) {
  const pan = al.fold.map((w, oc) => `c${oc}=${w.map((v, i) => `${v.toFixed(6)}*c${i}`).join('+')}`).join('|').replace(/\+-/g, '-');
  return {
    inputs: ['-ss', String(start), '-t', String(len), '-i', sintelFile, '-ss', String(start - al.offsetSec), '-t', String(len), '-i', meFile],
    // The film folded to stereo as the M&E was, minus the M&E, per channel (48 kHz).
    graph: (mix, me, out) => `[${mix}]aresample=48000,pan=stereo|${pan},aformat=sample_fmts=fltp[dmx];[${me}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=-1[dme];[dmx][dme]amix=inputs=2:normalize=0:duration=shortest[${out}]`,
  };
}

// ------------------------------------------------------------------------------------------------ the kit

const rows = [];
const intentionallyBroken = new Set();
function note(rel, purpose, extra = {}) { rows.push({ path: rel, purpose, ...extra }); }
const K = (...p) => path.join(kit, ...p);

async function build() {
  requireEncoders();
  const L = await loadLib();
  const src = synthetic ? path.join(work, 'synthetic-sources') : path.resolve(sourcesArg);
  if (synthetic) makeSyntheticSources(src);
  rmrf(kit); fs.rmSync(zipPath, { force: true });
  for (const d of ['franchise', 'formats', 'audio', 'stills', 'trouble', 'projects']) mkdirp(K(d));

  // ---------------------------------------------------------------- franchise/
  const subs = prepareSubtitles(L, src);
  const enc = encodeFilms(src);
  const film = {};
  for (const f of FILMS) {
    const rel = `franchise/${filmName(f)}.mp4`;
    fs.copyFileSync(enc[f.key], K(rel));
    film[f.key] = { ...f, file: K(rel), source: path.join(src, f.src), dur: duration(K(rel)), cues: subs[f.key].en?.cues ?? [], subtitles: [] };
    note(rel, `${f.title}, the complete film (CC BY, see CREDITS.txt), 720p H.264 / AAC${f.key === 'ed' ? ' (upscaled from the 1024x576 release)' : ''}.`);
    for (const [lang, s] of Object.entries(subs[f.key])) {
      const srel = `franchise/${filmName(f)}.${lang}.srt`;
      fs.writeFileSync(K(srel), s.text);
      film[f.key].subtitles.push(K(srel));
      note(srel, `Official ${langName(lang)} subtitles of ${f.title}${f.embedded?.[lang] ? ' (from the subtitle track of the official MKV)' : ''}, re-saved as UTF-8; attached automatically on import.`);
    }
  }
  const tos = film.tos, sintel = film.sintel, bbb = film.bbb, ed = film.ed;

  // ---------------------------------------------------------------- formats/
  const frames = {};
  for (const f of FILMS) frames[f.key] = frameStats(L, enc[f.key]); // the work copy: its cache file stays out of the kit
  const body = (f) => ({ from: f.dur * 0.06, to: f.dur * 0.8 });
  const brightAt = (f, from, to) => {
    const c = frames[f.key].filter((s) => s.t >= from && s.t <= to).sort((a, b) => b.yavg - a.yavg)[0];
    return c ? c.t : (from + to) / 2;
  };

  const tosMkvLen = synthetic ? 40 : 50;
  const tosW = L.bestWindow(tos.cues, tos.dur, tosMkvLen, { from: 20, to: tos.dur * 0.85 });
  {
    // 3 audio tracks, 2 soft subtitle tracks, chapters.
    const rel = 'formats/Tears of Steel - 3 audio tracks, 2 subtitles, chapters.mkv';
    const dir = mkdirp(path.join(work, 'mkv'));
    const enSrt = path.join(dir, 'en.srt'), deSrt = path.join(dir, 'de.srt');
    for (const [file, cues] of [[enSrt, subs.tos.en.cues], [deSrt, subs.tos.de.cues]]) {
      const w = L.windowCues(cues, tosW, tosMkvLen);
      if (w.length < 3) throw new Error(`only ${w.length} subtitle lines in the multi-track MKV window`);
      fs.writeFileSync(file, L.writeSrt(w));
    }
    const meta = path.join(dir, 'chapters.txt');
    const ch = [[0, 'Opening'], [Math.round(tosMkvLen / 3), 'The argument'], [Math.round((2 * tosMkvLen) / 3), 'Aftermath']];
    fs.writeFileSync(meta, `;FFMETADATA1\n${ch.map(([s, t], i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s * 1000}\nEND=${(i + 1 < ch.length ? ch[i + 1][0] : tosMkvLen) * 1000}\ntitle=${t}\n`).join('')}`);
    ff(['-ss', String(tosW), '-t', String(tosMkvLen), '-i', tos.source, '-i', enSrt, '-i', deSrt, '-i', meta,
      '-filter_complex', '[0:a:0]aresample=48000,asplit=3[a1][a2][a3];[a2]pan=stereo|c0=0.95*c0+0.45*c1|c1=0.45*c0+0.95*c1,acompressor=threshold=-24dB:ratio=3:makeup=2[alt];[a3]pan=stereo|c0=c0-c1|c1=c1-c0,volume=0.8[me]',
      '-map', '0:v:0', '-map', '[a1]', '-map', '[alt]', '-map', '[me]', '-map', '1:0', '-map', '2:0', '-map_metadata', '-1', '-map_chapters', '3',
      '-vf', 'format=yuv420p', ...X264(21, ['-g', '48']), '-c:a:0', 'aac', '-b:a:0', '160k', '-c:a:1', 'ac3', '-b:a:1', '192k', '-c:a:2', 'aac', '-b:a:2', '128k', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Main mix', '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Alternate mix (dialogue boost)',
      '-metadata:s:a:2', 'language=zxx', '-metadata:s:a:2', 'title=Music & effects (centre removed)',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English', '-metadata:s:s:1', 'language=ger', '-metadata:s:s:1', 'title=Deutsch',
      '-disposition:a:0', 'default', '-disposition:s:0', '0', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', K(rel)], { what: rel });
    note(rel, 'Multi-track MKV: audio 1 "Main mix" (AAC), 2 "Alternate mix (dialogue boost)" (AC-3), 3 "Music & effects (centre removed)" (AAC, an approximation made by cancelling the centre); soft subtitles English + German; 3 chapters.', { expect: { video: 1, audio: 3, subtitle: 2, chapters: 3 } });
  }
  {
    // A "DVD rip": 720x480 anamorphic 16:9, AC-3, English and German DVD bitmap subtitles (for OCR).
    const rel = 'formats/Tears of Steel - DVD rip with bitmap subtitles.mkv';
    const len = synthetic ? 40 : 45;
    const after = tosW + tosMkvLen + len <= tos.dur * 0.85;
    const w = L.bestWindow(tos.cues, tos.dur, len, { from: after ? tosW + tosMkvLen : 20, to: tos.dur * 0.85 });
    const dir = mkdirp(path.join(work, 'dvd'));
    const events = (cues) => {
      const out = [];
      for (const c of L.windowCues(cues, w, len)) {
        const prev = out[out.length - 1];
        const start = Math.max(c.start, prev ? prev.end : 0);
        const text = c.text.split('\n').slice(0, 2).map((l) => l.slice(0, 44)).join('\n');
        if (c.end - start > 0.3) out.push({ start, end: c.end, text });
      }
      if (!out.length) throw new Error('no subtitle events for the DVD rip window');
      return out;
    };
    const en = await L.makeBitmapSubsFixture(dir, { codec: 'dvd_subtitle', events: events(subs.tos.en.cues), duration: len, name: 'dvd-en' });
    const de = await L.makeBitmapSubsFixture(dir, { codec: 'dvd_subtitle', events: events(subs.tos.de.cues), duration: len, name: 'dvd-de' });
    ff(['-ss', String(w), '-t', String(len), '-i', tos.source, '-i', en.path, '-i', de.path,
      '-map', '0:v:0', '-map', '0:a:0', '-map', `1:${en.streamIndex}`, '-map', `2:${de.streamIndex}`,
      '-vf', 'scale=1280:-2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,scale=720:480,setsar=32/27,format=yuv420p', ...X264(20, ['-g', '15']),
      '-c:a', 'ac3', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-c:s', 'copy', '-t', String(len),
      '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=ger', ...CLEAN, K(rel)], { what: rel });
    note(rel, 'DVD-style rip: 720x480 anamorphic (16:9), AC-3 stereo, two DVD bitmap subtitle streams (English, German) for Read with OCR.', { expect: { video: 1, audio: 1, subtitle: 2, subtitleCodec: 'dvd_subtitle' } });
  }

  // 5.1 with dialogue alone on the centre channel.
  const meFile = fs.existsSync(path.join(src, 'sintel-me.flac')) ? path.join(src, 'sintel-me.flac') : null;
  const fcOk = centreIsDialogue(L, sintel);
  const al = fcOk.ok ? { ok: false, why: 'not needed' } : alignSintelMe(L, sintel.source, meFile, sintel.cues);
  const centre = {};
  {
    const len = synthetic ? 30 : 40;
    let rel;
    if (fcOk.ok) {
      const w = L.bestWindow(sintel.cues, sintel.dur, len, { from: 30, to: sintel.dur * 0.8 });
      rel = 'formats/Sintel - 5.1 with dialogue on the centre channel.mkv';
      ff(['-ss', String(w), '-t', String(len), '-i', sintel.source, '-map', '0:v:0', '-map', '0:a:0', '-vf', 'format=yuv420p', ...X264(21, ['-g', '48']),
        '-c:a', 'ac3', '-b:a', '448k', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=5.1 (the film\'s own mix)', ...CLEAN, K(rel)], { what: rel });
      centre.desc = "Sintel's own 5.1 mix, whose centre (FC) carries the voices and little else; music and effects are on the other channels";
    } else if (al.ok) {
      const w = L.bestWindow(sintel.cues, sintel.dur, len, { from: 30, to: sintel.dur * 0.8 });
      rel = 'formats/Sintel - 5.1 with dialogue on the centre channel.mkv';
      const d = sintelDialogueArgs(sintel.source, meFile, al, w, len);
      ff([...d.inputs, '-filter_complex', `${d.graph('0:a:0', '1:a:0', 'dlg')};[1:a:0]aresample=48000,aformat=channel_layouts=stereo,asplit=2[me1][me2];` +
        `[dlg]pan=mono|c0=0.5*c0+0.5*c1[c];[me2]pan=mono|c0=0.5*c0+0.5*c1,lowpass=f=120[lfe];` +
        '[me1][c][lfe]amerge=inputs=3,pan=5.1(side)|FL=c0|FR=c1|FC=c2|LFE=c3|SL=0.5*c0|SR=0.5*c1[a]',
      '-map', '0:v:0', '-map', '[a]', '-vf', 'format=yuv420p', ...X264(21, ['-g', '48']), '-c:a', 'ac3', '-b:a', '448k',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=5.1 (dialogue on the centre)', '-t', String(len), ...CLEAN, K(rel)], { what: rel });
      centre.desc = "Sintel's own dialogue alone on the centre (FC); Sintel's published music-and-effects track on the other channels";
    } else {
      // Fallback: Tears of Steel's sound only while someone speaks (silent between lines) on FC, Big Buck Bunny's score
      // (a film with no dialogue) on the others.
      const w = L.bestWindow(tos.cues, tos.dur, len, { from: 20, to: tos.dur * 0.85 });
      const b0 = brightAt(bbb, bbb.dur * 0.3, bbb.dur * 0.6);
      const gate = L.windowCues(tos.cues, w, len).map((c) => `between(t,${(c.start - 0.15).toFixed(2)},${(c.end + 0.25).toFixed(2)})`).join('+') || '0';
      rel = 'formats/Tears of Steel - 5.1 with dialogue on the centre channel.mkv';
      ff(['-ss', String(w), '-t', String(len), '-i', tos.source, '-ss', String(b0), '-t', String(len), '-i', bbb.source,
        '-filter_complex', `[0:a:0]aresample=48000,pan=mono|c0=0.5*c0+0.5*c1,volume='gt(${gate},0)':eval=frame[c];[1:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=0.7,asplit=2[m1][m2];[m2]pan=mono|c0=0.5*c0+0.5*c1,lowpass=f=120[lfe];` +
          '[m1][c][lfe]amerge=inputs=3,pan=5.1(side)|FL=c0|FR=c1|FC=c2|LFE=c3|SL=0.5*c0|SR=0.5*c1[a]',
        '-map', '0:v:0', '-map', '[a]', '-vf', 'format=yuv420p', ...X264(21, ['-g', '48']), '-c:a', 'ac3', '-b:a', '448k',
        '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=5.1 (dialogue on the centre)', '-t', String(len), ...CLEAN, K(rel)], { what: rel });
      centre.desc = "Tears of Steel's sound only while someone speaks (silent between lines) on the centre (FC); Big Buck Bunny's score on the other channels";
    }
    centre.file = path.basename(rel);
    note(rel, `5.1 AC-3 (FL FR FC LFE SL SR): ${centre.desc}. Extract Centre Channel (Dialogue) should leave only the voices.`, { expect: { video: 1, audio: 1, channels: 6 } });
  }

  const clip = (f, len, at) => { const from = at ?? Math.max(body(f).from, Math.min(body(f).to - len, f.dur * 0.35)); return ['-ss', String(from.toFixed(3)), '-t', String(len), '-i', f.source]; };
  {
    const rel = 'formats/Sintel - HEVC.mp4';
    ff([...clip(sintel, 30), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:-2,format=yuv420p', '-c:v', 'libx265', '-preset', synthetic ? 'ultrafast' : 'medium', '-crf', '26',
      '-x265-params', `log-level=error:pools=${THREADS}`, '-tag:v', 'hvc1', ...AAC(128), ...CLEAN, '-movflags', '+faststart', K(rel)], { what: rel });
    note(rel, 'HEVC (H.265) in MP4, tagged hvc1 as Apple devices write it. The preview may need a proxy.', { expect: { videoCodec: 'hevc' } });
  }
  {
    const rel = 'formats/Big Buck Bunny - ProRes 422.mov';
    ff([...clip(bbb, 20), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:720,format=yuv422p10le', '-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0', '-threads', THREADS,
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', ...CLEAN, K(rel)], { what: rel });
    note(rel, 'Apple ProRes 422 (10-bit 4:2:2) with PCM audio: an editing intermediate. Large on purpose.', { expect: { videoCodec: 'prores' } });
  }
  {
    const rel = 'formats/Elephants Dream - DNxHR LB.mov';
    ff([...clip(ed, 20), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:720,format=yuv422p', '-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-threads', THREADS,
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', ...CLEAN, K(rel)], { what: rel });
    note(rel, 'Avid DNxHR LB (8-bit 4:2:2) with PCM audio: another editing intermediate.', { expect: { videoCodec: 'dnxhd' } });
  }
  {
    const rel = 'formats/Big Buck Bunny - vertical 9x16.mp4';
    ff([...clip(bbb, 30, bbb.dur * 0.45), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'crop=ih*9/16:ih,scale=720:1280:flags=lanczos,setsar=1,format=yuv420p', ...X264(22, ['-g', '60']),
      ...AAC(128), ...CLEAN, '-movflags', '+faststart', K(rel)], { what: rel });
    note(rel, 'Vertical 9:16 video (720x1280), as made for phones and social media.', { expect: { width: 720, height: 1280 } });
  }
  {
    // A phone recording: portrait picture stored sideways (1280x720) with a 90-degree display rotation, and a variable
    // frame rate (about 30 fps with irregular gaps, as phones record in low light).
    const rel = 'formats/Sintel - phone clip, VFR, rotated.mp4';
    const tmp = path.join(mkdirp(path.join(work, 'phone')), 'sideways.mp4');
    const at = Math.max(body(sintel).from, sintel.dur * 0.5);
    ff(['-ss', String(at), '-t', '30', '-i', sintel.source, '-map', '0:v:0', '-map', '0:a:0',
      '-vf', "crop=ih*9/16:ih,scale=720:1280,fps=30,transpose=2,select='not(eq(mod(n\\,7)\\,3))*not(eq(mod(n\\,11)\\,5))',format=yuv420p", '-fps_mode', 'vfr',
      ...X264(23, ['-g', '30']), ...AAC(128), ...CLEAN, '-video_track_timescale', '90000', tmp], { what: `${rel} (sideways)` });
    // FFmpeg 7+ sets the display matrix with -display_rotation (the CI build is 9.x). Older ones cannot: the clip is
    // then left unrotated and only a synthetic run accepts that.
    const canRotate = ffmpegMajor() >= 7;
    if (!canRotate && !synthetic) throw new Error(`FFmpeg ${ffmpegMajor()} cannot set a display rotation; use FFmpeg 7 or newer`);
    if (canRotate) ff(['-display_rotation:v:0', '-90', '-i', tmp, '-map', '0', '-c', 'copy', ...CLEAN, '-movflags', '+faststart', K(rel)], { what: `${rel} (rotation)` });
    else { log('note: this FFmpeg cannot set a display rotation; the synthetic phone clip stays sideways'); ff(['-i', tmp, '-map', '0', '-c', 'copy', ...CLEAN, '-movflags', '+faststart', K(rel)], { what: rel }); }
    if (canRotate) {
      // Shown upright, the picture must be the portrait crop it was made from (not sideways or upside down).
      const psnr = (turn) => {
        const stats = path.join(work, 'phone', `psnr-${turn ? 'turned' : 'upright'}.log`);
        fs.rmSync(stats, { force: true });
        const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-ss', '1', '-i', K(rel), '-ss', String(at + 1), '-i', sintel.source, '-filter_complex',
          `[0:v]scale=360:640,format=yuv420p[x];[1:v]crop=ih*9/16:ih${turn ? ',transpose=1,transpose=1' : ''},scale=360:640,format=yuv420p[y];[x][y]psnr=stats_file=${stats.replace(/\\/g, '/').replace(/:/g, '\\:')}[out]`,
          '-map', '[out]', '-frames:v', '1', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
        const m = fs.existsSync(stats) ? /psnr_avg:([0-9.]+|inf)/.exec(fs.readFileSync(stats, 'utf8')) : null;
        if (r.status !== 0 || !m) throw new Error(`orientation check failed: ${r.stderr.slice(-800)}`);
        return m[1] === 'inf' ? 99 : Number(m[1]);
      };
      const upright = psnr(false), turned = psnr(true);
      log(`phone clip orientation: PSNR ${upright.toFixed(1)} dB upright vs ${turned.toFixed(1)} dB upside down`);
      if (!(upright > 15 && upright > turned + 3)) throw new Error(`the phone clip does not show upright (PSNR ${upright.toFixed(1)} vs ${turned.toFixed(1)})`);
    }
    note(rel, 'Phone-style clip: variable frame rate (30 fps nominal, about 23 fps on average, with irregular gaps) and a 90-degree rotation flag (stored 1280x720 sideways, shown upright as 720x1280).', { expect: { vfr: true, ...(canRotate ? { rotation: 90 } : {}) } });
    fs.rmSync(tmp);
  }
  // Frame-rate set, each with its rate and a frame counter burned in.
  const rates = [
    { rel: 'formats/Frame rate 23.976.mp4', f: tos, rate: '24000/1001', label: '23.976 fps' },
    { rel: 'formats/Frame rate 25.mp4', f: ed, rate: '25', label: '25 fps' },
    { rel: 'formats/Frame rate 29.97 drop-frame, timecode 01;00;00;00.mov', f: bbb, rate: '30000/1001', label: '29.97 fps drop-frame', tc: '01:00:00;00' },
    { rel: 'formats/Frame rate 30.mp4', f: sintel, rate: '30', label: '30 fps' },
    { rel: 'formats/Frame rate 60.mp4', f: bbb, rate: '60', label: '60 fps', blend: true },
  ];
  for (const r of rates) {
    const at = r.f === bbb && r.blend ? r.f.dur * 0.2 : undefined;
    const counter = r.tc
      ? drawtext(`${r.label}  `, 'x=24:y=24:fontsize=h/22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8') + `,drawtext=fontfile='${fontFile().replace(/:/g, '\\:')}':timecode='${r.tc.replace(/:/g, '\\:').replace(/;/g, '\\;')}':rate=${r.rate}:x=w-tw-24:y=24:fontsize=h/22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8`
      : drawtext(`${r.label}`, 'x=24:y=24:fontsize=h/22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8') + `,drawtext=fontfile='${fontFile().replace(/:/g, '\\:')}':text='frame %{frame_num}':x=w-tw-24:y=24:fontsize=h/22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8`;
    const conv = r.blend ? `framerate=fps=${r.rate}` : `fps=${r.rate}`;
    ff([...clip(r.f, 30, at), '-map', '0:v:0', '-map', '0:a:0', '-vf', `scale=1280:-2,${conv},${counter},format=yuv420p`, '-r', r.rate, ...X264(22, ['-g', '48']), ...AAC(128),
      ...(r.tc ? ['-timecode', r.tc] : []), ...CLEAN, '-movflags', '+faststart', K(r.rel)], { what: r.rel });
    note(r.rel, `${r.label}${r.tc ? `, with a timecode track starting at ${r.tc} (shown top right)` : ' (frame number shown top right)'}${r.blend ? '; in-between frames are blends' : ''}.`, { expect: { fps: r.rate, ...(r.tc ? { timecode: r.tc } : {}) } });
  }
  {
    const rel = 'formats/Big Buck Bunny - 4K UHD.mp4';
    ff([...clip(bbb, 20, bbb.dur * 0.6), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=3840:2160:flags=lanczos,format=yuv420p',
      ...X264(20, ['-maxrate', '16M', '-bufsize', '32M', '-level', '5.1', '-g', '48']), ...AAC(160), ...CLEAN, '-movflags', '+faststart', K(rel)], { what: rel });
    note(rel, '4K UHD (3840x2160) H.264, upscaled from 720p. Heavy to preview: proxies help.', { expect: { width: 3840, height: 2160 } });
  }

  // ---------------------------------------------------------------- audio/
  {
    const len = synthetic ? 30 : 40;
    const w = L.bestWindow(sintel.cues, sintel.dur, len, { from: Math.min(60, sintel.dur * 0.1), to: sintel.dur * 0.8 });
    const base = 'audio/Sintel - score and dialogue';
    const af = ['-af', `afade=t=in:d=0.5,afade=t=out:st=${len - 1}:d=1`];
    const inp = ['-ss', String(w), '-t', String(len), '-i', sintel.source, '-map', '0:a:0', '-ac', '2', '-ar', '48000', ...af, ...CLEAN];
    ff([...inp, '-c:a', 'pcm_s24le', K(`${base}.wav`)], { what: 'wav' });
    ff([...inp, '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0', K(`${base}.mp3`)], { what: 'mp3' });
    ff([...inp, '-c:a', 'flac', '-sample_fmt', 's16', K(`${base}.flac`)], { what: 'flac' });
    ff([...inp, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', K(`${base}.m4a`)], { what: 'm4a' });
    note(`${base}.wav`, `${len} s of Sintel (music and speech) as WAV (24-bit PCM).`, { expect: { audioCodec: 'pcm_s24le' } });
    note(`${base}.mp3`, 'The same excerpt as MP3 (192 kbps).', { expect: { audioCodec: 'mp3' } });
    note(`${base}.flac`, 'The same excerpt as FLAC (lossless, 16-bit).', { expect: { audioCodec: 'flac' } });
    note(`${base}.m4a`, 'The same excerpt as AAC in an .m4a file.', { expect: { audioCodec: 'aac' } });
  }
  let dialogueFile;
  {
    const len = synthetic ? 20 : 30;
    if (fcOk.ok) {
      const w = L.bestWindow(sintel.cues, sintel.dur, len, { from: 30, to: sintel.dur * 0.8 });
      dialogueFile = 'Sintel - dialogue only.wav';
      ff(['-ss', String(w), '-t', String(len), '-i', sintel.source, '-map', '0:a:0', '-af', `pan=mono|c0=c2,afade=t=in:d=0.2,afade=t=out:st=${len - 0.5}:d=0.5`, '-c:a', 'pcm_s16le', '-ar', '48000', ...CLEAN, K('audio', dialogueFile)], { what: dialogueFile });
      note(`audio/${dialogueFile}`, "Sintel's voices: the centre channel of the film's own 5.1 mix, as a mono file.", { expect: { audioCodec: 'pcm_s16le' } });
    } else if (al.ok) {
      const w = L.bestWindow(sintel.cues, sintel.dur, len, { from: 30, to: sintel.dur * 0.8 });
      dialogueFile = 'Sintel - dialogue only.wav';
      const d = sintelDialogueArgs(sintel.source, meFile, al, w, len);
      ff([...d.inputs, '-filter_complex', `${d.graph('0:a:0', '1:a:0', 'dlg')};[dlg]afade=t=in:d=0.2,afade=t=out:st=${len - 0.5}:d=0.5[a]`, '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', '-t', String(len), ...CLEAN, K('audio', dialogueFile)], { what: dialogueFile });
      note(`audio/${dialogueFile}`, "Sintel's voices only: the film's mix minus its published music-and-effects track.", { expect: { audioCodec: 'pcm_s16le' } });
    } else {
      const w = L.bestWindow(tos.cues, tos.dur, len, { from: 20, to: tos.dur * 0.85 });
      dialogueFile = 'Tears of Steel - dialogue lines only.wav';
      const gate = L.windowCues(tos.cues, w, len).map((c) => `between(t,${(c.start - 0.15).toFixed(2)},${(c.end + 0.25).toFixed(2)})`).join('+') || '0';
      ff(['-ss', String(w), '-t', String(len), '-i', tos.source, '-map', '0:a:0', '-af', `aresample=48000,volume='gt(${gate},0)':eval=frame`, '-ac', '2', '-c:a', 'pcm_s16le', ...CLEAN, K('audio', dialogueFile)], { what: dialogueFile });
      note(`audio/${dialogueFile}`, "Tears of Steel's sound only while someone speaks, silent between the lines.", { expect: { audioCodec: 'pcm_s16le' } });
    }
  }
  {
    const rel = 'audio/Tone 1 kHz at -20 dBFS.wav';
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t)':s=48000:d=30", '-c:a', 'pcm_s24le', ...CLEAN, K(rel)], { what: rel });
    note(rel, 'A steady 1 kHz sine at -20 dBFS (peak), 30 s, 24-bit stereo: for checking levels and meters.', { expect: { audioCodec: 'pcm_s24le' } });
  }
  {
    const rel = 'audio/Silence, then a sudden loud burst.wav';
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=20', '-f', 'lavfi', '-i', 'anoisesrc=r=48000:c=pink:a=0.9:d=1.5:seed=7', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=8.5',
      '-filter_complex', '[1:a]aformat=channel_layouts=stereo[n];[0:a][n][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]', '-c:a', 'pcm_s16le', ...CLEAN, K(rel)], { what: rel });
    note(rel, '20 s of digital silence, then 1.5 s of loud pink noise (near full scale), then silence: for waveforms, meters and loudness.', { expect: { audioCodec: 'pcm_s16le' } });
  }

  // ---------------------------------------------------------------- stills/
  const titleCard = K('stills', 'Title card (transparent).png');
  {
    const t1 = drawtext('OPEN MOVIE SAGA', 'x=(w-tw)/2:y=h*0.36:fontsize=150:fontcolor=white:borderw=6:bordercolor=black@0.85:shadowx=8:shadowy=8:shadowcolor=black@0.5');
    const t2 = drawtext('Four worlds. One fan edit.', 'x=(w-tw)/2:y=h*0.58:fontsize=64:fontcolor=0xffcc33:borderw=4:bordercolor=black@0.85');
    ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=1920x1080:r=1,format=rgba', '-vf', `${t1},${t2}`, '-frames:v', '1', '-c:v', 'png', ...CLEAN, titleCard], { what: 'title card' });
    note('stills/Title card (transparent).png', '1920x1080 PNG title with a transparent background (alpha): put it on V2 over a shot.', { expect: { pixFmt: 'rgba' } });
  }
  {
    const t = brightAt(sintel, sintel.dur * 0.3, sintel.dur * 0.7);
    ff(['-ss', String(t), '-i', sintel.source, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '2', ...CLEAN, K('stills', 'Sintel - frame grab.jpg')], { what: 'frame grab' });
    note('stills/Sintel - frame grab.jpg', 'A JPEG frame grab from Sintel (1280 wide).', { expect: { videoCodec: 'mjpeg' } });
    const b = brightAt(bbb, bbb.dur * 0.3, bbb.dur * 0.7);
    ff(['-ss', String(b), '-i', bbb.source, '-frames:v', '1', '-vf', 'scale=7680:4320:flags=lanczos', '-q:v', '4', ...CLEAN, K('stills', '8K still (7680x4320).jpg')], { what: '8K still' });
    note('stills/8K still (7680x4320).jpg', 'An 8K (7680x4320) JPEG, upscaled from Big Buck Bunny: a very large still.', { expect: { width: 7680, height: 4320 } });
    ff(['-ss', String(b), '-i', bbb.source, '-frames:v', '1', '-vf', 'scale=64:36:flags=area', ...CLEAN, K('stills', 'Tiny 64x36.png')], { what: 'tiny still' });
    note('stills/Tiny 64x36.png', 'A tiny 64x36 PNG: should scale up cleanly, not break the layout.', { expect: { width: 64, height: 36 } });
  }

  // ---------------------------------------------------------------- trouble/
  {
    const tmp = mkdirp(path.join(work, 'trouble'));
    const whole = path.join(tmp, 'whole.mp4');
    ff([...clip(bbb, 30), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:-2,format=yuv420p', ...X264(23, ['-g', '48']), ...AAC(128), ...CLEAN, '-movflags', '+faststart', whole], { what: 'trouble source' });
    const bytes = fs.readFileSync(whole);
    fs.writeFileSync(K('trouble', 'Truncated download.mp4'), bytes.subarray(0, Math.floor(bytes.length * 0.45)));
    intentionallyBroken.add('trouble/Truncated download.mp4');
    note('trouble/Truncated download.mp4', 'A 30 s MP4 cut off after 45% of its bytes (an unfinished download): it opens, but the picture and sound stop early.', { broken: 'truncated' });
    const noIndex = path.join(tmp, 'noindex.mp4');
    ff([...clip(ed, 20), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:-2,format=yuv420p', ...X264(23, ['-g', '48']), ...AAC(128), ...CLEAN, noIndex], { what: 'no index source' });
    const nb = fs.readFileSync(noIndex);
    const moov = nb.lastIndexOf(Buffer.from('moov'));
    if (moov < nb.length / 2) throw new Error('expected the moov box at the end of the file');
    fs.writeFileSync(K('trouble', 'Broken file (no index).mp4'), nb.subarray(0, moov - 4));
    intentionallyBroken.add('trouble/Broken file (no index).mp4');
    note('trouble/Broken file (no index).mp4', 'An MP4 whose index (moov box) is missing: no program can read it. ReCut should refuse it with a clear message.', { broken: 'unreadable' });
  }
  {
    const rel = 'trouble/Video only (no audio).mp4';
    ff([...clip(ed, 20), '-map', '0:v:0', '-an', '-vf', 'scale=1280:-2,format=yuv420p', ...X264(23), ...CLEAN, '-movflags', '+faststart', K(rel)], { what: rel });
    note(rel, 'Picture with no sound track at all.', { expect: { video: 1, audio: 0 } });
    const rel2 = 'trouble/Audio only (no video).mp4';
    ff([...clip(tos, 30, tosW), '-map', '0:a:0', '-vn', ...AAC(128), ...CLEAN, '-movflags', '+faststart', K(rel2)], { what: rel2 });
    note(rel2, 'An .mp4 that holds sound only (no picture), as some downloads do.', { expect: { video: 0, audio: 1 } });
    const rel3 = 'trouble/One frame.mp4';
    ff(['-ss', String(brightAt(sintel, sintel.dur * 0.2, sintel.dur * 0.5)), '-i', sintel.source, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=1280:-2,format=yuv420p', '-r', '24', ...X264(20), ...CLEAN, K(rel3)], { what: rel3 });
    note(rel3, 'A video that is exactly one frame long (1/24 s).', { expect: { video: 1, audio: 0, frames: 1 } });
    const rel4 = 'trouble/Café Ünïcödé – fan édit 🎬.mp4'.normalize('NFC');
    ff([...clip(sintel, 20, sintel.dur * 0.25), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:-2,format=yuv420p', ...X264(23), ...AAC(128), ...CLEAN, '-movflags', '+faststart', K(rel4)], { what: 'unicode name' });
    note(rel4, 'A normal clip whose file name has spaces, accents, a dash and an emoji: import, save, reopen, collect and export it.', { expect: { video: 1, audio: 1 } });
  }
  {
    const rel = `trouble/Two hours (long timeline).mp4`;
    const label = drawtext('Long timeline test', 'x=(w-tw)/2:y=h*0.18:fontsize=28:fontcolor=0x9fb3c8');
    const tc = `drawtext=fontfile='${fontFile().replace(/:/g, '\\:')}':timecode='00\\:00\\:00\\:00':rate=24:x=(w-tw)/2:y=(h-th)/2:fontsize=56:fontcolor=white`;
    ff(['-f', 'lavfi', '-i', `color=c=0x203040:s=480x270:r=24:d=${LONG_SECONDS}`, '-f', 'lavfi', '-i', `aevalsrc='0.1*sin(2*PI*1000*t)*lt(mod(t\\,60)\\,0.25)':s=16000:d=${LONG_SECONDS}`,
      '-vf', `${label},${tc},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '36', '-g', '240', '-threads', THREADS,
      '-c:a', 'aac', '-b:a', '24k', '-ac', '1', ...CLEAN, '-movflags', '+faststart', K(rel)], { what: rel });
    note(rel, `${synthetic ? 'Three minutes (synthetic build)' : 'Two hours'} of a running timecode on a plain background, with a short beep every minute: for long timelines, zooming and scrolling.`, { expect: { minDuration: LONG_SECONDS - 1 } });
  }
  {
    const { text, expected } = L.messySrt();
    fs.writeFileSync(K('trouble', 'Messy subtitles.srt'), text);
    const r = L.readCues(text);
    if (r.cues.length !== expected.cues || r.warnings.length !== expected.warnings) throw new Error(`messy SRT: ${r.cues.length} cues / ${r.warnings.length} warnings, expected ${expected.cues} / ${expected.warnings}`);
    note('trouble/Messy subtitles.srt', `Subtitles with problems: blocks out of order, overlapping lines, a missing number, dot milliseconds, an end before its start, an empty line and a line past the video's end. ReCut should keep ${expected.cues} lines and report ${expected.warnings} problems.`);
    const rel = 'trouble/Messy subtitles.mp4';
    ff([...clip(ed, 30, ed.dur * 0.3), '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=1280:-2,format=yuv420p', ...X264(23), ...AAC(128), ...CLEAN, '-movflags', '+faststart', K(rel)], { what: rel });
    note(rel, 'A 30 s clip that the messy subtitles belong to (importing it picks them up).', { expect: { video: 1, audio: 1 } });
  }

  // ---------------------------------------------------------------- projects/
  const lines = (f, n) => {
    const usable = f.cues.filter((c) => c.end - c.start >= 1.2 && c.end - c.start <= 5 && c.start > f.dur * 0.04 && c.end < f.dur * 0.8);
    const out = [];
    for (let i = 0; i < n && usable.length; i++) {
      const c = usable[Math.floor(((i + 0.5) * usable.length) / n)];
      out.push([Math.max(0, +(c.start - 0.3).toFixed(3)), +(c.end + 0.4).toFixed(3)]);
    }
    return out;
  };
  const plan = {
    kitRoot: kit,
    trailerPath: K('projects', 'Open Movie Trailer.recut'),
    startHerePath: K('projects', 'Start here.recut'),
    titleCard,
    franchise: 'Blender Open Movies',
    films: FILMS.map((f) => ({
      key: f.key, title: f.title, year: f.year, file: film[f.key].file, subtitles: film[f.key].subtitles,
      characters: f.characters, location: f.location,
      shots: L.pickShots(frames[f.key], { ...body(film[f.key]), n: 4, minLen: synthetic ? 2 : 2.5, maxLen: 3.5, minLuma: synthetic ? 10 : 35 }),
      lines: f.key === 'tos' ? lines(film.tos, 3) : f.key === 'sintel' ? lines(film.sintel, 2) : [],
    })),
  };
  for (const f of plan.films) if (f.shots.length < 4) throw new Error(`${f.title}: only ${f.shots.length} usable shots for the trailer`);
  const pr = await L.makeProjects(plan);
  log('projects:', JSON.stringify(pr));
  note('projects/Open Movie Trailer.recut', `A ready-made cross-film trailer (${(pr.trailer.durationFrames / 24).toFixed(0)} s at 24 fps): ${pr.trailer.media} media, ${pr.trailer.sequences} sequences (one nested as a compound clip, an alternate cut for Compare), ${pr.trailer.transitions} transitions, keyframes on ${pr.trailer.keyframedClips} clips, ${pr.trailer.markers} markers, ${pr.trailer.subtitleTracks} subtitle tracks. Open it, then Relink › Search folder… on the kit folder.`);
  note('projects/Start here.recut', 'An empty project with one sequence, to start your own edit.');

  // ---------------------------------------------------------------- docs
  const searchTos = L.searchWord(subs.tos.en.cues, [], ['robot', 'robots']);
  const searchSintel = L.searchWord(subs.sintel.en.cues, [], ['dragon', 'scales']);
  const searchBoth = L.searchWord(subs.tos.en.cues, [subs.sintel.en.cues], ['alone', 'remember', 'home', 'sorry', 'help', 'time']);
  if (!searchTos || !searchSintel || !searchBoth) throw new Error('no search words for TRY-THIS (task 2)');
  log(`search words: ${searchBoth} (both), ${searchTos} (Tears of Steel), ${searchSintel} (Sintel)`);
  const docVals = {
    VERSION: KIT_VERSION,
    SEARCH_WORD: searchBoth,
    SEARCH_TOS: searchTos,
    SEARCH_SINTEL: searchSintel,
    CENTRE_FILE: centre.file,
    DIALOGUE_FILE: dialogueFile,
    DIALOGUE_DESC: fcOk.ok ? "is Sintel's voices alone (the centre channel of its 5.1 mix)" : al.ok ? "is Sintel's voices alone (the film's mix minus its music-and-effects track)" : 'has the sound only while someone speaks',
    ME_CREDIT: al.ok ? "\nThe extra sound track\n---------------------\n\n  Sintel's music-and-effects track (sintel-m+e-st.flac, published with the film\n  at download.blender.org/durian/movies/, CC BY 3.0 like all Durian project\n  data) is used for the 5.1 file and the dialogue-only file.\n" : '',
  };
  for (const [name, needs] of [['README-FIRST.txt', ['VERSION']], ['TRY-THIS.md', ['VERSION', 'CENTRE_FILE', 'DIALOGUE_FILE', 'DIALOGUE_DESC', 'SEARCH_WORD', 'SEARCH_TOS', 'SEARCH_SINTEL']], ['REPORTING.md', ['VERSION']], ['CREDITS.txt', ['VERSION', 'ME_CREDIT']], ['TROUBLE.txt', []]]) {
    const tpl = fs.readFileSync(path.join(repo, 'scripts', 'tester-kit', 'docs', name), 'utf8');
    const vals = Object.fromEntries(needs.map((k) => [k, docVals[k]]));
    const target = name === 'TROUBLE.txt' ? K('trouble', name) : K(name);
    fs.writeFileSync(target, L.kitText(L.fillTemplate(tpl, vals)));
  }
  note('README-FIRST.txt', 'Start here: what ReCut is, how to install it on Windows and Mac, what is in the kit.');
  note('TRY-THIS.md', 'Twenty short things to try, one per feature, with the kit files to use.');
  note('REPORTING.md', 'How to report a problem or ask for a feature (templates to copy into a message).');
  note('CREDITS.txt', 'Licences and attribution for the films (CC BY) and everything else in the kit.');
  note('trouble/TROUBLE.txt', 'What each awkward file in trouble/ is for and what a good result looks like.');

  // ---------------------------------------------------------------- check, list, zip
  await validate(L);
  writeManifest(L);
  if (argv.includes('--zip')) makeZip(L);
}

function langName(code) { return { en: 'English', de: 'German', fr: 'French' }[code] ?? code; }

// ------------------------------------------------------------------------------------------------ validation

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}
const MEDIA_EXT = /\.(mp4|mkv|mov|wav|mp3|flac|m4a|png|jpg)$/i;

async function validate(L) {
  const files = walk(kit);
  const listed = new Set(rows.map((r) => r.path));
  const unlisted = files.filter((f) => !listed.has(f) && f !== 'MANIFEST.txt');
  if (unlisted.length) throw new Error(`files without a MANIFEST entry: ${unlisted.join(', ')}`);
  const absent = [...listed].filter((f) => !files.includes(f));
  if (absent.length) throw new Error(`MANIFEST entries without a file: ${absent.join(', ')}`);
  const problems = [];
  for (const r of rows) {
    const abs = K(r.path);
    r.size = fs.statSync(abs).size;
    if (r.size === 0) problems.push(`${r.path}: empty`);
    if (!MEDIA_EXT.test(r.path)) { r.codec = r.path.endsWith('.recut') ? 'ReCut project' : 'text'; continue; }
    if (intentionallyBroken.has(r.path)) {
      r.codec = checkBroken(r, abs, problems);
      continue;
    }
    let p;
    try { p = probe(abs); } catch (e) { problems.push(`${r.path}: ffprobe failed: ${String(e.message).slice(0, 300)}`); continue; }
    const streams = p.streams ?? [];
    const v = streams.filter((s) => s.codec_type === 'video'), a = streams.filter((s) => s.codec_type === 'audio'), s = streams.filter((x) => x.codec_type === 'subtitle');
    const still = /\.(png|jpg)$/i.test(r.path);
    r.duration = still ? null : Number(p.format.duration);
    r.codec = [
      ...v.map((x) => `${x.codec_name} ${x.width}x${x.height}${still ? '' : ` ${fpsText(x)}`}${x.pix_fmt && /rgba|422|10le/.test(x.pix_fmt) ? ` ${x.pix_fmt}` : ''}`),
      ...a.map((x) => `${x.codec_name} ${x.channel_layout ?? `${x.channels}ch`}${x.tags?.language && x.tags.language !== 'und' ? ` ${x.tags.language}` : ''}`),
      ...s.map((x) => `${x.codec_name}${x.tags?.language ? ` ${x.tags.language}` : ''}`),
      ...(p.chapters?.length ? [`${p.chapters.length} chapters`] : []),
    ].join(', ');
    // ReCut's own reading of the file (electron/media/probe.ts), as an import would see it.
    let rp;
    try { rp = await L.probeMedia(abs); } catch (e) { problems.push(`${r.path}: ReCut's probe failed: ${e.message}`); continue; }
    const e = r.expect ?? {};
    const want = (cond, what) => { if (!cond) problems.push(`${r.path}: ${what}`); };
    if (!still && !(r.duration > 0)) problems.push(`${r.path}: no duration`);
    if (/^(formats|audio)\//.test(r.path) && !(r.duration >= 19.5 && r.duration <= 60.5)) problems.push(`${r.path}: ${r.duration?.toFixed(1)} s, outside 20-60 s`);
    if (e.video !== undefined) want(v.length === e.video, `${v.length} video streams, want ${e.video}`);
    if (e.audio !== undefined) want(a.length === e.audio, `${a.length} audio streams, want ${e.audio}`);
    if (e.subtitle !== undefined) want(s.length === e.subtitle, `${s.length} subtitle streams, want ${e.subtitle}`);
    if (e.subtitleCodec) want(s.every((x) => x.codec_name === e.subtitleCodec), `subtitle codec ${s.map((x) => x.codec_name)}`);
    if (e.chapters !== undefined) want((p.chapters?.length ?? 0) === e.chapters, `${p.chapters?.length ?? 0} chapters, want ${e.chapters}`);
    if (e.channels) want(a[0]?.channels === e.channels && (rp.audio[0]?.layout ?? '').startsWith('5.1'), `audio ${a[0]?.channels} channels (${rp.audio[0]?.layout}), want ${e.channels}`);
    if (e.videoCodec) want(v[0]?.codec_name === e.videoCodec, `video codec ${v[0]?.codec_name}, want ${e.videoCodec}`);
    if (e.audioCodec) want(a[0]?.codec_name === e.audioCodec, `audio codec ${a[0]?.codec_name}, want ${e.audioCodec}`);
    if (e.pixFmt) want(v[0]?.pix_fmt === e.pixFmt, `pixel format ${v[0]?.pix_fmt}, want ${e.pixFmt}`);
    if (e.width) want(rp.video?.width === e.width && rp.video?.height === e.height, `ReCut sees ${rp.video?.width}x${rp.video?.height}, want ${e.width}x${e.height}`);
    if (e.vfr) want(rp.video?.isVfr === true, 'ReCut does not see a variable frame rate');
    if (e.rotation) want(rp.video?.rotation === e.rotation && rp.video?.width === 720 && rp.video?.height === 1280, `ReCut sees rotation ${rp.video?.rotation} and ${rp.video?.width}x${rp.video?.height}, want ${e.rotation} and 720x1280`);
    if (e.fps) want(v[0]?.r_frame_rate === (e.fps.includes('/') ? e.fps : `${e.fps}/1`), `frame rate ${v[0]?.r_frame_rate}, want ${e.fps}`);
    if (e.timecode) want(JSON.stringify(p).includes(e.timecode), `no timecode ${e.timecode}`);
    if (e.frames) {
      const n = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', abs]).toString().trim();
      want(Number(n) === e.frames, `${n} frames, want ${e.frames}`);
    }
    if (e.minDuration) want(r.duration >= e.minDuration, `${r.duration} s, want at least ${e.minDuration}`);
    if (r.path.startsWith('franchise/')) want(v[0]?.codec_name === 'h264' && a[0]?.codec_name === 'aac' && v[0]?.width <= 1280, 'franchise film is not 720p H.264 / AAC');
    if (!still && rp.audio?.length && rp.audio.some((x) => !x.channels)) problems.push(`${r.path}: ReCut sees an audio stream without channels`);
    // Decode the whole file once: no decode errors anywhere (the two-hour file only for its first and last minute).
    const decodeArgs = e.minDuration ? ['-t', '60', '-i', abs] : ['-i', abs];
    const d = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', ...decodeArgs, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    // (The null muxer's own timestamp complaints are not decode errors.)
    const errs = d.stderr.split('\n').filter((l) => l.trim() && !/non monotonically increasing dts/.test(l));
    if (d.status !== 0 || errs.length) problems.push(`${r.path}: decode errors: ${errs.join(' | ').slice(0, 400)}`);
  }
  if (problems.length) throw new Error(`kit validation failed:\n  ${problems.join('\n  ')}`);
  log(`validated ${rows.length} files`);
}
function fpsText(s) {
  const [n, d] = String(s.r_frame_rate).split('/').map(Number);
  const v = n / (d || 1);
  return `${Number.isInteger(v) ? v : v.toFixed(3)} fps${s.r_frame_rate !== s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? ' (variable)' : ''}`;
}
/** The broken files must be broken the way TROUBLE.txt says. */
function checkBroken(r, abs, problems) {
  if (r.broken === 'unreadable') {
    const x = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', abs], { encoding: 'utf8' });
    if (x.status === 0 && /codec_type=video/.test(x.stdout)) problems.push(`${r.path}: meant to be unreadable, but ffprobe reads it`);
    return 'unreadable on purpose (no moov index)';
  }
  const x = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-i', abs, '-f', 'null', '-'], { encoding: 'utf8' });
  const p = probe(abs);
  r.duration = Number(p.format.duration);
  if (!x.stderr.trim()) problems.push(`${r.path}: meant to be truncated, but it decodes without errors`);
  return 'H.264 / AAC, truncated on purpose';
}

function writeManifest(L) {
  const total = rows.reduce((n, r) => n + r.size, 0);
  const header = [
    `ReCut tester kit for ReCut ${KIT_VERSION}: list of files`,
    '',
    'Each entry: name, then size | length | what is inside (codecs, picture size, frame rate, sound channels), then what it',
    'is for. Lengths are hours:minutes:seconds. The films are CC BY: see CREDITS.txt.',
  ];
  fs.writeFileSync(K('MANIFEST.txt'), L.kitText(L.formatManifest(rows, header)));
  log(`MANIFEST.txt: ${rows.length} files, ${(total / 1048576).toFixed(1)} MB`);
}

function makeZip(L) {
  const files = ['MANIFEST.txt', ...rows.map((r) => r.path)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Fixed dates for every entry (and folder), so the zip does not change with the build time.
  for (const f of [...files, ...new Set(files.map((f) => path.posix.dirname(f)).filter((d) => d !== '.'))]) {
    execFileSync('touch', ['-h', '-d', '2026-10-01 12:00:00', K(f)]);
  }
  execFileSync('touch', ['-d', '2026-10-01 12:00:00', kit]);
  const list = [`${KIT_NAME}/`, ...[...new Set(files.map((f) => path.posix.dirname(f)).filter((d) => d !== '.'))].sort().map((d) => `${KIT_NAME}/${d}/`), ...files.map((f) => `${KIT_NAME}/${f}`)];
  const r = spawnSync('zip', ['-X', '-q', '-9', '-n', '.mp4:.mkv:.mov:.m4a:.mp3:.flac:.jpg:.png', zipPath, '-@'], { cwd: outDir, input: list.join('\n'), encoding: 'utf8', env: { ...process.env, LC_ALL: 'C.UTF-8', TZ: 'UTC' } });
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
  const t = spawnSync('unzip', ['-tq', zipPath], { encoding: 'utf8' });
  if (t.status !== 0) throw new Error(`zip test failed: ${t.stdout}${t.stderr}`);
  const size = fs.statSync(zipPath).size;
  log(`zip: ${zipPath} ${(size / 1048576).toFixed(1)} MB (budget ${(ZIP_BUDGET / 1048576).toFixed(0)} MB)`);
  if (size > ZIP_BUDGET) throw new Error(`the zip is ${L.formatSize(size)}, over the ${L.formatSize(ZIP_BUDGET)} budget`);
  if (size < ZIP_LOW) console.log(`::warning::the zip is only ${L.formatSize(size)} (aimed for about 600-800 MB)`);
}

build().catch((e) => { console.error('[tester-kit] FAILED:', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
