import { FolderOpen } from 'lucide-react';
import { registerPanel } from '../registry';
import { ProjectPanel } from './ProjectPanel';
import './project.css';

registerPanel({ id: 'project', title: 'Project', defaultZone: 'left-top', icon: FolderOpen, component: ProjectPanel, description: 'Media library: bins, series, scenes, sequences' });

export { ProjectPanel } from './ProjectPanel';
export { RelinkDialog } from './RelinkDialog';
export { parseEpisodeInfo, episodeLabel } from './parseIdentity';
