/**
 * OCR worker thread (worker_threads entry, bundled by scripts/build-electron.mjs to dist/electron/ocr/worker.js).
 *
 * Modeled on tesseract.js 7.0.0 `src/worker-script/node/index.js`: the same message dispatcher
 * (`tesseract.js/src/worker-script`, bundled in), with ReCut's own adapter:
 *  - getCore loads OUR packaged core from `<worker dir>/core` (dist/electron/ocr/core) with a runtime require, not the
 *    tesseract.js-core package (which is not shipped). Relaxed SIMD + LSTM-only when the runtime supports relaxed SIMD,
 *    else plain LSTM-only. (tesseract.js's own Node getCore receives `lstmOnly` where it expects an OEM, so it always
 *    picks a legacy+LSTM core, which is larger and slower.) If the relaxed-SIMD core fails to instantiate it falls
 *    back to the plain one.
 *  - fetch always rejects: language data is only ever read from the local `langPath` (ReCut's tessdata folder).
 *  - gunzip uses zlib (we load uncompressed `.traineddata`, gzip:false, but gzip input still works).
 *
 * workerData: { coreDir?: string; core?: 'relaxedsimd-lstm' | 'lstm' (force a variant, tests/diagnostics) }
 * Extra message to the parent, besides tesseract.js's job replies: { recut: 'core', variant } once the core is ready,
 * and { recut: 'stderr', line } for engine diagnostics when workerData.debug is set.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';

// tesseract.js internals: untyped CommonJS, bundled into this file by esbuild.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workerScript = require('tesseract.js/src/worker-script') as {
  dispatchHandlers(packet: unknown, send: (msg: unknown) => void): void;
  setAdapter(adapter: Record<string, unknown>): void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { relaxedSimd } = require('wasm-feature-detect') as { relaxedSimd(): Promise<boolean> };

export type CoreVariant = 'relaxedsimd-lstm' | 'lstm';
type CoreFactory = (moduleArg?: Record<string, unknown>) => Promise<unknown>;

interface Data { coreDir?: string; core?: CoreVariant; debug?: boolean }
const data: Data = (workerData && typeof workerData === 'object' ? workerData : {}) as Data;
const coreDir = data.coreDir || path.join(__dirname, 'core');
if (!parentPort) throw new Error('electron/ocr/worker must run in a worker thread');
const port = parentPort;

function coreFile(variant: CoreVariant): string {
  return path.join(coreDir, `tesseract-core-${variant}.js`);
}

/** Runtime require of an absolute path: esbuild leaves a non-literal require alone, so the core is not bundled. */
function loadCoreModule(variant: CoreVariant): CoreFactory {
  const file = coreFile(variant);
  if (!fs.existsSync(file)) throw new Error(`OCR core missing: ${file}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(file) as CoreFactory | { default: CoreFactory };
  return typeof mod === 'function' ? mod : mod.default;
}

async function variantOrder(): Promise<CoreVariant[]> {
  if (data.core === 'lstm' || data.core === 'relaxedsimd-lstm') return [data.core];
  let relaxed = false;
  try { relaxed = await relaxedSimd(); } catch { relaxed = false; }
  return relaxed ? ['relaxedsimd-lstm', 'lstm'] : ['lstm'];
}

const quiet = (line: string) => { if (data.debug) port.postMessage({ recut: 'stderr', line: String(line) }); };

let factory: CoreFactory | null = null;

/** Adapter getCore: returns a Core factory that instantiates the first variant that works and reports it. */
async function getCore(): Promise<CoreFactory> {
  if (factory) return factory;
  const order = await variantOrder();
  factory = async (moduleArg: Record<string, unknown> = {}) => {
    let lastErr: unknown = null;
    for (const variant of order) {
      try {
        const Core = loadCoreModule(variant);
        // print/printErr: Tesseract writes diagnostics ("Estimating resolution as ...") to stderr; keep them off the
        // app's console unless debugging.
        const mod = await Core({ ...moduleArg, print: quiet, printErr: quiet });
        port.postMessage({ recut: 'core', variant });
        return mod;
      } catch (e) {
        lastErr = e;
        quiet(`core ${variant} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    port.postMessage({ recut: 'core-failed', error: msg });
    throw new Error(`OCR core failed to load: ${msg}`);
  };
  return factory;
}

const readFile = (p: string) => fs.promises.readFile(p);

workerScript.setAdapter({
  getCore,
  gunzip: (buf: Uint8Array) => zlib.gunzipSync(buf),
  fetch: async (url: string) => { throw new Error(`OCR network access is disabled (${url})`); },
  readCache: readFile,
  // cacheMethod 'none': tesseract.js never writes or deletes cache files, but keep them inert anyway.
  writeCache: async () => {},
  deleteCache: async () => {},
  checkCache: async () => false,
});

port.on('message', (packet: unknown) => {
  workerScript.dispatchHandlers(packet, (obj) => port.postMessage(obj));
});
