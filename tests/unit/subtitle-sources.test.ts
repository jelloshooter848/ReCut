/**
 * Subtitle files the project reads its cues from are project sources: an export (video sidecar or the
 * Subtitles panel) must never overwrite them. The import routes must therefore record where the cues came
 * from, and projectSourcePaths must list those paths:
 *   - Subtitles panel "Import subtitles to track" (importSubtitlesToTrack → a sequence subtitle track);
 *   - Transcript "Subtitle file (SRT / WebVTT)" provider (transcribeWith → a media subtitle track), which
 *     picks up `Episode01.srt` next to `Episode01.mkv` on its own.
 * Real files under os.tmpdir(); the preload bridge is stubbed with the real main-process fs helpers.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, Project, Sequence } from '@shared/model';
import { createMediaItem, createProject, createSequence, normalizeProject } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { useStore, resetStore } from '../../src/state/store';
import { importSubtitlesToTrack } from '../../src/panels/subtitles/exportSubtitles';
import { transcribeWith } from '../../src/panels/transcript/shared';
import { SubtitleFileProvider } from '../../src/transcript/providers';
import { buildExportRequest, projectSourcePaths } from '../../src/panels/export/request';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { runExport } from '../../electron/export/exporter';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { readText, stat } from '../../electron/fs';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FPS = { num: 24, den: 1 };
const ORIGINAL_SRT = '1\n00:00:00,000 --> 00:00:01,000\nUSER ORIGINAL LINE\n\n';

let root: string;
let videoFile: string;
let dir: string;
let episode: string;
let srt: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-subtitle-sources-'));
  videoFile = path.join(root, 'red.mp4');
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', videoFile,
  ], ffmpegMajorVersionSync(FFMPEG))]);
}, 60000);

afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

/** The user's episode (in the project) and its subtitle file next to it: the fan-edit norm. */
function fixture(): { project: Project; seq: Sequence; media: MediaItem } {
  const project = createProject('Sources');
  const media: MediaItem = { ...createMediaItem(episode, 'Episode01.mkv'), id: 'm-ep', kind: 'video' };
  project.media[media.id] = media;
  const seq = createSequence('Edit', FPS, 320, 240);
  seq.subtitleTracks.push({ id: 'sst', name: 'Dialogue', language: 'en', enabled: true, cues: [] });
  project.sequences = { [seq.id]: seq };
  project.sequenceOrder = [seq.id];
  project.activeSequenceId = seq.id;
  return { project, seq, media };
}

function settings(over: Partial<ExportSettings>): ExportSettings {
  return {
    outputDir: dir, fileName: 'Episode01.mp4', width: 320, height: 240, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 30, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: true, useProxies: false, ...over,
  } as ExportSettings;
}

