import { Map } from 'lucide-react';
import { registerPanel } from '../registry';
import { StorylinePanel } from './StorylinePanel';

registerPanel({
  id: 'storyline',
  title: 'Storyline',
  defaultZone: 'center-bottom',
  icon: Map,
  component: StorylinePanel,
  description: 'Story blocks, character / plotline filters and what-if runtime experiments over the active sequence',
});

export { StorylinePanel };
export * from './util';
