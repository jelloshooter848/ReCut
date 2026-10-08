/**
 * The tester kit's projects, built with ReCut's own code (bundled by esbuild from scripts/tester-kit.mjs, as
 * scripts/make-project-fixture.mjs bundles its scenario): media are imported through the renderer's real import path
 * (src/state/mediaActions.ts importMedia, with FFprobe and the file system of electron/ behind a stand-in for the
 * preload bridge), the cut is made with the store actions the UI calls, and the file is written with the app's save
 * path (serializeForSave + projectJsonChunks + electron/project/io.ts saveProjectJson). Each project is then opened with
 * loadProjectFile and must open without repairs, and Relink's folder scan (electron/fs.ts scanForRelink) must find
 * every media file in the kit by name and size, which is what a tester does after unzipping the kit anywhere.
 *
 * Time and randomness are fixed, so the same inputs give the same project files (apart from the media paths).
 */
import fs from 'node:fs';
import path from 'node:path';
import { useStore, resetStore, serializeForSave, importMedia, importSubtitleFile, fileNameOf } from '../../src/state';
import { serializeProject } from '../../shared/project';
import { projectJsonChunks } from '../../shared/projectJson';
import { findClip } from '../../shared/timeline';
import { writeClipProperty } from '../../shared/keyframes';
import { saveProjectJson, loadProjectFile } from '../../electron/project/io';
import { probeMedia } from '../../electron/media/probe';
import { listDir, readText, stat, scanForRelink } from '../../electron/fs';
import type { ID, Project } from '../../shared/model';

/** 1 October 2026, 12:00 UTC, as the compatibility fixtures use. */
const FIXED_NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function must<T>(v: T, what: string): NonNullable<T> {
  if (v === null || v === undefined || (v as unknown) === false || (Array.isArray(v) && v.length === 0)) throw new Error(`tester-kit project: ${what} failed`);
  return v as NonNullable<T>;
}

export interface FilmPlan {
  key: 'tos' | 'sintel' | 'bbb' | 'ed';
  title: string;
  year: number;
  file: string;
  /** Sidecar subtitle files next to the film (attached by the import, as in the app). */
  subtitles: string[];
  characters: string[];
  location: string;
  /** Picture shots (seconds) for the trailer, in film order. */
  shots: [number, number][];
  /** Dialogue lines (seconds) worth hearing in the trailer. */
  lines: [number, number][];
}

export interface ProjectsPlan {
  kitRoot: string;
  trailerPath: string;
  startHerePath: string;
  titleCard: string;
  franchise: string;
  films: FilmPlan[];
}

export interface ProjectsSummary { trailer: Record<string, number>; startHere: Record<string, number>; relink: { file: string; media: number }[] }

/** The preload bridge, as far as the import path uses it (window.recut in the app). */
function installBridge(): () => void {
  const g = globalThis as unknown as { window?: unknown };
  const before = g.window;
  g.window = {
    recut: {
      probe: (p: string) => probeMedia(p),
      stat: (p: string) => stat(p),
      listDir: (p: string) => listDir(p),
      readText: (p: string) => readText(p),
    },
  };
  return () => { g.window = before; };
}

export async function makeProjects(plan: ProjectsPlan): Promise<ProjectsSummary> {
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => FIXED_NOW;
  Math.random = seededRandom(0x7e57c17);
  const restoreBridge = installBridge();
  try {
    const trailer = await buildTrailer(plan);
    const startHere = await buildStartHere(plan);
    const relink = [];
    for (const file of [plan.trailerPath, plan.startHerePath]) relink.push({ file, media: await checkRelink(file, plan.kitRoot) });
    return { trailer, startHere, relink };
  } finally {
    restoreBridge();
    Date.now = realNow;
    Math.random = realRandom;
  }
}

const S = () => useStore.getState();

