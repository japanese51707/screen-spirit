const { app, BrowserWindow, globalShortcut, screen, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('node:path');

let tray;
let overlays = [];

function openOverlay() {
  if (overlays.length) return;
  overlays = screen.getAllDisplays().map((display) => {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreen: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.loadFile(path.join(__dirname, 'overlay.html'));
    overlay.on('closed', () => {
      overlays = overlays.filter((item) => item !== overlay);
    });
    return overlay;
  });
}

app.whenReady().then(() => {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Screen Spirit POC');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'History (POC)', enabled: false },
    { label: 'Settings (POC)', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));

  const registered = globalShortcut.register('CommandOrControl+D', openOverlay);
  if (!registered) console.error('CommandOrControl+D is unavailable.');
  ipcMain.on('close-overlay', () => {
    overlays.forEach((overlay) => overlay.close());
    overlays = [];
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
});
