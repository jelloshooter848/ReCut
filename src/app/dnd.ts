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
