/**
 * Guard: the app's source names the product only through shared/productIdentity.ts. Fails when the display name
 * (current or legacy) or the repository slug appears literally anywhere in `src/`, `electron/`, `shared/` or
 * index.html outside the identity module, comments included, so that changing the identity module renames the
 * whole app.
 *
 * Not scanned (allowed to name the product literally): docs, CHANGELOG.md, bugs/, test fixtures and tests, where a
 * literal is the point. The frozen identifiers (cache-key salts, `recut.*.v1` storage keys, the `recut-media://`
 * scheme, `window.__recut`, the `.recut` fixtures) are lower case and are not the display name.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_PRODUCT_NAMES, LEGACY_REPO_SLUGS, PRODUCT_NAME, REPO_SLUG } from '../../shared/productIdentity';

const repo = path.resolve(__dirname, '../..');
const IDENTITY_MODULE = 'shared/productIdentity.ts';
const SCANNED_DIRS = ['src', 'electron', 'shared'];
const SCANNED_FILES = ['index.html'];
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|css|html|json)$/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sourceFiles(): string[] {
  const out: string[] = [...SCANNED_FILES];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(repo, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (EXTENSIONS.test(e.name)) out.push(r);
    }
  };
  for (const d of SCANNED_DIRS) walk(d);
  return out.filter((f) => f !== IDENTITY_MODULE);
}

/** `file:line: text` for every line of the scanned sources matching `re`. */
function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of sourceFiles()) {
    fs.readFileSync(path.join(repo, f), 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) out.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return out;
}

describe('product name guard', () => {
  it('scans the app source', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('electron/main.ts');
    expect(files).toContain('src/app/commands.ts');
    expect(files).not.toContain(IDENTITY_MODULE);
  });

  it('no display name outside the identity module', () => {
    const names = [...new Set([PRODUCT_NAME, ...LEGACY_PRODUCT_NAMES])];
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escape).join('|')})(?![a-z0-9])`);
    expect(hits(re), `use PRODUCT_NAME from ${IDENTITY_MODULE}`).toEqual([]);
  });

  it('no repository slug outside the identity module', () => {
    const slugs = [...new Set([REPO_SLUG, ...LEGACY_REPO_SLUGS])];
    const re = new RegExp(slugs.map(escape).join('|'), 'i');
    expect(hits(re), `use REPO_SLUG from ${IDENTITY_MODULE}`).toEqual([]);
  });

  it('the guard itself catches a literal', () => {
    const re = new RegExp(`(?<![A-Za-z0-9])${escape(PRODUCT_NAME)}(?![a-z0-9])`);
    expect(re.test(`title: '${PRODUCT_NAME} is not responding'`)).toBe(true);
    expect(re.test(`// ${PRODUCT_NAME}.app/Contents`)).toBe(true);
    expect(re.test('window.recut, recut-media://, RecutApi')).toBe(false);
  });
});
