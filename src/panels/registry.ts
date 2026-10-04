import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

/** Layout zones. See src/components/layout for how they are arranged. */
export type ZoneId = 'left-top' | 'left-bottom' | 'monitor-left' | 'monitor-right' | 'center-bottom' | 'right';
export const ZONE_IDS: readonly ZoneId[] = ['left-top', 'left-bottom', 'monitor-left', 'monitor-right', 'center-bottom', 'right'];
export const ZONE_TITLES: Record<ZoneId, string> = {
  'left-top': 'Left (top)',
  'left-bottom': 'Left (bottom)',
  'monitor-left': 'Monitor (left)',
  'monitor-right': 'Monitor (right)',
  'center-bottom': 'Bottom (timeline)',
  right: 'Right',
};

export interface PanelProps {
  panelId: string;
  zoneId: ZoneId;
  /** True when this panel's tab is the active one in its zone. Inactive panels stay mounted but hidden. */
  active: boolean;
  /** True when the zone has keyboard focus (last clicked). */
  focused: boolean;
}

export interface PanelDef {
  id: string;
  title: string;
  component: ComponentType<PanelProps>;
  defaultZone: ZoneId;
  icon?: LucideIcon;
  /** Shown in menus/tooltips. */
  description?: string;
}

const panels = new Map<string, PanelDef>();
let order: PanelDef[] = [];
const listeners = new Set<() => void>();
const emit = () => { order = Array.from(panels.values()); listeners.forEach((l) => l()); };

/** Register (or replace) a panel. Other modules call this at import time to override placeholders. */
export function registerPanel(def: PanelDef): void {
  panels.set(def.id, def);
  emit();
}
export function unregisterPanel(id: string): void { if (panels.delete(id)) emit(); }
export function getPanel(id: string): PanelDef | undefined { return panels.get(id); }
export function getPanels(): PanelDef[] { return order; }
export function subscribePanels(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
