/**
 * The performance gate's pure logic (tests/perf/_gate.mjs): calibration ratios, metric classes, normalization to the
 * reference machine, verdicts and the same-host A/B comparison
 * (bugs/closed/2026-10-07-perf-gate-verdict-not-reproducible.md: the same code failed 15 of 98 gates on a host about
 * 1.5-2.3x slower than the one the baseline was recorded on).
 */
import { describe, it, expect } from 'vitest';
import {
  aggregate, evaluate, calibrationRatios, combineScores, compareAB, categoryOf, metricClass, normalize, parseThreshold, runPass,
  AB_RUNS, CALIBRATION_TOLERANCE, REGRESSION_RULE, type RunRow, type Aggregated, type Ratios,
} from '../perf/_gate.mjs';

/** One run's row. */
const row = (file: string, section: string, metric: string, value: number | string, unit: string, threshold: string | undefined, pass: boolean | null, extra: Partial<RunRow> = {}): RunRow =>
  ({ key: `${file}|${section}|${metric}`, file, section, metric, value, unit, threshold, pass, ...extra });

/** A gate row measured with value v (ms, "<= budget") in each run. */
const msGate = (metric: string, budget: number, ...vs: number[]): RunRow[] => vs.map((v) => row('electron', 'store', metric, v, 'ms', `<= ${budget} ms`, v <= budget));

/** Runs (one RunRow[] per run) from per-row lists of run values. */
const runsOf = (...perRow: RunRow[][]): RunRow[][] => {
  const n = Math.max(...perRow.map((r) => r.length));
  return Array.from({ length: n }, (_, i) => perRow.map((r) => r[i]).filter(Boolean));
};

const ratiosFor = (k: Partial<Record<'js' | 'ffmpeg' | 'render', number>>): Ratios =>
  calibrationRatios({ js: 100 * (k.js ?? 1), ffmpeg: 100 * (k.ffmpeg ?? 1), render: 100 * (k.render ?? 1) }, { js: 100, ffmpeg: 100, render: 100 });

const one = (rows: Aggregated[], metric: string) => rows.find((r) => r.metric === metric)!;

describe('metric classes', () => {
  it('classifies time, rate (with its cap), long-task counts and structural counts', () => {
    expect(metricClass({ unit: 'ms', metric: 'switch sequence x20 -> paint (median)' }).kind).toBe('time');
    expect(metricClass({ unit: 'fps', metric: 'playhead scrub fps (rAF-driven setView) @ zoom-to-fit' })).toEqual({ kind: 'rate', cap: 60 });
    expect(metricClass({ unit: 'fps', metric: 'program fps @ 1 px/frame timeline (store playhead updates/s over 10 s)' })).toEqual({ kind: 'rate', cap: 24 });
    expect(metricClass({ unit: '', metric: 'long tasks during scrub @ 1 px/frame, 50 clips selected' }).kind).toBe('longtasks');
    expect(metricClass({ unit: '', metric: 'wheel x100 @ 1 px/frame: long tasks' }).kind).toBe('longtasks');
    for (const [unit, metric] of [['', 'DOM mutations per frame @ zoom-to-fit (tracks col / clips content)'], ['', 'ClipView renders per frame @ 1 px/frame'], ['nodes', 'DOM nodes in tracks content @ zoom-to-fit'], ['MB', 'heap growth over 300 commits (MB)'], ['frames', 'full export 2500 clips: frames out / expected'], ['calls', 'thumbnail IPC calls in 2.5 s after scrolling 3000 scene rows']]) {
      expect(metricClass({ unit, metric }).kind).toBe('count');
    }
  });

  it('picks the calibration category of a row', () => {
    expect(categoryOf({ file: 'store', section: 'commit', metric: 'razor all tracks (median)' })).toBe('js');
    expect(categoryOf({ file: 'export', section: 'graph', metric: 'buildRenderGraph @ 500 clips (median)' })).toBe('js');
    expect(categoryOf({ file: 'export', section: 'ffmpeg', metric: 'ffmpeg wall time @ 100 clips (0.5 s output)' })).toBe('ffmpeg');
    expect(categoryOf({ file: 'main', section: 'thumbs', metric: 'thumbnail cache MISS (median)' })).toBe('ffmpeg');
    expect(categoryOf({ file: 'electron', section: 'main', metric: 'thumbnail MISS via IPC (median of 8)' })).toBe('ffmpeg');
    expect(categoryOf({ file: 'electron', section: 'fairness', metric: 'autosave round trip while playing' })).toBe('render');
    expect(categoryOf({ file: 'electron', section: 'scrub', metric: 'playhead scrub fps (rAF-driven setView) @ zoom-to-fit' })).toBe('render');
  });
});

