import { Clapperboard } from 'lucide-react';
import { registerPanel } from '../registry';
import { ScenesPanel } from './ScenesPanel';

registerPanel({
  id: 'scenes',
  title: 'Scenes',
  defaultZone: 'left-bottom',
  icon: Clapperboard,
  description: 'Scene library — reusable references to source ranges with characters, locations, arcs, tags and ratings',
  component: ScenesPanel,
});

export { ScenesPanel, focusScenesPanel } from './ScenesPanel';
export * from './sceneUtils';
