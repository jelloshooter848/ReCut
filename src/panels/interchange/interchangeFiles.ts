/**
 * Pure helpers of the Export Timeline dialog (File › Export Timeline…): the default file name, where each file of
 * an `exportTimeline` result goes given the path picked in the save dialog, and the report's issue groups.
 * No DOM, no Node (the renderer has no `path` module): paths are split on both `/` and `\`.
 */
import { safeFileName } from '@shared/collect';
import type { InterchangeFile, InterchangeIssue } from '@shared/interchange';

/** Default name offered by the save dialog: the sequence name made safe, with the format's extension. */
export function defaultTimelineFileName(sequenceName: string, extension: string): string {
  return `${safeFileName(sequenceName.trim() || 'Timeline')}.${extension}`;
}

/** Split a path picked in the native dialog into its folder and file name. */
export function splitPickedPath(p: string): { folder: string; name: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return { folder: '', name: p };
  // Keep the root separator ("/x.edl" -> "/", "C:\x.edl" -> "C:\").
  const folder = i === 0 || /^[A-Za-z]:$/.test(p.slice(0, i)) ? p.slice(0, i + 1) : p.slice(0, i);
  return { folder, name: p.slice(i + 1) };
}

const SEPARATORS = /[ _.-]/;

/**
 * The part of each file name after the stem the files share, cut back to a separator so the stem is a whole word
 * ("Cut_V1.edl", "Cut_V2.edl" -> "_V1.edl", "_V2.edl"). Null unless every suffix is non-empty and distinct.
 */
function distinctSuffixes(names: readonly string[]): string[] | null {
  let prefix = names[0] ?? '';
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  // The stem ends where every name goes on with a separator; that separator stays in the suffix.
  let cut = prefix.length;
  while (cut > 0 && !names.every((n) => SEPARATORS.test(n[cut] ?? ''))) cut--;
  while (cut > 0 && SEPARATORS.test(prefix[cut - 1])) cut--;
  const suffixes = names.map((n) => n.slice(cut));
  if (suffixes.some((s) => !s) || new Set(suffixes.map((s) => s.toLowerCase())).size !== suffixes.length) return null;
  return suffixes;
}

/**
 * Where the files of a result go, given the path picked in the save dialog (`picked`). One file: the picked name
 * (with the extension added when the dialog left it out). Several files (EDL, one per video track): the picked
 * name without its extension is the base, and each file keeps the part of its own name that tells it apart
 * ("<base>_V1.edl", "<base>_V2.edl"), or is numbered when the names do not say.
 */
export function interchangeTargets(picked: string, files: readonly InterchangeFile[], extension: string): { folder: string; names: string[] } {
  const { folder, name } = splitPickedPath(picked);
  const ext = `.${extension}`;
  const hasExt = name.toLowerCase().endsWith(ext.toLowerCase());
  if (files.length <= 1) return { folder, names: [hasExt ? name : `${name}${ext}`] };
  const base = hasExt ? name.slice(0, -ext.length) : name;
  const suffixes = distinctSuffixes(files.map((f) => f.name));
  return {
    folder,
    names: files.map((f, i) => {
      const s = suffixes?.[i];
      if (s) return `${base}${SEPARATORS.test(s[0]) ? '' : '_'}${s.toLowerCase().endsWith(ext.toLowerCase()) ? s : `${s}${ext}`}`;
      return `${base}_${i + 1}${ext}`;
    }),
  };
}

export interface IssueGroup { severity: InterchangeIssue['severity']; title: string; issues: InterchangeIssue[] }

/** The report's issue groups: warnings (lost or approximated) first, then info (transferred in another form); empty groups left out. */
export function groupIssues(issues: readonly InterchangeIssue[]): IssueGroup[] {
  const groups: IssueGroup[] = [
    { severity: 'warning', title: 'Lost or approximated', issues: issues.filter((i) => i.severity === 'warning') },
    { severity: 'info', title: 'Transferred in another form', issues: issues.filter((i) => i.severity === 'info') },
  ];
  return groups.filter((g) => g.issues.length > 0);
}
