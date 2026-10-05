import { History } from 'lucide-react';
import { registerPanel } from '../registry';
import { HistoryPanel } from './HistoryPanel';

registerPanel({ id: 'history', title: 'History', defaultZone: 'left-bottom', icon: History, component: HistoryPanel, description: 'Undo history — click an entry to jump back or forward' });

export { HistoryPanel };