async function buildTrailer(plan: ProjectsPlan): Promise<Record<string, number>> {
  resetStore();
  S().newProject('Open Movie Trailer');
  // Previews of these files need no proxy (H.264 / AAC, PNG); keep proxies off while importing so nothing is queued
  // (there is no job queue here), then back to the default for the tester.
  S().setSettings({ useProxies: false });

  const filmIds = new Map<FilmPlan['key'], ID>();
  for (const f of plan.films) {
    const report = await importMedia([f.file, ...f.subtitles]);
    const id = must(report.added[0], `import ${f.title}`);
    const m = S().project.media[id];
    if (!m.probe || 'error' in (m.probe as object)) throw new Error(`probe of ${f.file} failed`);
    if (report.sidecarsUsed.length !== f.subtitles.length) {
      throw new Error(`${f.title}: ${report.sidecarsUsed.length} of ${f.subtitles.length} sidecar subtitle files attached`);
    }
    S().updateMedia(id, { category: 'Movie', identity: { ...m.identity, title: f.title, year: f.year, franchise: plan.franchise, collection: 'Blender Open Movies' } });
    filmIds.set(f.key, id);
  }
  const titleReport = await importMedia([plan.titleCard]);
  const titleId = must(titleReport.added[0], 'import the title card');

  const seqId = S().project.activeSequenceId as ID;
  S().renameSequence(seqId, 'Trailer');
  S().updateSequenceSettings(seqId, { fps: { num: 24, den: 1 }, width: 1280, height: 720 });
  const seq = () => S().project.sequences[seqId];
  const fps = 24;
  const fr = (sec: number) => Math.round(sec * fps);
  const v1 = seq().videoTracks[0].id, v2 = seq().videoTracks[1].id, a2 = seq().audioTracks[1].id;
  const end = () => Math.max(0, ...[...seq().videoTracks, ...seq().audioTracks].flatMap((t) => t.clips.map((c) => c.start + c.duration)));

  const film = (k: FilmPlan['key']) => plan.films.find((f) => f.key === k)!;
  type Piece = { k: FilmPlan['key']; r: [number, number]; dialogue?: boolean };
  const shot = (k: FilmPlan['key'], i: number): Piece | null => { const s = film(k).shots[i]; return s ? { k, r: s } : null; };
  const line = (k: FilmPlan['key'], i: number): Piece | null => { const s = film(k).lines[i]; return s ? { k, r: s, dialogue: true } : null; };

  // Act I: the worlds. Act II: the quest (nested into a compound clip below). Act III: the reckoning.
  const acts: { name: string; pieces: (Piece | null)[] }[] = [
    { name: 'Act I · Four worlds', pieces: [shot('ed', 0), shot('bbb', 0), shot('sintel', 0), shot('tos', 0), line('tos', 0), shot('ed', 1), shot('bbb', 1)] },
    { name: 'Act II · The quest', pieces: [line('sintel', 0), shot('sintel', 1), shot('ed', 2), line('tos', 1), shot('tos', 1), shot('sintel', 2)] },
    { name: 'Act III · The reckoning', pieces: [shot('tos', 2), shot('bbb', 2), line('sintel', 1), shot('ed', 3), shot('tos', 3), shot('bbb', 3), line('tos', 2), shot('sintel', 3)] },
  ];
  const placed: { act: number; at: number; ids: ID[]; video: ID; piece: Piece }[] = [];
  const actStart: number[] = [];
  for (let a = 0; a < acts.length; a++) {
    actStart.push(end());
    for (const p of acts[a].pieces) {
      if (!p) continue;
      const f = film(p.k);
      const at = end();
      const ids = must(S().insertFromSource(seqId, { mediaId: filmIds.get(p.k)!, in: p.r[0], out: p.r[1], atFrame: at, mode: 'overwrite', videoTrackId: v1 }), `insert ${f.title} ${p.r.join('-')}`);
      const video = must(ids.find((id) => seq().videoTracks.some((t) => t.clips.some((c) => c.id === id))), 'video clip');
      for (const id of ids) {
        S().setClipTags(seqId, id, { characters: f.characters, locations: [f.location], plotlines: [f.title], ...(p.dialogue ? { tags: ['dialogue'] } : {}) });
      }
      // Picture-only shots play quietly under the music; dialogue lines at full level.
      const audio = ids.find((id) => id !== video);
      if (audio && !p.dialogue) S().setClipAudio(seqId, audio, { volume: 0.35 });
      placed.push({ act: a, at, ids, video, piece: p });
    }
  }
  const total = end();
  if (total < fr(45)) throw new Error(`the trailer is only ${(total / fps).toFixed(1)} s long (too few shots)`);

  // Dissolves on every third cut, a dip to black between the acts (both picture and sound where there are handles).
  let dissolves = 0;
  for (let i = 1; i < placed.length; i++) {
    const cut = placed[i].at;
    const actCut = placed[i].act !== placed[i - 1].act;
    if (!actCut && i % 3 !== 0) continue;
    if (S().addTransitionAtCut(seqId, v1, cut, actCut ? 'dipToBlack' : 'crossDissolve', actCut ? 16 : 12)) dissolves++;
  }
  if (dissolves < 3) throw new Error(`only ${dissolves} transitions could be added`);

  // Title card on V2 over the opening shot: fades in (opacity keyframes), grows slowly (scale keyframes, ease).
  const title = must(S().insertFromSource(seqId, { mediaId: titleId, in: 0, out: 5, atFrame: fr(0.5), mode: 'overwrite', videoTrackId: v2, includeAudio: false }), 'insert the title card');
  S().addClipKeyframe(seqId, title, 'opacity', fr(0.5));
  S().addClipKeyframe(seqId, title, 'scale', fr(0.5));
  S().quiet((d) => {
    const c = findClip(d.sequences[seqId], title[0])!.clip;
    writeClipProperty(c, 'opacity', fr(0.5), 0);
    writeClipProperty(c, 'opacity', fr(1.5), 1);
    writeClipProperty(c, 'opacity', fr(4.5), 1);
    writeClipProperty(c, 'opacity', fr(5.5) - 1, 0);
    writeClipProperty(c, 'scale', fr(0.5), 0.9);
    writeClipProperty(c, 'scale', fr(5.5) - 1, 1.05);
  });
  S().setClipKeyframeInterp(seqId, title, 'scale', fr(0.5), 'ease');

  // A Ken Burns move (scale + position keyframes) on two picture shots.
  const kenBurns = placed.filter((p) => !p.piece.dialogue).slice(1, 3);
  for (const p of kenBurns) {
    const c0 = findClip(seq(), p.video)!.clip;
    const a = c0.start, b = c0.start + c0.duration - 1;
    S().addClipKeyframe(seqId, [p.video], 'scale', a);
    S().addClipKeyframe(seqId, [p.video], 'position', a);
    S().quiet((d) => {
      const c = findClip(d.sequences[seqId], p.video)!.clip;
      writeClipProperty(c, 'scale', a, 1);
      writeClipProperty(c, 'scale', b, 1.2);
      writeClipProperty(c, 'x', b, -60);
      writeClipProperty(c, 'y', b, 20);
    });
    S().setClipKeyframeInterp(seqId, [p.video], 'scale', a, 'ease');
  }

  // Music bed on A2: Big Buck Bunny's score under the whole trailer, ducked (level keyframes) under each dialogue line.
  const bbb = film('bbb');
  const bbbDur = S().project.media[filmIds.get('bbb')!].probe?.duration ?? 0;
  const bedIn = Math.min(Math.max(0, bbbDur - total / fps - 30), bbbDur * 0.55);
  const bed = must(S().insertFromSource(seqId, { mediaId: filmIds.get('bbb')!, in: bedIn, out: bedIn + total / fps, atFrame: 0, mode: 'overwrite', audioTrackId: a2, includeVideo: false }), `music bed from ${bbb.title}`);
  S().setClipAudio(seqId, bed[0], { volume: 0.6, fadeIn: 24, fadeOut: 48 });
  S().setTrackFlags(seqId, a2, { name: 'Music' });
  S().setTrackFlags(seqId, seq().audioTracks[0].id, { name: 'Dialogue' });
  S().addClipKeyframe(seqId, bed, 'volume', 0);
  S().quiet((d) => {
    const c = findClip(d.sequences[seqId], bed[0])!.clip;
    for (const p of placed.filter((x) => x.piece.dialogue)) {
      const len = findClip(d.sequences[seqId], p.video)!.clip.duration;
      writeClipProperty(c, 'volume', Math.max(1, p.at - 12), 0.6);
      writeClipProperty(c, 'volume', p.at, 0.15);
      writeClipProperty(c, 'volume', p.at + len - 1, 0.15);
      writeClipProperty(c, 'volume', p.at + len + 11, 0.6);
    }
  });

  // Markers: a chapter per act, plus two review notes.
  for (let a = 0; a < acts.length; a++) must(S().addMarker(seqId, { time: actStart[a], kind: 'chapter', name: acts[a].name, color: '#ffb224' }), 'chapter marker');
  must(S().addMarker(seqId, { time: fr(2), duration: fr(3), name: 'Title timing', note: 'Does the title fade in too slowly?', color: '#4d7cfe' }), 'marker');
  must(S().addMarker(seqId, { time: actStart[2] + fr(1), name: 'Music hit', note: 'Cut the next shot on the drum hit.', color: '#e5484d' }), 'marker');
  for (let a = 0; a < acts.length; a++) must(S().addStoryBlock(seqId, { start: actStart[a], end: a + 1 < acts.length ? actStart[a + 1] : total, name: acts[a].name }), 'story block');

  // A subtitle track of trailer captions (our own words), next to the film lines carried in with the clips.
  const captions = must(S().addSequenceSubtitleTrack(seqId, { name: 'Trailer captions', language: 'eng' }), 'subtitle track');
  const capText = ['Four worlds.', 'One quest.', 'No way back.', 'Four open movies. One fan edit.'];
  const capAt = [actStart[0] + fr(6), actStart[1] + fr(1), actStart[2] + fr(1), total - fr(4)];
  for (let i = 0; i < capText.length; i++) must(S().addManualCue(seqId, captions, { start: capAt[i], duration: fr(2.5), text: capText[i] }), 'caption');

  // Act II becomes a nested sequence (Make Compound Clip): the clips of the act, with their sound.
  const act2 = placed.filter((p) => p.act === 1).map((p) => p.video);
  const nested = must(S().makeCompoundClip(seqId, act2, 'Act II · The quest'), 'make compound clip');
  // A slow push-in on the whole nested act (keyframes on the nested clip).
  const nestedClip = must(seq().videoTracks[0].clips.find((c) => c.sequenceId === nested), 'nested clip');
  S().addClipKeyframe(seqId, [nestedClip.id], 'scale', nestedClip.start);
  S().quiet((d) => {
    const c = findClip(d.sequences[seqId], nestedClip.id)!.clip;
    writeClipProperty(c, 'scale', nestedClip.start, 1);
    writeClipProperty(c, 'scale', nestedClip.start + nestedClip.duration - 1, 1.08);
  });

  // Three scenes for the Scenes panel.
  for (const p of [placed[3], placed[8], placed[placed.length - 2]].filter(Boolean)) {
    const f = film(p.piece.k);
    S().addScene({
      id: `scn-${p.piece.k}-${Math.round(p.piece.r[0] * 10)}`, name: `${f.title}: ${p.piece.dialogue ? 'a line' : 'a shot'}`,
      mediaId: filmIds.get(p.piece.k)!, in: p.piece.r[0], out: p.piece.r[1], characters: f.characters, location: f.location,
      arc: f.title, tags: p.piece.dialogue ? ['dialogue'] : ['shot'], notes: '', rating: 3, color: '#5b8def', createdAt: Date.now(),
    });
  }

  // The alternate cut for Compare: a copy without the Big Buck Bunny shots, gaps closed.
  const altId = must(S().duplicateSequence(seqId, 'Trailer (no bunny)'), 'duplicate sequence');
  S().updateSequenceSettings(altId, { versionLabel: 'v2' });
  const alt = () => S().project.sequences[altId];
  const bunny = alt().videoTracks[0].clips.filter((c) => c.mediaId === filmIds.get('bbb'));
  for (const c of bunny) S().setClipEnabled(altId, c.id, false);
  for (const t of alt().audioTracks) for (const c of t.clips) if (c.mediaId === filmIds.get('bbb') && t.id !== alt().audioTracks[1].id) S().setClipEnabled(altId, c.id, false);
  must(S().removeDisabledClips(altId) > 0, 'remove the bunny shots from the alternate cut');

  S().setView(seqId, { playhead: 0 });
  S().setSettings({ useProxies: true });
  S().setActiveSequence(seqId);
  S().renameProject('Open Movie Trailer');
  return save(plan.trailerPath);
}

