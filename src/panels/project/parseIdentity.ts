/**
 * Pure filename → episode identity parser (no DOM, no store).
 *
 * Recognises the usual release / library conventions:
 *   "Show.Name.S01E03.Title.1080p.mkv"   → series "Show Name", season 1, episode 3, title "Title"
 *   "Show Name - 1x03 - Title.mkv"       → series "Show Name", season 1, episode 3, title "Title"
 *   "Show Name Season 1 Episode 3.mp4"   → series "Show Name", season 1, episode 3
 *   "Show Name (2019) S02E05.mkv"        → series "Show Name", year 2019, season 2, episode 5
 *   "Show Name E05.mkv"                  → series "Show Name", episode 5
 *   "Movie Name (1999).mkv"              → title "Movie Name", year 1999
 */
export interface EpisodeInfo {
  series?: string;
  season?: number;
  episode?: number;
  /** Last episode of a multi-episode file (S01E01E02 / S01E01-E02). */
  episodeEnd?: number;
  title?: string;
  year?: number;
}

const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|avi|wmv|webm|ts|m2ts|mts|mpg|mpeg|flv|ogv|3gp|srt|vtt|ass|ssa|sub|m4a|mp3|wav|flac|aac|ac3|png|jpe?g|gif|webp)$/i;

/** Tokens that mark the start of release junk; everything from the first match onwards is dropped from a title. */
const JUNK_TOKEN = /^(480p|576p|720p|1080p|1080i|2160p|4k|uhd|hdr|hdr10|dv|dovi|sdr|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|web|webrip|web-dl|webdl|bluray|blu-ray|bdrip|brrip|dvdrip|dvd|hdtv|pdtv|remux|proper|repack|internal|limited|extended|unrated|directors|dc|imax|amzn|nf|hulu|dsnp|atvp|hmax|max|pcok|aac|aac2\.0|ac3|eac3|dd5\.1|ddp5\.1|ddp|dts|dts-hd|truehd|atmos|5\.1|7\.1|2\.0|10bit|8bit|multi|dual|subbed|dubbed|complete|retail|hc|cam|ts|tc|scr|r5)$/i;

function clean(s: string): string {
  return s.replace(/[._]+/g, ' ').replace(/\s*[-–—:]+\s*$/g, '').replace(/^\s*[-–—:]+\s*/g, '').replace(/\s{2,}/g, ' ').trim();
}

function stripJunk(s: string): string {
  const words = clean(s).split(' ');
  const out: string[] = [];
  for (const w of words) {
    if (!w) continue;
    if (JUNK_TOKEN.test(w.replace(/[[\]()]/g, ''))) break;
    if (/^\[.*\]$/.test(w)) continue;          // [Group] tags
    if (/^-[A-Za-z0-9]+$/.test(w)) break;      // -GROUP suffix
    out.push(w);
  }
  // Drop a trailing "-GROUP" glued to the last word (Title-NTb)
  const joined = out.join(' ').replace(/-[A-Za-z0-9]{2,}$/g, '').trim();
  return clean(joined);
}

function extractYear(s: string): { rest: string; year?: number } {
  const m = /[(\[]?((?:19|20)\d{2})[)\]]?(?=\s|$|[._-])/.exec(s);
  if (!m) return { rest: s };
  const year = Number(m[1]);
  // Ignore things that look like resolutions / episode numbers (e.g. 2160p handled by junk anyway)
  const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ');
  return { rest, year };
}

function baseName(fileName: string): string {
  const i = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const base = i >= 0 ? fileName.slice(i + 1) : fileName;
  return base.replace(VIDEO_EXT, '');
}

/**
 * Parse a filename (or path) into an episode / movie identity. Never throws; fields are omitted when unknown.
 */
