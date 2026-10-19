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

/**
 * Evaluates a GitHub Actions expression made only of ==, !=, &&, ||, parentheses, string literals, startsWith()
 * and format() over the given context values (enough for the if: and concurrency expressions checked here).
 */
function evaluate(expr: string, ctx: Record<string, string | number>): unknown {
  const names = Object.keys(ctx).sort((a, b) => b.length - a.length);
  let js = expr.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  for (const n of names) js = js.split(n).join(`ctx[${JSON.stringify(n)}]`);
  expect(js.replace(/ctx\["[^"]+"\]/g, ''), `unknown identifier in: ${expr}`).not.toMatch(/\b(github|needs|inputs|steps|secrets)\./);
  const fn = new Function('ctx', 'startsWith', 'format', `return (${js});`);
  return fn(
    ctx,
    (s: string, p: string) => String(s).startsWith(p),
    (f: string, ...a: unknown[]) => f.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)])),
  );
}

describe('Windows workflow: no dev prereleases', () => {
  const publish = code(job('publish'));
  const installer = code(job('installer'));

  it('the publish job runs only for a real release and only after every gate passed', () => {
    expect(jobIf(publish)).toBe(
      "github.event_name == 'push' && ((github.ref == 'refs/heads/main' && needs.installer.outputs.prerelease == 'false') || (github.ref == 'refs/heads/rc' && needs.installer.outputs.prerelease == 'true') || startsWith(github.ref, 'refs/tags/v')) && needs.installer.outputs.release == 'true'",
    );
    expect(publish).toMatch(/^ {4}needs: \[installer, tests, e2e, launcher, linux, macos, macos-e2e\]$/m);
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

  it('only the tag-push fallback and the automatic release on main or rc set release=true', () => {
    expect(installer).toContain('release: ${{ steps.rel.outputs.release }}');
    expect(installer).toContain("$release = 'false'; $auto = 'false'");
    expect(installer.match(/\$release = 'true'/g)).toHaveLength(2);
    expect(installer).toMatch(/\$release = 'true'; \$auto = 'true'/);
    expect(installer).toMatch(/if \(\$env:EVENT_NAME -eq 'push' -and \$env:REF_TYPE -eq 'tag'\)[\s\S]*?\$release = 'true'\n\s+\} elseif/);
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

// The branch workflow (owner's decisions, 9 and 12-13 October 2026; CONTRIBUTING.md "Branches and pull requests",
// docs/RELEASING.md "Branches and roles"): main holds released code only, rc the release candidates, dev is the
// integration branch, devDavid and devJames are personal branches. Pushes to main, rc and dev and pull requests into
// main, rc, dev, devDavid and devJames run the workflow; only a push of a v tag, a push to main of a stable version or
// a push to rc of a release candidate can publish; only pull_request runs are ever cancelled by a newer run.
describe('Windows workflow: branches (main, rc, dev), pull requests and concurrency', () => {
  const header = workflow.slice(0, workflow.indexOf('\njobs:\n'));
  const publish = code(job('publish'));
  const installer = code(job('installer'));
  const macos = code(job('macos'));

  /** The `key: value` lines directly under `  <event>:` in the `on:` block. */
  function trigger(event: string): Record<string, string> {
    const on = /^on:\n((?: {2}.*\n)+)/m.exec(header)?.[1];
    expect(on, 'on:').toBeDefined();
    const block = new RegExp(`^ {2}${event}:\\n((?: {4}.*\\n)*)`, 'm').exec(on!)?.[1];
    expect(block, event).toBeDefined();
    const out: Record<string, string> = {};
    for (const m of block!.matchAll(/^ {4}([a-z-]+): (.+)$/gm)) out[m[1]] = m[2];
    return out;
  }
  const list = (v: string | undefined) => [...(v ?? '').matchAll(/'([^']+)'|([^\s,[\]']+)/g)].map((m) => m[1] ?? m[2]);

  it('runs on pushes to main, rc and dev, release tags, pull requests into main / rc / dev / devDavid / devJames, and by hand', () => {
    const push = trigger('push');
    expect(list(push.branches)).toEqual(['main', 'rc', 'dev']);
    expect(list(push.tags)).toEqual(['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+']);
    expect(list(push['paths-ignore'])).toEqual(['**/*.md', 'docs/**']);
    const pr = trigger('pull_request');
    expect(list(pr.branches)).toEqual(['main', 'rc', 'dev', 'devDavid', 'devJames']);
    expect(list(pr.types)).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review']);
    expect(pr['paths-ignore']).toBe(push['paths-ignore']);
    // Never pull_request_target: it would run with secrets and a writable token in the base repository's context.
    expect(header).not.toMatch(/pull_request_target|workflow_run/);
    expect(header).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}installer_stress:\n/m);
    // The CI bring-up branch is gone. PRs into main (rc -> main, hotfixes) and rc (promotions, release prep) are
    // test builds like any other pull request run.
    expect(header).not.toMatch(/^ {4}branches: .*claude\/build-recut/m);
  });

  it('publishing is impossible on a pull_request run, a dev push, a manual run, a pre-release on main or a stable version on rc', () => {
    const cond = jobIf(publish)!;
    const run = (event: string, ref: string, release = 'true', prerelease = 'false') =>
      evaluate(cond, {
        'github.event_name': event,
        'github.ref': ref,
        'needs.installer.outputs.release': release,
        'needs.installer.outputs.prerelease': prerelease,
      });
    expect(run('push', 'refs/heads/main')).toBe(true);
    expect(run('push', 'refs/heads/rc', 'true', 'true')).toBe(true);
    expect(run('push', 'refs/tags/v1.0.0')).toBe(true);
    expect(run('push', 'refs/tags/v1.0.0-rc.1', 'true', 'true')).toBe(true);
    expect(run('push', 'refs/heads/main', 'false')).toBe(false);
    expect(run('push', 'refs/heads/rc', 'false', 'true')).toBe(false);
    // main never publishes a pre-release and rc never a stable version, even with a (wrong) release output of 'true'.
    expect(run('push', 'refs/heads/main', 'true', 'true')).toBe(false);
    expect(run('push', 'refs/heads/rc', 'true', 'false')).toBe(false);
    // Every other event and branch publishes nothing, even with (wrong) release outputs of 'true':
    for (const [event, ref] of [
      ['pull_request', 'refs/pull/7/merge'],
      ['pull_request', 'refs/heads/main'],
      ['pull_request', 'refs/heads/rc'],
      ['push', 'refs/heads/dev'],
      ['push', 'refs/heads/devDavid'],
      ['push', 'refs/heads/devJames'],
      ['push', 'refs/heads/claude/some-task'],
      ['workflow_dispatch', 'refs/heads/main'],
      ['workflow_dispatch', 'refs/heads/rc'],
      ['workflow_dispatch', 'refs/tags/v1.0.0'],
    ]) {
      for (const prerelease of ['true', 'false']) expect(run(event, ref, 'true', prerelease), `${event} ${ref} ${prerelease}`).toBe(false);
    }
    // The installer job's release decision needs a push as well: a tag push, or a push to main or rc.
    expect(installer).toContain("if ($env:EVENT_NAME -eq 'push' -and $env:REF_TYPE -eq 'tag') {");
    expect(installer).toContain(
      "} elseif ($env:EVENT_NAME -eq 'push' -and ($env:REF -ceq 'refs/heads/main' -or $env:REF -ceq 'refs/heads/rc')) {",
    );
    expect(installer).not.toMatch(/refs\/heads\/dev|pull_request/);
    // So does the macos job's (which decides whether a release must be signed).
    expect(macos).toContain('if [ "$EVENT_NAME" = push ] && [ "$REF_TYPE" = tag ]; then');
    expect(macos).toContain('elif [ "$EVENT_NAME" = push ] && [ "$REF" = refs/heads/main ] && [[ "$v" != *-* ]] && [ "$section" = true ]; then');
    expect(macos).toContain('elif [ "$EVENT_NAME" = push ] && [ "$REF" = refs/heads/rc ] && [[ "$v" =~ $rc_version ]] && [ "$section" = true ]; then');
    expect(macos).not.toMatch(/refs\/heads\/dev/);
  });

  it('runs only with a read-only token, except the publish job', () => {
    expect(header).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(code(header)).not.toMatch(/: write/);
    expect(publish).toMatch(/^ {4}permissions:\n {6}contents: write\n/m);
    // No other job asks for more.
    expect(code(workflow).match(/^\s+[a-z-]+: write$/gm)).toEqual(['      contents: write']);
  });

  it('a fork pull request (no secrets) makes an ad-hoc signed test build instead of failing', () => {
    // Without secrets every HAVE_* is 'false' and the empty secrets count as unset: no "only some set" failure.
    expect(macos).toMatch(/if \[ "\$have" -eq 0 \]; then\n\s+echo 'No macOS signing secrets: building an ad-hoc signed test build/);
    // electron-builder skips every macOS signature (ad-hoc too) on a pull request build unless CSC_FOR_PULL_REQUEST is
    // true; then the "Code signature" step fails. The dmg step sets it for both paths, signed and ad-hoc.
    const pkgStep = /- name: Package the dmg\n\s+env:\n((?:\s{10}[A-Z_]+: .*\n)+)/.exec(macos)?.[1];
    expect(pkgStep).toBeDefined();
    expect(pkgStep).toMatch(/^\s+CSC_FOR_PULL_REQUEST: 'true'$/m);
    expect(code(workflow).match(/CSC_FOR_PULL_REQUEST/g)).toHaveLength(1);
    // A run that is not a release never checks for missing secrets.
    expect(macos).toMatch(/if \[ "\$release" != true \]; then\n(?:.*\n)\s+exit 0\n\s+fi\n\s+missing=''/);
  });

  it('cancels a superseded run only for pull requests, never on main, rc, a tag or dev', () => {
    const group = /^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m.exec(header);
    expect(group).not.toBeNull();
    const [, groupExpr, cancelExpr] = group!;
    const ctx = (event: string, ref: string, pr: number | string = '') => ({
      'github.event_name': event,
      'github.ref': ref,
      'github.event.pull_request.number': pr,
    });
    const cancels = (event: string, ref: string, pr?: number) => evaluate(cancelExpr, ctx(event, ref, pr));
    const groupOf = (event: string, ref: string, pr?: number) =>
      evaluate(groupExpr.replace(/^windows-\$\{\{\s*(.*?)\s*\}\}$/, "'windows-' + ($1)"), ctx(event, ref, pr));
    for (const [event, ref] of [
      ['push', 'refs/heads/main'],
      ['push', 'refs/heads/rc'],
      ['push', 'refs/tags/v1.0.0'],
      ['push', 'refs/tags/v1.0.0-rc.1'],
      ['push', 'refs/heads/dev'],
      ['workflow_dispatch', 'refs/heads/main'],
      ['workflow_dispatch', 'refs/heads/rc'],
      ['workflow_dispatch', 'refs/heads/claude/some-task'],
    ]) {
      expect(cancels(event, ref), `${event} ${ref}`).toBe(false);
    }
    expect(cancels('pull_request', 'refs/pull/12/merge', 12)).toBe(true);
    // One group per pull request, separate from every branch's and tag's group.
    expect(groupOf('pull_request', 'refs/pull/12/merge', 12)).toBe('windows-pr-12');
    expect(groupOf('push', 'refs/heads/main')).toBe('windows-refs/heads/main');
    expect(groupOf('push', 'refs/heads/rc')).toBe('windows-refs/heads/rc');
    expect(groupOf('push', 'refs/tags/v1.0.0')).toBe('windows-refs/tags/v1.0.0');
    expect(groupOf('push', 'refs/heads/dev')).toBe('windows-refs/heads/dev');
  });
});

