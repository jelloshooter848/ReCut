#!/usr/bin/env node
/**
 * Performance gate: runs the node perf suite and the Electron perf script one after the other, reads their JSON
 * results and prints one table of every budgeted row (metric, value, budget, PASS/FAIL). Exits 1 if any budgeted row
 * fails, if a suite exits non-zero, or if a result file is missing.
 *
 *   npm run perf:check                         # one run of both suites (~25 min; run it alone on the machine)
 *   npm run perf:check -- --runs 2             # N runs; value = median, a row fails unless it passed in most runs
 *   npm run perf:check -- --from <dir> [...]   # no run: aggregate result dirs from earlier runs
 *   options: --skip-build (dist/ already built), --node-only, --electron-only
 *
 * Budgets live in exactly one place: the thresholds the benches pass to ms() / record() / rec() in
 * tests/perf/*.perf.test.ts (via _report.ts) and tests/perf/electron-perf.mjs. Every row with a boolean `pass` is a
 * budgeted row; this script never re-derives or changes a threshold.
 *
 * Results go to $RECUT_PERF_OUT (default test-results/perf), or <out>/run-<k> with --runs > 1.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

function aggregate(runs) {
  const order = []; const byKey = new Map();
  for (const rows of runs) for (const r of rows) {
    if (typeof r.pass !== 'boolean') continue; // not a budgeted row
    if (!byKey.has(r.key)) { byKey.set(r.key, []); order.push(r.key); }
    byKey.get(r.key).push(r);
  }
  return order.map((key) => {
    const rs = byKey.get(key); const first = rs[0];
    const passes = rs.filter((r) => r.pass).length;
    const nums = rs.map((r) => r.value).filter(isNum);
    const value = nums.length === rs.length ? r2(median(nums)) : rs[rs.length - 1].value;
    const spread = nums.length === rs.length && rs.length > 1 ? `${r2(Math.min(...nums))}–${r2(Math.max(...nums))}` : '';
    // A row passes only if it passed in more than half of the runs it appeared in; and it must appear in every run.
    const pass = rs.length === runs.length && passes * 2 > rs.length;
    return { file: first.file, section: first.section, metric: first.metric, unit: first.unit ?? '', threshold: first.threshold ?? '', value, spread, passes, n: rs.length, pass };
  });
}

function printTable(rows, nRuns) {
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  const head = `${w('suite', 9)} ${w('metric', 78)} ${w('value', 22)} ${w('budget', 18)} result`;
  console.log(`\n${head}\n${'-'.repeat(head.length + 6)}`);
  for (const r of rows) {
    const v = `${r.value}${r.unit && isNum(r.value) ? ` ${r.unit}` : ''}`;
    const res = `${r.pass ? 'PASS' : 'FAIL'}${nRuns > 1 ? ` (${r.passes}/${r.n}${r.spread ? `, ${r.spread}` : ''})` : ''}`;
    console.log(`${w(r.file, 9)} ${w(`${r.section}: ${r.metric}`, 78)} ${w(v, 22)} ${w(r.threshold, 18)} ${res}`);
  }
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
printTable(rows, runs.length);
const failed = rows.filter((r) => !r.pass);
const all = [...suiteProblems, ...problems];
const show = (d) => { const r = path.relative(ROOT, d); return r && !r.startsWith('..') ? r : d; };
console.log(`\n[perf:check] ${runs.length} run(s) from ${dirs.map(show).join(', ')}${from ? '' : `, ${Math.round((Date.now() - t0) / 60000)} min`}`);
console.log(`[perf:check] budgeted rows: ${rows.length}, PASS ${rows.length - failed.length}, FAIL ${failed.length}`);
for (const p of all) console.log(`[perf:check] PROBLEM: ${p}`);
if (failed.length || all.length || rows.length === 0) { console.log('[perf:check] RESULT: FAIL'); process.exit(1); }
console.log('[perf:check] RESULT: PASS');
