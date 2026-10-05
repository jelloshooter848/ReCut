/**
 * Value ranges a loaded project must stay within. normalizeProject (shared/project.ts) repairs anything outside
 * them on load; the UI ranges for the same values should come from here too (single source).
 *
 * Pure: no DOM, no Node.
 */

/**
 * Upper bound for every timeline position / duration in frames (clip start / end, markers, story blocks, free
 * subtitle cues, view playhead / scroll / in / out): 24 hours at the highest supported frame rate (1000 fps,
 * see isValidFps in time.ts) = 86,400,000 frames. Far beyond any real edit, and small enough that frame
 * arithmetic stays exact and per-frame / per-tick loops over a visible range always make progress.
 */
export const MAX_TIMELINE_FRAMES = 24 * 60 * 60 * 1000;

/**
 * Upper bound for source-media positions in seconds (clip sourceIn, library scenes, detected scenes, media
 * subtitle cues): 10 days. Sources are at most a few hours long; this only rejects values that can not be a
 * real position (1e21 and the like) while keeping millisecond precision.
 */
export const MAX_SOURCE_SECONDS = 10 * 24 * 60 * 60;

/** Timeline zoom in pixels per frame (same bounds as ZOOM_FLOOR / MAX_ZOOM in src/panels/timeline/viewMath.ts). */
export const VIEW_ZOOM_MIN = 1e-4;
export const VIEW_ZOOM_MAX = 50;

/** Project settings ranges (Preferences dialog). */
export const AUTOSAVE_INTERVAL_MIN_SEC = 5;
export const AUTOSAVE_INTERVAL_MAX_SEC = 3600;
export const DEFAULT_TRANSITION_FRAMES_MIN = 1;
export const DEFAULT_TRANSITION_FRAMES_MAX = 600;
/** Proxy heights offered by the Preferences dialog and the Proxies tab. */
export const PROXY_HEIGHTS: readonly number[] = Object.freeze([540, 720, 1080]);

/**
 * Deepest nesting a loaded project may contain (root object = depth 1). Real project data is at most about a
 * dozen levels deep (sequence > snapshot > data > track > clip > transform > crop); anything nested deeper is
 * unknown data, and very deep nesting (thousands of levels) overflows the stack of JSON.stringify /
 * structuredClone, so normalizeProject drops values nested deeper than this.
 */
export const MAX_PROJECT_DEPTH = 64;
