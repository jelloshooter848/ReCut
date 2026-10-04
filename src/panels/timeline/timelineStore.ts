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
  setLiveHeight: (trackId, height) => set((s) => {
    const next = { ...s.liveHeights };
    if (height === null) delete next[trackId]; else next[trackId] = height;
    return { liveHeights: next };
  }),
}));
