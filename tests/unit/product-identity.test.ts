/**
 * shared/productIdentity.ts and the code that reads it: project extensions (open, save, command line, autosave,
 * collect, untitled names), the environment-variable prefixes, the update-check URLs and the User-Agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENV_PREFIXES, LEGACY_ENV_PREFIXES, LEGACY_PROJECT_EXTENSIONS, LEGACY_REPO_SLUGS, PRODUCT_NAME, PROJECT_EXTENSION, PROJECT_EXTENSIONS,
  PROJECT_FILE_TYPE_NAME, REPO_SLUG, isProjectFilePath, projectFileFilters, projectSaveFilters, readPrefixedEnv, stripProjectExtension,
  userAgentProduct, withProjectExtension,
} from '../../shared/productIdentity';
import { envVar } from '../../electron/env';
import { ensureProjectExt, isProjectPath, loadProjectFile, saveProjectFile, untitledAutosavePath, writeAutosave, checkRecovery } from '../../electron/project/io';
import { projectPathFromArgv } from '../../electron/project/argv';
import { RELEASES_PAGE_URL, UPDATE_API_URL, UPDATE_LIST_API_URL, isReleasePageUrl, parseLatestRelease } from '../../shared/update';
import { projectNameFromPath } from '../../src/state/mediaActions';
import { PROJECT_FILTERS, PROJECT_SAVE_FILTERS } from '../../src/app/project';
import { createProject } from '../../shared/project';

describe('project extensions', () => {
  it('the primary extension is one that opens, listed first; every legacy one opens', () => {
    expect(PROJECT_EXTENSIONS[0]).toBe(PROJECT_EXTENSION);
    for (const e of LEGACY_PROJECT_EXTENSIONS) expect(PROJECT_EXTENSIONS).toContain(e);
    // Projects saved by every earlier release use .recut; it must open forever.
    expect(PROJECT_EXTENSIONS).toContain('recut');
  });

  it('isProjectFilePath / withProjectExtension / stripProjectExtension accept every extension, any case', () => {
    for (const e of PROJECT_EXTENSIONS) {
      expect(isProjectFilePath(`/a/b.${e}`)).toBe(true);
      expect(isProjectFilePath(`C:\\x\\B.${e.toUpperCase()}`)).toBe(true);
      expect(withProjectExtension(`/a/b.${e}`)).toBe(`/a/b.${e}`);
      expect(stripProjectExtension(`My Edit.${e}`)).toBe('My Edit');
    }
    expect(isProjectFilePath('/a/b.mp4')).toBe(false);
    expect(isProjectFilePath(`.${PROJECT_EXTENSION}`)).toBe(false); // a bare extension is not a file name
    expect(isProjectFilePath(`/a/b.${PROJECT_EXTENSION}.autosave`)).toBe(false);
    expect(withProjectExtension('/a/b')).toBe(`/a/b.${PROJECT_EXTENSION}`);
    expect(withProjectExtension('/a/b.json')).toBe(`/a/b.json.${PROJECT_EXTENSION}`);
    expect(stripProjectExtension('clip.mp4')).toBe('clip.mp4');
  });

  it('io and argv use them: a legacy extension keeps its name on save, a new file gets the primary', () => {
    for (const e of PROJECT_EXTENSIONS) {
      expect(isProjectPath(`/p/x.${e}`)).toBe(true);
      expect(ensureProjectExt(`/p/x.${e}`)).toBe(`/p/x.${e}`);
      expect(projectPathFromArgv(['/opt/app', '--flag', `/p/x.${e}`])).toBe(path.resolve(`/p/x.${e}`));
      expect(projectPathFromArgv([`file:///p/y.${e}`])).toBe(path.resolve(`/p/y.${e}`));
    }
    expect(ensureProjectExt('/p/x')).toBe(`/p/x.${PROJECT_EXTENSION}`);
    expect(projectPathFromArgv(['/opt/app', '/p/movie.mp4'])).toBeNull();
  });

  it('the untitled project name from a file drops any project extension', () => {
    for (const e of PROJECT_EXTENSIONS) expect(projectNameFromPath(`/a/My Edit.${e}`)).toBe('My Edit');
  });

  it('dialog filters: Open lists every extension, Save As only the primary, under the product file-type name', () => {
    expect(PROJECT_FILTERS).toEqual(projectFileFilters());
    expect(PROJECT_FILTERS).toEqual([{ name: PROJECT_FILE_TYPE_NAME, extensions: [...PROJECT_EXTENSIONS] }]);
    expect(PROJECT_SAVE_FILTERS).toEqual(projectSaveFilters());
    expect(PROJECT_SAVE_FILTERS).toEqual([{ name: PROJECT_FILE_TYPE_NAME, extensions: [PROJECT_EXTENSION] }]);
    expect(PROJECT_FILE_TYPE_NAME).toBe(`${PRODUCT_NAME} Project`);
  });

  describe('on disk', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-identity-')); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it('every extension saves, loads and autosaves; recovery finds autosaves next to each', async () => {
      const candidates: string[] = [];
      for (const e of PROJECT_EXTENSIONS) {
        const file = path.join(tmp, `p-${e}.${e}`);
        const project = createProject(`P ${e}`);
        const saved = await saveProjectFile(file, project);
        expect(saved).toEqual({ ok: true, path: file });
        const loaded = await loadProjectFile(file);
        expect(loaded.ok && loaded.project.name).toBe(`P ${e}`);
        expect((await writeAutosave(file, { ...project, name: `P ${e} autosaved` }, tmp)).ok).toBe(true);
        fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
        candidates.push(file);
      }
      const rec = await checkRecovery(tmp, candidates);
      expect(rec?.projectPath && isProjectPath(rec.projectPath)).toBe(true);
      expect(rec?.autosavePath).toBe(`${rec?.projectPath}.autosave`);
    });

    it('the untitled autosave keeps its file name (an earlier version\'s is still found)', () => {
      expect(path.basename(untitledAutosavePath(tmp))).toBe('untitled.recut.autosave');
    });
  });
});

describe('environment variables', () => {
  it('RECUT_ is always read; the first non-empty prefixed value wins', () => {
    expect(ENV_PREFIXES).toContain('RECUT_');
    expect(LEGACY_ENV_PREFIXES).toContain('RECUT_');
    expect(readPrefixedEnv({ RECUT_CACHE_DIR: '/c' }, 'CACHE_DIR')).toBe('/c');
    expect(readPrefixedEnv({ RECUT_CACHE_DIR: '' }, 'CACHE_DIR')).toBeUndefined();
    expect(readPrefixedEnv({}, 'CACHE_DIR')).toBeUndefined();
    expect(envVar('UPDATE_CHECK', { RECUT_UPDATE_CHECK: '0' })).toBe('0');
    // Every prefix in the list is read, in order.
    const env: Record<string, string> = {};
    ENV_PREFIXES.forEach((p, i) => { env[`${p}X_TEST`] = String(i); });
    expect(readPrefixedEnv(env, 'X_TEST')).toBe('0');
    const last = ENV_PREFIXES[ENV_PREFIXES.length - 1];
    expect(readPrefixedEnv({ [`${last}X_TEST`]: 'legacy' }, 'X_TEST')).toBe('legacy');
  });

  it('no RECUT_ variable is read directly in app code (always through electron/env.ts)', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (/process\.env(\.|\[\s*['"`])RECUT_/.test(line)) offenders.push(`${path.relative(root, p)}:${i + 1}`);
          });
        }
      }
    };
    for (const d of ['electron', 'shared', 'src']) walk(path.join(root, d));
    expect(offenders).toEqual([]);
  });
});

describe('update check and links', () => {
  it('the URLs name the repository slug', () => {
    expect(UPDATE_API_URL).toBe(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`);
    expect(UPDATE_LIST_API_URL).toBe(`https://api.github.com/repos/${REPO_SLUG}/releases?per_page=10`);
    expect(RELEASES_PAGE_URL).toBe(`https://github.com/${REPO_SLUG}/releases`);
  });

  it('release pages of the current and every legacy slug are accepted; others are not', () => {
    for (const slug of [REPO_SLUG, ...LEGACY_REPO_SLUGS]) {
      expect(isReleasePageUrl(`https://github.com/${slug}/releases`)).toBe(true);
      expect(isReleasePageUrl(`https://github.com/${slug}/releases/tag/v1.2.3`)).toBe(true);
      expect(parseLatestRelease({ tag_name: 'v9.0.0', html_url: `https://github.com/${slug}/releases/tag/v9.0.0` }))
        .toEqual({ ok: true, release: { version: '9.0.0', url: `https://github.com/${slug}/releases/tag/v9.0.0` } });
    }
    expect(isReleasePageUrl('https://github.com/someone/else/releases')).toBe(false);
    // The slug is matched literally, not as a pattern.
    expect(isReleasePageUrl(`https://github.com/${REPO_SLUG.replace(/.$/, 'x')}/releases`)).toBe(false);
  });

  it('the User-Agent product token', () => {
    expect(userAgentProduct('1.2.3')).toBe(`${PRODUCT_NAME.replace(/\s/g, '')}/1.2.3`);
    expect(userAgentProduct('1.2.3')).toMatch(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/1\.2\.3$/);
  });
});
