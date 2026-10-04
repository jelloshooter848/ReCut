/**
 * Panel registrations. Placeholders first; real panel modules imported after this line override them
 * by calling registerPanel() with the same id.
 */
import './placeholders';

export { registerPanel, getPanel, getPanels, subscribePanels, ZONE_IDS, ZONE_TITLES } from './registry';
export type { PanelDef, PanelProps, ZoneId } from './registry';
export { usePanels, usePanel } from './usePanels';
