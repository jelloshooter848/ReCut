/**
 * #160: whisper's stock phrases written over music or silence ("Thank you." over a logo) are dropped; the same words
 * spoken are kept.
 */
import { describe, expect, it } from 'vitest';
import { isStockHallucination, parseWhisperJson } from '../../electron/whisper/output';

const tok = (text: string, p: number) => ({ text, p, t_dtw: -1, offsets: { from: 0, to: 0 } });
const seg = (from: number, to: number, text: string, ps: number[]) => ({
  offsets: { from, to }, text, tokens: [tok('[_BEG_]', 0.7), ...text.trim().split(' ').map((w, i) => tok(` ${w}`, ps[i] ?? 0.9))],
});

describe('stock hallucinations', () => {
  it('recognises the phrases, ignoring case and punctuation, only when they do not sound like speech', () => {
    expect(isStockHallucination(' Thank you.', 30, 0.9)).toBe(true);           // fills a whole window
    expect(isStockHallucination('Thank you.', 1.7, 0.03)).toBe(true);          // a guess
    expect(isStockHallucination('Thank you.', 1.7, 0.95)).toBe(false);         // spoken
    expect(isStockHallucination('Transcription by CastingWords', 30, 0.8)).toBe(true);
    expect(isStockHallucination('Subtitles by the Amara.org community', 25, 0.9)).toBe(true);
    expect(isStockHallucination('THE END', 28, 0.5)).toBe(true);
    expect(isStockHallucination('Thanks for watching!', 2, 0.05)).toBe(true);
    expect(isStockHallucination('Thank you for coming back.', 30, 0.01)).toBe(false); // not a stock phrase
    expect(isStockHallucination('Oh, my God.', 30, 0.2)).toBe(false);
  });

  it('parseWhisperJson drops them and keeps everything else', () => {
    const json = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        seg(0, 29980, ' Thank you.', [0.03, 0.99]),                           // over the Universal logo
        seg(30000, 59980, ' Oh, my God.', [0.82, 0.9, 0.23]),
        seg(61000, 62500, ' Thank you.', [0.97, 0.99]),                       // said by someone
        seg(90000, 119980, ' Transcription by CastingWords', [0.4, 0.6, 0.5]),
      ],
    });
    expect(parseWhisperJson(json).segments.map((s) => [s.start, s.text.trim()])).toEqual([[30, 'Oh, my God.'], [61, 'Thank you.']]);
  });
});
