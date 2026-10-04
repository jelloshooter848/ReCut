/**
 * Placeholder panel registrations. Other modules replace these by calling registerPanel() with the same id
 * (import their files from src/panels/index.ts after this one).
 */
import React from 'react';
import {
  Activity, Bookmark, Captions, Clapperboard, Columns2, FileText, Film, FolderOpen, GitCompareArrows, History, Layers, MonitorPlay, Route, SlidersHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { registerPanel, type PanelProps, type ZoneId } from './registry';

function makePlaceholder(title: string) {
  const Placeholder = (_props: PanelProps) => (
    <div className="panel">
      <div className="panel-placeholder">{title} panel</div>
    </div>
  );
  Placeholder.displayName = `${title.replace(/\s+/g, '')}Placeholder`;
  return Placeholder;
}

const PLACEHOLDERS: { id: string; title: string; zone: ZoneId; icon: LucideIcon }[] = [
  { id: 'project', title: 'Project', zone: 'left-top', icon: FolderOpen },
  { id: 'source', title: 'Source', zone: 'monitor-left', icon: Film },
  { id: 'program', title: 'Program', zone: 'monitor-right', icon: MonitorPlay },
  { id: 'timeline', title: 'Timeline', zone: 'center-bottom', icon: Layers },
  { id: 'inspector', title: 'Inspector', zone: 'right', icon: SlidersHorizontal },
  { id: 'transcript', title: 'Transcript', zone: 'left-bottom', icon: FileText },
  { id: 'scenes', title: 'Scenes', zone: 'left-bottom', icon: Clapperboard },
  { id: 'continuity', title: 'Continuity', zone: 'left-bottom', icon: GitCompareArrows },
  { id: 'storyline', title: 'Storyline', zone: 'center-bottom', icon: Route },
  { id: 'compare', title: 'Compare', zone: 'right', icon: Columns2 },
  { id: 'jobs', title: 'Jobs', zone: 'left-bottom', icon: Activity },
  { id: 'subtitles', title: 'Subtitles', zone: 'left-bottom', icon: Captions },
  { id: 'markers', title: 'Markers', zone: 'left-bottom', icon: Bookmark },
  { id: 'history', title: 'History', zone: 'left-bottom', icon: History },
];

for (const p of PLACEHOLDERS) registerPanel({ id: p.id, title: p.title, defaultZone: p.zone, icon: p.icon, component: makePlaceholder(p.title) });
