const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenSpiritSelection', {
  getInit: () => ipcRenderer.invoke('selection:get-init'),
  complete: (payload) => ipcRenderer.invoke('selection:complete', payload),
  cancel: () => ipcRenderer.invoke('selection:cancel'),
});
