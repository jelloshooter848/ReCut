// Builds the renderer, launches Electron under Playwright and screenshots the shell.
// Usage: xvfb-run -a node scripts/screenshot.mjs out.png [--no-build] [--workspace Research] [--maximize center-bottom] [--eval '<js>'] [--keep-state] [--fallback-main]
import { _electron as electron } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const out = path.resolve(root, argv.find((a) => !a.startsWith('--')) ?? 'docs/screenshots/shell.png');
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const noBuild = argv.includes('--no-build');
const workspace = flag('--workspace');
const maximize = flag('--maximize');
const evalJs = flag('--eval');
const keepState = argv.includes('--keep-state');
const forceFallback = argv.includes('--fallback-main');

if (!noBuild) {
  const r = spawnSync('npm', ['run', 'build:renderer'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const hasMain = !forceFallback && fs.existsSync(path.join(root, 'dist/electron/main.js'));
const args = hasMain ? ['.', '--no-sandbox'] : ['scripts/dev-shell-main.cjs', '--no-sandbox'];
console.log(`[screenshot] launching electron ${args[0]}`);
const app = await electron.launch({ args, cwd: root, env: { ...process.env, RECUT_HEADLESS: '1' }, timeout: 60000 });
app.process().stderr?.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(s); });
const page = await app.firstWindow();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer:${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[renderer:pageerror]', e.message));
try {
  await page.waitForSelector('#root .layout', { timeout: 30000 });
  if (!keepState) {
    // Deterministic shots: drop persisted layout/shortcut customizations and reload.
    await page.evaluate(() => { localStorage.removeItem('recut.layout.v1'); localStorage.removeItem('recut.shortcuts.v1'); });
    await page.reload();
    await page.waitForSelector('#root .layout', { timeout: 30000 });
  }
  if (workspace || maximize) {
    await page.evaluate(({ workspace, maximize }) => {
      const tabs = Array.from(document.querySelectorAll('.ws-tab'));
      const t = tabs.find((el) => el.textContent?.trim() === workspace);
      if (t) t.click();
      if (maximize) document.querySelector(`[data-zone="${maximize}"] .zone-tab`)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }, { workspace, maximize });
  }
  if (evalJs) await page.evaluate(evalJs);
  await page.waitForTimeout(500);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`[screenshot] wrote ${out}`);
} finally {
  await app.close();
}
