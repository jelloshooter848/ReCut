import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .github/workflows/windows.yml: only real versions (vX.Y.Z) may appear on the GitHub Releases page (owner's
// decision, 7 October 2026). Every other run is a test build: every gate runs and the installers stay as the run's
// ReCut-windows artifact, but no tag, release or prerelease is created. There is no YAML library in the project, so
// these checks work on the text (job blocks are cut at two-space indentation, comments are dropped).

const repo = fileURLToPath(new URL('../..', import.meta.url));
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/windows.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The workflow's lines without comment-only lines (comments describe the behaviour; the assertions are about code). */
function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** The block of job `name` under `jobs:`, from `  name:` to the next two-space-indented key (or end of file). */
function job(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThan(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]) && !/^ {2}#/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** The value of the job-level `if:` (four-space indentation) of a job block. */
function jobIf(block: string): string | undefined {
  return /^ {4}if: (.+)$/m.exec(block)?.[1].trim();
}

describe('Windows workflow: no dev prereleases', () => {
  const publish = code(job('publish'));
  const installer = code(job('installer'));

  it('the publish job runs only for a real release and only after every gate passed', () => {
    expect(jobIf(publish)).toBe("needs.installer.outputs.release == 'true'");
    expect(publish).toMatch(/^ {4}needs: \[installer, tests, e2e, launcher, linux\]$/m);
    // No status function: the implicit success() keeps a red, cancelled or skipped gate from publishing.
    expect(publish).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
  });

  it('the publish job publishes a full release or a release candidate, never a -dev. tag', () => {
    expect(publish).toContain('softprops/action-gh-release');
    // Pre-release and Latest come only from the final check, which derives them from the tag (see "Release candidates").
    expect(publish).toMatch(/^\s+prerelease: \$\{\{ steps\.pub\.outputs\.prerelease \}\}$/m);
    expect(publish).toMatch(/^\s+make_latest: \$\{\{ steps\.pub\.outputs\.make_latest \}\}$/m);
    expect(publish).not.toMatch(/prerelease:\s*true/);
    expect(publish).not.toContain('-dev.');
    expect(publish).not.toMatch(/DEV_|dev_(tag|name|notes)|dev-notes/);
    // The final check refuses anything but a semver tag (with at most a pre-release part).
    expect(publish).toContain("-cnotmatch '^v\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'");
  });

  it('a tag that appeared during the build publishes nothing (warning, success)', () => {
    expect(publish).toMatch(/::warning::Tag \$env:TAG was created while this run was building: .*already released/);
    expect(publish).toContain("$publish = 'false'");
    expect(publish).toMatch(/- name: Publish GitHub Release\n\s+if: steps\.pub\.outputs\.publish == 'true'\n\s+uses: softprops\/action-gh-release/);
  });

  it('only the tag-push fallback and the automatic release on main set release=true', () => {
    expect(installer).toContain('release: ${{ steps.rel.outputs.release }}');
    expect(installer).toContain("$release = 'false'; $auto = 'false'");
    expect(installer.match(/\$release = 'true'/g)).toHaveLength(2);
    expect(installer).toMatch(/\$release = 'true'; \$auto = 'true'/);
    expect(installer).toMatch(/if \(\$env:REF_TYPE -eq 'tag'\)[\s\S]*?\$release = 'true'\n\s+\} elseif/);
  });

  it('every run keeps the installers as the ReCut-windows artifact, and a test build says where to find them', () => {
    const upload = /- uses: actions\/upload-artifact@v4\n((?:\s{8,}.*\n)+)/g;
    const artifacts = [...installer.matchAll(upload)].map((m) => m[0]);
    const recut = artifacts.find((a) => /name: ReCut-windows\n/.test(a));
    expect(recut).toBeDefined();
    expect(recut).not.toMatch(/^\s+if:/m);
    expect(recut).toMatch(/retention-days: \d+/);
    expect(installer).toMatch(/- name: Test build summary\n\s+if: steps\.rel\.outputs\.release != 'true'/);
    expect(installer).toContain('GITHUB_STEP_SUMMARY');
    expect(installer).toContain("Test build: download the installers from this run's Artifacts (ReCut-windows).");
  });

  it('nothing in the workflow creates -dev. tags any more, and no gate may fail', () => {
    const all = code(workflow);
    expect(all).not.toContain('-dev.');
    expect(all).not.toMatch(/dev_(tag|name|notes)|dev-notes\.md/);
    expect(all).not.toMatch(/continue-on-error/);
  });
});

