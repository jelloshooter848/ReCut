/**
 * Update notice wiring for the main process: creates the UpdateChecker (electron/updateCheck.ts) with Electron's
 * `net.fetch`, registers its IPC channels (shared/ipc.ts: update:*) and schedules the automatic check.
 *
 * Env:
 *  RECUT_UPDATE_CHECK=0 — no opt-in prompt and no automatic check for this installation (tests, managed installs);
 *                         Help › Check for Updates… still works.
 *  RECUT_UPDATE_URL     — tests: ask this loopback http(s) URL instead of GitHub (any other value is ignored).
 */
import { app, ipcMain, net, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import { isReleasePageUrl, isUpdateCheckSetting, parseSemver, parseUpdateUrlOverride, type UpdateStatus } from '../shared/update';
import { UpdateChecker } from './updateCheck';
import { envVar } from './env';
import { PACKAGE_NAME } from '../shared/productIdentity';

export interface UpdateIpcDeps {
  userData: string;
  /** Send ev:updateStatus to every window. */
  broadcast(channel: string, ...args: unknown[]): void;
}

/**
 * The running version: app.getVersion() (package.json `version`). When Electron was started on a script outside the
 * app folder (`electron dist/electron/main.js`, as the end-to-end tests do) it reports its own default instead, so
 * the version is then read from the app's own package.json above the app path.
 */
export function runningVersion(): string {
  const v = app.getVersion();
  if (parseSemver(v)) return v;
  let dir = app.getAppPath();
  for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string' && parseSemver(pkg.version)) return pkg.version;
    } catch { /* not here */ }
  }
  return v;
}

export function registerUpdateIpc(deps: UpdateIpcDeps): UpdateChecker {
  const rawUrl = envVar('UPDATE_URL');
  const apiUrl = parseUpdateUrlOverride(rawUrl);
  if (rawUrl && !apiUrl) console.warn('RECUT_UPDATE_URL ignored: only a loopback http(s) URL is accepted');
  const checker = new UpdateChecker({
    currentVersion: runningVersion(),
    userData: deps.userData,
    // Electron's net.fetch honours the system proxy; `credentials: 'omit'` keeps the session's cookies out of it.
    fetch: (url, init) => net.fetch(url, init),
    apiUrl: apiUrl ?? undefined,
    managed: envVar('UPDATE_CHECK') === '0',
    onStatus: (s: UpdateStatus) => deps.broadcast(IPC.evUpdateStatus, s),
  });

  ipcMain.handle(IPC.updateStatus, () => checker.status());
  ipcMain.handle(IPC.updateCheck, () => checker.check());
  ipcMain.handle(IPC.updateSetSetting, (_e, setting: unknown) => {
    if (!isUpdateCheckSetting(setting)) throw new Error('Expected ask, on or off');
    return checker.setSetting(setting);
  });
  ipcMain.handle(IPC.updateSkip, (_e, version: unknown) => checker.skipVersion(typeof version === 'string' ? version : ''));
  // Opens only the repository's releases page or one release's page (shared/update.ts isReleasePageUrl).
  ipcMain.handle(IPC.updateOpenRelease, async (_e, url: unknown) => {
    if (!isReleasePageUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  return checker;
}