// The release matrix (owner's decision, 12-13 October 2026; docs/RELEASING.md "Branches and roles"): every
// combination of event x ref x package.json version is either a release or a test build, and only three publish: a
// push to main of a stable version X.Y.Z, a push to rc of a release candidate X.Y.Z-rc.N (N from 1), each with its
// changelog section and no v<version> tag yet, and the tag-push fallback. These tests run the workflow's own step
// scripts: the installer job's "Release metadata" and the publish job's "Final release check" with PowerShell (pwsh;
// skipped where it is not installed, but the Windows, Linux and macOS CI runners have it) and the macos job's
// "Release run?" with bash (not on Windows). A stub replaces git: `git ls-remote --exit-code` answers as if the tag
// existed (FAKE_TAG_EXIT=0) or not (2).
describe('Windows workflow: the release matrix (event x ref x version)', () => {
  const hasPwsh = (() => {
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    return r.status === 0 && Number(r.stdout.trim()) >= 7;
  })();
  const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;

  /** The `run: |` script of step `name` in job `jobName`, as the runner gets it (dedented, comments kept). */
  function stepScript(jobName: string, name: string): string {
    const lines = job(jobName).split('\n');
    const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    expect(at, name).toBeGreaterThan(-1);
    const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
    expect(runAt, `${name}: run: |`).toBeGreaterThan(at);
    expect(lines.slice(at + 1, runAt).some((l) => /^\s+- (name|uses):/.test(l)), `${name}: run: | belongs to another step`).toBe(false);
    const indent = /^ */.exec(lines[runAt + 1])![0].length;
    const out: string[] = [];
    for (const l of lines.slice(runAt + 1)) {
      if (l.trim() && /^ */.exec(l)![0].length < indent) break;
      out.push(l.slice(indent));
    }
    return out.join('\n').replace(/\n+$/, '\n');
  }

  interface Job { cwd: string; env: Record<string, string> }
  interface Result { code: number; log: string; outputs: Record<string, string> }

  function readOutputs(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(file)) return out;
    for (const l of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const i = l.indexOf('=');
      if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
    }
    return out;
  }

  /** Runs a PowerShell step once per job in one pwsh process (`exit` in a script file ends only that script). */
  function runPwsh(script: string, jobs: Job[]): Result[] {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-wf-ps-'));
    try {
      const step = path.join(tmp, 'step.ps1');
      fs.writeFileSync(step, script);
      const files = jobs.map((_, i) => ({ out: path.join(tmp, `out-${i}.txt`), log: path.join(tmp, `log-${i}.txt`), code: path.join(tmp, `code-${i}.txt`) }));
      fs.writeFileSync(path.join(tmp, 'jobs.json'), JSON.stringify(jobs.map((j, i) => ({ ...j, ...files[i] }))));
      fs.writeFileSync(
        path.join(tmp, 'driver.ps1'),
        [
          'param([string]$Jobs, [string]$Step)',
          "$ErrorActionPreference = 'Stop'",
          'function global:git { $global:LASTEXITCODE = [int]$env:FAKE_TAG_EXIT }',
          'foreach ($j in @(Get-Content -Raw -LiteralPath $Jobs | ConvertFrom-Json)) {',
          '  foreach ($p in $j.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value) }',
          '  [Environment]::SetEnvironmentVariable(\'GITHUB_OUTPUT\', $j.out)',
          '  Set-Location -LiteralPath $j.cwd',
          '  $global:LASTEXITCODE = 0',
          '  try { $text = & $Step 6>&1 2>&1 | Out-String; $code = $LASTEXITCODE } catch { $text = "THREW: $_"; $code = 99 }',
          '  Set-Content -LiteralPath $j.log -Value $text -Encoding utf8',
          '  Set-Content -LiteralPath $j.code -Value $code',
          '}',
        ].join('\n'),
      );
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(tmp, 'driver.ps1'), path.join(tmp, 'jobs.json'), step], { encoding: 'utf8' });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      return files.map((f) => ({
        code: Number(fs.readFileSync(f.code, 'utf8').trim()),
        log: fs.readFileSync(f.log, 'utf8'),
        outputs: readOutputs(f.out),
      }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Runs a bash step once per job (each in a subshell) in one bash process, with GitHub's bash options. */
  function runBash(script: string, jobs: Job[]): Result[] {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-wf-sh-'));
    try {
      const step = path.join(tmp, 'step.sh');
      fs.writeFileSync(step, script);
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const files = jobs.map((_, i) => ({ out: path.join(tmp, `out-${i}.txt`), log: path.join(tmp, `log-${i}.txt`), code: path.join(tmp, `code-${i}.txt`) }));
      const driver = [
        'git() { return "$FAKE_TAG_EXIT"; }',
        `export PATH=${q(path.dirname(process.execPath))}:"$PATH"`,
        ...jobs.map((j, i) =>
          `( set -eo pipefail; cd ${q(j.cwd)}; ${Object.entries({ ...j.env, GITHUB_OUTPUT: files[i].out }).map(([k, v]) => `export ${k}=${q(v)}`).join('; ')}; . ${q(step)} ) > ${q(files[i].log)} 2>&1; echo $? > ${q(files[i].code)}`,
        ),
      ].join('\n');
      fs.writeFileSync(path.join(tmp, 'driver.sh'), driver);
      const r = spawnSync('bash', ['--noprofile', '--norc', path.join(tmp, 'driver.sh')], { encoding: 'utf8' });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      return files.map((f) => ({
        code: Number(fs.readFileSync(f.code, 'utf8').trim()),
        log: fs.readFileSync(f.log, 'utf8'),
        outputs: readOutputs(f.out),
      }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // The versions: stable, a release candidate, rc.0 (not a candidate: N counts from 1) and another pre-release.
  const versions = { stable: '1.4.0', rc: '1.4.0-rc.2', rc0: '1.4.0-rc.0', beta: '1.4.0-beta.1' } as const;
  type Kind = keyof typeof versions;
  // fresh: the version has its changelog section and no tag; tagged: v<version> already exists on origin;
  // nosection: CHANGELOG.md has no section for it.
  type State = 'fresh' | 'tagged' | 'nosection';
  interface Case { event: string; ref: string; refType: 'branch' | 'tag'; kind: Kind; state: State }

  const tagPatterns = [...(/^on:\n {2}push:\n(?: {4}.*\n)*? {4}tags: \[(.*)\]$/m.exec(workflow)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const tagStartsRun = (tag: string) => tagPatterns.some((p) => new RegExp('^' + p.replace(/\./g, '\\.') + '$').test(tag));

  const cases: Case[] = [];
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
    for (const kind of Object.keys(versions) as Kind[]) {
      const refs: { ref: string; refType: 'branch' | 'tag' }[] = ['main', 'rc', 'dev', 'devDavid', 'devJames', 'claude/some-task'].map((b) => ({
        ref: `refs/heads/${b}`,
        refType: 'branch',
      }));
      if (event === 'pull_request') refs.push({ ref: 'refs/pull/7/merge', refType: 'branch' });
      // A tag push starts a run only for the tag patterns of on.push.tags (and a manual run can be started on a tag).
      if (tagStartsRun(`v${versions[kind]}`)) refs.push({ ref: `refs/tags/v${versions[kind]}`, refType: 'tag' });
      for (const r of refs) {
        const autoBranch = event === 'push' && (r.ref === 'refs/heads/main' || r.ref === 'refs/heads/rc');
        // The tag-push fallback fails a version without a changelog section (an error, not a test build).
        const states: State[] = autoBranch ? ['fresh', 'tagged', 'nosection'] : event === 'push' && r.refType === 'tag' ? ['fresh', 'tagged'] : ['fresh'];
        for (const state of states) cases.push({ event, ...r, kind, state });
      }
    }
  }
  const label = (c: Case) => `${c.event} ${c.ref} ${versions[c.kind]} (${c.state})`;

  /** The owner's rule: what publishes. Everything else is a test build. */
  const publishes = (c: Case) =>
    c.event === 'push' &&
    (c.refType === 'tag' ||
      (c.state === 'fresh' && ((c.ref === 'refs/heads/main' && c.kind === 'stable') || (c.ref === 'refs/heads/rc' && c.kind === 'rc'))));
  /** A push to main with a pre-release, or to rc with a pre-release that is not a candidate, warns. */
  const warns = (c: Case) =>
    c.event === 'push' && ((c.ref === 'refs/heads/main' && c.kind !== 'stable') || (c.ref === 'refs/heads/rc' && (c.kind === 'rc0' || c.kind === 'beta')));

  /** One checkout per version and changelog state. */
  function checkouts(root: string): (c: Case) => string {
    const dirs = new Map<string, string>();
    for (const kind of Object.keys(versions) as Kind[]) {
      for (const section of [true, false]) {
        const dir = path.join(root, `${kind}-${section}`);
        fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'recut', version: versions[kind] }));
        const head = section ? `## [${versions[kind]}] - 2026-11-01\n\n### Fixed\n\n- A fix.\n\n` : '';
        fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n${head}## [1.3.0] - 2026-10-01\n\n- Older.\n`);
        dirs.set(`${kind}-${section}`, dir);
      }
    }
    return (c) => dirs.get(`${c.kind}-${c.state !== 'nosection'}`)!;
  }
  const ghEnv = (c: Case, root: string): Record<string, string> => ({
    EVENT_NAME: c.event,
    REF: c.ref,
    REF_TYPE: c.refType,
    REF_NAME: c.ref.replace(/^refs\/(heads|tags)\//, ''),
    RUN_NUMBER: '42',
    REPO: 'owner/repo',
    SHA: '0123456789abcdef0123456789abcdef01234567',
    RUNNER_TEMP: root,
    FAKE_TAG_EXIT: c.state === 'tagged' ? '0' : '2',
  });

  it('covers every event, branch and version kind', () => {
    expect(tagPatterns.length).toBeGreaterThan(0);
    expect(new Set(cases.map((c) => c.event))).toEqual(new Set(['push', 'pull_request', 'workflow_dispatch']));
    for (const k of Object.keys(versions)) expect(cases.some((c) => c.kind === k && c.ref === 'refs/heads/rc')).toBe(true);
    expect(cases.filter(publishes).map(label).sort()).toEqual(
      [
        'push refs/heads/main 1.4.0 (fresh)',
        'push refs/heads/rc 1.4.0-rc.2 (fresh)',
        'push refs/tags/v1.4.0 1.4.0 (fresh)',
        'push refs/tags/v1.4.0 1.4.0 (tagged)',
        'push refs/tags/v1.4.0-rc.0 1.4.0-rc.0 (fresh)',
        'push refs/tags/v1.4.0-rc.0 1.4.0-rc.0 (tagged)',
        'push refs/tags/v1.4.0-rc.2 1.4.0-rc.2 (fresh)',
        'push refs/tags/v1.4.0-rc.2 1.4.0-rc.2 (tagged)',
      ].sort(),
    );
  });

  it.skipIf(!hasPwsh)('installer "Release metadata" + publish if: + "Final release check": only the owner\'s three cases publish', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-wf-matrix-'));
    try {
      const dirOf = checkouts(root);
      const meta = runPwsh(stepScript('installer', 'Release metadata (release or test build, changelog notes)'), cases.map((c) => ({ cwd: dirOf(c), env: ghEnv(c, path.join(dirOf(c), 'tmp')) })));
      const cond = jobIf(code(job('publish')))!;
      const toPublish: { c: Case; o: Record<string, string> }[] = [];
      cases.forEach((c, i) => {
        const r = meta[i];
        expect(r.code, `${label(c)}\n${r.log}`).toBe(0);
        const o = r.outputs;
        expect(o.release, `${label(c)}\n${r.log}`).toBe(publishes(c) ? 'true' : 'false');
        expect(o.prerelease, label(c)).toBe(c.kind === 'stable' ? 'false' : 'true');
        expect(/::warning::/.test(r.log), `${label(c)}\n${r.log}`).toBe(warns(c));
        if (o.release === 'true') {
          expect(o.tag, label(c)).toBe(`v${versions[c.kind]}`);
          expect(o.auto, label(c)).toBe(c.refType === 'tag' ? 'false' : 'true');
        } else {
          expect(o.tag, label(c)).toBe('');
          expect(o.name, label(c)).toContain('test build');
        }
        const runsPublish = evaluate(cond, {
          'github.event_name': c.event,
          'github.ref': c.ref,
          'needs.installer.outputs.release': o.release,
          'needs.installer.outputs.prerelease': o.prerelease,
        });
        expect(runsPublish, label(c)).toBe(publishes(c));
        if (runsPublish) toPublish.push({ c, o });
      });
      // The publish job's last check, with no tag appearing during the build: publishes exactly these.
      const final = runPwsh(
        stepScript('publish', 'Final release check'),
        toPublish.map(({ c, o }) => ({
          cwd: root,
          env: { REF: c.ref, AUTO: o.auto, PRERELEASE: o.prerelease, TAG: o.tag, NAME: o.name, NOTES: 'notes.md', FAKE_TAG_EXIT: '2' },
        })),
      );
      toPublish.forEach(({ c }, i) => {
        expect(final[i].code, `${label(c)}\n${final[i].log}`).toBe(0);
        expect(final[i].outputs.publish, label(c)).toBe('true');
        expect(final[i].outputs.make_latest, label(c)).toBe(c.kind === 'stable' ? 'true' : 'false');
      });
      expect(toPublish.length).toBe(cases.filter(publishes).length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!hasPwsh)('"Final release check" refuses a pre-release from main and anything but vX.Y.Z-rc.N from rc, whatever the installer said', () => {
    const jobs: [string, string, string, number][] = [
      ['refs/heads/main', 'v1.4.0-rc.2', 'true', 1],
      ['refs/heads/main', 'v1.4.0', 'false', 0],
      ['refs/heads/rc', 'v1.4.0', 'false', 1],
      ['refs/heads/rc', 'v1.4.0-beta.1', 'true', 1],
      ['refs/heads/rc', 'v1.4.0-rc.0', 'true', 1],
      ['refs/heads/rc', 'v1.4.0-rc.10', 'true', 0],
      ['refs/tags/v1.4.0-rc.0', 'v1.4.0-rc.0', 'true', 0],
    ];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-wf-final-'));
    try {
      const r = runPwsh(
        stepScript('publish', 'Final release check'),
        jobs.map(([ref, tag, pre]) => ({ cwd: tmp, env: { REF: ref, AUTO: 'false', PRERELEASE: pre, TAG: tag, NAME: 'x', NOTES: 'n', FAKE_TAG_EXIT: '2' } })),
      );
      jobs.forEach(([ref, tag, , want], i) => {
        expect(r[i].code, `${ref} ${tag}\n${r[i].log}`).toBe(want);
        if (want) expect(r[i].log, `${ref} ${tag}`).toContain('::error::Refusing to publish');
        else expect(r[i].outputs.publish, `${ref} ${tag}`).toBe('true');
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!hasBash)('macos "Release run?" decides every case as the installer job does, so a release is always signed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-wf-matrix-'));
    try {
      const dirOf = checkouts(root);
      const have = Object.fromEntries(['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].map((s) => [`HAVE_${s}`, 'true']));
      const results = runBash(
        stepScript('macos', 'Release run? (a release must be signed)'),
        cases.map((c) => ({ cwd: dirOf(c), env: { ...ghEnv(c, root), ...have } })),
      );
      cases.forEach((c, i) => {
        expect(results[i].code, `${label(c)}\n${results[i].log}`).toBe(0);
        expect(results[i].outputs.release, `${label(c)}\n${results[i].log}`).toBe(publishes(c) ? 'true' : 'false');
      });
      // A release run without the signing secrets fails; a test build does not need them.
      const noSecrets = Object.fromEntries(Object.keys(have).map((k) => [k, 'false']));
      const pick = (want: boolean) => cases.find((c) => publishes(c) === want && c.ref === 'refs/heads/rc')!;
      const [rel, test] = runBash(
        stepScript('macos', 'Release run? (a release must be signed)'),
        [pick(true), pick(false)].map((c) => ({ cwd: dirOf(c), env: { ...ghEnv(c, root), ...noSecrets } })),
      );
      expect(rel.code, rel.log).toBe(1);
      expect(rel.log).toContain('a release must be signed and notarized');
      expect(test.code, test.log).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!hasPwsh)('the install check passes -UpgradeFrom only to an install-check.ps1 that declares it (rc and main before #129 is promoted)', () => {
    const script = stepScript('installer', 'Install check (installer x5, upgrade, uninstall, portable exe)');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-wf-upgrade-'));
    try {
      const params = {
        with: "param([string]$Release = 'release', [int]$Attempts = 5, [int]$SmokeAttempts = 1, [switch]$SkipPortable, [string]$UpgradeFrom = '')",
        without: "param([string]$Release = 'release', [int]$Attempts = 5, [int]$SmokeAttempts = 1, [switch]$SkipPortable)",
      };
      const dirs = Object.entries(params).map(([name, param]) => {
        const dir = path.join(root, name);
        fs.mkdirSync(path.join(dir, 'scripts', 'windows'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'scripts', 'windows', 'install-check.ps1'),
          `${param}\nSet-Content -LiteralPath (Join-Path $PSScriptRoot 'called.txt') -Value "Release=$Release Attempts=$Attempts Smoke=$SmokeAttempts Upgrade=[$UpgradeFrom] Args=[$args]"\nexit 0\n`,
        );
        return dir;
      });
      const r = runPwsh(script, dirs.map((cwd) => ({ cwd, env: { UPGRADE_FROM: path.join(root, 'prev', 'Setup-0.8.2.exe') } })));
      const called = dirs.map((d) => fs.readFileSync(path.join(d, 'scripts', 'windows', 'called.txt'), 'utf8').trim());
      expect(r[0].code, r[0].log).toBe(0);
      expect(called[0]).toBe(`Release=release Attempts=5 Smoke=1 Upgrade=[${path.join(root, 'prev', 'Setup-0.8.2.exe')}] Args=[]`);
      expect(r[0].log).not.toContain('::notice::');
      expect(r[1].code, r[1].log).toBe(0);
      expect(called[1]).toBe('Release=release Attempts=5 Smoke=1 Upgrade=[] Args=[]');
      expect(r[1].log).toContain('has no -UpgradeFrom: the upgrade cycle is skipped');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
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
    // The installer's (and the launcher's) required smoke lines are scripts/smoke-requirements.json (issue #170).
    expect(jobText('installer')).toContain('node scripts/check-smoke.mjs --mode installer $out');
    const smokeList = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'smoke-requirements.json'), 'utf8')) as { required: Array<Record<string, string>> };
    for (const mode of ['installer', 'launcher']) {
      expect(smokeList.required.find((r) => r.id === 'whisper')?.[mode], mode).toBe(String.raw`^smoke: whisper engine=[0-9.]+ ok path=.*\\resources\\whisper\\whisper-cli\.exe$`);
    }
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

// The macOS dmgs (docs/ROADMAP.md §19): the macos (both arch legs) and macos-e2e jobs are release gates, a release run
// must be Developer ID signed and notarized (docs/MACOS-SIGNING.md), and publish attaches both dmgs.
describe('Windows workflow: the macOS dmg gate', () => {
  const macos = code(job('macos'));
  const macosE2e = code(job('macos-e2e'));
  const publish = code(job('publish'));
  const installer = code(job('installer'));
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

  it('is a release gate: publish needs both legs and macos-e2e, and nothing calls the macOS jobs advisory', () => {
    expect(publish).toMatch(/^ {4}needs: \[installer, tests, e2e, launcher, linux, macos, macos-e2e\]$/m);
    // `needs: macos` waits for every matrix leg; fail-fast stays off so both legs always report.
    expect(macos).toMatch(/^ {4}strategy:\n {6}fail-fast: false\n/m);
    expect(workflow).not.toMatch(/advisory|ADVISORY|bring-up/);
    expect(workflow).not.toMatch(/TODO\(0\.7\.0|when macOS becomes official/);
    expect(macos).toMatch(/^ {4}name: macOS \$\{\{ matrix\.arch \}\} dmg \+ smoke test$/m);
    expect(macosE2e).toMatch(/^ {4}name: End-to-end tests on macOS$/m);
    // The Windows, Linux and macOS summaries name all seven required jobs.
    for (const block of [installer, code(job('linux')), macos]) {
      expect(block).toContain('the required jobs of this run (installer, tests, e2e, launcher, linux, macos, macos-e2e) are green');
      expect(block).not.toContain('every job in this run is green');
    }
  });

  it('a release run must be signed: the macos job decides release like the installer job and fails without the secrets', () => {
    // The decision, made first: a tag push, or a push to main (stable version) or rc (release candidate) with a
    // non-empty changelog section and no tag on origin.
    const rel = /- name: Release run\? \(a release must be signed\)\n\s+id: rel\n([\s\S]*?)\n\n/.exec(macos)?.[1];
    expect(rel).toBeDefined();
    expect(macos.indexOf('- name: Release run?')).toBeLessThan(macos.indexOf('npm ci'));
    expect(rel).toContain('if [ "$EVENT_NAME" = push ] && [ "$REF_TYPE" = tag ]; then\n            release=true');
    expect(rel).toContain('elif [ "$EVENT_NAME" = push ] && [ "$REF" = refs/heads/main ] && [[ "$v" != *-* ]] && [ "$section" = true ]; then');
    expect(rel).toContain('elif [ "$EVENT_NAME" = push ] && [ "$REF" = refs/heads/rc ] && [[ "$v" =~ $rc_version ]] && [ "$section" = true ]; then');
    expect(rel).toContain("rc_version='^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[1-9][0-9]*$'");
    expect(rel).toContain('git ls-remote --exit-code --tags origin "refs/tags/v$v" || rc=$?');
    expect(rel).toMatch(/if \[ "\$rc" -eq 2 \]; then\n\s+release=true\n\s+elif \[ "\$rc" -ne 0 \]; then\n\s+echo "::error::git ls-remote failed/);
    // The same changelog rule as the installer job's Get-ChangelogSection.
    expect(installer).toContain("$head = '^## \\[' + [regex]::Escape($ver) + '\\](\\s|$)'");
    expect(rel).toContain('new RegExp("^## \\\\[" + v.split(".").join("\\\\.") + "\\\\](\\\\s|$)")');
    expect(rel).toContain('if (/^## \\[/.test(l) || /^\\[[^\\]]+\\]:\\s/.test(l)) break;');
    // Only whether each secret is set reaches the step, and a release with any missing fails.
    for (const s of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
      expect(rel).toContain(`HAVE_${s}: \${{ secrets.${s} != '' }}`);
    }
    expect(rel).toContain('echo "release=$release" >> "$GITHUB_OUTPUT"');
    expect(rel).toMatch(/if \[ -n "\$missing" \]; then\n\s+echo "::error::This run releases v\$v, and a release must be signed and notarized[^\n]*\n\s+exit 1/);
    // Checked again where signing is set up and where the signature is checked.
    expect(macos).toMatch(/- name: Code signing setup\n\s+id: sign\n\s+env:\n\s+RELEASE: \$\{\{ steps\.rel\.outputs\.release \}\}\n/);
    expect(macos).toMatch(/if \[ "\$have" -eq 0 \] && \[ "\$RELEASE" = true \]; then\n\s+echo '::error::[^\n]*\n\s+exit 1/);
    expect(macos).toMatch(/- name: Code signature\n\s+env:\n(?:\s+[A-Z]+: .*\n)*\s+RELEASE: \$\{\{ steps\.rel\.outputs\.release \}\}\n/);
    expect(macos).toMatch(/if \[ "\$RELEASE" = true \] && \[ "\$SIGNED" != true \]; then\n\s+echo '::error::[^\n]*\n\s+exit 1/);
    // A signed build is not accepted unless Gatekeeper sees it as notarized and the ticket is stapled.
    expect(macos).toMatch(/grep -q 'source=Notarized Developer ID' [^\n]*bad=1/);
    expect(macos).toMatch(/xcrun stapler validate "\$APP" \|\| \{[^\n]*bad=1/);
  });

  it('publish attaches both dmgs, after checking that all five release files exist and carry the version', () => {
    for (const arch of ['arm64', 'x64']) {
      expect(publish).toMatch(new RegExp(`- uses: actions/download-artifact@v4\\n\\s+with:\\n\\s+name: ReCut-macos-${arch}\\n\\s+path: release\\n`));
      expect(publish).toMatch(new RegExp(`files: \\|\\n(?:\\s+release/.*\\n)*\\s+release/ReCut-\\*-macos-${arch}\\.dmg\\n`));
    }
    const files = /- name: Release files\n([\s\S]*?)\n\n/.exec(publish)?.[1];
    expect(files).toBeDefined();
    expect(publish.indexOf('- name: Release files')).toBeLessThan(publish.indexOf('- name: Publish GitHub Release'));
    for (const name of [
      'ReCut-Setup-$v.exe',
      'ReCut-Portable-$v.exe',
      'ReCut-$v-linux-x86_64.AppImage',
      'ReCut-$v-macos-arm64.dmg',
      'ReCut-$v-macos-x64.dmg',
    ]) {
      expect(files, name).toContain(`name = "${name}"`);
    }
    // $v is the tag without its "v", pre-release part included (see the release-candidate tests below).
    expect(files).toMatch(/if \(\$env:TAG -cmatch '\^v\([^']*\)\$'\) \{ \$v = \$Matches\[1\] \}/);
    expect(files).toContain('$found.Count -ne 1 -or $found[0].Name -cne $want.name -or $found[0].Length -eq 0');
    expect(files).toContain('exit $bad');
  });

  it('the release notes say which dmg to pick and that macOS 12 or later is needed', () => {
    expect(installer).toContain('**ReCut-$v-macos-arm64.dmg** (Apple Silicon');
    expect(installer).toContain('**ReCut-$v-macos-x64.dmg** (Intel');
    expect(installer).toContain('macOS 12 or later');
    expect(installer).toContain('FFmpeg is bundled in every download');
    expect(installer).toContain('on Windows, Linux and macOS runners before publishing');
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
    // No BLAS on either arch: ggml's Accelerate backend imports the macOS 13.3 BLAS interface (target: macOS 12), and
    // any such import fails the build on both archs.
    expect(sh).not.toContain('-DGGML_BLAS=ON');
    expect(sh.match(/^ {4}-DGGML_BLAS=OFF$/gm)).toHaveLength(2);
    expect(sh).toMatch(/if nm -u "\$f" 2>\/dev\/null \| grep -q 'NEWLAPACK'; then\n(?:.*\n){1,2}\s+exit 1\n\s+fi/);
    expect(sh).not.toContain('note: $name imports');
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
    // The release itself is decided by the tag-push fallback and the automatic release on main or rc.
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
    expect(publish).toMatch(/files: \|\n\s+release\/ReCut-Setup-\*\.exe\n\s+release\/ReCut-Portable-\*\.exe\n\s+release\/ReCut-\*-linux-x86_64\.AppImage\n\s+release\/ReCut-\*-macos-arm64\.dmg\n\s+release\/ReCut-\*-macos-x64\.dmg\n/);
  });

  it('publish: the release-files check accepts a candidate tag and wants the five files named for the full version', () => {
    const files = /- name: Release files\n([\s\S]*?)\n\n/.exec(publish)?.[1];
    expect(files).toBeDefined();
    const m = /if \(\$env:TAG -cmatch '(\^v\([^']*\)\$)'\) \{ \$v = \$Matches\[1\] \}/.exec(files!);
    expect(m).not.toBeNull();
    const tag = new RegExp(m![1]);
    for (const [t, v] of [['v0.8.0', '0.8.0'], ['v1.0.0', '1.0.0'], ['v1.0.0-rc.1', '1.0.0-rc.1'], ['v1.0.0-rc.10', '1.0.0-rc.10']]) {
      expect(tag.exec(t)?.[1], t).toBe(v);
    }
    for (const bad of ['1.0.0', 'v1.0', 'v1.0.0-', 'v1.0.0-rc..1', 'v1.0.0+b', 'latest']) expect(tag.test(bad), bad).toBe(false);
    // The same tags as the final release check (which refuses to publish anything else).
    const finalRe = /-cnotmatch '(\^v[^']*)'/.exec(publish)![1];
    expect(m![1].replace(/^\^v\((.*)\)\$$/, '^v$1$')).toBe(finalRe);
  });

  it('a candidate is a release run for the macos job too, so its dmgs must be signed and notarized', () => {
    const macos = code(job('macos'));
    const rel = /- name: Release run\? \(a release must be signed\)\n\s+id: rel\n([\s\S]*?)\n\n/.exec(macos)?.[1];
    expect(rel).toBeDefined();
    // Any tag push that starts the workflow (vX.Y.Z or vX.Y.Z-rc.N) is a release run.
    expect(rel).toContain('if [ "$EVENT_NAME" = push ] && [ "$REF_TYPE" = tag ]; then\n            release=true');
    // On rc: run the step's own changelog check with a candidate version.
    const script = /node -e '\n([\s\S]*?)\n\s*'\)/.exec(rel!)?.[1];
    expect(script).toBeDefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-rc-macos-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'recut', version: '1.0.0-rc.2' }));
      const run = (changelog: string) => {
        fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
        const r = spawnSync(process.execPath, ['-e', script!], { cwd: dir, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      expect(run('# Changelog\n\n## [1.0.0-rc.2] - 2026-11-10\n\n- Fix.\n\n## [1.0.0-rc.1] - 2026-11-01\n\n- First.\n')).toBe('1.0.0-rc.2 true');
      expect(run('# Changelog\n\n## [1.0.0-rc.1] - 2026-11-01\n\n- First.\n')).toBe('1.0.0-rc.2 false');
      expect(run('# Changelog\n\n## [1.0.0-rc.2] - 2026-11-10\n## [1.0.0-rc.1]\n- First.\n')).toBe('1.0.0-rc.2 false');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
