/**
 * Command-line project path parsing (pure; unit-tested).
 *
 * Chromium re-orders argv (switches first, positionals last), so `recut --project <path>` can arrive
 * as `[..., --project, --allow-file-access-from-files, ..., main.js, <path>]`. Order of preference:
 *  1. the last positional argument ending in `.recut`;
 *  2. `--project=<path>`;
 *  3. `--project <path>`, only when the next token is not itself a switch.
 */
import path from 'node:path';
import { isProjectPath } from './io';

/** `cwd` resolves relative paths (the second instance's working directory). */
export function projectPathFromArgv(argv: string[], cwd?: string): string | null {
  let positional: string | null = null;
  let explicit: string | null = null;
  let spaced: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || !a) continue;
    if (a.startsWith('--project=')) {
      const v = a.slice('--project='.length);
      if (v) explicit = v;
      continue;
    }
    if (a === '--project') {
      const next = argv[i + 1];
      if (typeof next === 'string' && next && !next.startsWith('-')) spaced = next;
      continue; // the value (if any) is still considered as a positional below
    }
    if (!a.startsWith('-') && isProjectPath(a)) positional = a;
  }
  const pick = positional ?? explicit ?? spaced;
  return pick ? (cwd ? path.resolve(cwd, pick) : path.resolve(pick)) : null;
}
