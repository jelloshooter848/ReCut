#!/usr/bin/env node
/**
 * Performance gate: runs the node perf suite and the Electron perf script one after the other, reads their JSON
 * results and prints every budgeted row in three sections by tier (docs/DEVELOPMENT.md → Performance gate):
 *
 *   Gates        user-facing; the bench's threshold is pass/fail.
 *   Guardrails   architecture health; FAIL on a material regression against tests/perf/baseline.json
 *                (REGRESSION_RULE in _gate.mjs), and also on the threshold unless the row marks it `reference`.
 *   Diagnostics  microbenchmarks; value, reference threshold and trend against the baseline. Never fail.
 *
 * Calibration: before each run, tests/perf/calibrate.mjs measures how fast this host is (fixed js, ffmpeg and render
 * workloads) into <run dir>/calibration.json. The baseline records the same scores for the machine it was seeded on
 * (the reference machine). The ratio k = this host / reference decides how the run is judged: within
 * +-CALIBRATION_TOLERANCE every row is judged raw; beyond it, time and rate rows (and long-task counts) are normalized
 * to the reference machine first, so a slow host is not a regression and a fast host does not hide one. Raw verdicts
 * are printed next to the normalized ones. Counts and structural rows are never normalized (_gate.mjs metricClass).
 *
 * Exits 1 if a gate or guardrail fails, if a suite exits non-zero, if a result file is missing, or if a guardrail
 * row recorded in the baseline is no longer measured.
 *
 *   npm run perf:check                         # one run of both suites (~15-25 min; run it alone on the machine)
 *   npm run perf:check -- --runs 2             # N runs; value = median, a row fails unless it passed in most runs
 *   npm run perf:check -- --from <dir> [...]   # no run: aggregate result dirs from earlier runs
 *   options: --skip-build (dist/ already built), --node-only, --electron-only, --no-calibrate
 *
 *   node tests/perf/perf-check.mjs --update-baseline [--reason "<why>"] [--commit <sha>] [--machine-notes "<text>"] --from <dir> [...]
 *   node tests/perf/perf-check.mjs --update-baseline [--reason "<why>"] --runs 2
 *       rewrite tests/perf/baseline.json (rows and calibration) from the medians of these runs (>= 2 runs). Only in
 *       a PR that states why (accepted cost of a feature, locking in an improvement, a new reference machine).
 *
 *   node tests/perf/perf-check.mjs --ab <dirA> <dirB> [--runs N] [--electron-only | --node-only] [--skip-build]
 *       same-host A/B: <dirA> and <dirB> are two checkouts with node_modules (npm run perf:compare -- <refA> <refB>
 *       makes them from git refs). Builds each once, then runs A, B, A, B, ... (N runs each, default 2) on this
 *       host and prints per-row medians, B/A and a noise band; WORSE = B worse than A beyond the band in every run
 *       pair. Exits 1 if a gate or guardrail row is WORSE. Needs no baseline.
 *
 * Budgets and tiers live in exactly one place: the rows the benches record via ms() / record() / rec() in
 * tests/perf/*.perf.test.ts (_report.ts) and tests/perf/electron-perf.mjs. Every row with a boolean `pass` is a
 * budgeted row; a budgeted row without a `tier` is a gate. This script never re-derives or changes a threshold.
 *
 * Results go to $RECUT_PERF_OUT (default test-results/perf), or <out>/run-<k> with --runs > 1, <out>/ab/{A,B}/run-<k>.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineInfo, SPREAD_WARN } from './calibrate.mjs';
import { REGRESSION_RULE, CALIBRATION_TOLERANCE, CATEGORIES, TIERS, isNum, r2, aggregate, evaluate, combineScores, calibrationRatios, compareAB, scoresOf } from './_gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = path.join(ROOT, 'tests', 'perf', 'baseline.json');
const CALIBRATE = path.join(ROOT, 'tests', 'perf', 'calibrate.mjs');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const listAfter = (f) => { const i = argv.indexOf(f); if (i < 0) return null; const out = []; for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(path.resolve(argv[k])); return out; };
const NODE_FILES = ['store', 'panels', 'main', 'export'];
const ELECTRON_FILES = ['electron'];
const runNode = !has('--electron-only');
const runElectron = !has('--node-only');
const calibrateRuns = !has('--no-calibrate');
const expected = [...(runNode ? NODE_FILES : []), ...(runElectron ? ELECTRON_FILES : [])];
const OUT = path.resolve(process.env.RECUT_PERF_OUT || path.join(ROOT, 'test-results', 'perf'));
const pct = (x) => `${Math.round(x * 100)} %`;
const kx = (k) => (isNum(k) ? `x${k.toFixed(2)}` : '—');

function load() {
  const [l1] = os.loadavg();
  return `nproc ${os.cpus().length}, load average ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}${l1 > os.cpus().length * 0.5 ? '  (busy machine: results will be noisy)' : ''}`;
}

/** Waits (up to 90 s) for the 1-min load average to drop below half the cores, e.g. after the previous suite. */
function settle() {
  const t = Date.now();
  while (os.loadavg()[0] > os.cpus().length * 0.5 && Date.now() - t < 90_000) spawnSync('sleep', ['5']);
}

