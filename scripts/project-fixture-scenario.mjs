/**
 * The project every compatibility fixture holds, built with ONE checkout's own code (see make-project-fixture.mjs,
 * which bundles this file against `--root`; `@recut/<path>` is `<root>/<path>`).
 *
 * Plain JavaScript on purpose: it must work against every release from 0.3.0 on, whose types differ. It only calls
 * store actions that exist in all of them, and uses a newer feature only where `features` (read from the checkout's
 * shared/model.ts) or the store says the version has it. When a release adds project data, add it here behind such a
 * check, so the new release's fixture covers it while older checkouts still build their own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { useStore, resetStore, serializeForSave } from '@recut/src/state/store';
import { createMediaItem, createSequence, serializeProject } from '@recut/shared/project';
import { projectJsonChunks } from '@recut/shared/projectJson';
import { uid } from '@recut/shared/ids';
import { saveProjectJson, loadProjectFile } from '@recut/electron/project/io';

/** 1 October 2026, 12:00 UTC: every timestamp in the fixture. */
const FIXED_NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

/** Deterministic Math.random (mulberry32), so ids are the same on every run. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NTSC_FILM = { num: 24000, den: 1001 };
const PAL = { num: 25, den: 1 };

function must(v, what) {
  if (v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0)) throw new Error(`fixture scenario: ${what} failed`);
  return v;
}

function frameOf(seconds, fps) { return Math.round(seconds * fps.num / fps.den); }

/**
 * Build the scenario in the store of the bundled checkout and write it to `outPath` with that checkout's save code.
 * Returns a short summary (counts) for the log.
 */
