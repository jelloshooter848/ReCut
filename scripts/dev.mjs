// Dev runner: builds the electron main/preload, starts Vite, launches Electron pointing at the dev server.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
  p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))));
});

await run('node', ['scripts/build-electron.mjs']);
const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;
console.log('[dev] vite at', url);
const electronBin = (await import('electron')).default;
const child = spawn(electronBin, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, RECUT_DEV_URL: url },
});
child.on('exit', async () => { await server.close(); process.exit(0); });
