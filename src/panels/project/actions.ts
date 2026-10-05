/**
 * Panel-level operations that combine store actions with window.recut (IPC). Every IPC access is guarded.
 */
import type { DetectedScene, ID, MediaItem, MediaProbe, SceneRecord } from '@shared/model';
import type { FileFilter } from '@shared/ipc';
import { uid } from '@shared/ids';
import { allTracks, clipSourceOut } from '@shared/timeline';
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from '@/state/parseIdentity';
import { toast } from '@/components/ui/toastStore';
import { invalidateMediaPath } from '@/app/media';
import { useLayoutStore } from '@/components/layout/layoutStore';
import {
  useStore, recutApi, importMedia, probeMedia, startProxy, startSceneDetect, importSubtitleFile, importEmbeddedSubtitles,
  activeSequence, fileNameOf,
} from '@/state';
import { activeJobFor, useJobsStore } from '@/app/jobsStore';

export const VIDEO_EXT = VIDEO_EXTS;
export const AUDIO_EXT = AUDIO_EXTS;
export const IMAGE_EXT = IMAGE_EXTS;
export const SUB_EXT = ['srt', 'vtt'];
export const IMPORT_FILTERS: FileFilter[] = [
  { name: 'All media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT, ...SUB_EXT] },
  { name: 'Video', extensions: VIDEO_EXT },
  { name: 'Audio', extensions: AUDIO_EXT },
  { name: 'Images', extensions: IMAGE_EXT },
  { name: 'Subtitles', extensions: SUB_EXT },
  { name: 'All files', extensions: ['*'] },
];
export const SUBTITLE_FILTERS: FileFilter[] = [{ name: 'Subtitles', extensions: SUB_EXT }, { name: 'All files', extensions: ['*'] }];

const ext = (p: string) => { const n = fileNameOf(p); const i = n.lastIndexOf('.'); return i >= 0 ? n.slice(i + 1).toLowerCase() : ''; };
export const isSubtitlePath = (p: string) => SUB_EXT.includes(ext(p));
export const isMediaPath = (p: string) => { const e = ext(p); return VIDEO_EXT.includes(e) || AUDIO_EXT.includes(e) || IMAGE_EXT.includes(e); };

/**
 * Import a mixed list of paths: media files become MediaItems (routed into default bins unless `binId` is given);
 * subtitle files next to imported videos are attached automatically; any other subtitle files attach to the single
 * selected (or given / just imported) media item when there is one, otherwise are skipped with a hint.
 */
export async function importPaths(paths: string[], binId: ID | null, attachTo?: ID | null): Promise<ID[]> {
  const r = await importMedia(paths, binId, { rejectSubtitles: false });
  const ids = r.added;
  const mediaCount = paths.length - r.subtitlePaths.length;
  if (ids.length) {
    const st = useStore.getState();
    const topBin = (b: ID | null): string | null => { let id = b; let name: string | null = null; while (id && st.project.bins[id]) { name = st.project.bins[id].name; id = st.project.bins[id].parentId; } return name; };
    const where = [...new Set(r.binIds.map(topBin).filter((n): n is string => !!n))];
    toast('ok', `Imported ${ids.length} file${ids.length === 1 ? '' : 's'}${where.length ? ` into ${where.join(', ')}` : ''}`);
  } else if (mediaCount > 0 && r.existing.length === 0) toast('info', 'Nothing imported');
  const subs = r.subtitlePaths.filter((p) => !r.sidecarsUsed.includes(p));
  if (subs.length) {
    const target = attachTo ?? (ids.length === 1 ? ids[0] : null);
    if (!target) toast('warn', 'Subtitles attach to a media item: select one item, then use "Import subtitles…"');
    else for (const p of subs) await attachSubtitleFile(target, p);
  }
  return ids;
}

export async function importViaDialog(binId: ID | null, attachTo?: ID | null): Promise<ID[]> {
  const api = recutApi();
  if (!api) { toast('error', 'Import needs the Electron bridge'); return []; }
  const paths = await api.openFiles({ title: 'Import media', multi: true, filters: IMPORT_FILTERS });
  if (!paths.length) return [];
  return importPaths(paths, binId, attachTo);
}

export async function attachSubtitleFile(mediaId: ID, path: string): Promise<void> {
  try {
    const r = await importSubtitleFile(mediaId, path);
    if (r.trackId) toast('ok', `Attached ${fileNameOf(path)}${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})` : ''}`);
    else toast('error', `No cues found in ${fileNameOf(path)}${r.warnings[0] ? `: ${r.warnings[0]}` : ''}`);
  } catch (e) { toast('error', `Subtitle import failed: ${e instanceof Error ? e.message : String(e)}`); }
}

export async function importSubtitlesViaDialog(mediaId: ID): Promise<void> {
  const api = recutApi();
  if (!api) return;
  const paths = await api.openFiles({ title: 'Import subtitles', multi: true, filters: SUBTITLE_FILTERS });
  for (const p of paths) await attachSubtitleFile(mediaId, p);
}

export async function importEmbedded(mediaId: ID, streamIndex: number): Promise<void> {
  try {
    const r = await importEmbeddedSubtitles(mediaId, streamIndex);
    if (r.trackId) toast('ok', 'Embedded subtitles imported');
    else toast('error', `No cues in stream ${streamIndex}${r.warnings[0] ? `: ${r.warnings[0]}` : ''}`);
  } catch (e) { toast('error', `Subtitle extraction failed: ${e instanceof Error ? e.message : String(e)}`); }
}

// ---------------------------------------------------------------- source / timeline

export function loadInSource(mediaId: ID, time = 0, range?: { in: number; out: number }): void {
  const st = useStore.getState();
  st.setSourceClip(mediaId, time);
  if (range) { st.setSourceIn(range.in); st.setSourceOut(range.out); }
  st.setActivePanel('source');
  useLayoutStore.getState().focusPanel('source');
}

export function openSequence(seqId: ID): void {
  const st = useStore.getState();
  st.setActiveSequence(seqId);
  st.setActivePanel('timeline');
  useLayoutStore.getState().focusPanel('timeline');
}

export function insertAtPlayhead(mediaId: ID, mode: 'insert' | 'overwrite', range?: { in: number; out: number }): void {
  const st = useStore.getState();
  const seq = activeSequence(st);
  const m = st.project.media[mediaId];
  if (!seq) { toast('warn', 'No active sequence'); return; }
  if (!m) return;
  const dur = m.kind === 'image' ? 5 : m.probe?.duration;
  if (!range && (dur === undefined || !Number.isFinite(dur) || dur <= 0)) { toast('warn', 'Media has no duration yet (still probing?)'); return; }
  const ids = st.insertFromSource(seq.id, { mediaId, in: range?.in ?? 0, out: range?.out ?? dur!, atFrame: seq.view.playhead, mode });
  if (!ids.length) toast('warn', 'Nothing inserted (tracks locked?)');
}

// ---------------------------------------------------------------- removal

/** Number of clips across all sequences that reference any of the media ids. */
export function clipUsage(ids: ID[]): number {
  const st = useStore.getState();
  const set = new Set(ids);
  let n = 0;
  for (const seq of Object.values(st.project.sequences)) for (const t of allTracks(seq)) for (const c of t.clips) if (set.has(c.mediaId)) n++;
  return n;
}

export async function removeMediaConfirmed(ids: ID[]): Promise<boolean> {
  if (!ids.length) return false;
  const used = clipUsage(ids);
  if (used > 0) {
    const api = recutApi();
    const choice = api
      ? await api.message({
        type: 'warning', title: 'Remove media', message: `Remove ${ids.length} item${ids.length === 1 ? '' : 's'} from the project?`,
        detail: `${used} clip${used === 1 ? '' : 's'} in your sequences use${used === 1 ? 's' : ''} this media and will be deleted too.`,
        buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
      })
      : (window.confirm(`Remove ${ids.length} item(s)? ${used} clip(s) in sequences will be deleted.`) ? 0 : 1);
    if (choice !== 0) return false;
  }
  const st = useStore.getState();
  st.removeMedia(ids);
  st.selectMedia([], 'set');
  return true;
}

export async function deleteSequenceConfirmed(id: ID): Promise<boolean> {
  const st = useStore.getState();
  const seq = st.project.sequences[id];
  if (!seq) return false;
  const clips = allTracks(seq).reduce((n, t) => n + t.clips.length, 0);
  if (clips > 0) {
    const api = recutApi();
    const choice = api
      ? await api.message({ type: 'warning', title: 'Delete sequence', message: `Delete "${seq.name}"?`, detail: `It contains ${clips} clip${clips === 1 ? '' : 's'}.`, buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 })
      : (window.confirm(`Delete sequence "${seq.name}" (${clips} clips)?`) ? 0 : 1);
    if (choice !== 0) return false;
  }
  st.deleteSequence(id);
  return true;
}

// ---------------------------------------------------------------- relink / offline

/** Clips (all sequences) of `mediaId` whose source range runs past `durationSec`. */
export function clipsPastEnd(mediaId: ID, durationSec: number): number {
  const st = useStore.getState();
  let n = 0;
  for (const seq of Object.values(st.project.sequences)) {
    const tol = seq.fps.den / seq.fps.num;   // one frame
    for (const t of allTracks(seq)) for (const c of t.clips) if (c.mediaId === mediaId && clipSourceOut(c, seq.fps) > durationSec + tol) n++;
  }
  return n;
}

/** Relink `mediaId` to `newPath` and re-probe. Asks first when a video would be relinked to a file without video. */
export async function relinkWithPath(mediaId: ID, newPath: string): Promise<boolean> {
  const api = recutApi();
  const st = useStore.getState();
  const m = st.project.media[mediaId];
  if (!m) return false;
  const oldPath = m.path;
  let probe: MediaProbe | null = null;
  if (api) { try { probe = await api.probe(newPath); } catch { probe = null; } }
  if (probe && m.kind === 'video' && !probe.video) {
    const used = clipUsage([mediaId]);
    const detail = `"${m.name}" is a video, but ${fileNameOf(newPath)} has no video stream.${used ? ` ${used} clip${used === 1 ? '' : 's'} using it will show black.` : ''}`;
    const choice = api
      ? await api.message({ type: 'warning', title: 'Relink to audio-only file?', message: `Relink a video to an audio-only file?`, detail, buttons: ['Relink anyway', 'Cancel'], defaultId: 1, cancelId: 1 })
      : (window.confirm(detail) ? 0 : 1);
    if (choice !== 0) return false;
  }
  let stat: { size?: number; mtimeMs?: number } | undefined;
  if (api) { try { const s = await api.stat(newPath); if (s.exists) stat = { size: s.size, mtimeMs: s.mtimeMs }; } catch { /* ignore */ } }
  st.relinkMedia(mediaId, newPath, stat);
  invalidateMediaPath(oldPath);
  invalidateMediaPath(newPath);
  if (probe) useStore.getState().setMediaProbe(mediaId, probe);
  else await probeMedia(mediaId);
  toast('ok', `Relinked ${fileNameOf(newPath)}`);
  // Clips that run past a shorter file's end are fitted to it by the store on this first probe (setMediaProbe ->
  // one undo step + its own "shorter after the relink" warning); nothing is left to freeze, so no warning here.
  return true;
}

export async function locateMedia(mediaId: ID): Promise<boolean> {
  const api = recutApi();
  const m = useStore.getState().project.media[mediaId];
  if (!api || !m) return false;
  const name = fileNameOf(m.path);
  const e = ext(name);
  const paths = await api.openFiles({ title: `Locate "${name}"`, multi: false, filters: e ? [{ name: `*.${e}`, extensions: [e] }, { name: 'All files', extensions: ['*'] }] : undefined });
  if (!paths.length) return false;
  await relinkWithPath(mediaId, paths[0]);
  return true;
}

export function revealInFolder(path: string): void {
  const api = recutApi();
  if (api) void api.showItemInFolder(path); else toast('info', path);
}

// ---------------------------------------------------------------- jobs

export async function generateProxy(mediaId: ID): Promise<void> {
  const m = useStore.getState().project.media[mediaId];
  if (!m || m.offline) return;
  if (m.kind !== 'video' && m.kind !== 'audio') { toast('info', 'Proxies are only generated for video and audio'); return; }
  try { await startProxy(mediaId); } catch (e) { useStore.getState().setProxy(mediaId, { status: 'failed', error: String(e) }); toast('error', `Proxy failed to start: ${e instanceof Error ? e.message : String(e)}`); }
}

export async function cancelMediaJob(mediaId: ID, kind: 'proxy' | 'sceneDetect'): Promise<void> {
  const api = recutApi();
  const job = activeJobFor(useJobsStore.getState().jobs, mediaId, kind);
  if (api && job) { try { await api.cancelJob(job.id); } catch { /* ignore */ } }
  const st = useStore.getState();
  if (kind === 'proxy') st.setProxy(mediaId, { status: 'none' }); else st.setSceneDetectStatus(mediaId, 'none');
}

export async function detectScenes(mediaIds: ID[], threshold?: number): Promise<void> {
  for (const id of mediaIds) {
    const m = useStore.getState().project.media[id];
    if (!m || m.offline || m.kind !== 'video') continue;
    try { await startSceneDetect(id, threshold); } catch (e) { useStore.getState().setSceneDetectStatus(id, 'failed'); toast('error', `Scene detection failed to start: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

// ---------------------------------------------------------------- scenes

export function addSceneToLibrary(media: MediaItem, scene: DetectedScene): void {
  const rec: SceneRecord = {
    id: uid('scn'), name: scene.name, mediaId: media.id, in: scene.start, out: scene.end,
    characters: [...scene.characters], location: '', arc: '', tags: [...scene.tags], notes: '', rating: 0, color: '#4d7cfe', createdAt: Date.now(),
  };
  useStore.getState().addScene(rec);
  toast('ok', `Added "${scene.name}" to the scene library`);
}

export function mergeWithNext(media: MediaItem, sceneId: ID): void {
  const i = media.detectedScenes.findIndex((s) => s.id === sceneId);
  const next = media.detectedScenes[i + 1];
  if (i < 0 || !next) { toast('info', 'No following scene to merge with'); return; }
  useStore.getState().mergeDetectedScenes(media.id, [sceneId, next.id]);
}
