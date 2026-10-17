/**
 * The transcription job: one audio stream → timed text cues with the bundled whisper.cpp engine, as a job of kind
 * 'transcribe' (its own lane, one at a time; the engine uses every core but one).
 *
 *  1. Check the model (size + SHA-256 against the manifest, once per session) and the engine.
 *  2. Cache: `whisper/<file key>_s<stream>_<model>-<settings hash>.json`, keyed on the media's content key
 *     (transcriptionMediaKey), the stream, the model and its SHA-256, the language / translate settings, the engine
 *     version and WHISPER_PIPELINE_VERSION. A hit returns at once with `cached: true`.
 *  3. FFmpeg extracts the stream as 16 kHz mono 16-bit PCM into a temp WAV (progress 0–10 %).
 *  4. Long recordings are cut into chunks of at most 30 minutes at quiet moments (wav.ts), so whisper-cli's memory
 *     use stays bounded whatever the length; each chunk is transcribed in turn (progress 10–100 %, from whisper-cli's
 *     `-pp` percentage and the end time of the segments it prints). With "auto" the language detected in the first
 *     chunk is used for the rest.
 *  5. The `-oj` JSON of each chunk becomes cues (output.ts), shifted to source time.
 *
 * whisper-cli runs with its working folder in a temp folder under `<userData>/whisper/tmp` and is given relative
 * file names, so no non-ASCII path ever reaches it (whisper.cpp opens files with narrow-character APIs on Windows).
 * Cancel kills FFmpeg / whisper-cli; the temp folder is always removed. Never uses the network. No Electron import.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobInfo, SubtitleCue, SubtitleWord } from '@shared/model';
import { uid } from '@shared/ids';
import { WHISPER_ENGINE_VERSION, WHISPER_VERBATIM_PROMPT, verbatimApplies, whisperDtwPreset, whisperLanguage, type TranscribeRequest, type TranscribeResult } from '@shared/whisper';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { cacheKeyForPath, cacheSubdir, fileExists, removeQuietly } from '../media/cache';
import { FfmpegError, ffmpegFileArg, lineSplitter, runFfmpeg } from '../media/ffmpeg';
import { probeMedia } from '../media/probe';
import { ensureDirSafe } from '../safeMkdir';
import { getWhisperCliPath, killTree, whisperThreads } from './engine';
import { findWhisperModel, verifyModel } from './models';
import { parseProgressLine, parseSegmentLine, parseWhisperJson, segmentsToCues } from './output';
import { CHUNK_SECONDS, planChunks, readWavInfo, writeWavChunk } from './wav';
import { PRODUCT_NAME } from '../../shared/productIdentity';

/** Bump when a change to extraction / chunking / clean-up changes the text or timing of a result. */
export const WHISPER_PIPELINE_VERSION = 4;
/** Share of the progress bar for the audio extraction. */
const EXTRACT_SHARE = 0.1;

/** What the job needs besides the request. */
export interface TranscribeJobContext {
  /** The models folder (`<userData>/whisper/models`). */
  modelsDir: string;
  /** Parent of the per-job temp folders (`<userData>/whisper/tmp`). */
  tempRoot: string;
  /** whisper-cli to run; default the bundled one (engine.ts). */
  enginePath?: string | null;
  /** Tests: arguments put before whisper-cli's own (a fake engine run as `node fake.js …`). */
  enginePrefixArgs?: string[];
  /** Threads for whisper-cli; default every core but one. */
  threads?: number;
  /** Longest chunk in seconds (tests); default 30 minutes. */
  chunkSeconds?: number;
  /** Tests: called with each whisper-cli process once it has started, and with the temp folder. */
  onEngine?: (child: ChildProcess, tempDir: string) => void;
}

/**
 * The media part of the cache key, in one function so it can follow the media cache's identity rules. It is the
 * move-proof content key every media cache uses (cacheKeyForPath: size + sampled blocks), so a transcription survives
 * moving or renaming the file.
 */
export function transcriptionMediaKey(mediaPath: string): Promise<string> {
  return cacheKeyForPath(mediaPath);
}

