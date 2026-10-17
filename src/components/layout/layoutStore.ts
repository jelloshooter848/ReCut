import { create } from 'zustand';
import type { ZoneId } from '@/panels/registry';
import { ZONE_IDS, getPanel } from '@/panels/registry';
import { clamp } from '@shared/time';

export type WorkspaceId = 'Editing' | 'Research' | 'Audio' | 'Compare';
export const WORKSPACES: readonly WorkspaceId[] = ['Editing', 'Research', 'Audio', 'Compare'];

export interface LayoutSizes {
  /** Left column width (px). */
  leftW: number;
  /** Right column width (px). */
  rightW: number;
  /** Fraction of the left column given to 'left-top'. */
  leftSplit: number;
  /** Fraction of the center column given to the monitors row. */
  centerSplit: number;
  /** Fraction of the monitors row given to 'monitor-left'. */
  monitorSplit: number;
}

export type ZoneAssignments = Record<ZoneId, string[]>;

export interface WorkspaceLayout {
  zones: ZoneAssignments;
  active: Partial<Record<ZoneId, string>>;
  sizes: LayoutSizes;
}

// frozen: changing this would reset every user's saved panel layout (the key is read from the browser storage the
// user-data folder carries along; it is invisible to users).
export const STORAGE_KEY = 'recut.layout.v1';
export const MIN_COL_W = 200;
export const MIN_SPLIT = 0.12;

const BASE_ZONES: ZoneAssignments = {
  'left-top': ['project'],
  'left-bottom': ['transcript', 'scenes', 'continuity', 'subtitles', 'markers', 'history', 'jobs'],
  'monitor-left': ['source'],
  'monitor-right': ['program'],
  'center-bottom': ['timeline', 'storyline'],
  right: ['inspector', 'compare'],
};
const BASE_SIZES: LayoutSizes = { leftW: 320, rightW: 300, leftSplit: 0.42, centerSplit: 0.5, monitorSplit: 0.5 };

export const WORKSPACE_PRESETS: Record<WorkspaceId, WorkspaceLayout> = {
  Editing: { zones: BASE_ZONES, active: {}, sizes: BASE_SIZES },
  Research: {
    zones: {
      'left-top': ['transcript', 'scenes'],
      'left-bottom': ['project', 'continuity', 'subtitles', 'markers', 'history', 'jobs'],
      'monitor-left': [],
      'monitor-right': ['program', 'source'],
      'center-bottom': ['timeline', 'storyline'],
      right: ['inspector', 'compare'],
    },
    active: {},
    sizes: { leftW: 480, rightW: 280, leftSplit: 0.62, centerSplit: 0.55, monitorSplit: 0.5 },
  },
  Audio: { zones: BASE_ZONES, active: {}, sizes: { leftW: 300, rightW: 300, leftSplit: 0.4, centerSplit: 0.34, monitorSplit: 0.5 } },
  Compare: {
    zones: {
      'left-top': ['project', 'source'],
      'left-bottom': ['transcript', 'scenes', 'continuity', 'subtitles', 'markers', 'history', 'jobs'],
      'monitor-left': ['compare'],
      'monitor-right': ['program'],
      'center-bottom': ['timeline', 'storyline'],
      right: ['inspector'],
    },
    active: {},
    sizes: { leftW: 280, rightW: 280, leftSplit: 0.45, centerSplit: 0.58, monitorSplit: 0.5 },
  },
};

function cloneLayout(l: WorkspaceLayout): WorkspaceLayout {
  const zones = {} as ZoneAssignments;
  for (const z of ZONE_IDS) zones[z] = [...(l.zones[z] ?? [])];
  return { zones, active: { ...l.active }, sizes: { ...l.sizes } };
}

interface Persisted { version: 1; workspace: WorkspaceId; layouts: Partial<Record<WorkspaceId, WorkspaceLayout>> }

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Persisted;
    if (p?.version !== 1 || !WORKSPACES.includes(p.workspace)) return null;
    return p;
  } catch { return null; }
}

function sanitize(l: WorkspaceLayout): WorkspaceLayout {
  const out = cloneLayout(l);
  for (const z of ZONE_IDS) if (!Array.isArray(out.zones[z])) out.zones[z] = [];
  out.sizes = { ...BASE_SIZES, ...out.sizes };
  return out;
}

export interface LayoutState extends WorkspaceLayout {
  workspace: WorkspaceId;
  /** Saved per-workspace customizations. */
  layouts: Partial<Record<WorkspaceId, WorkspaceLayout>>;
  maximized: ZoneId | null;
  focusedZone: ZoneId | null;

  setWorkspace(ws: WorkspaceId): void;
  movePanel(panelId: string, toZone: ZoneId, index?: number): void;
  setActive(zone: ZoneId, panelId: string): void;
  setSizes(patch: Partial<LayoutSizes>): void;
  toggleMaximize(zone?: ZoneId | null): void;
  setFocusedZone(zone: ZoneId | null): void;
  /** Bring a panel to front in its zone and focus the zone (adds it to its default zone if not placed). */
  focusPanel(panelId: string): void;
  /** Zone containing a panel, if any. */
  zoneOf(panelId: string): ZoneId | null;
  resetLayout(workspace?: WorkspaceId): void;
}

