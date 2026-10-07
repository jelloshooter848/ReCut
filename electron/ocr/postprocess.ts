/**
 * OCR text clean-up (pure).
 *  - a standalone `|` (and `|` before 'm / 'll / 've / 'd) is the letter I;
 *  - runs of whitespace collapse to one space, lines are trimmed;
 *  - empty lines and lines of only punctuation / symbols (specks read as ". ,", "-", "_") are dropped;
 *  - the bands of one subtitle are joined with '\n'.
 */

const PIPE_AS_I = /(^|[\s"“‘(\[¿¡-])\|(?=$|[\s.,!?;:"”’)\]…-]|['’](?:m|ll|ve|d|s)\b)/gu;
const ONLY_PUNCT = /^[\p{P}\p{S}\s]*$/u;

/** Clean one OCR result (any number of lines). */
export function cleanOcrText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.replace(/[\s ​]+/gu, ' ').trim();
    // Twice: "| |" has overlapping matches.
    line = line.replace(PIPE_AS_I, '$1I').replace(PIPE_AS_I, '$1I');
    if (!line || ONLY_PUNCT.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Clean each band's text and join the non-empty ones top to bottom. */
export function joinBands(texts: string[]): string {
  return texts.map(cleanOcrText).filter((t) => t.length > 0).join('\n');
}