export function parseEpisodeInfo(fileName: string): EpisodeInfo {
  const raw = baseName(fileName ?? '').trim();
  if (!raw) return {};
  const text = raw.replace(/[._]+/g, ' ');
  const out: EpisodeInfo = {};

  const patterns: { re: RegExp; season: number | null; episode: number; end?: number }[] = [
    // S01E03, S01 E03, S01E03E04, S01E03-E04, S1E3
    { re: /(?:^|[\s\-([])S(\d{1,2})\s?E(\d{1,3})(?:\s?(?:-\s?)?E(\d{1,3}))?(?=[\s\-)\]]|$)/i, season: 1, episode: 2, end: 3 },
    // 1x03, 01x03, 1x03-04
    { re: /(?:^|[\s\-(\[])(\d{1,2})x(\d{1,3})(?:\s?-\s?(?:\d{1,2}x)?(\d{1,3}))?(?=[\s\-)\]]|$)/i, season: 1, episode: 2, end: 3 },
    // Season 1 Episode 3 / Season 01 Ep 3 / Series 1 Episode 3
    { re: /(?:^|[\s\-(\[])(?:Season|Series|Saison|Staffel)\s?(\d{1,2})\s*(?:[,\-–]|)\s*(?:Episode|Ep|E|Folge|Épisode)\.?\s?(\d{1,3})(?=[\s\-)\]]|$)/i, season: 1, episode: 2 },
    // Episode 3 / Ep3 / E03 (no season)
    { re: /(?:^|[\s\-(\[])(?:Episode|Ep|E)\.?\s?(\d{1,3})(?=[\s\-)\]]|$)/i, season: null, episode: 1 },
    // Part 3 (treated as episode)
    { re: /(?:^|[\s\-(\[])(?:Part|Pt)\.?\s?(\d{1,2})(?=[\s\-)\]]|$)/i, season: null, episode: 1 },
  ];

  let matchIndex = -1;
  let matchEnd = -1;
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    // m.index points at the separator (if any); the marker itself starts after it
    matchIndex = /^[\s\-(\[]/.test(m[0]) ? m.index + 1 : m.index;
    matchEnd = m.index + m[0].length;
    if (p.season !== null) out.season = Number(m[p.season]);
    out.episode = Number(m[p.episode]);
    if (p.end !== undefined && m[p.end]) { const e = Number(m[p.end]); if (e > out.episode) out.episodeEnd = e; }
    break;
  }

  // A bare "Season 1" with no episode marker still tells us the season.
  if (out.season === undefined) {
    const sm = /(?:^|[\s\-(\[])(?:Season|Series|Staffel)\s?(\d{1,2})(?=[\s\-)\]]|$)/i.exec(text);
    if (sm) {
      out.season = Number(sm[1]);
      if (matchIndex < 0) { matchIndex = sm.index + (/^[\s\-(\[]/.test(sm[0]) ? 1 : 0); matchEnd = sm.index + sm[0].length; }
    }
  }

  if (matchIndex >= 0) {
    const before = text.slice(0, matchIndex);
    const after = text.slice(matchEnd);
    const y1 = extractYear(before);
    if (y1.year !== undefined) out.year = y1.year;
    const series = stripJunk(y1.rest);
    if (series) out.series = series;
    const y2 = extractYear(after);
    if (out.year === undefined && y2.year !== undefined && !/^\s*\d{4}\s*$/.test(after) ) out.year = y2.year;
    const title = stripJunk(y2.year !== undefined ? y2.rest : after);
    if (title && !/^\d+$/.test(title)) out.title = title;
    return out;
  }

  // No episode marker: treat as a movie / loose title.
  const y = extractYear(text);
  if (y.year !== undefined) out.year = y.year;
  const title = stripJunk(y.rest);
  if (title) out.title = title;
  return out;
}

/** "S01E03" / "S01" / "E03" label for display; '' when nothing is known. */
export function episodeLabel(info: { season?: number; episode?: number; episodeEnd?: number }): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = info.season !== undefined ? `S${p(info.season)}` : '';
  const e = info.episode !== undefined ? `E${p(info.episode)}${info.episodeEnd !== undefined ? `-E${p(info.episodeEnd)}` : ''}` : '';
  return `${s}${e}`;
}
