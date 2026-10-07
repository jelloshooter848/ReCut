/**
 * Thin async wrappers around `window.recut` (IPC) that feed results into the store.
 * Every access to `window.recut` is guarded so this module is importable under vitest/node.
 */
import type { ID, JobInfo, MediaItem, MediaProbe, Project, SubtitleTrack } from '../../shared/model';
import type { RecutApi, SaveResult } from '../../shared/ipc';
import { createMediaItem, normalizeProject } from '../../shared/project';
import { projectJsonChunks } from '../../shared/projectJson';
import {
  canStreamAutosave, canStreamSave, decodeProjectWire, isProjectWire, type ProjectAutosaveStreamApi, type ProjectSaveStreamApi, type SaveBeginResult,
} from '../../shared/projectWire';
import { parseSubtitles } from '../../shared/subtitles';
import { uid } from '../../shared/ids';
import { useStore } from './store';
import { fileNameOf } from './selectors';
import { classifyPath, importIdentity, sidecarLanguage, LONG_FORM_MOVIE_SEC, type ImportBinKind } from './parseIdentity';
import { isStillImage, mediaNeedsProxyForPreview, proxyStreamStale } from '../playback/mediaSource';
import { ffmpegUnavailable } from './ffmpegStatus';

export function recutApi(): RecutApi | null {
  return typeof window !== 'undefined' && window.recut ? window.recut : null;
}

export interface ImportReport {
  /** Newly created media items (in input order). */
  added: ID[];
  /** Paths that were already in the project → their existing item ids. */
  existing: ID[];
  /** Subtitle paths in the input (never imported as media). */
  subtitlePaths: string[];
  /** Subtitle paths attached as sidecars of imported videos. */
  sidecarsUsed: string[];
  /** Bins that received new items. */
  binIds: ID[];
}

export interface ImportOptions {
  /** Toast about subtitle files in `paths` that were not picked up as sidecars (default true). */
  rejectSubtitles?: boolean;
}

type ImportListener = (r: ImportReport) => void;
const importListeners = new Set<ImportListener>();
/** Subscribe to finished imports (fires right after the items are added, before probing). Returns unsubscribe. */
export function onMediaImported(l: ImportListener): () => void { importListeners.add(l); return () => { importListeners.delete(l); }; }

const TOAST = { info: 'info', ok: 'success', warn: 'warning', error: 'error' } as const;
const say = (kind: keyof typeof TOAST, text: string) => { useStore.getState().toast(TOAST[kind], text); };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DEFAULT_BINS: Record<Exclude<ImportBinKind, null | 'tv'>, ID> = { movies: 'bin-movies', audio: 'bin-audio', graphics: 'bin-graphics' };

/** Create MediaItems for the given paths, add them to the project and probe each one. Returns the new ids. */
export async function importMediaFiles(paths: string[], binId: ID | null = null): Promise<ID[]> {
  return (await importMedia(paths, binId)).added;
}

/**
 * Full import: de-dups paths (within the call and against the project), parses identity / category from the file
 * name, routes items into default bins (Movies / TV › Series › Season / Audio / Graphics) unless `binId` targets a
 * bin, selects the result, probes (marking missing files offline), queues proxies for media the preview cannot
 * decode (when proxies are on) and attaches sidecar subtitles found next to imported videos.
 */
export async function importMedia(paths: string[], binId: ID | null = null, opts: ImportOptions = {}): Promise<ImportReport> {
  const st = useStore.getState();
  const noFfprobe = ffmpegUnavailable('ffprobe');
  if (noFfprobe && paths.length) {
    say('error', `Import failed: ${noFfprobe}`);
    return { added: [], existing: [], subtitlePaths: [], sidecarsUsed: [], binIds: [] };
  }
  const byPath = new Map(Object.values(st.project.media).map((m) => [m.path, m.id] as const));
  const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p))];
  const subtitlePaths = unique.filter((p) => classifyPath(p) === 'subtitle');
  const existing: ID[] = [];
  const fresh: string[] = [];
  for (const p of unique) {
    if (classifyPath(p) === 'subtitle') continue;
    const id = byPath.get(p);
    if (id) existing.push(id); else fresh.push(p);
  }
  const targeted = binId !== null && !!st.project.bins[binId];
  const plans = fresh.map((p) => {
    const cls = classifyPath(p);
    const ident = importIdentity(p, cls);
    const auto = ident.bin && ident.bin !== 'tv' ? DEFAULT_BINS[ident.bin] : null;
    const item: MediaItem = {
      ...createMediaItem(p, fileNameOf(p)),
      identity: ident.identity, category: ident.category,
      binId: targeted ? binId : auto && st.project.bins[auto] ? auto : null,
    };
    return { item, cls, ident };
  });
  const items = plans.map((x) => x.item);
  if (items.length) {
    st.addMedia(items);
    // Episodes → TV › Series › Season (one step per series/season; addMedia already carried the identity).
    if (!targeted) {
      const groups = new Map<string, { series: string; season: number; ids: ID[] }>();
      for (const { item, ident } of plans) {
        if (ident.bin !== 'tv' || !ident.identity.series) continue;
        const season = ident.identity.season ?? 1;
        const key = `${ident.identity.series}\u0000${season}`;
        const g = groups.get(key) ?? { series: ident.identity.series, season, ids: [] };
        g.ids.push(item.id); groups.set(key, g);
      }
      for (const g of groups.values()) useStore.getState().organizeAsSeries(g.ids, g.series, g.season);
    }
  }
  const added = items.map((m) => m.id);
  if (existing.length) say('info', `Already imported: ${existing.length}`);
  if (added.length || existing.length) useStore.getState().selectMedia([...added, ...existing], 'set');
  const media = useStore.getState().project.media;
  const binIds = [...new Set(added.map((id) => media[id]?.binId).filter((b): b is ID => !!b))];

  const report: ImportReport = { added, existing, subtitlePaths, sidecarsUsed: [], binIds };
  for (const l of importListeners) { try { l(report); } catch { /* listener errors must not break import */ } }

  const [, sidecars] = await Promise.all([
    probeImported(plans.map((x) => ({ id: x.item.id, category: x.ident.category, auto: !targeted }))),
    attachSidecars(plans.filter((x) => x.cls === 'video').map((x) => x.item.id), new Set(subtitlePaths)),
  ]);
  report.sidecarsUsed = sidecars;
  if (sidecars.length) say('ok', `Imported ${plural(sidecars.length, 'subtitle file')} found next to the media`);
  const rejected = subtitlePaths.filter((p) => !sidecars.includes(p));
  if (rejected.length && opts.rejectSubtitles !== false) {
    say('warn', `${plural(rejected.length, 'subtitle file')} not imported as media — select the media item and use "Import subtitles…" to attach ${rejected.length === 1 ? 'it' : 'them'}`);
  }
  return report;
}

