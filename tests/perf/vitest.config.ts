/**
 * Vitest config for the performance benchmarks in tests/perf.
 * The root vite.config.ts only includes tests/unit, so run these with:
 *   NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts
 * (plain `npx vitest run tests/perf` finds nothing because of the root `include`.)
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
// A slower host needs longer (the full chunked export takes about 8 min on the reference machine): perf-check.mjs sets
// RECUT_PERF_TIMEOUT_SCALE to the run's calibration ratio against the baseline when that is above 1.
const scale = Math.max(1, Number(process.env.RECUT_PERF_TIMEOUT_SCALE) || 1);

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'shared'),
      '@': path.resolve(root, 'src'),
    },
  },
  test: {
    root,
    include: ['tests/perf/**/*.perf.test.ts'],
    environment: 'node',
    testTimeout: Math.round(900_000 * scale),
    hookTimeout: Math.round(900_000 * scale),
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, execArgv: ['--expose-gc'] } },
    reporters: ['verbose'],
  },
});
