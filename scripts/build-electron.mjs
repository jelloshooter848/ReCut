import { build } from 'esbuild';
import path from 'node:path';
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
