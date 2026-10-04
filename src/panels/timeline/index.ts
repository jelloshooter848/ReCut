import { Layers } from 'lucide-react';
import { registerPanel } from '../registry';
import { TimelinePanel } from './TimelinePanel';
import './timeline.css';

registerPanel({
  id: 'timeline',
  title: 'Timeline',
  defaultZone: 'center-bottom',
  icon: Layers,
  component: TimelinePanel,
  description: 'Sequence timeline — frame-accurate editing with Premiere-style tools',
});

export { TimelinePanel } from './TimelinePanel';
export * from './viewMath';
