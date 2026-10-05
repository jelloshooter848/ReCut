/**
 * Export graph benchmarks: buildRenderGraph on the 2500-clip sequence (time, filter length, input count,
 * IPC payload size of the ExportRequest), then whether ffmpeg actually accepts the generated graph
 * (parse + init only: `-t 0.5`, null muxer, memory-capped child) at 100 / 500 / 2500 clips.
 *
 * Run: npx vitest run -c tests/perf/vitest.config.ts tests/perf/export.perf.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Sequence } from '../../shared/model';
import type { ExportRequest } from '../../shared/ipc';
import { useStore, resetStore } from '../../src/state/store';
import { buildRenderGraph, FILTER_SCRIPT_TOKEN } from '../../electron/export/renderGraph';
import { allTracks } from '../../shared/timeline';
import { runExport } from '../../electron/export/exporter';
import { planExportChunks } from '../../electron/export/chunks';
// @ts-expect-error plain JS module shared with the Electron harness
import { buildBigProject } from './bigProject.mjs';
import { bench, flush, ms, now, record, round } from './_report';

const SCRATCH = process.env.RECUT_PERF_SCRATCH || path.join(os.tmpdir(), 'recut-perf');
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const S = () => useStore.getState();

function probeFile(file: string): MediaProbe {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size), startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio: j.streams.filter((s: { codec_type: string }) => s.codec_type === 'audio').map((s: { index: number; codec_name: string; channels: number; channel_layout?: string; sample_rate: string }) => ({ index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate) })),
    subtitles: [],
  };
}

function settings(): ExportSettings {
  return {
    outputDir: SCRATCH, fileName: 'perf-export.mp4', width: 1280, height: 720, fps: { num: 24, den: 1 },
    videoCodec: 'libx264', qualityMode: 'crf', crf: 28, videoBitrateKbps: 4000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000, rangeMode: 'entire',
    burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
  };
}

/** Run ffmpeg to validate graph parsing/init only. A watchdog kills the child when its RSS exceeds `memMB` or after `timeoutMs`. */
function validateGraph(args: string[], filterGraph: string, tag: string, memMB = 6144, timeoutMs = 180_000): Promise<{ code: number | null; signal: string | null; ms: number; peakRssMB: number; tail: string; timedOut: boolean; memKilled: boolean }> {
  const script = path.join(SCRATCH, `filter-${tag}.txt`);
  fs.writeFileSync(script, filterGraph);
  const a = args.map((x) => (x === FILTER_SCRIPT_TOKEN ? script : x));
  // -t <dur> ... -f mp4 <out>  ->  -t 0.5 ... -f null -
  const ti = a.lastIndexOf('-t'); if (ti >= 0) a[ti + 1] = '0.5';
  const fi = a.lastIndexOf('-f'); if (fi >= 0) a[fi + 1] = 'null';
  a[a.length - 1] = '-';
  return new Promise((resolve) => {
    const t0 = now();
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...a.slice(3)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); if (err.length > 20000) err = err.slice(-20000); });
    let peak = 0; let timedOut = false; let memKilled = false;
    const poll = setInterval(() => {
      try {
        const st = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const m = /VmHWM:\s+(\d+) kB/.exec(st); if (m) peak = Math.max(peak, Number(m[1]) / 1024);
        if (peak > memMB) { memKilled = true; child.kill('SIGKILL'); }
      } catch { /* gone */ }
    }, 200);
    const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code, signal) => {
      clearInterval(poll); clearTimeout(killer);
      resolve({ code, signal, ms: round(now() - t0), peakRssMB: round(peak), tail: err.trim().split('\n').slice(-6).join(' | ').slice(0, 600), timedOut, memKilled });
    });
  });
}

let big: ReturnType<typeof buildBigProject>;
let mediaFiles: string[] = [];

