import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, resetStore, getUndoLabels, serializeForSave } from '../../src/state/store';
import { activeSequence, selectedClips, seriesTree, originalTimecode, continuityIssues, mediaDuration } from '../../src/state/selectors';
import { createMediaItem, createSequence } from '../../shared/project';
import { allTracks, clipEnd, findClip, resolveSubtitleCues } from '../../shared/timeline';
import type { MediaItem, MediaProbe, Sequence, SubtitleTrack } from '../../shared/model';

const FPS = { num: 24, den: 1 };

function fakeProbe(duration = 100): MediaProbe {
  return {
    container: 'matroska', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}

function fakeMedia(name = 'movie.mkv', duration = 100): MediaItem {
  const m = createMediaItem(`/media/${name}`, name);
  return { ...m, kind: 'video', probe: fakeProbe(duration) };
}

const S = () => useStore.getState();
const seq = (): Sequence => activeSequence(S())!;
const clips = () => allTracks(seq()).flatMap((t) => t.clips);

let media: MediaItem;
let seqId: string;

beforeEach(() => {
  resetStore();
  media = fakeMedia();
  S().addMedia([media]);
  const s = createSequence('Test 24', FPS);
  S().addSequence(s);
  seqId = s.id;
  S().clearHistory();
});

describe('insertFromSource', () => {
  it('creates linked video+audio clips on patched tracks and ripples on insert', () => {
    const ids1 = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    expect(ids1).toHaveLength(2);
    const ids2 = S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 0, mode: 'insert' });
    expect(ids2).toHaveLength(2);

    const s = seq();
    expect(s.videoTracks[0].clips).toHaveLength(2);
    expect(s.audioTracks[0].clips).toHaveLength(2);
    const v1 = findClip(s, ids1[0])!.clip; const a1 = findClip(s, ids1[1])!.clip;
    const v2 = findClip(s, ids2[0])!.clip; const a2 = findClip(s, ids2[1])!.clip;
    expect(v1.kind).toBe('video'); expect(a1.kind).toBe('audio');
    expect(v1.linkId).toBeTruthy(); expect(v1.linkId).toBe(a1.linkId);
    expect(v2.linkId).toBeTruthy(); expect(v2.linkId).not.toBe(v1.linkId);
    expect(v1.duration).toBe(240); expect(a1.duration).toBe(240);
    // the second insert at 0 pushed the first pair to frame 240
    expect(v2.start).toBe(0); expect(v1.start).toBe(240); expect(a1.start).toBe(240);
    expect(v2.sourceIn).toBe(20);
    expect(a1.audioStream).toBe(1);
    expect(S().dirty).toBe(true);
    expect(mediaDuration(S())(media.id)).toBe(100);
  });

  it('undo removes clips and redo restores them, with labels', () => {
    S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 0, mode: 'insert' });
    expect(clips()).toHaveLength(4);
    expect(getUndoLabels().undo).toBe('Insert');
    expect(S().undo()).toBe(true);
    expect(clips()).toHaveLength(2);
    expect(S().undo()).toBe(true);
    expect(clips()).toHaveLength(0);
    expect(S().undo()).toBe(false);
    expect(getUndoLabels().redo).toBe('Insert');
    expect(S().redo()).toBe(true);
    expect(S().redo()).toBe(true);
    expect(clips()).toHaveLength(4);
    expect(S().redo()).toBe(false);
  });

  it('overwrite mode does not ripple', () => {
    S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
    S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 25, atFrame: 48, mode: 'overwrite' });
    const v = seq().videoTracks[0].clips;
    expect(v.map((c) => [c.start, c.duration])).toEqual([[0, 48], [48, 120], [168, 72]]);
  });
});

