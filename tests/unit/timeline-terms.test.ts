/**
 * #145: the edit is called a Timeline everywhere the user sees it ("sequence" is kept for groups of scenes, #146).
 * Internal names (Sequence, project.sequences, command ids like 'sequence.new') are unchanged.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createProject } from '../../shared/project';

const ROOT = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Label / title string literals in a source file: label: '…', title: '…', cmd('…', …), label="…", title="…". */
function labels(file: string): string[] {
  const s = read(file);
  const out: string[] = [];
  for (const re of [/\b(?:label|title|heading)\s*:\s*'([^']*)'/g, /\b(?:label|title)="([^"]*)"/g, /\bcmd\('([^']*)'/g]) {
    for (const m of s.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const FILES = [
  'electron/menu.ts', 'src/keyboard/commands.ts', 'src/app/commands.ts', 'src/panels/project/menus.ts', 'src/panels/project/ProjectPanel.tsx',
  'src/app/dialogs/NewSequenceDialog.tsx', 'src/panels/inspector/SequenceInspector.tsx', 'src/panels/inspector/ClipInspector.tsx',
  'src/panels/export/ExportDialog.tsx', 'src/panels/compare/ComparePanel.tsx', 'src/panels/timeline/TimelinePanel.tsx',
];

describe('Timeline, not Sequence, in the UI (#145)', () => {
  it.each(FILES)('no menu / button / dialog label in %s says "sequence"', (file) => {
    const found = labels(file);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((l) => /\bsequences?\b/i.test(l))).toEqual([]);
  });

  it('a new project starts with "Timeline 01" in the "Timelines" bin', () => {
    const p = createProject();
    const seq = p.sequences[p.activeSequenceId!];
    expect(seq.name).toBe('Timeline 01');
    expect(p.bins[seq.binId!].name).toBe('Timelines');
  });
});