/** Settings part of the cache key: everything besides the media that changes the result. */
export function transcriptionSettingsHash(req: Pick<TranscribeRequest, 'streamIndex' | 'model' | 'language' | 'translate' | 'verbatim'>, modelSha256: string): string {
  const parts = {
    v: WHISPER_PIPELINE_VERSION, engine: WHISPER_ENGINE_VERSION, stream: req.streamIndex, model: req.model, sha: modelSha256,
    language: req.language, translate: Boolean(req.translate), verbatim: verbatimApplies(req),
  };
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** Cache file of one transcription result. */
export function transcriptionCachePath(fileKey: string, req: Pick<TranscribeRequest, 'streamIndex' | 'model' | 'language' | 'translate' | 'verbatim'>, modelSha256: string): string {
  return path.join(cacheSubdir('whisper'), `${fileKey}_s${req.streamIndex}_${req.model}-${transcriptionSettingsHash(req, modelSha256)}.json`);
}

function isCue(v: unknown): v is SubtitleCue {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.text === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end);
}

function validWords(v: unknown): v is SubtitleWord[] {
  return Array.isArray(v) && v.length > 0 && v.every((w) => w && typeof w === 'object' && typeof (w as SubtitleWord).text === 'string'
    && Number.isFinite((w as SubtitleWord).start) && Number.isFinite((w as SubtitleWord).end));
}

async function readCache(file: string, req: TranscribeRequest): Promise<TranscribeResult | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<TranscribeResult>;
    if (!Array.isArray(raw.cues) || !raw.cues.every(isCue) || typeof raw.language !== 'string') return null;
    return {
      mediaId: req.mediaId, streamIndex: req.streamIndex, model: req.model, translate: Boolean(req.translate),
      language: raw.language, spokenLanguage: typeof raw.spokenLanguage === 'string' ? raw.spokenLanguage : raw.language,
      // Fresh cue ids: a second transcription of the same stream must not share ids with the first track.
      cues: raw.cues.map((c) => ({ id: uid('cue'), start: c.start, end: c.end, text: c.text, ...(validWords(c.words) ? { words: c.words } : {}) })),
      duration: typeof raw.duration === 'number' ? raw.duration : 0,
      cached: true,
    };
  } catch {
    return null;
  }
}

async function writeCache(file: string, result: TranscribeResult): Promise<void> {
  const part = `${file}.${crypto.randomBytes(3).toString('hex')}.part`;
  try {
    const { cached: _c, mediaId: _m, ...rest } = result;
    await fsp.writeFile(part, JSON.stringify(rest));
    await fsp.rename(part, file);
  } catch {
    await removeQuietly(part);
  }
}

function canceled(): FfmpegError {
  return new FfmpegError('Transcription canceled', { canceled: true });
}

/** `p` relative to `from` when that is plain ASCII (safe for whisper.cpp on Windows), else `p` itself. */
export function engineFileArg(p: string, from: string): string {
  const rel = path.relative(from, p);
  return rel && !path.isAbsolute(rel) && /^[\x20-\x7e]+$/.test(rel) ? rel : p;
}

/**
 * whisper-cli arguments for one chunk. `-ojf` writes the JSON result with tokens (word timing, #118); `dtw` is the
 * model's alignment preset (whisperDtwPreset), which needs flash attention off (`-nfa`) to take effect.
 */
export function whisperArgs(o: { model: string; input: string; outBase: string; threads: number; language: string; translate: boolean; prompt?: string; dtw?: string | null }): string[] {
  return ['-m', o.model, '-f', o.input, '-of', o.outBase, '-ojf', '-pp', '-t', String(o.threads), '-l', o.language, ...(o.translate ? ['-tr'] : []),
    ...(o.dtw ? ['--dtw', o.dtw, '-nfa'] : []), ...(o.prompt ? ['--prompt', o.prompt] : [])];
}

interface EngineRun { segmentsEnd: number; stderrTail: string[] }