function initial(): Pick<LayoutState, 'workspace' | 'layouts' | 'zones' | 'active' | 'sizes'> {
  const p = loadPersisted();
  const workspace = p?.workspace ?? 'Editing';
  const layouts = p?.layouts ?? {};
  const cur = sanitize(layouts[workspace] ?? WORKSPACE_PRESETS[workspace]);
  return { workspace, layouts, ...cur };
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  ...initial(),
  maximized: null,
  focusedZone: null,

  setWorkspace(ws) {
    const s = get();
    const layouts = { ...s.layouts, [s.workspace]: { zones: s.zones, active: s.active, sizes: s.sizes } };
    const next = sanitize(layouts[ws] ?? WORKSPACE_PRESETS[ws]);
    set({ workspace: ws, layouts, ...next, maximized: null });
  },

  movePanel(panelId, toZone, index) {
    const s = get();
    const zones = {} as ZoneAssignments;
    for (const z of ZONE_IDS) zones[z] = s.zones[z].filter((p) => p !== panelId);
    const list = zones[toZone];
    const i = index === undefined ? list.length : clamp(index, 0, list.length);
    list.splice(i, 0, panelId);
    const active = { ...s.active, [toZone]: panelId };
    // Fix up active tabs for zones that lost their active panel
    for (const z of ZONE_IDS) {
      if (z !== toZone && (!active[z] || !zones[z].includes(active[z]!))) active[z] = zones[z][0];
    }
    set({ zones, active, maximized: s.maximized && zones[s.maximized].length ? s.maximized : null, focusedZone: toZone });
  },

  setActive(zone, panelId) { set((s) => ({ active: { ...s.active, [zone]: panelId }, focusedZone: zone })); },

  setSizes(patch) {
    set((s) => {
      const n = { ...s.sizes, ...patch };
      n.leftW = clamp(n.leftW, MIN_COL_W, 1200);
      n.rightW = clamp(n.rightW, MIN_COL_W, 1200);
      n.leftSplit = clamp(n.leftSplit, MIN_SPLIT, 1 - MIN_SPLIT);
      n.centerSplit = clamp(n.centerSplit, MIN_SPLIT, 1 - MIN_SPLIT);
      n.monitorSplit = clamp(n.monitorSplit, MIN_SPLIT, 1 - MIN_SPLIT);
      return { sizes: n };
    });
  },

  toggleMaximize(zone) {
    const s = get();
    const target = zone === undefined ? s.focusedZone : zone;
    if (s.maximized) set({ maximized: null });
    else if (target && s.zones[target].length) set({ maximized: target, focusedZone: target });
  },

  setFocusedZone(zone) { if (get().focusedZone !== zone) set({ focusedZone: zone }); },

  zoneOf(panelId) {
    const z = get().zones;
    for (const id of ZONE_IDS) if (z[id].includes(panelId)) return id;
    return null;
  },

  focusPanel(panelId) {
    const s = get();
    let zone = s.zoneOf(panelId);
    if (!zone) {
      const def = getPanel(panelId);
      if (!def) return;
      s.movePanel(panelId, def.defaultZone);
      zone = def.defaultZone;
    }
    set((st) => ({ active: { ...st.active, [zone!]: panelId }, focusedZone: zone, maximized: st.maximized && st.maximized !== zone ? null : st.maximized }));
  },

  resetLayout(workspace) {
    const s = get();
    const ws = workspace ?? s.workspace;
    const layouts = { ...s.layouts };
    delete layouts[ws];
    if (ws === s.workspace) set({ layouts, ...cloneLayout(WORKSPACE_PRESETS[ws]), maximized: null });
    else set({ layouts });
  },
}));

/** Resolve the panels that are visible in a zone: only registered ids. */
export function visibleZonePanels(ids: string[]): string[] { return ids.filter((id) => !!getPanel(id)); }

// ---- persistence (debounced) ----
let saveTimer: number | undefined;
useLayoutStore.subscribe((s) => {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const layouts = { ...s.layouts, [s.workspace]: { zones: s.zones, active: s.active, sizes: s.sizes } };
      const p: Persisted = { version: 1, workspace: s.workspace, layouts };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch { /* storage unavailable */ }
  }, 150);
});

/** Reset the current workspace to its preset and clear persisted customizations for it. */
export function resetLayout(workspace?: WorkspaceId) { useLayoutStore.getState().resetLayout(workspace); }
/** Clear every persisted layout and reset all workspaces. */
export function resetAllLayouts() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  const s = useLayoutStore.getState();
  useLayoutStore.setState({ layouts: {}, ...cloneLayout(WORKSPACE_PRESETS[s.workspace]), maximized: null });
}
