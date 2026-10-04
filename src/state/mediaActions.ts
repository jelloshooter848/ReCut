/**
 * Thin async wrappers around `window.recut` (IPC) that feed results into the store.
 * Every access to `window.recut` is guarded so this module is importable under vitest/node.
 */
import type { ID, JobInfo, MediaItem, MediaProbe, Project, SubtitleTrack } from '../../shared/model';
import type { RecutApi } from '../../shared/ipc';
import { createMediaItem, normalizeProject } from '../../shared/project';
import { parseSubtitles } from '../../shared/subtitles';
import { uid } from '../../shared/ids';
import { useStore, serializeForSave } from './store';
import { fileNameOf } from './selectors';
import { classifyPath, importIdentity, sidecarLanguage, LONG_FORM_MOVIE_SEC, type ImportBinKind } from './parseIdentity';
import { mediaNeedsProxyForPreview } from '../playback/mediaSource';

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
  const needProxy: ID[] = [];
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
    if (mediaNeedsProxyForPreview({ ...m, probe }) && (m.kind === 'video' || m.kind === 'audio') && m.proxy.status === 'none') needProxy.push(id);
  }));
  if (!needProxy.length || !useStore.getState().project.settings.useProxies) return;
  let started = 0;
  for (const id of needProxy) {
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
  st.setProxy(mediaId, { status: 'queued', progress: 0 });
  return api.startProxy({ mediaId, path: m.path, height: st.project.settings.proxyHeight, audioStream: m.preferredAudioStream });
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

export async function saveProject(path?: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const api = recutApi();
  if (!api) return { ok: false, error: 'IPC unavailable' };
  const st = useStore.getState();
  const target = path ?? st.projectPath;
  if (!target) return { ok: false, error: 'No project path' };
  const res = await api.saveProject(target, serializeForSave(st));
  if (res.ok) useStore.getState().markSaved(res.path);
  return res;
}

export async function openProject(path: string): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
  const api = recutApi();
  if (!api) return { ok: false, error: 'IPC unavailable' };
  const res = await api.loadProject(path);
  if (!res.ok) return res;
  try {
    const project = normalizeProject(res.project);
    useStore.getState().loadProjectData(project, res.path);
    // BUG-5: tell the user the newest edits were lost (same wording as requestOpenProject, which does not call this).
    if (res.fromBackup) {
      const when = res.backupMtime ? new Date(res.backupMtime).toLocaleString() : 'an earlier save';
      say('warn', `Opened the backup from ${when}; the project file was damaged`);
    }
    return { ok: true, project };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function autosaveProject(): Promise<void> {
  const api = recutApi();
  const st = useStore.getState();
  if (!api || !st.dirty) return;
  await api.autosaveProject(st.projectPath, serializeForSave(st));
}