function sh(cmd, args, env, cwd = ROOT) {
  settle();
  console.log(`\n[perf:check] $ ${cmd} ${args.join(' ')}${cwd !== ROOT ? `   (in ${cwd})` : ''}\n[perf:check] ${load()}`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  console.log(`[perf:check] exit ${r.status ?? r.signal} after ${Math.round((Date.now() - t) / 1000)} s`);
  return r.status === 0;
}

/** Measures this host into <dir>/calibration.json (tests/perf/calibrate.mjs). A failure is reported, not fatal. */
function calibrateInto(dir) {
  fs.rmSync(path.join(dir, 'calibration.json'), { force: true });
  if (!calibrateRuns) return [];
  const ok = sh(process.execPath, ['--expose-gc', CALIBRATE, '--json', path.join(dir, 'calibration.json')], {});
  return ok ? [] : ['calibration failed (calibrate.mjs exited non-zero): this run is judged raw'];
}

function build(root) {
  return sh('npm', ['run', 'build'], {}, root) ? [] : [`npm run build failed${root !== ROOT ? ` in ${root}` : ''}`];
}

/** Runs the selected suites of the checkout at `root` once into `dir`; returns the problems (non-zero exits). */
function runOnce(dir, root = ROOT, { buildFirst = !has('--skip-build') } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of expected) fs.rmSync(path.join(dir, `${f}.json`), { force: true }); // never read a stale result
  const problems = calibrateInto(dir);
  if (runNode) {
    const env = { RECUT_PERF_OUT: dir, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`.trim() };
    if (!sh('npx', ['vitest', 'run', '-c', 'tests/perf/vitest.config.ts'], env, root)) problems.push(`node perf suite exited non-zero (a test assertion failed or the run crashed)${root !== ROOT ? ` in ${root}` : ''}`);
  }
  if (runElectron) {
    if (buildFirst) { const b = build(root); if (b.length) return [...problems, ...b]; }
    const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
    const ok = useXvfb
      ? sh('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', 'node', 'tests/perf/electron-perf.mjs'], { RECUT_PERF_OUT: dir }, root)
      : sh('node', ['tests/perf/electron-perf.mjs'], { RECUT_PERF_OUT: dir }, root);
    if (!ok) problems.push(`electron-perf.mjs exited non-zero${root !== ROOT ? ` in ${root}` : ''}`);
  }
  return problems;
}

function readCalibration(dir) {
  const f = path.join(dir, 'calibration.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function readRuns(dirs) {
  const problems = [];
  const runs = dirs.map((dir) => {
    const rows = [];
    for (const f of expected) {
      const file = path.join(dir, `${f}.json`);
      if (!fs.existsSync(file)) { problems.push(`missing ${file}`); continue; }
      let data;
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(`unreadable ${file}: ${e.message}`); continue; }
      const seen = new Map();
      for (const r of data) {
        const base = `${f}|${r.section}|${r.metric}`;
        const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
        rows.push({ ...r, file: f, key: n > 1 ? `${base}#${n}` : base });
      }
    }
    return rows;
  });
  return { runs, problems, cals: dirs.map(readCalibration) };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) { console.log(`[perf:check] PROBLEM: unreadable ${BASELINE}: ${e.message}`); return null; }
}

const w = (s, n) => String(s).padEnd(n).slice(0, n);
const fmt = (v, unit) => `${isNum(v) ? r2(v) : v}${unit && isNum(v) ? ` ${unit}` : ''}`;

