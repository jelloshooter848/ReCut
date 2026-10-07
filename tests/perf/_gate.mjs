/**
 * Pure logic of the performance gate (tests/perf/perf-check.mjs): aggregation of runs, metric classes, calibration
 * ratios, normalization to the reference machine, verdicts, and the same-host A/B comparison. No I/O, so
 * tests/unit/perf-gate.test.ts covers it. docs/DEVELOPMENT.md → Performance gate explains the rules in prose.
 */

/**
 * Material regression of a guardrail: the median of at least `minRuns` runs is more than `ratio` x the baseline
 * median AND more than `floor[unit]` above it (absolute noise floor: few-ms rows differ up to 2x between runs of
 * identical code, and 0.04 -> 0.07 ms is timer resolution; units not listed, e.g. counts, have no floor). With fewer
 * runs an excess is reported as UNCONFIRMED, not FAIL. Values are compared after normalization (see below).
 */
export const REGRESSION_RULE = { ratio: 1.5, minRuns: 2, floor: { ms: 2, MB: 8 } };

/**
 * A host whose calibration ratio is within +-CALIBRATION_TOLERANCE of the baseline's counts as the reference machine:
 * its rows are judged raw. The calibration itself repeats within about +-5 % on one quiet host (median of 9-11
 * repeats); 10 % keeps that noise out of the verdicts.
 */
export const CALIBRATION_TOLERANCE = 0.1;

/** Calibration categories (tests/perf/calibrate.mjs). A missing category falls back to `js`. */
export const CATEGORIES = ['js', 'ffmpeg', 'render'];

/** The Long Tasks API reports main-thread tasks of more than 50 ms. */
export const LONG_TASK_MS = 50;

/** A rate within 5 % of its cap is treated as capped (no information about how much faster the host could go). */
export const CAP_NEAR = 0.95;

/** Same-host A/B: a difference is beyond the noise band when it exceeds max(rel x A, A's own run spread, floor[unit]). */
export const AB_BAND = { rel: 0.1, floor: { ms: 2, MB: 8, fps: 2 } };

export const TIERS = ['gate', 'guardrail', 'diagnostic'];
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- metric classes

/**
 * What a row measures, which decides whether and how it is normalized to the reference machine:
 *  - time       unit 'ms'. Scales with host speed: normalized = value / k.
 *  - rate       unit 'fps'. normalized = min(cap, value x k). The cap is the display (60) or, for program playback,
 *               the sequence frame rate (24). A rate at its cap on a faster host (k < 1) says nothing about the
 *               reference machine and stays raw ("capped").
 *  - longtasks  a count of main-thread tasks over 50 ms (Long Tasks API). Normalized by re-counting the recorded task
 *               durations against 50 ms x k (`longTasks` on the row); a plain count otherwise. On a faster host the
 *               normalized count is a lower bound (tasks between 50 x k and 50 ms were never reported).
 *  - count      everything else: counts, DOM nodes, renders and mutations per frame, page flips, IPC calls, MB,
 *               frames out, strings. Structural, not speed: never normalized.
 */
export function metricClass(row) {
  if (row.unit === 'ms') return { kind: 'time' };
  if (row.unit === 'fps') return { kind: 'rate', cap: /program fps/.test(row.metric) ? 24 : 60 };
  if (/\blong tasks\b/.test(row.metric) && (row.unit ?? '') === '') return { kind: 'longtasks' };
  return { kind: 'count' };
}

/**
 * Which calibration ratio applies to a row: native FFmpeg work (the media layer: thumbnails, filmstrips, waveforms,
 * proxies, export) -> ffmpeg; everything else measured in Electron (renderer and main: UI, store in the app, save /
 * open) -> render; the Node suites' pure JavaScript (store, panels, render graph) -> js.
 */
export function categoryOf(row) {
  const { file, section, metric } = row;
  if (file === 'main') return 'ffmpeg';
  if (file === 'export' && (section === 'ffmpeg' || section === 'export')) return 'ffmpeg';
  if (file === 'electron' && (section === 'main' || section === 'fairness') && /thumbnail|filmstrip|waveform|proxy/i.test(metric)) return 'ffmpeg';
  if (file === 'electron') return 'render';
  return 'js';
}