describe('transactions', () => {
  it('begin/update/end yields a single undo step', () => {
    const [vid] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    const before = S().history.past.length;
    S().beginTransaction();
    for (let i = 1; i <= 5; i++) {
      S().updateTransient((d) => { const c = findClip(d.sequences[seqId], vid)!.clip; c.start = i * 10; });
    }
    expect(S().history.past.length).toBe(before);
    expect(S().endTransaction('Move')).toBe(true);
    expect(S().history.past.length).toBe(before + 1);
    expect(findClip(seq(), vid)!.clip.start).toBe(50);
    expect(getUndoLabels().undo).toBe('Move');
    S().undo();
    expect(findClip(seq(), vid)!.clip.start).toBe(0);
  });

  it('endTransaction with no change does not add history', () => {
    const before = S().history.past.length;
    S().beginTransaction();
    expect(S().endTransaction('Nothing')).toBe(false);
    expect(S().history.past.length).toBe(before);
  });

  it('cancelTransaction restores the snapshot', () => {
    const [vid] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    const before = S().history.past.length;
    S().beginTransaction();
    S().updateTransient((d) => { findClip(d.sequences[seqId], vid)!.clip.start = 999; });
    expect(findClip(seq(), vid)!.clip.start).toBe(999);
    S().cancelTransaction();
    expect(findClip(seq(), vid)!.clip.start).toBe(0);
    expect(S().history.past.length).toBe(before);
    expect(S().transaction).toBeNull();
  });
});

describe('sequences', () => {
  it('duplicateSequence yields new ids and preserved structure', () => {
    S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 240, mode: 'insert' });
    S().addTransitionAtCut(seqId, seq().videoTracks[0].id, 240, 'crossDissolve', 12);
    S().addMarker(seqId, { time: 10, name: 'M' });
    const src = seq();
    const newId = S().duplicateSequence(seqId, 'Alt cut')!;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(seqId);
    const dup = S().project.sequences[newId];
    expect(dup.name).toBe('Alt cut');
    expect(dup.parentSequenceId).toBe(seqId);
    expect(dup.versionLabel).toBe('v2');
    expect(S().project.activeSequenceId).toBe(newId);
    expect(S().project.sequenceOrder.indexOf(newId)).toBe(S().project.sequenceOrder.indexOf(seqId) + 1);

    const srcClips = allTracks(src).flatMap((t) => t.clips);
    const dupClips = allTracks(dup).flatMap((t) => t.clips);
    expect(dupClips).toHaveLength(srcClips.length);
    const srcIds = new Set(srcClips.map((c) => c.id));
    for (const c of dupClips) expect(srcIds.has(c.id)).toBe(false);
    for (let i = 0; i < srcClips.length; i++) {
      expect(dupClips[i].start).toBe(srcClips[i].start);
      expect(dupClips[i].duration).toBe(srcClips[i].duration);
      expect(dupClips[i].sourceIn).toBe(srcClips[i].sourceIn);
    }
    // link groups preserved pairwise with fresh ids
    const dv = dup.videoTracks[0].clips; const da = dup.audioTracks[0].clips;
    expect(dv[0].linkId).toBe(da[0].linkId);
    expect(dv[1].linkId).toBe(da[1].linkId);
    expect(dv[0].linkId).not.toBe(dv[1].linkId);
    expect(dv[0].linkId).not.toBe(src.videoTracks[0].clips[0].linkId);
    for (const t of allTracks(dup)) expect(allTracks(src).some((st) => st.id === t.id)).toBe(false);
    // transition references remapped
    const tr = dup.videoTracks[0].transitions[0];
    expect(tr).toBeTruthy();
    expect(tr.outClipId).toBe(dv[0].id); expect(tr.inClipId).toBe(dv[1].id);
    expect(dup.markers).toHaveLength(1); expect(dup.markers[0].id).not.toBe(src.markers[0].id);
    expect(dup.snapshots).toEqual([]);
  });

  it('snapshots take and restore, keeping the snapshot list and view', () => {
    S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    const snapId = S().takeSnapshot(seqId, 'before delete')!;
    expect(seq().snapshots).toHaveLength(1);
    S().select(clips().map((c) => c.id));
    S().deleteSelected();
    expect(clips()).toHaveLength(0);
    S().setView(seqId, { playhead: 77 });
    S().restoreSnapshot(seqId, snapId);
    expect(clips()).toHaveLength(2);
    expect(seq().snapshots).toHaveLength(1);
    expect(seq().view.playhead).toBe(77);
  });

  it('deleteSequence picks another active sequence', () => {
    const other = S().project.sequenceOrder.find((id) => id !== seqId)!;
    S().deleteSequence(seqId);
    expect(S().project.sequences[seqId]).toBeUndefined();
    expect(S().project.activeSequenceId).toBe(other);
  });
});

