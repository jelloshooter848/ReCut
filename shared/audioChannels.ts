/**
 * Per-clip channel selection on a multichannel audio stream (Roadmap §9, the centre-channel quick utility).
 *
 * A clip plays its stream's normal mix (no `ClipAudio.channelSelection`, today's behaviour), one source channel as
 * mono, or a controlled stereo downmix with explicit centre and surround levels (ITU-R BS.775 defaults, LFE omitted).
 * This module is pure: the render graph (electron/export/renderGraph.ts) and the preview's channel proxy job
 * (electron/media/channelProxy.ts) build their FFmpeg `pan` filter with `channelPanFilter`, so the preview proxy holds
 * exactly what a stereo export renders; the Inspector, the planner and the Extract Centre Channel command read the
 * stream's channels from here.
 *
 * Channels are named as FFmpeg names them (FL, FR, FC, LFE, BL, BR, SL, SR, ...) from the layout ffprobe reports. When
 * the layout is unknown (`AudioStreamInfo.layoutGuessed`, or a layout string FFmpeg does not define), channels are
 * numbered instead: `c0`, `c1`, ... (shown as Channel 1, 2, ...), and the controlled downmix is not offered.
 */
import type { AudioChannelSelection, AudioStreamInfo, Clip, ID, MediaItem, Sequence } from './model';
import { channelSourceClip } from './timeline';

/** BS.775 defaults of the controlled downmix: centre and surrounds at −3 dB, LFE omitted. */
export const DEFAULT_CENTRE_DB = -3;
export const DEFAULT_SURROUND_DB = -3;
/** Range of the downmix levels (dB). −60 dB is effectively off. */
export const DOWNMIX_DB_MIN = -60;
export const DOWNMIX_DB_MAX = 6;
/**
 * Gain of a single (mono) channel on each side of a stereo mix: equal power, −3.01 dB, the level FFmpeg gives a mono
 * source in a stereo mix and the level the centre has in the standard downmix. A 5.1 mix plays it from the centre
 * speaker at full level.
 */
export const MONO_IN_STEREO_GAIN = Math.SQRT1_2;
/** Bumped when the filter a channel proxy is made with changes, so older cached proxies are not reused. */
export const CHANNEL_PROXY_VERSION = 1;

