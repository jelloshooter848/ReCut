import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaging of the OCR engine (electron/ocr): tesseract.js is pinned, only the two LSTM-only WebAssembly cores are
// shipped (copied by scripts/build-electron.mjs into dist/electron/ocr/core), dist/electron/ocr is unpacked from
// app.asar, the tesseract.js packages themselves never reach app.asar, and the folder stays within its size budget.
// .github/workflows/windows.yml measures the same folder in the real Windows build.

const repo = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
const buildScript = fs.readFileSync(path.join(repo, 'scripts/build-electron.mjs'), 'utf8');
const BUDGET = 7 * 1024 * 1024;
const CORE_FILES = ['tesseract-core-relaxedsimd-lstm.js', 'tesseract-core-relaxedsimd-lstm.wasm', 'tesseract-core-lstm.js', 'tesseract-core-lstm.wasm', 'LICENSE'];
const distOcr = path.join(repo, 'dist', 'electron', 'ocr');

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return n;
}

/** Names of the runtime packages reachable from `roots` (dependencies + optionalDependencies, hoisted layout). */
function closure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    const pj = path.join(repo, 'node_modules', name, 'package.json');
    if (!fs.existsSync(pj)) continue; // optional dependency not installed on this platform
    seen.add(name);
    const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
    queue.push(...Object.keys(p.dependencies ?? {}), ...Object.keys(p.optionalDependencies ?? {}));
    for (const dep of Object.keys(p.peerDependencies ?? {})) if (!p.peerDependenciesMeta?.[dep]?.optional) queue.push(dep);
  }
  return seen;
}

describe('OCR packaging', () => {
  it('tesseract.js is pinned exactly to 7.0.0, with tesseract.js-core 7.0.0 in the lockfile', () => {
    expect(pkg.dependencies['tesseract.js']).toBe('7.0.0');
    expect(lock.packages['node_modules/tesseract.js'].version).toBe('7.0.0');
    expect(lock.packages['node_modules/tesseract.js-core'].version).toBe('7.0.0');
  });

  it('dist/electron/ocr is unpacked from app.asar', () => {
    expect(pkg.build.asarUnpack).toEqual(['dist/electron/ocr/**']);
  });

  it('app.asar excludes tesseract.js, tesseract.js-core and the dependencies only they use', () => {
    const files: string[] = pkg.build.files;
    expect(files).toEqual(expect.arrayContaining(['dist/**/*', 'package.json', '!node_modules/tesseract.js{,/**}', '!node_modules/tesseract.js-core{,/**}']));
    const excluded = files.filter((f) => f.startsWith('!node_modules/')).map((f) => f.replace(/^!node_modules\//, '').replace(/\{,\/\*\*\}$/, ''));
    // Exactly the tesseract.js closure, and nothing another runtime dependency needs.
    const tess = closure(['tesseract.js']);
    const others = closure(Object.keys(pkg.dependencies).filter((d) => d !== 'tesseract.js'));
    expect(new Set(excluded)).toEqual(tess);
    for (const name of excluded) expect(others.has(name), `${name} is needed by another runtime dependency`).toBe(false);
  });

  it('the build copies only the two LSTM-only cores (+ licence), and they fit the 7 MB budget', () => {
    for (const f of CORE_FILES) expect(buildScript).toContain(`'${f}'`);
    // No other core variant is named in the build script.
    const named = [...buildScript.matchAll(/'(tesseract-core[\w-]*\.(?:js|wasm))'/g)].map((m) => m[1]).sort();
    expect(named).toEqual(CORE_FILES.filter((f) => f !== 'LICENSE').sort());
    const coreDir = path.join(repo, 'node_modules', 'tesseract.js-core');
    const coreBytes = CORE_FILES.reduce((n, f) => n + fs.statSync(path.join(coreDir, f)).size, 0);
    // Leaves at least 512 KB of the budget for worker.js (about 70 KB today).
    expect(coreBytes).toBeLessThan(BUDGET - 512 * 1024);
    expect(buildScript).toMatch(/electron\/ocr\/worker\.ts/);
    expect(buildScript).toMatch(/dist\/electron\/ocr/);
  });

  it.skipIf(!fs.existsSync(path.join(distOcr, 'worker.js')))('the built dist/electron/ocr is within budget and self-contained', () => {
    const bytes = dirBytes(distOcr);
    expect(bytes).toBeLessThanOrEqual(BUDGET);
    expect(fs.readdirSync(path.join(distOcr, 'core')).sort()).toEqual([...CORE_FILES].sort());
    expect(fs.readdirSync(distOcr).sort()).toEqual(['core', 'worker.js']);
    // The worker bundle needs nothing from node_modules (they are not shipped): only node: built-ins by name; the core
    // is loaded with a computed path.
    const src = fs.readFileSync(path.join(distOcr, 'worker.js'), 'utf8');
    const literalRequires = [...src.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    expect(literalRequires.filter((r) => !r.startsWith('node:'))).toEqual([]);
  });

  it('Windows CI measures the unpacked OCR folder, checks app.asar, and requires the OCR smoke line', () => {
    const yml = fs.readFileSync(path.join(repo, '.github/workflows/windows.yml'), 'utf8');
    expect(yml).toContain('release/win-unpacked/resources/app.asar.unpacked/dist/electron/ocr');
    expect(yml).toMatch(/-gt 7MB/);
    expect(yml).toMatch(/npx asar list release\/win-unpacked\/resources\/app\.asar/);
    expect(yml).toContain("tesseract\\.js(-core)?");
    expect(yml).toContain("ocr core=(relaxedsimd-lstm|lstm) ok worker=.*app\\.asar\\.unpacked");
    // A failed probe logs "ocr core=FAILED …", which the existing FAILED check rejects.
    expect(yml).toContain("$r -cmatch 'FAILED|layout=MISSING'");
    const main = fs.readFileSync(path.join(repo, 'electron/main.ts'), 'utf8');
    expect(main).toContain('smoke: ocr core=${core} ok worker=');
    expect(main).toContain('smoke: ocr core=FAILED');
  });
});
