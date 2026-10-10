/**
 * Panel-level operations that combine store actions with window.recut (IPC). Every IPC access is guarded.
 */
import type { DetectedScene, ID, MediaItem, MediaProbe, SceneRecord } from '@shared/model';
import type { FileFilter } from '@shared/ipc';
import { uid } from '@shared/ids';
import { allTracks, clipEnd, clipSourceOut, findClip } from '@shared/timeline';
import { secondsToFrames } from '@shared/time';
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS } from '@/state/parseIdentity';
import { toast } from '@/components/ui/toastStore';
import { invalidateMediaPath } from '@/app/media';
import { useLayoutStore } from '@/components/layout/layoutStore';
import {
  useStore, recutApi, importMedia, probeMedia, startProxy, startSceneDetect, importSubtitleFile, importEmbeddedSubtitles,
  activeSequence, fileNameOf,
} from '@/state';
import { activeJobFor, useJobsStore } from '@/app/jobsStore';
import { ocrStream, openOcrDialog } from '@/ocr/ocrUi';

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

/** Extract an embedded text stream; a bitmap stream (PGS, VobSub, DVB, XSUB) opens the Read with OCR dialog instead. */
export async function importEmbedded(mediaId: ID, streamIndex: number): Promise<void> {
  if (ocrStream(useStore.getState().project.media[mediaId], streamIndex)) { openOcrDialog({ mediaId, streamIndex }); return; }
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

/** A source range to place on the timeline (a detected shot). */
export interface RangeToInsert { mediaId: ID; in: number; out: number }

/**
 * Insert / overwrite several ranges back to back at the playhead, in the order given, as one undo step (#143).
 * Leaves the playhead after the last placed clip. Returns how many ranges were placed.
 */
export function insertRangesAtPlayhead(ranges: RangeToInsert[], mode: 'insert' | 'overwrite', label = mode === 'insert' ? 'Insert shots' : 'Overwrite shots'): number {
  const st = useStore.getState();
  const seq = activeSequence(st);
  if (!seq) { toast('warn', 'No active sequence'); return 0; }
  let at = seq.view.playhead;
  let placed = 0;
  st.batch(label, () => {
    for (const r of ranges) {
      if (!useStore.getState().project.media[r.mediaId]) continue;
      const ids = useStore.getState().insertFromSource(seq.id, { mediaId: r.mediaId, in: r.in, out: r.out, atFrame: at, mode });
      if (!ids.length) continue;
      placed++;
      // Advance by what was actually placed (inserts are capped at the media end).
      const now = useStore.getState().project.sequences[seq.id];
      let end = -Infinity;
      if (now) for (const id of ids) { const loc = findClip(now, id); if (loc) end = Math.max(end, clipEnd(loc.clip)); }
      at = Number.isFinite(end) ? end : at + Math.max(1, secondsToFrames(r.out - r.in, seq.fps));
    }
  });
  if (placed) useStore.getState().setView(seq.id, { playhead: at });
  else if (ranges.length) toast('warn', 'Nothing inserted (tracks locked?)');
  return placed;
}

/** Every detected shot of a media item, in source order, back to back at the playhead (one undo step). */
export function insertAllShots(mediaId: ID, mode: 'insert' | 'overwrite'): number {
  const m = useStore.getState().project.media[mediaId];
  if (!m || !m.detectedScenes.length) { toast('info', 'No detected shots'); return 0; }
  const shots = [...m.detectedScenes].sort((a, b) => a.start - b.start);
  return insertRangesAtPlayhead(shots.map((s) => ({ mediaId, in: s.start, out: s.end })), mode, mode === 'insert' ? 'Insert all shots' : 'Overwrite all shots');
}

/**
 * Shots of one media item whose indices are consecutive in its shot list, in that order; null if the ids span
 * several media items, include unknown ids, or skip a shot.
 */
export function contiguousShots(media: MediaItem, shotIds: ID[]): DetectedScene[] | null {
  const want = new Set(shotIds);
  const idx = media.detectedScenes.map((s, i) => (want.has(s.id) ? i : -1)).filter((i) => i >= 0);
  if (idx.length !== want.size || idx.length === 0) return null;
  for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return null;
  return idx.map((i) => media.detectedScenes[i]);
}

/** Next free default scene name in the Scene library: "Scene 01", "Scene 02", … */
export function nextSceneName(): string {
  const names = new Set(Object.values(useStore.getState().project.scenes).map((s) => s.name));
  for (let n = 1; ; n++) { const name = `Scene ${String(n).padStart(2, '0')}`; if (!names.has(name)) return name; }
}

/** Make one Scene library record covering contiguous shots of a media item (#143). Returns its id, or null. */
export function makeSceneFromShots(mediaId: ID, shotIds: ID[], name: string): ID | null {
  const m = useStore.getState().project.media[mediaId];
  const shots = m ? contiguousShots(m, shotIds) : null;
  if (!m || !shots) { toast('warn', 'Select shots that follow each other in one clip'); return null; }
  const rec: SceneRecord = {
    id: uid('scn'), name, mediaId, in: shots[0].start, out: shots[shots.length - 1].end,
    characters: [...new Set(shots.flatMap((s) => s.characters))], location: '', arc: '', tags: [...new Set(shots.flatMap((s) => s.tags))],
    notes: '', rating: 0, color: '#4d7cfe', createdAt: Date.now(),
  };
  useStore.getState().addScene(rec);
  toast('ok', `Scene "${name}" made from ${shots.length} shot${shots.length === 1 ? '' : 's'}`);
  return rec.id;
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
  // Nested elsewhere (Roadmap §8): those nested clips would play nothing.
  const hosts = Object.values(st.project.sequences).filter((s) => s.id !== id && allTracks(s).some((t) => t.clips.some((c) => c.sequenceId === id)));
  if (clips > 0 || hosts.length) {
    const api = recutApi();
    const nestNote = hosts.length ? ` It is nested in ${hosts.map((h) => `"${h.name}"`).join(', ')}: those nested clips will play nothing.` : '';
    const choice = api
      ? await api.message({ type: 'warning', title: 'Delete sequence', message: `Delete "${seq.name}"?`, detail: `It contains ${clips} clip${clips === 1 ? '' : 's'}.${nestNote}`, buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1 })
      : (window.confirm(`Delete sequence "${seq.name}" (${clips} clips)?${nestNote}`) ? 0 : 1);
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
    try { await startSceneDetect(id, threshold); } catch (e) { useStore.getState().setSceneDetectStatus(id, 'failed'); toast('error', `Shot detection failed to start: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

// ---------------------------------------------------------------- scenes

export function addSceneToLibrary(media: MediaItem, scene: DetectedScene): void {
  const rec: SceneRecord = {
    id: uid('scn'), name: scene.name, mediaId: media.id, in: scene.start, out: scene.end,
    characters: [...scene.characters], location: '', arc: '', tags: [...scene.tags], notes: '', rating: 0, color: '#4d7cfe', createdAt: Date.now(),
  };
  useStore.getState().addScene(rec);
  toast('ok', `Added "${scene.name}" to the Scene library`);
}

export function mergeWithNext(media: MediaItem, sceneId: ID): void {
  const i = media.detectedScenes.findIndex((s) => s.id === sceneId);
  const next = media.detectedScenes[i + 1];
  if (i < 0 || !next) { toast('info', 'No following shot to merge with'); return; }
  useStore.getState().mergeDetectedScenes(media.id, [sceneId, next.id]);
}
