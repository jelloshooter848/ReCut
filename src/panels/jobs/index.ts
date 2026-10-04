/**
 * Jobs panel registration. Job outcomes are routed into the project by src/app/jobsRouter.ts; this module only
 * exposes the jobs store on the automation hook (window.__recut.jobsStore).
 */
import { Activity } from 'lucide-react';
import { registerPanel } from '@/panels/registry';
import { useJobsStore } from '@/app/jobsStore';
import { JobsPanel } from './JobsPanel';

export { JobsPanel } from './JobsPanel';
export { JobsTab } from './JobsTab';
export { ProxiesTab } from './ProxiesTab';

registerPanel({
  id: 'jobs',
  title: 'Jobs',
  defaultZone: 'left-bottom',
  icon: Activity,
  component: JobsPanel,
  description: 'Background jobs (proxies, scene detection, exports) and proxy management',
});

if (typeof window !== 'undefined') {
  const hook = (window as unknown as { __recut?: Record<string, unknown> }).__recut;
  if (hook && !hook.jobsStore) hook.jobsStore = useJobsStore;
}