// ---------------------------------------------------------------- calibration

/** Scores (median ms per category) of one calibration.json, or null for a category that failed. */
export function scoresOf(cal) {
  const out = {};
  for (const c of CATEGORIES) { const s = cal?.scores?.[c]; out[c] = s && isNum(s.median) && s.median > 0 ? s.median : null; }
  return out;
}

/** Median score per category over several runs' calibrations (each run measures its own at its start). */
export function combineScores(cals) {
  const out = {};
  for (const c of CATEGORIES) { const xs = cals.map((cal) => scoresOf(cal)[c]).filter(isNum); out[c] = xs.length ? r2(median(xs)) : null; }
  return out;
}

/**
 * Calibration ratio per category: k = this host's score / the baseline host's score (> 1: this host is slower).
 * `effective` is the k the verdicts use: 1 within +-tol (the host counts as the reference machine), else k. A category
 * without a score on either side falls back to js (`from: 'js'`); without js nothing is normalized (k null).
 */
export function calibrationRatios(current, reference, tol = CALIBRATION_TOLERANCE) {
  const raw = {};
  for (const c of CATEGORIES) { const a = current?.[c], b = reference?.[c]; raw[c] = isNum(a) && isNum(b) && a > 0 && b > 0 ? a / b : null; }
  const out = {};
  for (const c of CATEGORIES) {
    const from = raw[c] !== null ? c : raw.js !== null ? 'js' : null;
    const k = from ? raw[from] : null;
    out[c] = { k, from, effective: k === null || Math.abs(k - 1) <= tol ? 1 : k, normalized: k !== null && Math.abs(k - 1) > tol };
  }
  return out;
}

// ---------------------------------------------------------------- normalization

/**
 * One measured value (of one run) normalized to the reference machine with ratio k (the effective ratio; 1 = raw).
 * Returns { value, how } with how in time | rate | capped | longtasks | longtasks (lower bound) | count | raw.
 */
export function normalize(row, k, value = row.value, longTasks = row.longTasks) {
  const c = metricClass(row);
  if (!isNum(value)) return { value, how: 'raw' };
  if (c.kind === 'count') return { value, how: 'count' };
  if (k === 1) return { value, how: 'raw' };
  if (c.kind === 'time') return { value: value / k, how: 'time' };
  if (c.kind === 'rate') {
    if (k < 1 && value >= c.cap * CAP_NEAR) return { value, how: 'capped' };
    return { value: Math.min(c.cap, value * k), how: 'rate' };
  }
  if (!Array.isArray(longTasks)) return { value, how: 'raw' }; // longtasks without recorded durations
  return { value: longTasks.filter((d) => d / k > LONG_TASK_MS).length, how: k < 1 ? 'longtasks (lower bound)' : 'longtasks' };
}

/** A bench threshold such as "<= 100 ms", ">= 50", "== 0"; null for anything else ("content == 0", "running"). */
export function parseThreshold(t) {
  const m = /^\s*(<=|>=|==|<|>)\s*(-?\d+(?:\.\d+)?)/.exec(String(t ?? ''));
  return m ? { op: m[1], n: Number(m[2]) } : null;
}

export function meets(th, v) {
  switch (th.op) {
    case '<=': return v <= th.n;
    case '>=': return v >= th.n;
    case '<': return v < th.n;
    case '>': return v > th.n;
    default: return v === th.n;
  }
}

/**
 * Budget verdict of one run after normalization. Rows whose threshold cannot be parsed, or that are not normalized,
 * keep the bench's own pass. A row can fail for a reason besides its threshold (an in-page scrub that page-flipped,
 * an open that returned an error): when the raw value met the threshold and the bench still failed it, so does this.
 */
export function runPass(row, run, k) {
  const n = normalize(row, k, run.value, run.longTasks);
  const th = parseThreshold(row.threshold);
  if (!th || !isNum(n.value) || n.how === 'raw' || n.how === 'count' || typeof run.pass !== 'boolean') return { pass: run.pass === true, value: n.value, how: n.how };
  const otherFailure = run.pass === false && isNum(run.value) && meets(th, run.value);
  return { pass: meets(th, n.value) && !otherFailure, value: n.value, how: n.how };
}

