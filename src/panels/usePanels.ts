import { useSyncExternalStore } from 'react';
import { getPanels, subscribePanels, getPanel } from './registry';

export function usePanels() { return useSyncExternalStore(subscribePanels, getPanels, getPanels); }
export function usePanel(id: string) {
  useSyncExternalStore(subscribePanels, getPanels, getPanels);
  return getPanel(id);
}