describe('media', () => {
  it('removeMedia removes clips, transitions and cues referencing it', () => {
    const other = fakeMedia('other.mkv');
    S().addMedia([other]);
    S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    S().insertFromSource(seqId, { mediaId: other.id, in: 0, out: 10, atFrame: 240, mode: 'insert' });
    S().addTransitionAtCut(seqId, seq().videoTracks[0].id, 240, 'crossDissolve', 12);
    expect(seq().videoTracks[0].transitions).toHaveLength(1);
    S().removeMedia([media.id]);
    expect(S().project.media[media.id]).toBeUndefined();
    const remaining = clips();
    expect(remaining).toHaveLength(2);
    for (const c of remaining) expect(c.mediaId).toBe(other.id);
    expect(seq().videoTracks[0].transitions).toHaveLength(0);
    S().undo();
    expect(S().project.media[media.id]).toBeTruthy();
    expect(clips()).toHaveLength(4);
  });

  it('setMediaProbe sets kind and clears offline', () => {
    const m = { ...createMediaItem('/x/a.mp4', 'a.mp4'), offline: true };
    S().addMedia([m]);
    S().setMediaProbe(m.id, fakeProbe(50));
    expect(S().project.media[m.id].kind).toBe('video');
    expect(S().project.media[m.id].offline).toBe(false);
    const img = createMediaItem('/x/b.png', 'b.png');
    S().addMedia([img]);
    S().setMediaProbe(img.id, { ...fakeProbe(0.04), container: 'png_pipe', audio: [], video: { ...fakeProbe().video!, codec: 'png' } });
    expect(S().project.media[img.id].kind).toBe('image');
    S().setMediaProbe(m.id, { error: 'boom' });
    expect(S().project.media[m.id].probeError).toBe('boom');
  });

  it('updateMedia merges a partial identity patch and clears fields set to undefined', () => {
    S().updateMedia(media.id, { identity: { series: 'Firefly', season: 1, episode: 3, title: 'Bushwhacked' } });
    S().updateMedia(media.id, { name: 'ep3.mkv', identity: { episode: 4 } });
    expect(S().project.media[media.id].name).toBe('ep3.mkv');
    expect(S().project.media[media.id].identity).toEqual({ series: 'Firefly', season: 1, episode: 4, title: 'Bushwhacked' });
    S().updateMedia(media.id, { identity: { title: undefined } });
    expect(S().project.media[media.id].identity).toEqual({ series: 'Firefly', season: 1, episode: 4 });
    expect(S().project.media[media.id].id).toBe(media.id);
  });

  it('proxy / scene / offline / relink status writes are quiet (no history, redo kept)', () => {
    S().renameProject('A');
    S().renameProject('B');
    S().undo();
    expect(S().canRedo()).toBe(true);
    const past = S().history.past.length;
    S().markSaved('/tmp/p.recut');
    S().setProxy(media.id, { status: 'running', progress: 0.5 });
    S().setSceneDetectStatus(media.id, 'running');
    S().setDetectedScenes(media.id, [10, 20], 100);
    S().setOffline(media.id, true);
    S().relinkMedia(media.id, '/media/new.mkv', { size: 5 });
    const m = S().project.media[media.id];
    expect(m.proxy.status).toBe('running');
    expect(m.detectedScenes).toHaveLength(3);
    expect(m.sceneDetectStatus).toBe('done');
    expect(m.offline).toBe(false);
    expect(m.path).toBe('/media/new.mkv');
    expect(S().history.past.length).toBe(past);
    expect(S().canRedo()).toBe(true);
    expect(S().dirty).toBe(true); // proxies / paths are persisted
    S().redo();
    expect(S().project.name).toBe('B');
    expect(S().canRedo()).toBe(false);
  });

  it('detected scenes: build, merge, split, delete', () => {
    S().setDetectedScenes(media.id, [10, 20, 30], 100);
    let sc = S().project.media[media.id].detectedScenes;
    expect(sc.map((s) => [s.start, s.end])).toEqual([[0, 10], [10, 20], [20, 30], [30, 100]]);
    expect(sc[0].name).toBe('Scene 001');
    S().mergeDetectedScenes(media.id, [sc[1].id, sc[2].id]);
    sc = S().project.media[media.id].detectedScenes;
    expect(sc.map((s) => [s.start, s.end])).toEqual([[0, 10], [10, 30], [30, 100]]);
    S().splitDetectedScene(media.id, sc[2].id, 50);
    sc = S().project.media[media.id].detectedScenes;
    expect(sc.map((s) => [s.start, s.end])).toEqual([[0, 10], [10, 30], [30, 50], [50, 100]]);
    S().deleteDetectedScene(media.id, sc[0].id);
    expect(S().project.media[media.id].detectedScenes).toHaveLength(3);
  });
});