function printSection(title, rows, nRuns) {
  console.log(`\n== ${title} (${rows.length}) ${'='.repeat(Math.max(0, 150 - title.length))}`);
  const head = `${w('suite', 8)} ${w('metric', 74)} ${w('value', 18)} ${w('normalized', 18)} ${w('budget', 20)} ${w('baseline', 13)} ${w('ratio', 6)} result`;
  console.log(`${head}\n${'-'.repeat(head.length + 12)}`);
  for (const r of rows) {
    const budget = r.threshold ? `${r.reference ? 'ref ' : ''}${r.threshold}` : '';
    const base = r.base !== null ? fmt(r.base, r.unit) : r.baseText ?? '—';
    const ratio = r.ratio !== null ? `x${r.ratio.toFixed(2)}` : '—';
    const norm = !r.normalized ? '' : r.norm.how === 'capped' ? 'capped (raw)' : fmt(r.norm.value, r.unit);
    const runs = nRuns > 1 ? ` [${r.normalized ? `${r.norm.passes}/${r.n}` : `${r.passes}/${r.n}`}${r.spread ? `, ${r.spread}` : ''}]` : '';
    const rawNote = r.normalized && r.raw.verdict !== r.verdict ? `  (raw on this host: ${r.raw.verdict})` : '';
    console.log(`${w(r.file, 8)} ${w(`${r.section}: ${r.metric}`, 74)} ${w(fmt(r.value, r.unit), 18)} ${w(norm, 18)} ${w(budget, 20)} ${w(base, 13)} ${w(ratio, 6)} ${r.verdict}${runs}${rawNote}`);
  }
}

function sh1(cmd, args, cwd = ROOT) {
  try { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; }
}

function machineLine(m) {
  if (!m) return 'unknown';
  return `${m.nproc} cores, ${m.cpu}, ${m.memGB} GB, ${m.platform}, node ${m.node}, ${m.ffmpeg}${m.notes ? ` (${m.notes})` : ''}`;
}

/** The calibration of this run set against the baseline's: scores, ratios, and what the verdicts will use. */
function calibrationSummary(cals, baseline) {
  const have = cals.filter(Boolean);
  const current = have.length ? combineScores(have) : null;
  const reference = baseline?.calibration?.scores ?? null;
  const ratios = current && reference ? calibrationRatios(current, reference) : null;
  return { have, current, reference, ratios, machine: have[0]?.machine ?? machineInfo() };
}

