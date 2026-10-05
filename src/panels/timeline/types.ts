import type { ID } from '@shared/model';

export const RULER_H = 28;
export const CLIP_BAR_H = 16;
/** Row heights below this draw the name bar as an overlay instead of reserving space. */
export const COMPACT_ROW_H = 36;

export interface GhostRect { clipId: ID; trackId: ID; start: number; duration: number; kind: 'video' | 'audio'; name: string }

export type DragPreview =
  | { kind: 'move'; ghosts: GhostRect[]; delta: number; insert: boolean; snapTarget: number | null; tip: string }
  | { kind: 'trim'; clipId: ID; trackId: ID; start: number; duration: number; edge: 'start' | 'end'; ripple: boolean; tip: string; snapTarget: number | null }
  | { kind: 'roll'; trackId: ID; frame: number; tip: string }
  | { kind: 'slip'; clipId: ID; trackId: ID; start: number; duration: number; tip: string }
  | { kind: 'slide'; clipId: ID; trackId: ID; start: number; duration: number; tip: string }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'transition'; id: ID; trackId: ID; duration: number; tip: string }
  | { kind: 'drop'; trackId: ID | null; frame: number; insert: boolean };

export type DialogState =
  | { kind: 'speed'; clipId: ID }
  | { kind: 'rename'; clipId: ID }
  | { kind: 'tags'; clipId: ID }
  | { kind: 'props'; clipId: ID; x: number; y: number }
  | { kind: 'marker'; markerId: ID; x: number; y: number }
  | { kind: 'renameTrack'; trackId: ID }
  | null;
