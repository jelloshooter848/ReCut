import { ListOrdered } from 'lucide-react';
import { registerPanel } from '../registry';
import { SequencesPanel } from './SequencesPanel';

registerPanel({
  id: 'sequences',
  title: 'Sequences',
  defaultZone: 'left-bottom',
  icon: ListOrdered,
  description: 'Sequences — groups of scenes in story order (acts, storylines, set pieces), placed on a timeline in one step',
  component: SequencesPanel,
});

export { SequencesPanel } from './SequencesPanel';