describe('export graph @ 2500 clips', () => {
  beforeAll(() => {
    fs.mkdirSync(SCRATCH, { recursive: true });
    // 4 tiny real inputs (2s, 160x90, tone) so ffmpeg can open every one of the 2500 segments.
    mediaFiles = [];
    for (let i = 0; i < 4; i++) {
      const f = path.join(SCRATCH, `tiny-${i}.mp4`);
      if (!fs.existsSync(f)) execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=24:d=61`, '-f', 'lavfi', '-i', `sine=frequency=${220 + i * 110}:duration=61:sample_rate=48000`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-shortest', f]);
      mediaFiles.push(f);
    }
    resetStore();
    const base = mediaFiles.map((f, i) => ({ name: `tiny ${i}.mp4`, path: f, probe: probeFile(f) }));
    big = buildBigProject(useStore, base, { altSequences: 0 });
  });
  afterAll(() => flush('export'));

  function requestFor(seq: Sequence): ExportRequest {
    return { sequence: seq, media: S().project.media as Record<string, MediaItem>, settings: settings() };
  }

  /** Sub-sequence keeping the first `n` clips (by pairs across tracks) of the big one. */
  function trimmed(n: number): Sequence {
    const seq = S().project.sequences[big.seqId];
    const perTrack = Math.ceil(n / allTracks(seq).length);
    const cut = (tracks: Sequence['videoTracks']) => tracks.map((t) => { const clips = t.clips.slice(0, perTrack); const ids = new Set(clips.map((c) => c.id)); return { ...t, clips, transitions: t.transitions.filter((tr) => (!tr.outClipId || ids.has(tr.outClipId)) && (!tr.inClipId || ids.has(tr.inClipId))) }; });
    return { ...seq, videoTracks: cut(seq.videoTracks), audioTracks: cut(seq.audioTracks) };
  }

  it('buildRenderGraph time / size scaling and IPC payload', () => {
    const seq = S().project.sequences[big.seqId];
    const req = requestFor(seq);
    let g = buildRenderGraph(req);
    const b = bench(5, () => { g = buildRenderGraph(req); });
    ms('graph', 'buildRenderGraph 2500 clips (median of 5)', b.median, 200);
    record({ section: 'graph', metric: 'filter graph length (chars)', value: g.filterGraph.length, unit: 'chars' });
    record({ section: 'graph', metric: 'filter graph chains', value: g.filterGraph.split(';\n').length, unit: '' });
    record({ section: 'graph', metric: 'ffmpeg inputs (one per clip segment)', value: g.inputCount, unit: 'inputs', threshold: 'ffmpeg must open all of them', pass: null });
    record({ section: 'graph', metric: 'ffmpeg argv length', value: g.args.length, unit: 'args' });
    record({ section: 'graph', metric: 'argv bytes (sum)', value: g.args.join(' ').length, unit: 'bytes' });
    record({ section: 'graph', metric: 'warnings', value: g.warnings.length, unit: '' });
    const t = now(); const json = JSON.stringify(req); const jt = now() - t;
    record({ section: 'ipc', metric: 'ExportRequest JSON size (MB) 2500 clips + 60 media', value: round(json.length / 1048576), unit: 'MB' });
    ms('ipc', 'ExportRequest JSON.stringify', jt, 50);
    const sc = bench(3, () => { structuredClone(req); });
    ms('ipc', 'ExportRequest structuredClone (IPC one way, median)', sc.median, 50);
    for (const n of [100, 500, 1000]) {
      const r = requestFor(trimmed(n)); const gg = buildRenderGraph(r);
      record({ section: 'graph', metric: `filter graph length @ ${n} clips`, value: gg.filterGraph.length, unit: 'chars' });
      const bb = bench(5, () => { buildRenderGraph(r); });
      ms('graph', `buildRenderGraph @ ${n} clips (median)`, bb.median, 100);
    }
    expect(g.inputCount).toBeGreaterThanOrEqual(2400);
  });

  it('ffmpeg accepts the generated graph (parse + init, -t 0.5, null muxer)', async () => {
    let lastOk = true;
    for (const n of [100, 500, 2500]) {
      if (!lastOk) { record({ section: 'ffmpeg', metric: `validate @ ${n} clips`, value: 'skipped (smaller graph already failed)', unit: '' }); continue; }
      const seq = n >= 2500 ? S().project.sequences[big.seqId] : trimmed(n);
      const g = buildRenderGraph(requestFor(seq));
      const r = await validateGraph(g.args, g.filterGraph, `n${n}`);
      const ok = r.code === 0;
      lastOk = ok;
      record({ section: 'ffmpeg', metric: `ffmpeg exit @ ${n} clips (${g.inputCount} inputs)`, value: r.timedOut ? 'TIMEOUT (killed)' : r.memKilled ? `KILLED: RSS > 6 GB` : `${r.code ?? r.signal}`, unit: '', threshold: '0', pass: ok, note: ok ? '' : r.tail });
      ms('ffmpeg', `ffmpeg wall time @ ${n} clips (0.5 s output)`, r.ms, 60_000);
      record({ section: 'ffmpeg', metric: `ffmpeg peak RSS @ ${n} clips (MB)`, value: r.peakRssMB, unit: 'MB', threshold: '<= 4096 MB', pass: r.peakRssMB <= 4096 });
    }
    expect(true).toBe(true);
  });
  it('chunked export of the full 2500-clip sequence (P-01): wall time and peak ffmpeg RSS', async () => {
    // RECUT_PERF_SKIP_FULL_EXPORT=1 skips this (it renders the whole ~26 min sequence at 1280x720).
    if (process.env.RECUT_PERF_SKIP_FULL_EXPORT) return;
    const seq = S().project.sequences[big.seqId];
    // overwrite: the scratch folder persists between runs (RECUT_PERF_SCRATCH / os.tmpdir()/recut-perf).
    const req = { ...requestFor(seq), settings: { ...settings(), fileName: 'perf-export-full.mp4' }, overwrite: true };
    const g = buildRenderGraph(req);
    const chunks = planExportChunks({ req, startF: g.startF, endF: g.endF });
    let peakKb = 0; let procs = 0;
    const onSpawn = (child: import('node:child_process').ChildProcess) => {
      procs++;
      const sample = () => {
        try { const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8')); if (m) peakKb = Math.max(peakKb, Number(m[1])); } catch { /* exited */ }
      };
      const t = setInterval(sample, 100);
      child.once('exit', () => clearInterval(t));
    };
    const t0 = now();
    const res = await runExport(req, undefined, undefined, { onSpawn });
    const wall = now() - t0;
    const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'json', res.outputPath]).toString());
    const frames = Number(out.streams[0].nb_read_packets);
    record({ section: 'export', metric: 'full export 2500 clips: chunks / ffmpeg processes', value: `${res.chunks} / ${procs}`, unit: '', note: `segments per chunk (video) max ${Math.max(...chunks.map((c) => c.videoSegments))}` });
    record({ section: 'export', metric: 'full export 2500 clips: frames out / expected', value: `${frames} / ${g.frameCount}`, unit: 'frames', threshold: 'equal', pass: frames === g.frameCount });
    ms('export', 'full export 2500 clips wall time (1280x720 ultrafast)', wall);
    record({ section: 'export', metric: 'full export 2500 clips: peak ffmpeg RSS (MB)', value: round(peakKb / 1024), unit: 'MB', threshold: '<= 1536 MB', pass: peakKb / 1024 <= 1536 });
    console.log(`[perf] full export: ${res.chunks} chunks, ${frames}/${g.frameCount} frames, ${round(wall / 1000)} s, peak ffmpeg RSS ${round(peakKb / 1024)} MB`);
    expect(frames).toBe(g.frameCount);
    expect(peakKb / 1024).toBeLessThan(1536);
  });

});
