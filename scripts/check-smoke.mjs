// Checks a smoke report (the file RECUT_SMOKE=1 writes to RECUT_SMOKE_OUT, see electron/main.ts runSmoke) against
// scripts/smoke-requirements.json, the one list of required lines shared by the Windows smoke checks (issue #170):
//
//   node scripts/check-smoke.mjs --mode installer <report>   .github/workflows/windows.yml, installer job
//   node scripts/check-smoke.mjs --mode launcher <report>    scripts/windows/start-recut.ps1 -Smoke (launcher job)
//
// Both modes require the speech-to-text engine and OCR, so the launcher cannot lose a component the installer has and
// stay green (tests/unit/launcher-parity.test.ts checks the list against real CI reports).
//
// Prints each missing line and each failure the report contains, then exits 1; exits 0 when every requirement of the
// mode is met, and 2 on a usage error (unknown mode, unreadable report).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const listFile = path.join(here, 'smoke-requirements.json');
const spec = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const log = (msg) => console.log(`[smoke] ${msg}`);

function usage(msg) {
  log(`${msg}. Usage: node scripts/check-smoke.mjs --mode <${spec.modes.join('|')}> <report file>`);
  process.exit(2);
}

const args = process.argv.slice(2);
const at = args.indexOf('--mode');
const mode = at >= 0 ? args[at + 1] : undefined;
const file = args.filter((_, i) => i !== at && i !== at + 1)[0];
if (!mode || !spec.modes.includes(mode)) usage(`unknown mode ${JSON.stringify(mode ?? '')}`);
if (!file) usage('no report file given');

let report;
try {
  report = fs.readFileSync(file, 'utf8');
} catch (e) {
  usage(`cannot read the report ${file}: ${e instanceof Error ? e.message : String(e)}`);
}
const lines = report.replace(/^\uFEFF/, '').split(/\r?\n/);

const problems = [];
const forbidden = new RegExp(spec.forbidden);
for (const line of lines) {
  if (forbidden.test(line)) problems.push(`the report has a failure: ${line}`);
}
const required = spec.required.filter((r) => typeof r[mode] === 'string');
for (const r of required) {
  const re = new RegExp(r[mode], 'i');
  if (!lines.some((l) => re.test(l))) problems.push(`missing "${r.id}" (${r.what}): no line matches /${r[mode]}/`);
}

if (problems.length) {
  for (const p of problems) log(p);
  log(`FAILED: the ${mode} smoke report does not meet ${path.relative(path.dirname(here), listFile).replace(/\\/g, '/')}.`);
  process.exit(1);
}
log(`ok: all ${required.length} ${mode} requirements met (${required.map((r) => r.id).join(', ')}).`);