describe('clip edits', () => {
  it('setClipSpeed duration math (ripple)', () => {
    const [vid] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    const [vid2] = S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 240, mode: 'insert' });
    S().setClipSpeed(seqId, vid, 2, { ripple: true });
    const v = findClip(seq(), vid)!.clip; const a = seq().audioTracks[0].clips[0];
    expect(v.speed).toBe(2); expect(v.duration).toBe(120); expect(a.duration).toBe(120);
    expect(findClip(seq(), vid2)!.clip.start).toBe(120);
    S().setClipSpeed(seqId, vid, 0.5, { ripple: true });
    expect(findClip(seq(), vid)!.clip.duration).toBe(480);
    expect(findClip(seq(), vid2)!.clip.start).toBe(480);
  });

  it('setClipSpeed without ripple is capped by the next clip', () => {
    const [vid] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    const [vid2] = S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 240, mode: 'insert' });
    S().setClipSpeed(seqId, vid, 0.5);
    expect(findClip(seq(), vid)!.clip.duration).toBe(240);
    expect(findClip(seq(), vid2)!.clip.start).toBe(240);
  });

  it('razor, trim, nudge, tags and vocabulary', () => {
    const [vid] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    S().setView(seqId, { playhead: 100 });
    const tails = S().razorAtPlayhead();
    expect(tails).toHaveLength(2);
    expect(seq().videoTracks[0].clips.map((c) => c.start)).toEqual([0, 100]);
    const tailV = seq().videoTracks[0].clips[1]; const tailA = seq().audioTracks[0].clips[1];
    expect(tailV.linkId).toBe(tailA.linkId);
    expect(tailV.linkId).not.toBe(findClip(seq(), vid)!.clip.linkId);

    S().trimClipEdge(seqId, vid, 'end', 80, false);
    expect(findClip(seq(), vid)!.clip.duration).toBe(80);
    expect(seq().audioTracks[0].clips[0].duration).toBe(80);

    S().select([tailV.id, tailA.id]);
    expect(selectedClips(S())).toHaveLength(2);
    S().nudgeSelected(-10);
    expect(findClip(seq(), tailV.id)!.clip.start).toBe(90);

    S().setClipTags(seqId, vid, { characters: ['Luke'], locations: ['Tatooine'], tags: ['opening'] });
    expect(S().project.tags.characters).toContain('Luke');
    expect(S().project.tags.locations).toContain('Tatooine');
    expect(S().project.tags.custom).toContain('opening');
    expect(seq().audioTracks[0].clips[0].characters).toEqual(['Luke']);

    S().select([vid]);
    S().rippleDeleteSelected();
    expect(findClip(seq(), vid)).toBeUndefined();
    expect(findClip(seq(), tailV.id)!.clip.start).toBe(10);
    expect(S().ui.selectedClipIds).toEqual([]);
  });

  it('default transition at selection of two adjacent clips', () => {
    const [v1] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    const [v2] = S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 240, mode: 'insert' });
    S().select([v1, v2]);
    S().addDefaultTransitionAtSelection();
    const trs = seq().videoTracks[0].transitions;
    expect(trs).toHaveLength(1);
    expect(trs[0].duration).toBe(S().project.settings.defaultTransitionFrames);
    S().setTransitionDuration(seqId, trs[0].id, 48);
    expect(seq().videoTracks[0].transitions[0].duration).toBe(48);
    S().removeTransition(seqId, trs[0].id);
    expect(seq().videoTracks[0].transitions).toHaveLength(0);
  });
});

