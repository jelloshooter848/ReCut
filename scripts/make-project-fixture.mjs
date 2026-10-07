#!/usr/bin/env node
/**
 * Make a saved-project compatibility fixture with a given ReCut checkout's own code.
 *
 *   node scripts/make-project-fixture.mjs [--root <checkout>] [--out <file>]
 *
 * `--root` is a ReCut checkout (default: this repository). Its version is read from its package.json, and the
 * fixture goes to `tests/fixtures/projects/recut-<version>.recut` in THIS repository unless `--out` says otherwise.
 *
 * The scenario (scripts/project-fixture-scenario.mjs) drives that checkout's own renderer store
 * (src/state/store.ts): it imports media with probe data, edits sequences with the same actions the UI calls, then
 * serializes the project with the checkout's own save path (serializeForSave + projectJsonChunks, as
 * src/state/mediaActions.ts does) and writes it with its own electron/project/io.ts saveProjectJson. Finally it opens
 * the file again with that checkout's loadProjectFile and fails if the file does not open cleanly.
 *
 * Bundled with esbuild (a devDependency) for Node. The checkout needs no node_modules of its own: packages resolve
 * from it first and then from this repository's node_modules. Time and randomness are fixed, so running the script
 * twice on the same checkout writes the same bytes.
 *
 * Release PRs run it on the new version (docs/RELEASING.md). Old fixtures are never regenerated or edited.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function parseArgs(argv) {
  const out = { root: repo, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = path.resolve(argv[++i]);
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') { console.log('usage: node scripts/make-project-fixture.mjs [--root <checkout>] [--out <file>]'); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(args.root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`unexpected version ${version} in ${args.root}/package.json`);
const outPath = args.out ?? path.join(repo, 'tests', 'fixtures', 'projects', `recut-${version}.recut`);

// What the checkout's project model has, read from its source (features are only used where that version had them).
const modelSrc = fs.readFileSync(path.join(args.root, 'shared', 'model.ts'), 'utf8');
const features = {
  proxyAudioStreams: /\baudioStreams\?:/.test(modelSrc),
  subtitleStreamIndex: /\bstreamIndex\?:\s*number/.test(modelSrc),
};

/** `@recut/<path>` in the scenario resolves to `<root>/<path>` (with the usual .ts / index lookups). */
const recutAlias = {
  name: 'recut-root',
  setup(build) {
    build.onResolve({ filter: /^@recut\// }, (a) => build.resolve('./' + a.path.slice('@recut/'.length), { resolveDir: args.root, kind: a.kind }));
  },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-fixture-'));
try {
  const bundle = path.join(tmp, 'scenario.mjs');
  await esbuild.build({
    entryPoints: [path.join(here, 'project-fixture-scenario.mjs')],
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: bundle, logLevel: 'warning',
    nodePaths: [path.join(args.root, 'node_modules'), path.join(repo, 'node_modules')],
    // Some packages (zustand's CJS build, ...) call require(); give the ESM bundle one.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [recutAlias],
  });
  const { makeFixture } = await import(pathToFileURL(bundle).href);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const summary = await makeFixture({ outPath, version, features });
  console.log(`wrote ${path.relative(process.cwd(), outPath) || outPath} (ReCut ${version}): ${JSON.stringify(summary)}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