/** Probe freshly imported items; reclassify audio-only containers; queue proxies for undecodable media (one toast). */
async function probeImported(list: { id: ID; category: string; auto: boolean }[]): Promise<void> {
  if (!list.length) return;
  const needProxy: { id: ID; still: boolean }[] = [];
  await Promise.all(list.map(async ({ id, category, auto }) => {
    const probe = await probeMedia(id);
    if (!probe) return;
    const m = useStore.getState().project.media[id];
    if (!m) return;
    if (m.kind === 'audio' && category === 'Other') {
      useStore.getState().updateMedia(id, { category: 'Music', ...(auto && m.binId === null && useStore.getState().project.bins['bin-audio'] ? { binId: 'bin-audio' } : {}) });
    } else if (m.kind === 'video' && category === 'Other' && probe.duration >= LONG_FORM_MOVIE_SEC) {
      // BUG-3: long-form video without an episode marker is a movie.
      useStore.getState().updateMedia(id, { category: 'Movie', ...(auto && m.binId === null && useStore.getState().project.bins['bin-movies'] ? { binId: 'bin-movies' } : {}) });
    }
    // A still Chromium cannot draw gets its PNG proxy even with proxies off: without it the preview shows nothing.
    const still = isStillImage({ ...m, probe });
    if (mediaNeedsProxyForPreview({ ...m, probe }) && (m.kind === 'video' || m.kind === 'audio' || still) && m.proxy.status === 'none') needProxy.push({ id, still });
  }));
  const useProxies = useStore.getState().project.settings.useProxies;
  const queue = needProxy.filter((x) => x.still || useProxies).map((x) => x.id);
  if (!queue.length) return;
  let started = 0;
  for (const id of queue) {
    try { if (await startProxy(id)) started++; }
    catch (e) { useStore.getState().setProxy(id, { status: 'failed', error: e instanceof Error ? e.message : String(e) }); }
  }
  if (started) say('info', `Generating proxies for ${plural(started, 'file')} the preview can't decode`);
}

const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : p; };

/** Look for `<base>.srt|vtt` / `<base>.<lang>.srt|vtt` next to each video (one listDir per folder). Returns attached paths. */
async function attachSidecars(videoIds: ID[], alsoKnown: Set<string>): Promise<string[]> {
  const api = recutApi();
  if (!api || !videoIds.length) return [];
  const byDir = new Map<string, ID[]>();
  for (const id of videoIds) {
    const m = useStore.getState().project.media[id];
    if (!m) continue;
    const d = dirOf(m.path);
    byDir.set(d, [...(byDir.get(d) ?? []), id]);
  }
  const used: string[] = [];
  for (const [dir, ids] of byDir) {
    let entries: { name: string; path: string; isDirectory: boolean }[] = [];
    try { entries = (await api.listDir(dir)).filter((e) => !e.isDirectory && /\.(srt|vtt)$/i.test(e.name)); } catch { entries = []; }
    // Subtitle paths passed in the same import call that live in this folder are candidates too.
    for (const p of alsoKnown) if (dirOf(p) === dir && !entries.some((e) => e.path === p)) entries.push({ name: fileNameOf(p), path: p, isDirectory: false });
    if (!entries.length) continue;
    for (const id of ids) {
      const m = useStore.getState().project.media[id];
      if (!m) continue;
      const already = new Set(m.subtitleTrackIds.map((t) => useStore.getState().project.subtitleTracks[t]?.path).filter(Boolean));
      for (const e of entries) {
        const lang = sidecarLanguage(fileNameOf(m.path), e.name);
        if (lang === null || already.has(e.path)) continue;
        try { const r = await importSubtitleFile(id, e.path, lang); if (r.trackId) used.push(e.path); } catch { /* unreadable sidecar: skip */ }
      }
    }
  }
  return used;
}