// ---------------------------------------------------------------- aggregation

/**
 * Groups budgeted rows (boolean `pass`) of several runs by key; value = median, plus the per-run values, passes and
 * long-task durations (`runs`) for normalization. `runs` is an array (one per run) of row arrays with `key` and `file`.
 */
export function aggregate(runs) {
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
    return {
      key, file: first.file, section: first.section, metric: first.metric, unit: first.unit ?? '', threshold: first.threshold ?? '', tier,
      reference: tier === 'diagnostic' || Boolean(last.reference), value, numeric, mins: numeric ? Math.min(...nums) : null, maxs: numeric ? Math.max(...nums) : null,
      spread, passes, n: rs.length, inAll, budgetPass,
      runs: rs.map((r) => ({ value: r.value, pass: r.pass, longTasks: Array.isArray(r.longTasks) ? r.longTasks : undefined })),
    };
  });
}

// ---------------------------------------------------------------- verdicts

/**
 * Verdict of one aggregated row with ratio k (1 = raw). `base` = the baseline's numeric median (or null), `baseText` =
 * its non-numeric value. Gates: the bench's threshold on each run's normalized value, passed in more than half of the
 * runs. Guardrails: the same budget check unless `reference`, plus the regression rule on the normalized median.
 * Diagnostics: the trend only.
 */
export function judge(r, { base, baseText }, nRuns, k, rule = REGRESSION_RULE) {
  const per = r.runs.map((run) => runPass(r, run, k));
  const vals = per.map((p) => p.value);
  const numeric = r.numeric && vals.every(isNum);
  const value = numeric ? r2(median(vals)) : r.value;
  const passes = per.filter((p) => p.pass).length;
  const budgetPass = r.inAll && passes * 2 > r.n;
  const hows = [...new Set(per.map((p) => p.how))];
  const how = hows.length === 1 ? hows[0] : hows.join('/');
  const ratio = numeric && base !== null && base > 0 ? value / base : null;
  const out = { value, passes, budgetPass, how, ratio, pass: true, verdict: '', unconfirmed: false, noBaseline: false };
  if (r.tier === 'gate') { out.pass = budgetPass; out.verdict = out.pass ? 'PASS' : 'FAIL'; return out; }
  if (r.tier === 'diagnostic') {
    const ref = r.threshold ? (budgetPass ? 'within ref' : 'over ref') : '';
    const trend = ratio === null ? (baseText !== null ? (baseText === String(r.value) ? 'same as baseline' : 'changed') : base === null ? 'no baseline' : 'n/a') : ratio > 1.1 ? `slower x${ratio.toFixed(2)}` : ratio < 0.9 ? `faster x${ratio.toFixed(2)}` : `steady x${ratio.toFixed(2)}`;
    out.verdict = [trend, ref].filter(Boolean).join(', ');
    return out;
  }
  // guardrail
  const reasons = [];
  if (!r.inAll) reasons.push(`missing in ${nRuns - r.n} run(s)`);
  else if (!r.reference && !budgetPass) reasons.push('budget');
  let excess = false;
  if (numeric && base !== null) {
    const floor = rule.floor[r.unit] ?? 0;
    const higherIsBetter = metricClass(r).kind === 'rate';
    excess = higherIsBetter ? value * rule.ratio < base && base - value > floor : value > rule.ratio * base && value - base > floor;
  }
  out.unconfirmed = excess && nRuns < rule.minRuns;
  const x = ratio === null ? '∞' : ratio.toFixed(2);
  if (excess && !out.unconfirmed) reasons.push(`regression x${x}`);
  out.noBaseline = numeric && base === null;
  out.pass = reasons.length === 0;
  out.verdict = out.pass ? (out.unconfirmed ? `PASS (UNCONFIRMED x${x}: needs ${rule.minRuns} runs)` : out.noBaseline ? 'PASS (no baseline)' : 'PASS') : `FAIL (${reasons.join(', ')})`;
  return out;
}

