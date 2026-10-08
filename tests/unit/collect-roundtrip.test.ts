/**
 * Collect round trips (1.0 release candidates: "Collect round trips"). A project with everything 0.8.0 added is
 * collected into a temp folder through the real main-process code (electron/project/collect.ts), the collected file
 * is opened through the real open path (loadProjectFile), and:
 *  - every file reference (media, proxies, channel proxies, subtitle files, sequence subtitle sources, also in
 *    snapshots) points into the collected folder, and at a byte-identical copy, or is one the options leave alone
 *    (offline media, unused media with "media used in sequences", proxies / subtitles when not included);
 *  - nothing else changed: the collected project is byte-for-byte the requested one once file paths are masked
 *    (clips, nested sequences, keyframes, channel selections, Whisper / OCR tracks, markers, snapshots, ...);
 *  - it opens without repairs, and collecting the collected project again gives the same project and layout.
 *
 * The project is the 0.8.0 compatibility fixture (tests/fixtures/projects/recut-0.8.0.recut, made by
 * scripts/project-fixture-scenario.mjs: keyframes, a compound clip "Reel 1" and the PAL recap nested in the alt cut,
 * an OCR track, a still, an offline file, Windows and POSIX paths), re-homed onto real files in a temp folder and
 * extended with the store's own actions:
 *  - media used ONLY inside a sequence nested two levels deep (Main > Act II > Deleted scenes): two same-named files
 *    from different folders (`Disc 1/title_t00.mkv`, `Disc 2/title_t00.mkv`) and the fixture's offline file;
 *  - the PAL recap nested a second time (in the main sequence too); a keyframed nested clip;
 *  - an extracted centre channel (channelSelection FC) and a downmix selection, with their ready channel proxies;
 *  - a Whisper transcript track (project data, no file);
 *  - a still proxy and a proxy of a media used only inside the nested sequence;
 *  - a snapshot whose subtitle track names a source file the live sequence no longer has;
 *  - a media item no sequence uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-collect-rt-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { JobQueue } from '../../electron/jobs/jobQueue';
import { startCollectJob } from '../../electron/project/collect';
import { loadProjectFile } from '../../electron/project/io';
import { channelProxyOutputPath } from '../../electron/media/channelProxy';
import { cacheSubdir } from '../../electron/media/cache';
import { useStore, resetStore } from '../../src/state/store';
import { serializeProjectSliced } from '../../src/state/mediaActions';
import { createMediaItem, createSequence, normalizeProject, serializeProject } from '../../shared/project';
import { allTracks, clipEnd } from '../../shared/timeline';
import { isNestedClip, nestDepthBelow } from '../../shared/nest';
import { channelProxyKey } from '../../shared/audioChannels';
import { pathComponents, type CollectOptions, type CollectResult } from '../../shared/collect';
import type { Clip, MediaItem, Project, Sequence } from '../../shared/model';

const FIXTURE = path.resolve(__dirname, '../fixtures/projects/recut-0.8.0.recut');
const SRC = path.join(tmp, 'sources');
const S = () => useStore.getState();

/** Where an original path of the fixture lives in this test: the same components under SRC. */
const home = (p: string) => path.join(SRC, ...pathComponents(p));

/** Write a small file with content unique to its path (so a copy of the wrong file is caught). */
function makeFile(file: string, kb = 3): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(`${file}\n`.repeat(Math.ceil((kb * 1024) / (file.length + 1)))));
}

/** Every file reference in a project: [where, path]. The path fields of the model, nothing else. */
function fileRefs(p: Project): [string, string][] {
  const out: [string, string][] = [];
  for (const m of Object.values(p.media)) {
    out.push([`media ${m.name}`, m.path]);
    if (m.proxy?.path) out.push([`proxy of ${m.name}`, m.proxy.path]);
    for (const [k, cp] of Object.entries(m.channelProxies ?? {})) if (cp.path) out.push([`channel proxy ${k} of ${m.name}`, cp.path]);
  }
  for (const t of Object.values(p.subtitleTracks)) if (t.path) out.push([`subtitle track ${t.name}`, t.path]);
  for (const seq of Object.values(p.sequences)) {
    for (const t of seq.subtitleTracks) (t.sourcePaths ?? []).forEach((sp, i) => out.push([`${seq.name} › ${t.name} source ${i}`, sp]));
    for (const snap of seq.snapshots) for (const t of snap.data.subtitleTracks) (t.sourcePaths ?? []).forEach((sp, i) => out.push([`${seq.name} › snapshot ${snap.name} › ${t.name} source ${i}`, sp]));
  }
  return out;
}

