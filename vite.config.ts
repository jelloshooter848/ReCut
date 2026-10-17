import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { PRODUCT_NAME } from './shared/productIdentity';

export default defineConfig({
  plugins: [
    react(),
    // index.html names the product through shared/productIdentity.ts (%PRODUCT_NAME%), like the rest of the app.
    { name: 'product-identity', transformIndexHtml: (html: string) => html.replace(/%PRODUCT_NAME%/g, PRODUCT_NAME) },
  ],
  base: './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
