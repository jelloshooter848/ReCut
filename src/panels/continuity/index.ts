import { AlertTriangle } from 'lucide-react';
import { registerPanel } from '../registry';
import { ContinuityPanel } from './ContinuityPanel';

registerPanel({
  id: 'continuity',
  title: 'Continuity',
  defaultZone: 'left-bottom',
  icon: AlertTriangle,
  description: 'Project-wide continuity issues — continuity markers across all sequences with status, category and linked clips',
  component: ContinuityPanel,
});

export { ContinuityPanel, CONTINUITY_CATEGORIES, issuesAsText } from './ContinuityPanel';
export type { ContinuityCategory, IssueRow } from './ContinuityPanel';
