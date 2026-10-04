import { Monitor } from 'lucide-react';
import { registerPanel } from '../registry';
import { ProgramPanel } from './ProgramPanel';

registerPanel({
  id: 'program',
  title: 'Program',
  defaultZone: 'monitor-right',
  icon: Monitor,
  component: ProgramPanel,
  description: 'Program Monitor — plays the active sequence',
});

export { ProgramPanel };