/** Probe one media item. Missing files are flagged offline (so Relink offers them); a good probe clears offline. */
export async function probeMedia(mediaId: ID): Promise<MediaProbe | null> {
  const api = recutApi();
  const m = useStore.getState().project.media[mediaId];
  if (!api || !m) return null;
  try {
    const probe = await api.probe(m.path);
    useStore.getState().setMediaProbe(mediaId, probe);
    if (useStore.getState().project.media[mediaId]?.offline) useStore.getState().setOffline(mediaId, false);
    return probe;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    useStore.getState().setMediaProbe(mediaId, { error });
    let missing = /not found|ENOENT|no such file/i.test(error);
    try { const s = await api.stat(m.path); missing = !s.exists; } catch { /* keep the message-based guess */ }
    if (!!useStore.getState().project.media[mediaId]?.offline !== missing) useStore.getState().setOffline(mediaId, missing);
    return null;
  }
}

/** Re-check that each media file still exists; marks offline accordingly. Also drops `ready` proxies whose file is gone. */
export async function verifyMediaOnline(mediaIds?: ID[]): Promise<ID[]> {
  const api = recutApi();
  if (!api) return [];
  const st = useStore.getState();
  const ids = mediaIds ?? Object.keys(st.project.media);
  const missing: ID[] = [];
  for (const id of ids) {
    const m = st.project.media[id];
    if (!m) continue;
    const s = await api.stat(m.path);
    if (!s.exists) missing.push(id);
    if (!s.exists !== m.offline) useStore.getState().setOffline(id, !s.exists);
  }
  await verifyProxies(ids);
  return missing;
}

/** Stat every `ready` proxy; a missing proxy file resets the item to `none` (so it shows as needing a proxy again). */
export async function verifyProxies(mediaIds?: ID[]): Promise<ID[]> {
  const api = recutApi();
  if (!api) return [];
  const media = useStore.getState().project.media;
  const gone: ID[] = [];
  for (const id of mediaIds ?? Object.keys(media)) {
    const m = media[id];
    if (!m || m.proxy.status !== 'ready' || !m.proxy.path) continue;
    let exists = true;
    try { exists = (await api.stat(m.proxy.path)).exists; } catch { /* leave as is */ }
    if (exists) continue;
    gone.push(id);
    useStore.getState().setProxy(id, { status: 'none' });
  }
  if (gone.length) say('warn', `${plural(gone.length, 'proxy file')} ${gone.length === 1 ? 'is' : 'are'} missing — regenerate in Jobs › Proxies`);
  return gone;
}

export async function startProxy(mediaId: ID): Promise<JobInfo | null> {
  const api = recutApi();
  const st = useStore.getState();
  const m = st.project.media[mediaId];
  if (!api || !m) return null;
  const noFfmpeg = ffmpegUnavailable('ffmpeg', 'ffprobe');
  if (noFfmpeg) throw new Error(noFfmpeg);
  // A proxy carries every audio stream (electron/media/proxy.ts), so it is not tied to one. `audioStream` is the one a
  // fallback proxy keeps when FFmpeg cannot proxy every stream: the preferred stream (Source Monitor, new clips).
  st.setProxy(mediaId, { status: 'queued', progress: 0 });
  return api.startProxy({ mediaId, path: m.path, height: st.project.settings.proxyHeight, ...(m.preferredAudioStream !== undefined ? { audioStream: m.preferredAudioStream } : {}) });
}

/** Queue a proxy when proxies are on and the preview cannot decode the original (errors mark the proxy failed). */
function requeueProxyIfNeeded(mediaId: ID): void {
  const st = useStore.getState();
  const m = st.project.media[mediaId];
  if (!m || m.proxy.status !== 'none' || !st.project.settings.useProxies || !mediaNeedsProxyForPreview(m)) return;
  startProxy(mediaId).catch((e) => useStore.getState().setProxy(mediaId, { status: 'failed', error: e instanceof Error ? e.message : String(e) }));
}

/**
 * Audio streams the preview needs from a media item: its preferred stream (Source Monitor, new clips) and the stream
 * of each of its audio clips in every sequence (`clip.audioStream ?? media.preferredAudioStream`, as export reads it).
 */
export function wantedAudioStreams(project: Project, mediaId: ID): (number | undefined)[] {
  const m = project.media[mediaId];
  const out = new Set<number | undefined>([m?.preferredAudioStream]);
  for (const seq of Object.values(project.sequences)) {
    for (const t of seq.audioTracks) for (const c of t.clips) if (c.mediaId === mediaId && c.kind === 'audio') out.add(c.audioStream ?? m?.preferredAudioStream);
  }
  return [...out];
}

/**
 * The media's proxy lacks an audio stream the preview needs (an older single-stream proxy; see wantedAudioStreams):
 * mark it stale (status 'none') and requeue it when proxies are on and the media needs one. Returns true when the
 * proxy was stale.
 */
export function requeueStaleProxy(mediaId: ID): boolean {
  const project = useStore.getState().project;
  const m = project.media[mediaId];
  if (!m || !proxyStreamStale(m, wantedAudioStreams(project, mediaId))) return false;
  useStore.getState().setProxy(mediaId, { status: 'none' });
  requeueProxyIfNeeded(mediaId);
  return true;
}

/** Change the media's preferred audio stream; a proxy carrying another stream goes stale and is rebuilt if needed. */
export function setMediaAudioStream(mediaId: ID, stream: number | undefined): void {
  const st = useStore.getState();
  const before = st.project.media[mediaId];
  if (!before || before.preferredAudioStream === stream) return;
  const hadProxy = before.proxy.status !== 'none';
  st.updateMedia(mediaId, { preferredAudioStream: stream }); // marks a stale proxy 'none'
  if (hadProxy && useStore.getState().project.media[mediaId]?.proxy.status === 'none') requeueProxyIfNeeded(mediaId);
}

