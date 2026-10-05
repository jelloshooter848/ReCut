import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Regression guard for bugs/closed/2026-10-05-nsis-installer-crash-system-dll.md.
//
// electron-builder < 26.12.0 generates a per-user installer whose multiUser.nsh copies the SHGetKnownFolderPath
// result with `System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'`: a fixed NSIS_MAX_STRLEN-wide read from a heap string
// of ~45 characters. When the string sits near the end of a heap region the read faults inside the NSIS System
// plugin (System.dll, offset 0x1581, 0xc0000005) and the installer dies before installing anything. Our config is
// exactly the affected mode (nsis.oneClick=false, nsis.perMachine=false), so the installed electron-builder's
// template must not contain that fixed-width read on the per-user path.
const require = createRequire(import.meta.url);
const appBuilderLib = path.dirname(require.resolve('app-builder-lib/package.json'));
const templates = path.join(appBuilderLib, 'templates', 'nsis');

/** System::Call struct reads of a fixed NSIS_MAX_STRLEN-wide string from a pointer (`*$N(&w${NSIS_MAX_STRLEN} ...)`). */
const FIXED_WIDTH_POINTER_READ = /System::Call\s+'\*\$\w+\(&w\$\{NSIS_MAX_STRLEN\}/;

describe('NSIS installer template (electron-builder)', () => {
  it('per-user install dir lookup does not read a fixed NSIS_MAX_STRLEN string from the SHGetKnownFolderPath buffer', () => {
    const multiUser = fs.readFileSync(path.join(templates, 'multiUser.nsh'), 'utf8');
    expect(multiUser).toContain('SHGetKnownFolderPath');
    const offending = multiUser.split(/\r?\n/).filter((line) => FIXED_WIDTH_POINTER_READ.test(line));
    expect(offending, `app-builder-lib ${require('app-builder-lib/package.json').version} multiUser.nsh`).toEqual([]);
  });

  it('no NSIS template reads a fixed NSIS_MAX_STRLEN string from a raw pointer', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(nsh|nsi)$/.test(e.name)) files.push(p);
      }
    };
    walk(templates);
    expect(files.length).toBeGreaterThan(5);
    const offending = files.flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .filter((line) => FIXED_WIDTH_POINTER_READ.test(line))
        .map((line) => `${path.relative(templates, f)}: ${line.trim()}`),
    );
    expect(offending).toEqual([]);
  });
});
