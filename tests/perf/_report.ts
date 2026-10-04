/**
 * Minimal measurement recorder shared by the perf tests: collects rows, prints a table at the end of a
 * suite and writes JSON under the scratch results dir (RECUT_PERF_OUT) so docs/attack/performance.md
 * can be assembled from real numbers.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Row { section: string; metric: string; value: number | string; unit: string; threshold?: string; pass?: boolean | null; note?: string }

const rows: Row[] = [];

export function record(r: Row): Row { rows.push(r); return r; }

export function ms(section: string, metric: string, value: number, threshold?: number, note?: string): Row {
  return record({ section, metric, value: round(value), unit: 'ms', threshold: threshold !== undefined ? `<= ${threshold} ms` : undefined, pass: threshold !== undefined ? value <= threshold : null, note });
}

export function round(v: number, d = 2): number { const f = 10 ** d; return Math.round(v * f) / f; }

export function now(): number { return performance.now(); }

/** Run fn n times; returns timing stats in ms. */
export function bench(n: number, fn: (i: number) => void): { median: number; p95: number; max: number; mean: number; total: number; samples: number[] } {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) { const t = now(); fn(i); samples.push(now() - t); }
  return stats(samples);
}

export async function benchAsync(n: number, fn: (i: number) => Promise<void>): Promise<ReturnType<typeof stats>> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) { const t = now(); await fn(i); samples.push(now() - t); }
  return stats(samples);
}

export function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? 0;
  const total = s.reduce((a, b) => a + b, 0);
  return { median: round(q(0.5)), p95: round(q(0.95)), max: round(s[s.length - 1] ?? 0), mean: round(total / Math.max(1, s.length)), total: round(total), samples };
}

export function heapMB(): number {
  if (typeof global.gc === 'function') global.gc();
  return round(process.memoryUsage().heapUsed / 1048576);
}
export function rssMB(): number { return round(process.memoryUsage().rss / 1048576); }

export function outDir(): string {
  const d = process.env.RECUT_PERF_OUT || path.join(process.cwd(), 'test-results', 'perf');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function flush(name: string): void {
  const mine = rows.splice(0, rows.length);
  const file = path.join(outDir(), `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(mine, null, 2));
  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const lines = mine.map((r) => `${w(r.section, 10)} ${w(r.metric, 58)} ${String(r.value).padStart(12)} ${w(r.unit, 6)} ${w(r.threshold ?? '', 16)} ${r.pass === null || r.pass === undefined ? '' : r.pass ? 'PASS' : 'FAIL'} ${r.note ?? ''}`);
  console.log(`\n[perf:${name}] ${mine.length} measurements -> ${file}\n${lines.join('\n')}\n`);
}
