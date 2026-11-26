// 抽屜的三個小視窗（右邊緣把手、夾層工具列、替身動畫）共用的橋接。
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('screenSpiritDrawer', {
  toggle: () => ipcRenderer.invoke('drawer:toggle'),
  barAction: (action) => ipcRenderer.invoke('drawer:bar-action', action),
  barReady: () => ipcRenderer.invoke('drawer:bar-ready'),
  onBarState: on('drawer:bar-state'),
  ghostReady: () => ipcRenderer.invoke('drawer:ghost-ready'),
  ghostDone: () => ipcRenderer.invoke('drawer:ghost-done'),
  onBadge: on('drawer:badge'),
  onGhostPlay: on('drawer:ghost-play'),
});
