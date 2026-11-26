const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenSpiritDrawer', {
  toggle: () => ipcRenderer.invoke('drawer:toggle'),
  onBadge: (callback) => {
    const listener = (_event, on) => callback(Boolean(on));
    ipcRenderer.on('drawer:badge', listener);
    return () => ipcRenderer.removeListener('drawer:badge', listener);
  },
});
