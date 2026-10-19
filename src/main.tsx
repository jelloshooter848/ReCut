import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import { bootstrap } from './app/bootstrap';
import { useStore } from './state';
import * as mediaActions from './state/mediaActions';
import * as selectors from './state/selectors';
import { runCommand } from './keyboard/shortcuts';

// Test/automation hook (used by Playwright e2e and dev console).
// frozen: changing this would break every e2e test, the perf scripts and the README media script that drive the app
// through window.__recut; it is invisible to users.
(window as unknown as Record<string, unknown>).__recut = { store: useStore, actions: mediaActions, selectors, runCommand };

async function start() {
  if (import.meta.env.DEV && !(window as unknown as { __vite_plugin_react_preamble_installed__?: boolean }).__vite_plugin_react_preamble_installed__) {
    // The strict CSP in index.html blocks @vitejs/plugin-react's inline preamble; install it from a module instead (dev only).
    try {
      const refreshPath = '/@react-refresh';
      const RefreshRuntime = (await import(/* @vite-ignore */ refreshPath)).default;
      RefreshRuntime.injectIntoGlobalHook(window);
      const w = window as unknown as Record<string, unknown>;
      w.$RefreshReg$ = () => { /* noop */ };
      w.$RefreshSig$ = () => (type: unknown) => type;
      w.__vite_plugin_react_preamble_installed__ = true;
    } catch (err) { console.warn('[dev] react-refresh preamble unavailable', err); }
  }
  bootstrap();
  const { App } = await import('./App');
  const el = document.getElementById('root')!;
  createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