/**
 * Fills in baseline, raw and normalized verdicts of every row. `ratios` = calibrationRatios(...) or null (no
 * calibration: everything raw). The row's verdict (`pass`, `verdict`) is the normalized one when its category's
 * effective ratio is not 1, else the raw one; `raw` and `norm` keep both.
 */
export function evaluate(rows, baseline, nRuns, ratios = null, rule = REGRESSION_RULE) {
  for (const r of rows) {
    const b = baseline?.rows?.[r.key];
    r.base = b && isNum(b.median) ? b.median : null;
    r.baseText = b && !isNum(b.median) && b.value !== undefined ? String(b.value) : null; // non-numeric rows ("16 / 0")
    r.category = categoryOf(r);
    r.cls = metricClass(r).kind;
    const cal = ratios?.[r.category] ?? null;
    r.k = cal?.k ?? null;
    r.kEff = cal?.effective ?? 1;
    r.raw = judge(r, r, nRuns, 1, rule);
    r.norm = r.kEff === 1 ? r.raw : judge(r, r, nRuns, r.kEff, rule);
    r.normalized = r.kEff !== 1 && r.cls !== 'count' && r.norm.how !== 'raw';
    const v = r.normalized ? r.norm : r.raw;
    r.ratio = v.ratio; r.pass = v.pass; r.verdict = v.verdict; r.unconfirmed = v.unconfirmed; r.noBaseline = v.noBaseline;
  }
  return rows;
}

// ---------------------------------------------------------------- same-host A/B

/**
 * Compares two sets of aggregated rows measured on the same host, interleaved (A, B, A, B, ...). Per row: medians,
 * B/A, the noise band, and a verdict: WORSE when B is worse than A beyond the band in every run pair and in the
 * medians, better when B is better beyond the band in every pair, same otherwise. Worse = higher for time and counts,
 * lower for rates. Non-numeric rows are only compared for equality ('changed', never WORSE).
 */
export function compareAB(rowsA, rowsB, band = AB_BAND) {
  const a = new Map(rowsA.map((r) => [r.key, r]));
  const b = new Map(rowsB.map((r) => [r.key, r]));
  const keys = [...rowsA.map((r) => r.key), ...rowsB.filter((r) => !a.has(r.key)).map((r) => r.key)];
  return keys.map((key) => {
    const ra = a.get(key), rb = b.get(key); const any = ra ?? rb;
    const out = { key, file: any.file, section: any.section, metric: any.metric, unit: any.unit, tier: (rb ?? ra).tier, a: ra ?? null, b: rb ?? null, ratio: null, band: null, verdict: '', worse: false };
    if (!ra || !rb) { out.verdict = ra ? 'only in A' : 'only in B'; return out; }
    if (!ra.numeric || !rb.numeric) { out.verdict = String(ra.value) === String(rb.value) ? 'same' : 'changed'; return out; }
    const dir = metricClass(any).kind === 'rate' ? -1 : 1; // +1: higher is worse
    const relSpread = ra.n > 1 && ra.value !== 0 ? (ra.maxs - ra.mins) / Math.abs(ra.value) : 0;
    const rel = Math.max(band.rel, relSpread);
    const floor = band.floor[any.unit] ?? 0;
    const limit = (x) => Math.max(rel * Math.abs(x), floor);
    const beyond = (x, y) => (y - x) * dir > limit(x) ? 1 : (x - y) * dir > limit(x) ? -1 : 0; // 1: y worse than x
    const pairs = [];
    for (let i = 0; i < Math.min(ra.runs.length, rb.runs.length); i++) pairs.push(beyond(ra.runs[i].value, rb.runs[i].value));
    const med = beyond(ra.value, rb.value);
    out.ratio = ra.value !== 0 ? rb.value / ra.value : null;
    out.band = { rel: r2(rel), floor };
    out.pairs = pairs;
    out.worse = med === 1 && pairs.length > 0 && pairs.every((p) => p === 1);
    const better = med === -1 && pairs.length > 0 && pairs.every((p) => p === -1);
    out.verdict = out.worse ? 'WORSE' : better ? 'better' : med !== 0 ? `${med === 1 ? 'worse' : 'better'} in the medians only (noise)` : 'same';
    return out;
  });
}
