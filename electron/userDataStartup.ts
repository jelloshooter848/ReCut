/**
 * Where this launch keeps its user data: the app name (which names the folder), the `<prefix>USER_DATA` override and
 * the one-time migration from a legacy folder (electron/userDataMigration.ts). `prepareUserData()` runs in main.ts
 * before anything calls `app.getPath('userData')` or takes the single-instance lock; the notices it may owe the user
 * are shown once the app is ready.
 *
 * Test switches, honoured only by an unpackaged app (tests, development), never by a release build:
 *  - `<prefix>TEST_APP_DATA`: the folder that holds the user-data folders instead of the OS app-data folder;
 *  - `<prefix>TEST_APP_NAME`: the app name (hence the user-data folder name) instead of USER_DATA_DIR_NAME;
 *  - `<prefix>TEST_LEGACY_USER_DATA`: the legacy folder(s) (path.delimiter-separated) instead of
 *    `<app data>/<LEGACY_USER_DATA_DIR_NAMES>`;
 *  - `<prefix>TEST_MIGRATION_FORCE_COPY=1`: act as if renaming the legacy folder failed (EXDEV);
 *  - `<prefix>TEST_MIGRATION_DIALOG=restart|continue|quit`: answer the "legacy app is running" question without a
 *    native dialog; notices are then printed (`user-data notice: …`) instead of shown.
 */
import { app, dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import { LEGACY_USER_DATA_DIR_NAMES, PRODUCT_NAME, USER_DATA_DIR_NAME } from '../shared/productIdentity';
import { envVar } from './env';
import { isSameFolder, migrateUserData, type MigrationOutcome } from './userDataMigration';

export interface UserDataStartup {
  outcome: MigrationOutcome;
  /** Legacy user-data folders other than the one in use (their cache paths are remapped: shared/legacyPaths.ts). */
  legacyDirs: string[];
}

const testSwitch = (name: string): string | undefined => (app.isPackaged ? undefined : envVar(name));

/** Name the app, apply the override, run the migration and point userData at the folder this session uses. */
export function prepareUserData(): UserDataStartup {
  app.setName(testSwitch('TEST_APP_NAME') || USER_DATA_DIR_NAME);
  const override = envVar('USER_DATA');
  if (override) {
    app.setPath('userData', path.resolve(override));
    return { outcome: { result: 'none', userData: app.getPath('userData'), reason: 'override' }, legacyDirs: [] };
  }
  const testAppData = testSwitch('TEST_APP_DATA');
  if (testAppData) app.setPath('userData', path.join(path.resolve(testAppData), app.getName()));
  const appData = testAppData ? path.resolve(testAppData) : app.getPath('appData');
  const current = app.getPath('userData');
  const testLegacy = testSwitch('TEST_LEGACY_USER_DATA');
  const legacy = testLegacy
    ? testLegacy.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p))
    : LEGACY_USER_DATA_DIR_NAMES.map((n) => path.join(appData, n));
  const outcome = migrateUserData({
    current, legacy, overridden: false, appVersion: app.getVersion(), forceCopy: testSwitch('TEST_MIGRATION_FORCE_COPY') === '1',
  });
  if (outcome.userData !== current) app.setPath('userData', outcome.userData);
  const inUse = app.getPath('userData');
  return { outcome, legacyDirs: legacy.filter((p) => !isSameFolder(p, inUse)) };
}

type Box = { type: 'info' | 'warning' | 'question'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };

const scripted = (): string | undefined => testSwitch('TEST_MIGRATION_DIALOG');

async function show(box: Box, win?: BrowserWindow | null): Promise<number> {
  const answer = scripted();
  if (answer !== undefined) {
    console.log(`user-data notice: ${box.message} | ${box.detail}`);
    const i = box.buttons.findIndex((b) => b.toLowerCase().startsWith(answer.toLowerCase()));
    return i >= 0 ? i : box.defaultId;
  }
  const opts = { ...box, noLink: true };
  return (win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)).response;
}

const legacyAppName = (dir: string) => path.basename(dir);

/**
 * The legacy app still uses its folder (outcome 'legacy-in-use'): ask, after `ready` and before the single-instance
 * lock. 'restart' relaunches (the migration runs again), 'continue' keeps the legacy folder for this session.
 */
export async function askLegacyInUse(s: UserDataStartup): Promise<'restart' | 'continue' | 'quit'> {
  const legacy = s.outcome.legacy ?? s.outcome.userData;
  const other = legacyAppName(legacy);
  const i = await show({
    type: 'question', title: PRODUCT_NAME,
    message: `Quit ${other}, then click Restart`,
    detail: `${PRODUCT_NAME} moves your settings, models and caches from ${legacy} to its own folder when it first starts, `
      + `but ${other} is running and using that folder, so nothing was moved.\n\n`
      + `Restart: try again once ${other} is closed.\n`
      + `Continue without moving: use the settings in ${legacy} for this session; they are moved at a later start. `
      + `If ${other} is still open, it is brought to the front instead.\n`
      + `Quit: close ${PRODUCT_NAME}.`,
    buttons: ['Restart', 'Continue without moving', 'Quit'], defaultId: 0, cancelId: 2,
  });
  return i === 0 ? 'restart' : i === 1 ? 'continue' : 'quit';
}

/** The one-time notice a finished migration owes the user (both folders held data, or the move failed), if any. */
export async function showMigrationNotice(s: UserDataStartup, win?: BrowserWindow | null): Promise<void> {
  const { result, legacy, error } = s.outcome;
  const current = app.getPath('userData');
  if (result === 'both-existed' && legacy) {
    await show({
      type: 'info', title: PRODUCT_NAME, message: 'Your earlier settings were left where they are',
      detail: `${PRODUCT_NAME} found settings both in ${legacy} and in ${current}. It uses ${current} and has not changed `
        + `or merged ${legacy}: copy anything you need from there by hand. This message is shown once.`,
      buttons: ['OK'], defaultId: 0, cancelId: 0,
    }, win);
  } else if (result === 'failed' && legacy) {
    await show({
      type: 'warning', title: PRODUCT_NAME, message: 'Your settings could not be moved',
      detail: `${PRODUCT_NAME} could not move ${legacy} to its own folder (${error ?? 'unknown error'}). Nothing was deleted: `
        + `this session uses ${legacy}, and the move is tried again at the next start.`,
      buttons: ['OK'], defaultId: 0, cancelId: 0,
    }, win);
  }
}