/**
 * Change the audio stream of audio clips (one undo step; undefined = follow the media's preferred stream). A proxy
 * lacking the stream goes stale and is rebuilt (carrying every stream) when the media needs one.
 */
export function setClipsAudioStream(seqId: ID, clipIds: ID[], index: number | undefined): void {
  const st = useStore.getState();
  const before = st.project.media;
  st.setClipAudioStream(seqId, clipIds, index); // marks a stale proxy 'none'
  const after = useStore.getState().project.media;
  for (const id of Object.keys(after)) {
    if (before[id] && before[id].proxy.status !== 'none' && after[id].proxy.status === 'none') requeueProxyIfNeeded(id);
  }
}

export async function startSceneDetect(mediaId: ID, threshold?: number): Promise<JobInfo | null> {
  const api = recutApi();
  const st = useStore.getState();
  const m = st.project.media[mediaId];
  if (!api || !m) return null;
  st.setSceneDetectStatus(mediaId, 'running');
  return api.startSceneDetect({ mediaId, path: m.path, threshold: threshold ?? st.project.settings.sceneThreshold, duration: m.probe?.duration ?? 0 });
}

/** Read an .srt/.vtt file and attach it to a media item as a subtitle track. Returns parse warnings. */
export async function importSubtitleFile(mediaId: ID, path: string, language = 'und'): Promise<{ trackId: ID | null; warnings: string[] }> {
  const api = recutApi();
  if (!api) return { trackId: null, warnings: ['IPC unavailable'] };
  const text = await api.readText(path);
  const parsed = parseSubtitles(text);
  if (parsed.cues.length === 0) return { trackId: null, warnings: parsed.warnings };
  const track: SubtitleTrack = { id: uid('sub'), name: fileNameOf(path), language, path, mediaId, cues: parsed.cues, origin: parsed.format === 'unknown' ? 'srt' : parsed.format };
  useStore.getState().addMediaSubtitleTrack(track);
  return { trackId: track.id, warnings: parsed.warnings };
}

/** Extract an embedded text subtitle stream and attach it to the media item. */
export async function importEmbeddedSubtitles(mediaId: ID, streamIndex: number): Promise<{ trackId: ID | null; warnings: string[] }> {
  const api = recutApi();
  const m = useStore.getState().project.media[mediaId];
  if (!api || !m) return { trackId: null, warnings: ['IPC unavailable'] };
  const srt = await api.extractSubtitles(m.path, streamIndex);
  const parsed = parseSubtitles(srt);
  if (parsed.cues.length === 0) return { trackId: null, warnings: parsed.warnings };
  const info = m.probe?.subtitles.find((s) => s.index === streamIndex);
  const language = info?.language ?? 'und';
  const track: SubtitleTrack = { id: uid('sub'), name: info?.title ?? `${language} (embedded)`, language, mediaId, cues: parsed.cues, origin: 'srt' };
  useStore.getState().addMediaSubtitleTrack(track);
  return { trackId: track.id, warnings: parsed.warnings };
}

// ------------------------------------------------------------------
// Project I/O
// ------------------------------------------------------------------

/** Longest stretch of project serialization / parsing run before yielding to the event loop (under the 50 ms long-task mark). */
const SLICE_MS = 25;

/** Resolve in a new task (a MessageChannel message: not clamped like nested setTimeout, not throttled when hidden). */
function nextTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); r(); };
    ch.port2.postMessage(null);
  });
}

/** A pause function that yields a task once SLICE_MS have passed since the last yield (else resolves at once). */
function slicer(): () => Promise<void> | void {
  let since = performance.now();
  return () => {
    if (performance.now() - since < SLICE_MS) return;
    return nextTask().then(() => { since = performance.now(); });
  };
}

/**
 * Upper bound (ms) an idle slice of background serialization waits for idle time before it runs anyway (a full
 * SLICE_MS slice then): a window that never idles (playback while the CPU is busy) still finishes the autosave,
 * at most one slice per IDLE_TIMEOUT_MS.
 */
const IDLE_TIMEOUT_MS = 100;
type IdleDeadlineLike = { didTimeout: boolean; timeRemaining(): number };
type RequestIdle = (cb: (d: IdleDeadlineLike) => void, o?: { timeout: number }) => number;

/**
 * slicer() for background work (autosaves): after a slice it resumes in the next idle period (requestIdleCallback),
 * for the idle time the browser offers there (at most SLICE_MS), or SLICE_MS when IDLE_TIMEOUT_MS passed without
 * idle time. Edits, input and frames do not queue behind back-to-back slices: while the user edits it runs in the
 * gaps. Where there is no requestIdleCallback (node / vitest) it is slicer().
 */
function idleSlicer(): () => Promise<void> | void {
  const ric = (globalThis as { requestIdleCallback?: RequestIdle }).requestIdleCallback;
  if (typeof ric !== 'function') return slicer();
  let since = performance.now();
  let budget = SLICE_MS;
  return () => {
    if (performance.now() - since < budget) return;
    return new Promise<void>((resolve) => {
      ric((d) => {
        since = performance.now();
        budget = d.didTimeout ? SLICE_MS : Math.min(SLICE_MS, Math.max(1, d.timeRemaining()));
        resolve(); // the slice runs in this idle callback's microtask checkpoint
      }, { timeout: IDLE_TIMEOUT_MS });
    });
  };
}

/** UTF-16 code units of file text gathered before they are handed on as one piece (a streamed save sends each). */
const PIECE_CHARS = 1 << 20;