describe('calibration ratio', () => {
  it('is this host / the reference, 1 within the tolerance, and falls back to js for a missing category', () => {
    const r = calibrationRatios({ js: 180, ffmpeg: 230, render: null }, { js: 100, ffmpeg: 100, render: 250 });
    expect(r.js.k).toBeCloseTo(1.8);
    expect(r.js.effective).toBeCloseTo(1.8);
    expect(r.ffmpeg.k).toBeCloseTo(2.3);
    expect(r.render).toMatchObject({ from: 'js', normalized: true });
    expect(r.render.k).toBeCloseTo(1.8);
    const near = calibrationRatios({ js: 100 * (1 + CALIBRATION_TOLERANCE) - 1, ffmpeg: 95, render: 100 }, { js: 100, ffmpeg: 100, render: 100 });
    expect(near.js).toMatchObject({ effective: 1, normalized: false });
    expect(near.ffmpeg).toMatchObject({ effective: 1, normalized: false });
    const fast = calibrationRatios({ js: 60, ffmpeg: 60, render: 60 }, { js: 100, ffmpeg: 100, render: 100 });
    expect(fast.js.effective).toBeCloseTo(0.6);
    const none = calibrationRatios({ js: null, ffmpeg: 120, render: null }, { js: 100, ffmpeg: 100, render: 100 });
    expect(none.js).toMatchObject({ k: null, effective: 1, normalized: false });
    expect(none.render).toMatchObject({ k: null, effective: 1 });
    expect(none.ffmpeg.k).toBeCloseTo(1.2);
  });

  it('combines several runs by the median, ignoring failed categories', () => {
    const cal = (js: number, render?: number) => ({ scores: { js: { median: js }, ffmpeg: { error: 'no ffmpeg' }, render: render === undefined ? undefined : { median: render } } });
    expect(combineScores([cal(80, 250), cal(90), cal(100, 270)])).toEqual({ js: 90, ffmpeg: null, render: 260 });
  });
});