async function buildStartHere(plan: ProjectsPlan): Promise<Record<string, number>> {
  resetStore();
  S().newProject('Start here');
  S().renameSequence(S().project.activeSequenceId as ID, 'My fan edit');
  return save(plan.startHerePath);
}

/** Save with the app's own path, then open with loadProjectFile: it must open as written, with no repairs. */
async function save(outPath: string): Promise<Record<string, number>> {
  const project = serializeForSave(S());
  const pieces: string[] = [];
  const it = projectJsonChunks(project, pieces);
  while (!it.next().done) { /* serializeInPieces in src/state/mediaActions.ts, without the pauses */ }
  const text = pieces.join('');
  if (text !== serializeProject(project)) throw new Error('projectJsonChunks and serializeProject disagree');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const saved = await saveProjectJson(outPath, text);
  if (!saved.ok) throw new Error(saved.error);
  // No .bak next to a fresh project in the kit.
  fs.rmSync(`${saved.path}.bak`, { force: true });
  const loaded = await loadProjectFile(saved.path);
  if (!loaded.ok) throw new Error(`ReCut cannot open ${outPath}: ${loaded.error}`);
  if (loaded.repaired?.length) throw new Error(`ReCut repaired ${outPath} on open: ${loaded.repaired.join('; ')}`);
  if (loaded.fromBackup) throw new Error(`ReCut opened ${outPath} from its backup`);
  return summary(loaded.project, Buffer.byteLength(text));
}

