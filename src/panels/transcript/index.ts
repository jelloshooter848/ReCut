import { FileText } from 'lucide-react';
import { registerPanel } from '../registry';
import { TranscriptPanel } from './TranscriptPanel';
import './transcript.css';

registerPanel({
  id: 'transcript',
  title: 'Transcript',
  defaultZone: 'left-bottom',
  icon: FileText,
  component: TranscriptPanel,
  description: 'Search dialogue across the project and read the Source clip transcript',
});

export { TranscriptPanel };