/** Run whisper-cli once; resolves when it exits 0. `onProgress(fraction)` follows `-pp` and the printed segments. */
function runEngine(bin: string, args: string[], cwd: string, chunkSeconds: number, jc: JobRunContext,
  onProgress: (f: number) => void, onChild?: (c: ChildProcess) => void): Promise<EngineRun> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(new Error(`could not start whisper-cli: ${(e as Error).message}`));
      return;
    }
    onChild?.(child);
    jc.onCancel(() => killTree(child));
    const run: EngineRun = { segmentsEnd: 0, stderrTail: [] };
    let pp = 0;
    const report = () => onProgress(Math.max(pp, chunkSeconds > 0 ? Math.min(1, run.segmentsEnd / chunkSeconds) : 0));
    const out = lineSplitter((line) => {
      const seg = parseSegmentLine(line);
      if (seg && seg.end > run.segmentsEnd) { run.segmentsEnd = seg.end; report(); }
    });
    const err = lineSplitter((line) => {
      const p = parseProgressLine(line);
      if (p !== null) { if (p > pp) { pp = p; report(); } return; }
      run.stderrTail.push(line);
      if (run.stderrTail.length > 40) run.stderrTail.shift();
    });
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => reject(new Error(`could not start whisper-cli: ${e.message}`)));
    child.on('close', (code, signal) => {
      out.flush(); err.flush();
      if (jc.signal.aborted) { reject(canceled()); return; }
      if (code === 0) { resolve(run); return; }
      const why = run.stderrTail.filter((l) => /error|failed|unable|cannot|invalid/i.test(l)).slice(-3).join(' · ')
        || run.stderrTail.slice(-2).join(' · ') || (signal ? `stopped by ${signal}` : `exit code ${code}`);
      reject(new Error(`whisper-cli failed: ${why}`));
    });
  });
}

