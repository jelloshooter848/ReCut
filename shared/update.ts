/**
 * Update notice: the pure rules (version comparison and which releases may be offered, GitHub's "latest release" and
 * release-list replies, the release-page URL check, the daily throttle). The check itself runs in the main process (electron/updateCheck.ts); the renderer shows the
 * notice and the opt-in prompt (src/app/updates.ts).
 *
 * The app never downloads or installs anything: it only says that a newer release exists and links to its page.
 *
 * Pure: no DOM, no Node.
 */
import { RELEASE_PAGE_REPO_SLUGS, REPO_SLUG } from './productIdentity';

/**
 * The one request the check makes (GitHub's REST API; no token, no cookies, only a User-Agent header), from a stable
 * version. GitHub's "latest" release is the newest one that is neither a draft nor a pre-release.
 */
export const UPDATE_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
/**
 * The one request the check makes from a pre-release (a release candidate such as 1.0.0-rc.1): the newest releases,
 * pre-releases included, because `releases/latest` never returns a pre-release (docs/RELEASING.md, Release
 * candidates). A few releases are enough: the list is newest first, and the release to offer is among the newest.
 */
export const UPDATE_LIST_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases?per_page=10`;
/** The releases page. Only this page and its `/tag/<tag>` pages are ever opened from the notice. */
export const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`;
/**
 * Releases paths a reply's `html_url` may name: the repository's, and those of its earlier slugs
 * (productIdentity LEGACY_REPO_SLUGS), which GitHub redirects after a repository rename.
 */
const RELEASES_PATHS: readonly string[] = RELEASE_PAGE_REPO_SLUGS.map((slug) => `/${slug}/releases`);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RELEASE_TAG_PATH = new RegExp(`^(?:${RELEASES_PATHS.map(escapeRegExp).join('|')})/tag/[0-9A-Za-z._+-]+$`);

/** At most one automatic check per this interval. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The automatic check waits this long after startup (never on the startup path). */
export const UPDATE_CHECK_DELAY_MS = 5000;
/** A check that has not answered by then has failed. */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/** Replies larger than this are not read (GitHub's reply for one release is a few KB). */
export const UPDATE_REPLY_MAX_BYTES = 1024 * 1024;

/** Preferences › Check for updates: `ask` (default, until the user answers the prompt), `on` (daily), `off`. */
export type UpdateCheckSetting = 'ask' | 'on' | 'off';
export const UPDATE_CHECK_SETTINGS: readonly UpdateCheckSetting[] = ['ask', 'on', 'off'];

export function isUpdateCheckSetting(v: unknown): v is UpdateCheckSetting {
  return typeof v === 'string' && (UPDATE_CHECK_SETTINGS as readonly string[]).includes(v);
}

/** A newer release: its version (no leading `v`) and its release page. */
export interface UpdateRelease { version: string; url: string }

/** What the main process reports to the renderer (IPC update:status, ev:updateStatus). */
export interface UpdateStatus {
  /** The running version (app.getVersion()). */
  current: string;
  setting: UpdateCheckSetting;
  /** No prompt and no daily check for this installation (RECUT_UPDATE_CHECK=0); Help › Check for Updates… still works. */
  managed: boolean;
  /** When the last check (automatic or manual) was made, ms since the epoch; null before the first one. */
  lastCheckAt: number | null;
  /** Whether that check got an answer from GitHub; null before the first one. */
  lastCheckOk: boolean | null;
  /** A release newer than the running version that the user has not skipped; null when there is none. */
  available: UpdateRelease | null;
  /** The version the user chose to skip (Skip this version), if any. */
  skippedVersion: string | null;
}

/** The result of one check. */
export type UpdateCheckResult =
  | { kind: 'newer'; current: string; release: UpdateRelease; skipped: boolean }
  | { kind: 'current'; current: string; latestVersion: string }
  | { kind: 'failed'; current: string; error: string };

// ------------------------------------------------------------------
// Semantic versions
// ------------------------------------------------------------------

