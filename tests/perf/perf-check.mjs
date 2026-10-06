#!/usr/bin/env node
/**
 * Performance gate: runs the node perf suite and the Electron perf script one after the other, reads their JSON
 * results and prints every budgeted row in three sections by tier (docs/DEVELOPMENT.md → Performance gate):
 *
 *   Gates        user-facing; the bench's threshold is pass/fail.
 *   Guardrails   architecture health; FAIL on a material regression against tests/perf/baseline.json
 *                (REGRESSION_RULE below), and also on the threshold unless the row marks it `reference`.
 *   Diagnostics  microbenchmarks; value, reference threshold and trend against the baseline. Never fail.
 *
 * Exits 1 if a gate or guardrail fails, if a suite exits non-zero, if a result file is missing, or if a guardrail
 * row recorded in the baseline is no longer measured.
 *
 *   npm run perf:check                         # one run of both suites (~25 min; run it alone on the machine)
 *   npm run perf:check -- --runs 2             # N runs; value = median, a row fails unless it passed in most runs
 *   npm run perf:check -- --from <dir> [...]   # no run: aggregate result dirs from earlier runs
 *   options: --skip-build (dist/ already built), --node-only, --electron-only
 *
 *   node tests/perf/perf-check.mjs --update-baseline [--reason "<why>"] [--commit <sha>] --from <dir> [...]
 *   node tests/perf/perf-check.mjs --update-baseline [--reason "<why>"] --runs 2
 *       rewrite tests/perf/baseline.json from the medians of these runs (>= REGRESSION_RULE.minRuns runs). Only in a
 *       PR that states why (accepted cost of a feature, or locking in an improvement).
 *
 * Budgets and tiers live in exactly one place: the rows the benches record via ms() / record() / rec() in
 * tests/perf/*.perf.test.ts (_report.ts) and tests/perf/electron-perf.mjs. Every row with a boolean `pass` is a
 * budgeted row; a budgeted row without a `tier` is a gate. This script never re-derives or changes a threshold.
 *
 * Results go to $RECUT_PERF_OUT (default test-results/perf), or <out>/run-<k> with --runs > 1.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Material regression of a guardrail: the median of at least `minRuns` runs is more than `ratio` x the baseline
 * median AND more than `floor[unit]` above it (absolute noise floor: few-ms rows differ up to 2x between runs of
 * identical code, and 0.04 -> 0.07 ms is timer resolution; units not listed, e.g. counts, have no floor). With fewer
 * runs an excess is reported as UNCONFIRMED, not FAIL.
 */
