/**
 * Command-line project path parsing (pure; unit-tested).
 *
 * Chromium re-orders argv (switches first, positionals last), so `recut --project <path>` can arrive
 * as `[..., --project, --allow-file-access-from-files, ..., main.js, <path>]`. Order of preference:
 *  1. the last positional argument ending in `.recut`;
 *  2. `--project=<path>`;
 *  3. `--project <path>`, only when the next token is not itself a switch.
 * Linux desktop entries pass files as `%U`, so a file manager may hand over a `file://` URI instead of a path:
 * local `file:` URIs are accepted as paths; any other URI is ignored.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProjectPath } from './io';

/** `cwd` resolves relative paths (the second instance's working directory). */
export function projectPathFromArgv(argv: string[], cwd?: string): string | null {
  let positional: string | null = null;
  let explicit: string | null = null;
  let spaced: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (typeof raw !== 'string' || !raw) continue;
    const a = localPath(raw);
    if (!a) continue;
    if (a.startsWith('--project=')) {
      const v = localPath(a.slice('--project='.length));
      if (v) explicit = v;
      continue;
    }
    if (a === '--project') {
      const next = argv[i + 1];
      const v = typeof next === 'string' ? localPath(next) : null;
      if (v && !v.startsWith('-')) spaced = v;
      continue; // the value (if any) is still considered as a positional below
    }
    if (!a.startsWith('-') && isProjectPath(a)) positional = a;
  }
  const pick = positional ?? explicit ?? spaced;
  return pick ? (cwd ? path.resolve(cwd, pick) : path.resolve(pick)) : null;
}

/** `p` itself, the local path of a `file:` URI, or null for any other URI or an unusable `file:` URI. */
function localPath(p: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
  if (!/^file:\/\//i.test(p)) return null;
  try {
    return fileURLToPath(p);
  } catch {
    return null; // e.g. file://otherhost/share/x.recut on Linux
  }
}