export interface Semver { major: number; minor: number; patch: number; prerelease: (string | number)[] }

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `1.2.3`, `v1.2.3`, `1.0.0-rc.2` (build metadata `+...` is accepted and ignored); null for anything else. */
export function parseSemver(v: unknown): Semver | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (!nums.every(Number.isSafeInteger)) return null;
  const prerelease = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: nums[0], minor: nums[1], patch: nums[2], prerelease };
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b (a pre-release is lower than its release). */
export function compareSemver(a: Semver, b: Semver): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core) return Math.sign(core);
  const pa = a.prerelease, pb = b.prerelease;
  if (!pa.length || !pb.length) return pa.length === pb.length ? 0 : pa.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return Math.sign(x - y);
    if (typeof x === 'number') return -1; // numeric identifiers are lower than alphanumeric ones
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** `1.0.0` or `1.0.0-rc.2` (no leading `v`, no build metadata). */
export function formatSemver(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? `-${v.prerelease.join('.')}` : ''}`;
}

/**
 * Whether release `version` may be offered to someone running `current`, newer or not. A stable release always may.
 * A pre-release only to someone already running a pre-release of the same MAJOR.MINOR.PATCH (1.0.0-rc.1 is told
 * about 1.0.0-rc.2; 0.13.0 and 1.0.0 are never told about any release candidate; 1.0.0-rc.2 is not told about
 * 1.1.0-rc.1, only about 1.0.0 and later stable releases). Anything unparsable may not.
 */
export function isOfferableRelease(version: string, current: string): boolean {
  const l = parseSemver(version), c = parseSemver(current);
  if (!l || !c) return false;
  if (!l.prerelease.length) return true;
  return c.prerelease.length > 0 && l.major === c.major && l.minor === c.minor && l.patch === c.patch;
}

/**
 * True when `latest` is newer than the running `current` version (semver precedence) and may be offered to it
 * (isOfferableRelease): a stable release newer than `current`, or, when `current` is a release candidate, a later
 * candidate of the same version. 1.0.0 is newer than 1.0.0-rc.9, and 1.0.0-rc.10 than 1.0.0-rc.9. Anything
 * unparsable is never newer.
 */
export function isNewerRelease(latest: string, current: string): boolean {
  const l = parseSemver(latest), c = parseSemver(current);
  if (!l || !c || !isOfferableRelease(latest, current)) return false;
  return compareSemver(l, c) > 0;
}

// ------------------------------------------------------------------
// URLs
// ------------------------------------------------------------------

/**
 * True for the repository's releases page or one release's page (`.../releases/tag/<tag>`), over https on
 * github.com, with no credentials, port, query or fragment. The notice opens nothing else.
 */
export function isReleasePageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 512) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) return false;
  return RELEASES_PATHS.includes(u.pathname) || RELEASE_TAG_PATH.test(u.pathname);
}

/** The release page of tag `tag` (a version tag such as `v1.2.3`). */
export function releasePageForTag(tag: string): string {
  return `${RELEASES_PAGE_URL}/tag/${encodeURIComponent(tag)}`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The API URL from the RECUT_UPDATE_URL test override, or null when it is unset or not a loopback http(s) URL (a
 * value pointing anywhere else is ignored, so the override can never send the request to another host).
 */
export function parseUpdateUrlOverride(value: string | undefined | null): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let u: URL;
  try { u = new URL(value.trim()); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK_HOSTS.has(u.hostname) || u.username || u.password) return null;
  return u.toString();
}

// ------------------------------------------------------------------
// GitHub's reply
// ------------------------------------------------------------------

export type ParsedRelease = { ok: true; release: UpdateRelease } | { ok: false; error: string };

/**
 * Read GitHub's `releases/latest` reply (already parsed JSON). Drafts and pre-releases (flagged, or with a
 * pre-release version such as `v1.0.0-rc.1`) are not offered. The release page is the reply's `html_url` when it
 * passes isReleasePageUrl, else the tag's page.
 */
export function parseLatestRelease(json: unknown): ParsedRelease {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'the reply is not a release' };
  const r = json as Record<string, unknown>;
  if (r.draft === true) return { ok: false, error: 'the latest release is a draft' };
  if (r.prerelease === true) return { ok: false, error: 'the latest release is a pre-release' };
  const tag = r.tag_name;
  const v = parseSemver(tag);
  if (typeof tag !== 'string' || !v) return { ok: false, error: 'the latest release has no version tag' };
  if (v.prerelease.length) return { ok: false, error: 'the latest release is a pre-release' };
  const version = `${v.major}.${v.minor}.${v.patch}`;
  const url = isReleasePageUrl(r.html_url) ? r.html_url : releasePageForTag(tag.trim());
  return { ok: true, release: { version, url } };
}

/** parseLatestRelease over the reply text. */
export function parseLatestReleaseText(text: string): ParsedRelease {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, error: 'the reply is not valid JSON' }; }
  return parseLatestRelease(json);
}

/**
 * Read GitHub's release list (UPDATE_LIST_API_URL, already parsed JSON) for someone running `current`: the release
 * with the highest semver precedence among those that may be offered to `current` (isOfferableRelease), newer or not
 * (the caller compares). Drafts, entries without a version tag, and entries whose `prerelease` flag disagrees with
 * their tag (flagged pre-release with a stable tag, or the reverse) are ignored. The release page is as in
 * parseLatestRelease.
 */
export function parseReleaseList(json: unknown, current: string): ParsedRelease {
  if (!Array.isArray(json)) return { ok: false, error: 'the reply is not a list of releases' };
  let best: { v: Semver; release: UpdateRelease } | null = null;
  for (const item of json) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (r.draft === true || typeof r.tag_name !== 'string') continue;
    const v = parseSemver(r.tag_name);
    if (!v || (r.prerelease === true) !== v.prerelease.length > 0) continue;
    const version = formatSemver(v);
    if (!isOfferableRelease(version, current)) continue;
    if (best && compareSemver(v, best.v) <= 0) continue;
    const url = isReleasePageUrl(r.html_url) ? r.html_url : releasePageForTag(r.tag_name.trim());
    best = { v, release: { version, url } };
  }
  return best ? { ok: true, release: best.release } : { ok: false, error: 'GitHub lists no published release' };
}

/** Whether the check for `current` asks for the release list (a pre-release) rather than the latest release. */
export function checksReleaseList(current: string): boolean {
  return Boolean(parseSemver(current)?.prerelease.length);
}

/** The URL of the one request the check makes for `current` (UPDATE_LIST_API_URL from a pre-release). */
export function updateApiUrlFor(current: string): string {
  return checksReleaseList(current) ? UPDATE_LIST_API_URL : UPDATE_API_URL;
}

/**
 * The reply text of the check for `current`: a list (from a pre-release, parseReleaseList) or one release
 * (parseLatestRelease, which never offers a pre-release). A list reply to a stable version is read with the stable
 * rules too, so only stable releases can come of it.
 */
export function parseUpdateReplyText(text: string, current: string): ParsedRelease {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, error: 'the reply is not valid JSON' }; }
  return Array.isArray(json) ? parseReleaseList(json, current) : parseLatestRelease(json);
}

// ------------------------------------------------------------------
// Throttle and what to show
// ------------------------------------------------------------------

/**
 * Whether an automatic check is due: never checked, or the last check was at least UPDATE_CHECK_INTERVAL_MS ago.
 * A last check in the future (the clock was set back) counts as due, so a wrong clock cannot stop the checks.
 */
export function autoCheckDue(lastCheckAt: number | null | undefined, now: number): boolean {
  if (typeof lastCheckAt !== 'number' || !Number.isFinite(lastCheckAt)) return true;
  if (lastCheckAt > now + 60_000) return true;
  return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** The release to tell the user about: `latest` when it is newer than `current`, has a valid page and was not skipped. */
export function availableUpdate(latest: UpdateRelease | null | undefined, current: string, skippedVersion: string | null | undefined): UpdateRelease | null {
  if (!latest || !isNewerRelease(latest.version, current) || !isReleasePageUrl(latest.url)) return null;
  if (skippedVersion && parseSemver(skippedVersion) && compareSemver(parseSemver(skippedVersion)!, parseSemver(latest.version)!) === 0) return null;
  return latest;
}
