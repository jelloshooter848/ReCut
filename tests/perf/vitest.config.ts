/**
 * Vitest config for the performance benchmarks in tests/perf.
 * The root vite.config.ts only includes tests/unit, so run these with:
 *   NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts
 * (plain `npx vitest run tests/perf` finds nothing because of the root `include`.)
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

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
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true, execArgv: ['--expose-gc'] } },
    reporters: ['verbose'],
  },
});
