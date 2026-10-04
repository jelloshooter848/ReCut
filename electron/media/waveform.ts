/**
 * Waveform peaks: decode the first audio stream to mono u8 PCM at a low sample rate and keep the
 * peak absolute amplitude per bucket (50 buckets/sec). Cached as `waves/<key>.pk` (+ `<key>.json`).
 *
 * The decode is streamed; memory stays O(peaks) even for multi-hour movies.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { WaveformData } from '@shared/ipc';
import { cacheSubdir, fileExists, removeQuietly } from './cache';
import { runFfmpeg, runFfprobeJson } from './ffmpeg';
import type { FfprobeOutput } from './probe';
import { peakOfU8 } from './peaks';

export const WAVEFORM_RATE = 50;        // buckets per second
export const WAVEFORM_SAMPLE_RATE = 4000; // Hz of the decoded PCM
const SAMPLES_PER_BUCKET = WAVEFORM_SAMPLE_RATE / WAVEFORM_RATE; // 80

/** v2: peaks start at the container start (late audio padded with silence). v1 caches are recomputed. */
const WAVE_VERSION = 2;
interface WaveHeader { rate: number; duration: number; version: number }

const inFlight = new Map<string, Promise<WaveformData>>();

export function waveformCachePaths(key: string): { pk: string; json: string } {
  const dir = cacheSubdir('waves');
  return { pk: path.join(dir, `${key}.pk`), json: path.join(dir, `${key}.json`) };
}

async function readCached(key: string): Promise<WaveformData | null> {
  const { pk, json } = waveformCachePaths(key);
  if (!(await fileExists(json)) || !(await fileExists(pk))) return null;
  try {
    const header = JSON.parse(await fsp.readFile(json, 'utf8')) as WaveHeader;
    if (header.version !== WAVE_VERSION) return null;
    const buf = await fsp.readFile(pk);
    return { rate: header.rate, duration: header.duration, peaks: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  } catch {
    return null;
  }
}

async function writeCached(key: string, data: WaveformData): Promise<void> {
  const { pk, json } = waveformCachePaths(key);
  const pkPart = `${pk}.part`, jsonPart = `${json}.part`;
  try {
    await fsp.writeFile(pkPart, data.peaks);
    const header: WaveHeader = { rate: data.rate, duration: data.duration, version: WAVE_VERSION };
    await fsp.writeFile(jsonPart, JSON.stringify(header));
    await fsp.rename(pkPart, pk);
    await fsp.rename(jsonPart, json);
  } catch {
    await removeQuietly(pkPart);
    await removeQuietly(jsonPart);
  }
}

/** Growable Uint8Array used while the final length is unknown. */
class PeakBuffer {
  private buf: Uint8Array;
  length = 0;
  constructor(initial: number) { this.buf = new Uint8Array(Math.max(1024, initial)); }
  push(v: number): void {
    if (this.length >= this.buf.length) {
      const n = new Uint8Array(this.buf.length * 2);
      n.set(this.buf);
      this.buf = n;
    }
    this.buf[this.length++] = v;
  }
  result(): Uint8Array { return this.buf.slice(0, this.length); }
}

export interface WaveformOptions {
  /** Absolute ffprobe stream index of the audio stream to analyse (default: first audio stream). */
  streamIndex?: number;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

/**
 * Compute (or load from cache) the waveform of `filePath`. `key` is the file's cache key.
 * Files without audio yield `{ rate, duration, peaks: Uint8Array(0) }`.
 */
export function getWaveform(filePath: string, key: string, opts: WaveformOptions = {}): Promise<WaveformData> {
  const cacheId = opts.streamIndex !== undefined ? `${key}_s${opts.streamIndex}` : key;
  const existing = inFlight.get(cacheId);
  if (existing) return existing;
  const task = (async () => {
    const cached = await readCached(cacheId);
    if (cached) return cached;
    const data = await computeWaveform(filePath, opts);
    await writeCached(cacheId, data);
    return data;
  })().finally(() => { inFlight.delete(cacheId); });
  inFlight.set(cacheId, task);
  return task;
}

/** Decode and bucket without touching the cache. */
export async function computeWaveform(filePath: string, opts: WaveformOptions = {}): Promise<WaveformData> {
  // Find the audio stream + duration.
  const raw = await runFfprobeJson<FfprobeOutput>(['-show_format', '-show_streams', '-select_streams', 'a', filePath], { timeoutMs: 60_000 });
  const audioStreams = (raw.streams ?? []).filter((s) => s.codec_type === 'audio');
  let duration = parseFloat(raw.format?.duration ?? '') || 0;
  if (!(duration > 0)) for (const s of audioStreams) duration = Math.max(duration, parseFloat(s.duration ?? '') || 0);

  if (audioStreams.length === 0) {
    return { rate: WAVEFORM_RATE, duration, peaks: new Uint8Array(0) };
  }
  let mapSpec = '0:a:0';
  let stream = audioStreams[0];
  if (opts.streamIndex !== undefined) {
    const s = audioStreams.find((a) => a.index === opts.streamIndex);
    if (!s) throw new Error(`stream ${opts.streamIndex} is not an audio stream of ${path.basename(filePath)}`);
    mapSpec = `0:${s.index}`;
    stream = s;
  }
  // ffmpeg decodes the stream from its own first sample; <video> (and the export) place it at
  // (stream start - container start). Pad that lead with silence so peaks are in media time (M-08).
  const lead = Math.max(0, (parseFloat(stream.start_time ?? '') || 0) - (parseFloat(raw.format?.start_time ?? '') || 0));

  const expected = duration > 0 ? Math.ceil(duration * WAVEFORM_RATE) + 1 : 0;
  const peaks = new PeakBuffer(expected);
  // carry-over bucket state across chunk boundaries
  let bucketMax = 0;
  let bucketCount = 0;
  const leadSamples = lead > 1e-6 && Number.isFinite(lead) ? Math.round(lead * WAVEFORM_SAMPLE_RATE) : 0;
  for (let i = 0; i < Math.floor(leadSamples / SAMPLES_PER_BUCKET); i++) peaks.push(0);
  bucketCount = leadSamples % SAMPLES_PER_BUCKET;

  const run = runFfmpeg(
    [
      '-i', filePath,
      '-map', mapSpec,
      '-vn', '-sn', '-dn',
      '-ac', '1',
      '-ar', String(WAVEFORM_SAMPLE_RATE),
      '-f', 'u8',
      '-',
    ],
    {
      stdout: 'data',
      duration: duration > 0 ? duration : undefined,
      onProgress: opts.onProgress ? (p) => opts.onProgress!(p) : undefined,
      signal: opts.signal,
      onStdout: (chunk) => {
        let i = 0;
        const n = chunk.length;
        while (i < n) {
          const take = Math.min(SAMPLES_PER_BUCKET - bucketCount, n - i);
          const m = peakOfU8(chunk, i, i + take);
          if (m > bucketMax) bucketMax = m;
          bucketCount += take;
          i += take;
          if (bucketCount === SAMPLES_PER_BUCKET) {
            peaks.push(bucketMax);
            bucketMax = 0;
            bucketCount = 0;
          }
        }
      },
    },
  );
  await run.promise;
  if (bucketCount > 0) peaks.push(bucketMax);

  const result = peaks.result();
  const decodedDuration = result.length / WAVEFORM_RATE;
  return {
    rate: WAVEFORM_RATE,
    duration: duration > 0 ? duration : decodedDuration,
    peaks: result,
  };
}
