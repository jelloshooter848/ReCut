/**
 * Update notice: version comparison, GitHub's reply, the release-page URL check, the daily throttle, skip-version,
 * and the main-process checker driven with a fake fetch (no test here touches the network).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  UPDATE_API_URL, UPDATE_CHECK_INTERVAL_MS, UPDATE_LIST_API_URL, RELEASES_PAGE_URL, autoCheckDue, availableUpdate, checksReleaseList,
  compareSemver, formatSemver, isNewerRelease, isOfferableRelease, isReleasePageUrl, parseLatestRelease, parseLatestReleaseText,
  parseReleaseList, parseSemver, parseUpdateReplyText, parseUpdateUrlOverride, updateApiUrlFor,
} from '../../shared/update';
import { UpdateChecker, type UpdateFetch } from '../../electron/updateCheck';
import { normalizePrefs, readPrefs, updatePrefs } from '../../electron/project/io';
import { CHECK_FOR_UPDATES_COMMAND, initUpdates, noticeRelease, showsUpdatePrompt } from '../../src/app/updates';
import { menuCommandMap } from '../../src/app/bootstrap';
import { getCommand } from '../../src/keyboard/shortcuts';
import { lastCheckText } from '../../src/app/dialogs/PreferencesDialog';

const sv = (v: string) => parseSemver(v)!;
const cmp = (a: string, b: string) => compareSemver(sv(a), sv(b));
const tagPage = (v: string) => `${RELEASES_PAGE_URL}/tag/v${v}`;
const reply = (tag: string, extra: Record<string, unknown> = {}) => JSON.stringify({ tag_name: tag, html_url: tagPage(tag.replace(/^v/, '')), draft: false, prerelease: false, name: `ReCut ${tag}`, body: 'notes', ...extra });

describe('semver', () => {
  it('parses versions with and without v, pre-release and build parts', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('v0.10.0')).toEqual({ major: 0, minor: 10, patch: 0, prerelease: [] });
    expect(parseSemver('1.0.0-rc.2')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['rc', 2] });
    expect(parseSemver('1.0.0+build.5')?.prerelease).toEqual([]);
    for (const bad of ['', '1.2', '1.2.3.4', '01.2.3', 'v', 'latest', '1.2.3-', ' ', 42, null, undefined, '1.2.3-rc..1']) expect(parseSemver(bad)).toBeNull();
  });

  it('orders by semver precedence', () => {
    expect(cmp('0.10.0', '0.9.0')).toBe(1);
    expect(cmp('0.9.0', '0.10.0')).toBe(-1);
    expect(cmp('1.0.0', '1.0.0')).toBe(0);
    expect(cmp('v1.0.0', '1.0.0')).toBe(0);
    expect(cmp('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(cmp('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(cmp('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(cmp('1.0.0-beta', '1.0.0-alpha')).toBe(1);
    expect(cmp('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('offers only stable releases newer than the running version (a release candidate compares correctly)', () => {
    expect(isNewerRelease('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerRelease('0.6.0', '0.6.0')).toBe(false);
    expect(isNewerRelease('0.5.0', '0.6.0')).toBe(false);
    expect(isNewerRelease('1.0.0', '1.0.0-rc.3')).toBe(true);
    expect(isNewerRelease('0.13.0', '1.0.0-rc.1')).toBe(false);
    expect(isNewerRelease('1.0.1', '1.0.0-rc.1')).toBe(true);
    expect(isNewerRelease('1.1.0-rc.1', '1.0.0')).toBe(false); // pre-releases are never offered
    expect(isNewerRelease('garbage', '1.0.0')).toBe(false);
    expect(isNewerRelease('2.0.0', 'garbage')).toBe(false);
  });
});

// Release candidates (docs/RELEASING.md, Release candidates): 1.0.0-rc.N are GitHub pre-releases. A stable user is
// never told about one; someone running a candidate is told about a later candidate of the same version or a newer
// stable release, from one request to the release list (GitHub's releases/latest never returns a pre-release).
describe('release candidates', () => {
  const entry = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag, html_url: tagPage(tag.replace(/^v/, '')), draft: false, prerelease: /-/.test(tag), name: `ReCut ${tag}`, ...extra,
  });
  const pick = (list: unknown[], current: string) => {
    const r = parseReleaseList(list, current);
    return r.ok ? r.release.version : r.error;
  };

  it('orders candidates by semver precedence', () => {
    expect(cmp('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
    expect(cmp('1.0.0', '1.0.0-rc.9')).toBe(1);
    expect(cmp('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
    expect(cmp('1.0.0-rc.9', '1.0.0-rc.10')).toBe(-1);
    expect(cmp('1.0.0-rc.1', '0.13.0')).toBe(1);
    expect(formatSemver(sv('v1.0.0-rc.10+build.3'))).toBe('1.0.0-rc.10');
    expect(formatSemver(sv('1.0.0'))).toBe('1.0.0');
  });

  it('a stable user is never told about a pre-release', () => {
    for (const cur of ['0.7.0', '0.13.0', '1.0.0', '1.0.1']) {
      for (const rc of ['1.0.0-rc.1', '1.0.0-rc.10', '1.1.0-rc.1', '2.0.0-beta.1']) {
        expect(isOfferableRelease(rc, cur), `${rc} to ${cur}`).toBe(false);
        expect(isNewerRelease(rc, cur), `${rc} to ${cur}`).toBe(false);
      }
    }
    expect(isNewerRelease('1.0.0', '0.13.0')).toBe(true);
  });

  it('someone on a candidate is told about a later candidate of the same version or the final release', () => {
    expect(isNewerRelease('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true);
    expect(isNewerRelease('1.0.0-rc.10', '1.0.0-rc.9')).toBe(true);
    expect(isNewerRelease('1.0.0', '1.0.0-rc.9')).toBe(true);
    expect(isNewerRelease('1.0.1', '1.0.0-rc.2')).toBe(true);
    expect(isNewerRelease('1.0.0-rc.1', '1.0.0-rc.2')).toBe(false); // older candidate
    expect(isNewerRelease('1.0.0-rc.9', '1.0.0-rc.10')).toBe(false);
    expect(isNewerRelease('1.0.0-rc.2', '1.0.0-rc.2')).toBe(false);
    expect(isNewerRelease('0.13.0', '1.0.0-rc.1')).toBe(false);
    // A candidate of another version is not offered (once 1.0.0 is out, a 1.0.0-rc.N user is pointed at 1.0.0).
    expect(isOfferableRelease('1.1.0-rc.1', '1.0.0-rc.2')).toBe(false);
    expect(isNewerRelease('1.1.0-rc.1', '1.0.0-rc.2')).toBe(false);
  });

  it('asks for the release list only when running a pre-release', () => {
    expect(updateApiUrlFor('0.7.0')).toBe(UPDATE_API_URL);
    expect(updateApiUrlFor('1.0.0')).toBe(UPDATE_API_URL);
    expect(updateApiUrlFor('1.0.0-rc.1')).toBe(UPDATE_LIST_API_URL);
    expect(updateApiUrlFor('garbage')).toBe(UPDATE_API_URL);
    expect(checksReleaseList('1.0.0-rc.3')).toBe(true);
    expect(checksReleaseList('1.0.0')).toBe(false);
    expect(UPDATE_LIST_API_URL).toBe('https://api.github.com/repos/jelloshooter848/ReCut/releases?per_page=10');
  });

  it('picks the highest release that may be offered from the list (newest first or not)', () => {
    const list = [entry('v1.1.0-rc.1'), entry('v1.0.0-rc.10'), entry('v1.0.0-rc.9'), entry('v1.0.0-rc.2'), entry('v0.13.0'), entry('v0.12.0')];
    expect(pick(list, '1.0.0-rc.2')).toBe('1.0.0-rc.10');
    expect(pick([...list].reverse(), '1.0.0-rc.2')).toBe('1.0.0-rc.10');
    expect(pick(list, '1.0.0-rc.10')).toBe('1.0.0-rc.10'); // up to date
    expect(pick([entry('v1.0.0'), ...list], '1.0.0-rc.9')).toBe('1.0.0');
    // A stable version reading a list (for example through the test override) only ever gets a stable release.
    expect(pick(list, '0.12.0')).toBe('0.13.0');
    expect(pick([entry('v1.0.0-rc.1')], '0.13.0')).toBe('GitHub lists no published release');
    expect(parseReleaseList(list, '1.0.0-rc.2')).toEqual({ ok: true, release: { version: '1.0.0-rc.10', url: tagPage('1.0.0-rc.10') } });
  });

  it('ignores drafts, entries without a version tag and entries whose pre-release flag contradicts the tag', () => {
    const base = [entry('v1.0.0-rc.1')];
    expect(pick([entry('v1.0.0-rc.5', { draft: true }), ...base], '1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(pick([entry('v1.0.0', { prerelease: true }), ...base], '1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(pick([entry('v1.0.0-rc.5', { prerelease: false }), ...base], '1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(pick([entry('nightly'), { tag_name: 7 }, null, 'v9.0.0', [], ...base], '1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(pick([entry('v1.0.0-rc.2', { html_url: 'https://evil.example/x' })], '1.0.0-rc.1')).toBe('1.0.0-rc.2');
    expect(parseReleaseList([entry('v1.0.0-rc.2', { html_url: 'https://evil.example/x' })], '1.0.0-rc.1'))
      .toEqual({ ok: true, release: { version: '1.0.0-rc.2', url: tagPage('1.0.0-rc.2') } });
    expect(pick([], '1.0.0-rc.1')).toBe('GitHub lists no published release');
    expect(parseReleaseList({ tag_name: 'v1.0.0' }, '1.0.0-rc.1')).toEqual({ ok: false, error: 'the reply is not a list of releases' });
  });

  it('reads either reply shape: a single release keeps the stable-only rules', () => {
    expect(parseUpdateReplyText(JSON.stringify([entry('v1.0.0-rc.2')]), '1.0.0-rc.1')).toMatchObject({ ok: true, release: { version: '1.0.0-rc.2' } });
    expect(parseUpdateReplyText(reply('v1.0.0'), '1.0.0-rc.1')).toMatchObject({ ok: true, release: { version: '1.0.0' } });
    expect(parseUpdateReplyText(JSON.stringify(entry('v1.0.0-rc.2')), '1.0.0-rc.1')).toEqual({ ok: false, error: 'the latest release is a pre-release' });
    expect(parseUpdateReplyText('[', '1.0.0-rc.1')).toEqual({ ok: false, error: 'the reply is not valid JSON' });
  });

  it('what to show: a remembered candidate is dropped once a stable version runs', () => {
    const rc2 = { version: '1.0.0-rc.2', url: tagPage('1.0.0-rc.2') };
    expect(availableUpdate(rc2, '1.0.0-rc.1', undefined)).toEqual(rc2);
    expect(availableUpdate(rc2, '1.0.0-rc.1', '1.0.0-rc.2')).toBeNull(); // skipped
    expect(availableUpdate(rc2, '1.0.0', undefined)).toBeNull();
    expect(availableUpdate(rc2, '0.13.0', undefined)).toBeNull();
  });
});

describe('release page URLs', () => {
  it('accepts only the repository releases page and its tag pages', () => {
    expect(isReleasePageUrl(RELEASES_PAGE_URL)).toBe(true);
    expect(isReleasePageUrl(`${RELEASES_PAGE_URL}/tag/v0.10.0`)).toBe(true);
    expect(isReleasePageUrl(`${RELEASES_PAGE_URL}/tag/v1.0.0-rc.1`)).toBe(true);
    for (const bad of [
      'http://github.com/jelloshooter848/ReCut/releases', // not https
      'https://github.com.evil.example/jelloshooter848/ReCut/releases',
      'https://evil.example/jelloshooter848/ReCut/releases',
      'https://github.com/someone-else/ReCut/releases',
      'https://github.com/jelloshooter848/ReCut/releases/download/v1.0.0/ReCut-Setup-1.0.0.exe',
      'https://github.com/jelloshooter848/ReCut/releases/tag/v1/../../../../evil',
      'https://github.com/jelloshooter848/ReCut/releases/tag/v1.0.0?x=1',
      'https://github.com/jelloshooter848/ReCut/releases/tag/v1.0.0#x',
      'https://user:pw@github.com/jelloshooter848/ReCut/releases',
      'https://github.com:8443/jelloshooter848/ReCut/releases',
      'javascript:alert(1)', 'file:///etc/passwd', '', 'not a url', 42, null,
    ]) expect(isReleasePageUrl(bad), String(bad)).toBe(false);
  });

  it('takes a loopback test override only', () => {
    expect(parseUpdateUrlOverride('http://127.0.0.1:4321/latest')).toBe('http://127.0.0.1:4321/latest');
    expect(parseUpdateUrlOverride('http://localhost:80/x')).toBe('http://localhost/x');
    expect(parseUpdateUrlOverride('https://api.github.com/repos/x/y/releases/latest')).toBeNull();
    expect(parseUpdateUrlOverride('http://10.0.0.1/latest')).toBeNull();
    expect(parseUpdateUrlOverride('ftp://127.0.0.1/latest')).toBeNull();
    expect(parseUpdateUrlOverride('')).toBeNull();
    expect(parseUpdateUrlOverride(undefined)).toBeNull();
  });
});

describe('parseLatestRelease', () => {
  it('reads the version and release page', () => {
    expect(parseLatestReleaseText(reply('v0.10.0'))).toEqual({ ok: true, release: { version: '0.10.0', url: tagPage('0.10.0') } });
  });
  it('falls back to the tag page when html_url is missing or not the repository releases page', () => {
    expect(parseLatestReleaseText(reply('v0.10.0', { html_url: 'https://evil.example/x' }))).toEqual({ ok: true, release: { version: '0.10.0', url: tagPage('0.10.0') } });
    expect(parseLatestRelease({ tag_name: 'v0.11.0' })).toEqual({ ok: true, release: { version: '0.11.0', url: tagPage('0.11.0') } });
  });
  it('refuses malformed JSON, drafts, pre-releases and missing or bad tags', () => {
    expect(parseLatestReleaseText('{"tag_name": "v1.0.0"')).toEqual({ ok: false, error: 'the reply is not valid JSON' });
    expect(parseLatestReleaseText('<html>rate limited</html>').ok).toBe(false);
    expect(parseLatestReleaseText('[]').ok).toBe(false);
    expect(parseLatestReleaseText('null').ok).toBe(false);
    expect(parseLatestReleaseText(reply('v1.0.0', { draft: true }))).toEqual({ ok: false, error: 'the latest release is a draft' });
    expect(parseLatestReleaseText(reply('v1.0.0', { prerelease: true }))).toEqual({ ok: false, error: 'the latest release is a pre-release' });
    expect(parseLatestReleaseText(reply('v1.0.0-rc.1'))).toEqual({ ok: false, error: 'the latest release is a pre-release' });
    expect(parseLatestRelease({ html_url: RELEASES_PAGE_URL })).toEqual({ ok: false, error: 'the latest release has no version tag' });
    expect(parseLatestRelease({ tag_name: 'nightly' }).ok).toBe(false);
    expect(parseLatestRelease({ tag_name: 7 }).ok).toBe(false);
  });
});

describe('throttle and what to show', () => {
  const DAY = UPDATE_CHECK_INTERVAL_MS;
  it('checks at most once per 24 h', () => {
    const now = 1_800_000_000_000;
    expect(autoCheckDue(undefined, now)).toBe(true);
    expect(autoCheckDue(null, now)).toBe(true);
    expect(autoCheckDue(now - 1000, now)).toBe(false);
    expect(autoCheckDue(now - DAY + 1, now)).toBe(false);
    expect(autoCheckDue(now - DAY, now)).toBe(true);
    expect(autoCheckDue(now + 2 * DAY, now)).toBe(true); // clock set back: not stuck for days
  });
  it('skip-version hides that release only', () => {
    const r = { version: '0.10.0', url: tagPage('0.10.0') };
    expect(availableUpdate(r, '0.6.0', undefined)).toEqual(r);
    expect(availableUpdate(r, '0.6.0', '0.10.0')).toBeNull();
    expect(availableUpdate(r, '0.6.0', '0.9.0')).toEqual(r);
    expect(availableUpdate({ version: '0.11.0', url: tagPage('0.11.0') }, '0.6.0', '0.10.0')).toEqual({ version: '0.11.0', url: tagPage('0.11.0') });
    expect(availableUpdate(r, '0.10.0', undefined)).toBeNull(); // already updated
    expect(availableUpdate({ version: '0.10.0', url: 'https://evil.example/' }, '0.6.0', undefined)).toBeNull();
    expect(availableUpdate(null, '0.6.0', undefined)).toBeNull();
  });
  it('renderer: prompt while "ask" (unless managed), notice until closed for the session', () => {
    const base = { current: '0.6.0', setting: 'ask' as const, managed: false, lastCheckAt: null, lastCheckOk: null, available: null, skippedVersion: null };
    expect(showsUpdatePrompt(base)).toBe(true);
    expect(showsUpdatePrompt({ ...base, managed: true })).toBe(false);
    expect(showsUpdatePrompt({ ...base, setting: 'on' })).toBe(false);
    expect(showsUpdatePrompt(null)).toBe(false);
    const available = { version: '0.10.0', url: tagPage('0.10.0') };
    expect(noticeRelease({ ...base, available }, null)).toEqual(available);
    expect(noticeRelease({ ...base, available }, '0.10.0')).toBeNull();
    expect(noticeRelease({ ...base, available }, '0.9.0')).toEqual(available);
    expect(lastCheckText(base)).toBe('Never checked');
    expect(lastCheckText({ ...base, lastCheckAt: 1, lastCheckOk: false })).toMatch(/could not be reached/);
    expect(lastCheckText({ ...base, lastCheckAt: 1, lastCheckOk: true, available })).toMatch(/ReCut 0\.10\.0 is available$/);
  });
  it('Help › Check for Updates… is a registered command the menu reaches', () => {
    initUpdates();
    expect(menuCommandMap['help.checkForUpdates']).toBe(CHECK_FOR_UPDATES_COMMAND);
    expect(getCommand(CHECK_FOR_UPDATES_COMMAND)).toMatchObject({ title: 'Check for Updates…', category: 'Help' });
  });
  it('prefs keep only well-formed update fields', () => {
    const p = normalizePrefs({
      recentProjects: [], shortcuts: {}, updateCheck: 'sometimes', updateLastCheckAt: -5, updateLastCheckOk: 'yes',
      updateLatest: { version: '0.10.0', url: 'https://evil.example/' }, updateSkipVersion: 'latest',
    });
    for (const k of ['updateCheck', 'updateLastCheckAt', 'updateLastCheckOk', 'updateLatest', 'updateSkipVersion']) expect(p).not.toHaveProperty(k);
    const ok = normalizePrefs({ updateCheck: 'on', updateLastCheckAt: 5, updateLastCheckOk: true, updateLatest: { version: '0.10.0', url: tagPage('0.10.0'), extra: 1 }, updateSkipVersion: '0.9.0' });
    expect(ok).toMatchObject({ updateCheck: 'on', updateLastCheckAt: 5, updateLastCheckOk: true, updateLatest: { version: '0.10.0', url: tagPage('0.10.0') }, updateSkipVersion: '0.9.0' });
    expect(ok.updateLatest).not.toHaveProperty('extra');
  });
});

describe('UpdateChecker (main process)', () => {
  let userData: string;
  let now: number;
  let calls: { url: string; init?: RequestInit }[];
  let respond: (url: string, init?: RequestInit) => Promise<Response>;
  const logs: string[] = [];
  const fetchFake: UpdateFetch = (url, init) => { calls.push({ url, init }); return respond(url, init); };
  const make = (extra: Partial<ConstructorParameters<typeof UpdateChecker>[0]> = {}) =>
    new UpdateChecker({ currentVersion: '0.6.0', userData, fetch: fetchFake, now: () => now, log: (m) => logs.push(m), ...extra });

  beforeEach(async () => {
    userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-update-'));
    now = 1_800_000_000_000;
    calls = [];
    logs.length = 0;
    respond = async () => new Response(reply('v0.10.0'), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  afterEach(async () => { await fsp.rm(userData, { recursive: true, force: true }); });

  it('sends one GET to the GitHub API with only a User-Agent header and no cookies', async () => {
    const c = make();
    const r = await c.check();
    expect(r).toEqual({ kind: 'newer', current: '0.6.0', release: { version: '0.10.0', url: tagPage('0.10.0') }, skipped: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(UPDATE_API_URL);
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.headers).toEqual({ 'User-Agent': 'ReCut/0.6.0' });
    expect(calls[0].init?.credentials).toBe('omit');
    expect(calls[0].init?.body).toBeUndefined();
    const prefs = await readPrefs(userData);
    expect(prefs).toMatchObject({ updateLastCheckAt: now, updateLastCheckOk: true, updateLatest: { version: '0.10.0', url: tagPage('0.10.0') } });
    expect((await c.status()).available).toEqual({ version: '0.10.0', url: tagPage('0.10.0') });
  });

  it('never checks automatically unless the setting is "on", and never when managed', async () => {
    expect(await make().autoCheckIfDue()).toBeNull(); // default: ask
    await updatePrefs(userData, { updateCheck: 'off' });
    expect(await make().autoCheckIfDue()).toBeNull();
    await updatePrefs(userData, { updateCheck: 'on' });
    expect(await make({ managed: true }).autoCheckIfDue()).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await make()).statusFrom(await readPrefs(userData)).setting).toBe('on');
  });

  it('checks automatically at most once per 24 h (failed attempts count)', async () => {
    await updatePrefs(userData, { updateCheck: 'on' });
    const c = make();
    expect((await c.autoCheckIfDue())?.kind).toBe('newer');
    now += 60_000;
    expect(await c.autoCheckIfDue()).toBeNull();
    now += UPDATE_CHECK_INTERVAL_MS;
    respond = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); };
    expect((await c.autoCheckIfDue())?.kind).toBe('failed');
    now += UPDATE_CHECK_INTERVAL_MS - 1;
    expect(await c.autoCheckIfDue()).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('a manual check runs whatever the setting', async () => {
    await updatePrefs(userData, { updateCheck: 'off', updateLastCheckAt: now });
    expect((await make().check()).kind).toBe('newer');
    expect(calls).toHaveLength(1);
  });

  it('reports up to date, and forgets an older notice', async () => {
    await updatePrefs(userData, { updateLatest: { version: '0.7.0', url: tagPage('0.7.0') } });
    respond = async () => new Response(reply('v0.6.0'), { status: 200 });
    const c = make();
    expect(await c.check()).toEqual({ kind: 'current', current: '0.6.0', latestVersion: '0.6.0' });
    expect((await readPrefs(userData)).updateLatest).toBeUndefined();
    expect((await c.status()).available).toBeNull();
  });

  it('skip this version hides the notice until a later release', async () => {
    const statuses: unknown[] = [];
    const c = make({ onStatus: (s) => statuses.push(s) });
    await c.check();
    const s = await c.skipVersion('0.10.0');
    expect(s.available).toBeNull();
    expect(s.skippedVersion).toBe('0.10.0');
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect((await c.check())).toMatchObject({ kind: 'newer', skipped: true });
    expect((await c.status()).available).toBeNull();
    respond = async () => new Response(reply('v0.11.0'), { status: 200 });
    await c.check();
    expect((await c.status()).available?.version).toBe('0.11.0');
    expect((await c.skipVersion('nonsense')).skippedVersion).toBe('0.10.0');
  });

  it('turns every failure into a logged "failed" result, never a throw, keeping the last known release', async () => {
    const c = make();
    await c.check(); // 0.10.0 known
    const cases: [() => Promise<Response>, RegExp][] = [
      [async () => { throw new TypeError('fetch failed'); }, /could not reach GitHub/],
      [async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 }), /403 \(rate limited/],
      [async () => new Response('Not Found', { status: 404 }), /no published release/],
      [async () => new Response('{oops', { status: 200 }), /not valid JSON/],
      [async () => new Response(reply('v2.0.0', { draft: true }), { status: 200 }), /draft/],
      [async () => new Response('x'.repeat(10), { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }), /too large/],
    ];
    for (const [fn, re] of cases) {
      respond = fn;
      now += 1;
      const r = await c.check();
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') expect(r.error).toMatch(re);
    }
    expect(logs.filter((l) => l.startsWith('[update] check failed'))).toHaveLength(cases.length);
    const prefs = await readPrefs(userData);
    expect(prefs.updateLastCheckOk).toBe(false);
    expect(prefs.updateLastCheckAt).toBe(now);
    expect(prefs.updateLatest?.version).toBe('0.10.0');
  });

  it('gives up after the timeout', async () => {
    respond = (_u, init) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
    const r = await make({ timeoutMs: 30 }).check();
    expect(r).toMatchObject({ kind: 'failed', error: 'GitHub did not answer within 1 s' });
  });

  it('shares one request between concurrent checks', async () => {
    const c = make();
    const [a, b] = await Promise.all([c.check(), c.check()]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('turning the setting on schedules a check; the scheduled check does not keep the process alive', async () => {
    vi.useFakeTimers();
    try {
      const c = make();
      await c.setSetting('on');
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1500);
      vi.useRealTimers();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UpdateChecker on a release candidate', () => {
  let userData: string;
  let calls: string[];
  let list: unknown[];
  const entry = (tag: string) => ({ tag_name: tag, html_url: tagPage(tag.replace(/^v/, '')), draft: false, prerelease: /-/.test(tag) });
  const fetchFake: UpdateFetch = async (url) => { calls.push(url); return new Response(JSON.stringify(list), { status: 200 }); };
  const make = (currentVersion: string) => new UpdateChecker({ currentVersion, userData, fetch: fetchFake, now: () => 1_800_000_000_000, log: () => {} });

  beforeEach(async () => {
    userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-update-rc-'));
    calls = [];
    list = [entry('v1.0.0-rc.2'), entry('v1.0.0-rc.1'), entry('v0.13.0')];
  });
  afterEach(async () => { await fsp.rm(userData, { recursive: true, force: true }); });

  it('sends one GET to the release list and reports a later candidate', async () => {
    const c = make('1.0.0-rc.1');
    expect(await c.check()).toEqual({ kind: 'newer', current: '1.0.0-rc.1', release: { version: '1.0.0-rc.2', url: tagPage('1.0.0-rc.2') }, skipped: false });
    expect(calls).toEqual([UPDATE_LIST_API_URL]);
    expect((await c.status()).available?.version).toBe('1.0.0-rc.2');
  });

  it('reports the final release over any candidate, and up to date on the newest candidate', async () => {
    list = [entry('v1.0.0'), ...list];
    expect(await make('1.0.0-rc.2').check()).toMatchObject({ kind: 'newer', release: { version: '1.0.0' } });
    list = [entry('v1.0.0-rc.10'), entry('v1.0.0-rc.9')];
    expect(await make('1.0.0-rc.10').check()).toEqual({ kind: 'current', current: '1.0.0-rc.10', latestVersion: '1.0.0-rc.10' });
    expect(await make('1.0.0-rc.9').check()).toMatchObject({ kind: 'newer', release: { version: '1.0.0-rc.10' } });
    expect(calls.every((u) => u === UPDATE_LIST_API_URL)).toBe(true);
  });

  it('a stable version still asks for the latest release only', async () => {
    list = [entry('v1.0.0-rc.2')];
    const r = await make('0.13.0').check();
    expect(calls).toEqual([UPDATE_API_URL]);
    expect(r.kind).toBe('failed'); // the fake answers a list; a stable version is never offered the candidate in it
  });
});
