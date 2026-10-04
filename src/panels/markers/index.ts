import { Bookmark } from 'lucide-react';
import { registerPanel } from '../registry';
import { MarkersPanel } from './MarkersPanel';

registerPanel({ id: 'markers', title: 'Markers', defaultZone: 'left-bottom', icon: Bookmark, component: MarkersPanel, description: 'Markers, chapters and continuity notes of the active sequence' });

export { MarkersPanel };
