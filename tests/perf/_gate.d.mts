// Types for tests/perf/_gate.mjs (the performance gate's pure logic), for tests/unit/perf-gate.test.ts.
export type Tier = 'gate' | 'guardrail' | 'diagnostic';
export type Category = 'js' | 'ffmpeg' | 'render';
export interface RunRow { key: string; file: string; section: string; metric: string; value: number | string; unit?: string; threshold?: string; pass?: boolean | null; tier?: string; reference?: boolean; longTasks?: number[] }
export interface PerRun { value: number | string; pass: boolean; longTasks?: number[] }
export interface Verdict { value: number | string; passes: number; budgetPass: boolean; how: string; ratio: number | null; pass: boolean; verdict: string; unconfirmed: boolean; noBaseline: boolean }
export interface Aggregated {
  key: string; file: string; section: string; metric: string; unit: string; threshold: string; tier: Tier; reference: boolean;
  value: number | string; numeric: boolean; mins: number | null; maxs: number | null; spread: string; passes: number; n: number; inAll: boolean; budgetPass: boolean; runs: PerRun[];
  base?: number | null; baseText?: string | null; category?: Category; cls?: string; k?: number | null; kEff?: number;
  raw?: Verdict; norm?: Verdict; normalized?: boolean; ratio?: number | null; pass?: boolean; verdict?: string; unconfirmed?: boolean; noBaseline?: boolean;
}
export interface Ratio { k: number | null; from: Category | null; effective: number; normalized: boolean }
export type Ratios = Record<Category, Ratio>;
export type Scores = Record<Category, number | null>;
export interface Calibration { scores?: Partial<Record<Category, { median?: number; error?: string; iqr?: number }>> }
export interface Baseline { rows?: Record<string, { median: number | null; value?: unknown; tier?: string }> }
export interface ABRow { key: string; file: string; section: string; metric: string; unit: string; tier: Tier; a: Aggregated | null; b: Aggregated | null; ratio: number | null; band: { rel: number; floor: number } | null; verdict: string; worse: boolean; pairs?: number[] }

export const REGRESSION_RULE: { ratio: number; minRuns: number; floor: Record<string, number>; zeroBaseCount?: number };
export const CALIBRATION_TOLERANCE: number;
export const CATEGORIES: Category[];
export const LONG_TASK_MS: number;
export const CAP_NEAR: number;
export const AB_BAND: { rel: number; floor: Record<string, number> };
export const AB_RUNS: number;
export const TIERS: Tier[];
export function isNum(v: unknown): v is number;
export function median(xs: number[]): number;
export function r2(v: number): number;
export function metricClass(row: { unit?: string; metric: string }): { kind: 'time' | 'rate' | 'longtasks' | 'count'; cap?: number };
export function categoryOf(row: { file: string; section: string; metric: string }): Category;
export function scoresOf(cal: Calibration | null): Scores;
export function combineScores(cals: Calibration[]): Scores;
export function calibrationRatios(current: Partial<Scores> | null, reference: Partial<Scores> | null, tol?: number): Ratios;
export function normalize(row: { unit?: string; metric: string; value?: unknown; longTasks?: number[] }, k: number, value?: unknown, longTasks?: number[]): { value: unknown; how: string };
export function parseThreshold(t: unknown): { op: string; n: number } | null;
export function meets(th: { op: string; n: number }, v: number): boolean;
export function runPass(row: { unit?: string; metric: string; threshold?: string }, run: PerRun, k: number): { pass: boolean; value: unknown; how: string };
export function aggregate(runs: RunRow[][]): Aggregated[];
export function judge(r: Aggregated, base: { base: number | null; baseText: string | null }, nRuns: number, k: number, rule?: typeof REGRESSION_RULE): Verdict;
export function evaluate(rows: Aggregated[], baseline: Baseline | null, nRuns: number, ratios?: Ratios | null, rule?: typeof REGRESSION_RULE): Aggregated[];
export function compareAB(rowsA: Aggregated[], rowsB: Aggregated[], band?: typeof AB_BAND): ABRow[];
