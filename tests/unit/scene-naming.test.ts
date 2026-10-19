/**
 * #144: shots and scenes named from what is said in them (the media's Whisper transcript or subtitles).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mediaSpeechCues, nameFromSpeech, speechText } from '../../shared/sceneNaming';
import { createMediaItem } from '../../shared/project';
import { useStore, resetStore } from '../../src/state/store';
import { nameShotsFromTranscript } from '../../src/panels/project/actions';
import { nameScenesFromTranscript } from '../../src/panels/scenes/sceneUtils';
import type { MediaItem, SubtitleTrack } from '../../shared/model';

(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const cue = (start: number, end: number, text: string) => ({ id: `c${start}`, start, end, text });

describe('speechText', () => {
  it('drops markup, sound descriptions, music, dashes and speaker labels', () => {
    expect(speechText('<i>Run!</i> {\\an8}[gunshot]')).toBe('Run!');
    expect(speechText('- Where are you?\n- (whispering) Here.')).toBe('Where are you? Here.');
    expect(speechText('♪ la la ♪')).toBe('la la');
    expect(speechText('JOHN: Get in the car.')).toBe('Get in the car.');
  });
});

describe('nameFromSpeech', () => {
  const cues = [cue(0, 2, 'Um, so we meet again.'), cue(2.5, 4, 'Uh, I suppose we do, Mr. Bond.'), cue(10, 12, '[explosion]'), cue(20, 22, 'Hi.')];
  it('the first words spoken in the range, fillers skipped, capitalised', () => {
    expect(nameFromSpeech(cues, 0, 5)).toBe('So we meet again. I suppose we do, Mr…');
    expect(nameFromSpeech(cues, 1, 2.2)).toBe('So we meet again.'); // a cue that started before the range counts
    expect(nameFromSpeech(cues, 19, 30)).toBe('Hi.');
  });
  it('cut to about 40 characters at a word boundary', () => {
    const long = [cue(0, 5, 'this is a very long line of dialogue that goes on and on and never seems to stop at all')];
    const name = nameFromSpeech(long, 0, 5)!;
    expect(name.length).toBeLessThanOrEqual(41);
    expect(name).toBe('This is a very long line of dialogue…');
  });
  it('null without speech: no cues in range, only sound descriptions or fillers', () => {
    expect(nameFromSpeech(cues, 5, 9)).toBeNull();
    expect(nameFromSpeech(cues, 9, 13)).toBeNull();
    expect(nameFromSpeech([cue(0, 1, 'Um... uh')], 0, 1)).toBeNull();
    expect(nameFromSpeech([], 0, 100)).toBeNull();
  });
});

describe('naming shots and scenes in the project', () => {
  const S = () => useStore.getState();
  let m: MediaItem;
  const track = (id: string, origin: string, cues: ReturnType<typeof cue>[], streamIndex?: number): SubtitleTrack => ({ id, name: id, language: 'en', mediaId: m.id, cues, origin, streamIndex });

  beforeEach(() => {
    resetStore();
    m = { ...createMediaItem('/m/a.mkv', 'a.mkv'), kind: 'video' };
    S().addMedia([m]);
  });

  it('mediaSpeechCues prefers the Whisper transcript, else subtitles, else none', () => {
    const tracks: Record<string, SubtitleTrack> = {};
    expect(mediaSpeechCues(m, tracks)).toBeNull();
    tracks.srt = track('srt', 'srt', [cue(0, 1, 'from subtitles')]);
    tracks.w = track('w', 'whisper', [cue(0, 1, 'from whisper')]);
    expect(mediaSpeechCues({ ...m, subtitleTrackIds: ['srt'] }, tracks)?.[0].text).toBe('from subtitles');
    expect(mediaSpeechCues({ ...m, subtitleTrackIds: ['srt', 'w'] }, tracks)?.[0].text).toBe('from whisper');
  });

  it('new detections are named through nameFor; shots without speech keep Shot NNN', () => {
    const cues = [cue(1, 2, 'Hello there.')];
    S().setDetectedScenes(m.id, [5], 10, (a, b) => nameFromSpeech(cues, a, b));
    expect(S().project.media[m.id].detectedScenes.map((x) => x.name)).toEqual(['Hello there.', 'Shot 002']);
  });

  it('Name from Transcript renames shots in one undo step, and undo restores the names', () => {
    S().setDetectedScenes(m.id, [5, 10], 15);
    S().addMediaSubtitleTrack(track('w', 'whisper', [cue(1, 2, 'Who goes there?'), cue(11, 12, 'A friend.')]));
    const live = () => S().project.media[m.id];
    expect(live().subtitleTrackIds).toContain('w');
    const past = S().history.past.length;
    expect(nameShotsFromTranscript(m.id)).toBe(2);
    expect(live().detectedScenes.map((x) => x.name)).toEqual(['Who goes there?', 'Shot 002', 'A friend.']);
    expect(S().history.past.length).toBe(past + 1);
    S().undo();
    expect(live().detectedScenes.map((x) => x.name)).toEqual(['Shot 001', 'Shot 002', 'Shot 003']);
    // Selected shots only.
    expect(nameShotsFromTranscript(m.id, [live().detectedScenes[2].id])).toBe(1);
    expect(live().detectedScenes.map((x) => x.name)).toEqual(['Shot 001', 'Shot 002', 'A friend.']);
  });

  it('Name from Transcript renames library scenes over their whole range', () => {
    S().addMediaSubtitleTrack(track('w', 'whisper', [cue(3, 4, 'Over here!')]));
    S().addScene({ id: 'sc', name: 'Scene 01', mediaId: m.id, in: 0, out: 6, characters: [], location: '', arc: '', tags: [], notes: '', rating: 0, color: '#fff', createdAt: 0 });
    expect(nameScenesFromTranscript([S().project.scenes.sc])).toBe(1);
    expect(S().project.scenes.sc.name).toBe('Over here!');
  });
});