const REGRESSION_RULE = { ratio: 1.5, minRuns: 2, floor: { ms: 2, MB: 8 } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = path.join(ROOT, 'tests', 'perf', 'baseline.json');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const NODE_FILES = ['store', 'panels', 'main', 'export'];
const ELECTRON_FILES = ['electron'];
const runNode = !has('--electron-only');
const runElectron = !has('--node-only');
const expected = [...(runNode ? NODE_FILES : []), ...(runElectron ? ELECTRON_FILES : [])];
const OUT = path.resolve(process.env.RECUT_PERF_OUT || path.join(ROOT, 'test-results', 'perf'));

function load() {
  const [l1] = os.loadavg();
  return `nproc ${os.cpus().length}, load average ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}${l1 > os.cpus().length * 0.5 ? '  (busy machine: results will be noisy)' : ''}`;
}

/** Waits (up to 90 s) for the 1-min load average to drop below half the cores, e.g. after the previous suite. */
function settle() {
  const t = Date.now();
  while (os.loadavg()[0] > os.cpus().length * 0.5 && Date.now() - t < 90_000) spawnSync('sleep', ['5']);
}

function sh(cmd, args, env) {
  settle();
  console.log(`\n[perf:check] $ ${cmd} ${args.join(' ')}\n[perf:check] ${load()}`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  console.log(`[perf:check] exit ${r.status ?? r.signal} after ${Math.round((Date.now() - t) / 1000)} s`);
  return r.status === 0;
}

/** Runs the selected suites once into `dir`; returns the suite failures (non-zero exits). */
function runOnce(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of expected) fs.rmSync(path.join(dir, `${f}.json`), { force: true }); // never read a stale result
  const problems = [];
  if (runNode) {
    const env = { RECUT_PERF_OUT: dir, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`.trim() };
    if (!sh('npx', ['vitest', 'run', '-c', 'tests/perf/vitest.config.ts'], env)) problems.push('node perf suite exited non-zero (a test assertion failed or the run crashed)');
  }
  if (runElectron) {
    if (!has('--skip-build') && !sh('npm', ['run', 'build'], {})) { problems.push('npm run build failed'); return problems; }
    const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
    const ok = useXvfb
      ? sh('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', 'node', 'tests/perf/electron-perf.mjs'], { RECUT_PERF_OUT: dir })
      : sh('node', ['tests/perf/electron-perf.mjs'], { RECUT_PERF_OUT: dir });
    if (!ok) problems.push('electron-perf.mjs exited non-zero');
  }
  return problems;
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
  return { runs, problems };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (v) => Math.round(v * 100) / 100;
const TIERS = ['gate', 'guardrail', 'diagnostic'];

function aggregate(runs) {
  const order = []; const byKey = new Map();
  for (const rows of runs) for (const r of rows) {
    if (typeof r.pass !== 'boolean') continue; // not a budgeted row
    if (!byKey.has(r.key)) { byKey.set(r.key, []); order.push(r.key); }
    byKey.get(r.key).push(r);
  }
  return order.map((key) => {
    const rs = byKey.get(key); const first = rs[0]; const last = rs[rs.length - 1];
    const passes = rs.filter((r) => r.pass).length;
    const nums = rs.map((r) => r.value).filter(isNum);
    const numeric = nums.length === rs.length;
    const value = numeric ? r2(median(nums)) : last.value;
    const spread = numeric && rs.length > 1 ? `${r2(Math.min(...nums))}–${r2(Math.max(...nums))}` : '';
    // The bench's threshold: passed in more than half of the runs the row appeared in, and it appeared in every run.
    const inAll = rs.length === runs.length;
    const budgetPass = inAll && passes * 2 > rs.length;
    // Unclassified budgeted rows are gates; an unknown tier is treated as a gate too (nothing escapes by a typo).
    const tier = TIERS.includes(last.tier) ? last.tier : 'gate';
    return { key, file: first.file, section: first.section, metric: first.metric, unit: first.unit ?? '', threshold: first.threshold ?? '', tier, reference: tier === 'diagnostic' || Boolean(last.reference), value, numeric, mins: numeric ? Math.min(...nums) : null, maxs: numeric ? Math.max(...nums) : null, spread, passes, n: rs.length, inAll, budgetPass };
  });
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) { console.log(`[perf:check] PROBLEM: unreadable ${BASELINE}: ${e.message}`); return null; }
}

/** Fills in baseline, ratio and the verdict of every row; `nRuns` = number of runs aggregated. */
function evaluate(rows, baseline, nRuns) {
  const rule = REGRESSION_RULE;
  for (const r of rows) {
    const b = baseline?.rows?.[r.key];
    r.base = b && isNum(b.median) ? b.median : null;
    r.baseText = b && !isNum(b.median) && b.value !== undefined ? String(b.value) : null; // non-numeric rows ("16 / 0")
    r.ratio = r.numeric && r.base !== null && r.base > 0 ? r.value / r.base : null;
    if (r.tier === 'gate') { r.pass = r.budgetPass; r.verdict = r.pass ? 'PASS' : 'FAIL'; continue; }
    if (r.tier === 'diagnostic') {
      r.pass = true;
      const ref = r.threshold ? (r.budgetPass ? 'within ref' : 'over ref') : '';
      const trend = r.ratio === null ? (r.baseText !== null ? (r.baseText === String(r.value) ? 'same as baseline' : 'changed') : r.base === null ? 'no baseline' : 'n/a') : r.ratio > 1.1 ? `slower x${r.ratio.toFixed(2)}` : r.ratio < 0.9 ? `faster x${r.ratio.toFixed(2)}` : `steady x${r.ratio.toFixed(2)}`;
      r.verdict = [trend, ref].filter(Boolean).join(', ');
      continue;
    }
    // guardrail
    const reasons = [];
    if (!r.inAll) reasons.push(`missing in ${nRuns - r.n} run(s)`);
    else if (!r.reference && !r.budgetPass) reasons.push('budget');
    let excess = false;
    if (r.numeric && r.base !== null) {
      const floor = rule.floor[r.unit] ?? 0;
      excess = r.value > rule.ratio * r.base && r.value - r.base > floor;
    }
    r.unconfirmed = excess && nRuns < rule.minRuns;
    if (excess && !r.unconfirmed) reasons.push(`regression x${r.ratio === null ? '∞' : r.ratio.toFixed(2)}`);
    r.noBaseline = r.numeric && r.base === null;
    r.pass = reasons.length === 0;
    r.verdict = r.pass ? (r.unconfirmed ? `PASS (UNCONFIRMED x${r.ratio === null ? '∞' : r.ratio.toFixed(2)}: needs ${rule.minRuns} runs)` : r.noBaseline ? 'PASS (no baseline)' : 'PASS') : `FAIL (${reasons.join(', ')})`;
  }
}

function printSection(title, rows, nRuns) {
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  const fmt = (v, unit) => `${isNum(v) ? r2(v) : v}${unit && isNum(v) ? ` ${unit}` : ''}`;
  console.log(`\n== ${title} (${rows.length}) ${'='.repeat(Math.max(0, 150 - title.length))}`);
  const head = `${w('suite', 8)} ${w('metric', 76)} ${w('value', 20)} ${w('budget', 22)} ${w('baseline', 14)} ${w('ratio', 6)} result`;
  console.log(`${head}\n${'-'.repeat(head.length + 12)}`);
  for (const r of rows) {
    const budget = r.threshold ? `${r.reference ? 'ref ' : ''}${r.threshold}` : '';
    const base = r.base !== null ? fmt(r.base, r.unit) : r.baseText ?? '—';
    const ratio = r.ratio !== null ? `x${r.ratio.toFixed(2)}` : '—';
    const runs = nRuns > 1 ? ` [${r.passes}/${r.n}${r.spread ? `, ${r.spread}` : ''}]` : '';
    console.log(`${w(r.file, 8)} ${w(`${r.section}: ${r.metric}`, 76)} ${w(fmt(r.value, r.unit), 20)} ${w(budget, 22)} ${w(base, 14)} ${w(ratio, 6)} ${r.verdict}${runs}`);
  }
}

function sh1(cmd, args) {
  try { const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; }
}

function writeBaseline(rows, nRuns, dirs) {
  if (nRuns < REGRESSION_RULE.minRuns) { console.log(`[perf:check] PROBLEM: --update-baseline needs >= ${REGRESSION_RULE.minRuns} runs (got ${nRuns}); baseline not written`); return false; }
  const commit = val('--commit', null) ?? sh1('git', ['rev-parse', 'HEAD']);
  const ffmpeg = (sh1(process.env.RECUT_FFMPEG || 'ffmpeg', ['-version']) ?? '').split('\n')[0].replace(/ Copyright.*$/, '') || 'unknown';
  const out = {
    about: 'Medians of the guardrail and diagnostic rows of tests/perf, keyed by "<suite>|<section>|<metric>". perf-check.mjs compares guardrails against it (REGRESSION_RULE) and shows the trend of diagnostics. Change it only in a PR that says why: an accepted cost of a feature, or locking in an improvement. See docs/DEVELOPMENT.md -> Performance gate.',
    rule: `guardrail FAIL when the median of >= ${REGRESSION_RULE.minRuns} runs > ${REGRESSION_RULE.ratio} x baseline median and exceeds it by more than ${Object.entries(REGRESSION_RULE.floor).map(([u, f]) => `${f} ${u}`).join(' / ')} (other units: no floor)`,
    reason: val('--reason', 'not given'),
    commit,
    date: new Date().toISOString().slice(0, 10),
    machine: { nproc: os.cpus().length, cpu: os.cpus()[0]?.model ?? 'unknown', memGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, node: process.version, ffmpeg, notes: val('--machine-notes', '') },
    runs: { count: nRuns, suites: expected, dirs: dirs.map((d) => path.basename(path.dirname(d)) + '/' + path.basename(d)) },
    rows: {},
  };
  for (const r of rows) {
    if (r.tier === 'gate') continue;
    out.rows[r.key] = r.numeric
      ? { tier: r.tier, median: r.value, min: r2(r.mins), max: r2(r.maxs), n: r.n, unit: r.unit, threshold: r.threshold || undefined, reference: r.reference || undefined }
      : { tier: r.tier, median: null, value: r.value, n: r.n, unit: r.unit, threshold: r.threshold || undefined, reference: r.reference || undefined };
  }
  fs.writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[perf:check] baseline written: ${path.relative(ROOT, BASELINE)} (${Object.keys(out.rows).length} rows from ${nRuns} runs, commit ${commit?.slice(0, 7)}, reason: ${out.reason})`);
  return true;
}

// ---------------------------------------------------------------- main
const from = (() => { const i = argv.indexOf('--from'); if (i < 0) return null; const out = []; for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(path.resolve(argv[k])); return out; })();
const nRuns = Math.max(1, Number(val('--runs', '1')) || 1);
let dirs; const suiteProblems = [];
const t0 = Date.now();
if (from) dirs = from;
else {
  dirs = nRuns === 1 ? [OUT] : Array.from({ length: nRuns }, (_, k) => path.join(OUT, `run-${k + 1}`));
  for (const d of dirs) suiteProblems.push(...runOnce(d));
}
const { runs, problems } = readRuns(dirs);
const rows = aggregate(runs);
if (has('--update-baseline') && !writeBaseline(rows, runs.length, dirs)) problems.push('baseline not written');
const baseline = readBaseline();
evaluate(rows, baseline, runs.length);
const byTier = Object.fromEntries(TIERS.map((t) => [t, rows.filter((r) => r.tier === t)]));
printSection('Gates: user-facing, pass/fail on the budget', byTier.gate, runs.length);
printSection(`Guardrails: architecture health, FAIL on the budget (unless "ref") or a regression > x${REGRESSION_RULE.ratio} baseline`, byTier.guardrail, runs.length);
printSection('Diagnostics: microbenchmarks, trend vs baseline, never fail', byTier.diagnostic, runs.length);

// Guardrail rows the baseline knows but this run did not measure (renamed or removed): a silent escape otherwise.
const measured = new Set(rows.map((r) => r.key));
const lost = Object.entries(baseline?.rows ?? {}).filter(([k, b]) => !measured.has(k) && expected.includes(k.split('|')[0]));
for (const [k, b] of lost) if (b.tier === 'guardrail') problems.push(`guardrail row in the baseline was not measured (renamed or removed?): ${k}`);
const lostDiag = lost.filter(([, b]) => b.tier !== 'guardrail');

const all = [...suiteProblems, ...problems];
const show = (d) => { const r = path.relative(ROOT, d); return r && !r.startsWith('..') ? r : d; };
const count = (rs) => `${rs.length}, PASS ${rs.filter((r) => r.pass).length}, FAIL ${rs.filter((r) => !r.pass).length}`;
console.log(`\n[perf:check] ${runs.length} run(s) from ${dirs.map(show).join(', ')}${from ? '' : `, ${Math.round((Date.now() - t0) / 60000)} min`}`);
console.log(`[perf:check] baseline: ${baseline ? `${show(BASELINE)} (commit ${String(baseline.commit).slice(0, 7)}, ${baseline.date}, ${baseline.runs?.count} runs)` : 'none (guardrails checked on their budgets only)'}`);
console.log(`[perf:check] regression rule: ${REGRESSION_RULE.ratio} x baseline median, >= ${REGRESSION_RULE.minRuns} runs, floor ${JSON.stringify(REGRESSION_RULE.floor)}`);
console.log(`[perf:check] gates:       ${count(byTier.gate)}`);
const gFail = byTier.guardrail.filter((r) => !r.pass);
console.log(`[perf:check] guardrails:  ${count(byTier.guardrail)} (budget ${gFail.filter((r) => r.verdict.includes('budget')).length}, regression ${gFail.filter((r) => r.verdict.includes('regression')).length}, missing ${gFail.filter((r) => r.verdict.includes('missing')).length}); unconfirmed ${byTier.guardrail.filter((r) => r.unconfirmed).length}; no baseline ${byTier.guardrail.filter((r) => r.noBaseline).length}`);
console.log(`[perf:check] diagnostics: ${byTier.diagnostic.length} reported (slower > 10 %: ${byTier.diagnostic.filter((r) => r.ratio !== null && r.ratio > 1.1).length}, over reference: ${byTier.diagnostic.filter((r) => r.threshold && !r.budgetPass).length}${lostDiag.length ? `, not measured: ${lostDiag.length}` : ''})`);
for (const p of all) console.log(`[perf:check] PROBLEM: ${p}`);
const failed = [...byTier.gate, ...byTier.guardrail].filter((r) => !r.pass);
if (failed.length || all.length || rows.length === 0) { console.log('[perf:check] RESULT: FAIL'); process.exit(1); }
console.log('[perf:check] RESULT: PASS');