describe('normalization to the reference machine', () => {
  const time = { unit: 'ms', metric: 'switch sequence x20 -> paint (median)' };
  const fps = { unit: 'fps', metric: 'playhead scrub fps (rAF-driven setView) multi-hour @ 1 px/frame, no selection' };
  const lt = { unit: '', metric: 'long tasks during scrub @ 1 px/frame, 50 clips selected' };

  it('divides time by k and multiplies rates by k up to their cap', () => {
    expect(normalize(time, 2, 134)).toEqual({ value: 67, how: 'time' });
    expect(normalize(time, 0.5, 40)).toEqual({ value: 80, how: 'time' });
    expect(normalize(fps, 1.25, 41.2).value).toBeCloseTo(51.5);
    expect(normalize(fps, 1.9, 41.2)).toEqual({ value: 60, how: 'rate' });
    expect(normalize({ unit: 'fps', metric: 'program fps @ zoom-to-fit (2500 clips mounted) (store playhead updates/s over 6 s)' }, 2, 20)).toEqual({ value: 24, how: 'rate' });
  });

  it('leaves a capped rate on a faster host raw, and scales a rate below the cap', () => {
    expect(normalize(fps, 0.7, 59.5)).toEqual({ value: 59.5, how: 'capped' });
    expect(normalize(fps, 0.8, 50).value).toBeCloseTo(40);
  });

  it('re-counts long tasks against 50 ms x k, never scales the count', () => {
    expect(normalize(lt, 1.9, 2, [62, 91])).toEqual({ value: 0, how: 'longtasks' });
    expect(normalize(lt, 1.5, 2, [62, 91])).toEqual({ value: 1, how: 'longtasks' });
    expect(normalize(lt, 0.8, 1, [52])).toEqual({ value: 1, how: 'longtasks (lower bound)' });
    expect(normalize(lt, 1.9, 2)).toEqual({ value: 2, how: 'raw' }); // no durations recorded: raw
  });

  it('never normalizes counts and structural rows, and k = 1 changes nothing', () => {
    expect(normalize({ unit: '', metric: 'ClipView renders per frame @ 1 px/frame' }, 2, 10.5)).toEqual({ value: 10.5, how: 'count' });
    expect(normalize({ unit: 'MB', metric: 'heap growth over 300 commits (MB)' }, 0.5, 3.2)).toEqual({ value: 3.2, how: 'count' });
    expect(normalize(time, 1, 134)).toEqual({ value: 134, how: 'raw' });
    expect(normalize(time, 2, '16 / 0')).toEqual({ value: '16 / 0', how: 'raw' });
  });

  it('parses bench thresholds', () => {
    expect(parseThreshold('<= 100 ms')).toEqual({ op: '<=', n: 100 });
    expect(parseThreshold('>= 23')).toEqual({ op: '>=', n: 23 });
    expect(parseThreshold('== 0')).toEqual({ op: '==', n: 0 });
    expect(parseThreshold('content == 0')).toBeNull();
    expect(parseThreshold(undefined)).toBeNull();
  });

  it('keeps a failure that is not about the threshold (an in-page scrub that page-flipped)', () => {
    const r = { unit: 'fps', metric: 'playhead scrub fps (rAF-driven setView) @ 1 px/frame, within the visible page, no selection', threshold: '>= 50' };
    expect(runPass(r, { value: 59, pass: false }, 1.5).pass).toBe(false); // raw met the threshold, the bench failed it
    expect(runPass(r, { value: 40, pass: false }, 1.5).pass).toBe(true); // failed on the threshold only: normalized 60
  });
});

