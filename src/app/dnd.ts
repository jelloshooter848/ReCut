/**
 * Drag-and-drop payloads shared between panels (Project, Source, Transcript, Scenes → Timeline/Source).
 */
export const CLIP_DND_TYPE = 'application/x-recut-clip';

export interface ClipDragPayload {
  mediaId: string;
  /** seconds; omit for whole media */
  in?: number;
  out?: number;
  name?: string;
  /** e.g. 'scene', 'transcript', 'library', 'media' */
  origin?: string;
  sceneRecordId?: string;
  characters?: string[];
  tags?: string[];
  includeVideo?: boolean;
  includeAudio?: boolean;
}

export function setClipDrag(dt: DataTransfer, payload: ClipDragPayload | ClipDragPayload[]): void {
  dt.setData(CLIP_DND_TYPE, JSON.stringify(Array.isArray(payload) ? payload : [payload]));
  dt.effectAllowed = 'copyMove';
}

export function readClipDrag(dt: DataTransfer): ClipDragPayload[] | null {
  const raw = dt.getData(CLIP_DND_TYPE);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [v]; } catch { return null; }
}

export function hasClipDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(CLIP_DND_TYPE);
}

/** DataTransfer type for Project-panel item drags (media / sequence / bin ids). */
export const ITEMS_DND_TYPE = 'application/x-recut-items';

/** Filesystem path of a File dropped from the OS. Electron 33 removed `File.path`; the preload exposes webUtils.getPathForFile. */
export function pathOfDroppedFile(file: File): string {
  try {
    const viaBridge = typeof window !== 'undefined' ? window.recut?.pathForFile?.(file) : '';
    if (viaBridge) return viaBridge;
  } catch { /* fall through */ }
  const legacy = (file as File & { path?: unknown }).path;
  return typeof legacy === 'string' ? legacy : '';
}
