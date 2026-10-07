/**
 * Extract an embedded text subtitle stream to SRT text via ffmpeg (stdout).
 */
import path from 'node:path';
import { ffmpegFileArg, runFfmpeg, runFfprobeJson } from './ffmpeg';
import type { FfprobeOutput } from './probe';
import { isOcrCodec } from '@shared/ocr';

export const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'ttml', 'sami', 'microdvd', 'mpl2', 'subviewer', 'subviewer1', 'vplayer', 'jacosub', 'realtext', 'stl']);
export const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext', 'arib_caption']);

export function isTextSubtitleCodec(codec: string | undefined): boolean {
  return !!codec && TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

/**
 * Why subtitle stream `streamIndex` (codec `codec`, lower case) cannot be extracted as text, or null when it can.
 * Bitmap streams ReCut can OCR (PGS, VobSub, DVB, XSUB) point to Read with OCR…; teletext / ARIB captions and
 * unknown codecs are not supported.
 */
export function subtitleExtractRefusal(codec: string, streamIndex: number): string | null {
  if (isOcrCodec(codec)) {
    return `subtitle stream ${streamIndex} is a bitmap subtitle stream (${codec}); use Read with OCR… to turn it into text.`;
  }
  if (BITMAP_SUBTITLE_CODECS.has(codec)) {
    return `subtitle stream ${streamIndex} uses ${codec}, which ReCut does not support: it can only extract text subtitles (SRT, ASS, mov_text, WebVTT) and read PGS, VobSub, DVB and XSUB bitmap subtitles with OCR.`;
  }
  if (!isTextSubtitleCodec(codec)) return `subtitle codec ${codec || 'unknown'} is not a supported text format`;
  return null;
}

/**
 * Returns the stream's contents as SRT. Rejects for bitmap subtitle streams (PGS, VobSub, DVB: see
 * subtitleExtractRefusal) and for stream indices that are not subtitle streams.
 */
export async function extractSubtitles(filePath: string, streamIndex: number): Promise<string> {
  const raw = await runFfprobeJson<FfprobeOutput>(['-show_streams', '-select_streams', String(streamIndex), ffmpegFileArg(filePath)], { timeoutMs: 60_000 });
  const stream = (raw.streams ?? []).find((s) => s.index === streamIndex) ?? raw.streams?.[0];
  const base = path.basename(filePath);
  if (!stream) throw new Error(`${base} has no stream with index ${streamIndex}`);
  if (stream.codec_type !== 'subtitle') throw new Error(`stream ${streamIndex} of ${base} is a ${stream.codec_type ?? 'non-subtitle'} stream, not subtitles`);
  const codec = (stream.codec_name ?? '').toLowerCase();
  const refusal = subtitleExtractRefusal(codec, streamIndex);
  if (refusal) throw new Error(refusal);

  const run = runFfmpeg(
    ['-i', ffmpegFileArg(filePath), '-map', `0:${streamIndex}`, '-vn', '-an', '-dn', '-c:s', 'srt', '-f', 'srt', '-'],
    { stdout: 'data', collectStdout: true },
  );
  const res = await run.promise;
  const text = (res.stdout ?? Buffer.alloc(0)).toString('utf8').replace(/^﻿/, '');
  return text.replace(/\r\n?/g, '\n');
}
