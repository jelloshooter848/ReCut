#!/usr/bin/env node
/**
 * Fetches the pinned whisper.cpp source and verifies it, for the engine build scripts
 * (scripts/linux/get-whisper.sh, scripts/windows/get-whisper.ps1, scripts/mac/get-whisper.sh).
 *
 *   node scripts/whisper-source.mjs --dest <folder>     fetch + verify into <folder> (must not exist or be empty)
 *   node scripts/whisper-source.mjs --hash <folder>     print the source-tree SHA-256 of an extracted tree
 *   node scripts/whisper-source.mjs --pin               print the pin as JSON (tag, commit, tree hash, URLs)
 *
 * Source: the release tag's source tarball from GitHub, which must have WHISPER_TARBALL_SHA256. When that download is
 * not possible or the tarball differs (some build machines cannot reach github.com archive URLs, and GitHub does not
 * promise byte-identical archives over time), the tag is cloned with git instead and its commit must be
 * WHISPER_COMMIT. Either way the extracted tree must then have WHISPER_TREE_SHA256: the SHA-256 over every file's
 * SHA-256 and path (see treeHash below), which is the same for the tarball and the git checkout, and which a single
 * changed byte in any file changes.
 *
 * Node 18+ only, no npm packages. Uses `tar` (bsdtar on Windows 10+ and macOS, GNU tar on Linux) and `git`.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** whisper.cpp release tag ReCut bundles. Keep in step with WHISPER_ENGINE_VERSION in shared/whisper.ts. */
export const WHISPER_TAG = 'v1.9.5';
/** Commit the tag points to (`git ls-remote https://github.com/ggml-org/whisper.cpp 'refs/tags/v1.9.5^{}'`). */
export const WHISPER_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
/** Source-tree SHA-256 of that commit (treeHash of a checkout without .git). */
export const WHISPER_TREE_SHA256 = '2dd351ef7699dcf04b9355f7ba19a88b4c78e948e5fce65eabdbaf85daffc845';
/** SHA-256 of the release tag's source tarball (WHISPER_TARBALL_URL) as GitHub served it when it was pinned. */
export const WHISPER_TARBALL_SHA256 = 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720';
export const WHISPER_REPO = 'https://github.com/ggml-org/whisper.cpp';
export const WHISPER_TARBALL_URL = `${WHISPER_REPO}/archive/refs/tags/${WHISPER_TAG}.tar.gz`;

/** Where fetchSource notes how the tree was fetched (top level of the tree; not part of the tree hash). */
const SOURCE_NOTE = '.recut-source.txt';

/** Every regular file under `dir` (relative, '/'-separated), sorted by code unit; `.git` and SOURCE_NOTE are skipped. */
function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r !== '.git') walk(r); }
      else if (e.isFile()) { if (r !== SOURCE_NOTE) out.push(r); }
      else if (e.isSymbolicLink()) throw new Error(`unexpected symbolic link in the source tree: ${r}`);
    }
  };
  walk('');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Source-tree hash: SHA-256 of the lines `<sha256 of the file>  <relative path>\n` for every file, sorted by path
 * (the same text `find . -type f | sort | xargs sha256sum` prints, without the leading "./").
 */
export function treeHash(dir) {
  const all = createHash('sha256');
  for (const rel of listFiles(dir)) {
    const h = createHash('sha256').update(fs.readFileSync(path.join(dir, ...rel.split('/')))).digest('hex');
    all.update(`${h}  ${rel}\n`);
  }
  return all.digest('hex');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().slice(-800)}`);
  return r.stdout;
}

async function viaTarball(work) {
  const res = await fetch(WHISPER_TARBALL_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tgz = path.join(work, 'src.tar.gz');
  const body = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== WHISPER_TARBALL_SHA256) throw new Error(`tarball SHA-256 ${sha}, expected ${WHISPER_TARBALL_SHA256}`);
  fs.writeFileSync(tgz, body);
  const x = path.join(work, 'x');
  fs.mkdirSync(x);
  run('tar', ['-xzf', tgz, '-C', x]);
  const tops = fs.readdirSync(x);
  if (tops.length !== 1) throw new Error(`unexpected tarball layout: ${tops.join(', ')}`);
  return { tree: path.join(x, tops[0]), how: `tarball ${WHISPER_TARBALL_URL} (tarball SHA-256 ${sha} verified)` };
}

function viaGit(work) {
  const g = path.join(work, 'git');
  run('git', ['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', WHISPER_TAG, WHISPER_REPO, g],
    { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
  const head = run('git', ['-C', g, 'rev-parse', 'HEAD']).trim();
  if (head !== WHISPER_COMMIT) throw new Error(`tag ${WHISPER_TAG} is at ${head}, expected ${WHISPER_COMMIT}`);
  fs.rmSync(path.join(g, '.git'), { recursive: true, force: true });
  return { tree: g, how: `git clone of ${WHISPER_REPO} tag ${WHISPER_TAG} (commit ${head})` };
}

async function fetchSource(dest) {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-whisper-src-'));
  try {
    let got = null;
    const errors = [];
    for (const way of [viaTarball, viaGit]) {
      try { got = await way(work); break; } catch (e) { errors.push(`${way.name}: ${e.message}`); }
    }
    if (!got) throw new Error(`could not fetch whisper.cpp ${WHISPER_TAG}:\n  ${errors.join('\n  ')}`);
    const h = treeHash(got.tree);
    if (h !== WHISPER_TREE_SHA256) throw new Error(`whisper.cpp source tree hash mismatch: got ${h}, expected ${WHISPER_TREE_SHA256} (from ${got.how})`);
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    if (fs.existsSync(dest)) fs.rmdirSync(dest);
    fs.cpSync(got.tree, dest, { recursive: true });
    console.log(`[ReCut] whisper.cpp ${WHISPER_TAG} from ${got.how}; source tree SHA-256 ${h} verified`);
    fs.writeFileSync(path.join(dest, SOURCE_NOTE), `${got.how}\nsource tree SHA-256 ${h}\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main(argv) {
  const [flag, value] = argv;
  if (flag === '--pin') {
    console.log(JSON.stringify({ tag: WHISPER_TAG, commit: WHISPER_COMMIT, treeSha256: WHISPER_TREE_SHA256, tarballSha256: WHISPER_TARBALL_SHA256, repo: WHISPER_REPO, tarball: WHISPER_TARBALL_URL }, null, 2));
  } else if (flag === '--hash' && value) {
    console.log(treeHash(value));
  } else if (flag === '--dest' && value) {
    await fetchSource(value);
  } else {
    console.error('usage: node scripts/whisper-source.mjs --dest <folder> | --hash <folder> | --pin');
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`[ReCut] ${e.message}`); process.exit(1); });
}