/**
 * Serialize `project` in the project file layout (projectJsonChunks) in slices of about SLICE_MS, yielding between
 * them, so saving a large project never blocks the window for the whole serialization. The text is handed to `emit` in order, in pieces of about PIECE_CHARS
 * cut between records (never inside a JSON string, so each piece is well-formed UTF-16 on its own); the pieces
 * concatenated are the whole text. `emit` may return a promise, which is awaited before serialization goes on.
 */
async function serializeInPieces(project: Project, emit: (text: string) => void | Promise<void>): Promise<void> {
  const out: string[] = [];
  const it = projectJsonChunks(project, out);
  const pause = slicer();
  let counted = 0;
  let chars = 0;
  for (;;) {
    const done = it.next().done;
    for (; counted < out.length; counted++) chars += out[counted].length;
    if (done || chars >= PIECE_CHARS) {
      const text = out.join('');
      out.length = 0; counted = 0; chars = 0;
      const p = emit(text);
      if (p) await p;
      if (done) return;
    }
    const p = pause();
    if (p) await p;
  }
}

/**
 * The project text, serialized in slices. `compact`: the same text as JSON.stringify (autosaves,
 * serializeCompactInPieces); otherwise the project file layout (serializeProject, serializeInPieces).
 */
export async function serializeProjectSliced(project: Project, compact = false): Promise<string> {
  const pieces: string[] = [];
  const emit = (text: string) => { pieces.push(text); };
  await (compact ? serializeCompactInPieces(project, emit) : serializeInPieces(project, emit));
  return pieces.join('');
}

/**
 * Where the compact serializer may yield: these containers are written part by part (the entries of a record,
 * the items of an array, the fields of an object, each laid out by the nested split); other values in one native
 * JSON.stringify, except arrays longer than LONG_ARRAY (clips, cues, markers, ...), written item by item. The
 * clock is checked after every part, so the longest stretch without a yield is one record (a clip, a cue) or one
 * short array. `cached`: a value whose text is kept for the next autosave when it is frozen (compactJsonCache),
 * laid out by the inner split when it has to be written.
 */
type CompactSplit = { entries: CompactSplit | null } | { fields: Record<string, CompactSplit> } | { items: CompactSplit | null } | { cached: CompactSplit };
/** Arrays longer than this are written item by item (yielding between items) instead of in one JSON.stringify. */
const LONG_ARRAY = 64;
const RECORD: CompactSplit = { fields: {} };
const CACHED: CompactSplit = { cached: RECORD };
const TRACKS: CompactSplit = { items: CACHED };
const SNAPSHOT_SPLIT: CompactSplit = { fields: { data: { fields: { videoTracks: TRACKS, audioTracks: TRACKS } } } };
const SEQUENCE_SPLIT: CompactSplit = { fields: { videoTracks: TRACKS, audioTracks: TRACKS, snapshots: { items: SNAPSHOT_SPLIT } } };
const PROJECT_SPLIT: CompactSplit = {
  fields: { media: { entries: CACHED }, sequences: { entries: SEQUENCE_SPLIT }, scenes: { entries: CACHED }, subtitleTracks: { entries: CACHED } },
};

/**
 * JSON text of frozen tracks / media items / scenes / subtitle tracks from earlier autosaves, by identity. The
 * store's project is immutable and frozen all the way down once committed (src/state/store.ts), so a frozen
 * value's text never changes, and an edit replaces the objects it changes: an autosave serializes only what
 * changed since the last one (typically one sequence's tracks of a 25 MB project) and copies the rest. Values
 * that are not frozen (a project just opened, before its idle freeze) are serialized every time. A sequence's
 * view (a mutable LiveView) is never part of a cached value. Entries go away with their objects.
 */
const compactJsonCache = new WeakMap<object, string>();

/** A plain object or array without toJSON: JSON.stringify writes it from its own enumerable properties. */
function isPlainContainer(v: unknown): v is object {
  if (v === null || typeof v !== 'object' || typeof (v as { toJSON?: unknown }).toJSON === 'function') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * JSON of `v` as the value of `key` inside its parent, exactly as JSON.stringify of the whole writes it;
 * undefined when JSON omits it (undefined, a function, a symbol). A value with toJSON (a Date, never in a
 * project) is written through a one-key wrapper, so its toJSON gets the key as it would in the whole.
 */
function compactValue(key: string, v: unknown): string | undefined {
  const t = typeof v;
  if ((t === 'object' && v !== null) || t === 'bigint') {
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      const w = JSON.stringify({ [key]: v });
      return w.length === 2 ? undefined : w.slice(JSON.stringify(key).length + 2, -1);
    }
  }
  return JSON.stringify(v);
}

/**
 * The compact text of `project`, exactly JSON.stringify(project) (the autosave bytes), handed to `emit` in
 * pieces of about PIECE_CHARS cut between values (never inside a JSON string, so each piece is well-formed
 * UTF-16), yielding once SLICE_MS have passed. Values are serialized by the native JSON.stringify, several times
 * faster than the record-by-record file layout of projectJsonChunks; PROJECT_SPLIT says which containers are
 * written part by part, so no single task holds the whole project, and which frozen values reuse their text from
 * an earlier autosave (compactJsonCache). `pause` yields between parts (slicer, or idleSlicer for autosaves).
 */
