import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
export default defineConfig({
  root,
  resolve: { alias: { '@shared': path.resolve(root, 'shared'), '@': path.resolve(root, 'src') } },
  test: { include: ['tests/attack-qa/**/*.test.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 120_000 },
});
