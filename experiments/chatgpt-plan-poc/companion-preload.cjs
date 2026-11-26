const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenSpiritCompanion', {
  beginSelection: () => ipcRenderer.invoke('companion:begin-selection'),
  beginClipboard: () => ipcRenderer.invoke('companion:begin-clipboard'),
  openChat: () => ipcRenderer.invoke('companion:open-chat'),
  showMenu: () => ipcRenderer.invoke('companion:show-menu'),
  getCompanionBounds: () => ipcRenderer.invoke('companion:get-bounds'),
  moveCompanion: (position) => ipcRenderer.invoke('companion:move', position),
  onStatus: (callback) => {
    const listener = (_event, message) => callback(String(message || ''));
    ipcRenderer.on('poc:companion-status', listener);
    return () => ipcRenderer.removeListener('poc:companion-status', listener);
  },
  onSkin: (callback) => {
    const listener = (_event, skin) => callback(skin || null);
    ipcRenderer.on('poc:companion-skin', listener);
    return () => ipcRenderer.removeListener('poc:companion-skin', listener);
  },
  onMood: (callback) => {
    const listener = (_event, mood) => callback(String(mood || 'idle'));
    ipcRenderer.on('poc:companion-mood', listener);
    return () => ipcRenderer.removeListener('poc:companion-mood', listener);
  },
  onCollapseChange: (callback) => {
    const listener = (_event, collapsed) => callback(Boolean(collapsed));
    ipcRenderer.on('poc:companion-collapse', listener);
    return () => ipcRenderer.removeListener('poc:companion-collapse', listener);
  },
});
