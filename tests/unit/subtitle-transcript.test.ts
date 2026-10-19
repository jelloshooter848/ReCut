/**
 * #162: a subtitle track (an imported SRT) can be a video's transcript: T lanes, the on-screen transcript, search and
 * naming read it, with its markup removed and estimated word timing for highlighting.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clipTranscriptCues, clipTranscriptTrack, estimateWords, transcriptDisplayText, transcriptIndex } from '../../shared/transcripts';
import { mediaSpeechCues } from '../../shared/sceneNaming';
import { createMediaItem } from '../../shared/project';
import type { MediaItem, Sequence, SubtitleTrack } from '../../shared/model';
import { useStore, resetStore } from '../../src/state/store';

const S = () => useStore.getState();
const fps = { num: 25, den: 1 };
let m: MediaItem;
const whisper: SubtitleTrack = { id: 'wh', name: 'English (Whisper)', language: 'en', mediaId: null, origin: 'whisper', streamIndex: 1,
  cues: [{ id: 'w1', start: 1, end: 3, text: 'I lost my papiers', words: [{ start: 1, end: 1.5, text: 'I' }, { start: 1.5, end: 2, text: 'lost' }, { start: 2, end: 2.5, text: 'my' }, { start: 2.5, end: 3, text: 'papiers' }] }] };
const srt: SubtitleTrack = { id: 'srt', name: 'English', language: 'en', mediaId: null, origin: 'srt',
  cues: [{ id: 's1', start: 1, end: 3, text: '<i>I lost my papers.</i>' }, { id: 's2', start: 10, end: 12, text: '{\\an8}Up there!' }] };

beforeEach(() => {
  resetStore();
  m = { ...createMediaItem('/m/film.mkv', 'film.mkv'), kind: 'video',
    probe: { container: 'matroska', duration: 60, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 320, height: 180, fps, avgFps: fps, isVfr: false },
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }] } };
  S().addMedia([m]);
  S().addMediaSubtitleTrack({ ...whisper, mediaId: m.id });
  S().addMediaSubtitleTrack({ ...srt, mediaId: m.id });
  S().updateSequenceSettings(S().project.activeSequenceId!, { fps });
});
const media = () => S().project.media[m.id];
const tracks = () => S().project.subtitleTracks;

describe('choosing the transcript', () => {
  it('Whisper by default; the chosen subtitle track when set; back to Whisper when cleared or removed; one undo step', () => {
    const clip = { id: 'c', mediaId: m.id, start: 0, duration: 500, sourceIn: 0, speed: 1 } as Parameters<typeof clipTranscriptTrack>[0];
    expect(clipTranscriptTrack(clip, media(), tracks())?.id).toBe('wh');
    S().setTranscriptSource(m.id, 'srt');
    expect(clipTranscriptTrack(clip, media(), tracks())?.id).toBe('srt');
    expect(mediaSpeechCues(media(), tracks())?.[0].id).toBe('s1');
    S().undo();
    expect(media().transcriptTrackId).toBeUndefined();
    S().redo();
    S().setTranscriptSource(m.id, 'not-a-track');
    expect(media().transcriptTrackId).toBeUndefined();
    S().setTranscriptSource(m.id, 'srt');
    S().removeMediaSubtitleTrack('srt');
    expect(media().transcriptTrackId).toBeUndefined();
    expect(clipTranscriptTrack(clip, media(), tracks())?.id).toBe('wh');
  });
});

describe('a subtitle file as the transcript', () => {
  it('markup removed; words estimated over each line; Whisper lines unchanged', () => {
    expect(transcriptDisplayText('<i>Hi</i> {\\an8}there  ')).toBe('Hi there');
    const w = estimateWords('I lost my papers.', 1, 3)!;
    expect(w.map((x) => x.text)).toEqual(['I', 'lost', 'my', 'papers.']);
    expect([w[0].start, w[3].end]).toEqual([1, 3]);
  });

  it('the T lane shows the SRT lines with estimated words, and they follow the clip', () => {
    const seqId = S().project.activeSequenceId!;
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 20, atFrame: 100, mode: 'overwrite' });
    S().setTranscriptSource(m.id, 'srt');
    const seq = () => S().project.sequences[seqId] as Sequence;
    const lane = () => [...transcriptIndex(seq(), S().project.media, tracks()).lanes.values()][0];
    expect(lane().map((c) => c.text)).toEqual(['I lost my papers.', 'Up there!']);
    expect(lane()[0]).toMatchObject({ start: 125, end: 175 });
    expect(lane()[0].words?.map((x) => x.text)).toEqual(['I', 'lost', 'my', 'papers.']);
    const clip = seq().audioTracks[0].clips[0];
    expect(clipTranscriptCues(clip, tracks().srt, fps)[1].start).toBe(100 + 10 * 25);
  });
});