function printMachine(cs, baseline, dirs) {
  console.log(`\n== Machine and calibration ${'='.repeat(130)}`);
  console.log(`this host      ${machineLine(cs.machine)}`);
  console.log(`               load average now ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}${cs.have.length ? `; at each run's calibration: ${cs.have.map((c) => c.load.join(' ')).join(' | ')}` : ''}`);
  console.log(`baseline host  ${baseline ? `${machineLine(baseline.machine)}; commit ${String(baseline.commit).slice(0, 7)}, ${baseline.date}, ${baseline.runs?.count} runs` : 'no baseline'}`);
  if (!cs.have.length) console.log(`calibration    none for these runs (${dirs.length} dir(s) without calibration.json, or --no-calibrate): every row is judged raw`);
  else if (!cs.reference) console.log('calibration    the baseline has no calibration (seeded before calibration existed): every row is judged raw; re-seed to enable it');
  console.log(`calibration    median ms of a fixed workload (tests/perf/calibrate.mjs), lower = faster; k = this host / baseline host, tolerance ±${pct(CALIBRATION_TOLERANCE)}`);
  for (const c of CATEGORIES) {
    const per = cs.have.map((cal) => cal.scores?.[c]).map((s) => (s?.error ? 'failed' : isNum(s?.median) ? `${s.median}${s.iqr > SPREAD_WARN ? ' NOISY' : ''}` : '—'));
    const cur = cs.current?.[c]; const ref = cs.reference?.[c]; const rt = cs.ratios?.[c];
    const use = !rt ? 'raw' : rt.k === null ? 'raw (no score)' : rt.normalized ? `normalized by ${kx(rt.k)}${rt.from !== c ? ` (${rt.from}'s ratio)` : ''}` : `raw (within ±${pct(CALIBRATION_TOLERANCE)})`;
    console.log(`  ${w(c, 7)} this host ${w(isNum(cur) ? `${cur} ms` : '—', 11)} [runs: ${w(per.join(', ') || '—', 22)}]  baseline ${w(isNum(ref) ? `${ref} ms` : '—', 11)} k ${w(rt ? kx(rt.k) : '—', 6)} -> ${use}`);
  }
  const spreadRuns = CATEGORIES.map((c) => cs.have.map((cal) => scoresOf(cal)[c]).filter(isNum)).filter((xs) => xs.length > 1 && Math.max(...xs) / Math.min(...xs) - 1 > CALIBRATION_TOLERANCE);
  if (spreadRuns.length) console.log(`  WARNING: the runs' calibrations differ by more than ±${pct(CALIBRATION_TOLERANCE)} (the host's load changed between runs); the median is used`);
}

function writeBaseline(rows, nRuns, dirs, cals) {
  if (nRuns < REGRESSION_RULE.minRuns) { console.log(`[perf:check] PROBLEM: --update-baseline needs >= ${REGRESSION_RULE.minRuns} runs (got ${nRuns}); baseline not written`); return false; }
  const commit = val('--commit', null) ?? sh1('git', ['rev-parse', 'HEAD']);
  const have = cals.filter(Boolean);
  const m = have[0]?.machine;
  const ffmpeg = m?.ffmpeg ?? ((sh1(process.env.RECUT_FFMPEG || 'ffmpeg', ['-version']) ?? '').split('\n')[0].replace(/ Copyright.*$/, '') || 'unknown');
  const out = {
    about: 'Medians of the guardrail and diagnostic rows of tests/perf, keyed by "<suite>|<section>|<metric>", and the calibration of the machine they were measured on (the reference machine). perf-check.mjs compares guardrails against it (REGRESSION_RULE) after normalizing each row to the reference machine with the calibration ratio, and shows the trend of diagnostics. Change it only in a PR that says why: an accepted cost of a feature, locking in an improvement, or a new reference machine. See docs/DEVELOPMENT.md -> Performance gate.',
    format: 2,
    rule: `guardrail FAIL when the median of >= ${REGRESSION_RULE.minRuns} runs > ${REGRESSION_RULE.ratio} x baseline median and exceeds it by more than ${Object.entries(REGRESSION_RULE.floor).map(([u, f]) => `${f} ${u}`).join(' / ')} (other units: no floor), compared after normalization to this machine when the calibration ratio is beyond ±${pct(CALIBRATION_TOLERANCE)}`,
    reason: val('--reason', 'not given'),
    commit,
    date: new Date().toISOString().slice(0, 10),
    machine: { nproc: m?.nproc ?? os.cpus().length, cpu: m?.cpu ?? os.cpus()[0]?.model ?? 'unknown', memGB: m?.memGB ?? Math.round(os.totalmem() / 2 ** 30), platform: m?.platform ?? `${os.platform()} ${os.release()}`, node: m?.node ?? process.version, ffmpeg, notes: val('--machine-notes', '') },
    calibration: have.length === nRuns
      ? { version: have[0].version, method: 'tests/perf/calibrate.mjs: median ms of a fixed workload per category, lower = faster; the median over the runs', scores: combineScores(have), runs: have.map((c) => ({ at: c.at, load: c.load, js: scoresOf(c).js, ffmpeg: scoresOf(c).ffmpeg, render: scoresOf(c).render, iqr: Object.fromEntries(CATEGORIES.map((k) => [k, c.scores?.[k]?.iqr ?? null])) })) }
      : undefined,
    runs: { count: nRuns, suites: expected, dirs: dirs.map((d) => path.basename(path.dirname(d)) + '/' + path.basename(d)) },
    rows: {},
  };
  if (!out.calibration) console.log(`[perf:check] WARNING: ${nRuns - have.length} of ${nRuns} runs have no calibration.json: the baseline is written without calibration, and later runs are judged raw`);
  for (const r of rows) {
    if (r.tier === 'gate') continue;
    out.rows[r.key] = r.numeric
      ? { tier: r.tier, median: r.value, min: r2(r.mins), max: r2(r.maxs), n: r.n, unit: r.unit, threshold: r.threshold || undefined, reference: r.reference || undefined }
      : { tier: r.tier, median: null, value: r.value, n: r.n, unit: r.unit, threshold: r.threshold || undefined, reference: r.reference || undefined };
  }
  fs.writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[perf:check] baseline written: ${path.relative(ROOT, BASELINE)} (${Object.keys(out.rows).length} rows from ${nRuns} runs, commit ${commit?.slice(0, 7)}, calibration ${out.calibration ? JSON.stringify(out.calibration.scores) : 'none'}, reason: ${out.reason})`);
  return true;
}

const show = (d) => { const r = path.relative(ROOT, d); return r && !r.startsWith('..') ? r : d; };

// ---------------------------------------------------------------- A/B mode
function abMode(dirA, dirB) {
  const nRuns = Math.max(1, Number(val('--runs', '2')) || 2);
  const t0 = Date.now();
  for (const d of [dirA, dirB]) if (!fs.existsSync(path.join(d, 'package.json')) || !fs.existsSync(path.join(d, 'node_modules'))) { console.log(`[perf:check] PROBLEM: ${d} is not a checkout with node_modules`); process.exit(2); }
  const problems = [];
  const outA = Array.from({ length: nRuns }, (_, k) => path.join(OUT, 'ab', 'A', `run-${k + 1}`));
  const outB = Array.from({ length: nRuns }, (_, k) => path.join(OUT, 'ab', 'B', `run-${k + 1}`));
  if (runElectron && !has('--skip-build')) for (const d of [dirA, dirB]) problems.push(...build(d));
  if (!problems.length) {
    for (let k = 0; k < nRuns; k++) {
      console.log(`\n[perf:check] A/B run ${k + 1} of ${nRuns}: A`);
      problems.push(...runOnce(outA[k], dirA, { buildFirst: false }).map((p) => `A run ${k + 1}: ${p}`));
      console.log(`\n[perf:check] A/B run ${k + 1} of ${nRuns}: B`);
      problems.push(...runOnce(outB[k], dirB, { buildFirst: false }).map((p) => `B run ${k + 1}: ${p}`));
    }
  }
  return reportAB(dirA, dirB, outA, outB, problems, t0);
}

function reportAB(dirA, dirB, outA, outB, problems, t0) {
  const A = readRuns(outA); const B = readRuns(outB);
  problems.push(...A.problems, ...B.problems);
  const cmp = compareAB(aggregate(A.runs), aggregate(B.runs));
  const desc = (d) => { const head = sh1('git', ['log', '-1', '--format=%h %s'], d); const dirty = sh1('git', ['status', '--porcelain', '--untracked-files=no'], d); return `${d}${head ? ` (${head.slice(0, 70)}${dirty ? ', with uncommitted changes' : ''})` : ''}`; };
  console.log(`\n== Same-host A/B ${'='.repeat(140)}`);
  console.log(`A  ${desc(dirA)}\nB  ${desc(dirB)}`);
  console.log(`${outA.length} interleaved run(s) each (A, B, A, B, ...) on this host: ${machineLine(A.cals.find(Boolean)?.machine ?? machineInfo())}`);
  for (const c of CATEGORIES) {
    const s = (cals) => cals.map((cal) => scoresOf(cal)[c]).map((x) => (isNum(x) ? x : '—')).join(', ');
    console.log(`  calibration ${w(c, 7)} A runs: ${w(s(A.cals), 24)} B runs: ${s(B.cals)}`);
  }
  console.log('noise band per row: max(10 %, A\'s own min–max spread / median, floor 2 ms | 8 MB | 2 fps); WORSE = B worse than A beyond the band in every run pair and in the medians (worse = higher time or count, lower rate)');
  for (const tier of TIERS) {
    const rows = cmp.filter((r) => r.tier === tier);
    console.log(`\n== A/B ${tier}s (${rows.length}) ${'='.repeat(140)}`);
    const head = `${w('suite', 8)} ${w('metric', 80)} ${w('A median [min–max]', 26)} ${w('B median [min–max]', 26)} ${w('B/A', 6)} ${w('band', 6)} verdict`;
    console.log(`${head}\n${'-'.repeat(head.length + 12)}`);
    const cell = (r) => (!r ? '—' : `${fmt(r.value, r.unit)}${r.spread ? ` [${r.spread}]` : ''}`);
    for (const r of rows) console.log(`${w(r.file, 8)} ${w(`${r.section}: ${r.metric}`, 80)} ${w(cell(r.a), 26)} ${w(cell(r.b), 26)} ${w(isNum(r.ratio) ? `x${r.ratio.toFixed(2)}` : '—', 6)} ${w(r.band ? `${pct(r.band.rel)}` : '', 6)} ${r.verdict}`);
  }
  const worse = (t) => cmp.filter((r) => r.tier === t && r.worse);
  const better = (t) => cmp.filter((r) => r.tier === t && r.verdict === 'better');
  console.log(`\n[perf:check] A/B: ${outA.length} run(s) each from ${show(path.dirname(path.dirname(outA[0])))}${t0 ? `, ${Math.round((Date.now() - t0) / 60000)} min` : ''}`);
  for (const t of TIERS) console.log(`[perf:check] ${w(`${t}s:`, 12)} ${cmp.filter((r) => r.tier === t).length} rows, B WORSE ${worse(t).length}${worse(t).length ? ` (${worse(t).map((r) => `${r.section}: ${r.metric} x${r.ratio?.toFixed(2)}`).join('; ')})` : ''}, B better ${better(t).length}`);
  for (const p of problems) console.log(`[perf:check] PROBLEM: ${p}`);
  const failed = worse('gate').length + worse('guardrail').length;
  if (failed || problems.length || cmp.length === 0) { console.log(`[perf:check] A/B RESULT: ${failed ? 'B WORSE than A' : 'FAIL (problems above)'}`); process.exit(1); }
  console.log('[perf:check] A/B RESULT: no gate or guardrail row of B is worse than A beyond the noise band');
  process.exit(0);
}

// ---------------------------------------------------------------- main
const ab = (() => { const i = argv.indexOf('--ab'); return i >= 0 ? [argv[i + 1], argv[i + 2]].filter((x) => x && !x.startsWith('--')).map((x) => path.resolve(x)) : null; })();
if (ab) {
  if (ab.length !== 2) { console.log('[perf:check] usage: --ab <dirA> <dirB> [--runs N] [--electron-only | --node-only] [--skip-build]'); process.exit(2); }
  const fromA = listAfter('--from-a'), fromB = listAfter('--from-b');
  if (fromA && fromB) reportAB(ab[0], ab[1], fromA, fromB, [], 0); // re-report earlier A/B result dirs
  else abMode(ab[0], ab[1]);
} else {
  const from = listAfter('--from');
  const nRuns = Math.max(1, Number(val('--runs', '1')) || 1);
  let dirs; const suiteProblems = [];
  const t0 = Date.now();
  if (from) dirs = from;
  else {
    dirs = nRuns === 1 ? [OUT] : Array.from({ length: nRuns }, (_, k) => path.join(OUT, `run-${k + 1}`));
    for (const d of dirs) suiteProblems.push(...runOnce(d));
  }
  const { runs, problems, cals } = readRuns(dirs);
  const rows = aggregate(runs);
  if (has('--update-baseline') && !writeBaseline(rows, runs.length, dirs, cals)) problems.push('baseline not written');
  const baseline = readBaseline();
  const cs = calibrationSummary(cals, baseline);
  evaluate(rows, baseline, runs.length, cs.ratios);
  printMachine(cs, baseline, dirs);
  const byTier = Object.fromEntries(TIERS.map((t) => [t, rows.filter((r) => r.tier === t)]));
  printSection('Gates: user-facing, pass/fail on the budget', byTier.gate, runs.length);
  printSection(`Guardrails: architecture health, FAIL on the budget (unless "ref") or a regression > x${REGRESSION_RULE.ratio} baseline`, byTier.guardrail, runs.length);
  printSection('Diagnostics: microbenchmarks, trend vs baseline, never fail', byTier.diagnostic, runs.length);

  // Guardrail rows the baseline knows but this run did not measure (renamed or removed): a silent escape otherwise.
  const measured = new Set(rows.map((r) => r.key));
  const lost = Object.entries(baseline?.rows ?? {}).filter(([k]) => !measured.has(k) && expected.includes(k.split('|')[0]));
  for (const [k, b] of lost) if (b.tier === 'guardrail') problems.push(`guardrail row in the baseline was not measured (renamed or removed?): ${k}`);
  const lostDiag = lost.filter(([, b]) => b.tier !== 'guardrail');

  const all = [...suiteProblems, ...problems];
  const count = (rs, pass = (r) => r.pass) => `${rs.length}, PASS ${rs.filter(pass).length}, FAIL ${rs.filter((r) => !pass(r)).length}`;
  const anyNorm = CATEGORIES.some((c) => cs.ratios?.[c]?.normalized);
  const calText = cs.ratios ? CATEGORIES.map((c) => `${c} ${kx(cs.ratios[c].k)}`).join(', ') : 'none';
  console.log(`\n[perf:check] ${runs.length} run(s) from ${dirs.map(show).join(', ')}${from ? '' : `, ${Math.round((Date.now() - t0) / 60000)} min`}`);
  console.log(`[perf:check] this host: ${machineLine(cs.machine)}; load average ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}`);
  console.log(`[perf:check] baseline: ${baseline ? `${show(BASELINE)} (commit ${String(baseline.commit).slice(0, 7)}, ${baseline.date}, ${baseline.runs?.count} runs; ${machineLine(baseline.machine)})` : 'none (guardrails checked on their budgets only)'}`);
  console.log(`[perf:check] calibration: this host ${cs.current ? JSON.stringify(cs.current) : 'not measured'}, reference ${cs.reference ? JSON.stringify(cs.reference) : 'none'}; k ${calText}`);
  console.log(anyNorm
    ? `[perf:check] VERDICTS NORMALIZED TO THE REFERENCE MACHINE (calibration ${CATEGORIES.filter((c) => cs.ratios[c].normalized).map((c) => `${c} ${kx(cs.ratios[c].k)}`).join(', ')}; beyond ±${pct(CALIBRATION_TOLERANCE)}): time and rate rows and long-task counts are judged as measured / k; counts and structural rows raw. Raw verdicts on this host are shown too.`
    : `[perf:check] verdicts are raw: ${cs.ratios ? `this host is within ±${pct(CALIBRATION_TOLERANCE)} of the reference machine in every category` : 'no calibration to compare (see above)'}`);
  console.log(`[perf:check] regression rule: ${REGRESSION_RULE.ratio} x baseline median, >= ${REGRESSION_RULE.minRuns} runs, floor ${JSON.stringify(REGRESSION_RULE.floor)}`);
  console.log(`[perf:check] gates:       ${count(byTier.gate)}${anyNorm ? ` (normalized to the reference machine; ${byTier.gate.filter((r) => r.normalized).length} rows normalized); raw on this host: PASS ${byTier.gate.filter((r) => r.raw.pass).length}, FAIL ${byTier.gate.filter((r) => !r.raw.pass).length}` : ''}`);
  const gFail = byTier.guardrail.filter((r) => !r.pass);
  console.log(`[perf:check] guardrails:  ${count(byTier.guardrail)} (budget ${gFail.filter((r) => r.verdict.includes('budget')).length}, regression ${gFail.filter((r) => r.verdict.includes('regression')).length}, missing ${gFail.filter((r) => r.verdict.includes('missing')).length}); unconfirmed ${byTier.guardrail.filter((r) => r.unconfirmed).length}; no baseline ${byTier.guardrail.filter((r) => r.noBaseline).length}${anyNorm ? `; raw on this host: PASS ${byTier.guardrail.filter((r) => r.raw.pass).length}, FAIL ${byTier.guardrail.filter((r) => !r.raw.pass).length}` : ''}`);
  console.log(`[perf:check] diagnostics: ${byTier.diagnostic.length} reported (slower > 10 %: ${byTier.diagnostic.filter((r) => r.ratio !== null && r.ratio > 1.1).length}, over reference: ${byTier.diagnostic.filter((r) => r.threshold && !(r.normalized ? r.norm : r.raw).budgetPass).length}${lostDiag.length ? `, not measured: ${lostDiag.length}` : ''})`);
  for (const p of all) console.log(`[perf:check] PROBLEM: ${p}`);
  const failed = [...byTier.gate, ...byTier.guardrail].filter((r) => !r.pass);
  if (failed.length || all.length || rows.length === 0) { console.log(`[perf:check] RESULT: FAIL${anyNorm ? ' (normalized to the reference machine)' : ''}`); process.exit(1); }
  console.log(`[perf:check] RESULT: PASS${anyNorm ? ' (normalized to the reference machine)' : ''}`);
}
