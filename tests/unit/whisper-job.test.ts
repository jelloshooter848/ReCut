/**
 * The transcription job (electron/whisper/transcribeJob.ts) end to end with a fake engine (tests/helpers/fakeWhisper.cjs,
 * run as `node fakeWhisper.cjs …` on every platform) and real FFmpeg: audio extraction of the chosen stream, chunking at
 * quiet moments, cue offsets, the detected language carried to later chunks, the cache, failures, and cancel (the
 * engine process is killed and the temp folder removed). Then the real bundled engine (resources/whisper, when it has
 * been built) with a generated test model, and with the real tiny model when RECUT_WHISPER_TINY_MODEL points to it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobInfo } from '../../shared/model';
import { WHISPER_VERBATIM_PROMPT, verbatimApplies, type TranscribeRequest, type TranscribeResult } from '../../shared/whisper';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { setCacheDir } from '../../electron/media/cache';
import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { WHISPER_CLI_NAME } from '../../electron/whisper/engine';
import { _resetVerifiedModels, setTestWhisperModels } from '../../electron/whisper/models';
import {
  engineFileArg, startTranscribeJob, transcribeJobTitle, transcriptionCachePath, transcriptionMediaKey, transcriptionSettingsHash,
  whisperArgs, type TranscribeJobContext,
} from '../../electron/whisper/transcribeJob';
import { readWavInfo, planChunks, wavHeader } from '../../electron/whisper/wav';
import { writeTestWhisperModel } from '../helpers/whisperModel';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const FAKE = path.join(repo, 'tests', 'helpers', 'fakeWhisper.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-whisper-job-'));
const modelsDir = path.join(tmp, 'models');
const tempRoot = path.join(tmp, 'whisper-tmp');
const log = path.join(tmp, 'engine-log.jsonl');
const hasFfmpeg = !!getFfmpegPath();

const MODEL_BYTES = crypto.randomBytes(4096);
const MODEL = { id: 'test-tiny', name: 'Test (tiny)', file: 'ggml-test-tiny.bin', bytes: MODEL_BYTES.length, sha256: crypto.createHash('sha256').update(MODEL_BYTES).digest('hex'), englishOnly: false, note: '' };

let media = '';
let n = 0;

function ffmpeg(args: string[]): void {
  execFileSync(getFfmpegPath()!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

beforeAll(() => {
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, MODEL.file), MODEL_BYTES);
  setCacheDir(path.join(tmp, 'cache'));
  process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');
  if (!hasFfmpeg) return;
  // 6 s, two audio streams: #0 a tone with silence 2.0–2.6 s, #1 quiet noise.
  media = path.join(tmp, 'clip with space é.mkv');
  ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,2.6),0,0.5*sin(2*PI*440*t))':d=6:s=48000",
    '-f', 'lavfi', '-i', 'anoisesrc=d=6:a=0.02:r=48000', '-map', '0', '-map', '1', '-c:a', 'flac', media]);
});
afterAll(() => {
  setTestWhisperModels([]);
  delete process.env.RECUT_CACHE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  setTestWhisperModels([MODEL]);
  _resetVerifiedModels();
  fs.rmSync(log, { force: true });
  fs.rmSync(path.join(tmp, 'cache'), { recursive: true, force: true });
  delete process.env.FAKE_WHISPER_MODE;
  delete process.env.FAKE_WHISPER_PIDFILE;
  process.env.FAKE_WHISPER_LOG = log;
});

const ctx = (extra: Partial<TranscribeJobContext> = {}): TranscribeJobContext => ({
  modelsDir, tempRoot, enginePath: process.execPath, enginePrefixArgs: [FAKE], threads: 2, ...extra,
});
const req = (extra: Partial<TranscribeRequest> = {}): TranscribeRequest => ({
  mediaId: `m${n++}`, path: media, streamIndex: 0, model: 'test-tiny', language: 'auto', translate: false, ...extra,
});
const engineRuns = (): { args: string[]; cwd: string }[] =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const leftovers = () => (fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot) : []);

async function run(q: JobQueue, r: TranscribeRequest, c: TranscribeJobContext): Promise<{ job: JobInfo; progress: number[] }> {
  const progress: number[] = [];
  const off = q.subscribe((jobs) => { const j = jobs.find((x) => x.kind === 'transcribe'); if (j?.status === 'running') progress.push(j.progress); });
  const started = startTranscribeJob(q, r, c);
  const job = await q.waitFor(started.id);
  off();
  return { job, progress };
}

describe.skipIf(!hasFfmpeg)('transcription job (fake engine)', () => {
  it('extracts the stream, runs the engine and returns cleaned cues; a second run comes from the cache', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    const { job, progress } = await run(q, req(), ctx());
    expect(job.status, job.error).toBe('done');
    const r = job.result as TranscribeResult;
    expect(r.language).toBe('fr');
    expect(r.spokenLanguage).toBe('fr');
    expect(r.cached).toBe(false);
    expect(r.duration).toBeCloseTo(6, 1);
    // [BLANK_AUDIO] dropped, tab collapsed, non-ASCII and escaped quotes kept.
    expect(r.cues.map((c) => c.text)).toEqual(['Bonjour, ça va ?', 'Très "bien".']);
    expect(r.cues[0].start).toBe(0);
    expect(r.cues[1].end).toBeCloseTo(6, 1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);

    // whisper-cli ran in the temp folder with relative, ASCII file names and every core but one.
    const [call] = engineRuns();
    expect(call.args).toEqual(whisperArgs({ model: path.join('..', '..', 'models', MODEL.file), input: 'audio.wav', outBase: 'out', threads: 2, language: 'auto', translate: false }));
    // realpath: on macOS the temp folder is /var/... but the engine may report it as /private/var/... (a symlink).
    expect(fs.realpathSync(path.dirname(call.cwd))).toBe(fs.realpathSync(tempRoot));
    expect(leftovers()).toEqual([]);

    const again = await run(q, req(), ctx());
    expect((again.job.result as TranscribeResult).cached).toBe(true);
    expect((again.job.result as TranscribeResult).cues.map((c) => c.text)).toEqual(r.cues.map((c) => c.text));
    expect(engineRuns()).toHaveLength(1);
  });

  it('a verbatim English request passes the filler prompt to whisper-cli (#117)', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    const { job } = await run(q, req({ language: 'en', verbatim: true }), ctx());
    expect(job.status, job.error).toBe('done');
    const [call] = engineRuns();
    expect(call.args.slice(-2)).toEqual(['--prompt', WHISPER_VERBATIM_PROMPT]);
  });

  it('transcribes long audio in chunks cut at a quiet moment, with the detected language passed on', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    const { job } = await run(q, req({ streamIndex: 0 }), ctx({ chunkSeconds: 4 }));
    expect(job.status, job.error).toBe('done');
    const runs = engineRuns();
    expect(runs.length).toBe(2);
    expect(runs[0].args).toContain('chunk.wav');
    expect(runs[0].args[runs[0].args.indexOf('-l') + 1]).toBe('auto');
    expect(runs[1].args[runs[1].args.indexOf('-l') + 1]).toBe('fr');
    const r = job.result as TranscribeResult;
    // Cue times are shifted to source time: the second chunk starts inside the 2.0–2.6 s silence.
    const secondStart = r.cues[2].start;
    expect(secondStart).toBeGreaterThan(1.95);
    expect(secondStart).toBeLessThan(2.65);
    expect(r.cues.at(-1)!.end).toBeCloseTo(6, 1);
    expect(leftovers()).toEqual([]);
  });

  it('extracts the chosen stream and passes language and translate settings', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    const { job } = await run(q, req({ streamIndex: 1, language: 'de', translate: true }), ctx());
    expect(job.status, job.error).toBe('done');
    const r = job.result as TranscribeResult;
    expect(r.language).toBe('en');
    expect(r.spokenLanguage).toBe('de');
    expect(r.translate).toBe(true);
    const args = engineRuns()[0].args;
    expect(args).toContain('-tr');
    expect(args[args.indexOf('-l') + 1]).toBe('de');
  });

  it('cancel kills the engine and removes the temp folder', async () => {
    process.env.FAKE_WHISPER_MODE = 'hang';
    const pidFile = path.join(tmp, 'pid.txt');
    fs.rmSync(pidFile, { force: true });
    process.env.FAKE_WHISPER_PIDFILE = pidFile;
    const q = new JobQueue({ throttleMs: 0 });
    let tempDir = '';
    const job = startTranscribeJob(q, req(), ctx({ onEngine: (_c, dir) => { tempDir = dir; } }));
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(fs.existsSync(tempDir)).toBe(true);
    q.cancel(job.id);
    const done = await q.waitFor(job.id);
    expect(done.status).toBe('canceled');
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    expect(fs.existsSync(tempDir)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('reports an engine failure with its error line and cleans up', async () => {
    process.env.FAKE_WHISPER_MODE = 'fail';
    const q = new JobQueue({ throttleMs: 0 });
    const { job } = await run(q, req(), ctx());
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/whisper-cli failed: .*failed to initialize whisper context/);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a missing or damaged model, an English-only model asked to translate, and a missing stream', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    setTestWhisperModels([MODEL, { ...MODEL, id: 'test-other', file: 'ggml-test-other.bin' }]);
    let r = await run(q, req({ model: 'test-other' }), ctx());
    expect(r.job.error).toMatch(/not installed/);
    fs.writeFileSync(path.join(modelsDir, 'ggml-test-other.bin'), crypto.randomBytes(MODEL.bytes));
    r = await run(q, req({ model: 'test-other' }), ctx());
    expect(r.job.error).toMatch(/damaged/);
    r = await run(q, req({ model: 'base.en', translate: true }), ctx());
    expect(r.job.error).toMatch(/English-only/);
    r = await run(q, req({ streamIndex: 7 }), ctx());
    expect(r.job.error).toMatch(/no audio stream #7/);
    r = await run(q, req(), ctx({ enginePath: null }));
    expect(r.job.error).toMatch(/not included in this build/);
    expect(engineRuns()).toHaveLength(0);
  });

  it('joins a running job for the same stream and settings', async () => {
    process.env.FAKE_WHISPER_MODE = 'hang';
    const q = new JobQueue({ throttleMs: 0 });
    const r = req();
    const a = startTranscribeJob(q, r, ctx());
    const b = startTranscribeJob(q, { ...r }, ctx());
    expect(b.id).toBe(a.id);
    expect(startTranscribeJob(q, { ...r, language: 'en' }, ctx()).id).not.toBe(a.id);
    const enJob = startTranscribeJob(q, { ...r, language: 'en' }, ctx());
    expect(startTranscribeJob(q, { ...r, language: 'en', verbatim: true }, ctx()).id).not.toBe(enJob.id);
    q.cancelAll();
    await q.waitFor(a.id);
  });
});

describe('cache key and arguments', () => {
  it('passes the verbatim prompt for English without translation only (#117)', () => {
    expect(verbatimApplies({ verbatim: true, language: 'en', translate: false })).toBe(true);
    expect(verbatimApplies({ verbatim: true, language: 'auto', translate: false })).toBe(false);
    expect(verbatimApplies({ verbatim: true, language: 'fr', translate: false })).toBe(false);
    expect(verbatimApplies({ verbatim: true, language: 'en', translate: true })).toBe(false);
    expect(verbatimApplies({ verbatim: false, language: 'en', translate: false })).toBe(false);
    const o = { model: 'm.bin', input: 'audio.wav', outBase: 'out', threads: 2, language: 'en', translate: false };
    expect(whisperArgs(o)).not.toContain('--prompt');
    const args = whisperArgs({ ...o, prompt: WHISPER_VERBATIM_PROMPT });
    expect(args.slice(-2)).toEqual(['--prompt', WHISPER_VERBATIM_PROMPT]);
  });

  it('changes with every setting that changes the result', async () => {
    const base = { streamIndex: 1, model: 'small', language: 'auto', translate: false };
    const h = transcriptionSettingsHash(base, 'a'.repeat(64));
    expect(transcriptionSettingsHash({ ...base }, 'a'.repeat(64))).toBe(h);
    for (const v of [{ ...base, streamIndex: 2 }, { ...base, model: 'base' }, { ...base, language: 'en' }, { ...base, translate: true }]) {
      expect(transcriptionSettingsHash(v, 'a'.repeat(64))).not.toBe(h);
    }
    expect(transcriptionSettingsHash(base, 'b'.repeat(64))).not.toBe(h);
    // Verbatim changes the key only where it changes the run: English, not translating (#117).
    const en = { ...base, language: 'en' };
    expect(transcriptionSettingsHash({ ...en, verbatim: true }, 'a'.repeat(64))).not.toBe(transcriptionSettingsHash(en, 'a'.repeat(64)));
    expect(transcriptionSettingsHash({ ...base, verbatim: true }, 'a'.repeat(64))).toBe(h);
    expect(transcriptionSettingsHash({ ...en, translate: true, verbatim: true }, 'a'.repeat(64))).toBe(transcriptionSettingsHash({ ...en, translate: true }, 'a'.repeat(64)));
    const f = path.join(tmp, 'key.bin');
    fs.writeFileSync(f, 'x');
    const k1 = await transcriptionMediaKey(f);
    fs.writeFileSync(f, 'xy');
    expect(await transcriptionMediaKey(f)).not.toBe(k1);
    expect(path.basename(transcriptionCachePath(k1, base, 'a'.repeat(64)))).toMatch(new RegExp(`^${k1}_s1_small-[0-9a-f]{16}\\.json$`));
  });

  it('gives the engine relative ASCII paths when it can', () => {
    const root = path.resolve('/data/whisper');
    expect(engineFileArg(path.join(root, 'models', 'm.bin'), path.join(root, 'tmp', 'job-1'))).toBe(path.join('..', '..', 'models', 'm.bin'));
    const odd = path.resolve('/data/José/models/m.bin');
    expect(engineFileArg(odd, path.join(root, 'tmp', 'job-1'))).toBe(odd);
  });

  it('titles jobs with the file, stream and model', () => {
    expect(transcribeJobTitle({ mediaId: 'm', path: path.resolve('/x/film.mkv'), streamIndex: 2, model: 'small', language: 'auto' })).toBe('Transcribe film.mkv #2 (Whisper Small)');
    expect(transcribeJobTitle({ mediaId: 'm', path: path.resolve('/x/film.mkv'), streamIndex: 2, model: 'small', language: 'auto', translate: true })).toBe('Transcribe film.mkv #2 (Whisper Small, to English)');
  });
});

describe('WAV chunking', () => {
  it('cuts at the quietest window before each nominal boundary and never past the end', async () => {
    // 10 s at 16 kHz: loud everywhere except 4.0–4.3 s.
    const rate = 16000;
    const samples = 10 * rate;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const t = i / rate;
      pcm.writeInt16LE(t >= 4 && t < 4.3 ? 0 : Math.round(8000 * Math.sin(2 * Math.PI * 300 * t)), i * 2);
    }
    const f = path.join(tmp, 'chunks.wav');
    fs.writeFileSync(f, Buffer.concat([wavHeader(samples), pcm]));
    const info = await readWavInfo(f);
    expect(info).toEqual({ dataOffset: 44, samples, sampleRate: rate });
    const cuts = await planChunks(f, info, { chunkSeconds: 5, searchSeconds: 2 });
    expect(cuts[0]).toBe(0);
    expect(cuts.at(-1)).toBe(samples);
    expect(cuts[1] / rate).toBeGreaterThanOrEqual(4);
    expect(cuts[1] / rate).toBeLessThan(4.3);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i] - cuts[i - 1]).toBeLessThanOrEqual(5 * rate);
    expect(await planChunks(f, info, { chunkSeconds: 20 })).toEqual([0, samples]);
  });
});

// ------------------------------------------------------------------
// The real engine
// ------------------------------------------------------------------

const engine = path.join(repo, 'resources', 'whisper', WHISPER_CLI_NAME);
const hasEngine = fs.existsSync(engine);
const hasFlite = hasFfmpeg && (() => {
  try { return /\bflite\b/.test(execFileSync(getFfmpegPath()!, ['-hide_banner', '-filters']).toString()); } catch { return false; }
})();

const hasEspeak = (() => {
  try { execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const SENTENCE = 'Hello there. This is a short test of the speech recognition engine.';

describe.skipIf(!hasEngine || !hasFfmpeg)('transcription with the bundled whisper.cpp engine', () => {
  let speech = '';
  beforeAll(() => {
    speech = path.join(tmp, 'speech.mka');
    // A spoken sentence from FFmpeg's flite voice or espeak-ng when one is there; a tone otherwise (the pipeline is
    // still checked end to end).
    if (hasFlite) ffmpeg(['-f', 'lavfi', '-i', `flite=text='${SENTENCE}':voice=slt`, '-c:a', 'flac', speech]);
    else if (hasEspeak) {
      const wav = path.join(tmp, 'espeak.wav');
      execFileSync('espeak-ng', ['-s', '150', '-w', wav, SENTENCE]);
      ffmpeg(['-i', wav, '-c:a', 'flac', speech]);
    } else ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-c:a', 'flac', speech]);
  });

  it('runs whisper-cli with a generated model and returns a well-formed result', async () => {
    const gen = path.join(modelsDir, 'ggml-test-gen.bin');
    const { bytes, sha256 } = writeTestWhisperModel(gen);
    setTestWhisperModels([{ ...MODEL, id: 'test-gen', file: 'ggml-test-gen.bin', bytes, sha256 }]);
    const q = new JobQueue({ throttleMs: 0 });
    const { job, progress } = await run(q, req({ path: speech, model: 'test-gen' }), { modelsDir, tempRoot, enginePath: engine, threads: 2 });
    expect(job.status, job.error).toBe('done');
    const r = job.result as TranscribeResult;
    expect(Array.isArray(r.cues)).toBe(true);
    expect(typeof r.language).toBe('string');
    for (const c of r.cues) {
      expect(c.end).toBeGreaterThan(c.start);
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.text.trim()).toBe(c.text);
    }
    expect(progress.at(-1)).toBeGreaterThan(0.1);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  const tiny = process.env.RECUT_WHISPER_TINY_MODEL;
  it.skipIf(!tiny || !(hasFlite || hasEspeak))('recognizes speech with the real tiny model', async () => {
    const dir = path.join(tmp, 'real-models');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(tiny!, path.join(dir, 'ggml-tiny.bin'));
    const q = new JobQueue({ throttleMs: 0 });
    const t0 = Date.now();
    const { job } = await run(q, req({ path: speech, model: 'tiny' }), { modelsDir: dir, tempRoot, enginePath: engine });
    expect(job.status, job.error).toBe('done');
    const r = job.result as TranscribeResult;
    const text = r.cues.map((c) => c.text).join(' ').toLowerCase();
    console.log(`tiny model: ${((Date.now() - t0) / 1000).toFixed(1)} s for ${r.duration.toFixed(1)} s of audio: ${text}`);
    expect(r.language).toBe('en');
    expect(text).toMatch(/hello/);
    expect(text).toMatch(/test/);
  }, 300_000);
});
