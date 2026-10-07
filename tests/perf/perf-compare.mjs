#!/usr/bin/env node
/**
 * Same-host A/B performance comparison of two git refs (or two existing checkouts), e.g. a feature branch against
 * main, without a baseline re-seed (docs/DEVELOPMENT.md → Performance gate → Same-host A/B):
 *
 *   npm run perf:compare -- <refA> <refB> [--runs N] [--electron-only | --node-only] [--keep]
 *
 * A ref that is an existing directory is used as it is (a checkout with node_modules, e.g. a worktree with
 * uncommitted changes). Otherwise the ref is checked out as a detached git worktree under
 * $RECUT_PERF_SCRATCH/ab (default <tmp>/recut-perf/ab), with this checkout's node_modules linked in when its
 * package-lock.json is identical (else `npm ci` runs there). Then `perf-check.mjs --ab <A> <B>` builds both and runs
 * them interleaved (A, B, A, B, ...; --runs N each, default 2) and prints per-row medians, B/A and the noise band.
 * The worktrees are removed at the end unless --keep. Exit code: perf-check's (1 when a gate or guardrail row of B
 * is worse than A beyond the band in every run pair).
 *
 * Run it alone on the machine, like perf:check: --runs 2 of both suites takes about an hour; --electron-only about
 * 25 minutes.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const refs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--runs'));
if (refs.length !== 2) {
  console.log('usage: npm run perf:compare -- <refA> <refB> [--runs N] [--electron-only | --node-only] [--keep]');
  process.exit(2);
}
const pass = argv.filter((a, i) => a === '--electron-only' || a === '--node-only' || a === '--runs' || (i > 0 && argv[i - 1] === '--runs'));
const keep = argv.includes('--keep');
const SCRATCH = path.join(process.env.RECUT_PERF_SCRATCH || path.join(os.tmpdir(), 'recut-perf'), 'ab');

const git = (args, cwd = ROOT) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

const made = [];
function checkout(ref, side) {
  if (fs.existsSync(ref) && fs.statSync(ref).isDirectory()) return path.resolve(ref);
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const dir = path.join(SCRATCH, `${side}-${sha.slice(0, 10)}`);
  if (fs.existsSync(dir)) { git(['worktree', 'remove', '--force', dir]); }
  fs.mkdirSync(SCRATCH, { recursive: true });
  git(['worktree', 'add', '--detach', dir, sha]);
  made.push(dir);
  const lockHere = path.join(ROOT, 'package-lock.json'), lockThere = path.join(dir, 'package-lock.json');
  const same = fs.existsSync(path.join(ROOT, 'node_modules')) && fs.existsSync(lockThere) && fs.readFileSync(lockHere, 'utf8') === fs.readFileSync(lockThere, 'utf8');
  if (same) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  else {
    console.log(`[perf:compare] ${ref}: package-lock.json differs from this checkout's: npm ci in ${dir}`);
    const r = spawnSync('npm', ['ci'], { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`npm ci failed in ${dir}`);
  }
  console.log(`[perf:compare] ${side} = ${ref} (${sha.slice(0, 10)}) in ${dir}`);
  return dir;
}

let code = 1;
try {
  const a = checkout(refs[0], 'A');
  const b = checkout(refs[1], 'B');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'perf', 'perf-check.mjs'), '--ab', a, b, ...pass], { cwd: ROOT, stdio: 'inherit' });
  code = r.status ?? 1;
} catch (e) {
  console.log(`[perf:compare] PROBLEM: ${e.message}`);
} finally {
  if (!keep) for (const d of made) { try { git(['worktree', 'remove', '--force', d]); } catch (e) { console.log(`[perf:compare] could not remove ${d}: ${e.message}`); } }
  else if (made.length) console.log(`[perf:compare] kept: ${made.join(', ')} (git worktree remove --force <dir> when done)`);
}
process.exit(code);
