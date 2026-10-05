import { create } from 'zustand';

/** Small shell-level UI state (title bar). The project/state agent sets these. */
export interface ShellState {
  projectName: string;
  sequenceName: string | null;
  dirty: boolean;
  setProjectTitle(patch: Partial<Pick<ShellState, 'projectName' | 'sequenceName' | 'dirty'>>): void;
}

export const useShellStore = create<ShellState>()((set) => ({
  projectName: 'Untitled Project',
  sequenceName: null,
  dirty: false,
  setProjectTitle: (patch) => set(patch),
}));