describe('subtitles', () => {
  it('carrySubtitles creates sequence cues that resolve at correct frames', () => {
    const track: SubtitleTrack = {
      id: 'sub1', name: 'English', language: 'en', mediaId: media.id, origin: 'srt',
      cues: [
        { id: 'c1', start: 2, end: 4, text: 'Hello' },
        { id: 'c2', start: 9, end: 11, text: 'Straddles out' },
        { id: 'c3', start: 50, end: 52, text: 'Far away' },
      ],
    };
    S().addMediaSubtitleTrack(track);
    expect(S().project.media[media.id].subtitleTrackIds).toEqual(['sub1']);
    const [vid] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 48, mode: 'overwrite' });
    const s = seq();
    expect(s.subtitleTracks).toHaveLength(1);
    expect(s.subtitleTracks[0].language).toBe('en');
    expect(s.subtitleTracks[0].cues).toHaveLength(2);
    expect(s.subtitleTracks[0].cues.every((c) => c.clipId === vid)).toBe(true);
    const resolved = resolveSubtitleCues(s);
    expect(resolved.map((r) => [r.start, r.end, r.text])).toEqual([[96, 144, 'Hello'], [264, 288, 'Straddles out']]);

    // cues follow the clip when it moves
    S().moveClips(seqId, [{ clipId: vid, toTrackId: s.videoTracks[0].id, toStart: 0 }], 'overwrite');
    expect(resolveSubtitleCues(seq())[0].start).toBe(48);

    // second insert with same language reuses the track
    S().insertFromSource(seqId, { mediaId: media.id, in: 49, out: 55, atFrame: 1000, mode: 'overwrite' });
    expect(seq().subtitleTracks).toHaveLength(1);
    expect(seq().subtitleTracks[0].cues).toHaveLength(3);
  });

  it('split and merge cues', () => {
    S().addMediaSubtitleTrack({ id: 'sub1', name: 'en', language: 'en', mediaId: media.id, origin: 'srt', cues: [{ id: 'c1', start: 2, end: 4, text: 'Line one\nLine two' }] });
    S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
    const cue = seq().subtitleTracks[0].cues[0];
    const second = S().splitCue(seqId, cue.id, 72)!;
    let res = resolveSubtitleCues(seq());
    expect(res.map((r) => [r.start, r.end, r.text])).toEqual([[48, 72, 'Line one'], [72, 96, 'Line two']]);
    S().mergeCues(seqId, [cue.id, second]);
    res = resolveSubtitleCues(seq());
    expect(res).toHaveLength(1);
    expect(res[0].start).toBe(48); expect(res[0].end).toBe(96); expect(res[0].text).toBe('Line one\nLine two');
    S().updateCue(seqId, cue.id, { offset: 5 });
    expect(resolveSubtitleCues(seq())[0].start).toBe(53);
  });
});

describe('history + view', () => {
  it('caps history at limit', () => {
    const limit = S().history.limit;
    expect(limit).toBe(200);
    for (let i = 0; i < limit + 5; i++) S().renameProject(`P${i}`);
    expect(S().history.past.length).toBe(limit);
    expect(S().history.pastLabels.length).toBe(limit);
  });

  it('setView does not create history and is not undone', () => {
    const before = S().history.past.length;
    S().setView(seqId, { playhead: 100, zoom: 8, inPoint: 10, outPoint: 50 });
    expect(S().history.past.length).toBe(before);
    expect(seq().view).toMatchObject({ playhead: 100, zoom: 8, inPoint: 10, outPoint: 50 });
    S().setActiveSequence(S().project.sequenceOrder[0]);
    expect(S().history.past.length).toBe(before);
  });

  it('undo preserves current playhead', () => {
    S().setView(seqId, { playhead: 100 });
    S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    S().setView(seqId, { playhead: 500 });
    S().undo();
    expect(clips()).toHaveLength(0);
    expect(seq().view.playhead).toBe(500);
    S().redo();
    expect(seq().view.playhead).toBe(500);
  });

  it('commit that changes nothing does not push history', () => {
    const before = S().history.past.length;
    expect(S().commit('noop', () => {})).toBe(false);
    expect(S().history.past.length).toBe(before);
  });

  it('serializeForSave stamps modifiedAt and markSaved clears dirty', () => {
    S().renameProject('X');
    expect(S().dirty).toBe(true);
    const p = serializeForSave(S());
    expect(p.name).toBe('X');
    expect(p.modifiedAt).toBeGreaterThanOrEqual(S().project.modifiedAt);
    S().markSaved('/tmp/x.recut');
    expect(S().dirty).toBe(false);
    expect(S().projectPath).toBe('/tmp/x.recut');
  });
});

