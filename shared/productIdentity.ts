/**
 * Product identity: the single module that names the app. Every display string, window title, menu label, dialog,
 * update-check URL, project-file extension, user-data folder name and environment-variable prefix derives from the
 * values below; nothing else in `src/`, `electron/` or `shared/` spells the product name or the repository slug
 * (tests/unit/product-name-guard.test.ts). The build configuration in package.json (productName, artifact names,
 * file associations, NSIS) and the release workflow cannot import this file; tests/unit/product-identity-sync.test.ts
 * keeps them equal to it.
 *
 * Legacy lists (`LEGACY_*`) hold every value the product has shipped with, the current one included. Entries are
 * never removed: they are what lets older project files open, older user-data folders migrate
 * (electron/userDataMigration.ts) and older environment variables keep working.
 *
 * Pure: no DOM, no Node.
 */

const unique = <T>(xs: readonly T[]): readonly T[] => Object.freeze([...new Set(xs)]);

// ------------------------------------------------------------------
// Names
// ------------------------------------------------------------------

/** The display name: window titles, menus, About, dialogs, toasts. */
export const PRODUCT_NAME = 'ReCut';
/** Display names the product shipped under before; strings that mention an earlier release may use them. */
export const LEGACY_PRODUCT_NAMES: readonly string[] = unique(['ReCut']);
/** One-line description used next to the name (About fallback). */
export const PRODUCT_TAGLINE = 'fan-edit video editor';
/**
 * Base name of the executable and the release files (electron-builder `productName`): `<name>.exe`, `<name>.app`,
 * `<name>-Setup-<version>.exe` and so on.
 */
export const PRODUCT_FILE_NAME = 'ReCut';
/** Executable base names of earlier releases (an installer may need to find a running one). */
export const LEGACY_PRODUCT_FILE_NAMES: readonly string[] = unique(['ReCut']);
/** Linux executable (electron-builder `linux.executableName`). */
export const LINUX_EXECUTABLE_NAME = 'recut';
/** package.json `name`. */
export const PACKAGE_NAME = 'recut';
/** package.json `author` (Windows file properties, uninstall "Publisher"). */
export const PRODUCT_AUTHOR = `${PRODUCT_NAME} contributors`;

/** electron-builder `appId` (Windows AppUserModelID, macOS CFBundleIdentifier). */
// frozen: changing this would make Windows treat the next installer as a different app (a side-by-side install
// instead of an upgrade) and macOS a different app (Launch Services, privacy prompts asked again).
export const APP_ID = 'app.recut.editor';
/**
 * The GUID electron-builder derives from APP_ID (UUID v5 in its namespace), pinned as `build.nsis.guid` so the
 * Windows upgrade path never depends on the appId.
 */
// frozen: changing this would make the Windows installer stop finding earlier installs (registry and uninstall
// keys are named after it), so the new version would install beside the old one instead of upgrading it.
export const WINDOWS_INSTALLER_GUID = '71b5ac76-3d71-54f8-ab45-e7992d0fc22e';

/** `<name>/<version>` product token for HTTP User-Agent headers (RFC 9110 token characters only). */
export function userAgentProduct(version: string): string {
  return `${PRODUCT_NAME.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, '')}/${version}`;
}

// ------------------------------------------------------------------
// Repository (update check, links)
// ------------------------------------------------------------------

export const REPO_OWNER = 'jelloshooter848';
export const REPO_NAME = 'ReCut';
/** `<owner>/<repo>` on GitHub. */
export const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;
/** Earlier slugs (the current one included): release-page links that still name them are accepted. */
export const LEGACY_REPO_SLUGS: readonly string[] = unique(['jelloshooter848/ReCut']);
/** Slugs whose release pages the update notice may open: the current one first. */
export const RELEASE_PAGE_REPO_SLUGS: readonly string[] = unique([REPO_SLUG, ...LEGACY_REPO_SLUGS]);
export const REPO_URL = `https://github.com/${REPO_SLUG}`;

/**
 * Release file names as electron-builder `artifactName` templates (package.json build.*.artifactName). The update
 * check reads only release tags and never these names; they are here so the build configuration and the release
 * workflow have one reference (tests/unit/product-identity-sync.test.ts).
 */
export const RELEASE_ARTIFACT_NAMES = Object.freeze({
  windowsSetup: `${PRODUCT_FILE_NAME}-Setup-\${version}.\${ext}`,
  windowsPortable: `${PRODUCT_FILE_NAME}-Portable-\${version}.\${ext}`,
  linuxAppImage: `${PRODUCT_FILE_NAME}-\${version}-linux-x86_64.\${ext}`,
  macDmg: `${PRODUCT_FILE_NAME}-\${version}-macos-\${arch}.\${ext}`,
});

