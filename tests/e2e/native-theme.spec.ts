/**
 * #166: the app is always dark, so its native chrome (the macOS title bar, menus, system dialogs) is dark too, whatever
 * the system appearance.
 */
import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers';

let launched: LaunchedApp;
test.beforeAll(async () => { launched = await launchApp(); });
test.afterAll(async () => { await launched?.app.close(); });

test('the native theme is dark', async () => {
  const theme = await launched.app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
  expect(theme).toEqual({ source: 'dark', dark: true });
});