/** Run one transcription request (the body of the job). */
export async function runTranscribe(req: TranscribeRequest, ctx: TranscribeJobContext, jc: JobRunContext): Promise<TranscribeResult> {
  const model = findWhisperModel(req.model);
  if (!model) throw new Error(`unknown Whisper model: ${JSON.stringify(req.model)}`);
  const translate = Boolean(req.translate);
  if (model.englishOnly && translate) throw new Error(`The ${model.name} model is English-only and cannot translate. Choose a multilingual model.`);
  if (model.englishOnly && req.language !== 'auto' && req.language !== 'en') throw new Error(`The ${model.name} model transcribes English only.`);
  if (req.language !== 'auto' && !whisperLanguage(req.language)) throw new Error(`unknown language: ${JSON.stringify(req.language)}`);

  jc.setProgress(0, `Checking the ${model.name} model…`);
  const verified = await verifyModel(ctx.modelsDir, req.model, jc.signal);
  if (!verified.ok) throw new Error(verified.error);
  if (jc.signal.aborted) throw canceled();
  const bin = ctx.enginePath === undefined ? getWhisperCliPath() : ctx.enginePath;
  if (!bin) throw new Error(`The speech-to-text engine (whisper-cli) is not included in this build of ${PRODUCT_NAME}.`);

  const fileKey = await transcriptionMediaKey(req.path);
  const cacheFile = transcriptionCachePath(fileKey, req, model.sha256);
  if (await fileExists(cacheFile)) {
    const hit = await readCache(cacheFile, req);
    if (hit) { jc.setProgress(1, `${hit.cues.length} lines (cached)`); return hit; }
  }

  const probe = await probeMedia(req.path);
  const stream = probe.audio.find((s) => s.index === req.streamIndex);
  if (!stream) throw new Error(`${path.basename(req.path)} has no audio stream #${req.streamIndex}`);
  if (jc.signal.aborted) throw canceled();

  await ensureDirSafe(ctx.tempRoot);
  const tmp = await fsp.mkdtemp(path.join(ctx.tempRoot, 'job-'));
  try {
    // 1. Extract 16 kHz mono PCM.
    const wav = path.join(tmp, 'audio.wav');
    jc.setProgress(0, 'Extracting audio…');
    const ff = runFfmpeg([
      '-i', ffmpegFileArg(req.path), '-map', `0:${req.streamIndex}`, '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', ffmpegFileArg(wav),
    ], { duration: probe.duration > 0 ? probe.duration : undefined, signal: jc.signal, onProgress: (f) => jc.setProgress(EXTRACT_SHARE * f, 'Extracting audio…') });
    jc.onCancel(() => ff.cancel());
    try {
      await ff.promise;
    } catch (e) {
      if (jc.signal.aborted) throw canceled();
      throw e;
    }
    if (jc.signal.aborted) throw canceled();

    // 2. Chunks.
    const info = await readWavInfo(wav);
    const total = info.samples / info.sampleRate;
    const cuts = await planChunks(wav, info, { chunkSeconds: ctx.chunkSeconds ?? CHUNK_SECONDS });
    const threads = ctx.threads ?? whisperThreads();
    const modelArg = engineFileArg(verified.path, tmp);
    const cues: SubtitleCue[] = [];
    let spoken = req.language === 'auto' ? (model.englishOnly ? 'en' : null) : req.language;
    const prompt = verbatimApplies(req) ? WHISPER_VERBATIM_PROMPT : undefined;
    const dtw = whisperDtwPreset(req.model);
    jc.setProgress(EXTRACT_SHARE, total > 0 ? 'Transcribing…' : 'No audio');

    // 3. Transcribe each chunk.
    for (let i = 0; i + 1 < cuts.length && total > 0; i++) {
      const start = cuts[i];
      const end = cuts[i + 1];
      const seconds = (end - start) / info.sampleRate;
      const base = EXTRACT_SHARE + (1 - EXTRACT_SHARE) * (start / info.samples);
      const share = (1 - EXTRACT_SHARE) * ((end - start) / info.samples);
      const label = cuts.length > 2 ? ` (part ${i + 1} of ${cuts.length - 1})` : '';
      let input = 'audio.wav';
      if (cuts.length > 2) {
        input = 'chunk.wav';
        await writeWavChunk(wav, info, start, end, path.join(tmp, input), jc.signal);
      }
      const outBase = 'out';
      await removeQuietly(path.join(tmp, `${outBase}.json`));
      const lang = spoken ?? 'auto';
      await runEngine(bin, [...(ctx.enginePrefixArgs ?? []), ...whisperArgs({ model: modelArg, input, outBase, threads, language: lang, translate, prompt, dtw })], tmp, seconds, jc,
        (f) => jc.setProgress(base + share * f, `Transcribing${label}… ${Math.round((start / info.sampleRate + f * seconds) / 60)} of ${Math.max(1, Math.round(total / 60))} min`),
        (child) => ctx.onEngine?.(child, tmp));
      if (jc.signal.aborted) throw canceled();
      let json: Buffer;
      try { json = await fsp.readFile(path.join(tmp, `${outBase}.json`)); } catch { throw new Error('whisper-cli finished without writing its result'); }
      const parsed = parseWhisperJson(json);
      if (!spoken && parsed.language && whisperLanguage(parsed.language)) spoken = parsed.language;
      cues.push(...segmentsToCues(parsed.segments, start / info.sampleRate, seconds));
      if (input !== 'audio.wav') await removeQuietly(path.join(tmp, input));
    }

    const spokenLanguage = spoken ?? 'en';
    const result: TranscribeResult = {
      mediaId: req.mediaId, streamIndex: req.streamIndex, model: req.model, translate,
      language: translate ? 'en' : spokenLanguage, spokenLanguage, cues, duration: total, cached: false,
    };
    await writeCache(cacheFile, result);
    jc.setProgress(1, `${cues.length} lines`);
    return result;
  } catch (e) {
    if (jc.signal.aborted) throw canceled();
    throw e;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** In-flight transcription per path|stream|model|language|translate|verbatim (dedupe). */
const inFlightTranscribe: InFlight = new WeakMap();

/** Job title: "Transcribe film.mkv #1 (Whisper Small)". */
export function transcribeJobTitle(req: TranscribeRequest): string {
  const name = findWhisperModel(req.model)?.name ?? req.model;
  return `Transcribe ${path.basename(req.path)} #${req.streamIndex} (Whisper ${name}${req.translate ? ', to English' : ''})`;
}

/**
 * Start (or join) the transcription of one audio stream. While a job for the same file, stream and settings is queued
 * or running, that job is returned. Its result is a TranscribeResult.
 */
export function startTranscribeJob(queue: JobQueue, req: TranscribeRequest, ctx: TranscribeJobContext): JobInfo {
  const key = `${req.path}|${req.streamIndex}|${req.model}|${req.language}|${req.translate ? 1 : 0}|${verbatimApplies(req) ? 1 : 0}`;
  const existing = inFlightJob(queue, inFlightTranscribe, key);
  if (existing) return existing;
  const job = queue.add<TranscribeResult>({
    kind: 'transcribe',
    title: transcribeJobTitle(req),
    mediaId: req.mediaId,
    run: (jc) => runTranscribe(req, ctx, jc),
  });
  trackInFlight(queue, inFlightTranscribe, key, job.id);
  return job;
}
