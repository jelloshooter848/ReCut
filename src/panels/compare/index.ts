import { Columns2 } from 'lucide-react';
import { registerPanel } from '../registry';
import { ComparePanel } from './ComparePanel';

registerPanel({
  id: 'compare',
  title: 'Compare',
  defaultZone: 'right',
  icon: Columns2,
  component: ComparePanel,
  description: 'Play two cuts side by side, compare durations and structure, manage alternate cuts and snapshots',
});

export { ComparePanel };
export * from './diff';
