/**
 * Thin async wrappers around `window.recut` (IPC) that feed results into the store.
 * Every access to `window.recut` is guarded so this module is importable under vitest/node.
 */
import type { ID, JobInfo, MediaItem, Project, SubtitleTrack } from '../../shared/model';
import type { RecutApi } from '../../shared/ipc';
import { createMediaItem, normalizeProject } from '../../shared/project';
import { parseSubtitles } from '../../shared/subtitles';
import { uid } from '../../shared/ids';
import { useStore, serializeForSave } from './store';
import { fileNameOf } from './selectors';

export function recutApi(): RecutApi | null {
  return typeof window !== 'undefined' && window.recut ? window.recut : null;
}

/** Create MediaItems for the given paths, add them to the project and probe each one. */
export async function importMediaFiles(paths: string[], binId: ID | null = null): Promise<ID[]> {
  const existing = new Set(Object.values(useStore.getState().project.media).map((m) => m.path));
  const items: MediaItem[] = paths.filter((p) => !existing.has(p)).map((p) => ({ ...createMediaItem(p, fileNameOf(p)), binId }));
  if (items.length === 0) return [];
  useStore.getState().addMedia(items);
  await Promise.all(items.map((m) => probeMedia(m.id)));
  return items.map((m) => m.id);
}

export async function probeMedia(mediaId: ID): Promise<void> {
  const api = recutApi();
  const m = useStore.getState().project.media[mediaId];
  if (!api || !m) return;
  try {
    const probe = await api.probe(m.path);
    useStore.getState().setMediaProbe(mediaId, probe);
  } catch (e) {
    useStore.getState().setMediaProbe(mediaId, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Re-check that each media file still exists; marks offline accordingly. */
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
  return missing;
}

export async function startProxy(mediaId: ID): Promise<JobInfo | null> {
  const api = recutApi();
  const st = useStore.getState();
  const m = st.project.media[mediaId];
  if (!api || !m) return null;
  st.setProxy(mediaId, { status: 'queued', progress: 0 });
  return api.startProxy({ mediaId, path: m.path, height: st.project.settings.proxyHeight });
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

/** Subscribe the store's `jobs` to main-process job events. Returns an unsubscribe function. */
export function bindJobEvents(): () => void {
  const api = recutApi();
  if (!api) return () => {};
  api.listJobs().then((jobs) => useStore.getState().setJobs(jobs)).catch(() => {});
  return api.onJobs((jobs) => useStore.getState().setJobs(jobs));
}
