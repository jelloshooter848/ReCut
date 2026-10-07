/**
 * 16 kHz mono 16-bit WAV helpers for the transcription job: read the header FFmpeg wrote, split a long recording into
 * chunks at quiet moments, and write a chunk as its own WAV file. Files are streamed: memory use does not grow with
 * the length of the recording. No Electron import (unit-testable).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

export interface WavInfo {
  /** Byte offset of the first sample. */
  dataOffset: number;
  /** Number of samples (mono). */
  samples: number;
  sampleRate: number;
}

/**
 * Read the header of a PCM WAV file (mono 16-bit). FFmpeg may write a data size of 0 or 0xFFFFFFFF when it could not
 * seek back; the data then runs to the end of the file.
 */
export async function readWavInfo(file: string): Promise<WavInfo> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(size, 4096));
    await fh.read(head, 0, head.length, 0);
    if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let off = 12;
    let fmtOk = false;
    let sampleRate = SAMPLE_RATE;
    while (off + 8 <= head.length) {
      const id = head.toString('ascii', off, off + 4);
      const len = head.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        const format = head.readUInt16LE(off + 8);
        const channels = head.readUInt16LE(off + 10);
        sampleRate = head.readUInt32LE(off + 12);
        const bits = head.readUInt16LE(off + 22);
        fmtOk = (format === 1 || format === 0xfffe) && channels === 1 && bits === 16;
        if (!fmtOk) throw new Error(`unexpected WAV format (format ${format}, ${channels} channels, ${bits} bits)`);
      } else if (id === 'data') {
        if (!fmtOk) throw new Error('WAV data before its format');
        const dataOffset = off + 8;
        const avail = size - dataOffset;
        const bytes = len === 0 || len === 0xffffffff || len > avail ? avail : len;
        return { dataOffset, samples: Math.floor(bytes / BYTES_PER_SAMPLE), sampleRate };
      }
      off += 8 + len + (len & 1);
    }
    throw new Error('WAV file without a data chunk');
  } finally {
    await fh.close();
  }
}

/** 44-byte header of a mono 16-bit PCM WAV holding `samples` samples. */
export function wavHeader(samples: number, sampleRate = SAMPLE_RATE): Buffer {
  const data = samples * BYTES_PER_SAMPLE;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  h.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data, 40);
  return h;
}

/** Write samples [start, end) of `src` (described by `info`) as a WAV file `dest`, streamed. */
export async function writeWavChunk(src: string, info: WavInfo, start: number, end: number, dest: string, signal?: AbortSignal): Promise<void> {
  const from = info.dataOffset + start * BYTES_PER_SAMPLE;
  const to = info.dataOffset + end * BYTES_PER_SAMPLE - 1;
  await fsp.writeFile(dest, wavHeader(end - start, info.sampleRate));
  if (end <= start) return;
  await pipeline(fs.createReadStream(src, { start: from, end: to }), fs.createWriteStream(dest, { flags: 'a' }), { signal });
}

/** Root-mean-square level of every `win`-sample window of `pcm` (16-bit little-endian). */
export function windowLevels(pcm: Buffer, win: number): number[] {
  const n = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const out: number[] = [];
  for (let w = 0; w + win <= n; w += win) {
    let sum = 0;
    for (let i = w; i < w + win; i++) { const v = pcm.readInt16LE(i * BYTES_PER_SAMPLE); sum += v * v; }
    out.push(Math.sqrt(sum / win));
  }
  return out;
}

export interface ChunkPlanOptions {
  /** Longest chunk in seconds (default 30 minutes). */
  chunkSeconds?: number;
  /** A cut is placed at the quietest moment within this many seconds before the nominal boundary (default 20). */
  searchSeconds?: number;
  /** Level window in seconds (default 0.1). */
  windowSeconds?: number;
}

/** Default chunk length: 30 minutes (about 58 MB of audio per chunk on disk and in whisper-cli's memory). */
export const CHUNK_SECONDS = 30 * 60;

/**
 * Chunk boundaries (sample indexes, ascending, first 0, last `info.samples`) for a recording: one chunk when it is
 * no longer than `chunkSeconds`; otherwise each cut sits at the quietest `windowSeconds` window in the
 * `searchSeconds` before the nominal boundary, so a cut rarely falls inside a word. Reads only those search windows.
 */
export async function planChunks(file: string, info: WavInfo, opts: ChunkPlanOptions = {}): Promise<number[]> {
  const rate = info.sampleRate;
  const chunk = Math.max(1, Math.round((opts.chunkSeconds ?? CHUNK_SECONDS) * rate));
  const search = Math.max(0, Math.round((opts.searchSeconds ?? 20) * rate));
  const win = Math.max(1, Math.round((opts.windowSeconds ?? 0.1) * rate));
  const cuts = [0];
  if (info.samples <= chunk) return [0, info.samples];
  const fh = await fsp.open(file, 'r');
  try {
    for (;;) {
      const last = cuts[cuts.length - 1];
      if (info.samples - last <= chunk) break;
      const nominal = last + chunk;
      const from = Math.max(last + 1, nominal - search);
      let cut = nominal;
      if (nominal - from >= win) {
        const buf = Buffer.alloc((nominal - from) * BYTES_PER_SAMPLE);
        await fh.read(buf, 0, buf.length, info.dataOffset + from * BYTES_PER_SAMPLE);
        const levels = windowLevels(buf, win);
        let best = 0;
        for (let i = 1; i < levels.length; i++) if (levels[i] < levels[best]) best = i; // first quietest window
        cut = from + best * win + Math.floor(win / 2);
      }
      cuts.push(cut);
    }
  } finally {
    await fh.close();
  }
  cuts.push(info.samples);
  return cuts;
}
