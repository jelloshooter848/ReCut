/**
 * Panel registrations. Placeholders first; real panel modules imported after this line override them
 * by calling registerPanel() with the same id. Each panel directory owns its own index.ts.
 */
import './placeholders';
import './project';
import './source';
import './program';
import './timeline';
import './inspector';
import './transcript';
import './subtitles';
import './scenes';
import './sequences';
import './continuity';
import './storyline';
import './compare';
import './export';
import './jobs';
import './markers';
import './history';

export { registerPanel, getPanel, getPanels, subscribePanels, ZONE_IDS, ZONE_TITLES } from './registry';
export type { PanelDef, PanelProps, ZoneId } from './registry';
export { usePanels, usePanel } from './usePanels';
