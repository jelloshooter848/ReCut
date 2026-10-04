# E2E tests

Playwright drives the real Electron app (`dist/electron/main.js`) under xvfb.

- Build first: `npm run build`
- Run: `xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts`
- The renderer exposes `window.__recut = { store, actions, selectors, runCommand }` for automation:
  `page.evaluate(() => window.__recut.store.getState().project)`.
- Launch with `env: { RECUT_USER_DATA: <tmp>, RECUT_CACHE_DIR: <tmp> }` for isolation and `args: ['.', '--no-sandbox']`.
- Synthetic media: `scripts/make-test-media.sh <dir> short`.
