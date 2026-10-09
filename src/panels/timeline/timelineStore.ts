/**
 * Panel-local UI state that is neither project data nor global editor UI: header column width,
 * linked-selection toggle, hover timecode and live (uncommitted) track heights during a resize drag.
 */
import { create } from 'zustand';

export interface TimelineUiState {
  linkedSelection: boolean;
  headerWidth: number;
  hoverFrame: number | null;
  liveHeights: Record<string, number>;
  setLinkedSelection(v: boolean): void;
  setHeaderWidth(w: number): void;
  setHoverFrame(f: number | null): void;
  setLiveHeight(trackId: string, height: number | null): void;
  /** Number of mounted Timeline panels able to show the marker editor. */
  markerEditorHosts: number;
  /** Pending "open the marker editor for this marker" request (M on an existing marker). */
  markerEditRequest: { markerId: string; nonce: number } | null;
  setMarkerEditorHost(delta: 1 | -1): void;
  requestMarkerEdit(markerId: string | null): void;
  /** Audio track ids whose transcript lane is collapsed to a thin line (#132); kept in local storage. */
  collapsedTranscripts: Record<string, true>;
  toggleTranscriptCollapsed(trackId: string): void;
}

const COLLAPSED_KEY = 'recut.timeline.collapsedTranscripts';

function readCollapsed(): Record<string, true> {
  try {
    const v = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).map((k) => [k, true as const])) : {};
  } catch { return {}; }
}

function writeCollapsed(v: Record<string, true>): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(COLLAPSED_KEY, JSON.stringify(v)); } catch { /* private mode / quota */ }
}

export const MIN_HEADER_W = 110;
export const MAX_HEADER_W = 340;

export const useTimelineUi = create<TimelineUiState>()((set) => ({
  linkedSelection: true,
  headerWidth: 170,
  hoverFrame: null,
  liveHeights: {},
  setLinkedSelection: (linkedSelection) => set({ linkedSelection }),
  setHeaderWidth: (w) => set({ headerWidth: Math.max(MIN_HEADER_W, Math.min(MAX_HEADER_W, Math.round(w))) }),
  setHoverFrame: (hoverFrame) => set((s) => (s.hoverFrame === hoverFrame ? s : { hoverFrame })),
  markerEditorHosts: 0,
  markerEditRequest: null,
  setMarkerEditorHost: (delta) => set((s) => ({ markerEditorHosts: Math.max(0, s.markerEditorHosts + delta) })),
  requestMarkerEdit: (markerId) => set((s) => ({ markerEditRequest: markerId ? { markerId, nonce: (s.markerEditRequest?.nonce ?? 0) + 1 } : null })),
  collapsedTranscripts: readCollapsed(),
  toggleTranscriptCollapsed: (trackId) => set((s) => {
    const next = { ...s.collapsedTranscripts };
    if (next[trackId]) delete next[trackId]; else next[trackId] = true;
    writeCollapsed(next);
    return { collapsedTranscripts: next };
  }),
  setLiveHeight: (trackId, height) => set((s) => {
    const next = { ...s.liveHeights };
    if (height === null) delete next[trackId]; else next[trackId] = height;
    return { liveHeights: next };
  }),
}));