// ------------------------------------------------------------------
// Project files
// ------------------------------------------------------------------

/** Extension of new project files (no dot). Save, Save As and Collect use it. */
export const PROJECT_EXTENSION = 'recut';
/**
 * Every extension a project file was ever saved with (no dot; the current one included). They all open: the open
 * dialog, drag and drop, the recent list, the command line, OS file associations and autosave checks accept them.
 */
export const LEGACY_PROJECT_EXTENSIONS: readonly string[] = unique(['recut']);
/** Extensions that open as projects: the primary first. */
export const PROJECT_EXTENSIONS: readonly string[] = unique([PROJECT_EXTENSION, ...LEGACY_PROJECT_EXTENSIONS]);
/** File-type name in dialogs and the OS (electron-builder fileAssociations `name`). */
export const PROJECT_FILE_TYPE_NAME = `${PRODUCT_NAME} Project`;
/** File-type description for the OS (fileAssociations `description`: Windows, the Linux MIME comment). */
export const PROJECT_FILE_TYPE_DESCRIPTION = `${PRODUCT_NAME} fan-edit project`;
/** MIME type of project files (fileAssociations `mimeType`). */
export const PROJECT_MIME_TYPE = 'application/x-recut';

/** The project extension of `p` (lower case, no dot) when it is one of PROJECT_EXTENSIONS, else null. */
export function projectExtensionOf(p: string): string | null {
  const lower = p.toLowerCase();
  for (const ext of PROJECT_EXTENSIONS) if (lower.endsWith(`.${ext}`) && lower.length > ext.length + 1) return ext;
  return null;
}

/** Whether `p` names a project file (any of PROJECT_EXTENSIONS, any case). */
export function isProjectFilePath(p: string): boolean {
  return typeof p === 'string' && projectExtensionOf(p) !== null;
}

/** `p` with a project extension: unchanged when it has one of PROJECT_EXTENSIONS, else with PROJECT_EXTENSION appended. */
export function withProjectExtension(p: string): string {
  return isProjectFilePath(p) ? p : `${p}.${PROJECT_EXTENSION}`;
}

/** A file name without its project extension (`My Edit.recut` → `My Edit`); other names unchanged. */
export function stripProjectExtension(name: string): string {
  const ext = projectExtensionOf(name);
  return ext ? name.slice(0, -(ext.length + 1)) : name;
}

/** Open dialog filter for project files: every extension that opens, the primary first. */
export function projectFileFilters(): { name: string; extensions: string[] }[] {
  return [{ name: PROJECT_FILE_TYPE_NAME, extensions: [...PROJECT_EXTENSIONS] }];
}

/** Save dialog filter: new project files get the primary extension only. */
export function projectSaveFilters(): { name: string; extensions: string[] }[] {
  return [{ name: PROJECT_FILE_TYPE_NAME, extensions: [PROJECT_EXTENSION] }];
}

// ------------------------------------------------------------------
// User-data folder
// ------------------------------------------------------------------

/** Name of the per-user data folder under the OS app-data folder (`app.setName`). */
export const USER_DATA_DIR_NAME = PRODUCT_NAME;
/**
 * Folder names earlier releases used (the current one included). A launch whose own folder is empty moves the first
 * of these that holds data into it (electron/userDataMigration.ts); a name equal to USER_DATA_DIR_NAME is skipped.
 */
export const LEGACY_USER_DATA_DIR_NAMES: readonly string[] = unique(['ReCut']);

// ------------------------------------------------------------------
// Environment variables
// ------------------------------------------------------------------

/** Prefix of the app's environment variables (`<prefix>CACHE_DIR`, …). */
export const ENV_PREFIX = 'RECUT_';
/**
 * Prefixes that are read as well, after ENV_PREFIX. `RECUT_` is never removed: administrators set
 * `RECUT_UPDATE_CHECK=0` in deployments and documented `RECUT_*` variables must keep working.
 */
export const LEGACY_ENV_PREFIXES: readonly string[] = unique(['RECUT_']);
/** Every prefix read, in order (the first set, non-empty variable wins). */
export const ENV_PREFIXES: readonly string[] = unique([ENV_PREFIX, ...LEGACY_ENV_PREFIXES]);

/** The value of variable `name` (without prefix) under the first prefix that sets it to a non-empty value. */
export function readPrefixedEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  for (const prefix of ENV_PREFIXES) {
    const v = env[prefix + name];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** The documented name of variable `name` (current prefix), for messages. */
export function envVarName(name: string): string {
  return ENV_PREFIX + name;
}
