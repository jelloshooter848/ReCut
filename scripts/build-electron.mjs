import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows .pathname is "/D:/..." and resolves to "D:\\D:\\...".
const root = fileURLToPath(new URL('..', import.meta.url));
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  alias: { '@shared': path.join(root, 'shared') },
  logLevel: 'info',
};
await build({ ...common, entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(root, 'dist/electron/main.js') });
await build({ ...common, entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(root, 'dist/electron/preload.js') });

// OCR (electron/ocr/engine.ts). The worker thread script and the Tesseract WebAssembly core it loads at run time.
// dist/electron/ocr/** is unpacked from app.asar (package.json build.asarUnpack): worker_threads cannot start a script
// inside an archive, and the core reads its .wasm with plain fs. Only the two LSTM-only cores are shipped (the
// tesseract.js-core package, ~45 MB with all six variants and their asm.js fallbacks, is excluded from the app).
// No sourcemap for the worker: it is mostly third-party code and the folder has a size budget
// (tests/unit/ocr-packaging.test.ts).
const ocrDir = path.join(root, 'dist/electron/ocr');
fs.rmSync(ocrDir, { recursive: true, force: true });
await build({ ...common, sourcemap: false, entryPoints: [path.join(root, 'electron/ocr/worker.ts')], outfile: path.join(ocrDir, 'worker.js') });
const OCR_CORE_FILES = [
  'tesseract-core-relaxedsimd-lstm.js',
  'tesseract-core-relaxedsimd-lstm.wasm',
  'tesseract-core-lstm.js',
  'tesseract-core-lstm.wasm',
  'LICENSE',
];
const require = createRequire(import.meta.url);
const coreSrc = path.dirname(require.resolve('tesseract.js-core/package.json', { paths: [path.dirname(require.resolve('tesseract.js/package.json'))] }));
const coreDst = path.join(ocrDir, 'core');
fs.mkdirSync(coreDst, { recursive: true });
for (const f of OCR_CORE_FILES) fs.copyFileSync(path.join(coreSrc, f), path.join(coreDst, f));
const ocrBytes = [...fs.readdirSync(ocrDir, { recursive: true })]
  .map((f) => path.join(ocrDir, String(f)))
  .filter((p) => fs.statSync(p).isFile())
  .reduce((n, p) => n + fs.statSync(p).size, 0);
console.log(`  dist/electron/ocr  ${(ocrBytes / 1048576).toFixed(2)} MB (worker + ${OCR_CORE_FILES.length} core files)`);
