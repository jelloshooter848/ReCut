/**
 * #118: word timestamps and short cues. whisper-cli's `-ojf` tokens (with `--dtw` alignment) become words with times,
 * long segments become short cues of a few words, and the words survive the cache, the project file, the copy into a
 * sequence and resolveSubtitleCues (in frames). wordAt finds the word spoken at a time.
 */
import { describe, it, expect } from 'vitest';
import { CUE_LINGER_SECONDS, CUE_MAX_CHARS, lingerCues, parseWhisperJson, segmentsToCues, splitWords, tokensToWords } from '../../electron/whisper/output';
import { whisperArgs } from '../../electron/whisper/transcribeJob';
import { whisperDtwPreset } from '../../shared/whisper';
import { wordAt } from '../../shared/subtitles';
import { createMediaItem, createProject, createSequence, normalizeProjectWithReport, serializeProject } from '../../shared/project';
import { resolveSubtitleCues } from '../../shared/timeline';
import { useStore, resetStore } from '../../src/state/store';
import type { MediaItem, SubtitleWord } from '../../shared/model';

const tok = (text: string, from: number, to: number, dtw = -1) => ({ text, offsets: { from, to }, t_dtw: dtw });

describe('tokensToWords', () => {
  it('joins pieces and punctuation, skips special tokens, starts words at the DTW time', () => {
    const words = tokensToWords([
      tok('[_BEG_]', 0, 0), tok(' So', 0, 100, 10), tok(',', 100, 200, 25), tok(' I', 200, 300, 40), tok('-', 300, 320, 45),
      tok(' I', 320, 400, 60), tok(' re', 400, 500, 80), tok('mote', 500, 700, 95), tok(' -', 700, 720, 120), tok('[_TT_50]', 720, 720),
    ], 0, 2);
    expect(words.map((w) => w.text)).toEqual(['So,', 'I-', 'I', 'remote -']);
    expect(words.map((w) => w.start)).toEqual([0.1, 0.4, 0.6, 0.8]);
  });

  it('falls back to token offsets without DTW, and keeps a pause between words visible', () => {
    const words = tokensToWords([tok(' Hello', 1000, 1400), tok(' there', 3000, 3400)], 1, 4);
    expect(words.map((w) => [w.text, w.start])).toEqual([['Hello', 1], ['there', 3]]);
    expect(words[0].end).toBeLessThan(2);       // estimated from its length, not stretched to the next word
    expect(words[1].end).toBeLessThanOrEqual(4);
    for (const w of words) expect(w.end).toBeGreaterThan(w.start);
  });

  it('a word never runs past the next one', () => {
    const words = tokensToWords([tok(' extraordinarily', 0, 0, 0), tok(' fast', 0, 0, 30)], 0, 5);
    expect(words[0].end).toBe(0.3);
  });
});

describe('splitWords', () => {
  const w = (text: string, start: number, end = start + 0.2): SubtitleWord => ({ text, start, end });
  it('breaks at sentence ends, pauses and the length limit', () => {
    const groups = splitWords([w('Okay.', 0), w('So', 0.3), w('this', 0.5), w('um', 2), w('is', 2.3), w('it', 2.5)]);
    expect(groups.map((g) => g.map((x) => x.text).join(' '))).toEqual(['Okay.', 'So this', 'um is it']);
    const long = Array.from({ length: 20 }, (_, i) => w('word', i * 0.3));
    for (const g of splitWords(long)) expect(g.map((x) => x.text).join(' ').length).toBeLessThanOrEqual(CUE_MAX_CHARS);
  });

  it('breaks after a comma only once the cue is half full', () => {
    const groups = splitWords([w('Yes,', 0), w('and', 0.3), w('then', 0.5), w('we', 0.7), w('went', 0.9), w('over', 1.1), w('there,', 1.3), w('right', 1.5)]);
    expect(groups.map((g) => g.map((x) => x.text).join(' '))).toEqual(['Yes, and then we went over there,', 'right']);
  });
});

describe('parseWhisperJson + segmentsToCues', () => {
  const json = JSON.stringify({
    result: { language: 'en' },
    transcription: [{
      offsets: { from: 1000, to: 6000 }, text: ' So, you see the remote control board. That is it.',
      tokens: [tok(' So', 1000, 1000, 100), tok(',', 1000, 1200, 110), tok(' you', 1200, 1400, 130), tok(' see', 1400, 1600, 150),
        tok(' the', 1600, 1700, 170), tok(' remote', 1700, 2000, 180), tok(' control', 2000, 2600, 210), tok(' board', 2600, 3000, 260),
        tok('.', 3000, 3100, 300), tok(' That', 4000, 4200, 420), tok(' is', 4200, 4400, 450), tok(' it', 4400, 4600, 470), tok('.', 4600, 4700, 490)],
    }],
  });

  it('turns a long segment into short word-timed cues, in source time', () => {
    const parsed = parseWhisperJson(json);
    expect(parsed.segments[0].words).toHaveLength(10);
    const cues = segmentsToCues(parsed.segments, 100, 60);
    expect(cues.map((c) => c.text)).toEqual(['So, you see the remote control board.', 'That is it.']);
    expect(cues[0].start).toBe(101);
    expect(cues[0].words![5]).toMatchObject({ text: 'control', start: 102.1 });
    expect(cues[1].start).toBe(104.2);
    for (const c of cues) expect(c.words!.map((x) => x.text).join(' ')).toBe(c.text);
  });

  it('a segment without tokens stays one cue (older results)', () => {
    const cues = segmentsToCues([{ start: 0, end: 5, text: ' One long line without tokens.' }]);
    expect(cues).toHaveLength(1);
    expect(cues[0].words).toBeUndefined();
  });
});

