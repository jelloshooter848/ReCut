/**
 * Extract an embedded text subtitle stream to SRT text via ffmpeg (stdout).
 */
import path from 'node:path';
import { ffmpegFileArg, runFfmpeg, runFfprobeJson } from './ffmpeg';
import type { FfprobeOutput } from './probe';

export const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'ttml', 'sami', 'microdvd', 'mpl2', 'subviewer', 'subviewer1', 'vplayer', 'jacosub', 'realtext', 'stl']);
export const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext', 'arib_caption']);

export function isTextSubtitleCodec(codec: string | undefined): boolean {
  return !!codec && TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

/**
 * Returns the stream's contents as SRT. Rejects for bitmap subtitle streams (PGS, VobSub, DVB)
 * and for stream indices that are not subtitle streams.
 */
export async function extractSubtitles(filePath: string, streamIndex: number): Promise<string> {
  const raw = await runFfprobeJson<FfprobeOutput>(['-show_streams', '-select_streams', String(streamIndex), ffmpegFileArg(filePath)], { timeoutMs: 60_000 });
  const stream = (raw.streams ?? []).find((s) => s.index === streamIndex) ?? raw.streams?.[0];
  const base = path.basename(filePath);
  if (!stream) throw new Error(`${base} has no stream with index ${streamIndex}`);
  if (stream.codec_type !== 'subtitle') throw new Error(`stream ${streamIndex} of ${base} is a ${stream.codec_type ?? 'non-subtitle'} stream, not subtitles`);
  const codec = (stream.codec_name ?? '').toLowerCase();
  if (BITMAP_SUBTITLE_CODECS.has(codec)) {
    throw new Error(`subtitle stream ${streamIndex} uses bitmap codec ${codec}; only text subtitles (SRT, ASS, mov_text, WebVTT) can be extracted. Use an OCR tool to convert it to SRT first.`);
  }
  if (!isTextSubtitleCodec(codec)) {
    throw new Error(`subtitle codec ${codec || 'unknown'} is not a supported text format`);
  }

  const run = runFfmpeg(
    ['-i', ffmpegFileArg(filePath), '-map', `0:${streamIndex}`, '-vn', '-an', '-dn', '-c:s', 'srt', '-f', 'srt', '-'],
    { stdout: 'data', collectStdout: true },
  );
  const res = await run.promise;
  const text = (res.stdout ?? Buffer.alloc(0)).toString('utf8').replace(/^﻿/, '');
  return text.replace(/\r\n?/g, '\n');
}
