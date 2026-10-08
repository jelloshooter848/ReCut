import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
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

  it('the publish job can only publish a full release, never a prerelease or a -dev. tag', () => {
    expect(publish).toContain('softprops/action-gh-release');
    expect(publish).toMatch(/^\s+prerelease: false$/m);
    expect(publish).toMatch(/^\s+make_latest: true$/m);
    expect(publish).not.toMatch(/prerelease:\s*(true|\$\{\{)/);
    expect(publish).not.toContain('-dev.');
    expect(publish).not.toMatch(/DEV_|dev_(tag|name|notes)|dev-notes/);
    // The final check refuses anything but a plain semver tag.
    expect(publish).toContain("-notmatch '^v\\d+\\.\\d+\\.\\d+$'");
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
      expect(jobText(job), job).toContain("hashFiles('scripts/whisper-source.mjs', 'scripts/mac/get-whisper.sh')");
    }
    // The dmg job builds the engine of its matrix arch, cached per arch; the e2e job builds the default (arm64).
    expect(jobText('macos')).toContain('./scripts/mac/get-whisper.sh --arch "$MAC_ARCH" --dest resources/whisper');
    expect(jobText('macos')).toContain("key: whisper-macos-${{ matrix.arch }}-${{ hashFiles(");
    expect(jobText('macos-e2e')).toContain('./scripts/mac/get-whisper.sh --dest resources/whisper');
    expect(jobText('macos-e2e')).toContain('key: whisper-macos-arm64-${{ hashFiles(');
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
    // The e2e suite stays arm64 only (native on the runner): no matrix, no arch.
    expect(macosE2e).not.toContain('matrix');
    expect(macosE2e).not.toContain('--arch');
  });

  it('builds two dmgs, arm64 and x64, as a matrix on the same runner, and keeps going when one leg fails', () => {
    expect(macos).toMatch(/^ {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}arch: \[arm64, x64\]\n/m);
    // Per arch: the name lipo prints and the FFMPEG-BUILD.txt platform.
    expect(macos).toMatch(/- arch: arm64\n\s+lipo: arm64\n\s+platform: arm64 macOS\n/);
    expect(macos).toMatch(/- arch: x64\n\s+lipo: x86_64\n\s+platform: x86-64 macOS\n/);
    expect(macos).toContain('MAC_ARCH: ${{ matrix.arch }}');
    expect(macos).toContain('LIPO_ARCH: ${{ matrix.lipo }}');
    expect(macos).toMatch(/^ {4}name: macOS \$\{\{ matrix\.arch \}\} dmg/m);
    // x64 runs its programs under Rosetta 2, installed if missing, before FFmpeg is downloaded and run.
    expect(macos).toMatch(/- name: Rosetta 2\n\s+if: matrix\.arch == 'x64'\n/);
    expect(macos).toContain('softwareupdate --install-rosetta --agree-to-license');
    expect(macos).toContain('arch -x86_64 /usr/bin/true');
    expect(macos.indexOf('- name: Rosetta 2')).toBeLessThan(macos.indexOf('get-ffmpeg.sh'));
    // The smoke test gives the first launch under Rosetta more time, and the app must be the leg's arch only.
    expect(macos).toContain('if [ "$MAC_ARCH" = x64 ]; then limit=360; fi');
    expect(macos).toContain('"$APP/Contents/Frameworks/Electron Framework.framework/Electron Framework"');
    // No universal binary: every bundled program and the app itself must be exactly the leg's arch.
    expect(macos.match(/\[ "\$got" = "\$LIPO_ARCH" \]/g)?.length).toBeGreaterThanOrEqual(3);
    expect(macos).not.toMatch(/--universal|lipo -create/);
  });

  it('is not a release gate yet: publish neither needs it nor attaches the dmg, and a TODO says how to change that', () => {
    expect(publish).toMatch(/^ {4}needs: \[installer, tests, e2e, launcher, linux\]$/m);
    expect(publish).not.toContain('ReCut-macos');
    expect(publish).not.toContain('.dmg');
    expect(workflow).toContain('# TODO(0.7.0, when macOS becomes official');
    expect(workflow).toContain('#   1. needs: [installer, tests, e2e, launcher, linux, macos, macos-e2e]');
    // The TODO ships both dmgs, from both arch artifacts.
    expect(workflow).toMatch(/^\s+#.*\brelease\/ReCut-\*-macos-arm64\.dmg/m);
    expect(workflow).toMatch(/^\s+#.*\brelease\/ReCut-\*-macos-x64\.dmg/m);
    expect(workflow).toMatch(/^\s+#\s+pattern: ReCut-macos-\*$/m);
    expect(workflow).toMatch(/^\s+#\s+merge-multiple: true$/m);
    // The Windows and Linux summaries say which jobs must be green: the five gates, not the advisory macOS jobs.
    for (const block of [code(job('installer')), code(job('linux'))]) {
      expect(block).toContain('the required jobs of this run (installer, tests, e2e, launcher, linux) are green');
      expect(block).not.toContain('every job in this run is green');
    }
  });

  it('tests with the bundled FFmpeg of the leg\'s arch, then packages that arch\'s dmg, signed only when all secrets are set', () => {
    expect(macos).toContain('./scripts/mac/get-ffmpeg.sh --arch "$MAC_ARCH" --dest resources/ffmpeg');
    expect(macos).toContain('npx vitest run');
    expect(macos.indexOf('get-ffmpeg.sh')).toBeLessThan(macos.indexOf('npx vitest run'));
    expect(macos.indexOf('npx vitest run')).toBeLessThan(macos.indexOf('electron-builder --mac'));
    // Signed: electron-builder signs, notarizes (APPLE_API_KEY = path of the decoded .p8) and staples. The same five
    // secrets sign both arches.
    expect(macos).toContain('APPLE_API_KEY="$APPLE_API_KEY_PATH" npx electron-builder --mac dmg "--$MAC_ARCH" --publish never');
    // Unsigned: no identity discovery, ad-hoc signature, hardened runtime off (a real boolean false).
    expect(macos).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg "--\$MAC_ARCH" --publish never \\\n\s+-c\.mac\.identity=- -c\.mac\.timestamp=none --no-config\.mac\.hardenedRuntime/);
    expect(macos).not.toMatch(/electron-builder --mac dmg --(arm64|x64)/);
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
    // The bundled FFmpeg names the leg's platform and Jellyfin build.
    expect(macos).toContain('PLATFORM: ${{ matrix.platform }}');
    expect(macos).toContain('grep -qx "Platform: *$PLATFORM" "$ff/FFMPEG-BUILD.txt"');
    expect(macos).toContain('_portable_$([ "$MAC_ARCH" = arm64 ] && echo macarm64 || echo mac64)-gpl');
  });

  it('checks the bundled speech-to-text engine of each arch: Metal on arm64, the CPU variants on x64', () => {
    expect(macos).toContain("grep -q 'GGML_METAL_EMBED_LIBRARY=ON' \"$w/WHISPER-BUILD.txt\"");
    expect(macos).toContain("grep -q 'GGML_METAL=OFF' \"$w/WHISPER-BUILD.txt\"");
    expect(macos).toContain("grep -q 'GGML_CPU_ALL_VARIANTS=ON' \"$w/WHISPER-BUILD.txt\"");
    expect(macos).toContain('for v in x64 sse42 sandybridge haswell skylakex; do');
    expect(macos).toMatch(/if \[ "\$bytes" -gt \$\(\(16 \* 1024 \* 1024\)\) \]/);
  });

  it('keeps each dmg as its arch\'s artifact (ReCut-macos-arm64, ReCut-macos-x64) on every run, with a job summary', () => {
    const upload = /- uses: actions\/upload-artifact@v4\n((?:\s{8,}.*\n)+)/g;
    const artifact = [...macos.matchAll(upload)].map((m) => m[0]).find((a) => /name: ReCut-macos-\$\{\{ matrix\.arch \}\}\n/.test(a));
    expect(artifact).toBeDefined();
    expect(artifact).not.toMatch(/^\s+if:/m);
    expect(artifact).toContain('path: release/ReCut-*-macos-${{ matrix.arch }}.dmg');
    expect(artifact).toMatch(/if-no-files-found: error/);
    expect(artifact).toMatch(/retention-days: 14/);
    expect(macos).toContain('GITHUB_STEP_SUMMARY');
    expect(macos).toContain("Artifacts (ReCut-macos-$MAC_ARCH)");
    expect(macos).toContain('dmg="$(ls "$GITHUB_WORKSPACE"/release/ReCut-*-macos-"$MAC_ARCH".dmg)"');
    // The old single-arch artifact name is gone from the workflow (docs point to the per-arch names).
    expect(code(workflow)).not.toMatch(/name: ReCut-macos\n/);
  });

  it('package.json names the dmg by arch, defaults to arm64, with the hardened runtime and a minimal entitlement set', () => {
    const mac = pkg.build.mac;
    // CI picks the arch on the command line (--arm64 / --x64); a bare `electron-builder --mac` builds arm64 only, so
    // one dmg never gets another arch's resources/ffmpeg and resources/whisper.
    expect(mac.target).toEqual([{ target: 'dmg', arch: ['arm64'] }]);
    expect(mac.artifactName).toBe('ReCut-${version}-macos-${arch}.${ext}');
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
    expect(script).toContain('echo "Platform:        $platform"');
    expect(script).toContain("echo 'Corresponding source'");
    expect(script).toContain('--skip-run');
    expect(script).not.toMatch(/master-latest|\/latest\//);
    // Every source: a versioned release URL, the archive's SHA-256, a licence URL at the same tag and its SHA-256.
    const entryRe = /^ {2}"(\$jf\/releases\/download\/(v[\d.]+-\d+)\/[^|"]+)\|([0-9a-f]{64})\|(\$jf_raw\/(v[\d.]+-\d+)\/COPYING\.GPLv3)\|([0-9a-f]{64})\|(v[\d.]+-\d+)"$/gm;
    const list = (name: string) => {
      const m = new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)$`, 'm').exec(script);
      expect(m, name).not.toBeNull();
      return [...m![1].matchAll(entryRe)];
    };
    const arm64 = list('sources_arm64');
    const x64 = list('sources_x64');
    expect(arm64.length).toBeGreaterThanOrEqual(1);
    expect(x64.length).toBeGreaterThanOrEqual(1);
    for (const [entries, variant] of [[arm64, 'macarm64-gpl'], [x64, 'mac64-gpl']] as const) {
      for (const e of entries) {
        expect(e[2]).toBe(e[5]);
        expect(e[2]).toBe(e[7]);
        expect(e[1]).toBe(`$jf/releases/download/${e[2]}/jellyfin-ffmpeg_${e[2].slice(1)}_portable_${variant}.tar.xz`);
      }
    }
    // The two dmgs bundle the same FFmpeg: the same releases, in the same order, with different archives.
    expect(x64.map((e) => e[2])).toEqual(arm64.map((e) => e[2]));
    expect(new Set([...arm64, ...x64].map((e) => e[3])).size).toBe(arm64.length + x64.length);
    expect(script).toMatch(/^if \[\[ "\$arch" == x64 \]\]; then sources=\("\$\{sources_x64\[@\]\}"\); else sources=\("\$\{sources_arm64\[@\]\}"\); fi$/m);
  });

  it('get-ffmpeg.sh takes the arch as a parameter (default arm64) and checks the binaries\' architecture', () => {
    expect(script).toContain('arch="${MAC_ARCH:-arm64}"');
    expect(script).toContain('-a|--arch) arch=');
    // arm64: Mach-O CPU type 0x0100000c, lipo "arm64"; x64: 0x01000007, lipo "x86_64".
    expect(script).toMatch(/arm64\|aarch64\) arch='arm64'; variant='macarm64-gpl'; lipo_arch='arm64'; cpu_bytes='0c000001'; platform='arm64 macOS' ;;/);
    expect(script).toMatch(/x64\|x86_64\|intel\) arch='x64'; variant='mac64-gpl'; lipo_arch='x86_64'; cpu_bytes='07000001'; platform='x86-64 macOS' ;;/);
    expect(script).toContain('[[ "$cpu" == "$cpu_bytes" ]]');
    expect(script).toContain('lipo -archs "$f"');
    // x64 runs natively or under Rosetta 2, which the script checks before running anything.
    expect(script).toContain('/usr/bin/arch -x86_64 /usr/bin/true');
    expect(script).toContain('builder/variants/$variant.sh');
  });

  it('get-whisper.sh builds arm64 (Metal) by default and a CPU-only x86_64 engine for x64, checking every file\'s arch', () => {
    const sh = fs.readFileSync(path.join(repo, 'scripts/mac/get-whisper.sh'), 'utf8').replace(/\r\n/g, '\n');
    expect(sh.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(sh).toContain('set -euo pipefail');
    expect(sh).toContain('arch="${MAC_ARCH:-arm64}"');
    expect(sh).toContain('-a|--arch) arch=');
    for (const f of ['-DCMAKE_OSX_ARCHITECTURES=arm64', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DBUILD_SHARED_LIBS=OFF']) expect(sh).toContain(f);
    for (const f of ['-DCMAKE_OSX_ARCHITECTURES=x86_64', '-DGGML_METAL=OFF', '-DGGML_BLAS=OFF', '-DGGML_BACKEND_DL=ON', '-DGGML_CPU_ALL_VARIANTS=ON', '-DCMAKE_INSTALL_RPATH=@loader_path']) {
      expect(sh).toContain(f);
    }
    expect(sh).toContain('-DCMAKE_OSX_DEPLOYMENT_TARGET="$min_macos"');
    expect(sh).toContain(`min_macos='${pkg.build.mac.minimumSystemVersion}'`);
    expect(sh).toContain('-DGGML_NATIVE=OFF');
    // The same five CPU variants as the Linux and Windows engines.
    const linux = fs.readFileSync(path.join(repo, 'scripts/linux/get-whisper.sh'), 'utf8');
    const variants = /^CPU_VARIANTS=\(([^)]*)\)$/m.exec(linux)![1];
    expect(sh).toContain(`CPU_VARIANTS=(${variants})`);
    // Every Mach-O in the folder: exactly the arch, at most macOS 12, only system or bundled libraries.
    expect(sh).toContain('[[ "$got" == "$lipo_arch" ]]');
    expect(sh).toContain("x64|x86_64|intel) arch='x64'; lipo_arch='x86_64' ;;");
    expect(sh).toContain('version_gt "$minos" "$min_macos"');
    expect(sh).toContain('/usr/lib/*|/System/Library/*) ;;');
    expect(sh).toContain('/usr/bin/arch -x86_64 /usr/bin/true');
  });
});
