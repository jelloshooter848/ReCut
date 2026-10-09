/**
 * The update check (main process): asks GitHub for the latest release (from a release candidate, for the newest
 * releases including pre-releases) and remembers the answer in prefs.json.
 *
 * - Automatic: only when Preferences › Check for updates is `on` (the user opted in; the default `ask` makes the
 *   renderer show a one-time prompt), at most once per UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_DELAY_MS after startup.
 * - Manual (Help › Check for Updates…): whatever the setting.
 * - One GET to UPDATE_API_URL (UPDATE_LIST_API_URL when the running version is a pre-release) with only a
 *   `User-Agent: <product>/<version>` header (productIdentity userAgentProduct), no cookies, a short timeout. Nothing
 *   else is sent. Every failure is logged and reported as `failed`, never thrown, never blocking anything.
 * - Nothing is downloaded or installed.
 *
 * Pure Node (no Electron imports) so vitest can drive it: main.ts passes Electron's `net.fetch`.
 */
import * as io from './project/io';
import type { AppPreferences } from '../shared/model';
import { userAgentProduct } from '../shared/productIdentity';
import {
  UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_TIMEOUT_MS, UPDATE_REPLY_MAX_BYTES,
  autoCheckDue, availableUpdate, isNewerRelease, parseSemver, parseUpdateReplyText, updateApiUrlFor,
  type UpdateCheckResult, type UpdateCheckSetting, type UpdateStatus,
} from '../shared/update';

export type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpdateCheckerDeps {
  /** app.getVersion(). */
  currentVersion: string;
  userData: string;
  fetch: UpdateFetch;
  /** Default updateApiUrlFor(currentVersion); the RECUT_UPDATE_URL test override (loopback only) replaces it. */
  apiUrl?: string;
  /** RECUT_UPDATE_CHECK=0: no prompt and no automatic check for this installation. */
  managed?: boolean;
  now?: () => number;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Called with the new status after every check and setting change (main.ts broadcasts ev:updateStatus). */
  onStatus?: (status: UpdateStatus) => void;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class UpdateChecker {
  private inFlight: Promise<UpdateCheckResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: UpdateCheckerDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private log(m: string): void { (this.deps.log ?? ((x: string) => console.warn(x)))(`[update] ${m}`); }

  /** The setting in force (`ask` when never answered). */
  static settingOf(prefs: AppPreferences): UpdateCheckSetting { return prefs.updateCheck ?? 'ask'; }

  statusFrom(prefs: AppPreferences): UpdateStatus {
    const current = this.deps.currentVersion;
    return {
      current,
      setting: UpdateChecker.settingOf(prefs),
      managed: Boolean(this.deps.managed),
      lastCheckAt: prefs.updateLastCheckAt ?? null,
      lastCheckOk: prefs.updateLastCheckOk ?? null,
      available: availableUpdate(prefs.updateLatest, current, prefs.updateSkipVersion),
      skippedVersion: prefs.updateSkipVersion ?? null,
    };
  }

  async status(): Promise<UpdateStatus> {
    return this.statusFrom(await io.readPrefs(this.deps.userData));
  }

  private async emit(prefs?: AppPreferences): Promise<UpdateStatus> {
    const s = prefs ? this.statusFrom(prefs) : await this.status();
    try { this.deps.onStatus?.(s); } catch (e) { this.log(`status listener failed: ${errMsg(e)}`); }
    return s;
  }

  /** Check now (Help › Check for Updates…, or the automatic check). Concurrent calls share one request. */
  check(): Promise<UpdateCheckResult> {
    this.inFlight ??= this.runCheck().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** The automatic check: runs only when the setting is `on`, the installation is not managed and a check is due. */
  async autoCheckIfDue(): Promise<UpdateCheckResult | null> {
    try {
      if (this.deps.managed) return null;
      const prefs = await io.readPrefs(this.deps.userData);
      if (UpdateChecker.settingOf(prefs) !== 'on' || !autoCheckDue(prefs.updateLastCheckAt, this.now())) return null;
      return await this.check();
    } catch (e) {
      this.log(`automatic check skipped: ${errMsg(e)}`);
      return null;
    }
  }

  /** Run autoCheckIfDue after `delayMs` (once; a later call replaces a pending one). Never keeps the app alive. */
  scheduleAutoCheck(delayMs = UPDATE_CHECK_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.autoCheckIfDue(); }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Preferences › Check for updates (or the prompt's answer). Turning it on schedules a check soon. */
  async setSetting(setting: UpdateCheckSetting): Promise<UpdateStatus> {
    const prefs = await io.updatePrefs(this.deps.userData, { updateCheck: setting });
    if (setting === 'on') this.scheduleAutoCheck(1000);
    return this.emit(prefs);
  }

  /** "Skip this version": no notice for `version` (a later release is shown again). */
  async skipVersion(version: string): Promise<UpdateStatus> {
    if (!parseSemver(version)) return this.status();
    return this.emit(await io.updatePrefs(this.deps.userData, { updateSkipVersion: version }));
  }

  private async runCheck(): Promise<UpdateCheckResult> {
    const current = this.deps.currentVersion;
    const at = this.now();
    let result: UpdateCheckResult;
    try {
      const release = await this.fetchLatest();
      if (isNewerRelease(release.version, current)) {
        const prefs = await io.readPrefs(this.deps.userData);
        result = { kind: 'newer', current, release, skipped: prefs.updateSkipVersion === release.version };
      } else {
        result = { kind: 'current', current, latestVersion: release.version };
      }
    } catch (e) {
      result = { kind: 'failed', current, error: errMsg(e) };
      this.log(`check failed: ${result.error}`);
    }
    try {
      const patch: Partial<AppPreferences> = { updateLastCheckAt: at, updateLastCheckOk: result.kind !== 'failed' };
      if (result.kind === 'newer') patch.updateLatest = result.release;
      if (result.kind === 'current') patch.updateLatest = undefined;
      await this.emit(await io.updatePrefs(this.deps.userData, patch));
    } catch (e) {
      this.log(`could not record the check: ${errMsg(e)}`);
    }
    return result;
  }

  /** GET the latest release. Throws a short, user-readable Error on any failure. */
  private async fetchLatest() {
    const ctl = new AbortController();
    const timeoutMs = this.deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.deps.fetch(this.deps.apiUrl ?? updateApiUrlFor(this.deps.currentVersion), {
          method: 'GET',
          headers: { 'User-Agent': userAgentProduct(this.deps.currentVersion) },
          credentials: 'omit',
          signal: ctl.signal,
        });
      } catch (e) {
        throw new Error(ctl.signal.aborted ? `GitHub did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s` : `could not reach GitHub (${errMsg(e)})`);
      }
      if (res.status === 404) throw new Error('GitHub lists no published release');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}${res.status === 403 || res.status === 429 ? ' (rate limited; try again later)' : ''}`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > UPDATE_REPLY_MAX_BYTES) throw new Error('the reply from GitHub is too large');
      let text: string;
      try { text = await res.text(); } catch (e) {
        throw new Error(ctl.signal.aborted ? `GitHub did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s` : `could not read the reply (${errMsg(e)})`);
      }
      if (text.length > UPDATE_REPLY_MAX_BYTES) throw new Error('the reply from GitHub is too large');
      const parsed = parseUpdateReplyText(text, this.deps.currentVersion);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.release;
    } finally {
      clearTimeout(timer);
    }
  }
}
