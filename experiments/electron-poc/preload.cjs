const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poc', {
  closeOverlay: () => ipcRenderer.send('close-overlay'),
});