// The Linux AppImage gate (docs/ROADMAP.md §19, release 0.6.1): a required job in the same workflow, whose AppImage
// the publish job attaches next to the Windows files.
describe('Windows workflow: the Linux AppImage gate', () => {
  const linux = code(job('linux'));
  const publish = code(job('publish'));
  const installer = code(job('installer'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

  it('runs on every run, like the Windows gates, on a pinned Ubuntu image', () => {
    expect(jobIf(linux)).toBeUndefined();
    expect(linux).toMatch(/^ {4}runs-on: ubuntu-22\.04$/m);
  });

  it('runs the unit tests and the e2e suite (xvfb) with the bundled FFmpeg, then packages the AppImage', () => {
    expect(linux).toContain('./scripts/linux/get-ffmpeg.sh --dest resources/ffmpeg');
    expect(linux).toContain('npx vitest run');
    expect(linux).toContain('xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts');
    expect(linux).toContain('npx electron-builder --linux AppImage --x64 --publish never');
    // FFmpeg before the tests, the tests before packaging.
    expect(linux.indexOf('get-ffmpeg.sh')).toBeLessThan(linux.indexOf('npx vitest run'));
    expect(linux.indexOf('playwright test')).toBeLessThan(linux.indexOf('electron-builder --linux'));
  });

  it('smoke-tests the AppImage (mounted and extracted) and fails on any missing line', () => {
    expect(linux).toContain('--appimage-extract-and-run');
    expect(linux).toContain('RECUT_SMOKE=1');
    for (const want of [
      'smoke: protocol status=206 ',
      'smoke: ffmpeg encode\\+probe ok ',
      '/(\\.mount_[^/ ]+|appimage_extracted_[^/ ]+)/resources/ffmpeg/ffmpeg ',
      'FFMPEG-BUILD\\.txt,FFMPEG-LICENSE\\.txt',
      'smoke: ocr core=(relaxedsimd-lstm|lstm) ok worker=.*app\\.asar\\.unpacked',
      'layout=mounted',
    ]) {
      expect(linux, want).toContain(want);
    }
    expect(linux).toContain("grep -E 'FAILED|layout=MISSING'");
    expect(linux).toContain('exit "$bad"');
    // A stalled package mirror never blocks a release: without libfuse2 the smoke test runs the extracted AppImage only.
    expect(linux).toContain("modes='mounted extracted'");
    expect(linux).toContain("modes='extracted'");
    expect(linux).toMatch(/timeout \d+ sudo apt-get/);
    expect(linux).not.toMatch(/^\s+sudo apt-get update$/m);
  });

  it('keeps the AppImage as the ReCut-linux artifact on every run', () => {
    const upload = /- uses: actions\/upload-artifact@v4\n((?:\s{8,}.*\n)+)/g;
    const artifact = [...linux.matchAll(upload)].map((m) => m[0]).find((a) => /name: ReCut-linux\n/.test(a));
    expect(artifact).toBeDefined();
    expect(artifact).not.toMatch(/^\s+if:/m);
    expect(artifact).toContain('path: release/ReCut-*-linux-x86_64.AppImage');
    expect(artifact).toMatch(/retention-days: \d+/);
    expect(linux).toContain('GITHUB_STEP_SUMMARY');
  });

  it('the publish job attaches the AppImage, and the release notes say how to run it', () => {
    expect(publish).toMatch(/- uses: actions\/download-artifact@v4\n\s+with:\n\s+name: ReCut-linux\n\s+path: release\n/);
    expect(publish).toMatch(/files: \|\n(?:\s+release\/.*\n)*\s+release\/ReCut-\*-linux-x86_64\.AppImage\n/);
    expect(installer).toContain('**ReCut-$v-linux-x86_64.AppImage**');
    expect(installer).toContain('chmod +x');
    expect(installer).toContain('libfuse2');
    expect(installer).toContain('--appimage-extract-and-run');
  });

  it('package.json names the AppImage as the workflow expects, distinct from the Windows files', () => {
    expect(pkg.build.appImage.artifactName).toBe('ReCut-${version}-linux-x86_64.${ext}');
    expect(pkg.build.linux.target).toEqual([{ target: 'AppImage', arch: ['x64'] }]);
    expect(pkg.build.nsis.artifactName).toBe('ReCut-Setup-${version}.${ext}');
    expect(pkg.build.portable.artifactName).toBe('ReCut-Portable-${version}.${ext}');
  });

  it('get-ffmpeg.sh writes the same licence, readme and build files as get-ffmpeg.ps1', () => {
    const sh = fs.readFileSync(path.join(repo, 'scripts/linux/get-ffmpeg.sh'), 'utf8').replace(/\r\n/g, '\n'); // CRLF on a Windows checkout
    expect(sh.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(sh).toContain('set -euo pipefail');
    for (const f of ['FFMPEG-LICENSE.txt', 'FFMPEG-README.txt', 'FFMPEG-BUILD.txt']) expect(sh).toContain(`'${f}'`);
    expect(sh).toContain("'Platform:        x86-64 Linux'");
    // Release-branch builds only: no development ("master") builds.
    expect(sh).not.toMatch(/master-latest/);
  });
});

describe('speech-to-text engine in CI (Roadmap §5)', () => {
  const wf = workflow; // CRLF already normalised (a Windows checkout)
  const jobText = (name: string) => {
    const lines = wf.split('\n');
    const start = lines.findIndex((l) => l === `  ${name}:`);
    const end = lines.findIndex((l, i) => i > start && /^  [a-z][a-z-]*:$/.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  };

  it('every job that bundles or tests the engine builds it from the pinned source, cached', () => {
    for (const job of ['installer', 'tests', 'e2e']) {
      expect(jobText(job), job).toContain('./scripts/windows/get-whisper.ps1 -Dest resources/whisper');
      expect(jobText(job), job).toContain("hashFiles('scripts/whisper-source.mjs', 'scripts/windows/get-whisper.ps1')");
    }
    expect(jobText('linux')).toContain('./scripts/linux/get-whisper.sh --dest resources/whisper');
    expect(jobText('linux')).toContain("hashFiles('scripts/whisper-source.mjs', 'scripts/linux/get-whisper.sh')");
    for (const job of ['macos', 'macos-e2e']) {
      expect(jobText(job), job).toContain('./scripts/mac/get-whisper.sh --dest resources/whisper');
      expect(jobText(job), job).toContain("hashFiles('scripts/whisper-source.mjs', 'scripts/mac/get-whisper.sh')");
    }
    // The macOS dmg ships the engine: checked inside the mounted app, and its smoke line is required.
    expect(jobText('macos')).toContain('- name: Bundled speech-to-text engine');
    expect(jobText('macos')).toContain("'smoke: whisper engine=[0-9.]+ ok path=[^ ]*/recut-dmg/ReCut\\.app/Contents/Resources/whisper/whisper-cli$'");
  });

  it('the smoke tests require the engine line, and the packages stay within the budget with no model', () => {
    expect(jobText('installer')).toContain("'whisper engine=[0-9.]+ ok path=.*resources\\\\whisper\\\\whisper-cli\\.exe'");
    expect(jobText('linux')).toContain("'smoke: whisper engine=[0-9.]+ ok path=");
    for (const job of ['installer', 'linux']) {
      expect(jobText(job), job).toContain('Speech-to-text packaging budget');
      expect(jobText(job), job).toMatch(/16 MB/);
    }
    const check = fs.readFileSync(path.join(repo, 'scripts', 'windows', 'install-check.ps1'), 'utf8');
    expect(check.match(/whisper engine=\[0-9\.\]\+ ok/g)).toHaveLength(2);
  });

  it('the Windows engine build finds Visual Studio with vswhere instead of naming a generator', () => {
    const ps1 = fs.readFileSync(path.join(repo, 'scripts', 'windows', 'get-whisper.ps1'), 'utf8');
    expect(ps1).toContain('vswhere.exe');
    expect(ps1).toContain('Enter-VsDevShell');
    expect(ps1).not.toMatch(/-G\s+'Visual Studio/);
    expect(ps1).toContain('$env:VCToolsRedistDir');
  });

  it('CI downloads only the pinned tiny model, checked against its SHA-256 and cached', () => {
    const linux = jobText('linux');
    expect(linux).toContain('ggml-tiny.bin');
    expect(linux).toContain('sha256sum -c');
    expect(wf).not.toMatch(/ggml-(base|small|medium|large)[a-z0-9.-]*\.bin/);
  });
});

// The macOS dmg (docs/ROADMAP.md §19, release 0.7.0): during bring-up the macos and macos-e2e jobs are ADVISORY. They
// run on every run, but publish does not need them and does not attach the dmg (docs/MACOS-SIGNING.md for signing).
describe('Windows workflow: the macOS dmg job (advisory during bring-up)', () => {
  const macos = code(job('macos'));
  const macosE2e = code(job('macos-e2e'));
  const publish = code(job('publish'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const script = fs.readFileSync(path.join(repo, 'scripts/mac/get-ffmpeg.sh'), 'utf8').replace(/\r\n/g, '\n'); // CRLF on a Windows checkout

  it('runs on every run on an Apple Silicon runner, and the e2e suite runs in its own job', () => {
    expect(jobIf(macos)).toBeUndefined();
    expect(macos).toMatch(/^ {4}runs-on: macos-14$/m);
    expect(jobIf(macosE2e)).toBeUndefined();
    expect(macosE2e).toMatch(/^ {4}runs-on: macos-14$/m);
    expect(macosE2e).toContain('./scripts/mac/get-ffmpeg.sh --dest "$RUNNER_TEMP/ff"');
    expect(macosE2e).toContain('npx playwright test -c tests/e2e/playwright.config.ts');
  });

  it('is not a release gate yet: publish neither needs it nor attaches the dmg, and a TODO says how to change that', () => {
    expect(publish).toMatch(/^ {4}needs: \[installer, tests, e2e, launcher, linux\]$/m);
    expect(publish).not.toContain('ReCut-macos');
    expect(publish).not.toContain('.dmg');
    expect(workflow).toContain('# TODO(0.7.0, when macOS becomes official');
    expect(workflow).toContain('#   1. needs: [installer, tests, e2e, launcher, linux, macos, macos-e2e]');
    expect(workflow).toMatch(/^\s+#.*\brelease\/ReCut-\*-macos-arm64\.dmg/m);
    expect(workflow).toMatch(/^\s+#\s+name: ReCut-macos$/m);
    // The Windows and Linux summaries say which jobs must be green: the five gates, not the advisory macOS jobs.
    for (const block of [code(job('installer')), code(job('linux'))]) {
      expect(block).toContain('the required jobs of this run (installer, tests, e2e, launcher, linux) are green');
      expect(block).not.toContain('every job in this run is green');
    }
  });

  it('tests with the bundled arm64 FFmpeg, then packages the arm64 dmg, signed only when all secrets are set', () => {
    expect(macos).toContain('./scripts/mac/get-ffmpeg.sh --dest resources/ffmpeg');
    expect(macos).toContain('npx vitest run');
    expect(macos.indexOf('get-ffmpeg.sh')).toBeLessThan(macos.indexOf('npx vitest run'));
    expect(macos.indexOf('npx vitest run')).toBeLessThan(macos.indexOf('electron-builder --mac'));
    // Signed: electron-builder signs, notarizes (APPLE_API_KEY = path of the decoded .p8) and staples.
    expect(macos).toContain('APPLE_API_KEY="$APPLE_API_KEY_PATH" npx electron-builder --mac dmg --arm64 --publish never');
    // Unsigned: no identity discovery, ad-hoc signature, hardened runtime off (a real boolean false).
    expect(macos).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --publish never \\\n\s+-c\.mac\.identity=- -c\.mac\.timestamp=none --no-config\.mac\.hardenedRuntime/);
    expect(macos).not.toMatch(/hardenedRuntime=false/);
    expect(macos).toContain("echo 'signed=false' >> \"$GITHUB_OUTPUT\"");
    expect(macos).toContain('if [ "$have" -ne 5 ]; then');
  });

  it('takes the five signing secrets only through env, and never prints them', () => {
    for (const s of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
      expect(macos).toContain(`secrets.${s} }}`);
    }
    const secretLines = macos.split('\n').filter((l) => l.includes('secrets.'));
    for (const l of secretLines) expect(l, l).toMatch(/^\s+[A-Z][A-Z0-9_]*: \$\{\{ .*secrets\.[A-Z_]+.* \}\}$/);
    expect(macos).not.toMatch(/(echo|printf)[^\n]*\$\{?(CSC_LINK|CSC_KEY_PASSWORD|APPLE_API_KEY_ID|APPLE_API_ISSUER)\b/);
    expect(macos).not.toMatch(/set -x|::add-mask::/);
    // The decoded key lives in a private temp folder that is removed after packaging.
    expect(macos).toContain('rm -rf "$RUNNER_TEMP/recut-notary"');
    // No other job sees them.
    expect(code(workflow).match(/secrets\.(CSC_|APPLE_)/g)?.length).toBe(macos.match(/secrets\.(CSC_|APPLE_)/g)?.length);
  });

  it('checks every Mach-O signature, and Gatekeeper and the stapled ticket when signed', () => {
    expect(macos).toContain('codesign --verify --deep --strict --verbose=2 "$APP"');
    expect(macos).toContain("grep -q '^Authority=Developer ID Application: '");
    expect(macos).toContain('runtime');
    expect(macos).toContain("grep -q '^Timestamp='");
    expect(macos).toContain("grep -q '^Signature=adhoc'");
    expect(macos).toContain('spctl -a -vv -t exec "$APP"');
    expect(macos).toContain('source=Notarized Developer ID');
    expect(macos).toContain('xcrun stapler validate "$APP"');
  });

  it('smoke-tests the app inside the mounted dmg and fails on any missing line', () => {
    expect(macos).toContain('hdiutil attach -nobrowse -readonly');
    expect(macos).toContain('RECUT_SMOKE=1');
    expect(macos).toContain('"$APP/Contents/MacOS/ReCut" &');
    for (const want of [
      'smoke: protocol status=206 ',
      'smoke: ffmpeg encode\\+probe ok ',
      '/recut-dmg/ReCut\\.app/Contents/Resources/ffmpeg/ffmpeg ',
      'FFMPEG-BUILD\\.txt,FFMPEG-LICENSE\\.txt',
      'smoke: ocr core=(relaxedsimd-lstm|lstm) ok worker=.*app\\.asar\\.unpacked',
      'layout=mounted',
    ]) {
      expect(macos, want).toContain(want);
    }
    expect(macos).toContain("grep -E 'FAILED|layout=MISSING'");
    expect(macos).toContain('exit "$bad"');
    expect(macos).toContain("grep -q '^Platform: *arm64 macOS$'");
  });

  it('keeps the dmg as the ReCut-macos artifact on every run, with a job summary', () => {
    const upload = /- uses: actions\/upload-artifact@v4\n((?:\s{8,}.*\n)+)/g;
    const artifact = [...macos.matchAll(upload)].map((m) => m[0]).find((a) => /name: ReCut-macos\n/.test(a));
    expect(artifact).toBeDefined();
    expect(artifact).not.toMatch(/^\s+if:/m);
    expect(artifact).toContain('path: release/ReCut-*-macos-arm64.dmg');
    expect(artifact).toMatch(/retention-days: 14/);
    expect(macos).toContain('GITHUB_STEP_SUMMARY');
  });

  it('package.json builds an arm64 dmg with the hardened runtime and a minimal entitlement set', () => {
    const mac = pkg.build.mac;
    expect(mac.target).toEqual([{ target: 'dmg', arch: ['arm64'] }]);
    expect(mac.artifactName).toBe('ReCut-${version}-macos-arm64.${ext}');
    expect(pkg.build.dmg.artifactName).toBe(mac.artifactName);
    expect(mac.category).toBe('public.app-category.video');
    expect(mac.hardenedRuntime).toBe(true);
    expect(mac.publish).toBeNull();
    expect(mac).not.toHaveProperty('identity');
    // The minimum macOS is the bundled FFmpeg's (scripts/mac/get-ffmpeg.sh checks the binaries against it).
    expect(script).toContain(`min_macos='${mac.minimumSystemVersion}'`);
    // Electron's and Chromium's licences ship inside the app (electron-builder leaves them out on macOS).
    expect(mac.extraResources).toEqual(expect.arrayContaining([
      { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE.electron.txt' },
      { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html' },
    ]));
    for (const f of [mac.entitlements, mac.entitlementsInherit]) {
      const plist = fs.readFileSync(path.join(repo, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      expect(plist, f).toContain('<key>com.apple.security.cs.allow-jit</key>');
      expect(plist.match(/<key>/g), f).toHaveLength(1);
    }
    expect(pkg.build.fileAssociations.map((a: { ext: string }) => a.ext)).toContain('recut');
  });

  it('get-ffmpeg.sh for macOS pins its downloads and writes the same licence, readme and build files', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    for (const f of ['FFMPEG-LICENSE.txt', 'FFMPEG-README.txt', 'FFMPEG-BUILD.txt']) expect(script).toContain(`'${f}'`);
    expect(script).toContain("echo 'Platform:        arm64 macOS'");
    expect(script).toContain("echo 'Corresponding source'");
    expect(script).toContain('--skip-run');
    expect(script).not.toMatch(/master-latest|\/latest\//);
    // Every source: a versioned release URL, the archive's SHA-256, a licence URL at the same tag and its SHA-256.
    const entries = [...script.matchAll(/^ {2}"(\$jf\/releases\/download\/(v[\d.]+-\d+)\/[^|"]+)\|([0-9a-f]{64})\|(\$jf_raw\/(v[\d.]+-\d+)\/COPYING\.GPLv3)\|([0-9a-f]{64})\|(v[\d.]+-\d+)"$/gm)];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(e[2]).toBe(e[5]);
      expect(e[2]).toBe(e[7]);
      expect(e[1]).toMatch(/_portable_macarm64-gpl\.tar\.xz$/);
    }
  });
});

// Release candidates (docs/RELEASING.md, Release candidates): a package.json version with a SemVer pre-release part
// (1.0.0-rc.1) and a "## [1.0.0-rc.1]" CHANGELOG.md section is published like a release, with the same gates and
// files, but marked pre-release and never Latest. Stable versions are unchanged. The PowerShell regexes below are
// taken from the workflow text and run with JavaScript's engine (they use only syntax both engines read the same way).
describe('Windows workflow: release candidates', () => {
  const installer = code(job('installer'));
  const publish = code(job('publish'));

  /** The single-quoted PowerShell string assigned to `$name` in `block`. */
  const psString = (block: string, name: string): string => {
    const m = new RegExp(`\\$${name} = '([^']*)'`).exec(block);
    expect(m, `$${name}`).not.toBeNull();
    return m![1];
  };
  /** .NET [regex]::Escape for a version string (only '.', '+' and the like can occur). */
  const escape = (s: string) => s.replace(/[\\*+?|{}[\]()^$.#\s]/g, '\\$&');

  it('accepts MAJOR.MINOR.PATCH and SemVer pre-release versions, and nothing else', () => {
    const semver = new RegExp(psString(installer, 'semver'));
    expect(installer).toContain('if ($v -cnotmatch $semver) {');
    for (const ok of ['0.7.0', '1.0.0', '10.20.30', '1.0.0-rc.1', '1.0.0-rc.10', '2.0.0-beta.2', '1.0.0-0.3.7', '1.0.0-x-y']) {
      expect(semver.test(ok), ok).toBe(true);
    }
    for (const bad of ['1.0', '1.0.0.0', '01.0.0', '1.00.0', 'v1.0.0', '1.0.0-', '1.0.0-rc.01', '1.0.0-rc..1', '1.0.0+build.1', '1.0.0-rc.1+b', ' 1.0.0', '1.0.0 ']) {
      expect(semver.test(bad), bad).toBe(false);
    }
  });

  it('a version with a pre-release part makes the release a pre-release; the outputs carry it to publish', () => {
    expect(installer).toContain("$prerelease = if ($v.Contains('-')) { 'true' } else { 'false' }");
    expect(installer).toContain("$core = ($v -split '-', 2)[0]");
    expect(installer).toContain('prerelease: ${{ steps.rel.outputs.prerelease }}');
    expect(installer).toMatch(/"prerelease=\$prerelease"/);
    // The release itself is decided exactly as before: the tag-push fallback and the automatic release on main.
    expect(installer.match(/\$release = 'true'/g)).toHaveLength(2);
    // A pre-release's notes start with a note saying what it is.
    expect(installer).toMatch(/\$preNote = "\*\*Pre-release: a release candidate of ReCut \$core, for testing\.\*\*/);
    expect(installer).toContain("if ($prerelease -eq 'true') { $section = \"$preNote`n`n$section\" }");
  });

  /** A JavaScript port of the step's Get-ChangelogSection, built from the regexes in the workflow text. */
  function changelogSection(changelog: string, ver: string): string | null {
    const headMatch = /\$head = '([^']*)' \+ \[regex\]::Escape\(\$ver\) \+ '([^']*)'/.exec(installer);
    expect(headMatch).not.toBeNull();
    const head = new RegExp(headMatch![1] + escape(ver) + headMatch![2]);
    expect(installer).toContain("elseif ($lines[$i] -match '^## \\[' -or $lines[$i] -match '^\\[[^\\]]+\\]:\\s') { $end = $i; break }");
    const next = [/^## \[/, /^\[[^\]]+\]:\s/];
    const lines = changelog.split('\n');
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (start < 0) { if (head.test(lines[i])) start = i; }
      else if (next.some((r) => r.test(lines[i]))) { end = i; break; }
    }
    if (start < 0) return null;
    if (end - start < 2) return '';
    return lines.slice(start + 1, end).join('\n').trim();
  }

  it('finds the "## [1.0.0-rc.N] - date" section and only that one', () => {
    const changelog = [
      '# Changelog', '',
      '## [1.0.0] - 2026-12-01', '', 'Final.', '',
      '## [1.0.0-rc.10] - 2026-11-20', '', 'Tenth candidate.', '',
      '## [1.0.0-rc.2] - 2026-11-10', '', '### Fixed', '', '- Second candidate fix.', '',
      '## [1.0.0-rc.1] - 2026-11-01', '', 'First candidate.', '',
      '## [0.13.0] - 2026-10-20', '', 'Keyframes.', '',
      '[1.0.0-rc.1]: https://example.invalid/',
    ].join('\n');
    expect(changelogSection(changelog, '1.0.0-rc.1')).toBe('First candidate.');
    expect(changelogSection(changelog, '1.0.0-rc.2')).toBe('### Fixed\n\n- Second candidate fix.');
    expect(changelogSection(changelog, '1.0.0-rc.10')).toBe('Tenth candidate.');
    expect(changelogSection(changelog, '1.0.0')).toBe('Final.');
    expect(changelogSection(changelog, '0.13.0')).toBe('Keyframes.');
    expect(changelogSection(changelog, '1.0.0-rc.3')).toBeNull();
    expect(changelogSection(changelog, '1.0.0-rc')).toBeNull();
    expect(changelogSection('## [1.0.0-rc.1] - 2026-11-01\n## [0.13.0]\nx', '1.0.0-rc.1')).toBe('');
    // The real changelog: the section of the version in package.json is found (a release PR's section).
    const real = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string };
    expect(changelogSection(real, pkg.version)).toBeTruthy();
  });

  it('publish: pre-release and Latest come from the tag, and a mismatch with the installer job publishes nothing', () => {
    const tagRe = /-cnotmatch '(\^v[^']*)'/.exec(publish);
    expect(tagRe).not.toBeNull();
    const tag = new RegExp(tagRe![1]);
    for (const ok of ['v0.7.0', 'v1.0.0', 'v1.0.0-rc.1', 'v1.0.0-rc.10']) expect(tag.test(ok), ok).toBe(true);
    for (const bad of ['1.0.0', 'v1.0', 'v1.0.0-', 'v1.0.0-rc..1', 'v1.0.0+b', 'latest']) expect(tag.test(bad), bad).toBe(false);
    expect(publish).toContain('PRERELEASE: ${{ needs.installer.outputs.prerelease }}');
    expect(publish).toContain("$prerelease = if ($env:TAG.Contains('-')) { 'true' } else { 'false' }");
    expect(publish).toContain("$latest = if ($prerelease -eq 'true') { 'false' } else { 'true' }");
    expect(publish).toMatch(/if \(\$env:PRERELEASE -cne \$prerelease\) \{ Write-Host "::error::[^"]*Publishing nothing\."; exit 1 \}/);
    expect(publish).toMatch(/"prerelease=\$prerelease", "make_latest=\$latest"/);
    // A candidate never becomes Latest: make_latest is only ever 'true' for a tag without a pre-release part.
    expect(publish.match(/\$latest = /g)).toHaveLength(1);
    // The same files as a stable release.
    expect(publish).toMatch(/files: \|\n\s+release\/ReCut-Setup-\*\.exe\n\s+release\/ReCut-Portable-\*\.exe\n\s+release\/ReCut-\*-linux-x86_64\.AppImage\n/);
  });

  it('the tag-push fallback also runs for v<version>-rc.<N>, and never for the old -dev. / -win. tags', () => {
    const triggers = /^on:\n {2}push:\n(?: {4}.*\n)*? {4}tags: \[(.*)\]$/m.exec(workflow);
    expect(triggers).not.toBeNull();
    const patterns = [...triggers![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(patterns).toEqual(['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+']);
    // GitHub's filter syntax here: '[0-9]+' is one or more digits, '.' and '-' are literal, the whole ref must match.
    const toRe = (p: string) => new RegExp('^' + p.replace(/\./g, '\\.') + '$');
    const matches = (ref: string) => patterns.some((p) => toRe(p).test(ref));
    for (const ok of ['v0.7.0', 'v1.0.0', 'v1.0.0-rc.1', 'v1.0.0-rc.12']) expect(matches(ok), ok).toBe(true);
    for (const bad of ['v0.7.0-dev.12', 'v0.1.0-win.3', 'v1.0.0-beta.1', 'v1.0.0-rc', '1.0.0-rc.1']) expect(matches(bad), bad).toBe(false);
  });

  it('release candidates have no saved-project fixture, and the fixture script refuses to make one', () => {
    const dir = path.join(repo, 'tests/fixtures/projects');
    for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('recut-'))) expect(f, f).toMatch(/^recut-\d+\.\d+\.\d+\.recut$/);
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-rc-fixture-'));
    try {
      fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'recut', version: '1.0.0-rc.1' }));
      const r = spawnSync(process.execPath, [path.join(repo, 'scripts/make-project-fixture.mjs'), '--root', fake], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('1.0.0-rc.1 is a pre-release: release candidates have no saved-project fixture');
      expect(fs.existsSync(path.join(dir, 'recut-1.0.0-rc.1.recut'))).toBe(false);
    } finally {
      fs.rmSync(fake, { recursive: true, force: true });
    }
  });
});
