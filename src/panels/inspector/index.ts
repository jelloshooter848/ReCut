import { SlidersHorizontal } from 'lucide-react';
import { registerPanel } from '../registry';
import { InspectorPanel } from './InspectorPanel';

registerPanel({
  id: 'inspector',
  title: 'Inspector',
  defaultZone: 'right',
  icon: SlidersHorizontal,
  component: InspectorPanel,
  description: 'Effect controls and properties for the selected clip, transition, media item or timeline.',
});

export { InspectorPanel };
