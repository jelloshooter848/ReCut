/**
 * Naming shots and scenes from what is said in them (#144): the first words spoken inside a source range, from the
 * media's transcript (Whisper) or subtitles. Pure: no DOM, no Node.
 */
import type { ID, MediaItem, SubtitleCue, SubtitleTrack } from './model';

/** Names are cut to about this many characters, at a word boundary. */
export const SPEECH_NAME_MAX = 40;

/** Hesitations dropped from names ("um, so we go" -> "So we go"). Compared lowercase without punctuation. */
const FILLERS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uh-huh', 'ah', 'ahh', 'er', 'erm', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'mm-hmm']);

/**
 * Subtitle markup and non-speech removed: tags (<i>, {\an8}), sound descriptions ([music], (laughs)), music notes,
 * leading dialogue dashes and speaker labels ("JOHN:").
 */
export function speechText(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[♪♫]/g, ' ')
    .replace(/\\N/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-–—]\s*/, '').replace(/^\s*[A-Z][A-Z0-9 .'-]{1,24}:\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isFiller = (w: string) => FILLERS.has(w.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, ''));

/** A name from the speech overlapping start..end (source seconds), or null when nothing is said there. */
export function nameFromSpeech(cues: readonly Pick<SubtitleCue, 'start' | 'end' | 'text'>[], start: number, end: number, max = SPEECH_NAME_MAX): string | null {
  const inside = cues.filter((c) => c.end > start && c.start < end).sort((a, b) => a.start - b.start);
  const words: string[] = [];
  let len = 0;
  for (const c of inside) {
    for (const w of speechText(c.text).split(' ')) {
      if (!w || isFiller(w)) continue;
      words.push(w);
      len += w.length + 1;
    }
    if (len > max) break;
  }
  // A lone leftover punctuation mark ("…", "-") is not speech.
  if (!words.some((w) => /[\p{L}\p{N}]/u.test(w))) return null;
  let name = '';
  let cut = false;
  for (const w of words) {
    const next = name ? `${name} ${w}` : w;
    if (next.length > max && name) { cut = true; break; }
    name = next;
  }
  name = name.replace(/^[^\p{L}\p{N}"'¿¡]+/u, '');
  if (cut) name = `${name.replace(/[\s,;:.!?…-]+$/u, '')}…`;
  else name = name.replace(/[\s,;:-]+$/u, '');
  return name ? name[0].toLocaleUpperCase() + name.slice(1) : null;
}

/**
 * The cues to name a media item's shots and scenes from: its latest Whisper transcript (of its preferred audio
 * stream when there are several), else its first subtitle track with cues; null when it has neither.
 */
export function mediaSpeechCues(media: MediaItem | undefined, tracks: Record<ID, SubtitleTrack>): SubtitleCue[] | null {
  if (!media) return null;
  const own = media.subtitleTrackIds.map((id) => tracks[id]).filter((t): t is SubtitleTrack => !!t && t.cues.length > 0);
  const stream = media.preferredAudioStream ?? media.probe?.audio[0]?.index;
  const whisper = own.filter((t) => t.origin === 'whisper');
  const pick = whisper.filter((t) => t.streamIndex === undefined || t.streamIndex === stream).at(-1) ?? whisper.at(-1) ?? own[0];
  return pick ? pick.cues : null;
}
