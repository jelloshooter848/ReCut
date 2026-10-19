/**
 * #135: editing subtitle and transcript lines by hand. Transcript edits change the media's own cue (source seconds),
 * so an edited line keeps following its audio clip; timeline cues added by hand attach to the clip under them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeCueText, rescaleWords, retextWords, splitCueText, spreadWords } from '../../shared/cueEdit';
import { createMediaItem } from '../../shared/project';
import { resolveSubtitleCues } from '../../shared/timeline';
import { transcriptIndex } from '../../shared/transcripts';
import type { MediaItem, Sequence, SubtitleTrack } from '../../shared/model';
import { useStore, resetStore } from '../../src/state/store';

const w = (start: number, end: number, text: string) => ({ start, end, text });

describe('word timing follows edited text', () => {
  it('same word count: each word keeps its timing, new spelling', () => {
    expect(retextWords([w(1, 1.4, 'Jason'), w(1.4, 2, 'Bourn')], 'Jason Bourne', 1, 2)).toEqual([w(1, 1.4, 'Jason'), w(1.4, 2, 'Bourne')]);
  });
  it('another word count: the cue time is shared out by word length; no words before or no text after: none', () => {
    const out = retextWords([w(0, 1, 'Hello')], 'Hello there friend', 0, 3)!;
    expect(out.map((x) => x.text)).toEqual(['Hello', 'there', 'friend']);
    expect(out[0].start).toBe(0);
    expect(out[2].end).toBe(3);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeCloseTo(out[i - 1].end, 3);
    expect(retextWords(undefined, 'x', 0, 1)).toBeUndefined();
    expect(retextWords([w(0, 1, 'a')], '   ', 0, 1)).toBeUndefined();
    expect(spreadWords(['a'], 2, 4)).toEqual([w(2, 4, 'a')]);
  });
  it('a timing edit moves and stretches the words; split and merge keep words in step with text', () => {
    expect(rescaleWords([w(10, 11, 'a'), w(11, 12, 'b')], [10, 12], [20, 24])).toEqual([w(20, 22, 'a'), w(22, 24, 'b')]);
    const s = splitCueText('a b c', [w(0, 1, 'a'), w(1, 2, 'b'), w(2, 3, 'c')], 0, 3, 1.5)!;
    expect([s.a.text, s.b.text]).toEqual(['a b', 'c']);
    expect(splitCueText('one', [w(0, 1, 'one')], 0, 1, 0.5)).toBeNull();
    expect(splitCueText('one two three four', undefined, 0, 4, 2)).toEqual({ a: { text: 'one two' }, b: { text: 'three four' } });
    expect(mergeCueText([{ text: 'a b', words: [w(0, 1, 'a'), w(1, 2, 'b')] }, { text: 'c', words: [w(2, 3, 'c')] }]))
      .toEqual({ text: 'a b c', words: [w(0, 1, 'a'), w(1, 2, 'b'), w(2, 3, 'c')] });
    expect(mergeCueText([{ text: 'a' }, { text: 'b', words: [w(1, 2, 'b')] }])).toEqual({ text: 'a b' });
  });
});

describe('editing transcript lines in the store', () => {
  const S = () => useStore.getState();
  let m: MediaItem;
  const TRACK = 'wh1';
  const fps = { num: 25, den: 1 };
  beforeEach(() => {
    resetStore();
    m = {
      ...createMediaItem('/m/film.mkv', 'film.mkv'), kind: 'video',
      probe: { container: 'matroska', duration: 60, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
        video: { index: 0, codec: 'h264', width: 320, height: 180, fps, avgFps: fps, isVfr: false },
        audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }] },
    };
    S().addMedia([m]);
    const track: SubtitleTrack = {
      id: TRACK, name: 'English (Whisper)', language: 'en', mediaId: m.id, origin: 'whisper', streamIndex: 1,
      cues: [
        { id: 'c1', start: 10, end: 12, text: 'Jason Bourn', words: [w(10, 11, 'Jason'), w(11, 12, 'Bourn')] },
        { id: 'c2', start: 13, end: 14, text: 'Hello.' },
        { id: 'c3', start: 14, end: 15, text: 'Again.' },
      ],
    };
    S().addMediaSubtitleTrack(track);
    S().updateSequenceSettings(S().project.activeSequenceId!, { fps }); // 25 fps keeps the frame arithmetic readable
  });
  const cues = () => S().project.subtitleTracks[TRACK].cues;
  const tl = () => S().project.sequences[S().project.activeSequenceId!];

  it('fixing a word keeps the word timing and marks the transcript edited; one undo step', () => {
    const past = S().history.past.length;
    S().editMediaCue(TRACK, 'c1', { text: 'Jason Bourne' });
    expect(cues()[0]).toMatchObject({ text: 'Jason Bourne', words: [w(10, 11, 'Jason'), w(11, 12, 'Bourne')] });
    expect(S().project.subtitleTracks[TRACK].edited).toBe(true);
    expect(S().history.past.length).toBe(past + 1);
    S().undo();
    expect(cues()[0].text).toBe('Jason Bourn');
  });

  it('timing: kept off the neighbours; empty text deletes the line', () => {
    S().editMediaCue(TRACK, 'c2', { start: 11, end: 14.5 });
    expect(cues()[1]).toMatchObject({ start: 12, end: 14 }); // c1 ends at 12, c3 starts at 14
    S().editMediaCue(TRACK, 'c1', { start: 9, end: 11.5 });
    expect(cues()[0].words).toEqual([w(9, 10.25, 'Jason'), w(10.25, 11.5, 'Bourn')]); // the words follow the new span
    S().editMediaCue(TRACK, 'c3', { text: '  ' });
    expect(cues().map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('add into a gap, split, merge consecutive lines, delete', () => {
    const id = S().addMediaCue(TRACK, { start: 2, end: 4, text: 'Opening line' })!;
    expect(cues()[0]).toMatchObject({ id, start: 2, end: 4, text: 'Opening line' });
    const b = S().splitMediaCue(TRACK, 'c1', 10.9)!;
    expect(cues().find((c) => c.id === 'c1')).toMatchObject({ text: 'Jason', end: 11 });
    expect(cues().find((c) => c.id === b)).toMatchObject({ text: 'Bourn', start: 11, end: 12 });
    S().mergeMediaCues(TRACK, ['c1', b]);
    expect(cues().find((c) => c.id === 'c1')).toMatchObject({ text: 'Jason Bourn', start: 10, end: 12 });
    S().mergeMediaCues(TRACK, ['c1', 'c3']); // not consecutive: refused
    expect(cues()).toHaveLength(4);
    S().removeMediaCue(TRACK, id);
    expect(cues()).toHaveLength(3);
  });

  it('an edited line keeps following its audio clip when the clip moves (the T lane reads it live)', () => {
    const seqId = S().project.activeSequenceId!;
    // A clip of source 8..16 s at frame 100 (4 s in at 25 fps).
    S().insertFromSource(seqId, { mediaId: m.id, in: 8, out: 16, atFrame: 100, mode: 'overwrite', includeVideo: false, includeAudio: true });
    S().editMediaCue(TRACK, 'c1', { text: 'Jason Bourne' });
    const lane = () => [...transcriptIndex(tl() as Sequence, S().project.media, S().project.subtitleTracks).lanes.values()][0];
    const line = () => lane().find((c) => c.text === 'Jason Bourne')!;
    expect(line().start).toBe(100 + (10 - 8) * 25);
    const a = tl().audioTracks[0];
    const clipId = a.clips[0].id;
    S().moveClips(seqId, [{ clipId, toTrackId: a.id, toStart: 500 }], 'overwrite');
    expect(line().start).toBe(500 + (10 - 8) * 25); // moved with the clip
    expect(line().text).toBe('Jason Bourne');
  });

  it('transcribing again replaces the track and clears the edited mark', () => {
    S().editMediaCue(TRACK, 'c2', { text: 'Hi.' });
    S().putWhisperSubtitleTrack({ id: 'new', name: 'English (Whisper)', language: 'en', mediaId: m.id, origin: 'whisper', streamIndex: 1, cues: [{ id: 'x', start: 1, end: 2, text: 'Fresh' }] });
    expect(S().project.subtitleTracks[TRACK].edited).toBeUndefined();
    expect(cues()).toEqual([{ id: 'x', start: 1, end: 2, text: 'Fresh' }]);
  });
});

describe('timeline subtitle cues', () => {
  const S = () => useStore.getState();
  let m: MediaItem;
  beforeEach(() => {
    resetStore();
    m = { ...createMediaItem('/m/a.mkv', 'a.mkv'), kind: 'video', probe: { container: 'matroska', duration: 60, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 320, height: 180, fps: { num: 25, den: 1 }, avgFps: { num: 25, den: 1 }, isVfr: false }, audio: [] } };
    S().addMedia([m]);
    S().updateSequenceSettings(S().project.activeSequenceId!, { fps: { num: 25, den: 1 } });
  });
  const seq = () => S().project.sequences[S().project.activeSequenceId!];

  it('a cue added over a clip is attached to it and follows it; Unpin keeps it in place', () => {
    const seqId = seq().id;
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 10, atFrame: 50, mode: 'overwrite' });
    const trackId = S().addSequenceSubtitleTrack(seqId)!;
    const id = S().addManualCue(seqId, trackId, { start: 75, duration: 50, text: 'Look out!' })!;
    expect(seq().subtitleTracks[0].cues[0]).toMatchObject({ clipId: seq().videoTracks[0].clips[0].id, srcStart: 1, srcEnd: 3 });
    const v = seq().videoTracks[0];
    S().moveClips(seqId, [{ clipId: v.clips[0].id, toTrackId: v.id, toStart: 150 }], 'overwrite');
    expect(resolveSubtitleCues(seq()).find((c) => c.id === id)).toMatchObject({ start: 175, end: 225 });
    S().unpinCue(seqId, id);
    S().moveClips(seqId, [{ clipId: v.clips[0].id, toTrackId: v.id, toStart: 0 }], 'overwrite');
    expect(resolveSubtitleCues(seq()).find((c) => c.id === id)).toMatchObject({ start: 175, end: 225 }); // stayed
  });

  it('setCueTiming keeps an attached cue in its clip; editing text re-times its words (the old updateCue bug)', () => {
    const seqId = seq().id;
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
    const trackId = S().addSequenceSubtitleTrack(seqId)!;
    const id = S().addManualCue(seqId, trackId, { start: 25, duration: 25, text: 'one two' })!;
    S().commit('words', (d) => { const c = d.sequences[seqId].subtitleTracks[0].cues[0]; c.words = [w(1, 1.5, 'one'), w(1.5, 2, 'two')]; });
    S().updateCue(seqId, id, { text: 'one too' });
    expect(seq().subtitleTracks[0].cues[0].words).toEqual([w(1, 1.5, 'one'), w(1.5, 2, 'too')]);
    S().setCueTiming(seqId, id, 50, 400); // past the clip's end (250): limited to it
    expect(resolveSubtitleCues(seq()).find((c) => c.id === id)).toMatchObject({ start: 50, end: 250 });
  });
});
