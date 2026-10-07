/**
 * Application menu. Every command item sends `ev:menu` with a command string to the renderer;
 * the renderer owns the editing behaviour (and most keyboard shortcuts). Only menu-safe items
 * carry accelerators here so they do not steal keys from the renderer.
 *
 * Commands sent:
 *  file.new, file.open, file.clearRecent, file.save, file.saveAs, file.collect, file.importMedia,
 *  file.importSubtitles, file.export
 *  edit.undo, edit.redo, edit.cut, edit.copy, edit.paste, edit.delete, edit.rippleDelete, edit.selectAll
 *  sequence.new, sequence.duplicate, sequence.addEdit, (Render & Export → file.export)
 *  clip.speedDuration, edit.linkUnlink, edit.toggleClipEnabled, clip.extractCentreChannel
 *  view.zoomIn, view.zoomOut, view.zoomFit
 *  help.shortcuts, help.about
 * Open Recent entries send `ev:openProjectPath` with the file path instead.
 */
import { app, Menu, MenuItemConstructorOptions, shell } from 'electron';
import type { MenuCommand } from '../shared/ipc';

export interface MenuDeps {
  send(command: MenuCommand): void;
  openProjectPath(path: string): void;
  getRecent(): string[];
  requestQuit(): void;
  isDev: boolean;
}

const isMac = process.platform === 'darwin';

export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const cmd = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => deps.send(command),
  });

  const recent = deps.getRecent();
  const recentSub: MenuItemConstructorOptions[] = recent.length
    ? [
        ...recent.map((p) => ({ label: p, click: () => deps.openProjectPath(p) })),
        { type: 'separator' as const },
        { label: 'Clear Recent', click: () => deps.send('file.clearRecent') },
      ]
    : [{ label: 'No Recent Projects', enabled: false }];

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      cmd('New Project', 'file.new', 'CmdOrCtrl+N'),
      cmd('Open Project…', 'file.open', 'CmdOrCtrl+O'),
      { label: 'Open Recent', submenu: recentSub },
      { type: 'separator' },
      cmd('Save', 'file.save', 'CmdOrCtrl+S'),
      cmd('Save As…', 'file.saveAs', 'CmdOrCtrl+Shift+S'),
      cmd('Collect Project…', 'file.collect'),
      { type: 'separator' },
      cmd('Import Media…', 'file.importMedia'),
      cmd('Import Subtitles…', 'file.importSubtitles'),
      cmd('OCR Languages…', 'app.ocrLanguages'),
      { type: 'separator' },
      cmd('Export…', 'file.export', 'CmdOrCtrl+M'),
      ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => deps.requestQuit() }]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      cmd('Undo', 'edit.undo', 'CmdOrCtrl+Z'),
      cmd('Redo', 'edit.redo', isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Shift+Z'),
      { type: 'separator' },
      cmd('Cut', 'edit.cut'),
      cmd('Copy', 'edit.copy'),
      cmd('Paste', 'edit.paste'),
      cmd('Delete', 'edit.delete'),
      cmd('Ripple Delete', 'edit.rippleDelete'),
      { type: 'separator' },
      cmd('Select All', 'edit.selectAll'),
      // macOS has Preferences in the app menu; elsewhere it lives at the end of Edit.
      ...(isMac ? [] : [{ type: 'separator' as const }, cmd('Preferences…', 'app.preferences', 'CmdOrCtrl+,')]),
    ],
  };

  const sequenceMenu: MenuItemConstructorOptions = {
    label: 'Sequence',
    submenu: [
      cmd('New Sequence…', 'sequence.new'),
      cmd('Duplicate Sequence', 'sequence.duplicate'),
      cmd('Duplicate as Cut Without Disabled Clips…', 'sequence.duplicateWithoutDisabled'),
      { type: 'separator' },
      cmd('Remove Disabled Clips…', 'sequence.removeDisabledClips'),
      { type: 'separator' },
      cmd('Add Edit', 'sequence.addEdit'),
      { type: 'separator' },
      cmd('Render & Export…', 'file.export'),
    ],
  };

  const clipMenu: MenuItemConstructorOptions = {
    label: 'Clip',
    submenu: [
      cmd('Speed / Duration…', 'clip.speedDuration'),
      cmd('Link / Unlink', 'edit.linkUnlink'),
      cmd('Enable / Disable', 'edit.toggleClipEnabled'),
      { type: 'separator' },
      cmd('Extract Centre Channel (Dialogue)', 'clip.extractCentreChannel'),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'togglefullscreen' },
      { type: 'separator' },
      cmd('Zoom In Timeline', 'view.zoomIn'),
      cmd('Zoom Out Timeline', 'view.zoomOut'),
      cmd('Zoom to Fit', 'view.zoomFit'),
      { type: 'separator' },
      { role: 'resetZoom', label: 'Reset UI Scale' },
      { role: 'zoomIn', label: 'Increase UI Scale' },
      { role: 'zoomOut', label: 'Decrease UI Scale' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      ...(deps.isDev ? [{ role: 'reload' as const }, { role: 'forceReload' as const }] : []),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'windowMenu',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [
      cmd('Keyboard Shortcuts', 'help.shortcuts'),
      { label: 'FFmpeg Documentation', click: () => { void shell.openExternal('https://ffmpeg.org/documentation.html'); } },
      { type: 'separator' },
      cmd(`About ${app.getName()}`, 'help.about'),
    ],
  };

  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        cmd('Preferences…', 'app.preferences', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => deps.requestQuit() },
      ],
    });
  }
  template.push(fileMenu, editMenu, sequenceMenu, clipMenu, viewMenu, windowMenu, helpMenu);
  return template;
}

export function installMenu(deps: MenuDeps): { refresh(): void } {
  const apply = () => Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(deps)));
  apply();
  return { refresh: apply };
}
