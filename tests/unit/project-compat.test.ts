/**
 * The project compatibility promise (docs/project-format.md → Compatibility promise): every saved-project fixture
 * (tests/fixtures/projects/recut-<version>.recut, each written by that release; see its README) opens through the
 * real open path with nothing lost, saving and reopening it is stable, and a file from a newer format is refused with
 * a clear message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProjectFile, saveProjectFile, BACKUP_EXT } from '../../electron/project/io';
import { serializeProject } from '../../shared/project';
import { PROJECT_FORMAT_VERSION } from '../../shared/model';
import type { Clip, Project, Sequence, Track } from '../../shared/model';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/projects');
const FIXTURE_RE = /^recut-(\d+)\.(\d+)\.(\d+)\.recut$/;

const fixtures = fs.readdirSync(FIXTURE_DIR)
  .map((f) => ({ file: f, m: FIXTURE_RE.exec(f) }))
  .filter((x): x is { file: string; m: RegExpExecArray } => !!x.m)
  .map(({ file, m }) => ({ file, version: `${m[1]}.${m[2]}.${m[3]}`, v: [Number(m[1]), Number(m[2]), Number(m[3])] as const }))
  .sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);

/** The fixture's release is `min` or later. */
const atLeast = (v: readonly number[], min: [number, number, number]) => (v[0] - min[0] || v[1] - min[1] || v[2] - min[2]) >= 0;

let tmp: string;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-compat-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

/** Plain JSON (class instances such as LiveView become plain objects). */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * Every value in `saved` is present, equal, in `opened` (which may add fields with their defaults). Returns the
 * paths that differ, so a failure names the field that was lost.
 */