export async function makeFixture({ outPath, version, features }) {
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => FIXED_NOW;
  Math.random = seededRandom(0x5eed0001);
  try {
    return await build(outPath, version, features);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
}

async function build(outPath, version, features) {
  resetStore();
  const S = () => useStore.getState();
  S().newProject(`Compatibility fixture (saved by ReCut ${version})`);

  // ---------------------------------------------------------------- media
  const movie = createMediaItem('D:\\Films\\Star Wars\\The Empire Strikes Back (1980).mkv', 'The Empire Strikes Back (1980).mkv');
  const episode = createMediaItem('/home/fan/TV/The Clone Wars/S01E02 – Rising Malevolence.mkv', 'S01E02 – Rising Malevolence.mkv');
  const music = createMediaItem('D:\\Music\\John Williams – Main Title.flac', 'John Williams – Main Title.flac');
  const still = createMediaItem('/home/fan/Graphics/Title card – Amélie.png', 'Title card – Amélie.png');
  const deleted = createMediaItem('E:\\Rips\\Deleted Scenes\\Biggs at Anchorhead.mkv', 'Biggs at Anchorhead.mkv');
  S().addMedia([movie, episode, music, still, deleted]);

  S().setMediaProbe(movie.id, {
    container: 'matroska,webm', duration: 7620.12, size: 32_212_254_720, startTime: 0, bitrate: 33_800_000,
    browserPlayable: false, playabilityReason: 'audio codec ac3 not supported by Chromium',
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: NTSC_FILM, avgFps: NTSC_FILM, pixFmt: 'yuv420p', isVfr: false, colorSpace: 'bt709', sar: { num: 1, den: 1 } },
    audio: [
      { index: 1, codec: 'ac3', channels: 6, layout: '5.1(side)', sampleRate: 48000, language: 'eng', title: 'Surround 5.1' },
      { index: 2, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, language: 'eng', title: 'Commentary' },
    ],
    subtitles: [
      { index: 3, codec: 'subrip', language: 'eng', title: 'English' },
      { index: 4, codec: 'hdmv_pgs_subtitle', language: 'fre', title: 'Français' },
    ],
  });
  S().setMediaProbe(episode.id, {
    container: 'matroska,webm', duration: 1320.5, size: 1_288_490_188, startTime: 0.021, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 720, height: 576, fps: PAL, avgFps: PAL, pixFmt: 'yuv420p', isVfr: false, sar: { num: 64, den: 45 } },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, language: 'eng' }],
    subtitles: [],
  });
  S().setMediaProbe(music.id, {
    container: 'flac', duration: 331.4, size: 41_943_040, startTime: 0, browserPlayable: true,
    audio: [{ index: 0, codec: 'flac', channels: 2, layout: 'stereo', sampleRate: 96000 }],
    subtitles: [],
  });
  S().setMediaProbe(still.id, {
    container: 'png_pipe', duration: 0.04, size: 2_097_152, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'png', width: 1920, height: 1080, fps: PAL, avgFps: PAL, pixFmt: 'rgba', isVfr: false },
    audio: [], subtitles: [],
  });
  S().setMediaProbe(deleted.id, {
    container: 'matroska,webm', duration: 95.7, size: 734_003_200, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: NTSC_FILM, avgFps: NTSC_FILM, isVfr: true },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  });
  S().setOffline(deleted.id, true);

  S().updateMedia(movie.id, {
    category: 'Movie', fileSize: 32_212_254_720, fileMtime: 1_700_000_000_000, notes: 'Despecialized 2.7 master', tags: ['source:bluray'],
    color: '#e5484d', preferredAudioStream: 1, thumbnailTime: 312.5,
    identity: { franchise: 'Star Wars', collection: 'Original Trilogy', title: 'The Empire Strikes Back', year: 1980 },
  });
  S().updateMedia(episode.id, { category: 'Episode', fileSize: 1_288_490_188, fileMtime: 1_650_000_000_000 });
  S().updateMedia(music.id, { category: 'Music', identity: { title: 'Main Title' } });
  S().updateMedia(deleted.id, { category: 'Deleted Scene' });

  // 0.4.0 made proxies carry every audio stream (`*_all.mp4`) and record them in `audioStreams`.
  const proxy = features.proxyAudioStreams
    ? { status: 'ready', path: '/home/fan/.cache/recut/proxies/esb_540p_all.mp4', width: 960, height: 540, audioStreams: [1, 2] }
    : { status: 'ready', path: '/home/fan/.cache/recut/proxies/esb_540p.mp4', width: 960, height: 540 };
  S().setProxy(movie.id, proxy);
  S().setProxy(episode.id, { status: 'failed', error: 'ffmpeg exited with code 1' });

  S().setSceneDetectStatus(movie.id, 'done');
  S().setDetectedScenes(movie.id, [83.2, 190.04, 312.5, 455.75], 7620.12);
  const detected = S().project.media[movie.id].detectedScenes;
  must(detected.length === 5, 'detected scenes');
  S().renameDetectedScene(movie.id, detected[1].id, 'Hoth – Echo Base');
  S().tagDetectedScene(movie.id, detected[1].id, { tags: ['snow'], characters: ['Han', 'Leia'] });

  // ---------------------------------------------------------------- media subtitle tracks
  S().addMediaSubtitleTrack({
    id: uid('st'), name: 'The Empire Strikes Back (1980).en.srt', language: 'eng', origin: 'srt', mediaId: movie.id,
    path: 'D:\\Films\\Star Wars\\The Empire Strikes Back (1980).en.srt',
    cues: [
      { id: uid('cue'), start: 1.5, end: 3.25, text: 'A long time ago…' },
      { id: uid('cue'), start: 4, end: 6.5, text: 'Echo Three to Echo Seven.\nHan, old buddy, do you read me?' },
      { id: uid('cue'), start: 121, end: 124.75, text: '<i>Do. Or do not.</i>' },
      { id: uid('cue'), start: 126, end: 128, text: 'There is no try.' },
    ],
  });
  S().addMediaSubtitleTrack({
    id: uid('st'), name: 'Notes', language: 'und', origin: 'manual', mediaId: episode.id,
    cues: [{ id: uid('cue'), start: 31, end: 33.5, text: 'Malevolence fires' }],
  });
  if (features.subtitleStreamIndex && typeof S().putOcrSubtitleTrack === 'function') {
    S().putOcrSubtitleTrack({
      id: uid('st'), name: 'Français (OCR)', language: 'fre', origin: 'ocr', mediaId: movie.id, streamIndex: 4,
      cues: [
        { id: uid('cue'), start: 2, end: 4, text: 'Il y a bien longtemps…' },
        { id: uid('cue'), start: 122, end: 125, text: 'Fais-le, ou ne le fais pas.' },
      ],
    });
  }

  // ---------------------------------------------------------------- bins and tags
  const sagaBin = S().addBin('Star Wars', 'bin-movies', 'collection');
  S().moveToBin([movie.id, deleted.id], sagaBin);
  S().moveToBin([music.id], 'bin-audio');
  S().moveToBin([still.id], 'bin-graphics');
  S().organizeAsSeries([{ id: episode.id, episode: 2, title: 'Rising Malevolence' }], 'The Clone Wars', 1);
  S().addTag('themes', 'Redemption');
  S().addTag('custom', 'fan favourite');

  S().setSettings({
    proxyHeight: 720, autosaveIntervalSec: 120, sceneThreshold: 0.42, playbackResolution: '1/2', snapping: false,
    defaultTransitionFrames: 12, showSourceTimecodeOnClips: true,
  });

  // ---------------------------------------------------------------- main sequence (23.976, stereo)
  const mainId = S().project.activeSequenceId;
  S().renameSequence(mainId, 'Episode V – Despecialized');
  const seq = () => S().project.sequences[mainId];
  const fps = seq().fps;
  const v1 = seq().videoTracks[0].id, v2 = seq().videoTracks[1].id, a1 = seq().audioTracks[0].id, a2 = seq().audioTracks[1].id;

  // Three linked picture + sound pairs, cut end to end (subtitles carried from the movie's tracks).
  const c1 = must(S().insertFromSource(mainId, { mediaId: movie.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' }), 'insert 1');
  const cut1 = frameOf(10, fps);
  const c2 = must(S().insertFromSource(mainId, { mediaId: movie.id, in: 120, out: 135, atFrame: cut1, mode: 'overwrite' }), 'insert 2');
  const cut2 = cut1 + frameOf(15, fps);
  const c3 = must(S().insertFromSource(mainId, { mediaId: episode.id, in: 30, out: 40, atFrame: cut2, mode: 'overwrite' }), 'insert 3');
  // Music on A2 only; the title card on V2 only.
  const cm = must(S().insertFromSource(mainId, { mediaId: music.id, in: 0, out: 20, atFrame: 0, mode: 'overwrite', audioTrackId: a2, includeVideo: false }), 'insert music');
  const ct = must(S().insertFromSource(mainId, { mediaId: still.id, in: 0, out: 4, atFrame: 48, mode: 'overwrite', videoTrackId: v2, includeAudio: false }), 'insert still');

  must(S().addTransitionAtCut(mainId, v1, cut1, 'crossDissolve', 12), 'cross dissolve');
  must(S().addTransitionAtCut(mainId, a1, cut1, 'audioCrossfade', 12), 'audio crossfade');
  const end3 = cut2 + frameOf(10, fps);
  must(S().addTransitionAtCut(mainId, v1, end3, 'dipToBlack', 24), 'dip to black');

  S().setClipTransform(mainId, ct[0], { x: 40, y: -20, scale: 0.8, rotation: 2.5, opacity: 0.9, crop: { left: 0.05, top: 0, right: 0.05, bottom: 0.1 } });
  S().setClipAudio(mainId, c1[1], { gain: -3, volume: 0.8, fadeIn: 12 });
  S().setClipAudio(mainId, cm[0], { fadeOut: 24, volume: 0.5 });
  S().setClipTags(mainId, c2[0], { characters: ['Luke', 'Yoda'], plotlines: ['Jedi Training'], locations: ['Dagobah'], tags: ['keep'], notes: 'The heart of the film', color: '#30a46c', name: 'Luke meets Yoda' });
  S().setClipEnabled(mainId, c3[1], false);

  S().addMarker(mainId, { time: 0, kind: 'chapter', name: 'Chapter 1 – Hoth', color: '#ffb224' });
  S().addMarker(mainId, { time: cut1, kind: 'chapter', name: 'Chapter 2 – Dagobah', color: '#ffb224' });
  S().addMarker(mainId, { time: 24, duration: 48, name: 'Check the title timing', note: 'Fade it in?', color: '#4d7cfe' });
  const cont1 = must(S().addContinuityNote(mainId, { time: cut1 + 30, name: "Luke's jacket", note: 'Changes between shots', category: 'wardrobe', clipId: c2[0] }), 'continuity 1');
  must(S().addContinuityNote(mainId, { time: cut2 + 5, name: 'Music cuts off', note: '', category: 'music', duration: 24 }), 'continuity 2');
  S().resolveContinuity(mainId, cont1, true);

  must(S().addStoryBlock(mainId, { start: 0, end: cut1, name: 'Act I – Hoth', color: '#5b8def', notes: 'Cold open' }), 'story block 1');
  must(S().addStoryBlock(mainId, { start: cut1, end: end3, name: 'Act II – Training', color: '#46a758', notes: '' }), 'story block 2');

  const sst = must(S().addSequenceSubtitleTrack(mainId, { name: 'Forced', language: 'eng' }), 'subtitle track');
  must(S().addManualCue(mainId, sst, { start: 60, duration: 48, text: 'Somewhere on Hoth' }), 'manual cue 1');
  must(S().addManualCue(mainId, sst, { start: cut1 + 10, duration: 36, text: 'Dagobah system\n(forced)' }), 'manual cue 2');
  const carried = seq().subtitleTracks.flatMap((t) => t.cues).find((c) => c.clipId);
  must(carried, 'carried subtitle cue');
  S().updateCue(mainId, carried.id, { offset: 3 });

  S().setTrackFlags(mainId, a2, { volume: 0.7, name: 'Music' });
  S().setTrackFlags(mainId, v2, { locked: true });
  S().setView(mainId, { playhead: 120, zoom: 2, scroll: 16, inPoint: 24, outPoint: cut2 });

  must(S().takeSnapshot(mainId, 'Before act 2 trim'), 'snapshot');
  S().trimClipEdge(mainId, c3[0], 'end', end3 - 12, false);

  // ---------------------------------------------------------------- alternate cut (lineage) and a PAL 5.1 sequence
  const altId = must(S().duplicateSequence(mainId, 'Episode V – Alt cut'), 'duplicate');
  S().updateSequenceSettings(altId, { versionLabel: 'v2' });
  S().removeDisabledClips(altId);

  const pal = createSequence('Clone Wars recap', { ...PAL }, 1280, 720);
  pal.channels = 6;
  S().addSequence(pal, { activate: false });
  must(S().insertFromSource(pal.id, { mediaId: episode.id, in: 100, out: 112.5, atFrame: 0, mode: 'insert' }), 'insert pal');
  S().addMarker(pal.id, { time: 25, kind: 'chapter', name: 'Recap' });

  // ---------------------------------------------------------------- scene library
  must(S().sceneFromClip(mainId, c2[0], 'Luke meets Yoda'), 'scene from clip');
  S().addScene({
    id: uid('scn'), name: 'Biggs farewell', mediaId: deleted.id, in: 12.5, out: 58.25, characters: ['Luke', 'Biggs'],
    location: 'Anchorhead', arc: 'Friends', tags: ['deleted'], notes: 'Restore in the extended cut', rating: 4, color: '#8e4ec6', createdAt: Date.now(),
  });

  // ---------------------------------------------------------------- nested sequences (Roadmap §8, from 0.12.0)
  // The alt cut's first two picture + sound pairs become a compound clip ("Reel 1", a new sequence), and the PAL recap
  // is nested after them: a nested clip of another frame rate.
  if (typeof S().makeCompoundClip === 'function' && typeof S().nestSequence === 'function') {
    const alt = () => S().project.sequences[altId];
    const firstTwo = [...alt().videoTracks[0].clips].sort((a, b) => a.start - b.start).slice(0, 2).map((c) => c.id);
    must(firstTwo.length === 2, 'alt cut clips');
    const reel = must(S().makeCompoundClip(altId, firstTwo, 'Reel 1'), 'make compound clip');
    must(S().project.sequences[reel], 'compound clip sequence');
    const altEnd = Math.max(...[...alt().videoTracks, ...alt().audioTracks].flatMap((t) => t.clips).map((c) => c.start + c.duration));
    must(S().nestSequence(altId, pal.id, altEnd), 'nest the PAL recap');
  }

  S().setSettings({ carrySubtitles: false, useProxies: false });
  S().setActiveSequence(mainId);

  // ---------------------------------------------------------------- save with this version's own code
  const project = serializeForSave(S());
  const pieces = [];
  const it = projectJsonChunks(project, pieces);
  while (!it.next().done) { /* serializeInPieces in src/state/mediaActions.ts, without the pauses */ }
  const text = pieces.join('');
  if (text !== serializeProject(project)) throw new Error('projectJsonChunks and serializeProject disagree');

  const tmpTarget = path.join(path.dirname(outPath), `.${path.basename(outPath)}.making`);
  const saved = await saveProjectJson(tmpTarget, text);
  if (!saved.ok) throw new Error(saved.error);
  try {
    const loaded = await loadProjectFile(saved.path);
    if (!loaded.ok) throw new Error(`the version that wrote the fixture cannot open it: ${loaded.error}`);
    if (loaded.repaired?.length) throw new Error(`the version that wrote the fixture repaired it on open: ${loaded.repaired.join('; ')}`);
    fs.copyFileSync(saved.path, outPath);
  } finally {
    for (const f of fs.readdirSync(path.dirname(saved.path))) {
      if (f.startsWith(path.basename(saved.path))) fs.rmSync(path.join(path.dirname(saved.path), f), { force: true });
    }
  }

  const seqs = Object.values(project.sequences);
  return {
    media: Object.keys(project.media).length,
    sequences: seqs.length,
    clips: seqs.reduce((n, s) => n + [...s.videoTracks, ...s.audioTracks].reduce((k, t) => k + t.clips.length, 0), 0),
    transitions: seqs.reduce((n, s) => n + [...s.videoTracks, ...s.audioTracks].reduce((k, t) => k + t.transitions.length, 0), 0),
    markers: seqs.reduce((n, s) => n + s.markers.length, 0),
    subtitleTracks: Object.keys(project.subtitleTracks).length,
    scenes: Object.keys(project.scenes).length,
    bytes: Buffer.byteLength(text),
  };
}
