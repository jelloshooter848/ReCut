import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Issue #170: "Start ReCut.cmd" (scripts/windows/start-recut.ps1) never set up the speech-to-text engine that the
// installer bundles, and its CI smoke check did not notice. These checks keep the launcher in step with the installer:
//   - every folder the installer bundles from resources/ (package.json build.extraResources) is set up by the launcher;
//   - both Windows smoke checks read one list of required lines, scripts/smoke-requirements.json (scripts/check-smoke.mjs),
//     and the launcher's -Smoke (CI only) requires the engine and OCR unconditionally;
//   - no prompt can block -Smoke or a CI run; without the C++ toolchain setup-dev.mjs says what to install and exits 0.
// They read the scripts as text (comments dropped) and run the Node parts; no PowerShell needed.

const repo = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');

/** PowerShell without comments (<# … #> blocks and whole-line # comments): a mention in a comment proves nothing. */
function psCode(text: string): string {
  return text
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** JavaScript without comments (/* … *\/ blocks and whole-line // comments). */
function jsCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

const launcherPath = 'scripts/windows/start-recut.ps1';
const launcher = () => psCode(read(launcherPath));
const setupDev = () => jsCode(read('scripts/setup-dev.mjs'));

/** The line(s) of the launcher that run scripts/setup-dev.mjs with node. */
const SETUP_DEV_CALL = /^\s*&\s*node\s+\(Join-Path \$Root 'scripts\\setup-dev\.mjs'\)(.*)$/m;

/** The folders under resources/ that electron-builder bundles into the installer. */
function bundledResourceFolders(): string[] {
  const pkg = JSON.parse(read('package.json')) as { build: { extraResources: Array<{ from: string } | string> } };
  return pkg.build.extraResources
    .map((e) => (typeof e === 'string' ? e : e.from))
    .filter((from) => from.startsWith('resources/'))
    .map((from) => from.slice('resources/'.length).split('/')[0]);
}

describe('launcher parity: Start ReCut.cmd sets up everything the installer bundles', () => {
  it('the installer bundles FFmpeg and the speech-to-text engine from resources/', () => {
    // Guards the parity test below against passing on an empty list.
    expect(bundledResourceFolders()).toEqual(expect.arrayContaining(['ffmpeg', 'whisper']));
  });

  for (const name of bundledResourceFolders()) {
    it(`start-recut.ps1 sets up resources/${name} (get-${name}.ps1 or scripts/setup-dev.mjs)`, () => {
      const code = launcher();
      // Either the launcher calls the folder's own script…
      const viaScript = code.includes(`get-${name}.ps1`) && fs.existsSync(path.join(repo, 'scripts', 'windows', `get-${name}.ps1`));
      // …or it runs the development setup, which sets the folder up with that same script.
      const dev = setupDev();
      const viaSetupDev = SETUP_DEV_CALL.test(code) && dev.includes(`run('${name}'`) && dev.includes("`get-${tool}.ps1`");
      expect(
        viaScript || viaSetupDev,
        `${launcherPath} never sets up resources/${name}, which the installer bundles (package.json build.extraResources). ` +
          `Call scripts/windows/get-${name}.ps1 from it, or have scripts/setup-dev.mjs set it up.`,
      ).toBe(true);
    });
  }

  it('the speech-to-text setup runs before ReCut starts, with hints that name the launcher', () => {
    const code = launcher();
    const m = SETUP_DEV_CALL.exec(code);
    expect(m, 'start-recut.ps1 runs scripts/setup-dev.mjs').not.toBeNull();
    const at = m!.index;
    expect(at).toBeLessThan(code.indexOf("Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Root | Out-Null"));
    expect(at).toBeLessThan(code.indexOf("$env:RECUT_SMOKE = '1'"));
    // RECUT_SETUP_RETRY makes setup-dev.mjs's "then run: ..." hints name the launcher.
    expect(code.slice(0, at)).toMatch(/\$env:RECUT_SETUP_RETRY = "[^"]*Start ReCut\.cmd[^"]*"/);
    // The step itself never ends the launcher: a double-click start goes on without speech-to-text.
    const step = code.slice(at, code.indexOf('if ($Smoke -and -not (Test-Path $whisperCli))'));
    expect(step).not.toMatch(/\bFail\b|\bexit\b/);
  });
});

describe('launcher -Smoke is strict and never waits for input', () => {
  it('-Smoke fails when resources\\whisper was not set up, before the app starts', () => {
    const code = launcher();
    const strict = code.indexOf('if ($Smoke -and -not (Test-Path $whisperCli)) {');
    expect(strict, 'start-recut.ps1 fails -Smoke without the engine').toBeGreaterThan(0);
    expect(code.slice(strict).split('\n')[1]).toMatch(/^\s*Fail "Smoke test failed: the speech-to-text engine/);
    expect(code).toContain("$whisperCli = Join-Path $Root 'resources\\whisper\\whisper-cli.exe'");
    expect(strict).toBeGreaterThan(SETUP_DEV_CALL.exec(code)!.index);
    expect(strict).toBeLessThan(code.indexOf("$env:RECUT_SMOKE = '1'"));
    // RECUT_WHISPER_CLI cannot stand in for the engine the launcher sets up.
    const clear = code.indexOf('if ($Smoke) { Remove-Item Env:RECUT_WHISPER_CLI -ErrorAction SilentlyContinue }');
    expect(clear).toBeGreaterThan(0);
    expect(clear).toBeLessThan(SETUP_DEV_CALL.exec(code)!.index);
    // No "passes without the engine" branch is left in the smoke check.
    expect(code.slice(code.indexOf("$env:RECUT_SMOKE = '1'"))).not.toContain('$haveWhisper');
  });

  it('every prompt is guarded by $Interactive, which is false with -Smoke, in CI and with redirected input', () => {
    const code = launcher();
    expect(code).toMatch(/^\$Interactive = \(-not \$Smoke\) -and \(-not \$env:CI\) -and \[Environment\]::UserInteractive$/m);
    expect(code).toMatch(/^try \{ if \(\[Console\]::IsInputRedirected\) \{ \$Interactive = \$false \} \} catch \{ \}$/m);
    const lines = code.split('\n');
    const prompts = lines.map((l, i) => ({ l, i })).filter(({ l }) => /Read-Host/.test(l));
    // "Press Enter to close" (Fail), the winget question, and James's "Press Enter to start ReCut without speech-to-text".
    expect(prompts.length).toBe(3);
    for (const { l, i } of prompts) {
      expect(`${lines[i - 1]}\n${l}`, l.trim()).toMatch(/\$Interactive/);
    }
    expect(code).toMatch(/if \(\$Interactive -and -not \(Test-Path \$notice\)\) \{\n\s*Read-Host "Press Enter to start ReCut without speech-to-text"/);
  });
});

describe('without the C++ toolchain: setup-dev.mjs says what to install and never fails the launcher', () => {
  let tmp: string;
  let preload: string;

  beforeAll(() => {
    // A copy of setup-dev.mjs in an empty checkout (no resources/whisper), run as on Windows with nothing on PATH, so
    // cmake is "not installed". RECUT_FFMPEG skips the FFmpeg step (the launcher sets FFmpeg up before this).
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-launcher-setup-'));
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.mkdirSync(path.join(tmp, 'empty-path'));
    fs.copyFileSync(path.join(repo, 'scripts', 'setup-dev.mjs'), path.join(tmp, 'scripts', 'setup-dev.mjs'));
    preload = path.join(tmp, 'as-windows.mjs');
    fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });\n");
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function runSetup(retry?: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!/^(path|RECUT_.*)$/i.test(k)) env[k] = v;
    }
    env.PATH = path.join(tmp, 'empty-path');
    env.RECUT_FFMPEG = path.join(tmp, 'no-ffmpeg');
    if (retry !== undefined) env.RECUT_SETUP_RETRY = retry;
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(tmp, 'scripts', 'setup-dev.mjs')], {
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
    return { status: r.status, lines: r.stdout.split('\n').filter((l) => l.trim() !== ''), stderr: r.stderr };
  }

  it('from "Start ReCut.cmd": what to install and to start the launcher again; exit 0', () => {
    const retry = /\$env:RECUT_SETUP_RETRY = "([^"]*)"/.exec(launcher())?.[1];
    expect(retry).toBeDefined();
    const r = runSetup(retry);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^\[setup\] Skipping the speech-to-text engine: /);
    expect(r.lines[0]).toContain('cmake and Visual Studio 2022 or newer with the "Desktop development with C++" workload');
    expect(r.lines[0]).toContain(`then run: ${retry}`);
  });

  it('from npm run dev / npm start / npm run setup: the same line, retried with npm run setup', () => {
    const r = runSetup();
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^\[setup\] Skipping the speech-to-text engine: .*Install them, then run: npm run setup$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The shared list of required smoke lines.

interface SmokeSpec {
  modes: string[];
  forbidden: string;
  required: Array<{ id: string; what: string } & Record<string, string>>;
}
const spec = () => JSON.parse(read('scripts/smoke-requirements.json')) as SmokeSpec;

// Real reports from CI (run 285 on dev): the unpacked installer build, and "Start ReCut.cmd -Smoke" from a clone,
// which had no speech-to-text engine (issue #170). LAUNCHER_REPORT is that launcher report with the engine line a run
// from source prints once resources\whisper is set up (electron/main.ts runSmoke; the app finds it via the working
// directory, electron/whisper/engine.ts).
const INSTALLER_REPORT = [
  'smoke: protocol status=206 content-length=10 content-range=bytes 10-19/188784128 body-bytes=10 type=application/octet-stream',
  'smoke: HEAD status=200 content-length=188784128 accept-ranges=bytes',
  'smoke: missing status=404',
  'smoke: unsatisfiable status=416 content-range=bytes */188784128',
  'smoke: ffmpeg path=D:\\a\\ReCut\\ReCut\\release\\win-unpacked\\resources\\ffmpeg\\ffmpeg.exe ffprobe path=D:\\a\\ReCut\\ReCut\\release\\win-unpacked\\resources\\ffmpeg\\ffprobe.exe version=9.0.2-essentials_build-www.gyan.dev',
  'smoke: ffmpeg encode+probe ok duration=1.00 video=h264 320x180 audio=aac browserPlayable=true',
  'smoke: licences shipped=LICENSE,THIRD_PARTY_NOTICES.md,FFMPEG-BUILD.txt,FFMPEG-LICENSE.txt,FFMPEG-README.txt,LICENSE.electron.txt,LICENSES.chromium.html,LICENSE,WHISPER-LICENSE.txt,WHISPER-BUILD.txt absent=none',
  'smoke: ocr core=relaxedsimd-lstm ok worker=D:\\a\\ReCut\\ReCut\\release\\win-unpacked\\resources\\app.asar.unpacked\\dist\\electron\\ocr\\worker.js',
  'smoke: whisper engine=1.9.5 ok path=D:\\a\\ReCut\\ReCut\\release\\win-unpacked\\resources\\whisper\\whisper-cli.exe',
  'smoke: window loaded=file:///D:/a/ReCut/ReCut/release/win-unpacked/resources/app.asar/dist/renderer/index.html layout=mounted',
];
const LAUNCHER_REPORT_NO_ENGINE = [
  'smoke: protocol status=206 content-length=10 content-range=bytes 10-19/188784128 body-bytes=10 type=application/octet-stream',
  'smoke: HEAD status=200 content-length=188784128 accept-ranges=bytes',
  'smoke: missing status=404',
  'smoke: unsatisfiable status=416 content-range=bytes */188784128',
  'smoke: ffmpeg path=D:\\a\\ReCut\\ReCut\\resources\\ffmpeg\\ffmpeg.exe ffprobe path=D:\\a\\ReCut\\ReCut\\resources\\ffmpeg\\ffprobe.exe version=9.0.2-essentials_build-www.gyan.dev',
  'smoke: ffmpeg encode+probe ok duration=1.00 video=h264 320x180 audio=aac browserPlayable=true',
  'smoke: licences shipped=LICENSE,THIRD_PARTY_NOTICES.md,FFMPEG-BUILD.txt,FFMPEG-LICENSE.txt,FFMPEG-README.txt,LICENSES.chromium.html,LICENSE absent=LICENSE.electron.txt,WHISPER-LICENSE.txt,WHISPER-BUILD.txt',
  'smoke: ocr core=relaxedsimd-lstm ok worker=D:\\a\\ReCut\\ReCut\\dist\\electron\\ocr\\worker.js',
  'smoke: whisper engine=absent (not bundled in a source run)',
  'smoke: window loaded=file:///D:/a/ReCut/ReCut/dist/renderer/index.html layout=mounted',
];
const LAUNCHER_ENGINE_LINE = 'smoke: whisper engine=1.9.5 ok path=D:\\a\\ReCut\\ReCut\\resources\\whisper\\whisper-cli.exe';
const LAUNCHER_REPORT = LAUNCHER_REPORT_NO_ENGINE.map((l) => (l.startsWith('smoke: whisper ') ? LAUNCHER_ENGINE_LINE : l));

describe('one list of required smoke lines for the installer and the launcher', () => {
  let tmp: string;
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-smoke-check-')); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  let n = 0;
  function check(mode: string, lines: string[], eol = '\n') {
    const file = path.join(tmp, `report-${++n}.txt`);
    fs.writeFileSync(file, lines.join(eol) + eol);
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'check-smoke.mjs'), '--mode', mode, file], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
  }

  it('lists the speech-to-text engine and OCR for both modes, with patterns that compile', () => {
    const s = spec();
    expect(s.modes).toEqual(['installer', 'launcher']);
    const ids = s.required.map((r) => r.id);
    for (const id of ['protocol', 'ffmpeg', 'ocr', 'whisper']) {
      const r = s.required.find((x) => x.id === id);
      expect(r, id).toBeDefined();
      for (const mode of s.modes) expect(typeof r![mode], `${id} / ${mode}`).toBe('string');
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of s.required) {
      for (const mode of s.modes) if (r[mode] !== undefined) expect(() => new RegExp(r[mode], 'i'), `${r.id} / ${mode}`).not.toThrow();
    }
    // The engine must be the one in resources\whisper (the folder the launcher sets up and the installer bundles).
    expect(s.required.find((r) => r.id === 'whisper')!.launcher).toContain('\\\\resources\\\\whisper\\\\whisper-cli\\.exe$');
  });

  it('accepts real passing reports of both modes, with LF or CRLF line ends', () => {
    for (const eol of ['\n', '\r\n']) {
      let r = check('installer', INSTALLER_REPORT, eol);
      expect(r.status, r.out).toBe(0);
      r = check('launcher', LAUNCHER_REPORT, eol);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('whisper');
    }
  });

  it('fails the launcher without the speech-to-text engine (issue #170) or without OCR, with LF or CRLF', () => {
    let r = check('launcher', LAUNCHER_REPORT_NO_ENGINE, '\r\n');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing "whisper"/);
    r = check('launcher', LAUNCHER_REPORT_NO_ENGINE);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing "whisper"/);
    r = check('launcher', LAUNCHER_REPORT.filter((l) => !l.startsWith('smoke: ocr ')));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing "ocr"/);
    r = check('launcher', LAUNCHER_REPORT.map((l) => (l.startsWith('smoke: whisper ') ? 'smoke: whisper engine=FAILED spawn ENOENT' : l)));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/report has a failure: smoke: whisper engine=FAILED/);
  });

  it('keeps the per-mode OCR worker path: app.asar.unpacked when packaged, dist\\electron\\ocr from source', () => {
    let r = check('launcher', INSTALLER_REPORT);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing "ocr"/);
    r = check('installer', LAUNCHER_REPORT);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/missing "ocr"/);
    // A run from source may use an FFmpeg on PATH: only the installer requires resources\ffmpeg.
    r = check('launcher', LAUNCHER_REPORT.map((l) => l.replace(/D:\\a\\ReCut\\ReCut\\resources\\ffmpeg/g, 'C:\\ffmpeg\\bin')));
    expect(r.status, r.out).toBe(0);
  });

  it('fails the installer without the engine, OCR, a mounted window, or with any FAILED line', () => {
    for (const drop of ['smoke: whisper ', 'smoke: ocr ', 'smoke: window ', 'smoke: ffmpeg encode', 'smoke: protocol ']) {
      const r = check('installer', INSTALLER_REPORT.filter((l) => !l.startsWith(drop)));
      expect(r.status, drop).toBe(1);
    }
    const r = check('installer', [...INSTALLER_REPORT, 'smoke: licences check error: FAILED']);
    expect(r.status).toBe(1);
  });

  it('refuses an unknown mode or a missing report (exit 2)', () => {
    expect(check('portable', INSTALLER_REPORT).status).toBe(2);
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'check-smoke.mjs'), '--mode', 'installer', path.join(tmp, 'none.txt')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });

  it('both smoke checks run it, and neither keeps patterns of its own', () => {
    // .github/workflows/windows.yml, installer job, "Smoke-test the unpacked app".
    const wf = read('.github/workflows/windows.yml');
    const step = /- name: Smoke-test the unpacked app\n([\s\S]*?)\n\n/.exec(wf)?.[1] ?? '';
    const stepCode = step.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(stepCode).toContain('node scripts/check-smoke.mjs --mode installer $out');
    expect(stepCode).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ throw 'smoke test failed' \}/);
    expect(stepCode).not.toMatch(/whisper engine=|encode\\\+probe|status=206|ocr core=/);
    // scripts/windows/start-recut.ps1 -Smoke.
    const code = launcher();
    const smoke = code.slice(code.indexOf("$env:RECUT_SMOKE = '1'"));
    expect(smoke).toContain("& node (Join-Path $Root 'scripts\\check-smoke.mjs') --mode launcher $out");
    expect(smoke).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ Fail "Smoke test failed\." \}/);
    expect(smoke).not.toMatch(/whisper engine=|encode\\\+probe|status=206|ocr core=/);
  });

  it('the launcher CI job restores the engine from the other Windows jobs\' cache before running the launcher', () => {
    const wf = read('.github/workflows/windows.yml');
    const block = (name: string) => {
      const lines = wf.split('\n');
      const start = lines.findIndex((l) => l === `  ${name}:`);
      const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][a-z-]*:$/.test(l));
      return lines.slice(start, end < 0 ? undefined : end).join('\n');
    };
    const saveKey = (job: string) => /- name: Speech-to-text engine cache\n\s+id: whisper-cache\n\s+uses: actions\/cache@v4\n\s+with:\n\s+path: resources\/whisper\n\s+key: (.+)\n/.exec(block(job))?.[1];
    const launcherJob = block('launcher');
    const restoreKey = /- name: Speech-to-text engine cache \(restore only\)\n\s+uses: actions\/cache\/restore@v4\n\s+with:\n\s+path: resources\/whisper\n\s+key: (.+)\n/.exec(launcherJob)?.[1];
    expect(restoreKey).toBeDefined();
    // The key covers the engine's build script, so a change to it (like the PowerShell 5.1 fix) rebuilds the engine.
    expect(restoreKey).toContain("hashFiles('scripts/whisper-source.mjs', 'scripts/windows/get-whisper.ps1')");
    for (const job of ['installer', 'tests', 'e2e']) expect(saveKey(job), job).toBe(restoreKey);
    expect(launcherJob.indexOf('- name: Speech-to-text engine cache')).toBeLessThan(launcherJob.indexOf('call "Start ReCut.cmd" -Smoke'));
    // The launcher compiles the engine itself on a miss: no separate build step that would hide a broken launcher.
    expect(launcherJob).not.toMatch(/get-whisper\.ps1 -Dest/);
  });
});

describe('get-whisper.ps1 runs under Windows PowerShell 5.1 (what the launcher and npm run setup use)', () => {
  it('reads whisper-cli --version / --help through Get-NativeOutput, not a stderr redirect under ErrorActionPreference Stop', () => {
    const code = psCode(read('scripts/windows/get-whisper.ps1'));
    expect(code).toMatch(/^\$ErrorActionPreference = 'Stop'$/m);
    // 5.1 turns redirected native stderr into error records, fatal under 'Stop'; the helper runs with 'Continue'.
    const helper = /function Get-NativeOutput\([^)]*\) \{\n\s*\$ErrorActionPreference = 'Continue'\n\s*\(\(& \$Exe @Arguments 2>&1\)/.exec(code);
    expect(helper, 'Get-NativeOutput sets Continue before redirecting stderr').not.toBeNull();
    expect(code).toContain("$version = (Get-NativeOutput $exe @('--version')).Trim()");
    expect(code).toContain("$help = Get-NativeOutput $exe @('--help')");
    // No other stderr redirect of a native command in the script.
    const outside = code.replace(helper![0], '');
    expect(outside).not.toMatch(/2>&1|2>\$null/);
  });
});
