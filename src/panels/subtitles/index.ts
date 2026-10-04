import { Captions } from 'lucide-react';
import { registerPanel } from '../registry';
import { SubtitlesPanel } from './SubtitlesPanel';
import './subtitles.css';

registerPanel({
  id: 'subtitles',
  title: 'Subtitles',
  defaultZone: 'left-bottom',
  icon: Captions,
  component: SubtitlesPanel,
  description: 'Edit, nudge, split and export the active sequence’s subtitle tracks',
});

export { SubtitlesPanel };
export { exportSequenceSubtitles, importSubtitlesToTrack, serializeSequenceSubtitles } from './exportSubtitles';
