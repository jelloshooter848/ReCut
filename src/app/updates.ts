/**
 * Update notice, renderer side: the status from the main process (electron/updateCheck.ts), the first-launch opt-in
 * prompt, the "new version" notice, and Help › Check for Updates…. Nothing is downloaded or installed: the notice only
 * opens the release page in the browser.
 */
import { create } from 'zustand';
import { registerCommand } from '@/keyboard/shortcuts';
import { recutApi } from '@/state/mediaActions';
import { toast } from '@/components/ui/toastStore';
import { confirmInApp } from './dialogs/ConfirmDialog';
import { RELEASES_PAGE_URL, type UpdateCheckResult, type UpdateCheckSetting, type UpdateRelease, type UpdateStatus } from '@shared/update';

export const CHECK_FOR_UPDATES_COMMAND = 'help.checkForUpdates';

interface UpdateUiState {
  status: UpdateStatus | null;
  /** Version whose notice was closed for this session (it comes back on the next launch unless skipped). */
  dismissed: string | null;
  checking: boolean;
}

export const useUpdateStore = create<UpdateUiState>()(() => ({ status: null, dismissed: null, checking: false }));

const setStatus = (status: UpdateStatus) => useUpdateStore.setState({ status });

/** The opt-in prompt is shown: the user has not chosen yet and the installation does not turn checks off. */
export function showsUpdatePrompt(s: UpdateStatus | null): boolean {
  return !!s && s.setting === 'ask' && !s.managed;
}

/** The release the notice shows, or null (none, or closed for this session). */
export function noticeRelease(s: UpdateStatus | null, dismissed: string | null): UpdateRelease | null {
  if (!s?.available) return null;
  return s.available.version === dismissed ? null : s.available;
}

export async function refreshUpdateStatus(): Promise<void> {
  const api = recutApi();
  if (!api?.updateStatus) return;
  try { setStatus(await api.updateStatus()); } catch (e) { console.warn('[update] status unavailable:', e); }
}

export async function setUpdateCheckSetting(setting: UpdateCheckSetting): Promise<void> {
  const api = recutApi();
  if (!api?.setUpdateCheck) return;
  try { setStatus(await api.setUpdateCheck(setting)); } catch (e) { toast('error', `Could not change the update setting: ${e instanceof Error ? e.message : String(e)}`); }
}

export async function skipUpdateVersion(version: string): Promise<void> {
  const api = recutApi();
  if (!api?.skipUpdateVersion) return;
  try { setStatus(await api.skipUpdateVersion(version)); } catch (e) { console.warn('[update] skip failed:', e); }
}

export function dismissUpdateNotice(version: string): void {
  useUpdateStore.setState({ dismissed: version });
}

/** Open a release page (main refuses anything but this repository's releases pages). */
export async function openReleasePage(url: string): Promise<void> {
  const ok = await recutApi()?.openReleasePage?.(url).catch(() => false);
  if (!ok) toast('error', `Could not open ${url}`);
}

/** Help › Check for Updates…: one check now, whatever the setting, and say what came of it. */
export async function checkForUpdatesNow(): Promise<UpdateCheckResult | null> {
  const api = recutApi();
  if (!api?.checkForUpdates) { toast('info', 'Checking for updates needs the desktop app'); return null; }
  if (useUpdateStore.getState().checking) return null;
  useUpdateStore.setState({ checking: true });
  let result: UpdateCheckResult;
  try {
    result = await api.checkForUpdates();
  } catch (e) {
    result = { kind: 'failed', current: useUpdateStore.getState().status?.current ?? '', error: e instanceof Error ? e.message : String(e) };
  } finally {
    useUpdateStore.setState({ checking: false });
  }
  void refreshUpdateStatus();
  if (result.kind === 'newer') {
    const { version, url } = result.release;
    useUpdateStore.setState((s) => (s.dismissed === version ? { dismissed: null } : {}));
    const choice = await confirmInApp({
      type: 'info', title: 'Check for Updates', testId: 'update-check-result',
      message: `ReCut ${version} is available.`,
      detail: `You have ReCut ${result.current}. ReCut does not update itself: download the new version from its release page and install it over this one. Your projects and preferences are kept.`,
      buttons: ['Release notes', 'Skip this version', 'Close'], defaultId: 0, cancelId: 2,
    });
    if (choice === 0) await openReleasePage(url);
    else if (choice === 1) await skipUpdateVersion(version);
  } else if (result.kind === 'current') {
    await confirmInApp({
      type: 'info', title: 'Check for Updates', testId: 'update-check-result',
      message: `ReCut ${result.current} is up to date.`,
      detail: `The latest release on GitHub is ${result.latestVersion}.`,
      buttons: ['OK'], defaultId: 0, cancelId: 0,
    });
  } else {
    const choice = await confirmInApp({
      type: 'warning', title: 'Check for Updates', testId: 'update-check-result',
      message: "Couldn't check for updates.",
      detail: `${result.error}.\n\nCheck your internet connection and try again, or look at the releases page: ${RELEASES_PAGE_URL}`,
      buttons: ['Open releases page', 'Close'], defaultId: 1, cancelId: 1,
    });
    if (choice === 0) await openReleasePage(RELEASES_PAGE_URL);
  }
  return result;
}

let initialized = false;

/** Load the status, follow the main process's updates, and register Help › Check for Updates…. Idempotent. */
export function initUpdates(): void {
  if (initialized) return;
  initialized = true;
  registerCommand({ id: CHECK_FOR_UPDATES_COMMAND, title: 'Check for Updates…', category: 'Help', defaultKeys: [], run: () => { void checkForUpdatesNow(); } });
  const api = recutApi();
  if (!api) return;
  try { api.onUpdateStatus?.(setStatus); } catch (e) { console.warn('[update] no status events:', e); }
  void refreshUpdateStatus();
}