describe('verdicts', () => {
  // The gates and guardrails that failed in the bug report on identical code (a host ~1.8-2x slower than the
  // baseline's), as measured there; long-task durations are plausible values for that host.
  const slowHostRuns = runsOf(
    [row('electron', 'long', 'playhead scrub fps (rAF-driven setView) multi-hour @ 1 px/frame, no selection', 37.7, 'fps', '>= 50', false), row('electron', 'long', 'playhead scrub fps (rAF-driven setView) multi-hour @ 1 px/frame, no selection', 44.2, 'fps', '>= 50', false)],
    [row('electron', 'timeline', 'switch to big sequence -> first paint @ zoom-to-fit', 128.7, 'ms', '<= 100 ms', false), row('electron', 'timeline', 'switch to big sequence -> first paint @ zoom-to-fit', 139.7, 'ms', '<= 100 ms', false)],
    [row('electron', 'io', 'openProject round trip', 782, 'ms', '<= 1000 ms', true), row('electron', 'io', 'openProject round trip', 1349, 'ms', '<= 1000 ms', false)],
    [row('electron', 'scrub', 'long tasks during scrub @ 1 px/frame, 50 clips selected', 1, '', '== 0', false, { longTasks: [64] }), row('electron', 'scrub', 'long tasks during scrub @ 1 px/frame, 50 clips selected', 1, '', '== 0', false, { longTasks: [71] })],
    [row('electron', 'scrub', 'ClipView renders per frame @ zoom-to-fit, no selection', 0, '', '== 0', true), row('electron', 'scrub', 'ClipView renders per frame @ zoom-to-fit, no selection', 0, '', '== 0', true)],
    [row('store', 'commit', 'razor all tracks (median)', 7.1, 'ms', '<= 16 ms', true, { tier: 'guardrail' }), row('store', 'commit', 'razor all tracks (median)', 7.38, 'ms', '<= 16 ms', true, { tier: 'guardrail' })],
    [row('export', 'ffmpeg', 'ffmpeg wall time @ 100 clips (0.5 s output)', 3300, 'ms', '<= 60000 ms', true, { tier: 'guardrail' }), row('export', 'ffmpeg', 'ffmpeg wall time @ 100 clips (0.5 s output)', 3480, 'ms', '<= 60000 ms', true, { tier: 'guardrail' })],
  );
  const baseline = { rows: { 'store|commit|razor all tracks (median)': { tier: 'guardrail', median: 3.65 }, 'export|ffmpeg|ffmpeg wall time @ 100 clips (0.5 s output)': { tier: 'guardrail', median: 1453 } } };

  it('the same code on a slower host: raw FAIL, normalized PASS (the bug)', () => {
    const rows = evaluate(aggregate(slowHostRuns), baseline, 2, ratiosFor({ js: 1.98, ffmpeg: 2.33, render: 1.9 }));
    for (const r of rows) {
      expect(r.pass, `${r.metric}: ${r.verdict}`).toBe(true);
    }
    expect(rows.filter((r) => r.tier === 'gate' && !r.raw!.pass).map((r) => r.metric)).toHaveLength(4);
    expect(rows.filter((r) => r.tier === 'guardrail' && !r.raw!.pass)).toHaveLength(2);
    const scrub = one(rows, 'playhead scrub fps (rAF-driven setView) multi-hour @ 1 px/frame, no selection');
    expect(scrub.normalized).toBe(true);
    expect(scrub.norm!.value).toBe(60);
    expect(one(rows, 'razor all tracks (median)').ratio).toBeCloseTo(7.24 / 1.98 / 3.65, 2);
    expect(one(rows, 'ClipView renders per frame @ zoom-to-fit, no selection').normalized).toBe(false);
  });

  it('a host within the tolerance is judged raw (the same FAILs as before)', () => {
    const rows = evaluate(aggregate(slowHostRuns), baseline, 2, ratiosFor({ js: 1.05, ffmpeg: 0.95, render: 1.08 }));
    expect(rows.every((r) => !r.normalized)).toBe(true);
    expect(rows.filter((r) => !r.pass)).toHaveLength(6);
  });

  it('without calibration everything is raw', () => {
    const rows = evaluate(aggregate(slowHostRuns), baseline, 2, null);
    expect(rows.filter((r) => !r.pass)).toHaveLength(6);
  });

  it('a fast host does not hide a regression', () => {
    const runs = runsOf(
      msGate('razor all tracks commit -> paint (median)', 32, 24, 26), // passes raw on a host 1.6x faster
      [row('store', 'commit', 'setClipSpeed ripple (median)', 2.9, 'ms', '<= 16 ms', true, { tier: 'guardrail' }), row('store', 'commit', 'setClipSpeed ripple (median)', 3.1, 'ms', '<= 16 ms', true, { tier: 'guardrail' })],
    );
    const base = { rows: { 'store|commit|setClipSpeed ripple (median)': { tier: 'guardrail', median: 2.04 } } };
    const rows = evaluate(aggregate(runs), base, 2, ratiosFor({ js: 0.6, render: 0.6 }));
    const gate = one(rows, 'razor all tracks commit -> paint (median)');
    expect(gate.raw!.pass).toBe(true);
    expect(gate.pass).toBe(false); // 25 ms here is about 42 ms on the reference machine
    const guard = one(rows, 'setClipSpeed ripple (median)');
    expect(guard.raw!.pass).toBe(true); // x1.47 raw: under the x1.5 rule
    expect(guard.verdict).toMatch(/regression x2\.45/);
  });

  it('keeps the regression floor, and one run is UNCONFIRMED', () => {
    const g = (v: number) => row('panels', 'transcript', 'searchTranscript regex', v, 'ms', '<= 50 ms', true, { tier: 'guardrail' });
    const base = { rows: { 'panels|transcript|searchTranscript regex': { tier: 'guardrail', median: 1.2 } } };
    expect(evaluate(aggregate([[g(3)], [g(3.1)]]), base, 2, null)[0].pass).toBe(true); // x2.5 but +1.85 ms: under the floor
    const single = evaluate(aggregate([[g(5)]]), base, 1, null)[0];
    expect(single.pass).toBe(true);
    expect(single.unconfirmed).toBe(true);
    expect(evaluate(aggregate([[g(5)], [g(5.2)]]), base, 2, null)[0].verdict).toMatch(/FAIL \(regression/);
  });

  it('a count row with a baseline of 0 tolerates 1, fails at 2; non-zero baselines keep the ratio rule', () => {
    expect(REGRESSION_RULE.zeroBaseCount).toBe(1);
    const metric = 'media elements (<video> + <audio>) created during 10 s playback @ 1 px/frame';
    const c = (v: number) => row('electron', 'pool', metric, v, '', '<= 16 (pool capacity)', v <= 16, { tier: 'guardrail' });
    const base = (median: number) => ({ rows: { [`electron|pool|${metric}`]: { tier: 'guardrail' as const, median } } });
    const verdict = (b: number, ...vs: number[]) => evaluate(aggregate(vs.map((v) => [c(v)])), base(b), vs.length, null)[0];
    expect(verdict(0, 0, 0).verdict).toBe('PASS');
    expect(verdict(0, 1, 1).verdict).toBe('PASS'); // 0 -> 1: tolerated
    expect(verdict(0, 0, 1).pass).toBe(true);
    expect(verdict(0, 2, 2).verdict).toMatch(/^FAIL \(regression x∞\)$/); // 0 -> 2: still a regression
    expect(verdict(0, 1, 2).pass).toBe(false); // median 1.5
    expect(verdict(0, 2).unconfirmed).toBe(true); // one run: UNCONFIRMED as before
    // Non-zero baselines are unchanged: 2 -> 3 is x1.5 (not more), 2 -> 4 fails; 1 -> 2 fails.
    expect(verdict(2, 3, 3).pass).toBe(true);
    expect(verdict(2, 4, 4).verdict).toMatch(/FAIL \(regression x2\.00\)/);
    expect(verdict(1, 2, 2).pass).toBe(false);
    // Only the count class: a 0 ms baseline (time) or 0 long tasks keep the old rule.
    const lt = (v: number) => row('electron', 'fairness', 'long tasks while autosaving', v, '', '<= 3', v <= 3, { tier: 'guardrail' });
    expect(evaluate(aggregate([[lt(1)], [lt(1)]]), { rows: { 'electron|fairness|long tasks while autosaving': { tier: 'guardrail', median: 0 } } }, 2, null)[0].pass).toBe(false);
  });

  it('a gate passes only when it passed in more than half of the runs, normalized per run', () => {
    const rows = evaluate(aggregate(runsOf(msGate('switch sequence x20 -> paint (median)', 100, 150, 190, 150))), null, 3, ratiosFor({ render: 1.6 }));
    const r = rows[0];
    expect(r.raw!.passes).toBe(0);
    expect(r.norm!.passes).toBe(2); // 93.75, 118.75, 93.75
    expect(r.pass).toBe(true);
    expect(r.norm!.value).toBeCloseTo(93.75);
  });

  it('a gate missing in one run fails', () => {
    const runs = [[...msGate('undo commit -> paint (median)', 32, 20)], []];
    const rows = evaluate(aggregate(runs), null, 2, null);
    expect(rows[0].pass).toBe(false);
  });

  it('diagnostics report the normalized trend and never fail', () => {
    const d = (v: number) => row('store', 'io', 'serializeProject (pretty JSON)', v, 'ms', '<= 100 ms', v <= 100, { tier: 'diagnostic', reference: true });
    const base = { rows: { 'store|io|serializeProject (pretty JSON)': { tier: 'diagnostic', median: 80 } } };
    const rows = evaluate(aggregate([[d(160)], [d(164)]]), base, 2, ratiosFor({ js: 2 }));
    expect(rows[0].pass).toBe(true);
    expect(rows[0].verdict).toMatch(/^steady x1\.0[0-9], within ref$/);
    expect(rows[0].raw!.verdict).toMatch(/^slower x2\.0[0-9], over ref$/);
  });
});

describe('same-host A/B', () => {
  const agg = (...perRow: RunRow[][]) => aggregate(runsOf(...perRow));
  const t = (metric: string, ...vs: number[]) => vs.map((v) => row('electron', 'store', metric, v, 'ms', '<= 32 ms', v <= 32));

  it('flags B as WORSE only when it is worse beyond the band in every run pair', () => {
    const A = agg(t('razor commit -> paint', 20, 21), t('undo commit -> paint', 20, 21), t('redo commit -> paint', 20, 22));
    const B = agg(t('razor commit -> paint', 36, 38), t('undo commit -> paint', 36, 21), t('redo commit -> paint', 21, 22));
    const cmp = compareAB(A, B);
    expect(cmp.find((r) => r.metric === 'razor commit -> paint')).toMatchObject({ verdict: 'WORSE', worse: true });
    expect(cmp.find((r) => r.metric === 'undo commit -> paint')!.worse).toBe(false); // one pair only
    expect(cmp.find((r) => r.metric === 'redo commit -> paint')!.verdict).toBe('same');
  });

  it('uses A\'s own spread as the band when it is wider than 10 %, and an absolute floor', () => {
    const A = agg(t('a', 10, 14), t('b', 1, 1.1));
    const B = agg(t('a', 14.4, 15.4), t('b', 2.5, 2.6)); // a: +20 % vs a 33 % spread; b: x2.4 but +1.5 ms < 2 ms floor
    const cmp = compareAB(A, B);
    expect(cmp.find((r) => r.metric === 'a')!.worse).toBe(false);
    expect(cmp.find((r) => r.metric === 'a')!.band!.rel).toBeCloseTo(0.33, 2);
    expect(cmp.find((r) => r.metric === 'b')!.worse).toBe(false);
  });

  it('lower is worse for rates; counts from 0 are flagged; non-numeric rows only report a change', () => {
    const f = (v: number) => row('electron', 'scrub', 'playhead scrub fps (rAF-driven setView) @ zoom-to-fit', v, 'fps', '>= 50', v >= 50);
    const l = (v: number) => row('electron', 'scrub', 'long tasks during scrub @ zoom-to-fit', v, '', '== 0', v === 0);
    const s = (v: string) => row('electron', 'pool', 'video elements created / live', v, '', 'live <= 16', true, { tier: 'guardrail' });
    const cmp = compareAB(agg([f(60), f(59)], [l(0), l(0)], [s('12 / 9'), s('12 / 9')]), agg([f(45), f(44)], [l(2), l(1)], [s('13 / 9'), s('13 / 9')]));
    expect(cmp.map((r) => r.verdict)).toEqual(['WORSE', 'WORSE', 'changed']);
    const better = compareAB(agg([f(45), f(44)]), agg([f(60), f(59)]));
    expect(better[0].verdict).toBe('better');
  });

  it('runs 3 times per side by default', () => {
    expect(AB_RUNS).toBe(3);
  });

  it('reports rows measured on one side only', () => {
    const cmp = compareAB(agg(t('old row', 10, 10)), agg(t('new row', 10, 10)));
    expect(cmp.map((r) => r.verdict)).toEqual(['only in A', 'only in B']);
  });
});
