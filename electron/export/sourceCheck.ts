/**
 * Source end check for export warnings (see ffmpegWarnings.ts): for each source stream an export reads, a
 * demux-only ffprobe pass (no decoding) over the last seconds before the point the export reads to finds where
 * its data really ends. A file shorter than its probed duration (cut short, or replaced after import) makes
 * FFmpeg pad silently and print nothing, so this is the only way to see it.
 *
 * Cost: one short ffprobe per source file and stream (a few tens of ms each), a few at a time; a stream with no
 * packets in that window is scanned from the start to find its real end (bounded by a timeout).
 */
import { spawn } from 'node:child_process';
import { getFfprobePath, ffmpegFileArg } from '../media/ffmpeg';
import { packetDataEnd, SOURCE_END_TOLERANCE_SEC, type SourceEndCheck, type SourceEndResult } from './ffmpegWarnings';

/** Seconds before the needed end the window starts at. */
const WINDOW_SEC = 3;
const WINDOW_TIMEOUT_MS = 15_000;
const FULL_SCAN_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

type Packet = { pts_time?: string; dts_time?: string; duration_time?: string };

/** ffprobe packet listing of one stream; null when ffprobe could not run or timed out. */
function probePackets(bin: string, check: SourceEndCheck, interval: string | null, timeoutMs: number, signal?: AbortSignal): Promise<Packet[] | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    let file: string;
    try { file = ffmpegFileArg(check.path); } catch { resolve(null); return; }
    const args = ['-v', 'quiet', '-print_format', 'json', '-select_streams', check.stream, '-show_entries', 'packet=pts_time,dts_time,duration_time',
      ...(interval ? ['-read_intervals', interval] : []), file];
    let child: ReturnType<typeof spawn>;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { resolve(null); return; }
    const out: Buffer[] = [];
    let done = false;
    const finish = (v: Packet[] | null) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', kill); resolve(v); };
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(null); };
    const timer = setTimeout(kill, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.on('error', () => finish(null));
    child.on('close', () => {
      try {
        const j = JSON.parse(Buffer.concat(out).toString('utf8') || '{}') as { packets?: Packet[] };
        finish(Array.isArray(j.packets) ? j.packets : []);
      } catch { finish(null); }
    });
  });
}

const sec = (s: number) => Math.max(0, s).toFixed(3);

/** Where one stream's data ends (container-relative seconds), or null when that could not be found out. */
async function streamDataEnd(bin: string, c: SourceEndCheck, signal?: AbortSignal): Promise<number | null> {
  const from = c.startTime + Math.max(0, c.needEnd - WINDOW_SEC);
  const to = c.startTime + c.needEnd + 0.5;
  const win = await probePackets(bin, c, `${sec(from)}%${sec(to)}`, WINDOW_TIMEOUT_MS, signal);
  if (win === null) return null;
  const end = packetDataEnd(win, c.startTime);
  if (end !== null) return end;
  // Nothing in the window (an index pointing past the end of a cut MP4, or a seek past the data): the real end.
  const all = await probePackets(bin, c, null, FULL_SCAN_TIMEOUT_MS, signal);
  if (all === null) return null;
  return packetDataEnd(all, c.startTime) ?? 0;
}

/**
 * Runs `checks` (planSourceEndChecks) and returns the streams whose data ends more than SOURCE_END_TOLERANCE_SEC
 * before the point the export reads to. Best effort: no ffprobe, a failed or timed-out probe, or a cancel just
 * skips that stream (never fails the export).
 */
export async function checkSourceEnds(checks: SourceEndCheck[], signal?: AbortSignal): Promise<SourceEndResult[]> {
  const bin = getFfprobePath();
  if (!bin || !checks.length) return [];
  const results: (SourceEndResult | null)[] = new Array(checks.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < checks.length && !signal?.aborted) {
      const i = next++;
      const c = checks[i];
      const end = await streamDataEnd(bin, c, signal);
      if (end !== null && end < c.needEnd - SOURCE_END_TOLERANCE_SEC) results[i] = { check: c, dataEnd: Math.max(0, end) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, checks.length) }, worker));
  return results.filter((r): r is SourceEndResult => r !== null);
}
