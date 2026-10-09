/**
 * The build configuration, the release workflow and the Windows scripts cannot import shared/productIdentity.ts
 * (package.json is static JSON read by electron-builder; the workflow is YAML). This suite keeps them equal to it, so
 * changing a value in the identity module fails here until every copy follows.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  APP_ID, LINUX_EXECUTABLE_NAME, PACKAGE_NAME, PRODUCT_AUTHOR, PRODUCT_FILE_NAME, PRODUCT_NAME, PROJECT_EXTENSIONS,
  PROJECT_FILE_TYPE_DESCRIPTION, PROJECT_FILE_TYPE_NAME, PROJECT_MIME_TYPE, RELEASE_ARTIFACT_NAMES, WINDOWS_INSTALLER_GUID,
} from '../../shared/productIdentity';

const repo = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read('package.json'));
const b = pkg.build;

describe('package.json follows the identity module', () => {
  it('names', () => {
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(pkg.productName).toBe(PRODUCT_FILE_NAME);
    expect(b.productName).toBe(PRODUCT_FILE_NAME);
    expect(pkg.author).toBe(PRODUCT_AUTHOR);
    expect(b.appId).toBe(APP_ID);
    expect(b.linux.executableName).toBe(LINUX_EXECUTABLE_NAME);
    expect(b.nsis.shortcutName).toBe(PRODUCT_NAME);
  });

  it('release file names', () => {
    expect(b.nsis.artifactName).toBe(RELEASE_ARTIFACT_NAMES.windowsSetup);
    expect(b.portable.artifactName).toBe(RELEASE_ARTIFACT_NAMES.windowsPortable);
    expect(b.appImage.artifactName).toBe(RELEASE_ARTIFACT_NAMES.linuxAppImage);
    expect(b.mac.artifactName).toBe(RELEASE_ARTIFACT_NAMES.macDmg);
    expect(b.dmg.artifactName).toBe(RELEASE_ARTIFACT_NAMES.macDmg);
  });

  it('file associations: every project extension, named and described from the display name', () => {
    const assoc = b.fileAssociations as { ext: string; name: string; description: string; role: string; mimeType: string }[];
    expect(assoc.map((a) => a.ext).sort()).toEqual([...PROJECT_EXTENSIONS].sort());
    for (const a of assoc) {
      // The OS file-type name (Windows ProgId text, macOS CFBundleTypeName) and description (Windows, Linux MIME comment).
      expect(a.name).toBe(PROJECT_FILE_TYPE_NAME);
      expect(a.description).toBe(PROJECT_FILE_TYPE_DESCRIPTION);
      expect(a.role).toBe('Editor');
    }
    // The original extension keeps its MIME type.
    expect(assoc.find((a) => a.ext === 'recut')?.mimeType).toBe(PROJECT_MIME_TYPE);
  });
});

describe('Windows upgrade path', () => {
  it('nsis.guid is pinned to the GUID electron-builder derives from the original appId', () => {
    expect(b.nsis.guid).toBe(WINDOWS_INSTALLER_GUID);
    // electron-builder's own derivation (app-builder-lib NsisTarget: UUID.v5(appId, ELECTRON_BUILDER_NS_UUID)).
    // The appId is the literal here on purpose: the pin must stay this value even if APP_ID ever changes.
    const req = createRequire(path.join(repo, 'node_modules', 'app-builder-lib', 'package.json'));
    const { UUID } = req('builder-util-runtime') as { UUID: { v5(name: string, ns: unknown): string; parse(s: string): unknown } };
    const nsis = read('node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
    const ns = /ELECTRON_BUILDER_NS_UUID = [\w.]+\.parse\("([0-9a-f-]+)"\)/.exec(nsis)?.[1];
    expect(ns).toBe('50e065bc-3134-11e6-9bab-38c9862bdaf3');
    expect(nsis).toMatch(/options\.guid \|\| [\w.]+\.UUID\.v5\(appInfo\.id, ELECTRON_BUILDER_NS_UUID\)/);
    expect(UUID.v5('app.recut.editor', UUID.parse(ns!))).toBe(WINDOWS_INSTALLER_GUID);
  });
});

/** Every name the text gives to a release file, artifact, executable or app bundle, with where it was found. */
function productTokens(text: string): { token: string; at: string }[] {
  const out: { token: string; at: string }[] = [];
  const patterns: RegExp[] = [
    /(?<![\w$.-])([A-Za-z][A-Za-z0-9]*)-(?:Setup|Portable)-/g, // <name>-Setup-<v>.exe, <name>-Portable-<v>.exe
    /(?<![\w$.-])([A-Za-z][A-Za-z0-9]*)-(?:windows|linux|macos)(?![\w-]*-x86_64)\b/g, // artifacts <name>-windows / -linux / -macos-<arch>
    /(?<![\w$.-])([A-Za-z][A-Za-z0-9]*)-(?:\*|\$v|\$\{version\}|[0-9][0-9.]*)-(?:linux-x86_64|macos-)/g, // <name>-<v>-linux-x86_64.AppImage, -macos-<arch>.dmg
    /(?<![\w$.-])([A-Za-z][A-Za-z0-9]*)\\?\.app\b/g, // <name>.app
    /win-unpacked[\\/]([A-Za-z][A-Za-z0-9]*)\.exe/g,
    /Contents\/MacOS\/([A-Za-z][A-Za-z0-9]*)/g,
  ];
  text.split('\n').forEach((line, i) => {
    for (const re of patterns) for (const m of line.matchAll(re)) out.push({ token: m[1], at: `${i + 1}: ${line.trim().slice(0, 120)}` });
  });
  return out;
}

describe('release workflow and scripts name the files the build makes', () => {
  for (const file of ['.github/workflows/windows.yml', 'scripts/windows/install-check.ps1', 'docs/RELEASING.md']) {
    it(file, () => {
      const tokens = productTokens(read(file));
      if (file.endsWith('windows.yml')) expect(tokens.length).toBeGreaterThan(30); // the patterns still find the names
      // Other things named like that: cache keys (whisper-windows-…), macOS apps the scripts use.
      const notProduct = new Set(['whisper', 'ffmpeg', 'Terminal']);
      const wrong = tokens.filter((t) => t.token !== PRODUCT_FILE_NAME && !notProduct.has(t.token));
      expect(wrong, `names other than ${PRODUCT_FILE_NAME}`).toEqual([]);
    });
  }

  it('the source launcher is "Start <product>.cmd", as the workflow calls it', () => {
    const launcher = `Start ${PRODUCT_NAME}.cmd`;
    expect(fs.existsSync(path.join(repo, launcher))).toBe(true);
    const wf = read('.github/workflows/windows.yml');
    for (const m of wf.matchAll(/Start ([A-Za-z0-9 ]+)\.cmd/g)) expect(m[0]).toBe(launcher);
  });

  it('install-check.ps1 reads the names from package.json (no hard-coded product name)', () => {
    const ps1 = read('scripts/windows/install-check.ps1');
    expect(ps1).toContain('$product = $pkg.build.productName');
    expect(ps1).toContain('$guid = $pkg.build.nsis.guid');
    expect(ps1).not.toContain(PRODUCT_NAME);
  });
});
