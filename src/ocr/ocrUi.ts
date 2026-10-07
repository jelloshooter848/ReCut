/**
 * Open state of the OCR dialogs (store.ui.dialogs flags are plain booleans, so dialogs that carry their own
 * options live here). `openOcrLanguages()` shows the OCR Languages dialog, optionally scrolled to one language.
 */
import { create } from 'zustand';

export interface OcrUiState {
  /** The OCR Languages dialog is open. */
  languagesOpen: boolean;
  /** Language code to highlight when it opens. */
  focusCode: string | null;
}

export const useOcrUi = create<OcrUiState>()(() => ({ languagesOpen: false, focusCode: null }));

export function openOcrLanguages(focusCode?: string): void {
  useOcrUi.setState({ languagesOpen: true, focusCode: focusCode ?? null });
}

export function closeOcrLanguages(): void {
  useOcrUi.setState({ languagesOpen: false, focusCode: null });
}
