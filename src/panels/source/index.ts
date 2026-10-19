import { Film } from 'lucide-react';
import { registerPanel } from '../registry';
import { SourcePanel } from './SourcePanel';

registerPanel({
  id: 'source',
  title: 'Source',
  defaultZone: 'monitor-left',
  icon: Film,
  component: SourcePanel,
  keepAlive: true,
  description: 'Source Monitor — preview media, mark In/Out, insert into the timeline',
});

export { SourcePanel };
export { insertSourceIntoSequence } from './insert';