/** What a tester does after unzipping: Relink › Search folder… on the kit folder. Every media file must match by name + size. */
async function checkRelink(projectPath: string, kitRoot: string): Promise<number> {
  const loaded = await loadProjectFile(projectPath);
  if (!loaded.ok) throw new Error(loaded.error);
  const media = Object.values(loaded.project.media);
  const missing = media.map((m) => ({ mediaId: m.id, fileName: fileNameOf(m.path), size: m.fileSize ?? m.probe?.size }));
  const found = await scanForRelink({ folder: kitRoot, missing });
  for (const m of missing) {
    const c = found.filter((x) => x.missingMediaId === m.mediaId);
    if (c.length !== 1) throw new Error(`Relink › Search folder… finds ${c.length} candidates for ${m.fileName} in the kit (want exactly 1)`);
    if (c[0].confidence !== 'name+size') throw new Error(`Relink matches ${m.fileName} by name only (the size differs)`);
  }
  return media.length;
}

function summary(project: Project, bytes: number): Record<string, number> {
  const seqs = Object.values(project.sequences);
  const clips = seqs.flatMap((s) => [...s.videoTracks, ...s.audioTracks].flatMap((t) => t.clips));
  return {
    media: Object.keys(project.media).length,
    sequences: seqs.length,
    nestedClips: clips.filter((c) => c.sequenceId).length,
    clips: clips.length,
    transitions: seqs.reduce((n, s) => n + [...s.videoTracks, ...s.audioTracks].reduce((k, t) => k + t.transitions.length, 0), 0),
    keyframedClips: clips.filter((c) => c.transform.keyframes || c.audio.keyframes).length,
    markers: seqs.reduce((n, s) => n + s.markers.length, 0),
    subtitleTracks: seqs.reduce((n, s) => n + s.subtitleTracks.length, 0),
    durationFrames: Math.max(0, ...clips.map((c) => c.start + c.duration)),
    bytes,
  };
}