describe('lingerCues (#119: text stays through a pause)', () => {
  const cue = (start: number, end: number, words = true) => ({ id: `c${start}`, start, end, text: 'x', ...(words ? { words: [{ start, end, text: 'x' }] } : {}) });
  it('keeps a word-timed cue up to CUE_LINGER_SECONDS after its last word, never into the next cue or past the limit', () => {
    const cues = lingerCues([cue(0, 1), cue(1.3, 2), cue(5, 6), cue(6.5, 7)], 7.4);
    expect(cues.map((c) => c.end)).toEqual([1.3, 2 + CUE_LINGER_SECONDS, 6.5, 7.4]);
    for (let i = 0; i + 1 < cues.length; i++) expect(cues[i].end).toBeLessThanOrEqual(cues[i + 1].start);
  });
  it('leaves cues without word timing alone, and the words keep their own times', () => {
    const [plain, timed] = lingerCues([cue(0, 1, false), cue(3, 4)]);
    expect(plain.end).toBe(1);
    expect(timed.end).toBe(4 + CUE_LINGER_SECONDS);
    expect(timed.words![0].end).toBe(4);
  });
});

describe('whisper-cli arguments', () => {
  it('asks for tokens, and DTW alignment (flash attention off) for models with a preset', () => {
    const o = { model: 'm.bin', input: 'a.wav', outBase: 'out', threads: 2, language: 'en', translate: false };
    expect(whisperArgs(o)).toContain('-ojf');
    expect(whisperArgs(o)).not.toContain('--dtw');
    const args = whisperArgs({ ...o, dtw: 'large.v3.turbo' });
    expect(args.slice(args.indexOf('--dtw'), args.indexOf('--dtw') + 3)).toEqual(['--dtw', 'large.v3.turbo', '-nfa']);
    expect(whisperDtwPreset('large-v3-turbo')).toBe('large.v3.turbo');
    expect(whisperDtwPreset('small.en')).toBe('small.en');
    expect(whisperDtwPreset('test-tiny')).toBeNull();
  });
});

describe('wordAt', () => {
  const cues = [
    { start: 0, end: 2, words: [{ start: 0, end: 0.5, text: 'a' }, { start: 1, end: 1.8, text: 'b' }] },
    { start: 3, end: 4, words: [{ start: 3, end: 4, text: 'c' }] },
    { start: 5, end: 6 },
  ];
  it('finds the word spoken at a time, null between words or without timing', () => {
    expect(wordAt(cues, 1.2)?.word.text).toBe('b');
    expect(wordAt(cues, 3.5)).toMatchObject({ cueIndex: 1, wordIndex: 0 });
    expect(wordAt(cues, 0.7)).toBeNull();
    expect(wordAt(cues, 2.5)).toBeNull();
    expect(wordAt(cues, 5.5)).toBeNull();
    expect(wordAt(cues, -1)).toBeNull();
  });
});

describe('words in the project', () => {
  it('survive save and load; malformed word timing is dropped with a repair note', () => {
    const p = createProject('Words');
    p.subtitleTracks.st = {
      id: 'st', name: 'English (Whisper Small)', language: 'eng', mediaId: null, origin: 'whisper',
      cues: [
        { id: 'c1', start: 0, end: 1, text: 'Hi there', words: [{ start: 0, end: 0.4, text: 'Hi' }, { start: 0.5, end: 1, text: 'there' }] },
        { id: 'c2', start: 2, end: 3, text: 'Bad', words: 'nope' as never },
      ],
    };
    const { project, repairs } = normalizeProjectWithReport(JSON.parse(serializeProject(p)));
    expect(project.subtitleTracks.st.cues[0].words).toEqual(p.subtitleTracks.st.cues[0].words);
    expect(project.subtitleTracks.st.cues[1].words).toBeUndefined();
    expect(repairs.join(' ')).toMatch(/word timing/);
  });

  it('highlighting the spoken word is on by default, also for projects saved before the setting existed', () => {
    const p = JSON.parse(serializeProject(createProject('Old')));
    delete p.settings.highlightSpokenWords;
    expect(normalizeProjectWithReport(p).project.settings.highlightSpokenWords).toBe(true);
  });

  it('are copied into the sequence with the clip (a non-Whisper track) and resolved to frames', () => {
    resetStore();
    const S = useStore.getState;
    const FPS = { num: 25, den: 1 };
    const media: MediaItem = {
      ...createMediaItem('/m/talk.mp4', 'talk.mp4'), kind: 'video',
      probe: { container: 'mp4', duration: 60, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
        video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
        audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }] },
    };
    S().addMedia([media]);
    // Whisper tracks are no longer copied (they show live in T lanes, #112); a word-timed track of another origin is.
    S().addMediaSubtitleTrack({
      id: 'w', name: 'English', language: 'eng', mediaId: media.id, origin: 'manual',
      cues: [{ id: 'c1', start: 10, end: 11, text: 'Hello there', words: [{ start: 10, end: 10.4, text: 'Hello' }, { start: 10.5, end: 11, text: 'there' }] }],
    });
    const seq = createSequence('S', FPS);
    S().addSequence(seq);
    S().insertFromSource(seq.id, { mediaId: media.id, in: 8, out: 20, atFrame: 100, mode: 'overwrite' });
    const s = S().project.sequences[seq.id];
    expect(s.subtitleTracks[0].cues[0].words).toHaveLength(2);
    const [cue] = resolveSubtitleCues(s);
    // source 10 s is 2 s into the clip, which starts at frame 100: frame 150; "there" at 10.5 s: frame 162.5 → 163.
    expect(cue.words).toEqual([{ start: 150, end: 160, text: 'Hello' }, { start: 163, end: 175, text: 'there' }]);
    expect(wordAt([cue], 165)?.word.text).toBe('there');
  });
});
