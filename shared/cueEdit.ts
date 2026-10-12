/**
 * Editing subtitle / transcript cues by hand (#135): keeping a cue's per-word timing (`words`, #118) consistent with
 * its edited text, and splitting / merging word timing. The model rule "the words joined by spaces are `text`" holds
 * for every result. Pure: no DOM, no Node.
 */
import type { SubtitleWord } from './model';

const tokens = (text: string) => text.split(/\s+/).filter(Boolean);

/**
 * Word timing for a cue's new text. Same number of words: each word keeps its timing and takes the new spelling.
 * Otherwise the cue's time (start..end) is shared out over the new words in proportion to their length. No words
 * before (a plain cue), or no text after: no words.
 */
export function retextWords(words: readonly SubtitleWord[] | undefined, text: string, start: number, end: number): SubtitleWord[] | undefined {
  if (!words?.length) return undefined;
  const t = tokens(text);
  if (!t.length) return undefined;
  if (t.length === words.length) return words.map((w, i) => ({ start: w.start, end: w.end, text: t[i] }));
  return spreadWords(t, start, end);
}

/** `texts` laid out over start..end, each word's share proportional to its length (plus one for the gap). */
export function spreadWords(texts: readonly string[], start: number, end: number): SubtitleWord[] {
  const total = texts.reduce((n, w) => n + w.length + 1, 0);
  const span = Math.max(0, end - start);
  const out: SubtitleWord[] = [];
  let at = start;
  for (const w of texts) {
    const len = (span * (w.length + 1)) / total;
    out.push({ start: round3(at), end: round3(at + len), text: w });
    at += len;
  }
  if (out.length) out[out.length - 1].end = round3(end);
  return out;
}

/** Words moved and stretched from the cue's old span to its new one (a timing edit keeps their relative places). */
export function rescaleWords(words: readonly SubtitleWord[] | undefined, from: [number, number], to: [number, number]): SubtitleWord[] | undefined {
  if (!words?.length) return undefined;
  const [a0, a1] = from, [b0, b1] = to;
  const k = a1 > a0 ? (b1 - b0) / (a1 - a0) : 0;
  const map = (t: number) => round3(Math.min(b1, Math.max(b0, b0 + (t - a0) * k)));
  return words.map((w) => ({ start: map(w.start), end: map(w.end), text: w.text }));
}

/**
 * A cue split at time `at`: the text and words before and after. With words, each word goes to the side its start
 * falls on (both sides keep at least one word); without, the text splits at the word nearest the same fraction of the
 * cue's time. Null when it cannot be split (one word, or `at` outside the cue).
 */
export function splitCueText(text: string, words: readonly SubtitleWord[] | undefined, start: number, end: number, at: number):
  { a: { text: string; words?: SubtitleWord[] }; b: { text: string; words?: SubtitleWord[] } } | null {
  if (!(at > start && at < end)) return null;
  if (words?.length) {
    let k = words.findIndex((w) => w.start >= at);
    if (k < 0) k = words.length;
    k = Math.min(words.length - 1, Math.max(1, k));
    if (words.length < 2) return null;
    const wa = words.slice(0, k), wb = words.slice(k);
    return { a: { text: wa.map((w) => w.text).join(' '), words: wa }, b: { text: wb.map((w) => w.text).join(' '), words: wb } };
  }
  const t = tokens(text);
  if (t.length < 2) return null;
  const k = Math.min(t.length - 1, Math.max(1, Math.round(((at - start) / (end - start)) * t.length)));
  return { a: { text: t.slice(0, k).join(' ') }, b: { text: t.slice(k).join(' ') } };
}

/** Text and words of merged cues (in time order): texts joined by a space; words kept when every cue has them. */
export function mergeCueText(parts: readonly { text: string; words?: readonly SubtitleWord[] }[]): { text: string; words?: SubtitleWord[] } {
  const text = parts.map((p) => p.text.trim()).filter(Boolean).join(' ');
  const all = parts.every((p) => (p.words?.length ?? 0) > 0);
  return all ? { text, words: parts.flatMap((p) => p.words!.map((w) => ({ ...w }))) } : { text };
}

function round3(x: number): number { return Math.round(x * 1000) / 1000; }