/** A timeline the exporter can render (the episode file is a real video). */
function withClip(project: Project, seq: Sequence, media: MediaItem): void {
  seq.videoTracks[0].clips.push(makeClip({ mediaId: media.id, name: 'ep', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 0));
  seq.subtitleTracks[0].cues.push({ id: 'q', start: 0, duration: 12, offset: 0, text: 'Export cue' });
  project.media[media.id] = media;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'));
  episode = path.join(dir, 'Episode01.mkv');
  fs.copyFileSync(videoFile, episode);
  srt = path.join(dir, 'Episode01.srt');
  fs.writeFileSync(srt, ORIGINAL_SRT);
  resetStore();
  vi.stubGlobal('window', { recut: { readText, stat }, setTimeout: () => 0, clearTimeout: () => undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Subtitles panel "Import subtitles to track" records the file it read', () => {
  it('the sequence track keeps the source path, and a sidecar export over it is refused', async () => {
    const { project, seq, media } = fixture();
    useStore.setState({ project });
    const res = await importSubtitlesToTrack({ seqId: seq.id, trackId: 'sst', path: srt });
    expect(res.ok).toBe(true);
    const after = useStore.getState().project;
    const track = after.sequences[seq.id].subtitleTracks.find((t) => t.id === 'sst')!;
    expect(track.cues.map((c) => c.text)).toEqual(['USER ORIGINAL LINE']);
    expect(track.sourcePaths).toEqual([srt]);
    expect(projectSourcePaths(after)).toContain(srt);

    // Export Episode01.mp4 next to it with the .srt sidecar on: refused before anything is written.
    const exported = structuredClone(after);
    const s = exported.sequences[seq.id];
    withClip(exported, s, media);
    const req = buildExportRequest(exported, s, settings({}));
    expect(req.protectedPaths).toContain(srt);
    expect(() => buildRenderGraph(req)).toThrow(/Episode01\.srt".*source file of the project/);
    await expect(runExport(req)).rejects.toThrow(/source file of the project/);
    expect(fs.readFileSync(srt, 'utf8')).toBe(ORIGINAL_SRT);
  }, 30000);

  it('importing a second file into the same track records both, once each', async () => {
    const { project, seq } = fixture();
    useStore.setState({ project });
    const other = path.join(dir, 'Episode01.fr.vtt');
    fs.writeFileSync(other, 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nBonjour\n');
    expect((await importSubtitlesToTrack({ seqId: seq.id, trackId: 'sst', path: srt })).ok).toBe(true);
    expect((await importSubtitlesToTrack({ seqId: seq.id, trackId: 'sst', path: other })).ok).toBe(true);
    expect((await importSubtitlesToTrack({ seqId: seq.id, trackId: 'sst', path: srt })).ok).toBe(true);
    const track = useStore.getState().project.sequences[seq.id].subtitleTracks[0];
    expect(track.sourcePaths).toEqual([srt, other]);
  });

  it('the recorded path survives a save / load round trip (normalizeProject)', async () => {
    const { project, seq } = fixture();
    useStore.setState({ project });
    await importSubtitlesToTrack({ seqId: seq.id, trackId: 'sst', path: srt });
    const loaded = normalizeProject(JSON.parse(JSON.stringify(useStore.getState().project)));
    expect(loaded.sequences[seq.id].subtitleTracks[0].sourcePaths).toEqual([srt]);
    expect(projectSourcePaths(loaded)).toContain(srt);
  });

  it('paths recorded in another sequence, or only in a sequence snapshot, are protected too', () => {
    const { project, seq } = fixture();
    const other = createSequence('Other', FPS, 320, 240);
    other.subtitleTracks.push({ id: 'o', name: 'o', language: 'en', enabled: true, cues: [], sourcePaths: ['/subs/other.srt'] });
    const { snapshots: _s, ...data } = structuredClone(seq);
    data.subtitleTracks = [{ id: 'old', name: 'old', language: 'en', enabled: true, cues: [], sourcePaths: ['/subs/snap.srt'] }];
    seq.snapshots.push({ id: 'snap', name: 'before', createdAt: 0, data });
    project.sequences[other.id] = other;
    const paths = projectSourcePaths(project);
    expect(paths).toContain('/subs/other.srt');
    expect(paths).toContain('/subs/snap.srt');
  });

  it('hostile project data in sourcePaths is ignored, not trusted or crashed on', () => {
    const { project, seq } = fixture();
    (seq.subtitleTracks[0] as unknown as { sourcePaths: unknown }).sourcePaths = ['/ok.srt', 42, null, ''];
    seq.subtitleTracks.push({ ...seq.subtitleTracks[0], id: 'x', sourcePaths: 'not-an-array' as unknown as string[] });
    expect(projectSourcePaths(project).filter((p) => p.endsWith('.srt'))).toEqual(['/ok.srt']);
  });
});

describe('Transcript SubtitleFileProvider records the sidecar it picked up', () => {
  it('transcribeWith stores the sidecar path on the media subtitle track, and a sidecar export over it is refused', async () => {
    const { project, seq, media } = fixture();
    useStore.setState({ project });
    await transcribeWith(new SubtitleFileProvider(), media.id);
    const after = useStore.getState().project;
    const tracks = Object.values(after.subtitleTracks);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].cues.map((c) => c.text)).toEqual(['USER ORIGINAL LINE']);
    expect(tracks[0].origin).toBe('subtitle-file');
    expect(tracks[0].path).toBe(srt);
    expect(projectSourcePaths(after)).toContain(srt);

    const exported = structuredClone(after);
    const s = exported.sequences[seq.id];
    withClip(exported, s, exported.media[media.id]);
    const req = buildExportRequest(exported, s, settings({}));
    expect(() => buildRenderGraph(req)).toThrow(/source file of the project/);
    await expect(runExport(req)).rejects.toThrow(/source file of the project/);
    expect(fs.readFileSync(srt, 'utf8')).toBe(ORIGINAL_SRT);
  }, 30000);

  it('projects saved before the fix (subtitle-file track without a path) still protect the sidecar names of its media', () => {
    const { project, seq, media } = fixture();
    project.subtitleTracks['legacy'] = {
      id: 'legacy', name: 'Subtitle file (SRT / WebVTT)', language: 'und', mediaId: media.id,
      cues: [{ id: 'c', start: 0, end: 1, text: 'USER ORIGINAL LINE' }], origin: 'subtitle-file',
    };
    withClip(project, seq, media);
    const paths = projectSourcePaths(project);
    expect(paths).toContain(srt);
    expect(paths).toContain(path.join(dir, 'Episode01.en.vtt'));
    expect(() => buildRenderGraph(buildExportRequest(project, seq, settings({})))).toThrow(/source file of the project/);
    // A track whose media is gone protects the sidecar names of every media item (its file is unknown).
    project.subtitleTracks['legacy'].mediaId = 'gone';
    expect(projectSourcePaths(project)).toContain(srt);
  });
});
