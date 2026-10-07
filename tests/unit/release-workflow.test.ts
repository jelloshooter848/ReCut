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
    expect(publish).toMatch(/^ {4}needs: \[installer, tests, e2e, launcher\]$/m);
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