describe('bins + organisation', () => {
  it('organizeAsSeries creates series/season bins and sets identity', () => {
    const ep2 = fakeMedia('e2.mkv');
    S().addMedia([ep2]);
    const r = S().organizeAsSeries([media.id, ep2.id], 'Firefly', 1);
    const bins = S().project.bins;
    expect(bins[r.seriesBinId]).toMatchObject({ name: 'Firefly', kind: 'series', parentId: 'bin-tv' });
    expect(bins[r.seasonBinId]).toMatchObject({ name: 'Season 1', kind: 'season', parentId: r.seriesBinId });
    expect(S().project.media[media.id]).toMatchObject({ binId: r.seasonBinId, identity: { series: 'Firefly', season: 1 }, category: 'Episode' });
    // re-running reuses the same bins; per-item episode/title land in one commit
    const past = S().history.past.length;
    const r2 = S().organizeAsSeries([{ id: ep2.id, episode: 2, title: 'The Train Job' }], 'Firefly', 1);
    expect(r2).toEqual(r);
    expect(S().history.past.length).toBe(past + 1);
    expect(S().project.media[ep2.id].identity).toMatchObject({ series: 'Firefly', season: 1, episode: 2, title: 'The Train Job' });
    S().organizeAsSeries([{ id: ep2.id, title: '' }], 'Firefly', 1);
    expect(S().project.media[ep2.id].identity.title).toBeUndefined();
    expect(S().project.media[ep2.id].identity.episode).toBe(2);
    expect(Object.values(bins).filter((b) => b.kind === 'series')).toHaveLength(1);
    const tree = seriesTree(S());
    expect(tree.series).toHaveLength(1);
    expect(tree.series[0].seasons[0].episodes).toHaveLength(2);
  });

  it('deleteBin moves children to parent', () => {
    const parent = S().addBin('Parent');
    const child = S().addBin('Child', parent);
    const grandchild = S().addBin('Grandchild', child);
    S().moveToBin([media.id, seqId], child);
    expect(S().project.media[media.id].binId).toBe(child);
    S().deleteBin(child);
    expect(S().project.bins[child]).toBeUndefined();
    expect(S().project.bins[grandchild].parentId).toBe(parent);
    expect(S().project.media[media.id].binId).toBe(parent);
    expect(S().project.sequences[seqId].binId).toBe(parent);
  });
});

describe('selectors + ui', () => {
  it('originalTimecode and continuity issues', () => {
    S().updateMedia(media.id, { identity: { franchise: 'Star Wars', title: 'Empire Strikes Back' } });
    const [vid] = S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 100, mode: 'overwrite' });
    const clip = findClip(seq(), vid)!.clip;
    const tc = originalTimecode(clip, 148, FPS, S().project.media[media.id]);
    expect(tc.sourceSeconds).toBeCloseTo(22);
    expect(tc.sourceTimecode).toBe('00:00:22:00');
    expect(tc.fileName).toBe('movie.mkv');
    expect(tc.identityLabel).toBe('Star Wars › Empire Strikes Back');

    const id = S().addContinuityNote(seqId, { time: 120, name: 'Hat', note: 'wrong hat', category: 'wardrobe', clipId: vid })!;
    const issues = continuityIssues(S());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sequenceId: seqId, sequenceName: 'Test 24' });
    S().resolveContinuity(seqId, id);
    expect(continuityIssues(S())[0].marker.resolved).toBe(true);
  });

  it('selection modes and pruning after removal', () => {
    const ids = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    S().select([ids[0]]);
    S().select([ids[1]], 'add');
    expect(S().ui.selectedClipIds).toHaveLength(2);
    S().select([ids[0]], 'toggle');
    expect(S().ui.selectedClipIds).toEqual([ids[1]]);
    S().removeMedia([media.id]);
    expect(S().ui.selectedClipIds).toEqual([]);
    S().setSourceClip('nope');
    expect(S().ui.sourceClip?.mediaId).toBe('nope');
    const t = S().toast('info', 'hi');
    expect(S().ui.toasts).toHaveLength(1);
    S().dismissToast(t);
    expect(S().ui.toasts).toHaveLength(0);
    expect(S().history.past.length).toBeGreaterThan(0);
  });

  it('sceneFromSource uses the source in/out', () => {
    S().setSourceClip(media.id, 5);
    S().setSourceIn(12.5);
    S().setSourceOut(20);
    const id = S().sceneFromSource('Cantina')!;
    expect(S().project.scenes[id]).toMatchObject({ name: 'Cantina', mediaId: media.id, in: 12.5, out: 20 });
  });
});
