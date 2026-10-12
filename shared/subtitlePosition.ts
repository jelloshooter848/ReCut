/**
 * Where subtitles sit in the frame (#115): a timeline's optional `subtitlePosition`, the height of the text as a
 * fraction of the frame from the top (0.05..0.95). In the lower half the text block's BOTTOM sits there (lines stack
 * upwards); in the upper half its TOP does (lines stack downwards). Absent: the default look (Program baseline at 93 %
 * of the height, libass's own bottom margin in burn-in), unchanged from before the setting existed.
 *
 * Pure: shared by the Program monitor (canvas), the Source monitor (CSS) and burn-in export (libass).
 */
export const SUBTITLE_POSITION_MIN = 0.05;
export const SUBTITLE_POSITION_MAX = 0.95;
/** The position the Program monitor draws at when none is set (the last line's baseline). */
export const SUBTITLE_POSITION_DEFAULT = 0.93;
/** "Top" preset. */
export const SUBTITLE_POSITION_TOP = 0.07;

export function isValidSubtitlePosition(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= SUBTITLE_POSITION_MIN && v <= SUBTITLE_POSITION_MAX;
}

/** Which edge of the text block is placed at the position, and the distance (fraction of the height) to that edge of the frame. */
export interface SubtitleAnchor { edge: 'top' | 'bottom'; margin: number }

/** The anchor of a set position; null when none is set (the default look). */
export function subtitleAnchor(position: number | undefined | null): SubtitleAnchor | null {
  if (!isValidSubtitlePosition(position)) return null;
  return position < 0.5 ? { edge: 'top', margin: position } : { edge: 'bottom', margin: 1 - position };
}

/** libass's script height for SRT input (and the burn-in ASS): MarginV is in these units. */
export const ASS_PLAY_RES_Y = 288;

/** libass Alignment (2 bottom centre, 8 top centre) and MarginV for a set position; null when none is set. */
export function assSubtitlePosition(position: number | undefined | null): { alignment: 2 | 8; marginV: number } | null {
  const a = subtitleAnchor(position);
  if (!a) return null;
  return { alignment: a.edge === 'top' ? 8 : 2, marginV: Math.round(a.margin * ASS_PLAY_RES_Y) };
}
