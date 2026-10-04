// Minimal Electron launcher for shell screenshots when dist/electron/main.js is not built yet.
// Loads dist/renderer/index.html with no preload (window.recut is absent; the shell must still render).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1600, height: 900, backgroundColor: '#141414', show: true, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
