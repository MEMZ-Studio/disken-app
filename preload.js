const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskenAPI', {
  onShowAbout: (callback) => ipcRenderer.on('show-about', callback)
});
