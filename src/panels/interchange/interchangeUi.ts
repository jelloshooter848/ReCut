/**
 * Open state of the Export Timeline dialog (File › Export Timeline…, command `file.exportTimeline`), plus the
 * choices it remembers for the session (sequence, format).
 */
import { create } from 'zustand';
import type { ID } from '@shared/model';
import type { InterchangeFormat } from '@shared/interchange';

export interface InterchangeUiState {
  open: boolean;
  /** The sequence to export; the active sequence when the dialog opens. */
  sequenceId: ID | null;
  format: InterchangeFormat;
}

export const useInterchangeUi = create<InterchangeUiState>()(() => ({ open: false, sequenceId: null, format: 'fcpxml' }));

/** Open the dialog on `sequenceId` (the active sequence), keeping the format picked last. */
export function openExportTimelineDialog(sequenceId: ID): void {
  useInterchangeUi.setState({ open: true, sequenceId });
}

export function closeExportTimelineDialog(): void {
  useInterchangeUi.setState({ open: false });
}