async function serializeCompactInPieces(project: Project, emit: (text: string) => void | Promise<void>, pause = slicer()): Promise<void> {
  /** Where text goes: the pieces handed to `emit`, or a value's own text being built for the cache. */
  interface Sink { push(s: string): void; step(): Promise<void> }
  let out: string[] = [];
  let chars = 0;
  const main: Sink = {
    push: (s) => { out.push(s); chars += s.length; },
    step: async () => {
      if (chars >= PIECE_CHARS) {
        const text = out.join('');
        out = []; chars = 0;
        const p = emit(text);
        if (p) await p;
      }
      const p = pause();
      if (p) await p;
    },
  };
  const longArray = (v: unknown): boolean => Array.isArray(v) && v.length > LONG_ARRAY && isPlainContainer(v);
  /** JSON of `v` (the value of `key`) laid out by `split`, pushed to `to`; false (nothing pushed) when JSON omits it. */
  const write = async (to: Sink, key: string, v: unknown, split: CompactSplit | null): Promise<boolean> => {
    if (split !== null && 'cached' in split && isPlainContainer(v)) {
      let s = Object.isFrozen(v) ? compactJsonCache.get(v) : undefined;
      if (s === undefined) {
        const own: string[] = [];
        await write({ push: (x) => { own.push(x); }, step: async () => { const p = pause(); if (p) await p; } }, key, v, split.cached);
        s = own.join('');
        if (Object.isFrozen(v)) compactJsonCache.set(v, s);
      }
      to.push(s);
      return true;
    }
    const asItems = split !== null && 'items' in split;
    if (!isPlainContainer(v) || (split === null || 'cached' in split || asItems !== Array.isArray(v) ? !longArray(v) : false)) {
      const s = compactValue(key, v);
      if (s === undefined) return false;
      to.push(s);
      return true;
    }
    if (Array.isArray(v)) {
      const itemSplit = asItems ? (split as { items: CompactSplit | null }).items : null;
      to.push('[');
      for (let i = 0; i < v.length; i++) {
        if (i) to.push(',');
        if (!(await write(to, String(i), v[i], itemSplit))) to.push('null'); // JSON writes an omitted item as null
        await to.step();
      }
      to.push(']');
      return true;
    }
    const rec = v as Record<string, unknown>;
    const sp = split as { entries: CompactSplit | null } | { fields: Record<string, CompactSplit> };
    let sep = '{';
    for (const k of Object.keys(rec)) {
      const sub = 'entries' in sp ? sp.entries : (Object.hasOwn(sp.fields, k) ? sp.fields[k] : null);
      const x = rec[k];
      // Only a value written by compactValue can be omitted: decide that before the key is pushed.
      if (!isPlainContainer(x) || (sub === null && !longArray(x))) {
        const s = compactValue(k, x);
        if (s === undefined) continue;
        to.push(sep + JSON.stringify(k) + ':' + s);
      } else {
        to.push(sep + JSON.stringify(k) + ':');
        await write(to, k, x, sub);
      }
      sep = ',';
      await to.step();
    }
    to.push(sep === '{' ? '{}' : '}');
    return true;
  };
  const whole = await write(main, '', project, PROJECT_SPLIT);
  if (!whole) throw new TypeError('the project is not serializable');
  const text = out.join('');
  if (text) { const p = emit(text); if (p) await p; }
}

/** One streamed write to main: a manual save (ProjectSaveStreamApi) or an autosave (ProjectAutosaveStreamApi). */
interface SaveStream {
  begin(): Promise<SaveBeginResult>;
  chunk(id: string, seq: number, text: string): void;
  commit(id: string, totals: { chunks: number; chars: number }): Promise<SaveResult>;
  abort(id: string): Promise<void> | void;
}

/**
 * Write by streaming the text to main while `serialize` produces it: each piece is sent as soon as it is
 * written, and main encodes and appends it to a temp file while the next piece is serialized; only the commit
 * makes it the file. Measured on a 31 MB project (2,500-clip project plus a 3 h, 6,700-clip sequence), sending
 * the text as one string spent about 50 ms in the renderer on the IPC send (one long task), 70 ms in main
 * receiving it and 60 ms encoding it, all after the serialization; streamed, those costs overlap the
 * serialization of the next piece, and only the last piece, the fsync and the rename follow it.
 */
async function writeStreamed(s: SaveStream, serialize: (emit: (text: string) => Promise<void>) => Promise<void>): Promise<SaveResult> {
  const begun = s.begin(); // main opens the temp file while the first slice is serialized
  begun.catch(() => undefined); // a rejection is handled where it is awaited (first piece / failure below)
  let id: string | null = null;
  let chunks = 0;
  let chars = 0;
  try {
    await serialize(async (text) => {
      if (id === null) {
        const b = await begun;
        if (!b.ok) throw new SaveRefused(b);
        id = b.id;
      }
      s.chunk(id, chunks++, text);
      chars += text.length;
    });
  } catch (e) {
    if (e instanceof SaveRefused) return e.result;
    // Drop the temp file in main, also when the failure came before the first piece was sent.
    const opened = id ?? (await begun.then((b) => (b.ok ? b.id : null), () => null));
    if (opened !== null) await Promise.resolve(s.abort(opened)).catch(() => undefined);
    throw e;
  }
  return s.commit(id!, { chunks, chars });
}

/** Save by streaming the project file text (the serializeProject layout) to main while it is serialized. */
function saveStreamed(api: ProjectSaveStreamApi, target: string, project: Project): Promise<SaveResult> {
  return writeStreamed({
    begin: () => api.saveProjectBegin(target),
    chunk: (id, seq, text) => api.saveProjectChunk(id, seq, text),
    commit: (id, totals) => api.saveProjectCommit(id, totals),
    abort: (id) => api.saveProjectAbort(id),
  }, (emit) => serializeInPieces(project, emit));
}