function lostValues(saved: unknown, opened: unknown, at = '$', out: string[] = []): string[] {
  if (saved === null || typeof saved !== 'object') {
    if (!Object.is(saved, opened)) out.push(`${at}: saved ${JSON.stringify(saved)}, opened ${JSON.stringify(opened)}`);
    return out;
  }
  if (opened === null || typeof opened !== 'object' || Array.isArray(saved) !== Array.isArray(opened)) {
    out.push(`${at}: saved ${Array.isArray(saved) ? 'an array' : 'an object'}, opened ${JSON.stringify(opened)}`);
    return out;
  }
  if (Array.isArray(saved)) {
    const o = opened as unknown[];
    if (o.length !== saved.length) out.push(`${at}: saved ${saved.length} entries, opened ${o.length}`);
    saved.forEach((v, i) => lostValues(v, o[i], `${at}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(saved)) {
    if (!Object.hasOwn(opened, k)) out.push(`${at}.${k}: missing after open`);
    else lostValues(v, (opened as Record<string, unknown>)[k], `${at}.${k}`, out);
  }
  return out;
}

async function openFixture(file: string): Promise<{ project: Project; raw: Record<string, unknown>; copy: string }> {
  const copy = path.join(tmp, file);
  await fsp.copyFile(path.join(FIXTURE_DIR, file), copy);
  const res = await loadProjectFile(copy);
  if (!res.ok) throw new Error(`${file} did not open: ${res.error}`);
  expect(res.fromBackup).toBeFalsy();
  expect(res.repaired ?? []).toEqual([]);
  expect(res.preRepairPath).toBeUndefined();
  const raw = JSON.parse(await fsp.readFile(copy, 'utf8')) as Record<string, unknown>;
  return { project: res.project, raw, copy };
}

const byName = <T extends { name: string }>(xs: Iterable<T>, name: string): T => {
  const found = [...xs].find((x) => x.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};
const span = (c: Clip) => [c.start, c.duration];
const track = (seq: Sequence, kind: 'video' | 'audio', i: number): Track => (kind === 'video' ? seq.videoTracks : seq.audioTracks)[i];

describe('saved-project fixtures', () => {
  it('there is a fixture for every stable release from 0.3.0 on, including the version in package.json', () => {
    const versions = fixtures.map((f) => f.version);
    expect(versions).toEqual(expect.arrayContaining(['0.3.0', '0.4.0', '0.4.1', '0.5.0', '0.6.0']));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };
    // A release PR adds the new version's fixture (docs/RELEASING.md); a pre-release (1.0.0-rc.N) needs none.
    if (/^\d+\.\d+\.\d+$/.test(pkg.version)) expect(versions).toContain(pkg.version);
    // Never edited by hand: every fixture says which release saved it.
    for (const f of fixtures) {
      const text = fs.readFileSync(path.join(FIXTURE_DIR, f.file), 'utf8');
      expect(text).toContain(`"name": "Compatibility fixture (saved by ReCut ${f.version})"`);
    }
  });

  describe.each(fixtures)('ReCut $version', ({ file, version, v }) => {
    it('opens through the real open path without repairs, losing nothing it saved', async () => {
      const { project, raw } = await openFixture(file);
      expect(project.formatVersion).toBe(PROJECT_FORMAT_VERSION);
      expect(raw.formatVersion).toBeGreaterThanOrEqual(1);
      expect(raw.formatVersion).toBeLessThanOrEqual(PROJECT_FORMAT_VERSION);
      // Same format: every saved value is still there. (Once a migration reshapes an older format, the spot checks
      // below, and new ones for the migrated fields, are what proves that nothing was lost.)
      if (raw.formatVersion === PROJECT_FORMAT_VERSION) expect(lostValues(raw, plain(project))).toEqual([]);
    });

    it('keeps media, probe data, proxies, scenes and media subtitle tracks', async () => {
      const { project } = await openFixture(file);
      expect(project.name).toBe(`Compatibility fixture (saved by ReCut ${version})`);
      const media = Object.values(project.media);
      expect(media).toHaveLength(5);
      const movie = byName(media, 'The Empire Strikes Back (1980).mkv');
      const episode = byName(media, 'S01E02 – Rising Malevolence.mkv');
      const music = byName(media, 'John Williams – Main Title.flac');
      const still = byName(media, 'Title card – Amélie.png');
      const deleted = byName(media, 'Biggs at Anchorhead.mkv');
      expect(movie.path).toBe('D:\\Films\\Star Wars\\The Empire Strikes Back (1980).mkv');
      expect(episode.path).toBe('/home/fan/TV/The Clone Wars/S01E02 – Rising Malevolence.mkv');
      expect(still.path).toBe('/home/fan/Graphics/Title card – Amélie.png');
      expect([movie.kind, episode.kind, music.kind, still.kind]).toEqual(['video', 'video', 'audio', 'image']);
      expect(movie.identity).toEqual({ franchise: 'Star Wars', collection: 'Original Trilogy', title: 'The Empire Strikes Back', year: 1980 });
      expect(episode.identity).toMatchObject({ series: 'The Clone Wars', season: 1, episode: 2, title: 'Rising Malevolence' });
      expect(movie.category).toBe('Movie');
      expect(movie.fileSize).toBe(32_212_254_720);
      expect(movie.preferredAudioStream).toBe(1);
      expect(movie.probe?.video?.fps).toEqual({ num: 24000, den: 1001 });
      expect(movie.probe?.audio.map((a) => [a.index, a.codec, a.channels])).toEqual([[1, 'ac3', 6], [2, 'aac', 2]]);
      expect(movie.probe?.subtitles.map((s) => s.codec)).toEqual(['subrip', 'hdmv_pgs_subtitle']);
      expect(episode.probe?.video?.sar).toEqual({ num: 64, den: 45 });
      expect(deleted.offline).toBe(true);
      expect(deleted.probe?.video?.isVfr).toBe(true);

      expect(movie.proxy.status).toBe('ready');
      if (atLeast(v, [0, 4, 0])) {
        expect(movie.proxy.path).toMatch(/_540p_all\.mp4$/);
        expect(movie.proxy.audioStreams).toEqual([1, 2]);
      } else {
        expect(movie.proxy.path).toMatch(/_540p\.mp4$/);
        expect(movie.proxy.audioStreams).toBeUndefined();
      }
      expect(episode.proxy).toMatchObject({ status: 'failed', error: 'ffmpeg exited with code 1' });

      expect(movie.sceneDetectStatus).toBe('done');
      expect(movie.detectedScenes.map((s) => [s.start, s.end])).toEqual([[0, 83.2], [83.2, 190.04], [190.04, 312.5], [312.5, 455.75], [455.75, 7620.12]]);
      expect(movie.detectedScenes[1]).toMatchObject({ name: 'Hoth – Echo Base', tags: ['snow'], characters: ['Han', 'Leia'] });

      const tracks = Object.values(project.subtitleTracks);
      const srt = tracks.find((t) => t.origin === 'srt')!;
      expect(srt.path).toBe('D:\\Films\\Star Wars\\The Empire Strikes Back (1980).en.srt');
      expect(srt.cues.map((c) => [c.start, c.end, c.text])).toEqual([
        [1.5, 3.25, 'A long time ago…'],
        [4, 6.5, 'Echo Three to Echo Seven.\nHan, old buddy, do you read me?'],
        [121, 124.75, '<i>Do. Or do not.</i>'],
        [126, 128, 'There is no try.'],
      ]);
      expect(tracks.find((t) => t.origin === 'manual')).toMatchObject({ mediaId: episode.id, name: 'Notes' });
      const ocr = tracks.find((t) => t.origin === 'ocr');
      if (atLeast(v, [0, 6, 0])) {
        expect(ocr).toMatchObject({ mediaId: movie.id, streamIndex: 4, language: 'fre' });
        expect(ocr!.cues.map((c) => c.text)).toEqual(['Il y a bien longtemps…', 'Fais-le, ou ne le fais pas.']);
        expect(tracks).toHaveLength(3);
      } else {
        expect(ocr).toBeUndefined();
        expect(tracks).toHaveLength(2);
      }
      for (const m of media) for (const id of m.subtitleTrackIds) expect(project.subtitleTracks[id]?.mediaId).toBe(m.id);

      const bins = project.bins;
      expect(bins[movie.binId!]).toMatchObject({ name: 'Star Wars', kind: 'collection', parentId: 'bin-movies' });
      const season = bins[episode.binId!];
      expect(season).toMatchObject({ name: 'Season 1', kind: 'season' });
      expect(bins[season.parentId!]).toMatchObject({ name: 'The Clone Wars', kind: 'series' });
      expect(music.binId).toBe('bin-audio');

      const scenes = Object.values(project.scenes);
      expect(scenes).toHaveLength(2);
      expect(byName(scenes, 'Biggs farewell')).toMatchObject({ mediaId: deleted.id, in: 12.5, out: 58.25, rating: 4, location: 'Anchorhead' });
      expect(byName(scenes, 'Luke meets Yoda')).toMatchObject({ mediaId: movie.id, in: 120, characters: ['Luke', 'Yoda'] });

      expect(project.tags.themes).toEqual(['Redemption']);
      expect(project.tags.characters).toEqual(expect.arrayContaining(['Luke', 'Yoda', 'Han', 'Leia', 'Biggs']));
      expect(project.settings).toEqual({
        useProxies: false, proxyHeight: 720, autosaveIntervalSec: 120, carrySubtitles: false, sceneThreshold: 0.42,
        playbackResolution: '1/2', snapping: false, defaultTransitionFrames: 12, showSourceTimecodeOnClips: true,
      });
    });

    it('keeps sequences: clip positions in frames, links, transitions, markers, story blocks, subtitles, snapshots', async () => {
      const { project } = await openFixture(file);
      const seqs = project.sequenceOrder.map((id) => project.sequences[id]);
      expect(seqs.map((s) => s.name)).toEqual(['Episode V – Despecialized', 'Episode V – Alt cut', 'Clone Wars recap']);
      const [main, alt, pal] = seqs;
      expect(project.activeSequenceId).toBe(main.id);
      expect(main.fps).toEqual({ num: 24000, den: 1001 });

      const v1 = track(main, 'video', 0), v2 = track(main, 'video', 1), a1 = track(main, 'audio', 0), a2 = track(main, 'audio', 1);
      expect(v1.clips.map(span)).toEqual([[0, 240], [240, 360], [600, 228]]);
      expect(a1.clips.map(span)).toEqual([[0, 240], [240, 360], [600, 228]]);
      expect(v1.clips.map((c) => c.sourceIn)).toEqual([0, 120, 30]);
      v1.clips.forEach((c, i) => {
        expect(c.linkId).toBeTruthy();
        expect(a1.clips[i].linkId).toBe(c.linkId);
      });
      expect(new Set(v1.clips.map((c) => c.linkId)).size).toBe(3);
      expect(a1.clips.map((c) => c.enabled)).toEqual([true, true, false]);
      expect(a1.clips[0].audioStream).toBe(1);
      expect(a1.clips[0].audio).toMatchObject({ gain: -3, volume: 0.8, fadeIn: 12 });
      expect(v1.clips[1]).toMatchObject({ name: 'Luke meets Yoda', characters: ['Luke', 'Yoda'], plotlines: ['Jedi Training'], locations: ['Dagobah'], tags: ['keep'], color: '#30a46c' });
      expect(v2.locked).toBe(true);
      expect(v2.clips.map(span)).toEqual([[48, 96]]);
      const { keyframes: titleKeys, ...titleTransform } = v2.clips[0].transform;
      expect(titleTransform).toEqual({ x: 40, y: -20, scale: 0.8, rotation: 2.5, opacity: 0.9, crop: { left: 0.05, top: 0, right: 0.05, bottom: 0.1 } });
      expect(a2).toMatchObject({ name: 'Music', volume: 0.7 });
      expect(a2.clips.map(span)).toEqual([[0, 480]]);
      expect(a2.clips[0].audio).toMatchObject({ fadeOut: 24, volume: 0.5 });
      // Keyframes (Roadmap §11) from 0.13.0: clip-relative frames, interpolation only where it is 'ease'.
      if (atLeast(v, [0, 13, 0])) {
        expect(plain(titleKeys)).toEqual({
          opacity: [{ frame: 0, value: 0, interp: 'ease' }, { frame: 24, value: 0.9 }],
          scale: [{ frame: 0, value: 0.8 }, { frame: 95, value: 1.1, interp: 'ease' }],
          x: [{ frame: 12, value: 40 }, { frame: 90, value: -60 }],
          y: [{ frame: 12, value: -20 }, { frame: 90, value: -20 }],
        });
        expect(plain(a2.clips[0].audio.keyframes)).toEqual({ volume: [
          { frame: 48, value: 0.5, interp: 'ease' }, { frame: 72, value: 0.2 }, { frame: 96, value: 0.2, interp: 'ease' }, { frame: 120, value: 0.5 },
        ] });
      } else {
        expect(titleKeys).toBeUndefined();
        expect(a2.clips[0].audio.keyframes).toBeUndefined();
      }
      for (const c of [...v1.clips, ...a1.clips]) expect([c.transform.keyframes, c.audio.keyframes]).toEqual([undefined, undefined]);

      expect(v1.transitions.map((t) => [t.type, t.duration, t.outClipId, t.inClipId]).sort()).toEqual([
        ['crossDissolve', 12, v1.clips[0].id, v1.clips[1].id],
        ['dipToBlack', 24, v1.clips[2].id, null],
      ]);
      expect(a1.transitions.map((t) => [t.type, t.duration, t.outClipId, t.inClipId])).toEqual([['audioCrossfade', 12, a1.clips[0].id, a1.clips[1].id]]);

      const marks = main.markers.map((m) => [m.kind, m.time, m.duration, m.name]);
      expect(marks).toEqual([
        ['chapter', 0, 0, 'Chapter 1 – Hoth'],
        ['marker', 24, 48, 'Check the title timing'],
        ['chapter', 240, 0, 'Chapter 2 – Dagobah'],
        ['continuity', 270, 0, "Luke's jacket"],
        ['continuity', 605, 24, 'Music cuts off'],
      ]);
      expect(main.markers[3]).toMatchObject({ category: 'wardrobe', resolved: true, clipId: v1.clips[1].id });
      expect(main.markers[4]).toMatchObject({ category: 'music', resolved: false });
      expect(main.storyBlocks.map((b) => [b.name, b.start, b.end])).toEqual([['Act I – Hoth', 0, 240], ['Act II – Training', 240, 840]]);

      const subs = main.subtitleTracks;
      const eng = byName(subs, 'eng');
      expect(eng.sourcePaths).toEqual(['D:\\Films\\Star Wars\\The Empire Strikes Back (1980).en.srt']);
      expect(eng.cues.map((c) => [c.clipId, c.srcStart, c.srcEnd, c.offset, c.text])).toEqual([
        [v1.clips[0].id, 1.5, 3.25, 3, 'A long time ago…'],
        [v1.clips[0].id, 4, 6.5, 0, 'Echo Three to Echo Seven.\nHan, old buddy, do you read me?'],
        [v1.clips[1].id, 121, 124.75, 0, '<i>Do. Or do not.</i>'],
        [v1.clips[1].id, 126, 128, 0, 'There is no try.'],
      ]);
      expect(byName(subs, 'Notes').cues.map((c) => [c.clipId, c.text])).toEqual([[v1.clips[2].id, 'Malevolence fires']]);
      expect(byName(subs, 'Forced').cues.map((c) => [c.clipId, c.start, c.duration, c.text])).toEqual([
        [undefined, 60, 48, 'Somewhere on Hoth'], [undefined, 250, 36, 'Dagobah system\n(forced)'],
      ]);
      expect(subs.some((t) => t.language === 'fre')).toBe(atLeast(v, [0, 6, 0]));
      expect(plain(main.view)).toEqual({ playhead: 120, zoom: 2, scroll: 16, inPoint: 24, outPoint: 600 });

      expect(main.snapshots).toHaveLength(1);
      const snap = main.snapshots[0];
      expect(snap.name).toBe('Before act 2 trim');
      expect(snap.data.videoTracks[0].clips.map(span)).toEqual([[0, 240], [240, 360], [600, 240]]);
      expect(snap.data.markers).toHaveLength(5);

      expect(alt.parentSequenceId).toBe(main.id);
      expect(alt.versionLabel).toBe('v2');
      expect(track(alt, 'audio', 0).clips.map(span)).toEqual([[0, 240], [240, 360]]);
      expect(track(alt, 'video', 0).clips.map(span)).toEqual([[0, 240], [240, 360], [600, 228]]);

      expect(pal.fps).toEqual({ num: 25, den: 1 });
      expect([pal.width, pal.height, pal.channels]).toEqual([1280, 720, 6]);
      expect(track(pal, 'video', 0).clips.map((c) => [c.start, c.duration, c.sourceIn])).toEqual([[0, 313, 100]]);
      expect(pal.markers.map((m) => [m.kind, m.time, m.name])).toEqual([['chapter', 25, 'Recap']]);

      // Every clip still points at an existing media item.
      const mediaIds = new Set(Object.keys(project.media));
      for (const s of seqs) for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) expect(mediaIds.has(c.mediaId)).toBe(true);
    });

    it('save → reopen is stable (idempotent)', async () => {
      const { project, copy } = await openFixture(file);
      const first = plain(project);
      const saved = await saveProjectFile(copy, project);
      expect(saved.ok).toBe(true);
      const again = await loadProjectFile(copy);
      if (!again.ok) throw new Error(again.error);
      expect(again.repaired).toBeUndefined();
      expect(plain(again.project)).toEqual(first);
      // A second save writes the same bytes as the first.
      const text1 = await fsp.readFile(copy, 'utf8');
      expect(serializeProject(again.project)).toBe(text1);
      // The save kept the release's file as the backup.
      expect(fs.existsSync(copy + BACKUP_EXT)).toBe(true);
    });
  });

  it('refuses a fixture rewritten with a newer formatVersion, with a clear message, and never uses its .bak', async () => {
    const latest = fixtures[fixtures.length - 1];
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, latest.file), 'utf8')) as Record<string, unknown>;
    const file = path.join(tmp, 'from-the-future.recut');
    await fsp.writeFile(file, JSON.stringify({ ...raw, formatVersion: PROJECT_FORMAT_VERSION + 1 }));
    await fsp.copyFile(path.join(FIXTURE_DIR, latest.file), file + BACKUP_EXT);
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe(`Could not open project: Project was saved by a newer ReCut (format ${PROJECT_FORMAT_VERSION + 1}); this build reads ${PROJECT_FORMAT_VERSION}.`);
    // Refusal leaves the file alone.
    expect(JSON.parse(await fsp.readFile(file, 'utf8')).formatVersion).toBe(PROJECT_FORMAT_VERSION + 1);
    expect(fs.readdirSync(tmp).sort()).toEqual(['from-the-future.recut', 'from-the-future.recut.bak']);
  });
});

// Keep the fixture helpers honest.
describe('lostValues', () => {
  it('reports values missing or changed after open, and accepts added defaults', () => {
    expect(lostValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2], c: 3 })).toEqual([]);
    expect(lostValues({ a: 1, b: { c: 'x' } }, { a: 2, b: {} })).toEqual(['$.a: saved 1, opened 2', '$.b.c: missing after open']);
    expect(lostValues({ l: [1, 2] }, { l: [1] })).toHaveLength(2);
  });
});