/** FFmpeg's standard layouts (`ffmpeg -layouts`), channel order as FFmpeg decodes them. */
const STANDARD_LAYOUTS: Record<string, readonly string[]> = {
  mono: ['FC'],
  stereo: ['FL', 'FR'],
  '2.1': ['FL', 'FR', 'LFE'],
  '3.0': ['FL', 'FR', 'FC'],
  '3.0(back)': ['FL', 'FR', 'BC'],
  '4.0': ['FL', 'FR', 'FC', 'BC'],
  quad: ['FL', 'FR', 'BL', 'BR'],
  'quad(side)': ['FL', 'FR', 'SL', 'SR'],
  '3.1': ['FL', 'FR', 'FC', 'LFE'],
  '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'],
  '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'],
  '4.1': ['FL', 'FR', 'FC', 'LFE', 'BC'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  '6.0': ['FL', 'FR', 'FC', 'BC', 'SL', 'SR'],
  '6.0(front)': ['FL', 'FR', 'FLC', 'FRC', 'SL', 'SR'],
  '3.1.2': ['FL', 'FR', 'FC', 'LFE', 'TFL', 'TFR'],
  hexagonal: ['FL', 'FR', 'FC', 'BL', 'BR', 'BC'],
  '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  '6.1(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BC'],
  '6.1(front)': ['FL', 'FR', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  '7.0': ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR'],
  '7.0(front)': ['FL', 'FR', 'FC', 'FLC', 'FRC', 'SL', 'SR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'],
  '7.1(wide-side)': ['FL', 'FR', 'FC', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  '5.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR'],
  octagonal: ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR'],
  cube: ['FL', 'FR', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '5.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '7.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR'],
  '7.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  downmix: ['DL', 'DR'],
};

/** Human names of FFmpeg's channel ids. */
export const CHANNEL_NAMES: Readonly<Record<string, string>> = {
  FL: 'Front left', FR: 'Front right', FC: 'Centre', LFE: 'LFE (subwoofer)', BL: 'Back left', BR: 'Back right',
  FLC: 'Front left of centre', FRC: 'Front right of centre', BC: 'Back centre', SL: 'Side left', SR: 'Side right',
  TC: 'Top centre', TFL: 'Top front left', TFC: 'Top front centre', TFR: 'Top front right', TBL: 'Top back left',
  TBC: 'Top back centre', TBR: 'Top back right', DL: 'Downmix left', DR: 'Downmix right', WL: 'Wide left',
  WR: 'Wide right', SDL: 'Surround direct left', SDR: 'Surround direct right', LFE2: 'LFE 2', TSL: 'Top side left',
  TSR: 'Top side right', BFC: 'Bottom front centre', BFL: 'Bottom front left', BFR: 'Bottom front right',
};

/** A channel id as stored in `AudioChannelSelection.channel`: an FFmpeg channel name, or `c<N>` (0-based). */
const CHANNEL_ID = /^(?:[A-Z][A-Z0-9]{0,4}|c\d{1,2})$/;

type StreamLike = Pick<AudioStreamInfo, 'channels' | 'layout'> & { layoutGuessed?: boolean };

/**
 * The FFmpeg channel names of a stream in decode order, or null when its layout is unknown: guessed by the probe from
 * the channel count, not a layout FFmpeg defines, or not matching the channel count. A custom layout reported as
 * `FL+FR+...` or `6 channels (FL+FR+...)` is read from its decomposition.
 */
export function layoutChannelNames(stream: StreamLike | undefined): string[] | null {
  if (!stream || stream.layoutGuessed) return null;
  const n = stream.channels;
  const layout = typeof stream.layout === 'string' ? stream.layout.trim() : '';
  let names: readonly string[] | undefined = Object.hasOwn(STANDARD_LAYOUTS, layout) ? STANDARD_LAYOUTS[layout] : undefined;
  if (!names) {
    const m = /^(?:\d+ channels \()?([A-Z][A-Z0-9]*(?:\+[A-Z][A-Z0-9]*)+)\)?$/.exec(layout);
    if (m) names = m[1].split('+');
  }
  if (!names || names.length !== n || new Set(names).size !== names.length) return null;
  return [...names];
}

/** The channel ids a stream offers: its layout's names, or `c0`..`c<N-1>` when the layout is unknown. */
export function streamChannelIds(stream: StreamLike | undefined): string[] {
  if (!stream || !(stream.channels > 0)) return [];
  return layoutChannelNames(stream) ?? Array.from({ length: stream.channels }, (_, i) => `c${i}`);
}

/** "Centre (FC)", "LFE (subwoofer) (LFE)", "Channel 3" for `c2`. */
export function channelLabel(id: string): string {
  const m = /^c(\d+)$/.exec(id);
  if (m) return `Channel ${Number(m[1]) + 1}`;
  return CHANNEL_NAMES[id] ? `${CHANNEL_NAMES[id]} (${id})` : id;
}

/** Whether the per-clip channel selection is offered for a stream: two or more channels. */
export function isMultichannel(stream: StreamLike | undefined): boolean {
  return !!stream && stream.channels >= 2;
}

/** Whether the controlled stereo downmix is offered: more than two channels in a known layout. */
export function canDownmix(stream: StreamLike | undefined): boolean {
  return !!stream && stream.channels > 2 && layoutChannelNames(stream) !== null;
}

/** Whether the stream has a real centre channel (FC in a known layout of three or more channels; mono does not count). */
export function hasCentreChannel(stream: StreamLike | undefined): boolean {
  return !!stream && stream.channels >= 3 && (layoutChannelNames(stream)?.includes('FC') ?? false);
}

/** Index of `channel` in the stream's decode order, or -1 when the stream has no such channel. */
export function channelIndex(stream: StreamLike | undefined, channel: string): number {
  if (!stream) return -1;
  const m = /^c(\d+)$/.exec(channel);
  if (m) {
    // A numbered channel addresses the stream by position, whatever its layout.
    const i = Number(m[1]);
    return i < stream.channels ? i : -1;
  }
  return layoutChannelNames(stream)?.indexOf(channel) ?? -1;
}

export type ResolvedChannelSelection =
  | { mode: 'channel'; index: number; channel: string }
  | { mode: 'downmix'; left: [number, number][]; right: [number, number][] };

export function dbToGain(db: number): number { return Math.pow(10, db / 20); }

/** Stereo downmix side of each FFmpeg channel: 'L', 'R', 'C' (both, centre level), 'S' (both, surround level). */
function downmixRole(name: string): { side: 'L' | 'R' | 'both'; level: 'front' | 'centre' | 'surround' } | null {
  switch (name) {
    case 'FL': case 'FLC': case 'WL': return { side: 'L', level: 'front' };
    case 'FR': case 'FRC': case 'WR': return { side: 'R', level: 'front' };
    case 'FC': return { side: 'both', level: 'centre' };
    case 'BL': case 'SL': case 'SDL': case 'TFL': case 'TBL': case 'TSL': return { side: 'L', level: 'surround' };
    case 'BR': case 'SR': case 'SDR': case 'TFR': case 'TBR': case 'TSR': return { side: 'R', level: 'surround' };
    case 'BC': case 'TC': case 'TFC': case 'TBC': return { side: 'both', level: 'surround' };
    default: return null; // LFE, LFE2 (omitted, BS.775), DL / DR, bottom channels
  }
}

/**
 * What a selection plays on `stream`, or null for the stream's normal mix: no selection, or one the stream cannot
 * honour (a channel it does not have, a downmix of a stereo stream or of an unknown layout). The export and the
 * preview both fall back to the normal mix then; `channelSelectionProblem` says why.
 */
export function resolveChannelSelection(sel: AudioChannelSelection | undefined, stream: StreamLike | undefined): ResolvedChannelSelection | null {
  if (!sel || !stream) return null;
  if (sel.mode === 'channel') {
    if (!isMultichannel(stream)) return null;
    const index = channelIndex(stream, sel.channel);
    return index < 0 ? null : { mode: 'channel', index, channel: sel.channel };
  }
  if (!canDownmix(stream)) return null;
  const names = layoutChannelNames(stream)!;
  const c = dbToGain(sel.centreDb), s = dbToGain(sel.surroundDb);
  const left: [number, number][] = [], right: [number, number][] = [];
  names.forEach((name, i) => {
    const role = downmixRole(name);
    if (!role) return;
    const g = role.level === 'front' ? 1 : role.level === 'centre' ? c : s;
    if (role.side !== 'R') left.push([i, g]);
    if (role.side !== 'L') right.push([i, g]);
  });
  return { mode: 'downmix', left, right };
}

/** Why a selection falls back to the stream's normal mix (null when it applies, or there is none). */
export function channelSelectionProblem(sel: AudioChannelSelection | undefined, stream: StreamLike | undefined): string | null {
  if (!sel || !stream) return null;
  if (resolveChannelSelection(sel, stream)) return null;
  if (!isMultichannel(stream)) return 'the stream is mono';
  if (sel.mode === 'channel') return `the stream (${stream.layout || `${stream.channels} channels`}) has no ${channelLabel(sel.channel)} channel`;
  return stream.channels <= 2 ? 'a stereo stream has nothing to downmix' : 'the stream\'s channel layout is unknown';
}

function gainStr(g: number): string {
  const s = g.toFixed(6).replace(/\.?0+$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

function panSum(terms: [number, number][]): string {
  return terms.length ? terms.map(([i, g]) => `${gainStr(g)}*c${i}`).join('+') : '0*c0';
}

/**
 * The FFmpeg `pan` filter that applies a selection, for a mix whose layout is `outLayout` ('stereo', or '5.1' for a
 * 6-channel mix); null for the normal mix (no filter). A single channel is mono: in stereo it sits in the centre at
 * MONO_IN_STEREO_GAIN on each side, in 5.1 it plays from the centre speaker at full level. The controlled downmix is
 * always stereo (`=` in `pan`: the gains are exact, never renormalised); a 5.1 mix takes it on its front pair. Gains
 * address channels by position (`c<N>`), so an unknown layout works the same way.
 */
export function channelPanFilter(sel: AudioChannelSelection | undefined, stream: StreamLike | undefined, outLayout: string): string | null {
  const r = resolveChannelSelection(sel, stream);
  if (!r) return null;
  if (r.mode === 'channel') {
    if (outLayout === 'mono') return `pan=mono|c0=1*c${r.index}`;
    if (outLayout === '5.1' || outLayout === '5.1(side)') return `pan=${outLayout}|c2=1*c${r.index}`;
    const t = `${gainStr(MONO_IN_STEREO_GAIN)}*c${r.index}`;
    return `pan=stereo|c0=${t}|c1=${t}`;
  }
  return `pan=stereo|c0=${panSum(r.left)}|c1=${panSum(r.right)}`;
}

/** dB value rounded and clamped as the model stores it (0.1 dB steps within DOWNMIX_DB_MIN..MAX). */
export function clampDownmixDb(db: number, fallback: number): number {
  if (!Number.isFinite(db)) return fallback;
  const v = Math.round(Math.min(DOWNMIX_DB_MAX, Math.max(DOWNMIX_DB_MIN, db)) * 10) / 10;
  return v + 0; // never -0
}

/** The selection of a loaded clip, repaired: undefined when absent or unusable (the normal mix). */
export function normalizeChannelSelection(v: unknown): { value: AudioChannelSelection | undefined; repaired: boolean } {
  if (v === undefined) return { value: undefined, repaired: false };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: undefined, repaired: true };
  const o = v as Record<string, unknown>;
  if (o.mode === 'channel') {
    if (typeof o.channel === 'string' && CHANNEL_ID.test(o.channel)) return { value: { mode: 'channel', channel: o.channel }, repaired: false };
    return { value: undefined, repaired: true };
  }
  if (o.mode === 'downmix') {
    const c = typeof o.centreDb === 'number' ? clampDownmixDb(o.centreDb, DEFAULT_CENTRE_DB) : DEFAULT_CENTRE_DB;
    const s = typeof o.surroundDb === 'number' ? clampDownmixDb(o.surroundDb, DEFAULT_SURROUND_DB) : DEFAULT_SURROUND_DB;
    return { value: { mode: 'downmix', centreDb: c, surroundDb: s }, repaired: c !== o.centreDb || s !== o.surroundDb };
  }
  return { value: undefined, repaired: true };
}

/** A valid channel id (FFmpeg name or `c<N>`). */
export function isChannelId(v: unknown): v is string { return typeof v === 'string' && CHANNEL_ID.test(v); }

function dbKey(db: number): string { return gainStr(Math.round(db * 10) / 10); }

/**
 * Key of the preview proxy that plays `sel` on audio stream `stream` (absolute index): `<stream>.ch-FC`,
 * `<stream>.dm-c-3-s-3`. File-name safe; the key of `MediaItem.channelProxies`.
 */
export function channelProxyKey(stream: number, sel: AudioChannelSelection): string {
  return sel.mode === 'channel' ? `${stream}.ch-${sel.channel}` : `${stream}.dm-c${dbKey(sel.centreDb)}-s${dbKey(sel.surroundDb)}`;
}

/** A well-formed `channelProxyKey`. */
export const CHANNEL_PROXY_KEY = /^\d{1,6}\.(?:ch-(?:[A-Z][A-Z0-9]{0,4}|c\d{1,2})|dm-c-?\d+(?:\.\d)?-s-?\d+(?:\.\d)?)$/;

/** Short label of a selection: "Centre (FC)", "Channel 3", "Stereo downmix (centre −3 dB, surround −3 dB)". */
export function channelSelectionLabel(sel: AudioChannelSelection | undefined): string {
  if (!sel) return 'Normal mix';
  if (sel.mode === 'channel') return channelLabel(sel.channel);
  const f = (db: number) => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db)} dB`;
  return `Stereo downmix (centre ${f(sel.centreDb)}, surround ${f(sel.surroundDb)})`;
}

/** The stream a probe lists with absolute index `index`. */
export function audioStreamInfo(audio: readonly AudioStreamInfo[] | undefined, index: number | null | undefined): AudioStreamInfo | undefined {
  if (!audio || index === null || index === undefined) return undefined;
  return audio.find((a) => a.index === index);
}

/**
 * The audio stream a clip plays, resolved as the export does (renderGraph.ts audioStreamIndex): the clip's stream,
 * else the media's preferred one, when the probe lists it; else the first audio stream.
 */
export function clipAudioStream(media: MediaItem | undefined, clip: Pick<Clip, 'audioStream'>): AudioStreamInfo | undefined {
  const audio = media?.probe?.audio;
  if (!audio || audio.length === 0) return undefined;
  const want = clip.audioStream ?? media!.preferredAudioStream;
  return (want !== undefined ? audio.find((a) => a.index === want) : undefined) ?? audio[0];
}

/** Name of the clip Extract Centre Channel adds. */
export function centreClipName(name: string): string { return `${name} (centre)`; }

export type CentreExtraction =
  | { ok: true; source: Clip; stream: AudioStreamInfo; media: MediaItem }
  | { ok: false; reason: string };

/**
 * Whether Extract Centre Channel (Dialogue) can run on `clipId`, and on what: the clip's sound (shared/timeline.ts
 * channelSourceClip) and its stream, which must have a centre channel (FC in a known layout of three or more
 * channels, e.g. 5.1). `reason` explains why not, for the disabled menu item.
 */
export function centreExtraction(seq: Sequence, media: Record<ID, MediaItem>, clipId: ID): CentreExtraction {
  const source = channelSourceClip(seq, clipId);
  if (!source) return { ok: false, reason: 'Select a clip first.' };
  const m = media[source.mediaId];
  if (!m) return { ok: false, reason: 'The clip\'s media is not in the project.' };
  if (!m.probe) return { ok: false, reason: 'The clip\'s media has not been read yet.' };
  const stream = clipAudioStream(m, source);
  if (!stream) return { ok: false, reason: 'The clip\'s source has no audio.' };
  if (!hasCentreChannel(stream)) {
    const what = stream.layoutGuessed ? `${stream.channels} channels in an unknown layout` : stream.layout || `${stream.channels} channels`;
    return { ok: false, reason: `The source audio (${what}) has no centre channel. Extract Centre Channel needs a surround stream such as 5.1.` };
  }
  return { ok: true, source, stream, media: m };
}