/**
 * Autosave by streaming the compact text (serializeCompactInPieces) to main while it is serialized. Background
 * work: in idle slices (idleSlicer), so edits never queue behind it; while playing (the window renders every
 * frame and is rarely idle; the lifecycle defers autosaves then, a forced one still runs) in task slices between
 * the frames (slicer).
 */
function autosaveStreamed(api: ProjectAutosaveStreamApi, projectPath: string | null, project: Project, playing: boolean): Promise<SaveResult> {
  return writeStreamed({
    begin: () => api.autosaveProjectBegin(projectPath),
    chunk: (id, seq, text) => api.saveProjectChunk(id, seq, text),
    commit: (id, totals) => api.autosaveProjectCommit(projectPath, id, totals),
    abort: (id) => api.saveProjectAbort(id),
  }, (emit) => serializeCompactInPieces(project, emit, playing ? slicer() : idleSlicer()));
}

/** Main refused to start a streamed save (bad path, no permission): stops the serialization, reported as is. */
class SaveRefused {
  constructor(readonly result: SaveResult & { ok: false }) {}
}

/** The save in progress (or a settled promise): saves run one at a time, so their writes land in order. */
let saveQueue: Promise<unknown> = Promise.resolve();

/**
 * Save the project to `path` (default: its current path). Saves are queued: each one snapshots the project when its
 * turn comes, so a save pressed twice writes the newest content last. The project is marked saved only at the
 * revision that was written: edits committed during the serialization slices / IPC write keep it dirty.
 */
export function saveProject(path?: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const run = saveQueue.then(() => saveNow(path));
  saveQueue = run.catch(() => undefined);
  return run;
}

/**
 * The project as written, stamped with modifiedAt: what serializeForSave returns (same keys, same order), as a
 * shallow copy. serializeForSave runs immer's produce, which deep-freezes a project that is not frozen yet: right
 * after an open (loadProjectData stores the decoded project as is) that froze a 31 MB project in one ~370 ms task
 * before the save could start.
 */
function projectToSave(project: Project): Project {
  return { ...project, modifiedAt: Date.now() };
}

async function saveNow(path?: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const api = recutApi();
  if (!api) return { ok: false, error: 'IPC unavailable' };
  const st = useStore.getState();
  const target = path ?? st.projectPath;
  if (!target) return { ok: false, error: 'No project path' };
  const revision = st.revision;
  const project = projectToSave(st.project);
  // Serialize here, in slices, and send text (P-06): a structured clone of the whole project across IPC cost more
  // than the serialization, and main then pretty-printed it again on its own thread. Streamed when the bridge
  // can (saveStreamed); else one string.
  const res = canStreamSave(api) ? await saveStreamed(api, target, project)
    : typeof api.saveProjectJson === 'function' ? await api.saveProjectJson(target, await serializeProjectSliced(project))
      : await api.saveProject(target, project);
  if (res.ok) {
    useStore.getState().markSaved(res.path, revision);
    const after = useStore.getState();
    // Edits made while the save ran keep the project dirty: make sure an autosave newer than this file holds them.
    if (after.dirty && after.revision !== revision && after.loadedRevision <= revision) autosaveAfterSave(after.project.id, after.loadedRevision);
  }
  return res;
}

/**
 * How long after a save that left edits unsaved the follow-up autosave runs. Startup recovery offers an autosave
 * only when it is more than a second newer than its project file (electron/project/io.ts checkRecovery), and FAT
 * volumes keep modification times to 2 s: the lifecycle's autosave debounce (src/app/project.ts) clears both.
 */
export const AUTOSAVE_AFTER_SAVE_MS = 5000;
/** An autosave that finished this long after the save is newer than the project file for recovery (see above). */
const RECOVERY_NEWER_MS = 3000;

let afterSaveTimer: ReturnType<typeof setTimeout> | null = null;

const autosaveDirectly = () => { autosaveProject().catch((e: unknown) => { console.warn('[autosave] after save failed', e); }); };
/** How the follow-up autosave is started: the app lifecycle routes it through its own schedule (setAutosaveRequester). */
let requestAutosave: () => void = autosaveDirectly;

/**
 * Let the app lifecycle start the follow-up autosave (autosaveAfterSave) through its own schedule, e.g. its idle
 * callback and autosave gate (src/app/autosaveGate.ts: only in a pause of the user's work), instead of directly.
 * Returns a function that restores the direct autosave.
 */
export function setAutosaveRequester(fn: () => void): () => void {
  requestAutosave = fn;
  return () => { if (requestAutosave === fn) requestAutosave = autosaveDirectly; };
}
/** When the last autosave finished writing (Date.now()); 0 before the first. */
let lastAutosaveDoneAt = 0;

/**
 * An edit made while a manual save was in flight stays dirty (markSaved), and its debounced autosave may have
 * landed before the save's write: recovery then takes that autosave for older than the project file and ignores
 * it, and the lifecycle would only autosave again on its interval tick (60 s by default). Autosave once more
 * AUTOSAVE_AFTER_SAVE_MS after such a save, unless an autosave finished since (bugs/closed/
 * 2026-10-06-autosave-during-save-ignored-by-recovery.md). Never while playing or mid-drag (the lifecycle's rule):
 * it waits for those to end. Dropped when the project is saved, replaced or opened meanwhile.
 */
