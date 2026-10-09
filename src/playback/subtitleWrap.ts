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
