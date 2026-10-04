import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: path.resolve(__dirname),
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  expect: { timeout: 20_000 },
  outputDir: path.resolve(__dirname, '../../test-results'),
});
