import { FolderOpen } from 'lucide-react';
import { registerPanel } from '../registry';
import { ProjectPanel } from './ProjectPanel';
import './project.css';
import { clipsPastEnd, importPaths, relinkWithPath } from './actions';

registerPanel({ id: 'project', title: 'Project', defaultZone: 'left-top', icon: FolderOpen, component: ProjectPanel, description: 'Media library: bins, series, scenes, sequences' });

export { ProjectPanel } from './ProjectPanel';
export { RelinkDialog } from './RelinkDialog';
export { parseEpisodeInfo, episodeLabel } from './parseIdentity';

// Automation hook (Playwright): window.__recut.projectActions.{importPaths, relinkWithPath, clipsPastEnd}.
// Deferred: this module is evaluated before main.tsx installs window.__recut.
if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    const hook = (window as unknown as { __recut?: Record<string, unknown> }).__recut;
    if (hook && !hook.projectActions) hook.projectActions = { importPaths, relinkWithPath, clipsPastEnd };
  }, 0);
}
