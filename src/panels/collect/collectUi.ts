/**
 * Open state of the Collect Project dialog (File › Collect Project…, command `file.collect`), plus the choices it
 * remembers for the session (destination, options) and the collect job it is following.
 */
import { create } from 'zustand';
import type { ID } from '@shared/model';
import { DEFAULT_COLLECT_OPTIONS, type CollectOptions } from '@shared/collect';

export interface CollectUiState {
  open: boolean;
  /** Folder the collected project goes into (a `<Project name>` folder is created inside it). */
  destination: string;
  options: CollectOptions;
  /** The collect job started from the dialog (followed for progress and the result). */
  jobId: ID | null;
}

export const useCollectUi = create<CollectUiState>()(() => ({ open: false, destination: '', options: { ...DEFAULT_COLLECT_OPTIONS }, jobId: null }));

export function openCollectDialog(): void {
  useCollectUi.setState({ open: true });
}

export function closeCollectDialog(): void {
  useCollectUi.setState({ open: false });
}