function autosaveAfterSave(projectId: ID, loadedRevision: number): void {
  if (afterSaveTimer !== null) clearTimeout(afterSaveTimer);
  const savedAt = Date.now();
  const fire = () => {
    afterSaveTimer = null;
    const st = useStore.getState();
    if (!st.dirty || st.project.id !== projectId || st.loadedRevision !== loadedRevision) return;
    if (lastAutosaveDoneAt - savedAt >= RECOVERY_NEWER_MS) return; // a later autosave already holds the edits
    if (st.playback.playing || st.transaction) { afterSaveTimer = setTimeout(fire, AUTOSAVE_AFTER_SAVE_MS); return; }
    requestAutosave();
  };
  afterSaveTimer = setTimeout(fire, AUTOSAVE_AFTER_SAVE_MS);
}

/** The name a still-untitled project takes from its file (`/a/My Edit.recut` -> `My Edit`). */
export const DEFAULT_PROJECT_NAME = 'Untitled Project';
export function projectNameFromPath(p: string): string {
  return fileNameOf(p).replace(/\.recut$/i, '').trim();
}

/** Warning text for a load that had to repair damaged data (LoadResult.repaired / preRepairPath). */
export function repairedMessage(repaired: string[], preRepairPath?: string): string {
  const n = repaired.length;
  const what = `${repaired.slice(0, 3).join('; ')}${n > 3 ? `; and ${n - 3} more` : ''}`;
  const kept = preRepairPath ? `The original file was kept as ${fileNameOf(preRepairPath)}.` : 'Could not keep a copy of the original file.';
  return `Some project data was damaged and has been repaired (${what}). ${kept}`;
}

/**
 * The project of a load / recovery reply, normalized exactly once: a `projectWire` was normalized by main and is
 * only decoded (parsed piece by piece, yielding between pieces); a plain `project` object (older bridge, test
 * double) is normalized here.
 */
export async function projectFromReply(res: { project: Project } | { projectWire: unknown }): Promise<Project> {
  if ('projectWire' in res) {
    if (!isProjectWire(res.projectWire)) throw new Error('Could not open project: unexpected reply from the main process');
    return decodeProjectWire(res.projectWire, slicer());
  }
  return normalizeProject(res.project);
}

/** How open reports what happened: kind, text and (optionally) how long the message stays up. */
export type OpenNotify = (kind: 'ok' | 'warn', text: string, timeoutMs?: number) => void;

/**
 * Load the project at `path` into the store: the one open path behind both `actions.openProject` and the
 * File › Open / recent / OS open requests (src/app/project.ts requestOpenProject). Normalizes the data, gives a
 * still-untitled project its file name, and warns when the backup was opened or the data had to be repaired.
 * `warned` is true when a warning was shown (callers skip their success message then).
 */
export async function openProject(path: string, opts: { notify?: OpenNotify } = {}): Promise<{ ok: true; project: Project; path: string; warned: boolean } | { ok: false; error: string }> {
  const api = recutApi();
  if (!api) return { ok: false, error: 'IPC unavailable' };
  const notify: OpenNotify = opts.notify ?? ((kind, text) => say(kind, text));
  const res = await api.loadProject(path);
  if (!res.ok) return res;
  try {
    let project = await projectFromReply(res);
    if (project.name === DEFAULT_PROJECT_NAME) {
      const name = projectNameFromPath(res.path);
      if (name) project = { ...project, name };
    }
    // The store load and the render it causes run in a task of their own, not behind the last decode slice.
    await nextTask();
    useStore.getState().loadProjectData(project, res.path);
    let warned = false;
    // BUG-5: tell the user the newest edits were lost.
    if (res.fromBackup) {
      const when = res.backupMtime ? new Date(res.backupMtime).toLocaleString() : 'an earlier save';
      notify('warn', `Opened the backup from ${when}; the project file was damaged`);
      warned = true;
    }
    if (res.repaired?.length) {
      notify('warn', repairedMessage(res.repaired, res.preRepairPath), 12000);
      warned = true;
    }
    return { ok: true, project, path: res.path, warned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The autosave in progress (or a settled promise): autosaves run one at a time, so the newest content lands last. */
let autosaveQueue: Promise<unknown> = Promise.resolve();

/**
 * Autosave the dirty project: compact JSON, the same bytes as the main process's serializeAutosave. Streamed to
 * main while it is serialized in slices when the bridge can (ProjectAutosaveStreamApi: the IPC copies, encoding
 * and disk writes overlap the serialization, and no task holds the whole project); else one string through
 * autosaveProjectJson (P-06), else a structured clone through autosaveProject on older bridges. Autosaves are
 * queued like saves; each snapshots the project when its turn comes. Throws when the write failed.
 */
export function autosaveProject(): Promise<void> {
  const run = autosaveQueue.then(() => autosaveNow());
  autosaveQueue = run.catch(() => undefined);
  return run;
}

async function autosaveNow(): Promise<void> {
  const api = recutApi();
  const st = useStore.getState();
  if (!api || !st.dirty) return;
  const project = projectToSave(st.project);
  const res = canStreamAutosave(api) ? await autosaveStreamed(api, st.projectPath, project, st.playback.playing)
    : typeof api.autosaveProjectJson === 'function' ? await api.autosaveProjectJson(st.projectPath, JSON.stringify(project))
      : await api.autosaveProject(st.projectPath, project);
  if (res && res.ok === false) throw new Error(res.error);
  lastAutosaveDoneAt = Date.now();
}
