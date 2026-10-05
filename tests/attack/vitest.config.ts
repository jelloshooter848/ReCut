import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Attack suite: run with `npx vitest run -c tests/attack/vitest.config.ts` (the root config only includes tests/unit).
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '..', '..', 'shared'),
      '@': path.resolve(__dirname, '..', '..', 'src'),
    },
  },
  test: {
    include: ['tests/attack/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
