/**
 * Line wrapping for subtitles drawn on the Program monitor canvas (sequencePlayer.drawSubtitleOverlay). Canvas text
 * does not wrap, so a long cue (a Whisper segment is one line of 20+ words) overflowed both edges of the frame (#114).
 */

/** Share of the frame width subtitle lines may use: the Source monitor's overlay leaves 8 % on each side. */
export const SUBTITLE_MAX_WIDTH = 0.84;

/**
 * Split `text` into lines no wider than `maxWidth`: explicit line breaks are kept, words are packed greedily, and a
 * single word wider than `maxWidth` gets a line of its own. `measure` returns a string's width (ctx.measureText).
 */
export function wrapSubtitleText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > maxWidth) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Colour of the word being spoken (karaoke highlight, #119), in the Source and Program monitors alike. */
export const SUBTITLE_HIGHLIGHT = '#ffd84d';

/**
 * The word to highlight at time `t` (#119): the last word that has started, so the highlight moves word by word and
 * stays on a word through the short pause after it; -1 before the first word. `words` are in cue order; times are in
 * any unit (seconds in the Source monitor, frames in the Program monitor) as long as `t` uses the same one.
 */
export function activeWordIndex(words: readonly { start: number }[] | undefined, t: number): number {
  if (!words) return -1;
  let i = -1;
  while (i + 1 < words.length && words[i + 1].start <= t) i++;
  return i;
}

/** wrapSubtitleText for a cue's words: the lines as lists of word indices, so each word can be drawn on its own. */
export function wrapWords(words: readonly string[], maxWidth: number, measure: (s: string) => number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let text = '';
  words.forEach((w, i) => {
    const next = text ? `${text} ${w}` : w;
    if (line.length && measure(next) > maxWidth) { lines.push(line); line = [i]; text = w; } else { line.push(i); text = next; }
  });
  if (line.length) lines.push(line);
  return lines;
}