/** The project as JSON with every file reference replaced by a placeholder: what must not change in a collect. */
function maskPaths(p: Project): string {
  const c = JSON.parse(serializeProject(p)) as Project;
  const mask = '<path>';
  for (const m of Object.values(c.media)) {
    m.path = mask;
    if (m.proxy?.path) m.proxy.path = mask;
    for (const cp of Object.values(m.channelProxies ?? {})) if (cp.path) cp.path = mask;
  }
  for (const t of Object.values(c.subtitleTracks)) if (t.path) t.path = mask;
  for (const seq of Object.values(c.sequences)) {
    for (const t of seq.subtitleTracks) if (t.sourcePaths) t.sourcePaths = t.sourcePaths.map(() => mask);
    for (const snap of seq.snapshots) for (const t of snap.data.subtitleTracks) if (t.sourcePaths) t.sourcePaths = t.sourcePaths.map(() => mask);
  }
  return serializeProject(c);
}

/** Every string anywhere in `v` (to prove no path hides in a field fileRefs does not know). */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) allStrings(x, out);
  return out;
}

const inside = (folder: string, p: string) => { const r = path.relative(folder, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const clipsOf = (s: Pick<Sequence, 'videoTracks' | 'audioTracks'>): Clip[] => allTracks(s as Sequence).flatMap((t) => t.clips);
const byName = <T extends { name: string }>(xs: Iterable<T>, name: string): T => {
  const x = [...xs].find((y) => y.name === name);
  if (!x) throw new Error(`no ${name}`);
  return x;
};
const seqEnd = (s: Sequence) => Math.max(0, ...clipsOf(s).map(clipEnd));
const keyframeJson = (p: Project) => Object.fromEntries(Object.values(p.sequences).flatMap((s) => [
  ...clipsOf(s), ...s.snapshots.flatMap((sn) => clipsOf(sn.data)),
].filter((c) => c.transform.keyframes || c.audio.keyframes).map((c) => [`${s.id}/${c.id}`, JSON.stringify([c.transform.keyframes, c.audio.keyframes])])));

let requestJson = '';
let requested: Project;
/** Files the project references that exist (originals): path -> bytes. */
const originals = new Map<string, Buffer>();
let ids: { movie: string; episode: string; still: string; offline: string; disc1: string; disc2: string; unused: string; main: string; alt: string; recap: string; reel: string; act2: string; deleted: string };
let offlinePath = '';
let unusedPath = '';
let snapshotOnlySrt = '';

beforeAll(async () => {
  // 1. The 0.8.0 fixture, opened through the real open path.
  const copy = path.join(tmp, 'fixture.recut');
  await fsp.copyFile(FIXTURE, copy);
  const opened = await loadProjectFile(copy);
  if (!opened.ok) throw new Error(opened.error);
  expect(opened.repaired ?? []).toEqual([]);
  const p = opened.project;

  // 2. Re-home every file reference onto a real file under SRC (the offline item stays missing).
  const media = Object.values(p.media);
  const offline = media.find((m) => m.offline)!;
  for (const m of media) {
    m.path = home(m.path);
    if (!m.offline) makeFile(m.path, 8);
    if (m.proxy?.path) {
      m.proxy.path = path.join(cacheSubdir('proxies'), path.basename(m.proxy.path));
      makeFile(m.proxy.path);
    }
  }
  offlinePath = offline.path;
  for (const t of Object.values(p.subtitleTracks)) if (t.path) { t.path = home(t.path); makeFile(t.path, 1); }
  const rehomeSources = (tracks: Sequence['subtitleTracks']) => {
    for (const t of tracks) if (t.sourcePaths) t.sourcePaths = t.sourcePaths.map((sp) => { const h = home(sp); makeFile(h, 1); return h; });
  };
  for (const seq of Object.values(p.sequences)) {
    rehomeSources(seq.subtitleTracks);
    for (const snap of seq.snapshots) rehomeSources(snap.data.subtitleTracks);
  }
  // The main sequence's snapshot still names a subtitle file its live track no longer has (re-imported since).
  const main0 = byName(Object.values(p.sequences), 'Episode V – Despecialized');
  snapshotOnlySrt = path.join(SRC, 'Subs', 'old timing', 'Episode V.en.srt');
  makeFile(snapshotOnlySrt, 1);
  byName(main0.snapshots[0].data.subtitleTracks, 'eng').sourcePaths!.push(snapshotOnlySrt);

  resetStore();
  S().loadProjectData(p, null);

  // 3. Extend it with the store's own actions.
  const P = () => S().project;
  const movie = byName(Object.values(P().media), 'The Empire Strikes Back (1980).mkv');
  const episode = byName(Object.values(P().media), 'S01E02 – Rising Malevolence.mkv');
  const still = byName(Object.values(P().media), 'Title card – Amélie.png');
  const seqs = () => Object.values(P().sequences);
  const main = byName(seqs(), 'Episode V – Despecialized');
  const alt = byName(seqs(), 'Episode V – Alt cut');
  const recap = byName(seqs(), 'Clone Wars recap');
  const reel = byName(seqs(), 'Reel 1');

  // Media used only inside a sequence nested two levels deep; two of them same-named files from different folders.
  const disc = (n: number): MediaItem => {
    const f = path.join(SRC, 'Rips', `Disc ${n}`, 'title_t00.mkv');
    makeFile(f, 8);
    return { ...createMediaItem(f, `Disc ${n} title_t00.mkv`), kind: 'video', probe: structuredClone(episode.probe) };
  };
  const d1 = disc(1), d2 = disc(2);
  unusedPath = path.join(SRC, 'Rips', 'Unused', 'b-roll.mkv');
  makeFile(unusedPath, 4);
  const unused: MediaItem = { ...createMediaItem(unusedPath, 'b-roll.mkv'), kind: 'video', probe: structuredClone(episode.probe) };
  S().addMedia([d1, d2, unused]);
  const deleted = createSequence('Deleted scenes', main.fps);
  S().addSequence(deleted, { activate: false });
  S().insertFromSource(deleted.id, { mediaId: d1.id, in: 0, out: 2, atFrame: 0, mode: 'overwrite' });
  S().insertFromSource(deleted.id, { mediaId: d2.id, in: 3, out: 5, atFrame: 48, mode: 'overwrite' });
  // The fixture's offline file, used in there too: reported missing by the collect, its path kept.
  expect(S().insertFromSource(deleted.id, { mediaId: offline.id, in: 0, out: 1, atFrame: 96, mode: 'overwrite' }).length).toBeGreaterThan(0);
  const act2 = createSequence('Act II', main.fps);
  S().addSequence(act2, { activate: false });
  expect(S().nestSequence(act2.id, deleted.id, 0).length).toBeGreaterThan(0);
  const mainEnd = seqEnd(P().sequences[main.id]);
  const nestedAct2 = S().nestSequence(main.id, act2.id, mainEnd + 24);
  expect(nestedAct2.length).toBeGreaterThan(0);
  // The PAL recap, already nested in the alt cut, nested in the main sequence too.
  expect(S().nestSequence(main.id, recap.id, seqEnd(P().sequences[main.id]) + 24).length).toBeGreaterThan(0);
  expect(nestDepthBelow(P().sequences, main.id)).toBe(2);
  // A keyframed nested clip (opacity fade in on Act II).
  const act2Video = clipsOf(P().sequences[main.id]).find((c) => nestedAct2.includes(c.id) && c.kind === 'video')!;
  S().addClipKeyframe(main.id, [act2Video.id], 'opacity', 0);
  S().addClipKeyframe(main.id, [act2Video.id], 'opacity', 24);

  // Channel selections: the centre channel extracted from the movie's 5.1, and a downmix on another movie clip.
  const movieAudio = P().sequences[main.id].audioTracks[0].clips.filter((c) => c.mediaId === movie.id);
  const centre = S().extractCentreChannel(main.id, movieAudio[0].id);
  if (!centre.ok) throw new Error(centre.reason);
  const downmix = { mode: 'downmix', centreDb: -3, surroundDb: -3 } as const;
  S().setClipChannelSelection(main.id, [movieAudio[1].id], downmix);
  // Their preview proxies, as the channel-proxy jobs leave them (cache files named like electron/media/channelProxy.ts).
  const fc = channelProxyKey(1, { mode: 'channel', channel: 'FC' });
  const dm = channelProxyKey(1, downmix);
  const fcFile = channelProxyOutputPath('0123456789abcdef', fc);
  const dmFile = channelProxyOutputPath('0123456789abcdef', dm);
  makeFile(fcFile); makeFile(dmFile);
  S().setChannelProxies(movie.id, {
    [fc]: { status: 'ready', path: fcFile, progress: 1 },
    [dm]: { status: 'ready', path: dmFile, progress: 1 },
    '2.ch-FL': { status: 'failed', error: 'Canceled' },
  });

  // A Whisper transcript of the movie (project data: no file).
  S().putWhisperSubtitleTrack({
    id: 'sub-whisper-1', name: 'English (Whisper Base)', language: 'eng', mediaId: movie.id, origin: 'whisper', streamIndex: 1,
    cues: [{ id: 'w1', start: 1.5, end: 3.25, text: 'I am your father.' }, { id: 'w2', start: 4, end: 6, text: 'Nooo — ¡no!' }],
  });
  // Proxies: a still proxy, and a proxy of a media used only inside the nested sequence.
  const stillProxy = path.join(cacheSubdir('proxies'), 'aaaa1111_still.png');
  const d1Proxy = path.join(cacheSubdir('proxies'), 'bbbb2222_540p_all.mp4');
  makeFile(stillProxy); makeFile(d1Proxy);
  S().setProxy(still.id, { status: 'ready', path: stillProxy, width: 1920, height: 1080 });
  S().setProxy(d1.id, { status: 'ready', path: d1Proxy, width: 675, height: 540, audioStreams: [1] });

  ids = {
    movie: movie.id, episode: episode.id, still: still.id, offline: offline.id, disc1: d1.id, disc2: d2.id, unused: unused.id,
    main: main.id, alt: alt.id, recap: recap.id, reel: reel.id, act2: act2.id, deleted: deleted.id,
  };

  // 4. What the dialog sends (src/panels/collect/CollectDialog.tsx), and what the main process will collect.
  requestJson = await serializeProjectSliced(P(), true);
  requested = normalizeProject(JSON.parse(requestJson));
  for (const [, f] of fileRefs(requested)) if (fs.existsSync(f)) originals.set(f, fs.readFileSync(f));
}, 60_000);

afterAll(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

async function collect(json: string, dest: string, options: CollectOptions): Promise<{ r: CollectResult; project: Project; text: string }> {
  fs.mkdirSync(dest, { recursive: true });
  const q = new JobQueue({ throttleMs: 5 });
  const res = await startCollectJob(q, { projectJson: json, destination: dest, options });
  if (!res.ok) throw new Error(res.error);
  const job = await q.waitFor(res.jobId);
  q.flush();
  expect(job.status, job.error).toBe('done');
  const r = job.result as CollectResult;
  const loaded = await loadProjectFile(r.projectFile);
  if (!loaded.ok) throw new Error(loaded.error);
  // Opens through the real open path with no repairs, from the file itself (not a backup).
  expect(loaded.repaired ?? []).toEqual([]);
  expect(loaded.fromBackup).toBeFalsy();
  expect(loaded.preRepairPath).toBeUndefined();
  return { r, project: loaded.project, text: await fsp.readFile(r.projectFile, 'utf8') };
}

const filesIn = (folder: string) => fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => path.relative(folder, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();

/** Nested structure, clip by clip: what each sequence plays (media or nested sequence) where. */
const structure = (p: Project) => Object.fromEntries(Object.values(p.sequences).map((s) => [s.name, clipsOf(s).map((c) => [
  c.kind, c.start, c.duration, isNestedClip(c) ? `seq:${p.sequences[c.sequenceId]?.name}` : `media:${p.media[c.mediaId]?.name}`,
  c.audio.channelSelection ? JSON.stringify(c.audio.channelSelection) : '',
])]));

const FULL: CollectOptions = { scope: 'sequences', includeSubtitles: true, includeProxies: true };

describe('Collect round trip of a 0.8.0 project (nesting, keyframes, channel selections, Whisper / OCR, stills, offline media)', () => {
  let first: { r: CollectResult; project: Project; text: string };

  it("'media used in sequences' with subtitles and proxies: every reference points into the collection", async () => {
    first = await collect(requestJson, path.join(tmp, 'Archive Drive'), FULL);
    const { r, project: c } = first;
    const folder = r.folder;
    expect(path.basename(folder)).toBe('Compatibility fixture (saved by ReCut 0.8.0)');

    expect(filesIn(folder)).toEqual([
      'Compatibility fixture (saved by ReCut 0.8.0).recut',
      'Media/Disc 1/title_t00.mkv',
      'Media/Disc 2/title_t00.mkv',
      'Media/John Williams – Main Title.flac',
      'Media/S01E02 – Rising Malevolence.mkv',
      'Media/The Empire Strikes Back (1980).mkv',
      'Media/Title card – Amélie.png',
      'Proxies/Disc 1/title_t00.mkv_540p_all.mp4',
      'Proxies/The Empire Strikes Back (1980).mkv_540p_all.mp4',
      'Proxies/The Empire Strikes Back (1980).mkv_ch1.ch-FC_v1.m4a',
      'Proxies/The Empire Strikes Back (1980).mkv_ch1.dm-c-3-s-3_v1.m4a',
      'Proxies/Title card – Amélie.png_still.png',
      'Subtitles/Episode V.en.srt',
      'Subtitles/The Empire Strikes Back (1980).en.srt',
    ]);
    // The offline file (used only inside the nested sequence) is reported and skipped; the media no sequence uses is
    // not copied.
    expect(r.missing.map((m) => m.path)).toEqual([offlinePath]);

    // Every reference: inside the folder and a byte-identical copy of its original, or one the options leave alone.
    const reqRefs = new Map(fileRefs(requested));
    const leftAlone = new Set([offlinePath, unusedPath]);
    for (const [where, p] of fileRefs(c)) {
      const orig = reqRefs.get(where);
      expect(orig, where).toBeDefined();
      if (leftAlone.has(orig!)) { expect(p, where).toBe(orig); continue; }
      expect(inside(folder, p), `${where}: ${p}`).toBe(true);
      expect(path.isAbsolute(p), where).toBe(true);
      expect(fs.readFileSync(p).equals(originals.get(orig!)!), `${where}: ${p} is not a copy of ${orig}`).toBe(true);
    }
    expect(fileRefs(c).map(([w]) => w).sort()).toEqual([...reqRefs.keys()].sort());
    expect(c.media[ids.offline].path).toBe(offlinePath);
    expect(c.media[ids.unused].path).toBe(unusedPath);
    // Media used only two levels down a nested sequence are collected (same-named files kept apart).
    expect(c.media[ids.disc1].path).toBe(path.join(folder, 'Media', 'Disc 1', 'title_t00.mkv'));
    expect(c.media[ids.disc2].path).toBe(path.join(folder, 'Media', 'Disc 2', 'title_t00.mkv'));
    expect(c.media[ids.disc1].proxy.path).toBe(path.join(folder, 'Proxies', 'Disc 1', 'title_t00.mkv_540p_all.mp4'));
    // Channel proxies are proxies: copied with "Include proxies", named after their media and their key.
    expect(c.media[ids.movie].channelProxies).toEqual({
      '1.ch-FC': { status: 'ready', progress: 1, path: path.join(folder, 'Proxies', 'The Empire Strikes Back (1980).mkv_ch1.ch-FC_v1.m4a') },
      '1.dm-c-3-s-3': { status: 'ready', progress: 1, path: path.join(folder, 'Proxies', 'The Empire Strikes Back (1980).mkv_ch1.dm-c-3-s-3_v1.m4a') },
      '2.ch-FL': { status: 'failed', error: 'Canceled' },
    });
    // The snapshot's own subtitle source was collected too.
    const snapEng = byName(c.sequences[ids.main].snapshots[0].data.subtitleTracks, 'eng');
    expect(snapEng.sourcePaths).toEqual([path.join(folder, 'Subtitles', 'The Empire Strikes Back (1980).en.srt'), path.join(folder, 'Subtitles', 'Episode V.en.srt')]);

    // No path outside the folder hides anywhere else in the file (only the two left alone on purpose).
    const outside = allStrings(JSON.parse(first.text)).filter((s) => s.includes(tmp) && !inside(folder, s));
    expect(outside.sort()).toEqual([offlinePath, unusedPath].sort());
  }, 60_000);

  it('nothing but the file paths changed: clips, nesting, keyframes, channel selections and subtitle tracks are intact', () => {
    const c = first.project;
    expect(maskPaths(c)).toBe(maskPaths(requested));
    // The file on disk is exactly what the app saves (open → save writes the same bytes).
    expect(first.text).toBe(serializeProject(c));
    // Keyframes, byte for byte (the fixture's title card and music dip, in the alt cut and the snapshot, and the nested clip).
    const kf = keyframeJson(c);
    expect(kf).toEqual(keyframeJson(requested));
    expect(Object.keys(kf).length).toBeGreaterThanOrEqual(5);
    // Nesting: depth 2 below the main sequence, the recap nested in two places, every nested clip resolves.
    expect(structure(c)).toEqual(structure(requested));
    expect(nestDepthBelow(c.sequences, ids.main)).toBe(2);
    const nestsOf = (id: string) => Object.values(c.sequences).filter((s) => clipsOf(s).some((x) => x.sequenceId === id)).map((s) => s.name).sort();
    expect(nestsOf(ids.recap)).toEqual(['Episode V – Alt cut', 'Episode V – Despecialized']);
    expect(nestsOf(ids.reel)).toEqual(['Episode V – Alt cut']);
    expect(nestsOf(ids.deleted)).toEqual(['Act II']);
    expect(nestsOf(ids.act2)).toEqual(['Episode V – Despecialized']);
    for (const s of Object.values(c.sequences)) for (const x of clipsOf(s)) {
      if (isNestedClip(x)) expect(c.sequences[x.sequenceId], x.name).toBeDefined();
      else expect(c.media[x.mediaId], x.name).toBeDefined();
    }
    // Channel selections: the extracted centre channel and the downmix.
    const sels = clipsOf(c.sequences[ids.main]).map((x) => x.audio.channelSelection).filter(Boolean);
    expect(sels).toEqual(expect.arrayContaining([{ mode: 'channel', channel: 'FC' }, { mode: 'downmix', centreDb: -3, surroundDb: -3 }]));
    // Whisper and OCR tracks are project data (no file): carried as they were, cues and stream included.
    const whisper = c.subtitleTracks['sub-whisper-1'];
    expect(whisper).toEqual(requested.subtitleTracks['sub-whisper-1']);
    expect(whisper.path).toBeUndefined();
    const ocr = Object.values(c.subtitleTracks).find((t) => t.origin === 'ocr')!;
    expect(ocr).toEqual(Object.values(requested.subtitleTracks).find((t) => t.origin === 'ocr'));
    expect(ocr.path).toBeUndefined();
    expect(c.media[ids.movie].subtitleTrackIds).toEqual(requested.media[ids.movie].subtitleTrackIds);
    // Export settings are not part of the project (they live in the export dialog / preferences): nothing to rewrite.
    expect(allStrings(JSON.parse(first.text)).some((s) => s.includes('outputDir'))).toBe(false);
  });

  it('collecting the collected project again gives the same project and the same layout', async () => {
    const again = await collect(first.text, path.join(tmp, 'Second Drive'), FULL);
    expect(filesIn(again.r.folder)).toEqual(filesIn(first.r.folder));
    expect(maskPaths(again.project)).toBe(maskPaths(first.project));
    const rel = (folder: string, refs: [string, string][]) => refs.map(([w, p]) => [w, inside(folder, p) ? path.relative(folder, p) : p]);
    expect(rel(again.r.folder, fileRefs(again.project))).toEqual(rel(first.r.folder, fileRefs(first.project)));
  }, 60_000);

  it("'all media' without subtitles or proxies: unused media copied; proxies, channel proxies and subtitle files keep their paths", async () => {
    const { r, project: c } = await collect(requestJson, path.join(tmp, 'All Media'), { scope: 'all', includeSubtitles: false, includeProxies: false });
    expect(filesIn(r.folder)).toEqual([
      'Compatibility fixture (saved by ReCut 0.8.0).recut',
      'Media/Disc 1/title_t00.mkv',
      'Media/Disc 2/title_t00.mkv',
      'Media/John Williams – Main Title.flac',
      'Media/S01E02 – Rising Malevolence.mkv',
      'Media/The Empire Strikes Back (1980).mkv',
      'Media/Title card – Amélie.png',
      'Media/b-roll.mkv',
    ]);
    expect(maskPaths(c)).toBe(maskPaths(requested));
    for (const m of Object.values(c.media)) {
      const orig = requested.media[m.id];
      if (m.id === ids.offline) expect(m.path).toBe(offlinePath);
      else expect(inside(r.folder, m.path), m.name).toBe(true);
      // Not included: proxies (media and channel) still name their cache files, which this computer still has.
      expect(m.proxy).toEqual(orig.proxy);
      expect(m.channelProxies).toEqual(orig.channelProxies);
    }
    for (const [where, p] of fileRefs(c)) if (!where.startsWith('media ')) expect(new Map(fileRefs(requested)).get(where), where).toBe(p);
  }, 60_000);
});
